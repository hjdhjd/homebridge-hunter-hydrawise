/* Copyright(C) 2017-2026, HJD (https://github.com/hjdhjd). All rights reserved.
 *
 * v2.test.ts: The Hydrawise v2 client, driven through an injected dispatcher so the token grant, the query, and every failure classification run the real
 * production code against recorded wire traffic and never touch the live account API. Covers token acquisition, lazy renewal, the reset a failed grant performs,
 * the single-flight guarantee two concurrent callers rest on, the selection the account query asks for, the facts composition rules - hardware, availability,
 * per-zone suspension, and the sensor derivation - the rate-budget draws, and the failure classifications, including the one that matters most for a GraphQL
 * endpoint, an HTTP 200 whose body carries an errors array with or without data, and the pool re-arm a timed-out call triggers. It covers too a 429 from the read
 * or its grant named up the chain, the token a refused read drops, and the password grant a refused renewal falls back to.
 *
 * Every fixture body below is taken from the live probe captures, so a wrong field mapping fails here rather than in the field.
 */
// The OAuth and GraphQL wire shapes use snake_case keys such as access_token, so camelcase is disabled here to let the fixtures mirror the captured bodies verbatim.
/* eslint-disable camelcase */
import { HYDRAWISE_TRANSPORT_FAULT_SENTENCES, HYDRAWISE_V2_BUDGET_CALLS, HYDRAWISE_V2_BUDGET_WINDOW, HYDRAWISE_V2_CLIENT_ID, HYDRAWISE_V2_CLIENT_SECRET,
  HYDRAWISE_V2_GRAPH_ENDPOINT, HYDRAWISE_V2_TOKEN_ENDPOINT } from "./settings.ts";
import { MockAgent, errors } from "undici";
import { capturingLog, errnoError, formatLogEntry, linesAt } from "homebridge-plugin-utils/testing";
import { describe, test } from "node:test";
import type { HydrawiseControllerV2Facts } from "./types.ts";
import type { HydrawiseTransportFault } from "./settings.ts";
import { HydrawiseV2Client } from "./v2.ts";
import { RateBudget } from "homebridge-plugin-utils";
import type { TestLogEntry } from "homebridge-plugin-utils/testing";
import assert from "node:assert/strict";

// The origin every v2 request targets, derived from the endpoint constant exactly as the client derives its own pool origin.
const V2_ORIGIN = new URL(HYDRAWISE_V2_GRAPH_ENDPOINT).origin;

// The paths the client posts to, likewise derived so a changed endpoint constant moves the intercepts with it rather than silently matching nothing.
const GRAPH_PATH = new URL(HYDRAWISE_V2_GRAPH_ENDPOINT).pathname;
const TOKEN_PATH = new URL(HYDRAWISE_V2_TOKEN_ENDPOINT).pathname;

// A successful token grant, shaped as the live capture recorded it.
const TOKEN_BODY = { access_token: "access-one", expires_in: 3600, refresh_token: "refresh-one" };

// The second grant a renewal receives, distinguishable from the first so a test can tell a renewed token from a reused one.
const RENEWED_TOKEN_BODY = { access_token: "access-two", expires_in: 3600, refresh_token: "refresh-two" };

/* The controller hardware block exactly as the live capture recorded it, including the fields the client does NOT read. Keeping the unread fields is what makes the
 * selection rules genuinely tested: the model name sits beside the description, so a mapping that reached for the wrong one would produce the wrong string here
 * rather than passing against a fixture trimmed to only the right answer.
 */
const CAPTURED_CONTROLLER = {

  deviceId: 1058556,
  hardware: {

    firmware: [{ type: "controller", version: "4.76" }],
    model: { description: "HCC 38 Zones", family: { id: 6, name: "HCC Controller" }, id: "hydrawise938", maxZones: 38, name: "38 Zones" },
    status: "Linked",
    version: "hydrawise938"
  },
  id: 1058515,
  name: "Home"
};

/* The zone ids the live captures record, used verbatim so a correlation test is running against the real id space. The suspended one is the zone the 2026-08-09
 * capture caught carrying a suspension while its siblings carried none.
 */
const SUSPENDED_ZONE_ID = 6940619;
const QUIET_ZONE_ID = 6940181;

// The far-future suspension instant the live capture recorded on that zone, kept exactly so the beyond-a-week rendering tiers are exercised against a real value.
const SUSPENDED_UNTIL = 1903928399;

// The zone block as the account query returns it: one zone under a suspension, one under none. The unsuspended zone answers a NULL suspendedUntil rather than
// omitting the field, which is the shape the live capture records and the one that has to read as "not suspended" rather than as "unknown".
const CAPTURED_ZONES = [ { id: QUIET_ZONE_ID, name: "Parkway North", status: { suspendedUntil: null } },
  { id: SUSPENDED_ZONE_ID, name: "Sideyard Vegetable Garden",
    status: { suspendedUntil: { timestamp: SUSPENDED_UNTIL, value: "Wed, 01 May 30 23:59:59 -0500" } } } ];

/* The sensor block as the live sensors capture records it, including the unread fields. The sensorType value is the live one - the owner's rain and freeze sensor
 * reports LEVEL_CLOSED - so a filter that matched some other spelling would compose nothing here rather than passing against a fixture trimmed to the right answer.
 */
const CAPTURED_SENSORS = [{ id: 394649, model: { active: true, id: 3318, name: "Rain Sensor (normally closed wire)", sensorType: "LEVEL_CLOSED" },
  name: "Hunter Rain Freeze Sensor", status: { active: true, waterFlow: null }, zones: [{ id: QUIET_ZONE_ID }] }];

// The whole-account answer, carrying the captured controller with its zones, its sensors, and its reachability.
const ACCOUNT_BODY = { data: { me: { controllers: [{ ...CAPTURED_CONTROLLER, sensors: CAPTURED_SENSORS, status: { online: true }, zones: CAPTURED_ZONES }] } } };

// The errors array the live status-query capture recorded under HTTP 200: one internal error, whose path names a field of the first sensor on the first controller.
const GRAPH_ERRORS = [{ extensions: { category: "internal" }, locations: [{ column: 231, line: 1 }], message: "Internal server error",
  path: [ "me", "controllers", 0, "sensors", 0, "model", "mode" ] }];

/* The whole of that capture's shape, with the selection it records: the error beside the controller it left standing, the sensor's entry nulled and every other field
 * answered. This is the partial answer a status-code check alone cannot see. The capture's selection asked for no hardware, so none is here.
 */
const GRAPH_ERRORS_BODY = { data: { me: { controllers: [{ id: 1058515, name: "Home", online: true, sensors: [null], status: { online: true, summary: "All good!" },
  zones: CAPTURED_ZONES }] } }, errors: GRAPH_ERRORS };

// The body a refused renewal or password grant answers with.
const REFUSED_GRANT_BODY = { error: "invalid_grant" };

// One recorded request the injected dispatcher served, in the order it was served. The path is what tells a token grant from a query, and the order is what a
// budget-before-dispatch assertion reads, from the ceiling's free slots sampled as each call dispatched.
interface RecordedCall {

  budgetAvailableAtDispatch: number;
  path: string;
}

// The handles a harness hands back: the client under test, the recorded call log, the ceiling it draws against, and the captured log lines.
interface V2Harness {

  budget: RateBudget;
  calls: RecordedCall[];
  client: HydrawiseV2Client;
  entries: readonly TestLogEntry[];
}

/* Build a client over a MockAgent handed in through the constructor's dispatcher factory - the SAME parameter production leaves unset, so nothing here is a path
 * production does not have. The factory answers one agent for the life of the harness; a test needing the timeout self-heal path constructs HydrawiseV2Client
 * directly instead, since this harness offers no way to override the factory it builds.
 *
 * Each intercept records the call before it replies, capturing the ceiling's free slots AT DISPATCH. That number is what proves the draw is awaited rather than
 * merely present: a call that reached the wire without waiting would be recorded with its ceiling untouched.
 */
