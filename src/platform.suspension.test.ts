/* Copyright(C) 2017-2026, HJD (https://github.com/hjdhjd). All rights reserved.
 *
 * platform.suspension.test.ts: The platform's per-zone suspension surface, exercised against a REAL HydrawisePlatform. The client under it is a REAL
 * HydrawiseV2Client built over an injected MockAgent and sharing the platform's own rate budgets, so the whole path - the platform's zero-cost pre-check, the
 * client's admission phase, the transport - runs production code with nothing ever reaching the account API.
 *
 * The pre-check and the admission bound are deliberately told apart here. The pre-check answers the COMMON saturated case for free and carries a check-then-act
 * race of its own; the client's admission window is what bounds the loser of that race. A suite that drove only the fast path would pass against an
 * implementation whose race loser blocked for the length of the budget's own window.
 *
 * Which ceiling a fixture drains is the whole meaning of these tests, so each one says so. A command's admission draws the COMMAND ceiling, while the token grant
 * it may need draws the READ ceiling alongside the scheduled reads, and a saturation staged against the wrong one of those would prove nothing about the path it
 * claims to be testing.
 */
// The OAuth wire shape uses snake_case keys such as access_token, so camelcase is disabled here to let the grant fixture mirror the captured body verbatim.
/* eslint-disable camelcase */
import { HYDRAWISE_V2_BUDGET_CALLS, HYDRAWISE_V2_GRAPH_ENDPOINT, HYDRAWISE_V2_MUTATION_BUDGET_CALLS, HYDRAWISE_V2_MUTATION_BUDGET_WINDOW,
  HYDRAWISE_V2_TOKEN_ENDPOINT } from "./settings.ts";
import { buildPlatform, installV2Client, v2BudgetOf, v2MutationBudgetOf } from "./testing/platform.helpers.ts";
import { describe, test } from "node:test";
import type { HydrawisePlatform } from "./platform.ts";
import { HydrawiseV2Client } from "./v2.ts";
import { MockAgent } from "undici";
import type { RateBudget } from "homebridge-plugin-utils";
import type { TestLogEntry } from "homebridge-plugin-utils/testing";
import assert from "node:assert/strict";
import { capturingLog } from "homebridge-plugin-utils/testing";

const SHUTDOWN = "shutdown";

// The configured-option entries that carry an account login, which is the only home those credentials have and the whole of what the client gate reads.
const CREDENTIAL_OPTIONS = [ "Enable.Account.Password=test-password", "Enable.Account.Username=test-user" ];

// The v2 origin and the paths every account-credentialed request targets (GRAPH_PATH and TOKEN_PATH), derived from the endpoint constants exactly as the client
// derives its own.
const V2_ORIGIN = new URL(HYDRAWISE_V2_GRAPH_ENDPOINT).origin;

const GRAPH_PATH = new URL(HYDRAWISE_V2_GRAPH_ENDPOINT).pathname;

const TOKEN_PATH = new URL(HYDRAWISE_V2_TOKEN_ENDPOINT).pathname;

// A successful token grant, shaped as the live capture recorded it.
const TOKEN_BODY = { access_token: "access-one", expires_in: 3600, refresh_token: "refresh-one" };

// The zone every command below names, taken from the live capture's own id space.
const ZONE_ID = 6940181;

// A far-future instant to suspend until, which is the shape a real command carries.
const SUSPEND_UNTIL = 1903928399;

/** Replace the platform's own client with a REAL one over a MockAgent, sharing BOTH of the platform's rate budgets so the pre-check and the admission phase are
 * reading the same ceilings production has them read. The agent refuses to connect out, so a request that escaped an intercept fails loudly rather than reaching
 * the account.
 *
 * The client's log is CAPTURED rather than silenced, because the one line it writes about a command - the debug sentence its admission phase emits when the window
 * closes on it - is how a test tells a command the platform refused for free from one the client took in and then turned away. That absence is the only witness
 * with no clock in it.
 *
 * @param platform - The HydrawisePlatform whose client field this installs the double onto.
 * @param program  - Callback that programs the agent's replies, calling record() for each request the fixture serves so the returned served() reader counts them.
 *
 * @returns The lines the client wrote, read live, and a reader for the requests the agent served, which together are what an absence assertion reads.
 */
