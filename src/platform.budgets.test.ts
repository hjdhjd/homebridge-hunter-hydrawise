/* Copyright(C) 2017-2026, HJD (https://github.com/hjdhjd). All rights reserved.
 *
 * platform.budgets.test.ts: The rate ceilings retrieve() enforces, exercised against a REAL platform whose undici traffic runs through a MockAgent
 * installed as the global dispatcher after construction. Asserts the capacities the platform constructs its budgets at, which budget each endpoint draws against,
 * and - the assertion the whole mechanism rests on - that both draws are AWAITED, by saturating a ceiling and proving the blocked call put nothing on the wire before
 * shutdown resolved it to the quiet null every caller of retrieve() expects. A command admitted after a wait longer than a request's deadline still confirms, which
 * is what holds the deadline to the moment the request is admitted.
 *
 * Draw ORDER (the command ceiling before the account ceiling) is deliberately not asserted here. The budgets are independent objects, so no order between them
 * is observable from outside without a production test hook this suite refuses to add; the order is a structural property of two adjacent awaits and is verified
 * by reading the diff, while what these tests verify is that each ceiling is independently enforced by an awaited draw.
 *
 * Every platform here runs on a TestClock nothing steps unless a row does, so a correctly awaited draw stays parked on that clock however long a row settles, and
 * the check can never fail against a correct implementation. A draw that was dispatched instead of awaited reaches the wire within a turn or two, which the turns
 * each blocked row settles are enough to catch, and the parked wait on the clock is the positive witness that the window was there to cross.
 */

// The Hydrawise API wire shapes use snake_case keys such as message_type, so camelcase is disabled here to let these literals mirror the wire verbatim.
/* eslint-disable camelcase */
import { HYDRAWISE_API_BUDGET_CALLS, HYDRAWISE_API_BUDGET_WINDOW, HYDRAWISE_COMMAND_BUDGET_CALLS, HYDRAWISE_COMMAND_BUDGET_WINDOW,
  HYDRAWISE_COMMAND_ENDPOINT } from "./settings.ts";
import { budgetsOf, buildPlatform, installMockDispatcher, programCountedReply } from "./testing/platform.helpers.ts";
import { describe, test } from "node:test";
import { loggedAt, settle, settleUntil } from "homebridge-plugin-utils/testing";
import type { HydrawiseCommandOutcome } from "./types.ts";
import assert from "node:assert/strict";

// APIEvent.SHUTDOWN's string value, the event the platform binds its teardown to. Firing it aborts the shutdown signal, which is what releases a caller waiting on
// a saturated budget.
const SHUTDOWN = "shutdown";

// The reply body every counted intercept answers with. Its content is immaterial to these tests: what matters is only whether a reply was served at all.
const REPLY_BODY = { message: "" };

// The reply a command's admission row is answered with, the verdict Hydrawise gives a command it accepted, and the parameters the command carries, which are
// immaterial to its admission.
const CONFIRMATION = { message: "", message_type: "info" };
const PARAMS = { action: "stop", controller_id: "500001", relay_id: "700001" };

// A call count comfortably below either ceiling, used where a test needs several successful calls without saturating anything. The assertions it feeds are written
// against the ceiling constants minus this number, never against a bare literal, so a changed ceiling moves the expectation with it.
const CALLS_WELL_UNDER_CEILING = 3;

