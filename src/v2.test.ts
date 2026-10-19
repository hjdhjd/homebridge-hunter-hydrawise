/* Copyright(C) 2017-2026, HJD (https://github.com/hjdhjd). All rights reserved.
 *
 * v2.test.ts: The Hydrawise v2 client, driven through an injected dispatcher so the token grant, the query, and every failure classification run the real
 * production code against recorded wire traffic and never touch the live account API. Covers token acquisition, lazy renewal, the reset a failed grant performs,
 * the single-flight guarantee two concurrent callers rest on, the selection the account query asks for, the facts composition rules - hardware, availability,
 * per-zone suspension, and the sensor derivation - the rate-budget draws, and the failure classifications, including the one that matters most for a GraphQL
 * endpoint, an HTTP 200 whose body carries an errors array. It also covers the zone-suspension command path in full: the admission a per-zone write takes on
 * its own ceiling, the race that admission runs against a token grant shared with the scheduled reads, and the pool re-arm a timed-out call triggers along
 * the way.
 *
 * Every fixture body below is taken from the live probe captures, so a wrong field mapping fails here rather than in the field.
 */
// The OAuth and GraphQL wire shapes use snake_case keys such as access_token, so camelcase is disabled here to let the fixtures mirror the captured bodies verbatim.
/* eslint-disable camelcase */
import { HYDRAWISE_TRANSPORT_FAULT_SENTENCES, HYDRAWISE_V2_BUDGET_CALLS, HYDRAWISE_V2_BUDGET_WINDOW, HYDRAWISE_V2_CLIENT_ID, HYDRAWISE_V2_CLIENT_SECRET,
  HYDRAWISE_V2_GRAPH_ENDPOINT, HYDRAWISE_V2_MUTATION_ADMISSION_TIMEOUT, HYDRAWISE_V2_MUTATION_BUDGET_CALLS, HYDRAWISE_V2_MUTATION_BUDGET_WINDOW,
  HYDRAWISE_V2_TOKEN_ENDPOINT } from "./settings.ts";
import { MockAgent, errors } from "undici";
import { describe, test } from "node:test";
import type { CapturedLogLine } from "./testing.helpers.ts";
import type { HydrawiseTransportFault } from "./settings.ts";
import { HydrawiseV2Client } from "./v2.ts";
import { RateBudget } from "homebridge-plugin-utils";
import assert from "node:assert/strict";
import { capturingLog } from "./testing.helpers.ts";
import { setTimeout as delay } from "node:timers/promises";
import util from "node:util";

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

/* The 2026-08-10 suspension probe's own values, kept verbatim. The instant is the one the account echoed back as the suspension it had recorded, and the two
 * documents are the request bodies the account accepted, byte for byte.
 *
 * Asserting the composed text against the capture rather than against this plugin's own idea of the shape is the whole point: the argument names, the quoting, the
 * two-digit year, and the explicit offset are all things the account enforces and none of them can be derived from the schema.
 */
const PROBE_SUSPEND_UNTIL = 1786392682;

const PROBE_SUSPEND_MUTATION = "mutation { suspendZone(zoneId: 6940181, until: \"Mon, 10 Aug 26 15:11:22 -0500\") { status summary } }";

const PROBE_RESUME_MUTATION = "mutation { resumeZone(zoneId: 6940181) { status summary } }";

// The refusal summary a mutation carries back for the controller's one sentence to name, shaped as the account composes its own.
const REFUSAL_SUMMARY = "This zone cannot be suspended right now.";

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

/* An HTTP 200 carrying a GraphQL errors array, taken from the live status-query capture. This is the failure shape a status-code check alone cannot see: the
 * transport succeeded, and the query did not.
 */
const GRAPH_ERRORS_BODY = { data: { me: { controllers: [] } },
  errors: [{ extensions: { category: "internal" }, locations: [{ column: 231, line: 1 }], message: "Internal server error",
    path: [ "me", "controllers", 0, "sensors", 0, "model", "mode" ] }] };

// One recorded request the injected dispatcher served, in the order it was served. The path is what tells a token grant from a query, and the order is what a
// budget-before-dispatch assertion reads. Every ceiling the client draws against is sampled, because a draw attributed to the wrong one is exactly what a split
// budget can get wrong.
interface RecordedCall {

  budgetAvailableAtDispatch: number;
  mutationAvailableAtDispatch: number;
  path: string;
}

// The handles a harness hands back: the client under test, the recorded call log, the two ceilings it draws against, and the captured log lines.
interface V2Harness {

  budget: RateBudget;
  calls: RecordedCall[];
  client: HydrawiseV2Client;
  lines: () => CapturedLogLine[];
  mutationBudget: RateBudget;
}

/* Build a client over a MockAgent handed in through the constructor's dispatcher factory - the SAME parameter production leaves unset, so nothing here is a path
 * production does not have. The factory answers one agent for the life of the harness; a test needing the timeout self-heal path constructs HydrawiseV2Client
 * directly instead, since this harness offers no way to override the factory it builds.
 *
 * Each intercept records the call before it replies, capturing both ceilings' free slots AT DISPATCH. Those numbers are what prove the draw is awaited rather than
 * merely present: a call that reached the wire without waiting would be recorded with its ceiling untouched. Each capacity is settable on its own, which is what
 * lets a test saturate one ceiling and leave the other roomy - the arrangement every independence assertion below rests on.
 */
function makeV2Harness(program: (agent: MockAgent, record: (path: string) => void) => void,
  options: { capacity?: number; mutationCapacity?: number; signal?: AbortSignal } = {}): V2Harness {

  const { lines, logger } = capturingLog();
  const signal = options.signal ?? new AbortController().signal;
  const budget = new RateBudget({ capacity: options.capacity ?? HYDRAWISE_V2_BUDGET_CALLS, signal, window: HYDRAWISE_V2_BUDGET_WINDOW * 1000 });
  const mutationBudget = new RateBudget({ capacity: options.mutationCapacity ?? HYDRAWISE_V2_MUTATION_BUDGET_CALLS, signal,
    window: HYDRAWISE_V2_MUTATION_BUDGET_WINDOW * 1000 });
  const calls: RecordedCall[] = [];
  const agent = new MockAgent();

  agent.disableNetConnect();

  program(agent, (path: string): void => {

    calls.push({ budgetAvailableAtDispatch: budget.available, mutationAvailableAtDispatch: mutationBudget.available, path });
  });

  const client = new HydrawiseV2Client({ budget, dispatcherFactory: (): MockAgent => agent, log: logger, mutationBudget, password: "test-password", signal,
    username: "test-user" });

  return { budget, calls, client, lines, mutationBudget };
}