function installRealClient(platform: HydrawisePlatform,
  program: (agent: MockAgent, record: () => void) => void): { entries: readonly TestLogEntry[]; served: () => number } {

  /* undici's MockAgent implements close but inherits the base dispatcher's unimplemented destroy, and the platform's teardown calls destroy because that is what
   * fails a wedged pool's in-flight requests fast; mapping one onto the other is the double's business, not production's.
   */
  const agent = Object.assign(new MockAgent(), { destroy: async (): Promise<void> => { await agent.close(); } });
  const log = capturingLog();
  let served = 0;

  agent.disableNetConnect();
  program(agent, (): void => { served++; });

  installV2Client(platform, new HydrawiseV2Client({ budget: v2BudgetOf(platform), dispatcherFactory: (): MockAgent => agent, log,
    mutationBudget: v2MutationBudgetOf(platform), password: "test-password", signal: platform.signal, username: "test-user" }));

  return { entries: log.entries, served: (): number => served };
}

// The client's own sentence about a command its admission window closed on. A test that means to assert the platform's free refusal asserts this line's ABSENCE, which
// is what says the command never reached the client at all.
const NOT_ADMITTED = "The zone suspension command was not admitted";

// Program one persisted JSON reply for a v2 path, counting the requests it serves.
function programReply(agent: MockAgent, record: () => void, path: string, body: object): void {

  agent.get(V2_ORIGIN).intercept({ method: "POST", path }).reply(200, (): object => {

    record();

    return body;
  }).persist();
}

// Spend slots on the stated ceiling until the stated number remain free, so a test states the room it wants rather than the arithmetic that produces it. The
// ceiling is passed in rather than looked up, because WHICH ceiling a fixture saturates is the claim each test below rests on.
async function drainTo(budget: RateBudget, remaining: number): Promise<void> {

  while(budget.available > remaining) {

    // eslint-disable-next-line no-await-in-loop
    await budget.acquire();
  }
}