function makeV2Harness(program: (agent: MockAgent, record: (path: string) => void) => void,
  options: { capacity?: number; signal?: AbortSignal } = {}): V2Harness {

  const log = capturingLog();
  const signal = options.signal ?? new AbortController().signal;
  const budget = new RateBudget({ capacity: options.capacity ?? HYDRAWISE_V2_BUDGET_CALLS, signal, window: HYDRAWISE_V2_BUDGET_WINDOW * 1000 });
  const calls: RecordedCall[] = [];
  const agent = new MockAgent();

  agent.disableNetConnect();

  program(agent, (path: string): void => {

    calls.push({ budgetAvailableAtDispatch: budget.available, path });
  });

  const client = new HydrawiseV2Client({ budget, dispatcherFactory: (): MockAgent => agent, log, password: "test-password", signal, username: "test-user" });

  return { budget, calls, client, entries: log.entries };
}

/* A MockAgent whose destroy tears it down for real. undici's MockAgent implements close but inherits the base dispatcher's unimplemented destroy, and the client
 * calls destroy because that is what fails a wedged pool's in-flight requests fast; mapping one onto the other is the double's business, not production's.
 */
function destroyable(agent: MockAgent): MockAgent {

  return Object.assign(agent, { destroy: async (): Promise<void> => { await agent.close(); } });
}

// Program one JSON reply for a path on the agent, recording each request it serves. Persisted, so a test that expects two calls to the same path gets the same
// answer twice unless it programs otherwise.
function programReply(agent: MockAgent, record: (path: string) => void, path: string, body: object, statusCode = 200): void {

  agent.get(V2_ORIGIN).intercept({ method: "POST", path }).reply(statusCode, (): object => {

    record(path);

    return body;
  }).persist();
}

/* Program the graph endpoint on the same terms, additionally capturing the query text of every request it serves. That capture is what lets a test assert the exact
 * document that went on the wire, which every other intercept here - matching on path and method alone - is blind to.
 */
function programGraph(agent: MockAgent, record: (path: string) => void, body: object, queries: string[], statusCode = 200): void {

  agent.get(V2_ORIGIN).intercept({ body: (payload) => {

    queries.push((JSON.parse(payload) as { query: string }).query);

    return true;
  }, method: "POST", path: GRAPH_PATH }).reply(statusCode, (): object => {

    record(GRAPH_PATH);

    return body;
  }).persist();
}

// The error lines a capture holds, rendered the way a user reads them. The plugin logs printf-style, so a sentence and the detail it carries can sit in different
// arguments and only the rendered line is what a user actually reads - which is what an assertion about the reported wording has to run against.
function errorLines(entries: readonly TestLogEntry[]): string[] {

  return entries.filter(line => line.level === "error").map(formatLogEntry);
}

// The answer a grant that came carries.
function granted(accessToken: string): { accessToken: string; status: "granted" } {

  return { accessToken, status: "granted" };
}

// The facts an answered read carries, failing the row on any other outcome, so a row reading the facts is held to the read having answered.
async function answeredFacts(client: HydrawiseV2Client): Promise<Map<number, HydrawiseControllerV2Facts>> {

  const read = await client.fetchAccountFacts();

  assert.ok(read.status === "answered", "the read answers its facts");

  return read.facts;
}

/* Program the token endpoint to answer each grant in turn, one-shot and in order, recording the grant type each request presented. The record is what tells a password
 * grant from a renewal, which every intercept matching on path and method alone is blind to.
 */
function programGrants(agent: MockAgent, grants: (string | null)[], answers: { body: object; statusCode?: number }[]): void {

  for(const { body, statusCode = 200 } of answers) {

    agent.get(V2_ORIGIN).intercept({ method: "POST", path: TOKEN_PATH }).reply(statusCode, (request): object => {

      grants.push(new URLSearchParams(request.body as string).get("grant_type"));

      return body;
    });
  }
}

describe("HydrawiseV2Client tokens", () => {

  test("acquires an access token on first use and reuses it on the next call", async () => {

    const harness = makeV2Harness((agent, record) => programReply(agent, record, TOKEN_PATH, TOKEN_BODY));

    assert.deepEqual(await harness.client.ensureToken(), granted("access-one"), "the password grant should answer the captured access token");
    assert.deepEqual(await harness.client.ensureToken(), granted("access-one"), "a token comfortably inside its lifetime answers again without a second grant");
    assert.equal(harness.calls.length, 1, "the second call should have spent no grant");
  });

  test("renews a token that is inside its proactive-refresh window", async () => {

    // A grant whose lifetime is shorter than the proactive-refresh threshold is inside that window the instant it lands, so the next call renews rather than
    // reusing it. That is the same arithmetic a long-lived token reaches near its expiry, without a test having to wait an hour to observe it.
    const harness = makeV2Harness((agent, record) => {

      agent.get(V2_ORIGIN).intercept({ method: "POST", path: TOKEN_PATH }).reply(200, (): object => {

        record(TOKEN_PATH);

        return { access_token: "access-one", expires_in: 30, refresh_token: "refresh-one" };
      });

      programReply(agent, record, TOKEN_PATH, RENEWED_TOKEN_BODY);
    });

    assert.deepEqual(await harness.client.ensureToken(), granted("access-one"), "the first grant answers the short-lived token");
    assert.deepEqual(await harness.client.ensureToken(), granted("access-two"), "a token inside the refresh window is renewed rather than reused");
    assert.equal(harness.calls.length, 2, "the renewal should have spent a second grant");
  });

  test("a failed grant resets the token state so the next call retries from scratch", async () => {

    const harness = makeV2Harness((agent, record) => {

      agent.get(V2_ORIGIN).intercept({ method: "POST", path: TOKEN_PATH }).reply(401, (): object => {

        record(TOKEN_PATH);

        return REFUSED_GRANT_BODY;
      });

      programReply(agent, record, TOKEN_PATH, TOKEN_BODY);
    });

    assert.deepEqual(await harness.client.ensureToken(), { status: "failed" }, "a rejected grant answers a failed one");

    // The recovery is the point of the reset: a client left holding a failed state would fail forever, where one returned to holding nothing simply tries
    // again and succeeds the moment the account is reachable.
    assert.deepEqual(await harness.client.ensureToken(), granted("access-one"), "the next call runs a fresh password grant and recovers");
    assert.equal(harness.calls.length, 2, "each attempt spent exactly one grant");
  });

  test("a grant carrying no access token is treated as a failure", async () => {

    const harness = makeV2Harness((agent, record) => programReply(agent, record, TOKEN_PATH, { expires_in: 3600, token_type: "Bearer" }));

    assert.deepEqual(await harness.client.ensureToken(), { status: "failed" }, "a 200 with no access token is not a usable grant");
  });

  test("two concurrent callers resolve from exactly ONE grant", async () => {

    const harness = makeV2Harness((agent, record) => programReply(agent, record, TOKEN_PATH, TOKEN_BODY));

    /* Both calls are started before either is awaited, which is the only arrangement that can observe the single-flight mechanism at all. The transition to the
     * in-flight state happens synchronously, in the same frame that read the prior state, so the second caller finds a grant already running and joins it. Drop
     * that synchronous transition and both callers observe "no token" and each fire a grant of their own, which this call count catches.
     */
    const [ first, second ] = await Promise.all([ harness.client.ensureToken(), harness.client.ensureToken() ]);

    assert.deepEqual(first, granted("access-one"), "the first caller resolves the token");
    assert.deepEqual(second, granted("access-one"), "the second caller resolves the same token");
    assert.equal(harness.calls.length, 1, "two concurrent callers should share ONE grant, not fire one each");
    assert.equal(harness.budget.available, HYDRAWISE_V2_BUDGET_CALLS - 1, "sharing the grant means sharing its budget slot too");
  });

  test("a token grant draws the rate budget BEFORE it reaches the wire", async () => {

    const harness = makeV2Harness((agent, record) => programReply(agent, record, TOKEN_PATH, TOKEN_BODY));

    await harness.client.ensureToken();

    // The slot count sampled at dispatch is the witness. A draw that was dispatched instead of awaited would let the request through with the budget still whole.
    assert.equal(harness.calls.length, 1, "the grant reached the wire");
    assert.equal(harness.calls[0]?.budgetAvailableAtDispatch, HYDRAWISE_V2_BUDGET_CALLS - 1, "the grant's slot was already spent by the time it dispatched");
  });
});