describe("HydrawisePlatform rate budgets", () => {

  test("constructs each budget at its documented capacity", (t) => {

    const { emit, platform } = buildPlatform();

    t.after(() => emit(SHUTDOWN));

    const budgets = budgetsOf(platform);

    assert.equal(budgets.account.capacity, HYDRAWISE_API_BUDGET_CALLS, "the account budget carries the account-wide call ceiling");
    assert.equal(budgets.command.capacity, HYDRAWISE_COMMAND_BUDGET_CALLS, "the command budget carries the zone-command ceiling");
    assert.equal(budgets.account.available, HYDRAWISE_API_BUDGET_CALLS, "a freshly constructed account budget has spent nothing");
    assert.equal(budgets.command.available, HYDRAWISE_COMMAND_BUDGET_CALLS, "a freshly constructed command budget has spent nothing");
  });

  test("a non-command call draws the account budget alone", async (t) => {

    const { emit, platform } = buildPlatform();

    t.after(() => emit(SHUTDOWN));
    await using dispatcher = installMockDispatcher();

    const served = programCountedReply(dispatcher.agent, "statusschedule.php", REPLY_BODY);

    for(let call = 0; call < CALLS_WELL_UNDER_CEILING; call++) {

      // The calls run one after another rather than in parallel, because what is being asserted is how many slots a SEQUENCE of admitted calls consumes.
      // eslint-disable-next-line no-await-in-loop
      await platform.retrieve("statusschedule.php");
    }

    const budgets = budgetsOf(platform);

    assert.equal(served(), CALLS_WELL_UNDER_CEILING, "every call should have put exactly one request on the wire");
    assert.equal(budgets.account.available, HYDRAWISE_API_BUDGET_CALLS - CALLS_WELL_UNDER_CEILING, "the account budget drops one slot per admitted call");
    assert.equal(budgets.command.available, HYDRAWISE_COMMAND_BUDGET_CALLS, "an endpoint that is not a zone command leaves the command budget untouched");
  });

  test("a zone command draws the account ceiling and the command ceiling", async (t) => {

    const { emit, platform } = buildPlatform();

    t.after(() => emit(SHUTDOWN));
    await using dispatcher = installMockDispatcher();

    const served = programCountedReply(dispatcher.agent, HYDRAWISE_COMMAND_ENDPOINT, REPLY_BODY);

    await platform.retrieve(HYDRAWISE_COMMAND_ENDPOINT);

    const budgets = budgetsOf(platform);

    assert.equal(served(), 1, "the command should have put exactly one request on the wire");
    assert.equal(budgets.command.available, HYDRAWISE_COMMAND_BUDGET_CALLS - 1, "a zone command consumes a command slot");
    assert.equal(budgets.account.available, HYDRAWISE_API_BUDGET_CALLS - 1, "a zone command consumes an account slot as well");
  });

  test("a call blocked at the saturated account ceiling puts nothing on the wire and resolves to null on shutdown", async () => {

    const { clock, emit, entries, platform } = buildPlatform();

    await using dispatcher = installMockDispatcher();

    const served = programCountedReply(dispatcher.agent, "statusschedule.php", REPLY_BODY);

    // Spend every slot the account ceiling grants, awaiting each so the budget's timestamp log fills in arrival order.
    for(let call = 0; call < HYDRAWISE_API_BUDGET_CALLS; call++) {

      // eslint-disable-next-line no-await-in-loop
      await platform.retrieve("statusschedule.php");
    }

    assert.equal(served(), HYDRAWISE_API_BUDGET_CALLS, "the ceiling's worth of calls should all have reached the wire");

    // The next call finds no free slot inside the trailing window and must WAIT for one. This is where an unawaited draw gives itself away: it would let the caller
    // fall straight through to the request, and the wire count would show that extra request. Shutdown then rejects the wait, and retrieve's aborted-signal branch
    // answers this caller with the quiet null every other teardown path answers with.
    const blocked = platform.retrieve("statusschedule.php");

    await settle(2);

    assert.equal(served(), HYDRAWISE_API_BUDGET_CALLS, "the blocked call is still waiting out the window rather than having reached the wire");
    assert.equal(clock.pending, 1, "its wait for a slot is the one entry on the platform's clock");
    assert.equal(clock.nextDeadline, HYDRAWISE_API_BUDGET_WINDOW * 1000, "and it lasts until the spent slots leave the account ceiling's window");

    emit(SHUTDOWN);

    assert.equal(await blocked, null, "a call blocked at the ceiling resolves to null once shutdown aborts its wait");
    assert.equal(served(), HYDRAWISE_API_BUDGET_CALLS, "the blocked call put no request on the wire");
    assert.equal(entries.filter(line => line.level === "error").length, 0, "a shutdown reached while waiting for a slot is orderly teardown, so nothing is logged " +
      "at error level");
  });

  test("a command blocked at the saturated command ceiling puts nothing on the wire and resolves to null on shutdown", async () => {

    const { clock, emit, entries, platform } = buildPlatform();

    await using dispatcher = installMockDispatcher();

    const served = programCountedReply(dispatcher.agent, HYDRAWISE_COMMAND_ENDPOINT, REPLY_BODY);

    // Spend every slot the command ceiling grants. The account ceiling is far larger, so it still has slots to spare and the block below can only be the command
    // ceiling doing its job.
    for(let call = 0; call < HYDRAWISE_COMMAND_BUDGET_CALLS; call++) {

      // eslint-disable-next-line no-await-in-loop
      await platform.retrieve(HYDRAWISE_COMMAND_ENDPOINT);
    }

    const accountBeforeBlocking = budgetsOf(platform).account.available;

    assert.equal(served(), HYDRAWISE_COMMAND_BUDGET_CALLS, "the ceiling's worth of commands should all have reached the wire");
    assert.ok(accountBeforeBlocking > 0, "the account ceiling still has room, so only the command ceiling can block the next command");

    const blocked = platform.retrieve(HYDRAWISE_COMMAND_ENDPOINT);

    await settle(2);

    // Two independent witnesses that the command draw held this call, either of which a dispatched-instead-of-awaited command draw would break: the request never
    // reached the wire, and the call never got as far as the account draw that sits behind the command draw and would have admitted it at once.
    assert.equal(served(), HYDRAWISE_COMMAND_BUDGET_CALLS, "the blocked command is still waiting out the window rather than having reached the wire");
    assert.equal(budgetsOf(platform).account.available, accountBeforeBlocking, "the blocked command never reached the account draw, so it consumed no account slot");
    assert.equal(clock.pending, 1, "its wait for a slot is the one entry on the platform's clock");
    assert.equal(clock.nextDeadline, HYDRAWISE_COMMAND_BUDGET_WINDOW * 1000, "and it lasts until the spent slots leave the command ceiling's window");

    emit(SHUTDOWN);

    assert.equal(await blocked, null, "a command blocked at the ceiling resolves to null once shutdown aborts its wait");
    assert.equal(served(), HYDRAWISE_COMMAND_BUDGET_CALLS, "the blocked command put no request on the wire");
    assert.equal(entries.filter(line => line.level === "error").length, 0, "a shutdown reached while waiting for a slot is orderly teardown, so nothing is logged " +
      "at error level");
  });

  test("a command admitted after a wait longer than a request's deadline still confirms, because its deadline is armed only at admission", async (t) => {

    const { clock, emit, entries, platform } = buildPlatform();

    t.after(() => emit(SHUTDOWN));
    await using dispatcher = installMockDispatcher();

    const served = programCountedReply(dispatcher.agent, HYDRAWISE_COMMAND_ENDPOINT, CONFIRMATION);

    /* Spend every slot the command ceiling grants, so the next command waits out the ceiling's whole window. The window is longer than a request is given to
     * answer, so a deadline armed ahead of admission would run out during the wait, and the request it bounds would be cut off before it was sent.
     */
    for(let call = 0; call < HYDRAWISE_COMMAND_BUDGET_CALLS; call++) {

      // eslint-disable-next-line no-await-in-loop
      await platform.command({ params: PARAMS });
    }

    const outcomes: HydrawiseCommandOutcome[] = [];

    void platform.command({ params: PARAMS }).then((outcome): void => {

      outcomes.push(outcome);
    });

    await settle(2);

    assert.equal(served(), HYDRAWISE_COMMAND_BUDGET_CALLS, "the command waits for the command ceiling");
    assert.equal(clock.nextDeadline, HYDRAWISE_COMMAND_BUDGET_WINDOW * 1000, "and the first entry on the platform's clock is its wait for a slot, no deadline ahead");

    clock.advance(HYDRAWISE_COMMAND_BUDGET_WINDOW * 1000);
    await settleUntil(() => outcomes.length === 1, { description: "the command admitted at the end of the window to be answered" });

    assert.deepEqual(outcomes, [{ status: "confirmed" }], "the command admitted after the wait confirms");
    assert.equal(served(), HYDRAWISE_COMMAND_BUDGET_CALLS + 1, "on the one request it put on the wire once admitted");
    assert.ok(!loggedAt(entries, "error", "taking too long"), "and no deadline ran out while it waited");
  });
});