describe("HydrawisePlatform zone suspension surface", () => {

  test("a platform with no account credentials answers unavailable", async (t) => {

    const { emit, platform } = buildPlatform();

    t.after(() => emit(SHUTDOWN));

    /* The honest answer for a caller that has no client to command through. It is structurally unreachable from a live switch - those exist only where a client
     * does, and that is fixed at construction - which is exactly why it is asserted HERE, at the surface that can actually produce it, rather than through a handler
     * that could never reach it.
     */
    assert.equal(platform.hasV2Client, false, "an install carrying only an API key builds no client at all");
    assert.deepEqual(await platform.setZoneSuspension({ until: SUSPEND_UNTIL, zoneId: ZONE_ID }), { status: "unavailable" },
      "and its suspension surface says so rather than pretending to command");
  });

  test("an accepted command answers done, and a refused one carries the account's own words back", async (t) => {

    const { emit, platform } = buildPlatform({ options: CREDENTIAL_OPTIONS });

    t.after(() => emit(SHUTDOWN));

    const { served } = installRealClient(platform, (agent, record) => {

      programReply(agent, record, TOKEN_PATH, TOKEN_BODY);
      programReply(agent, record, GRAPH_PATH, { data: { suspendZone: { status: "ERROR", summary: "Hydrawise says no." } } });
    });

    /* The refusal's summary reaching the platform's own answer is the point: the controller speaks one sentence about a failed command and names the reason in it,
     * which it can only do if the reason travels this far. A boolean surface would have lost it here.
     */
    assert.deepEqual(await platform.setZoneSuspension({ until: SUSPEND_UNTIL, zoneId: ZONE_ID }), { reason: "Hydrawise says no.", status: "failed" },
      "a command the account refused reports the account's own summary");
    assert.equal(served(), 2, "a genuinely attempted command spent its grant and its mutation");
  });

  test("a saturated COMMAND ceiling is refused by the pre-check, without a single call being spent or the client being entered", async (t) => {

    const { emit, platform } = buildPlatform({ options: CREDENTIAL_OPTIONS });

    t.after(() => emit(SHUTDOWN));

    const { entries, served } = installRealClient(platform, (agent, record) => {

      programReply(agent, record, TOKEN_PATH, TOKEN_BODY);
      programReply(agent, record, GRAPH_PATH, { data: { suspendZone: { status: "OK" } } });
    });

    // The COMMAND ceiling is the one the pre-check reads, so it is the one drained here. The read ceiling is left deliberately untouched: a pre-check consulting
    // that one instead would sail straight past a full bucket, and the assertions below are what catch it doing so.
    await drainTo(v2MutationBudgetOf(platform), 0);

    assert.deepEqual(await platform.setZoneSuspension({ until: SUSPEND_UNTIL, zoneId: ZONE_ID }), { status: "rejected" },
      "a command ceiling with nothing to give refuses the command");

    /* Zero calls is the whole claim of the pre-check, and it is what makes a burst of taps free. The absent debug line is the sharper half of the claim: the client
     * writes that sentence whenever its own admission window closes on a command, so its silence is what says the command was refused BEFORE the client was ever
     * entered. A clock reading could only have suggested as much.
     */
    assert.equal(served(), 0, "the refusal touched no connection and spent no call");
    assert.deepEqual(entries.filter(line => line.message.includes(NOT_ADMITTED)), [], "and the client never saw it at all, so its admission phase said nothing");
    assert.equal(v2BudgetOf(platform).available, HYDRAWISE_V2_BUDGET_CALLS, "with the read ceiling left whole for the scheduled reads");
  });

  test("the pre-check's race loser is bounded by the admission window, not by the command budget's", async (t) => {

    const { emit, platform } = buildPlatform({ options: CREDENTIAL_OPTIONS });

    t.after(() => emit(SHUTDOWN));

    const { entries, served } = installRealClient(platform, (agent, record) => {

      programReply(agent, record, TOKEN_PATH, TOKEN_BODY);
      programReply(agent, record, GRAPH_PATH, { data: { suspendZone: { status: "OK" } } });
    });

    /* ONE slot left on the COMMAND ceiling is the state the race needs, and staging it there rather than on the read ceiling is what makes this the pre-check's own
     * race: the pre-check reads that bucket, so two commands started in the same frame both see the slot as free before either has taken it. The budget records a
     * grant on a microtask rather than in the calling frame, which is precisely why the check-then-act window exists at all and is driven here rather than reasoned
     * about. The read ceiling is left whole, so the winner's token grant is paid for and the two commands part ways on their own merits.
     */
    await drainTo(v2MutationBudgetOf(platform), 1);

    const started = Date.now();
    const commands = await Promise.all([ platform.setZoneSuspension({ until: SUSPEND_UNTIL, zoneId: ZONE_ID }),
      platform.setZoneSuspension({ until: null, zoneId: ZONE_ID }) ]);
    const elapsed = Date.now() - started;

    /* The queue is first-in-first-out, so the command that asked first takes the last slot and goes on to complete, while the one behind it gives up on its bounded
     * wait. That bound is the whole point: unbounded, the loser would sit in the queue toward the command budget's own hour-wide horizon instead of answering the
     * person holding the phone.
     */
    assert.deepEqual(commands, [ { status: "done" }, { status: "rejected" } ], "the winner completes and the loser is turned away rather than queued");
    assert.ok(elapsed < (HYDRAWISE_V2_MUTATION_BUDGET_WINDOW * 1000), "and the loser resolved on the admission window rather than the budget's hour");
    assert.equal(served(), 2, "exactly the winner's grant and its mutation reached the wire");
    assert.equal(entries.filter(line => line.message.includes(NOT_ADMITTED)).length, 1, "with the client's admission phase speaking once, for the loser alone");
  });

  test("the surface draws the command ceiling for its admission and the read ceiling for the grant", async (t) => {

    const { emit, platform } = buildPlatform({ options: CREDENTIAL_OPTIONS });

    t.after(() => emit(SHUTDOWN));

    installRealClient(platform, (agent, record) => {

      programReply(agent, record, TOKEN_PATH, TOKEN_BODY);
      programReply(agent, record, GRAPH_PATH, { data: { resumeZone: { status: "OK" } } });
    });

    assert.deepEqual(await platform.setZoneSuspension({ until: null, zoneId: ZONE_ID }), { status: "done" }, "the command was accepted");

    /* One command on a cold client spends one slot of each ceiling, and asserting them SEPARATELY is what would catch either draw quietly moving to the other's
     * meter: the admission is the command's own, while the token grant is shared infrastructure a scheduled read would have paid for identically. A single total
     * across both would read the same whichever bucket each came out of.
     */
    assert.equal(v2MutationBudgetOf(platform).available, HYDRAWISE_V2_MUTATION_BUDGET_CALLS - 1, "the admission spent one slot of the command ceiling");
    assert.equal(v2BudgetOf(platform).available, HYDRAWISE_V2_BUDGET_CALLS - 1, "and the grant it needed spent one slot of the read ceiling");
  });
});