describe("HydrawiseV2Client grant body", () => {

  /* These assert what actually goes ON THE WIRE, which every other test in this file is blind to: the intercepts elsewhere match on path and method alone, so a grant
   * that swapped the client id and secret, or one that never sent the renewal grant type at all, would satisfy the entire suite. The account would simply fail to
   * authenticate in the field with nothing red anywhere.
   *
   * The matcher is undici's own body predicate, so the assertion runs against the serialized form the server would receive rather than against anything the client
   * hands back. A request whose body does not satisfy the predicate matches no intercept and the call fails, which is what turns a wrong body into a red test.
   */
  test("the password grant sends exactly the six parameters the account API expects", async () => {

    const harness = makeV2Harness((agent, record) => {

      agent.get(V2_ORIGIN).intercept({ body: (body) => {

        const params = new URLSearchParams(body);

        return (params.get("client_id") === HYDRAWISE_V2_CLIENT_ID) && (params.get("client_secret") === HYDRAWISE_V2_CLIENT_SECRET) &&
          (params.get("grant_type") === "password") && (params.get("scope") === "all") && (params.get("username") === "test-user") &&
          (params.get("password") === "test-password") && ([...params.keys()].length === 6);
      }, method: "POST", path: TOKEN_PATH }).reply(200, (): object => {

        record(TOKEN_PATH);

        return TOKEN_BODY;
      }).persist();
    });

    // The grant resolving at all is the assertion: only a body satisfying every clause above matches the intercept, so the id and the secret cannot be swapped and
    // no parameter can be dropped, added, or renamed.
    assert.deepEqual(await harness.client.ensureToken(), granted("access-one"), "the password grant reaches the wire carrying exactly its six documented parameters");
    assert.equal(harness.calls.length, 1, "and it spent exactly one grant doing it");
  });

  test("the renewal sends the refresh_token grant, not another password grant", async () => {

    const harness = makeV2Harness((agent, record) => {

      // The first grant is a password grant answering a token already inside the proactive-refresh window, so the very next call must renew.
      agent.get(V2_ORIGIN).intercept({ body: (body) => new URLSearchParams(body).get("grant_type") === "password", method: "POST", path: TOKEN_PATH })
        .reply(200, (): object => {

          record(TOKEN_PATH);

          return { access_token: "access-one", expires_in: 30, refresh_token: "refresh-one" };
        });

      /* The renewal's own intercept accepts ONLY a refresh_token grant presenting the token the first answer carried, and carrying neither of the account
       * credentials - a renewal that fell back to re-sending the username and password would match nothing here and fail.
       */
      agent.get(V2_ORIGIN).intercept({ body: (body) => {

        const params = new URLSearchParams(body);

        return (params.get("grant_type") === "refresh_token") && (params.get("refresh_token") === "refresh-one") &&
          (params.get("client_id") === HYDRAWISE_V2_CLIENT_ID) && (params.get("client_secret") === HYDRAWISE_V2_CLIENT_SECRET) &&
          (params.get("scope") === "all") && (params.get("username") === null) && (params.get("password") === null);
      }, method: "POST", path: TOKEN_PATH }).reply(200, (): object => {

        record(TOKEN_PATH);

        return RENEWED_TOKEN_BODY;
      });
    });

    assert.deepEqual(await harness.client.ensureToken(), granted("access-one"), "the first call runs the password grant");
    assert.deepEqual(await harness.client.ensureToken(), granted("access-two"), "the renewal presents the refresh token rather than the account credentials");
    assert.equal(harness.calls.length, 2, "exactly two grants, one of each kind");
  });
});