// Spend every slot of ONE ceiling, leaving the other exactly as it was. Saturating one bucket and watching the traffic that draws the other carry on is the whole
// shape of an independence assertion, and naming the bucket at the call site is what says which direction the assertion is testing.
async function saturate(budget: RateBudget): Promise<void> {

  while(budget.available > 0) {

    // eslint-disable-next-line no-await-in-loop
    await budget.acquire();
  }
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

// The operator-visible text of one captured line. The plugin logs printf-style, so a sentence and the detail it carries can sit in different arguments and only the
// formatted line is what a user actually reads - which is what an assertion about the reported wording has to run against.
function formatted(line: CapturedLogLine): string {

  return util.format(line.message, ...line.args);
}

// The error lines a harness captured, already formatted.
function errorLines(lines: CapturedLogLine[]): string[] {

  return lines.filter(line => line.level === "error").map(line => formatted(line));
}

describe("HydrawiseV2Client tokens", () => {

  test("acquires an access token on first use and reuses it on the next call", async () => {

    const harness = makeV2Harness((agent, record) => programReply(agent, record, TOKEN_PATH, TOKEN_BODY));

    assert.equal(await harness.client.ensureToken(), "access-one", "the password grant should answer the captured access token");
    assert.equal(await harness.client.ensureToken(), "access-one", "a token comfortably inside its lifetime answers again without a second grant");
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

    assert.equal(await harness.client.ensureToken(), "access-one", "the first grant answers the short-lived token");
    assert.equal(await harness.client.ensureToken(), "access-two", "a token inside the refresh window is renewed rather than reused");
    assert.equal(harness.calls.length, 2, "the renewal should have spent a second grant");
  });

  test("a failed grant resets the token state so the next call retries from scratch", async () => {

    const harness = makeV2Harness((agent, record) => {

      agent.get(V2_ORIGIN).intercept({ method: "POST", path: TOKEN_PATH }).reply(401, (): object => {

        record(TOKEN_PATH);

        return { error: "invalid_grant" };
      });

      programReply(agent, record, TOKEN_PATH, TOKEN_BODY);
    });

    assert.equal(await harness.client.ensureToken(), null, "a rejected grant answers null");

    // The recovery is the point of the reset: a client left holding a failed state would answer null forever, where one returned to holding nothing simply tries
    // again and succeeds the moment the account is reachable.
    assert.equal(await harness.client.ensureToken(), "access-one", "the next call runs a fresh password grant and recovers");
    assert.equal(harness.calls.length, 2, "each attempt spent exactly one grant");
  });

  test("a grant carrying no access token is treated as a failure", async () => {

    const harness = makeV2Harness((agent, record) => programReply(agent, record, TOKEN_PATH, { expires_in: 3600, token_type: "Bearer" }));

    assert.equal(await harness.client.ensureToken(), null, "a 200 with no access token is not a usable grant");
  });

  test("two concurrent callers resolve from exactly ONE grant", async () => {

    const harness = makeV2Harness((agent, record) => programReply(agent, record, TOKEN_PATH, TOKEN_BODY));

    /* Both calls are started before either is awaited, which is the only arrangement that can observe the single-flight mechanism at all. The transition to the
     * in-flight state happens synchronously, in the same frame that read the prior state, so the second caller finds a grant already running and joins it. Drop
     * that synchronous transition and both callers observe "no token" and each fire a grant of their own, which this call count catches.
     */
    const [ first, second ] = await Promise.all([ harness.client.ensureToken(), harness.client.ensureToken() ]);

    assert.equal(first, "access-one", "the first caller resolves the token");
    assert.equal(second, "access-one", "the second caller resolves the same token");
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
    assert.equal(await harness.client.ensureToken(), "access-one", "the password grant reaches the wire carrying exactly its six documented parameters");
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

    assert.equal(await harness.client.ensureToken(), "access-one", "the first call runs the password grant");
    assert.equal(await harness.client.ensureToken(), "access-two", "the renewal presents the refresh token rather than the account credentials");
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

    /* The two deliberate omissions, asserted as omissions. The sensor model's mode answers a 500 that nullifies the whole sensor entry, and a GraphQL error
     * anywhere is reported against the entire response, so selecting it would cost the enrichment every fact rather than just that one.
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

    const facts = await harness.client.fetchAccountFacts();

    assert.ok(facts, "a successful query should answer a map");
    assert.deepEqual([...facts.keys()], [1058515], "the map is keyed on the id that matches the v1 controller, never on the sibling device id");

    const entry = facts.get(1058515);

    // The model is held to the DESCRIPTION, which is the full name a user recognizes. The capture carries the shorter name field beside it, so a mapping that
    // reached for that instead would answer "38 Zones" here.
    assert.deepEqual(entry?.hardware, { firmware: "4.76", model: "HCC 38 Zones" }, "the captured controller composes its captured model and firmware");
    assert.equal(entry?.online, true, "the captured controller reports itself reachable");

    /* The per-zone facts land on their OWN ids, which is the correlation claim. The suspended zone carries its captured instant and the quiet one carries null,
     * so a composer that keyed zones positionally, or that joined on the display number instead of the id, would swap these two.
     */
    assert.equal(entry?.zones.get(SUSPENDED_ZONE_ID)?.suspendedUntil, SUSPENDED_UNTIL, "the suspended zone carries its own suspension instant");
    assert.equal(entry?.zones.get(QUIET_ZONE_ID)?.suspendedUntil, null, "a zone answering a null suspension is not suspended");

    // The covered zone is the one the sensor names, and the sensor reads tripped, so exactly that zone is sensor-stopped while its uncovered sibling is not.
    assert.equal(entry?.zones.get(QUIET_ZONE_ID)?.sensorStopped, true, "the zone the tripped sensor covers reads as stopped");
    assert.equal(entry?.zones.get(SUSPENDED_ZONE_ID)?.sensorStopped, false, "a zone no tripped sensor covers reads as not stopped, rather than as unknown");
  });

  test("carries each zone's full name, and composes null for any answer that is not one", async () => {

    const harness = makeV2Harness((agent, record) => {

      programReply(agent, record, TOKEN_PATH, TOKEN_BODY);
      programReply(agent, record, GRAPH_PATH, ACCOUNT_BODY);
    });

    const entry = (await harness.client.fetchAccountFacts())?.get(1058515);

    // The account's own name for each zone, landing on that zone's own entry. The key-based wire truncates these at roughly fifteen characters, which is the whole
    // reason the enrichment reaches for them.
    assert.equal(entry?.zones.get(QUIET_ZONE_ID)?.name, "Parkway North", "a zone carries the name the account reports for it");
    assert.equal(entry?.zones.get(SUSPENDED_ZONE_ID)?.name, "Sideyard Vegetable Garden", "including one longer than the key-based API can express");
  });

  test("carries the controller's own name, trimmed, and composes null for any answer that is not one", async () => {

    const harness = makeV2Harness((agent, record) => {

      programReply(agent, record, TOKEN_PATH, TOKEN_BODY);
      programReply(agent, record, GRAPH_PATH, ACCOUNT_BODY);
    });

    // The name the live capture records for the owner's controller, landing on that controller's own facts entry.
    assert.equal((await harness.client.fetchAccountFacts())?.get(1058515)?.name, "Home", "a controller carries the name the account reports for it");

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
      const facts = await scenarioHarness.client.fetchAccountFacts();

      assert.equal(facts?.get(1058515)?.name, scenario.expected, scenario.label + " composes " + JSON.stringify(scenario.expected));
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
      const facts = await harness.client.fetchAccountFacts();

      assert.equal(facts?.get(1058515)?.zones.get(QUIET_ZONE_ID)?.name, null, scenario.label + " composes null");
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
    assert.equal((await harness.client.fetchAccountFacts())?.get(1058515)?.zones.get(QUIET_ZONE_ID)?.name, "Parkway North", "a name arrives trimmed");
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

    const facts = await harness.client.fetchAccountFacts();

    assert.equal(facts?.get(1058515)?.zones.get(QUIET_ZONE_ID)?.sensorStopped, false, "a quiet sensor answers false, not null");
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

    const facts = await harness.client.fetchAccountFacts();

    assert.equal(facts?.get(1058515)?.zones.get(QUIET_ZONE_ID)?.sensorStopped, true, "one tripped sensor is enough to stop the zone it covers");
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
      const facts = await harness.client.fetchAccountFacts();

      assert.equal(facts?.get(1058515)?.zones.get(QUIET_ZONE_ID)?.sensorStopped, null, "a sensor answer this plugin cannot read composes an unknown");
    }
  });

  test("an unreachable controller composes a FALSE availability, not an absent one", async () => {

    // Both polarities are fixtured, because a one-value fixture cannot catch a read that inverted the field or that hardcoded the answer.
    const harness = makeV2Harness((agent, record) => {

      programReply(agent, record, TOKEN_PATH, TOKEN_BODY);
      programReply(agent, record, GRAPH_PATH,
        { data: { me: { controllers: [{ ...CAPTURED_CONTROLLER, sensors: CAPTURED_SENSORS, status: { online: false }, zones: CAPTURED_ZONES }] } } });
    });

    assert.equal((await harness.client.fetchAccountFacts())?.get(1058515)?.online, false, "an offline controller reports itself offline");
  });

  test("a controller answering no status block at all reports an unknown availability", async () => {

    const harness = makeV2Harness((agent, record) => {

      programReply(agent, record, TOKEN_PATH, TOKEN_BODY);
      programReply(agent, record, GRAPH_PATH, { data: { me: { controllers: [{ ...CAPTURED_CONTROLLER, zones: CAPTURED_ZONES }] } } });
    });

    assert.equal((await harness.client.fetchAccountFacts())?.get(1058515)?.online, null, "an absent availability is unknown rather than reachable");
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

    assert.equal((await harness.client.fetchAccountFacts())?.get(1058515)?.hardware?.firmware, "4.76",
      "the entry whose type names the controller is the one selected");
  });

  test("a controller with no controller-firmware entry composes no hardware, while its other facts still land", async () => {

    const noController = { ...CAPTURED_CONTROLLER, hardware: { ...CAPTURED_CONTROLLER.hardware, firmware: [{ type: "adapter", version: "1.40" }] },
      status: { online: true }, zones: CAPTURED_ZONES };

    const harness = makeV2Harness((agent, record) => {

      programReply(agent, record, TOKEN_PATH, TOKEN_BODY);
      programReply(agent, record, GRAPH_PATH, { data: { me: { controllers: [noController] } } });
    });

    const entry = (await harness.client.fetchAccountFacts())?.get(1058515);

    /* Each fact carries its own absence rather than one incomplete field withholding the entry. A half-populated hardware shape would put a real model beside an
     * empty firmware in HomeKit, so it composes nothing at all - but the suspension and availability facts on the same controller are unaffected.
     */
    assert.equal(entry?.hardware, null, "a partial hardware block composes nothing rather than half a shape");
    assert.equal(entry?.online, true, "the controller's other facts are untouched by its incomplete hardware");
    assert.equal(entry?.zones.get(SUSPENDED_ZONE_ID)?.suspendedUntil, SUSPENDED_UNTIL, "and so are its zones");
  });

  test("a controller with no model description composes no hardware", async () => {

    const noModel = { ...CAPTURED_CONTROLLER, hardware: { ...CAPTURED_CONTROLLER.hardware, model: { name: "38 Zones" } } };

    const harness = makeV2Harness((agent, record) => {

      programReply(agent, record, TOKEN_PATH, TOKEN_BODY);
      programReply(agent, record, GRAPH_PATH, { data: { me: { controllers: [noModel] } } });
    });

    assert.equal((await harness.client.fetchAccountFacts())?.get(1058515)?.hardware, null, "a hardware block carrying no description composes nothing");
  });

  test("a controller the answer cannot correlate is skipped entirely", async () => {

    // Without an id there is no way to say which v1 controller these facts belong to, and guessing would enrich the wrong accessory.
    const harness = makeV2Harness((agent, record) => {

      programReply(agent, record, TOKEN_PATH, TOKEN_BODY);
      programReply(agent, record, GRAPH_PATH, { data: { me: { controllers: [{ hardware: CAPTURED_CONTROLLER.hardware, status: { online: true } }] } } });
    });

    const facts = await harness.client.fetchAccountFacts();

    // A successful query that composed nothing is an EMPTY map rather than a null, so the caller can still tell it apart from a query that failed.
    assert.deepEqual(facts && [...facts.keys()], [], "a controller carrying no correlation id contributes no entry");
  });

  test("a zone the answer cannot correlate is skipped, leaving its siblings intact", async () => {

    const harness = makeV2Harness((agent, record) => {

      programReply(agent, record, TOKEN_PATH, TOKEN_BODY);
      programReply(agent, record, GRAPH_PATH, { data: { me: { controllers: [{ ...CAPTURED_CONTROLLER,
        zones: [ { status: { suspendedUntil: null } }, ...CAPTURED_ZONES ] }] } } });
    });

    const entry = (await harness.client.fetchAccountFacts())?.get(1058515);

    assert.equal(entry?.zones.size, 2, "the zone with no id contributes no entry");
    assert.equal(entry?.zones.get(SUSPENDED_ZONE_ID)?.suspendedUntil, SUSPENDED_UNTIL, "its correlatable siblings compose exactly as they would have");
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
      programReply(agent, record, GRAPH_PATH, GRAPH_ERRORS_BODY);
    });

    // The transport succeeded and the query did not. A classification that read the status alone would hand the caller the body's empty controller list as though
    // it were an answer, and every controller would be quietly left unenriched with nothing reported.
    assert.equal(await harness.client.fetchAccountFacts(), null, "a body-level errors array classifies as a failed query");

    // The reported line is read as the operator sees it, whole. The read's own sentence and the account's message reach the log as separate printf arguments, so
    // an assertion against either argument alone would check half the sentence and pass while the other half went missing.
    assert.deepEqual(errorLines(harness.lines()), ["Unable to retrieve enhanced controller details: Internal server error."],
      "the reported failure names the read that failed and what the API said was wrong");
  });

  test("a non-2xx query status is a failure", async () => {

    const harness = makeV2Harness((agent, record) => {

      programReply(agent, record, TOKEN_PATH, TOKEN_BODY);
      programReply(agent, record, GRAPH_PATH, { message: "Too Many Requests" }, 429);
    });

    assert.equal(await harness.client.fetchAccountFacts(), null, "a throttled query answers null rather than a partial result");

    // The status branch's own sentence, asserted whole for the same reason the errors branch above is: the read states what it was doing and the transport states
    // what it got, and the two reach the log as separate arguments of one line.
    assert.deepEqual(errorLines(harness.lines()), ["Unable to retrieve enhanced controller details. The Hydrawise API answered with status 429."],
      "the throttled read is reported under the read's own sentence");
  });

  test("a failed grant leaves the query unattempted", async () => {

    const harness = makeV2Harness((agent, record) => {

      programReply(agent, record, TOKEN_PATH, { error: "invalid_grant" }, 401);
      programReply(agent, record, GRAPH_PATH, ACCOUNT_BODY);
    });

    assert.equal(await harness.client.fetchAccountFacts(), null, "a query with no token to present answers null");
    assert.deepEqual(harness.calls.map(call => call.path), [TOKEN_PATH], "the query never reached the wire without a token");
  });

  test("a generic transport failure is reported and answers null", async () => {

    /* The classification's final arm, which every other failure test routes around: not a shutdown, not a timeout, just a transport that threw. Without this case
     * the timeout branch could silently absorb the general one - a mis-scoped condition catching everything - and no test would notice, because the caller sees the
     * same null either way. What tells them apart is what reaches the user, so that is what this asserts.
     */
    const harness = makeV2Harness((agent, record) => {

      programReply(agent, record, TOKEN_PATH, TOKEN_BODY);
      agent.get(V2_ORIGIN).intercept({ method: "POST", path: GRAPH_PATH }).replyWithError(new Error("socket hang up"));
    });

    assert.equal(await harness.client.fetchAccountFacts(), null, "a thrown transport failure answers the same null every recoverable failure does");

    // Read as the operator sees it, whole. The read composes its own sentence with the reason the transport handed back, so what is asserted is the line rather
    // than whichever argument a given composition happens to put it in.
    const reported = errorLines(harness.lines());

    assert.equal(reported.length, 1, "it is reported exactly once");
    assert.ok(reported[0]?.startsWith("Unable to retrieve enhanced controller details: "), "under the read's own sentence");
    assert.ok(reported.some(line => line.includes("socket hang up")), "and the report carries what actually went wrong");
    assert.ok(!reported.some(line => line.includes("too long to respond")), "a generic failure is not narrated as a timeout");
  });

  test("a shutdown while a read is QUEUED for a slot answers the same quiet null", async () => {

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
    assert.equal(await read, null, "a read torn down while queued answers null like every other recoverable failure");
    assert.deepEqual(errorLines(harness.lines()), [], "and a shutdown is not an error");
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

    // Aborting mid-flight is orderly teardown rather than a fault, so it answers the same quiet null every other recoverable failure does and logs nothing at all.
    const result = await harness.client.fetchAccountFacts();

    assert.equal(result, null, "a shutdown reached mid-request answers null");
    assert.equal(harness.lines().filter(line => line.level === "error").length, 0, "a shutdown is not an error and reports nothing");
  });
});

