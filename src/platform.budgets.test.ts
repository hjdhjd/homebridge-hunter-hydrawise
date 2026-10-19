/* Copyright(C) 2017-2026, HJD (https://github.com/hjdhjd). All rights reserved.
 *
 * platform.budgets.test.ts: The rate ceilings retrieve() enforces, exercised against a REAL platform whose undici traffic runs through a MockAgent
 * installed as the global dispatcher after construction. Asserts the capacities the platform constructs its budgets at, which budget each endpoint draws against,
 * and - the assertion the whole mechanism rests on - that both draws are AWAITED, by saturating a ceiling and proving the blocked call put nothing on the wire before
 * shutdown resolved it to the quiet null every caller of retrieve() expects.
 *
 * Draw ORDER (the command ceiling before the account ceiling) is deliberately not asserted here. The budgets are independent objects, so no order between them
 * is observable from outside without a production test hook this suite refuses to add; the order is a structural property of two adjacent awaits and is verified
 * by reading the diff, while what these tests verify is that each ceiling is independently enforced by an awaited draw.
 */
import { HYDRAWISE_API_BUDGET_CALLS, HYDRAWISE_COMMAND_BUDGET_CALLS, HYDRAWISE_COMMAND_ENDPOINT } from "./settings.ts";
import { budgetsOf, buildPlatform, installMockDispatcher, programCountedReply } from "./testing/platform.helpers.ts";
import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { setTimeout as delay } from "node:timers/promises";

// APIEvent.SHUTDOWN's string value, the event the platform binds its teardown to. Firing it aborts the shutdown signal, which is what releases a caller waiting on
// a saturated budget.
const SHUTDOWN = "shutdown";

/* How long, in milliseconds, a blocked call is given to misbehave before the assertion that it has not. A correctly awaited draw is waiting out a trailing window
 * measured in tens or hundreds of seconds, so it cannot reach the wire inside this span no matter how the machine is loaded - the check can never fail against a
 * correct implementation. A draw that was dispatched instead of awaited reaches the wire within a microtask or two, which is what this span is long enough to
 * catch. Both properties come from the same asymmetry, which is why the number is a settle window rather than a race.
 */
const SETTLE_MS = 50;

// The reply body every counted intercept answers with. Its content is immaterial to these tests: what matters is only whether a reply was served at all.
const REPLY_BODY = { message: "" };

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
      const response = await platform.retrieve("statusschedule.php");

      // eslint-disable-next-line no-await-in-loop
      await response?.body.json();
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
    const response = await platform.retrieve(HYDRAWISE_COMMAND_ENDPOINT);

    await response?.body.json();

    const budgets = budgetsOf(platform);

    assert.equal(served(), 1, "the command should have put exactly one request on the wire");
    assert.equal(budgets.command.available, HYDRAWISE_COMMAND_BUDGET_CALLS - 1, "a zone command consumes a command slot");
    assert.equal(budgets.account.available, HYDRAWISE_API_BUDGET_CALLS - 1, "a zone command consumes an account slot as well");
  });

  test("a call blocked at the saturated account ceiling puts nothing on the wire and resolves to null on shutdown", async () => {

    const { emit, entries, platform } = buildPlatform();

    await using dispatcher = installMockDispatcher();

    const served = programCountedReply(dispatcher.agent, "statusschedule.php", REPLY_BODY);

    // Spend every slot the account ceiling grants, awaiting each so the budget's timestamp log fills in arrival order.
    for(let call = 0; call < HYDRAWISE_API_BUDGET_CALLS; call++) {

      // eslint-disable-next-line no-await-in-loop
      const response = await platform.retrieve("statusschedule.php");

      // eslint-disable-next-line no-await-in-loop
      await response?.body.json();
    }

    assert.equal(served(), HYDRAWISE_API_BUDGET_CALLS, "the ceiling's worth of calls should all have reached the wire");

    // The next call finds no free slot inside the trailing window and must WAIT for one. This is where an unawaited draw gives itself away: it would let the caller
    // fall straight through to the request, and the wire count would show that extra request. Shutdown then rejects the wait, and retrieve's aborted-signal branch
    // answers this caller with the quiet null every other teardown path answers with.
    const blocked = platform.retrieve("statusschedule.php");

    await delay(SETTLE_MS);

    assert.equal(served(), HYDRAWISE_API_BUDGET_CALLS, "the blocked call is still waiting out the window rather than having reached the wire");

    emit(SHUTDOWN);

    assert.equal(await blocked, null, "a call blocked at the ceiling resolves to null once shutdown aborts its wait");
    assert.equal(served(), HYDRAWISE_API_BUDGET_CALLS, "the blocked call put no request on the wire");
    assert.equal(entries.filter(line => line.level === "error").length, 0, "a shutdown reached while waiting for a slot is orderly teardown, so nothing is logged " +
      "at error level");
  });

  test("a command blocked at the saturated command ceiling puts nothing on the wire and resolves to null on shutdown", async () => {

    const { emit, entries, platform } = buildPlatform();

    await using dispatcher = installMockDispatcher();

    const served = programCountedReply(dispatcher.agent, HYDRAWISE_COMMAND_ENDPOINT, REPLY_BODY);

    // Spend every slot the command ceiling grants. The account ceiling is far larger, so it still has slots to spare and the block below can only be the command
    // ceiling doing its job.
    for(let call = 0; call < HYDRAWISE_COMMAND_BUDGET_CALLS; call++) {

      // eslint-disable-next-line no-await-in-loop
      const response = await platform.retrieve(HYDRAWISE_COMMAND_ENDPOINT);

      // eslint-disable-next-line no-await-in-loop
      await response?.body.json();
    }

    const accountBeforeBlocking = budgetsOf(platform).account.available;

    assert.equal(served(), HYDRAWISE_COMMAND_BUDGET_CALLS, "the ceiling's worth of commands should all have reached the wire");
    assert.ok(accountBeforeBlocking > 0, "the account ceiling still has room, so only the command ceiling can block the next command");

    const blocked = platform.retrieve(HYDRAWISE_COMMAND_ENDPOINT);

    await delay(SETTLE_MS);

    // Two independent witnesses that the command draw held this call, either of which a dispatched-instead-of-awaited command draw would break: the request never
    // reached the wire, and the call never got as far as the account draw that sits behind the command draw and would have admitted it at once.
    assert.equal(served(), HYDRAWISE_COMMAND_BUDGET_CALLS, "the blocked command is still waiting out the window rather than having reached the wire");
    assert.equal(budgetsOf(platform).account.available, accountBeforeBlocking, "the blocked command never reached the account draw, so it consumed no account slot");

    emit(SHUTDOWN);

    assert.equal(await blocked, null, "a command blocked at the ceiling resolves to null once shutdown aborts its wait");
    assert.equal(served(), HYDRAWISE_COMMAND_BUDGET_CALLS, "the blocked command put no request on the wire");
    assert.equal(entries.filter(line => line.level === "error").length, 0, "a shutdown reached while waiting for a slot is orderly teardown, so nothing is logged " +
      "at error level");
  });
});