describe("HydrawiseV2Client account facts", () => {

  test("asks for every field the enrichment reads, and for none of the fields that answer with a server error", async () => {

    let asked = "";

    const harness = makeV2Harness((agent, record) => {

      programReply(agent, record, TOKEN_PATH, TOKEN_BODY);

      agent.get(V2_ORIGIN).intercept({ body: (body) => {

        asked = (JSON.parse(body) as { query: string }).query;

        return true;
      }, method: "POST", path: GRAPH_PATH }).reply(200, (): object => {

        record(GRAPH_PATH);

        return ACCOUNT_BODY;
      }).persist();
    });

    await harness.client.fetchAccountFacts();

    /* Every selection the enrichment actually consumes, named individually so dropping one is a failure here rather than a field that silently reads as absent.
     * The two name selections are named with the block that carries each, because a bare "name" would be satisfied by either one and could not tell a dropped
     * controller name from a dropped zone name.
     */
    for(const selection of [ "id", "controllers { id name", "zones { id name", "status { online }", "model { description }", "firmware { type version }",
      "suspendedUntil { timestamp }", "model { sensorType }", "status { active }" ]) {

      assert.ok(asked.includes(selection), "the account query asks for " + selection);
    }

    /* The two deliberate omissions, asserted as omissions. The sensor model's mode answers an internal error under HTTP 200 that nulls the whole sensor entry, so
     * selecting it would cost every zone its sensor reading on every read rather than just that one field.
     *
     * The mode check matches a whole FIELD rather than a substring, because "mode" sits inside "model" - which the selection legitimately asks for twice - and a
     * substring test would fail against a perfectly correct query.
     */
    assert.ok(!(/\bmode\b/).test(asked), "the sensor mode that answers a server error is never selected");
    assert.ok(!asked.includes("lastRun") && !asked.includes("nextRun"), "the unproven run fields are never selected");
  });

  test("asks the controller itself for its name, in the selection the live capture proves is a plain scalar there", async () => {

    const queries: string[] = [];

    const harness = makeV2Harness((agent, record) => {

      programReply(agent, record, TOKEN_PATH, TOKEN_BODY);
      programGraph(agent, record, ACCOUNT_BODY, queries);
    });

    await harness.client.fetchAccountFacts();

    /* The controller selection as it goes on the wire, asserted as text. The name is what the key-based API truncates, and the 2026-08-09 capture records it at the
     * controller level as a plain scalar - so it takes no subselection, and asking for it with one would fail the whole query rather than just this field. A
     * substring naming the block is what tells this selection from the zone block's own name a few characters later.
     */
    assert.equal(queries.length, 1, "one account query goes on the wire");
    assert.ok(queries[0]?.includes("controllers { id name status { online }"), "the controller selection asks for its own name beside its id");
  });

  test("parses the captured whole-account answer into the facts shape", async () => {

    const harness = makeV2Harness((agent, record) => {

      programReply(agent, record, TOKEN_PATH, TOKEN_BODY);
      programReply(agent, record, GRAPH_PATH, ACCOUNT_BODY);
    });

    const facts = await answeredFacts(harness.client);

    assert.deepEqual([...facts.keys()], [1058515], "the map is keyed on the id that matches the v1 controller, never on the sibling device id");

    const entry = facts.get(1058515);

    // The model is held to the DESCRIPTION, which is the full name a user recognizes. The capture carries the shorter name field beside it, so a mapping that
    // reached for that instead would answer "38 Zones" here.
    assert.deepEqual(entry?.hardware, { firmware: "4.76", model: "HCC 38 Zones" }, "the captured controller composes its captured model and firmware");
    assert.equal(entry.online, true, "the captured controller reports itself reachable");

    /* The per-zone facts land on their OWN ids, which is the correlation claim. The suspended zone carries its captured instant and the quiet one carries null,
     * so a composer that keyed zones positionally, or that joined on the display number instead of the id, would swap these two.
     */
    assert.equal(entry.zones.get(SUSPENDED_ZONE_ID)?.suspendedUntil, SUSPENDED_UNTIL, "the suspended zone carries its own suspension instant");
    assert.equal(entry.zones.get(QUIET_ZONE_ID)?.suspendedUntil, null, "a zone answering a null suspension is not suspended");

    // The covered zone is the one the sensor names, and the sensor reads tripped, so exactly that zone is sensor-stopped while its uncovered sibling is not.
    assert.equal(entry.zones.get(QUIET_ZONE_ID)?.sensorStopped, true, "the zone the tripped sensor covers reads as stopped");
    assert.equal(entry.zones.get(SUSPENDED_ZONE_ID)?.sensorStopped, false, "a zone no tripped sensor covers reads as not stopped, rather than as unknown");
  });

  test("carries each zone's full name, and composes null for any answer that is not one", async () => {

    const harness = makeV2Harness((agent, record) => {

      programReply(agent, record, TOKEN_PATH, TOKEN_BODY);
      programReply(agent, record, GRAPH_PATH, ACCOUNT_BODY);
    });

    const entry = (await answeredFacts(harness.client)).get(1058515);

    // The account's own name for each zone, landing on that zone's own entry. The key-based wire truncates these at roughly fifteen characters, which is the whole
    // reason the enrichment reaches for them.
    assert.equal(entry?.zones.get(QUIET_ZONE_ID)?.name, "Parkway North", "a zone carries the name the account reports for it");
    assert.equal(entry.zones.get(SUSPENDED_ZONE_ID)?.name, "Sideyard Vegetable Garden", "including one longer than the key-based API can express");
  });

  test("carries the controller's own name, trimmed, and composes null for any answer that is not one", async () => {

    const harness = makeV2Harness((agent, record) => {

      programReply(agent, record, TOKEN_PATH, TOKEN_BODY);
      programReply(agent, record, GRAPH_PATH, ACCOUNT_BODY);
    });

    // The name the live capture records for the owner's controller, landing on that controller's own facts entry.
    assert.equal((await answeredFacts(harness.client)).get(1058515)?.name, "Home", "a controller carries the name the account reports for it");

    /* Every way an answer can carry no usable controller name, plus the incidental whitespace one that IS usable once trimmed. They degrade exactly as a zone's
     * name does, and for the same two reasons: null leaves the wire's own name standing where an empty string would blank the controller's label, and trimming
     * keeps the account and key-based answers comparing equal rather than churning the accessory cache on every refresh.
     *
     * The absent case states the name as undefined, which never survives serialization to the wire - the reply the client parses simply carries no name field.
     */
    const cases = [ { expected: null, label: "an absent name", name: undefined }, { expected: null, label: "an empty name", name: "" },
      { expected: null, label: "a whitespace-only name", name: "   " }, { expected: "Home", label: "a padded name", name: "  Home  " } ];

    for(const scenario of cases) {

      const scenarioHarness = makeV2Harness((agent, record) => {

        programReply(agent, record, TOKEN_PATH, TOKEN_BODY);
        programReply(agent, record, GRAPH_PATH, { data: { me: { controllers: [{ ...CAPTURED_CONTROLLER, name: scenario.name, sensors: CAPTURED_SENSORS,
          status: { online: true }, zones: CAPTURED_ZONES }] } } });
      });

      // eslint-disable-next-line no-await-in-loop
      const facts = await answeredFacts(scenarioHarness.client);

      assert.equal(facts.get(1058515)?.name, scenario.expected, scenario.label + " composes " + JSON.stringify(scenario.expected));
    }
  });

  test("a name the account cannot usefully answer composes null rather than an empty display", async () => {

    /* Every way an answer can carry no usable name, asserted together because they have to degrade identically: no name field at all, an empty string, and one
     * that is nothing but whitespace. Each composes null, which leaves the wire's own name standing - where an empty string would blank a zone's label outright.
     */
    const cases = [ { label: "an absent name", zone: { id: QUIET_ZONE_ID, status: { suspendedUntil: null } } },
      { label: "an empty name", zone: { id: QUIET_ZONE_ID, name: "", status: { suspendedUntil: null } } },
      { label: "a whitespace-only name", zone: { id: QUIET_ZONE_ID, name: "   ", status: { suspendedUntil: null } } } ];

    for(const scenario of cases) {

      const harness = makeV2Harness((agent, record) => {

        programReply(agent, record, TOKEN_PATH, TOKEN_BODY);
        programReply(agent, record, GRAPH_PATH,
          { data: { me: { controllers: [{ ...CAPTURED_CONTROLLER, sensors: CAPTURED_SENSORS, status: { online: true }, zones: [scenario.zone] }] } } });
      });

      // eslint-disable-next-line no-await-in-loop
      const facts = await answeredFacts(harness.client);

      assert.equal(facts.get(1058515)?.zones.get(QUIET_ZONE_ID)?.name, null, scenario.label + " composes null");
    }
  });

  test("a name carrying incidental whitespace is trimmed to what the display will use", async () => {

    const harness = makeV2Harness((agent, record) => {

      programReply(agent, record, TOKEN_PATH, TOKEN_BODY);
      programReply(agent, record, GRAPH_PATH, { data: { me: { controllers: [{ ...CAPTURED_CONTROLLER, sensors: CAPTURED_SENSORS, status: { online: true },
        zones: [{ id: QUIET_ZONE_ID, name: "  Parkway North  ", status: { suspendedUntil: null } }] }] } } });
    });

    // The key-based path trims the names it receives, so the account path trims too - otherwise the same zone would compare unequal between the two and churn the
    // accessory cache on every refresh.
    assert.equal((await answeredFacts(harness.client)).get(1058515)?.zones.get(QUIET_ZONE_ID)?.name, "Parkway North", "a name arrives trimmed");
  });

  test("a sensor reporting itself quiet composes a definite NOT-stopped rather than an unknown", async () => {

    // The distinction this assertion exists for: a live sensor that is not tripped is real evidence the zones it covers are not rain-stopped, and it has to reach the
    // classifier as false so that the key-based group inference is retired rather than consulted.
    const quiet = [{ ...CAPTURED_SENSORS[0], status: { active: false } }];

    const harness = makeV2Harness((agent, record) => {

      programReply(agent, record, TOKEN_PATH, TOKEN_BODY);
      programReply(agent, record, GRAPH_PATH,
        { data: { me: { controllers: [{ ...CAPTURED_CONTROLLER, sensors: quiet, status: { online: true }, zones: CAPTURED_ZONES }] } } });
    });

    const facts = await answeredFacts(harness.client);

    assert.equal(facts.get(1058515)?.zones.get(QUIET_ZONE_ID)?.sensorStopped, false, "a quiet sensor answers false, not null");
  });

  test("two sensors covering one zone read as stopped when ANY of them is tripped", async () => {

    /* The some-versus-every assertion an all-single-sensor suite cannot see. One tripped sensor stops the zones it covers whatever its siblings report, so a composer
     * written with `every` would answer false here and silently suppress a real rain stop on a controller with more than one sensor.
     */
    const mixed = [ { ...CAPTURED_SENSORS[0], status: { active: false } },
      { ...CAPTURED_SENSORS[0], id: 394650, status: { active: true }, zones: [{ id: QUIET_ZONE_ID }] } ];

    const harness = makeV2Harness((agent, record) => {

      programReply(agent, record, TOKEN_PATH, TOKEN_BODY);
      programReply(agent, record, GRAPH_PATH,
        { data: { me: { controllers: [{ ...CAPTURED_CONTROLLER, sensors: mixed, status: { online: true }, zones: CAPTURED_ZONES }] } } });
    });

    const facts = await answeredFacts(harness.client);

    assert.equal(facts.get(1058515)?.zones.get(QUIET_ZONE_ID)?.sensorStopped, true, "one tripped sensor is enough to stop the zone it covers");
  });

  test("an answer carrying no usable sensor leaves every zone's sensor state UNKNOWN", async () => {

    /* Both ways an answer can carry no usable sensor, asserted together because they have to degrade identically: a controller reporting no sensors at all, and
     * one reporting a sensor of a kind outside the level family. Either way the zones answer null, which is what routes them back to the key-based group
     * inference rather than inventing a stop or denying one.
     */
    const unknownKind = [{ ...CAPTURED_SENSORS[0], model: { sensorType: "FLOW_METER" }, status: { active: true } }];

    for(const sensors of [ [], unknownKind ]) {

      const harness = makeV2Harness((agent, record) => {

        programReply(agent, record, TOKEN_PATH, TOKEN_BODY);
        programReply(agent, record, GRAPH_PATH,
          { data: { me: { controllers: [{ ...CAPTURED_CONTROLLER, sensors, status: { online: true }, zones: CAPTURED_ZONES }] } } });
      });

      // eslint-disable-next-line no-await-in-loop
      const facts = await answeredFacts(harness.client);

      assert.equal(facts.get(1058515)?.zones.get(QUIET_ZONE_ID)?.sensorStopped, null, "a sensor answer this plugin cannot read composes an unknown");
    }
  });

  test("an unreachable controller composes a FALSE availability, not an absent one", async () => {

    // Both polarities are fixtured, because a one-value fixture cannot catch a read that inverted the field or that hardcoded the answer.
    const harness = makeV2Harness((agent, record) => {

      programReply(agent, record, TOKEN_PATH, TOKEN_BODY);
      programReply(agent, record, GRAPH_PATH,
        { data: { me: { controllers: [{ ...CAPTURED_CONTROLLER, sensors: CAPTURED_SENSORS, status: { online: false }, zones: CAPTURED_ZONES }] } } });
    });

    assert.equal((await answeredFacts(harness.client)).get(1058515)?.online, false, "an offline controller reports itself offline");
  });

  test("a controller answering no status block at all reports an unknown availability", async () => {

    const harness = makeV2Harness((agent, record) => {

      programReply(agent, record, TOKEN_PATH, TOKEN_BODY);
      programReply(agent, record, GRAPH_PATH, { data: { me: { controllers: [{ ...CAPTURED_CONTROLLER, zones: CAPTURED_ZONES }] } } });
    });

    assert.equal((await answeredFacts(harness.client)).get(1058515)?.online, null, "an absent availability is unknown rather than reachable");
  });

  test("selects the controller's own firmware entry rather than the first one in the list", async () => {

    /* The synthetic module entry is ordered FIRST deliberately. A naive implementation that took the head of the list would answer with the adapter's version, so
     * this ordering is what makes the by-type selection rule genuinely proven rather than incidentally satisfied.
     */
    const multiEntry = { ...CAPTURED_CONTROLLER,
      hardware: { ...CAPTURED_CONTROLLER.hardware, firmware: [ { type: "adapter", version: "1.40" }, { type: "controller", version: "4.76" } ] } };

    const harness = makeV2Harness((agent, record) => {

      programReply(agent, record, TOKEN_PATH, TOKEN_BODY);
      programReply(agent, record, GRAPH_PATH, { data: { me: { controllers: [multiEntry] } } });
    });

    assert.equal((await answeredFacts(harness.client)).get(1058515)?.hardware?.firmware, "4.76",
      "the entry whose type names the controller is the one selected");
  });

  test("a controller with no controller-firmware entry composes no hardware, while its other facts still land", async () => {

    const noController = { ...CAPTURED_CONTROLLER, hardware: { ...CAPTURED_CONTROLLER.hardware, firmware: [{ type: "adapter", version: "1.40" }] },
      status: { online: true }, zones: CAPTURED_ZONES };

    const harness = makeV2Harness((agent, record) => {

      programReply(agent, record, TOKEN_PATH, TOKEN_BODY);
      programReply(agent, record, GRAPH_PATH, { data: { me: { controllers: [noController] } } });
    });

    const entry = (await answeredFacts(harness.client)).get(1058515);

    /* Each fact carries its own absence rather than one incomplete field withholding the entry. A half-populated hardware shape would put a real model beside an
     * empty firmware in HomeKit, so it composes nothing at all - but the suspension and availability facts on the same controller are unaffected.
     */
    assert.equal(entry?.hardware, null, "a partial hardware block composes nothing rather than half a shape");
    assert.equal(entry.online, true, "the controller's other facts are untouched by its incomplete hardware");
    assert.equal(entry.zones.get(SUSPENDED_ZONE_ID)?.suspendedUntil, SUSPENDED_UNTIL, "and so are its zones");
  });

  test("a controller with no model description composes no hardware", async () => {

    const noModel = { ...CAPTURED_CONTROLLER, hardware: { ...CAPTURED_CONTROLLER.hardware, model: { name: "38 Zones" } } };

    const harness = makeV2Harness((agent, record) => {

      programReply(agent, record, TOKEN_PATH, TOKEN_BODY);
      programReply(agent, record, GRAPH_PATH, { data: { me: { controllers: [noModel] } } });
    });

    assert.equal((await answeredFacts(harness.client)).get(1058515)?.hardware, null, "a hardware block carrying no description composes nothing");
  });

  test("a controller the answer cannot correlate is skipped entirely", async () => {

    // Without an id there is no way to say which v1 controller these facts belong to, and guessing would enrich the wrong accessory.
    const harness = makeV2Harness((agent, record) => {

      programReply(agent, record, TOKEN_PATH, TOKEN_BODY);
      programReply(agent, record, GRAPH_PATH, { data: { me: { controllers: [{ hardware: CAPTURED_CONTROLLER.hardware, status: { online: true } }] } } });
    });

    const facts = await answeredFacts(harness.client);

    // A successful query that composed nothing is an EMPTY map rather than a null, so the caller can still tell it apart from a query that failed.
    assert.deepEqual([...facts.keys()], [], "a controller carrying no correlation id contributes no entry");
  });

  test("a zone the answer cannot correlate is skipped, leaving its siblings intact", async () => {

    const harness = makeV2Harness((agent, record) => {

      programReply(agent, record, TOKEN_PATH, TOKEN_BODY);
      programReply(agent, record, GRAPH_PATH, { data: { me: { controllers: [{ ...CAPTURED_CONTROLLER,
        zones: [ { status: { suspendedUntil: null } }, ...CAPTURED_ZONES ] }] } } });
    });

    const entry = (await answeredFacts(harness.client)).get(1058515);

    assert.equal(entry?.zones.size, 2, "the zone with no id contributes no entry");
    assert.equal(entry.zones.get(SUSPENDED_ZONE_ID)?.suspendedUntil, SUSPENDED_UNTIL, "its correlatable siblings compose exactly as they would have");
  });

  test("a query draws the rate budget BEFORE it reaches the wire, on top of the grant's own draw", async () => {

    const harness = makeV2Harness((agent, record) => {

      programReply(agent, record, TOKEN_PATH, TOKEN_BODY);
      programReply(agent, record, GRAPH_PATH, ACCOUNT_BODY);
    });

    await harness.client.fetchAccountFacts();

    /* Two calls, two slots, and the ORDER is what the paths record: the query draws its slot first, then the token grant it triggers draws a second, and only then
     * does the grant reach the wire. Reading the slot count at each dispatch is what catches a draw that was dispatched instead of awaited.
     */
    assert.deepEqual(harness.calls.map(call => call.path), [ TOKEN_PATH, GRAPH_PATH ], "the grant dispatches before the query it authenticates");
    assert.equal(harness.calls[0]?.budgetAvailableAtDispatch, HYDRAWISE_V2_BUDGET_CALLS - 2, "the query's slot and the grant's slot are both spent before the " +
      "grant dispatches");
    assert.equal(harness.calls[1]?.budgetAvailableAtDispatch, HYDRAWISE_V2_BUDGET_CALLS - 2, "the query dispatches against the same two spent slots");
    assert.equal(harness.budget.available, HYDRAWISE_V2_BUDGET_CALLS - 2, "one enrichment costs exactly two slots on a cold client");
  });
});