describe("HydrawiseV2Client zone suspension", () => {

  test("composes the exact suspendZone document the live probe recorded", async () => {

    const queries: string[] = [];

    const harness = makeV2Harness((agent, record) => {

      programReply(agent, record, TOKEN_PATH, TOKEN_BODY);
      programGraph(agent, record, { data: { suspendZone: { status: "OK", summary: "Suspending Parkway North" } } }, queries);
    });

    const result = await harness.client.setZoneSuspension({ until: PROBE_SUSPEND_UNTIL, zoneId: QUIET_ZONE_ID });

    /* The whole document, byte for byte against the capture. Every part of it is something the account enforces and none of it is derivable: the argument names,
     * the quoting around the instant, the two-digit year, and the explicit offset. A formatter that rendered the host's own zone, or a four-digit year, composes a
     * different string here rather than failing in the field.
     */
    assert.deepEqual(queries, [PROBE_SUSPEND_MUTATION], "the suspend composes the document the account accepted");
    assert.deepEqual(result, { status: "done" }, "an accepted command answers done");
  });

  test("composes the exact resumeZone document the live probe recorded", async () => {

    const queries: string[] = [];

    const harness = makeV2Harness((agent, record) => {

      programReply(agent, record, TOKEN_PATH, TOKEN_BODY);
      programGraph(agent, record, { data: { resumeZone: { status: "OK", summary: "Resuming scheduled watering" } } }, queries);
    });

    const result = await harness.client.setZoneSuspension({ until: null, zoneId: QUIET_ZONE_ID });

    // The resume carries the zone and nothing else, which is what makes it per-zone: the probe suspended one zone, resumed it, and watched a sibling's standing
    // suspension survive the cycle untouched.
    assert.deepEqual(queries, [PROBE_RESUME_MUTATION], "the resume composes the document the account accepted");
    assert.deepEqual(result, { status: "done" }, "an accepted resume answers done");
  });

  test("reads the status word out of the field its OWN mutation answers under", async () => {

    /* The two mutations nest their answer under different field names, so a reader that looked at one field for both would pass every test written against that
     * one shape and misread the other in the field. Every combination of mutation and outcome is driven here, plus the pair that proves the correlation rather
     * than the parsing: a body answering under the SIBLING mutation's name is not this command's answer at all, and reads as a refusal rather than as a success.
     */
    const cases = [
      { answer: { data: { suspendZone: { status: "OK" } } }, expected: { status: "done" }, until: PROBE_SUSPEND_UNTIL },
      { answer: { data: { resumeZone: { status: "OK" } } }, expected: { status: "done" }, until: null },
      { answer: { data: { suspendZone: { status: "ERROR", summary: REFUSAL_SUMMARY } } }, expected: { reason: REFUSAL_SUMMARY, status: "failed" },
        until: PROBE_SUSPEND_UNTIL },
      { answer: { data: { resumeZone: { status: "ERROR", summary: REFUSAL_SUMMARY } } }, expected: { reason: REFUSAL_SUMMARY, status: "failed" }, until: null },
      { answer: { data: { resumeZone: { status: "OK" } } }, expected: { reason: null, status: "failed" }, until: PROBE_SUSPEND_UNTIL },
      { answer: { data: { suspendZone: { status: "OK" } } }, expected: { reason: null, status: "failed" }, until: null }
    ];

    for(const scenario of cases) {

      const harness = makeV2Harness((agent, record) => {

        programReply(agent, record, TOKEN_PATH, TOKEN_BODY);
        programReply(agent, record, GRAPH_PATH, scenario.answer);
      });

      // eslint-disable-next-line no-await-in-loop
      const result = await harness.client.setZoneSuspension({ until: scenario.until, zoneId: QUIET_ZONE_ID });

      assert.deepEqual(result, scenario.expected, "the command reads " + JSON.stringify(scenario.answer) + " correctly");

      // A refusal reported inside a clean 200 is the command's own business to report, so the client says nothing at all about it - the one sentence the user reads
      // belongs to the controller, which knows which zone was touched.
      assert.deepEqual(errorLines(harness.lines()), [], "an in-band answer is never narrated by the client");
    }
  });

  test("a transport failure carries its reason back in the result rather than logging one", async () => {

    const harness = makeV2Harness((agent, record) => {

      programReply(agent, record, TOKEN_PATH, TOKEN_BODY);
      programReply(agent, record, GRAPH_PATH, { message: "Bad Gateway" }, 502);
    });

    /* A command that failed at the TRANSPORT is silent here for the same reason one refused in band is: the controller is the layer that knows which zone the user
     * touched, so it speaks, and the reason has to reach it to be spoken. A client that reported this itself would leave one failure narrated twice.
     */
    assert.deepEqual(await harness.client.setZoneSuspension({ until: PROBE_SUSPEND_UNTIL, zoneId: QUIET_ZONE_ID }),
      { reason: "The Hydrawise API answered with status 502.", status: "failed" }, "the transport's reason travels back in the result");
    assert.deepEqual(errorLines(harness.lines()), [], "and the client says nothing about a command's failure, whatever caused it");
  });

  test("a GraphQL errors array likewise carries the account's words back rather than logging them", async () => {

    const harness = makeV2Harness((agent, record) => {

      programReply(agent, record, TOKEN_PATH, TOKEN_BODY);
      programReply(agent, record, GRAPH_PATH, { errors: [{ message: "Cannot query field" }] });
    });

    assert.deepEqual(await harness.client.setZoneSuspension({ until: null, zoneId: QUIET_ZONE_ID }), { reason: "Cannot query field.", status: "failed" },
      "a body-level errors array is a failed command whose reason is what the API said");
    assert.deepEqual(errorLines(harness.lines()), [], "reported by nobody at this layer");
  });

  test("a command that times out re-arms the pool, and still leaves the reporting to its caller", async () => {

    /* The recovery half has to survive the silence. A timeout is the one classification that DOES something besides describing itself - it replaces the wedged
     * connection pool - and moving the reporting out of the classifier must not take the re-arm with it.
     */
    const first = destroyable(new MockAgent());
    const second = new MockAgent();
    const built = [ first, second ];
    const { lines, logger } = capturingLog();
    const signal = new AbortController().signal;

    first.disableNetConnect();
    second.disableNetConnect();

    first.get(V2_ORIGIN).intercept({ method: "POST", path: TOKEN_PATH }).reply(200, (): object => TOKEN_BODY).persist();
    first.get(V2_ORIGIN).intercept({ method: "POST", path: GRAPH_PATH })
      .replyWithError(new DOMException("The operation was aborted due to timeout", "TimeoutError")).persist();

    const client = new HydrawiseV2Client({ budget: new RateBudget({ capacity: HYDRAWISE_V2_BUDGET_CALLS, signal, window: HYDRAWISE_V2_BUDGET_WINDOW * 1000 }),
      dispatcherFactory: (): MockAgent => built.shift() ?? second, log: logger,
      mutationBudget: new RateBudget({ capacity: HYDRAWISE_V2_MUTATION_BUDGET_CALLS, signal, window: HYDRAWISE_V2_MUTATION_BUDGET_WINDOW * 1000 }),
      password: "test-password", signal, username: "test-user" });

    assert.deepEqual(await client.setZoneSuspension({ until: PROBE_SUSPEND_UNTIL, zoneId: QUIET_ZONE_ID }),
      { reason: "The Hydrawise API took too long to respond, which can usually be safely ignored.", status: "failed" },
      "the timeout's reason travels back for the controller to say");
    assert.equal(client.dispatcher, second, "and the wedged pool was replaced all the same");
    assert.deepEqual(errorLines(lines()), [], "with nothing said here about the command that provoked it");
  });

  test("a saturated command ceiling rejects the command having spent NOTHING on it", async (t) => {

    const controller = new AbortController();

    const harness = makeV2Harness((agent, record) => {

      programReply(agent, record, TOKEN_PATH, TOKEN_BODY);
      programReply(agent, record, GRAPH_PATH, { data: { suspendZone: { status: "OK" } } });
    }, { mutationCapacity: 1, signal: controller.signal });

    t.after(() => controller.abort("test-teardown"));

    // Spend the only COMMAND slot, so the command arrives at the ceiling it draws with nothing to give and a window it cannot wait out. The read ceiling is left
    // whole on purpose: this is a claim about the ceiling commands are paced by, and draining the other one would prove it against the wrong bucket.
    await harness.mutationBudget.acquire();

    const started = Date.now();
    const result = await harness.client.setZoneSuspension({ until: PROBE_SUSPEND_UNTIL, zoneId: QUIET_ZONE_ID });

    assert.deepEqual(result, { status: "rejected" }, "a command the ceiling cannot admit is rejected rather than queued");
    assert.deepEqual(harness.calls, [], "and it reached the wire for nothing at all - no grant, no mutation");

    /* The bound is what makes this reject-with-feedback rather than a silent wait. Unbounded, this caller would sit in the library's blocking queue until the
     * command budget's own window released a slot, which is measured in hours.
     */
    assert.ok((Date.now() - started) < (HYDRAWISE_V2_MUTATION_BUDGET_WINDOW * 1000), "the command gave up on the admission window rather than the budget's");
    assert.equal(harness.budget.available, HYDRAWISE_V2_BUDGET_CALLS, "and the reads' own ceiling was never touched on its way past");
  });

  test("an admission that gives up on the token race leaves the grant, the pool, and the token state untouched", async (t) => {

    const controller = new AbortController();
    let released = (): void => undefined;
    const grantInFlight = new Promise<void>(resolve => { released = resolve; });

    const harness = makeV2Harness((agent, record) => {

      // A grant that is genuinely IN FLIGHT when the admission window closes. That is the only fixture the token-reset control can be asserted against at all: the
      // reset lives inside the grant's own failure paths, so a fixture with no live grant would assert an absence that could never have happened.
      agent.get(V2_ORIGIN).intercept({ method: "POST", path: TOKEN_PATH }).reply(200, async (): Promise<object> => {

        record(TOKEN_PATH);

        await grantInFlight;

        return TOKEN_BODY;
      }).persist();

      programReply(agent, record, GRAPH_PATH, { data: { suspendZone: { status: "OK" } } });
    }, { signal: controller.signal });

    t.after(() => controller.abort("test-teardown"));

    const pool = harness.client.dispatcher;
    const command = harness.client.setZoneSuspension({ until: PROBE_SUSPEND_UNTIL, zoneId: QUIET_ZONE_ID });

    assert.deepEqual(await command, { status: "rejected" }, "the window closed on a grant still in flight, so the command is rejected");

    // The faces of the misclassification this structure exists to make unrepresentable. An admission abort that reached the failure classification would
    // re-arm the pool, would report itself as a request that took too long, and - by way of the grant it aborted - would reset the token state.
    assert.equal(harness.client.dispatcher, pool, "an admission abort never re-arms the connection pool");
    assert.deepEqual(errorLines(harness.lines()), [], "and never narrates itself as a request timeout, or as anything else");

    // Let the grant land and confirm it was neither abandoned nor reset: the very next caller finds a usable token and spends no second grant.
    released();

    assert.equal(await harness.client.ensureToken(), "access-one", "the abandoned grant completed and its token was kept");
    assert.deepEqual(harness.calls.map(call => call.path), [TOKEN_PATH], "which is to say the admission abort reset nothing and cost no second grant");
  });

  test("a reader waiting on the same grant is unaffected by a command abandoning its admission race", async (t) => {

    const controller = new AbortController();
    let released = (): void => undefined;
    const grantInFlight = new Promise<void>(resolve => { released = resolve; });

    const harness = makeV2Harness((agent, record) => {

      agent.get(V2_ORIGIN).intercept({ method: "POST", path: TOKEN_PATH }).reply(200, async (): Promise<object> => {

        record(TOKEN_PATH);

        await grantInFlight;

        return TOKEN_BODY;
      }).persist();

      programReply(agent, record, GRAPH_PATH, ACCOUNT_BODY);
    }, { signal: controller.signal });

    t.after(() => controller.abort("test-teardown"));

    /* Both callers are driven in ONE test, which is the only arrangement that can observe the claim at all: the read joins the grant the command's admission
     * started, and the command then walks away from it. Threading the command's deadline INTO that shared grant - rather than racing it - would cancel the read's
     * token too, and the read would answer null here.
     */
    const read = harness.client.fetchAccountFacts();
    const command = harness.client.setZoneSuspension({ until: null, zoneId: QUIET_ZONE_ID });

    assert.deepEqual(await command, { status: "rejected" }, "the command gave up on its own window");

    released();

    const facts = await read;

    assert.ok(facts, "the read the command left behind resolved on the very grant that command abandoned");
    assert.equal(facts.get(1058515)?.online, true, "and it carries the account's own answer, whole");
  });

  test("an admitted command draws its admission from the command ceiling and its grant from the read ceiling, ONCE each and never again in the transport", async () => {

    const harness = makeV2Harness((agent, record) => {

      programReply(agent, record, TOKEN_PATH, TOKEN_BODY);
      programReply(agent, record, GRAPH_PATH, { data: { resumeZone: { status: "OK" } } });
    });

    assert.deepEqual(await harness.client.setZoneSuspension({ until: null, zoneId: QUIET_ZONE_ID }), { status: "done" }, "the command was accepted");

    /* The draws attributed BY PHASE AND BY CEILING, neither of which a bare total could do. A cold client spends exactly two calls, one out of each bucket: the
     * admission is the command's own and comes off the command ceiling, while the token grant is shared infrastructure and comes off the read ceiling that pays
     * for the scheduled reads. Asserting them apart is what catches a grant quietly re-pointed at the command ceiling - a change that would leave the TOTAL
     * spend identical and this suite green if it only counted. A transport step drawing a third would show up as a lower reading at the mutation's dispatch.
     */
    assert.equal(harness.mutationBudget.available, HYDRAWISE_V2_MUTATION_BUDGET_CALLS - 1, "the admission spent one slot of the command ceiling and no more");
    assert.equal(harness.budget.available, HYDRAWISE_V2_BUDGET_CALLS - 1, "and the grant spent one slot of the read ceiling and no more");
    assert.deepEqual(harness.calls.map(call => call.path), [ TOKEN_PATH, GRAPH_PATH ], "the grant dispatches before the mutation it authenticates");
    assert.equal(harness.calls[1]?.budgetAvailableAtDispatch, HYDRAWISE_V2_BUDGET_CALLS - 1, "with the mutation dispatching against the grant's spent read slot");
    assert.equal(harness.calls[1]?.mutationAvailableAtDispatch, HYDRAWISE_V2_MUTATION_BUDGET_CALLS - 1, "and against its own already-spent admission slot");
  });

  test("a command admitted on a roomy command ceiling still gives up when the drained READ ceiling cannot pay for its token renewal", async (t) => {

    /* The compound case, and the one an admission bound on step ONE alone would fail. It is also the DELIBERATE residual of pacing commands and reads on separate
     * ceilings: a grant is one shared thing serving both, so it draws the read ceiling wherever it was triggered from. Here the command's own ceiling is wide open
     * and it is admitted at once, but the token it then needs is inside its renewal window and the read ceiling has nothing left to buy that renewal with, so the
     * grant's draw would block toward the read budget's own horizon. Racing that wait, rather than merely bounding the slot, is what answers the user in a beat.
     *
     * The corner is narrow by arithmetic rather than by luck: the scheduled reads renew the token perpetually at a cadence well inside its lifetime, so a drained
     * read ceiling meeting a token due for renewal belongs to the seconds before a session's first read lands, or to a refresh loop that has stopped.
     */
    const controller = new AbortController();

    const harness = makeV2Harness((agent, record) => {

      // A grant whose lifetime is already inside the proactive-renewal threshold, so the very next caller renews.
      agent.get(V2_ORIGIN).intercept({ method: "POST", path: TOKEN_PATH }).reply(200, (): object => {

        record(TOKEN_PATH);

        return { access_token: "access-one", expires_in: 30, refresh_token: "refresh-one" };
      }).persist();

      programReply(agent, record, GRAPH_PATH, { data: { suspendZone: { status: "OK" } } });
    }, { capacity: 1, signal: controller.signal });

    t.after(() => controller.abort("test-teardown"));

    // Warm the client, which spends the read ceiling's only slot on the short-lived grant and leaves the renewal nothing to draw.
    assert.equal(await harness.client.ensureToken(), "access-one", "the client starts holding a token that is already due for renewal");
    assert.equal(harness.budget.available, 0, "with the read ceiling spent, which is the whole precondition of this corner");

    const started = Date.now();
    const result = await harness.client.setZoneSuspension({ until: PROBE_SUSPEND_UNTIL, zoneId: QUIET_ZONE_ID });
    const elapsed = Date.now() - started;

    assert.deepEqual(result, { status: "rejected" }, "the renewal could not be paid for inside the window, so the command is rejected");
    assert.ok(elapsed < (HYDRAWISE_V2_MUTATION_BUDGET_WINDOW * 1000), "and it resolved on its own window rather than blocking toward either budget's");
    assert.deepEqual(harness.calls.map(call => call.path), [TOKEN_PATH], "the mutation never reached the wire");
    assert.equal(harness.mutationBudget.available, HYDRAWISE_V2_MUTATION_BUDGET_CALLS - 1,
      "and the admission it did win is spent all the same, which is what this corner costs");
  });

  test("a grant that fails inside the window answers failed without spending a second one", async () => {

    const harness = makeV2Harness((agent, record) => {

      programReply(agent, record, TOKEN_PATH, { error: "invalid_grant" }, 401);
      programReply(agent, record, GRAPH_PATH, { data: { suspendZone: { status: "OK" } } });
    });

    /* The fast-null arm of the race, which is a FAILURE rather than a rejection: the account was reached and refused, which is something the user can act on.
     * Entering the transport here would run the token chokepoint a second time and spend a duplicate grant on an account that has just said no.
     */
    assert.deepEqual(await harness.client.setZoneSuspension({ until: null, zoneId: QUIET_ZONE_ID }), { reason: null, status: "failed" },
      "a grant that failed inside the window is a failed command, carrying no reason of its own because the sign-in reported itself");
    assert.deepEqual(harness.calls.map(call => call.path), [TOKEN_PATH], "exactly one grant was attempted, and the mutation never dispatched");
  });

  test("a shutdown reaching the admission phase reports nothing at all", async () => {

    const controller = new AbortController();

    const harness = makeV2Harness((agent, record) => {

      programReply(agent, record, TOKEN_PATH, TOKEN_BODY);
      programReply(agent, record, GRAPH_PATH, { data: { suspendZone: { status: "OK" } } });
    }, { mutationCapacity: 1, signal: controller.signal });

    // The COMMAND ceiling is drained, so the command is genuinely sitting in the admission phase when the teardown arrives - which is the phase this test names.
    await harness.mutationBudget.acquire();

    const command = harness.client.setZoneSuspension({ until: PROBE_SUSPEND_UNTIL, zoneId: QUIET_ZONE_ID });

    // Teardown, not a refusal. The lifetime signal is read ahead of everything else, so a shutdown reaching a queued command answers quietly rather than
    // manufacturing a line about a ceiling nobody is waiting on any more.
    await delay(HYDRAWISE_V2_MUTATION_ADMISSION_TIMEOUT * 100);
    controller.abort("shutdown");

    assert.deepEqual(await command, { status: "rejected" }, "a command torn down mid-admission is rejected");
    assert.deepEqual(harness.lines().filter(line => line.level !== "debug"), [], "and a shutdown narrates nothing, at any level a user reads");
  });

  test("a command holding a warm token completes with the READ ceiling fully saturated", async (t) => {

    const controller = new AbortController();

    const harness = makeV2Harness((agent, record) => {

      programReply(agent, record, TOKEN_PATH, TOKEN_BODY);
      programReply(agent, record, GRAPH_PATH, { data: { suspendZone: { status: "OK" } } });
    }, { signal: controller.signal });

    t.after(() => controller.abort("test-teardown"));

    /* The WARM TOKEN is the precondition that gives this assertion its meaning, and the order it is established in is the whole of the setup. A token comfortably inside
     * its lifetime short-circuits the chokepoint without touching any ceiling at all, so the only bucket this command goes on to draw is the one under test. Cold,
     * the command's grant would block on the drained read ceiling under either wiring and the assertion would prove nothing about which bucket admits a command.
     */
    assert.equal(await harness.client.ensureToken(), "access-one", "the client is warmed with a token good for the rest of the test");

    await saturate(harness.budget);

    assert.equal(harness.budget.available, 0, "and the read ceiling is then spent to the last slot");

    const result = await harness.client.setZoneSuspension({ until: PROBE_SUSPEND_UNTIL, zoneId: QUIET_ZONE_ID });

    assert.deepEqual(result, { status: "done" }, "the command is admitted and completed by a ceiling the reads cannot exhaust");
    assert.deepEqual(harness.calls.map(call => call.path), [ TOKEN_PATH, GRAPH_PATH ], "with the warm token spending no second grant on its way to the wire");
    assert.equal(harness.mutationBudget.available, HYDRAWISE_V2_MUTATION_BUDGET_CALLS - 1, "and the command paid for itself out of the command ceiling alone");
    assert.equal(harness.budget.available, 0, "leaving the read ceiling exactly as drained as it found it");
  });

  test("a saturated command ceiling turns a command away while a scheduled read proceeds on the READ ceiling", async (t) => {

    const controller = new AbortController();

    const harness = makeV2Harness((agent, record) => {

      programReply(agent, record, TOKEN_PATH, TOKEN_BODY);
      programReply(agent, record, GRAPH_PATH, ACCOUNT_BODY);
    }, { signal: controller.signal });

    t.after(() => controller.abort("test-teardown"));

    // The other polarity of the same independence, and the direction that actually motivated the split: a burst of switch flips that has spent its own ceiling must
    // not take the scheduled reads down with it. Driving both in ONE test is the only arrangement that can observe that, since the claim is about their relation.
    await saturate(harness.mutationBudget);

    const command = harness.client.setZoneSuspension({ until: PROBE_SUSPEND_UNTIL, zoneId: QUIET_ZONE_ID });
    const facts = await harness.client.fetchAccountFacts();

    assert.ok(facts, "the scheduled read is admitted and answered while the command ceiling stands at zero");
    assert.equal(facts.get(1058515)?.online, true, "and it carries the account's own answer, whole");
    assert.deepEqual(await command, { status: "rejected" }, "while the command is turned away by the ceiling that is actually its own");
  });

  test("the command ceiling admits exactly its capacity inside one window, and turns the next one away", async (t) => {

    const controller = new AbortController();

    const harness = makeV2Harness((agent, record) => {

      programReply(agent, record, TOKEN_PATH, TOKEN_BODY);
      programReply(agent, record, GRAPH_PATH, { data: { suspendZone: { status: "OK" } } });
    }, { signal: controller.signal });

    t.after(() => controller.abort("test-teardown"));

    // Warmed first, so the burst below is metered by the command ceiling and by nothing else: a cold client would run the narrower read ceiling out partway through
    // and the boundary this test is looking for would be the wrong one's.
    assert.equal(await harness.client.ensureToken(), "access-one", "the client is warmed before the burst, so no command in it pays for a grant");

    const burst = await Promise.all(Array.from({ length: HYDRAWISE_V2_MUTATION_BUDGET_CALLS },
      (_, index) => harness.client.setZoneSuspension({ until: PROBE_SUSPEND_UNTIL, zoneId: QUIET_ZONE_ID + index })));

    assert.deepEqual(burst, Array.from({ length: HYDRAWISE_V2_MUTATION_BUDGET_CALLS }, () => ({ status: "done" })),
      "a burst the size of the ceiling is admitted whole");
    assert.equal(harness.mutationBudget.available, 0, "which is the ceiling spent exactly, with nothing over");
    assert.deepEqual(await harness.client.setZoneSuspension({ until: PROBE_SUSPEND_UNTIL, zoneId: QUIET_ZONE_ID }), { status: "rejected" },
      "and the command past the boundary is refused rather than queued behind an hour-wide window");
    assert.equal(harness.calls.filter(call => call.path === GRAPH_PATH).length, HYDRAWISE_V2_MUTATION_BUDGET_CALLS,
      "with exactly the admitted commands reaching the wire");
    assert.equal(harness.budget.available, HYDRAWISE_V2_BUDGET_CALLS - 1, "and the read ceiling down only the one slot the warming grant spent");
  });
});