describe("HydrawiseV2Client failure classification", () => {

  test("an HTTP 200 carrying a GraphQL errors array is a failure, not a success", async () => {

    const harness = makeV2Harness((agent, record) => {

      programReply(agent, record, TOKEN_PATH, TOKEN_BODY);
      programReply(agent, record, GRAPH_PATH, { errors: GRAPH_ERRORS });
    });

    // The transport succeeded and the query did not. A classification that read the status alone would hand the caller an absent data field as though it were an
    // answer, and every controller would be quietly left unenriched with nothing reported.
    assert.deepEqual(await harness.client.fetchAccountFacts(), { status: "failed" }, "a body-level errors array with no data classifies as a failed query");

    // The reported line is read as the operator sees it, whole. The read's own sentence and the account's message reach the log as separate printf arguments, so
    // an assertion against either argument alone would check half the sentence and pass while the other half went missing.
    assert.deepEqual(errorLines(harness.entries), ["Unable to retrieve enhanced controller details: Internal server error."],
      "the reported failure names the read that failed and what the API said was wrong");
  });

  test("a non-2xx query status is a failure", async () => {

    const harness = makeV2Harness((agent, record) => {

      programReply(agent, record, TOKEN_PATH, TOKEN_BODY);
      programReply(agent, record, GRAPH_PATH, { message: "Internal Server Error" }, 500);
    });

    assert.deepEqual(await harness.client.fetchAccountFacts(), { status: "failed" }, "a refused query answers failed rather than a partial result");

    // The status branch's own sentence, asserted whole for the same reason the errors branch above is: the read states what it was doing and the transport states
    // what it got, and the two reach the log as separate arguments of one line.
    assert.deepEqual(errorLines(harness.entries), ["Unable to retrieve enhanced controller details. The Hydrawise API answered with status 500."],
      "the refused read is reported under the read's own sentence");
  });

  test("a failed grant leaves the query unattempted", async () => {

    const harness = makeV2Harness((agent, record) => {

      programReply(agent, record, TOKEN_PATH, REFUSED_GRANT_BODY, 401);
      programReply(agent, record, GRAPH_PATH, ACCOUNT_BODY);
    });

    assert.deepEqual(await harness.client.fetchAccountFacts(), { status: "failed" }, "a query with no token to present fails");
    assert.deepEqual(harness.calls.map(call => call.path), [TOKEN_PATH], "the query never reached the wire without a token");
  });

  test("a generic transport failure is reported and answers failed", async () => {

    /* The classification's final arm, which every other failure test routes around: not a shutdown, not a timeout, just a transport that threw. Without this case
     * the timeout branch could silently absorb the general one - a mis-scoped condition catching everything - and no test would notice, because the caller sees the
     * same failed read either way. What tells them apart is what reaches the user, so that is what this asserts.
     */
    const harness = makeV2Harness((agent, record) => {

      programReply(agent, record, TOKEN_PATH, TOKEN_BODY);
      agent.get(V2_ORIGIN).intercept({ method: "POST", path: GRAPH_PATH }).replyWithError(new Error("socket hang up"));
    });

    assert.deepEqual(await harness.client.fetchAccountFacts(), { status: "failed" }, "a thrown transport failure answers as every recoverable failure does");

    // Read as the operator sees it, whole. The read composes its own sentence with the reason the transport handed back, so what is asserted is the line rather
    // than whichever argument a given composition happens to put it in.
    const reported = errorLines(harness.entries);

    assert.equal(reported.length, 1, "it is reported exactly once");
    assert.ok(reported[0]?.startsWith("Unable to retrieve enhanced controller details: "), "under the read's own sentence");
    assert.ok(reported.some(line => line.includes("socket hang up")), "and the report carries what actually went wrong");
    assert.ok(!reported.some(line => line.includes("too long to respond")), "a generic failure is not narrated as a timeout");
  });

  test("a shutdown while a read is QUEUED for a slot answers the same quiet failure", async () => {

    const controller = new AbortController();

    const harness = makeV2Harness((agent, record) => {

      programReply(agent, record, TOKEN_PATH, TOKEN_BODY);
      programReply(agent, record, GRAPH_PATH, ACCOUNT_BODY);
    }, { capacity: 1, signal: controller.signal });

    // Spend the only slot, so the read below waits in the budget's queue rather than reaching the transport at all.
    await harness.budget.acquire();

    const read = harness.client.fetchAccountFacts();

    controller.abort("shutdown");

    /* The read's pacing wait sits inside its own try, which is what makes this quiet rather than an escaping rejection. Callers and tests alike consume this method
     * bare, so a shutdown arriving while a scheduled read was still queued would otherwise surface as an unhandled rejection at teardown.
     */
    assert.deepEqual(await read, { status: "failed" }, "a read torn down while queued answers failed like every other recoverable failure");
    assert.deepEqual(errorLines(harness.entries), [], "and a shutdown is not an error");
    assert.deepEqual(harness.calls, [], "nothing reached the wire");
  });

  test("a shutdown in flight reports nothing", async () => {

    const controller = new AbortController();

    const harness = makeV2Harness((agent, record) => {

      agent.get(V2_ORIGIN).intercept({ method: "POST", path: TOKEN_PATH }).reply(200, (): object => {

        record(TOKEN_PATH);
        controller.abort("shutdown");

        return TOKEN_BODY;
      }).persist();

      programReply(agent, record, GRAPH_PATH, ACCOUNT_BODY);
    }, { signal: controller.signal });

    // Aborting mid-flight is orderly teardown rather than a fault, so it answers the same quiet failure every other recoverable failure does and logs nothing at all.
    const result = await harness.client.fetchAccountFacts();

    assert.deepEqual(result, { status: "failed" }, "a shutdown reached mid-request answers failed");
    assert.equal(harness.entries.filter(line => line.level === "error").length, 0, "a shutdown is not an error and reports nothing");
  });
});

describe("HydrawiseV2Client partial answers", () => {

  test("the captured partial body answers its facts, writes no error line, and logs the errors at debug", async () => {

    const harness = makeV2Harness((agent, record) => {

      programReply(agent, record, TOKEN_PATH, TOKEN_BODY);
      programReply(agent, record, GRAPH_PATH, GRAPH_ERRORS_BODY);
    });

    const entry = (await answeredFacts(harness.client)).get(1058515);

    assert.equal(entry?.name, "Home", "the controller's name stands");
    assert.equal(entry.online, true, "and its availability");
    assert.equal(entry.hardware, null, "a selection that asked for no hardware composes none");
    assert.deepEqual([...entry.zones.keys()], [ QUIET_ZONE_ID, SUSPENDED_ZONE_ID ], "every zone the error did not name stands");
    assert.equal(entry.zones.get(QUIET_ZONE_ID)?.name, "Parkway North", "with its name");
    assert.equal(entry.zones.get(SUSPENDED_ZONE_ID)?.suspendedUntil, SUSPENDED_UNTIL, "and its suspension");
    assert.equal(entry.zones.get(QUIET_ZONE_ID)?.sensorStopped, null, "while the nulled sensor leaves every zone's sensor reading to the key-based inference");
    assert.deepEqual(errorLines(harness.entries), [], "a partial answer is no failure, so it writes no error line");
    assert.deepEqual(linesAt(harness.entries, "debug"), ["Unable to retrieve enhanced controller details: Internal server error."],
      "and its errors are said at debug under the read's sentence");
  });

  test("a null entry in each widened list is dropped and the read answers", async () => {

    /* A null in every list at once, each ahead of an entry that stands, so a read that dereferences any one of them unguarded rejects here. The read has no catch
     * above it, so that rejection would end the refresh loop until a restart.
     */
    const sensor = { ...CAPTURED_SENSORS[0], zones: [ null, { id: QUIET_ZONE_ID } ] };
    const harness = makeV2Harness((agent, record) => {

      programReply(agent, record, TOKEN_PATH, TOKEN_BODY);
      programReply(agent, record, GRAPH_PATH, { data: { me: { controllers: [ null, { ...CAPTURED_CONTROLLER,
        hardware: { ...CAPTURED_CONTROLLER.hardware, firmware: [ null, { type: "controller", version: "4.76" } ] }, sensors: [ null, sensor ], status: { online: true },
        zones: [ null, ...CAPTURED_ZONES ] } ] } } });
    });

    const facts = await answeredFacts(harness.client);
    const entry = facts.get(1058515);

    assert.deepEqual([...facts.keys()], [1058515], "the null controller entry is dropped, and the one beside it stands");
    assert.deepEqual(entry?.hardware, { firmware: "4.76", model: "HCC 38 Zones" }, "the null firmware entry is dropped, and the one beside it is selected");
    assert.deepEqual([...entry.zones.keys()], [ QUIET_ZONE_ID, SUSPENDED_ZONE_ID ], "the null zone entry is dropped, and the zones beside it stand");
    assert.deepEqual(errorLines(harness.entries), [], "and nothing is reported");
  });

  test("a controller or a zone whose id is null is dropped and the read answers", async () => {

    // A null can sit under a non-null marker, so a read that asked only whether an entry exists would key the facts on null.
    const harness = makeV2Harness((agent, record) => {

      programReply(agent, record, TOKEN_PATH, TOKEN_BODY);
      programReply(agent, record, GRAPH_PATH, { data: { me: { controllers: [ { ...CAPTURED_CONTROLLER, id: null, zones: CAPTURED_ZONES },
        { ...CAPTURED_CONTROLLER, zones: [ { id: null, name: "Unnumbered" }, ...CAPTURED_ZONES ] } ] } } });
    });

    const facts = await answeredFacts(harness.client);

    assert.deepEqual([...facts.keys()], [1058515], "the controller with a null id is dropped, and the one beside it stands");
    assert.deepEqual([...(facts.get(1058515)?.zones.keys() ?? [])], [ QUIET_ZONE_ID, SUSPENDED_ZONE_ID ], "and so is the zone with a null id, and those beside it stand");
    assert.deepEqual(errorLines(harness.entries), [], "with nothing reported");
  });

  test("an error costs only the controller whose index its path names", async () => {

    // The index counts the wire's own list, the null entry ahead of these two included, so the error's path names the second controller that stands.
    const errors = [{ message: "Internal server error", path: [ "me", "controllers", 2, "zones", 0, "status", "suspendedUntil" ] }];
    const harness = makeV2Harness((agent, record) => {

      programReply(agent, record, TOKEN_PATH, TOKEN_BODY);
      programReply(agent, record, GRAPH_PATH, { data: { me: { controllers: [ null, { ...CAPTURED_CONTROLLER, zones: CAPTURED_ZONES },
        { ...CAPTURED_CONTROLLER, id: 1058516, zones: CAPTURED_ZONES } ] } }, errors });
    });

    const facts = await answeredFacts(harness.client);

    assert.deepEqual([...(facts.get(1058515)?.zones.keys() ?? [])], [ QUIET_ZONE_ID, SUSPENDED_ZONE_ID ], "the controller the path does not name keeps every zone");
    assert.deepEqual([...(facts.get(1058516)?.zones.keys() ?? [])], [SUSPENDED_ZONE_ID], "and the one it names loses the zone it names");
  });

  test("errors beside data that leave no controller entry fail, under the read's sentence", async () => {

    // An error under a field the server cannot null on its own takes the whole controller entry. Answering that as an empty map would report a connection that
    // enriched nothing, and every enhanced fact would age out with no line saying why.
    for(const data of [ { me: { controllers: [null] } }, { me: { controllers: [{ id: null }] } }, { me: { controllers: [] } }, { me: null } ]) {

      const harness = makeV2Harness((agent, record) => {

        programReply(agent, record, TOKEN_PATH, TOKEN_BODY);
        programReply(agent, record, GRAPH_PATH, { data, errors: GRAPH_ERRORS });
      });

      // eslint-disable-next-line no-await-in-loop
      assert.deepEqual(await harness.client.fetchAccountFacts(), { status: "failed" }, JSON.stringify(data) + " beside errors is a failed read");
      assert.deepEqual(errorLines(harness.entries), ["Unable to retrieve enhanced controller details: Internal server error."], "and it writes the read's error line");
    }
  });

  test("a body carrying neither data nor errors is a failed read with nothing to report", async () => {

    const harness = makeV2Harness((agent, record) => {

      programReply(agent, record, TOKEN_PATH, TOKEN_BODY);
      programReply(agent, record, GRAPH_PATH, {});
    });

    assert.deepEqual(await harness.client.fetchAccountFacts(), { status: "failed" }, "an answer with nothing in it enriches nothing");
    assert.deepEqual(errorLines(harness.entries), [], "and it has no reason to give");
  });
});