describe("HydrawiseV2Client dispatcher", () => {

  test("a timed-out request re-arms the connection pool, and the dispatcher getter answers the replacement", async () => {

    const first = destroyable(new MockAgent());
    const second = new MockAgent();
    const built = [ first, second ];
    const { lines, logger } = capturingLog();
    const signal = new AbortController().signal;

    first.disableNetConnect();
    second.disableNetConnect();

    // The timeout is driven through the request itself rather than by reaching past the class: undici surfaces a request timeout as exactly this DOMException, so
    // rejecting with it puts the client on the same code path a genuinely slow account would.
    first.get(V2_ORIGIN).intercept({ method: "POST", path: TOKEN_PATH })
      .replyWithError(new DOMException("The operation was aborted due to timeout", "TimeoutError")).persist();

    const client = new HydrawiseV2Client({ budget: new RateBudget({ capacity: HYDRAWISE_V2_BUDGET_CALLS, signal, window: HYDRAWISE_V2_BUDGET_WINDOW * 1000 }),
      dispatcherFactory: (): MockAgent => built.shift() ?? second, log: logger,
      mutationBudget: new RateBudget({ capacity: HYDRAWISE_V2_MUTATION_BUDGET_CALLS, signal, window: HYDRAWISE_V2_MUTATION_BUDGET_WINDOW * 1000 }),
      password: "test-password", signal, username: "test-user" });

    assert.equal(client.dispatcher, first, "the client starts on the dispatcher its factory built");
    assert.equal(await client.ensureToken(), null, "a timed-out grant answers null");

    /* A wedged pool carries every request on its single connection, so it is replaced rather than waited out. The getter answering the REPLACEMENT is what makes
     * the platform's teardown correct across this: that registration reads the dispatcher at disposal time, and a captured reference would destroy the pool that
     * was already abandoned while leaving the live one open.
     */
    assert.equal(client.dispatcher, second, "the timeout re-armed the pool, and the getter answers the live one");
    assert.ok(lines().some(line => (line.level === "error") && line.message.includes("too long to respond")), "the timeout is reported to the user");
  });

  test("a response deadline re-arms the connection pool exactly as the request deadline does", async () => {

    const first = destroyable(new MockAgent());
    const second = new MockAgent();
    const built = [ first, second ];
    const { lines, logger } = capturingLog();
    const signal = new AbortController().signal;

    first.disableNetConnect();
    second.disableNetConnect();

    // The transport's own header deadline is a deadline elapsing exactly as the composed per-request timeout is, so it takes the same arm: the same sentence, and
    // the same replacement of a pool whose single connection every in-flight request was using.
    first.get(V2_ORIGIN).intercept({ method: "POST", path: TOKEN_PATH }).replyWithError(new errors.HeadersTimeoutError()).persist();

    const client = new HydrawiseV2Client({ budget: new RateBudget({ capacity: HYDRAWISE_V2_BUDGET_CALLS, signal, window: HYDRAWISE_V2_BUDGET_WINDOW * 1000 }),
      dispatcherFactory: (): MockAgent => built.shift() ?? second, log: logger,
      mutationBudget: new RateBudget({ capacity: HYDRAWISE_V2_MUTATION_BUDGET_CALLS, signal, window: HYDRAWISE_V2_MUTATION_BUDGET_WINDOW * 1000 }),
      password: "test-password", signal, username: "test-user" });

    assert.equal(client.dispatcher, first, "the client starts on the dispatcher its factory built");
    assert.equal(await client.ensureToken(), null, "a grant that outran the response deadline answers null");
    assert.equal(client.dispatcher, second, "the deadline re-armed the pool, and the getter answers the live one");
    assert.ok(lines().some(line => (line.level === "error") && line.message.includes("too long to respond")), "and the deadline is reported to the user");
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
      const { lines, logger } = capturingLog();
      const signal = new AbortController().signal;

      first.disableNetConnect();
      second.disableNetConnect();
      first.get(V2_ORIGIN).intercept({ method: "POST", path: TOKEN_PATH })
        .replyWithError(Object.assign(new Error("a transport fault"), { code: row.code })).persist();

      const client = new HydrawiseV2Client({ budget: new RateBudget({ capacity: HYDRAWISE_V2_BUDGET_CALLS, signal, window: HYDRAWISE_V2_BUDGET_WINDOW * 1000 }),
        dispatcherFactory: (): MockAgent => built.shift() ?? second, log: logger,
        mutationBudget: new RateBudget({ capacity: HYDRAWISE_V2_MUTATION_BUDGET_CALLS, signal, window: HYDRAWISE_V2_MUTATION_BUDGET_WINDOW * 1000 }),
        password: "test-password", signal, username: "test-user" });

      // eslint-disable-next-line no-await-in-loop
      assert.equal(await client.ensureToken(), null, "a coded transport fault answers the same null every failed grant does");
      assert.deepEqual(errorLines(lines()),
        ["Unable to sign in to your Hydrawise account for enhanced features. " + HYDRAWISE_TRANSPORT_FAULT_SENTENCES[row.kind]],
        "and it reads as the sign-in sentence joined to the fault's own by a period");
      assert.equal(client.dispatcher, first, "while a fault that is not a deadline leaves the pool alone");
    }
  });

  test("a transport fault on a suspension command travels back as the sentence the controller says", async () => {

    /* The command path is where a transport fault reaches a user under the name of the zone they touched: the failure travels back in the result rather than being
     * logged here, so the reason the controller is handed is what this asserts.
     */
    const harness = makeV2Harness((agent, record) => {

      programReply(agent, record, TOKEN_PATH, TOKEN_BODY);
      agent.get(V2_ORIGIN).intercept({ method: "POST", path: GRAPH_PATH })
        .replyWithError(Object.assign(new Error("connect ECONNREFUSED"), { code: "ECONNREFUSED" }));
    });

    assert.deepEqual(await harness.client.setZoneSuspension({ until: PROBE_SUSPEND_UNTIL, zoneId: QUIET_ZONE_ID }),
      { reason: HYDRAWISE_TRANSPORT_FAULT_SENTENCES.refused, status: "failed" }, "the fault's own sentence travels back for the controller to say");
    assert.deepEqual(errorLines(harness.lines()), [], "with nothing said here about the command that provoked it");
  });
});