describe("HydrawiseV2Client throttling", () => {

  test("a graph 429 answers throttled, named under the read's sentence", async () => {

    const harness = makeV2Harness((agent, record) => {

      programReply(agent, record, TOKEN_PATH, TOKEN_BODY);
      programReply(agent, record, GRAPH_PATH, { message: "Too Many Requests" }, 429);
    });

    assert.deepEqual(await harness.client.fetchAccountFacts(), { status: "throttled" }, "the refresh loop can tell this failure from every other");
    assert.deepEqual(errorLines(harness.entries), ["Unable to retrieve enhanced controller details. The Hydrawise API rate limit has been exceeded."],
      "and the line names the rate limit rather than a status");
  });

  test("a token 429 answers throttled and a token 500 or 503 failed, each under the sign-in sentence and none with the credentials sentence", async () => {

    const cells = [ { line: "The Hydrawise API rate limit has been exceeded.", status: "throttled", statusCode: 429 },
      { line: "The Hydrawise API answered with status 500.", status: "failed", statusCode: 500 },
      { line: "The Hydrawise API answered with status 503.", status: "failed", statusCode: 503 } ];

    for(const { line, status, statusCode } of cells) {

      const harness = makeV2Harness((agent, record) => {

        programReply(agent, record, TOKEN_PATH, { error: "unavailable" }, statusCode);
        programReply(agent, record, GRAPH_PATH, ACCOUNT_BODY);
      });

      // eslint-disable-next-line no-await-in-loop
      assert.deepEqual(await harness.client.fetchAccountFacts(), { status }, "a " + statusCode.toString() + " from the token endpoint answers " + status);
      assert.deepEqual(errorLines(harness.entries), ["Unable to sign in to your Hydrawise account for enhanced features. " + line], "and blames nobody's password");
      assert.deepEqual(harness.calls.map(call => call.path), [TOKEN_PATH], "with the query never reaching the wire");
    }
  });

  test("a refused password grant keeps the credentials sentence", async () => {

    const harness = makeV2Harness((agent, record) => {

      programReply(agent, record, TOKEN_PATH, REFUSED_GRANT_BODY, 401);
      programReply(agent, record, GRAPH_PATH, ACCOUNT_BODY);
    });

    assert.deepEqual(await harness.client.fetchAccountFacts(), { status: "failed" }, "a refused password is a failed read");
    assert.deepEqual(errorLines(harness.entries),
      ["Unable to sign in to your Hydrawise account for enhanced features. Please check the username and password you have configured."],
      "and it is the one failure that really does say the credentials are wrong");
  });
});

describe("HydrawiseV2Client token recovery", () => {

  // A first grant already inside the proactive-refresh window, so the next fetch renews.
  const SHORT_LIVED_TOKEN_BODY = { access_token: "access-one", expires_in: 30, refresh_token: "refresh-one" };

  test("a 401 on a read makes the next fetch run a fresh password grant", async () => {

    const grants: (string | null)[] = [];
    const harness = makeV2Harness((agent, record) => {

      programGrants(agent, grants, [ { body: TOKEN_BODY }, { body: RENEWED_TOKEN_BODY } ]);

      agent.get(V2_ORIGIN).intercept({ method: "POST", path: GRAPH_PATH }).reply(401, (): object => {

        record(GRAPH_PATH);

        return { message: "The resource owner or authorization server denied the request." };
      });

      programReply(agent, record, GRAPH_PATH, ACCOUNT_BODY);
    });

    assert.deepEqual(await harness.client.fetchAccountFacts(), { status: "failed" }, "the refused read ends its own tick, with nothing retried inside it");
    assert.deepEqual(grants, ["password"], "the first fetch spent one grant");
    assert.equal(harness.calls.filter(call => call.path === GRAPH_PATH).length, 1, "and one read");
    assert.deepEqual(errorLines(harness.entries), ["Unable to retrieve enhanced controller details. The Hydrawise API answered with status 401."],
      "the refusal is reported under the read's own sentence");

    assert.ok((await answeredFacts(harness.client)).has(1058515), "the next fetch answers on a fresh token");
    assert.deepEqual(grants, [ "password", "password" ], "which came from a password grant rather than the token the server refused");
  });

  test("a refused refresh grant falls back to the password grant inside the same fetch", async () => {

    const grants: (string | null)[] = [];
    const harness = makeV2Harness((agent, record) => {

      programGrants(agent, grants, [ { body: SHORT_LIVED_TOKEN_BODY }, { body: REFUSED_GRANT_BODY, statusCode: 401 }, { body: RENEWED_TOKEN_BODY } ]);
      programReply(agent, record, GRAPH_PATH, ACCOUNT_BODY);
    });

    assert.ok((await answeredFacts(harness.client)).has(1058515), "the first fetch signs in");
    assert.ok((await answeredFacts(harness.client)).has(1058515), "and the second answers its facts despite the refused renewal");
    assert.deepEqual(grants, [ "password", "refresh_token", "password" ], "the fallback ran inside the fetch that needed it");
    assert.deepEqual(errorLines(harness.entries), [], "and it is silent for the refused renewal, with no credentials line");
    assert.deepEqual(await harness.client.ensureToken(), granted("access-two"), "the fallback's token is the one held");
  });

  test("a fallback the password grant then refuses says the credentials are wrong", async () => {

    const grants: (string | null)[] = [];
    const harness = makeV2Harness((agent, record) => {

      programGrants(agent, grants, [ { body: SHORT_LIVED_TOKEN_BODY }, { body: REFUSED_GRANT_BODY, statusCode: 401 }, { body: REFUSED_GRANT_BODY, statusCode: 401 } ]);
      programReply(agent, record, GRAPH_PATH, ACCOUNT_BODY);
    });

    await harness.client.fetchAccountFacts();

    assert.deepEqual(await harness.client.fetchAccountFacts(), { status: "failed" }, "with no grant left there is no read");
    assert.deepEqual(grants, [ "password", "refresh_token", "password" ], "the password was tried once more");
    assert.deepEqual(errorLines(harness.entries),
      ["Unable to sign in to your Hydrawise account for enhanced features. Please check the username and password you have configured."],
      "and only the refused password is reported");
  });

  test("a renewal answered 429, 500 or 503 keeps its token state, so the next fetch renews rather than presenting the password", async () => {

    for(const [ statusCode, status ] of [ [ 429, "throttled" ], [ 500, "failed" ], [ 503, "failed" ] ] as const) {

      const grants: (string | null)[] = [];

      // Each fetch draws the ceiling for its read and its grant, and the harness's window never closes, so this run is given the room to finish.
      const harness = makeV2Harness((agent, record) => {

        programGrants(agent, grants, [ { body: SHORT_LIVED_TOKEN_BODY }, { body: { error: "unavailable" }, statusCode }, { body: RENEWED_TOKEN_BODY } ]);
        programReply(agent, record, GRAPH_PATH, ACCOUNT_BODY);
      }, { capacity: HYDRAWISE_V2_BUDGET_CALLS * 2 });

      // eslint-disable-next-line no-await-in-loop
      await harness.client.fetchAccountFacts();

      // eslint-disable-next-line no-await-in-loop
      assert.deepEqual(await harness.client.fetchAccountFacts(), { status }, "the renewal's " + statusCode.toString() + " costs the read its tick");

      // eslint-disable-next-line no-await-in-loop
      assert.ok((await answeredFacts(harness.client)).has(1058515), "and the next fetch answers");
      assert.deepEqual(grants, [ "password", "refresh_token", "refresh_token" ], "because it renewed again, presenting the refresh token it kept");
    }
  });

  test("a renewal cut off by the transport drops the token, so the next fetch runs the password grant", async () => {

    const grants: (string | null)[] = [];
    const harness = makeV2Harness((agent, record) => {

      programGrants(agent, grants, [{ body: SHORT_LIVED_TOKEN_BODY }]);
      agent.get(V2_ORIGIN).intercept({ method: "POST", path: TOKEN_PATH }).replyWithError(errnoError("a transport fault", "ECONNRESET"));
      programGrants(agent, grants, [{ body: RENEWED_TOKEN_BODY }]);
      programReply(agent, record, GRAPH_PATH, ACCOUNT_BODY);
    }, { capacity: HYDRAWISE_V2_BUDGET_CALLS * 2 });

    await harness.client.fetchAccountFacts();

    assert.deepEqual(await harness.client.fetchAccountFacts(), { status: "failed" }, "the fault costs the read its tick");
    assert.ok((await answeredFacts(harness.client)).has(1058515), "and the next fetch answers");
    assert.deepEqual(grants, [ "password", "password" ], "having signed in afresh");
  });
});

describe("HydrawiseV2Client dispatcher", () => {

  test("a timed-out request re-arms the connection pool, and the dispatcher getter answers the replacement", async () => {

    const first = destroyable(new MockAgent());
    const second = new MockAgent();
    const built = [ first, second ];
    const log = capturingLog();
    const signal = new AbortController().signal;

    first.disableNetConnect();
    second.disableNetConnect();

    // The timeout is driven through the request itself rather than by reaching past the class: undici surfaces a request timeout as exactly this DOMException, so
    // rejecting with it puts the client on the same code path a genuinely slow account would.
    first.get(V2_ORIGIN).intercept({ method: "POST", path: TOKEN_PATH })
      .replyWithError(new DOMException("The operation was aborted due to timeout", "TimeoutError")).persist();

    const client = new HydrawiseV2Client({ budget: new RateBudget({ capacity: HYDRAWISE_V2_BUDGET_CALLS, signal, window: HYDRAWISE_V2_BUDGET_WINDOW * 1000 }),
      dispatcherFactory: (): MockAgent => built.shift() ?? second, log,
      password: "test-password", signal, username: "test-user" });

    assert.equal(client.dispatcher, first, "the client starts on the dispatcher its factory built");
    assert.deepEqual(await client.ensureToken(), { status: "failed" }, "a timed-out grant answers a failed one");

    /* A wedged pool carries every request on its single connection, so it is replaced rather than waited out. The getter answering the REPLACEMENT is what makes
     * the platform's teardown correct across this: that registration reads the dispatcher at disposal time, and a captured reference would destroy the pool that
     * was already abandoned while leaving the live one open.
     */
    assert.equal(client.dispatcher, second, "the timeout re-armed the pool, and the getter answers the live one");
    assert.ok(log.entries.some(line => (line.level === "error") && line.message.includes("too long to respond")), "the timeout is reported to the user");
  });

  test("a response deadline re-arms the connection pool exactly as the request deadline does", async () => {

    const first = destroyable(new MockAgent());
    const second = new MockAgent();
    const built = [ first, second ];
    const log = capturingLog();
    const signal = new AbortController().signal;

    first.disableNetConnect();
    second.disableNetConnect();

    // The transport's own header deadline is a deadline elapsing exactly as the composed per-request timeout is, so it takes the same arm: the same sentence, and
    // the same replacement of a pool whose single connection every in-flight request was using.
    first.get(V2_ORIGIN).intercept({ method: "POST", path: TOKEN_PATH }).replyWithError(new errors.HeadersTimeoutError()).persist();

    const client = new HydrawiseV2Client({ budget: new RateBudget({ capacity: HYDRAWISE_V2_BUDGET_CALLS, signal, window: HYDRAWISE_V2_BUDGET_WINDOW * 1000 }),
      dispatcherFactory: (): MockAgent => built.shift() ?? second, log,
      password: "test-password", signal, username: "test-user" });

    assert.equal(client.dispatcher, first, "the client starts on the dispatcher its factory built");
    assert.deepEqual(await client.ensureToken(), { status: "failed" }, "a grant that outran the response deadline answers a failed one");
    assert.equal(client.dispatcher, second, "the deadline re-armed the pool, and the getter answers the live one");
    assert.ok(log.entries.some(line => (line.level === "error") && line.message.includes("too long to respond")), "and the deadline is reported to the user");
  });

  test("every coded transport fault is reported as the sentence the plugin keeps for its kind", async () => {

    /* Each row pairs a wire code with the kind it classifies as, and the expected sentence is READ from the shared table rather than restated here - so what this
     * asserts is the wiring: that a fault of a given kind reaches that kind's entry, joined to the caller's sentence by a period. The prose of each sentence is asserted
     * literally by the retrieve suite's substring assertions over the same table, which divides the work between them: a mis-paired kind fails here, and a mistyped
     * sentence fails there.
     */
    const faultRows: { code: string; kind: HydrawiseTransportFault }[] = [

      { code: "CERT_HAS_EXPIRED", kind: "certificate" },
      { code: "ECONNREFUSED", kind: "refused" },
      { code: "ECONNRESET", kind: "reset" },
      { code: "EHOSTUNREACH", kind: "unreachable" },
      { code: "ENOTFOUND", kind: "dns" },
      { code: "UND_ERR_CONNECT_TIMEOUT", kind: "connect-timeout" },
      { code: "UND_ERR_DESTROYED", kind: "destroyed" },
      { code: "UND_ERR_REQ_RETRY", kind: "retries-exhausted" }
    ];

    assert.deepEqual(faultRows.map(row => row.kind).toSorted(), Object.keys(HYDRAWISE_TRANSPORT_FAULT_SENTENCES).toSorted(),
      "a kind the table names is a row this test demands");

    for(const row of faultRows) {

      const first = destroyable(new MockAgent());
      const second = new MockAgent();
      const built = [ first, second ];
      const log = capturingLog();
      const signal = new AbortController().signal;

      first.disableNetConnect();
      second.disableNetConnect();
      first.get(V2_ORIGIN).intercept({ method: "POST", path: TOKEN_PATH })
        .replyWithError(errnoError("a transport fault", row.code)).persist();

      const client = new HydrawiseV2Client({ budget: new RateBudget({ capacity: HYDRAWISE_V2_BUDGET_CALLS, signal, window: HYDRAWISE_V2_BUDGET_WINDOW * 1000 }),
        dispatcherFactory: (): MockAgent => built.shift() ?? second, log,
        password: "test-password", signal, username: "test-user" });

      // eslint-disable-next-line no-await-in-loop
      assert.deepEqual(await client.ensureToken(), { status: "failed" }, "a coded transport fault answers as every failed grant does");
      assert.deepEqual(errorLines(log.entries),
        ["Unable to sign in to your Hydrawise account for enhanced features. " + HYDRAWISE_TRANSPORT_FAULT_SENTENCES[row.kind]],
        "and it reads as the sign-in sentence joined to the fault's own by a period");
      assert.equal(client.dispatcher, first, "while a fault that is not a deadline leaves the pool alone");
    }
  });

});
