/* Copyright(C) 2017-2026, HJD (https://github.com/hjdhjd). All rights reserved.
 *
 * platform.command.test.ts: The HydrawisePlatform.command() path, exercised against a REAL platform whose undici traffic is driven through a MockAgent installed as
 * the global dispatcher after construction. Covers the outcome each answer a command can meet comes to - a confirmation, a refusal in the reply or by status, a
 * reply carrying no verdict or cut off mid-read, a failure, a deadline before the reply or during its read, and a shutdown - the request log a command shares with
 * every other request, the withdrawal a caller's signal makes while the command waits for admission, which takes no slot and reaches nothing already admitted, and
 * the error lines one failed command writes through a controller the platform built.
 */

// The Hydrawise API wire shapes use snake_case keys such as relay_id and message_type, so camelcase is disabled here to let these literals mirror the wire verbatim.
/* eslint-disable camelcase */
import type { BuildPlatformResult, MockDispatcherHandle } from "./testing/platform.helpers.ts";
import { Characteristic, HYDRAWISE_ORIGIN, Service, addressesEndpoint, budgetsOf, buildPlatform, heldEndFor, installMockDispatcher, programCountedReply,
  programJsonReply, programStatusReply } from "./testing/platform.helpers.ts";
import { HYDRAWISE_API_TIMEOUT, HYDRAWISE_COMMAND_BUDGET_CALLS, HYDRAWISE_COMMAND_BUDGET_WINDOW } from "./settings.ts";
import { describe, test } from "node:test";
import { errnoError, linesAt, logCount, loggedAt, present, settle, settleUntil, triggerSet } from "homebridge-plugin-utils/testing";
import { makeCustomerDetails, normalSchedule } from "./api.helpers.ts";
import type { HydrawiseCommandOutcome } from "./types.ts";
import type { HydrawiseController } from "./controller.ts";
import { HydrawiseReservedNames } from "./types.ts";
import type { PlatformAccessory } from "homebridge";
import assert from "node:assert/strict";
import { errors } from "undici";
import { syntheticController } from "./api.fixtures.ts";

// APIEvent.DID_FINISH_LAUNCHING's and APIEvent.SHUTDOWN's string values, the events the platform binds discovery and its teardown to. Firing the second aborts the
// shutdown signal and destroys the dispatcher.
const DID_FINISH_LAUNCHING = "didFinishLaunching";
const SHUTDOWN = "shutdown";

// The sentence the request log writes for a reached rate limit, which is also the reason a command it stopped gives.
const RATE_LIMIT = "Hydrawise API rate limit has been exceeded.";

// The reason a command whose reply could not be read gives.
const UNREADABLE = "The answer from Hydrawise could not be read.";

// The parameters every command below carries. Their content is immaterial to the outcome, which the reply alone decides.
const PARAMS = { action: "stop", controller_id: "500001", relay_id: "700001" };

describe("HydrawisePlatform command", () => {

  test("a reply whose message type is info confirms the command", async (t) => {

    const { emit, entries, platform } = buildPlatform();

    t.after(() => emit(SHUTDOWN));
    await using dispatcher = installMockDispatcher();
    programJsonReply(dispatcher.agent, "setzone.php", { message: "Running zone", message_type: "info" });

    assert.deepEqual(await platform.command({ params: PARAMS }), { status: "confirmed" }, "Hydrawise's info verdict confirms the command");
    assert.equal(entries.filter(line => line.level === "error").length, 0, "and a confirmed command logs nothing");
  });

  test("a refusal in the reply carries Hydrawise's own message, and a refusal with none says the command did not take", async (t) => {

    const { emit, entries, platform } = buildPlatform();

    t.after(() => emit(SHUTDOWN));
    await using dispatcher = installMockDispatcher();
    programStatusReply(dispatcher.agent, "setzone.php", 200, { message: "Zone is disabled. ", message_type: "error" });
    programStatusReply(dispatcher.agent, "setzone.php", 200, { message: "", message_type: "error" });

    assert.deepEqual(await platform.command({ params: PARAMS }), { reason: "Zone is disabled.", status: "refused" },
      "a refusal in the reply is the command's refusal, giving Hydrawise's message as its reason");
    assert.deepEqual(await platform.command({ params: PARAMS }), { reason: "Hydrawise did not accept the command.", status: "refused" },
      "a refusal carrying no message still names what happened");
    assert.equal(entries.filter(line => line.level === "error").length, 0, "the request itself succeeded, so the request log says nothing");
  });

  test("a reply that does not parse, or carries no verdict, is unreadable", async (t) => {

    const { emit, entries, platform } = buildPlatform();

    t.after(() => emit(SHUTDOWN));
    await using dispatcher = installMockDispatcher();
    programStatusReply(dispatcher.agent, "setzone.php", 200, "not json");
    programStatusReply(dispatcher.agent, "setzone.php", 200, { message: "Running zone" });
    programStatusReply(dispatcher.agent, "setzone.php", 200, { message: "Running zone", message_type: "warning" });

    for(const label of [ "a body that does not parse", "a body carrying no message type", "a message type no verdict is spelled with" ]) {

      // The replies answer in the order they were programmed, so the commands run one after another.
      // eslint-disable-next-line no-await-in-loop
      assert.deepEqual(await platform.command({ params: PARAMS }), { reason: UNREADABLE, status: "unreadable" }, label + " is unreadable");
    }

    assert.equal(entries.filter(line => line.level === "error").length, 0, "the caller says what an unreadable reply means, so the platform says nothing");
  });

  test("a reply that fails partway through its body for any reason but a deadline is unreadable", async (t) => {

    const { emit, entries, platform } = buildPlatform();

    t.after(() => emit(SHUTDOWN));
    await using dispatcher = installMockDispatcher({ bodyError: errnoError("The connection was reset.", "ECONNRESET") });
    programJsonReply(dispatcher.agent, "setzone.php", { message: "Running zone", message_type: "info" });

    assert.deepEqual(await platform.command({ params: PARAMS }), { reason: UNREADABLE, status: "unreadable" }, "a reply cut off mid-read is unreadable");
    assert.equal(entries.filter(line => line.level === "error").length, 0, "and the platform says nothing for it");
  });

  test("a deadline met while the reply is read is a timeout", async (t) => {

    const { clock, emit, entries, platform } = buildPlatform();
    const heldEnd = heldEndFor("setzone.php");

    t.after(() => emit(SHUTDOWN));

    // The reply's bytes arrive and its end is held, so the platform is still reading it when the row steps the clock across the request's deadline.
    await using dispatcher = installMockDispatcher({ heldEnd });
    programJsonReply(dispatcher.agent, "setzone.php", { message: "Running zone", message_type: "info" });

    const outcomes: HydrawiseCommandOutcome[] = [];
    const commanding = platform.command({ params: PARAMS });

    void commanding.then((outcome): void => {

      outcomes.push(outcome);
    });

    await heldEnd.reached;

    // The outcome is read through the turns that follow each step rather than awaited, so a deadline left off the platform's clock cannot answer in real time
    // inside the row's own timeout.
    clock.advance((HYDRAWISE_API_TIMEOUT * 1000) - 1);

    assert.equal(await Promise.race([ commanding.then(() => "answered"), settle().then(() => "pending") ]), "pending",
      "a millisecond short of the deadline the reply is still being read");

    clock.advance(1);
    await settleUntil(() => outcomes.length === 1, { description: "the command to answer once its deadline cut off the reply's read" });

    assert.deepEqual(outcomes, [{ status: "timeout" }], "a reply the deadline cut off mid-read timed out, so it may be resent");
    assert.equal(entries.filter(line => line.level === "error").length, 0, "and the request log, which counted the request as answered, says nothing");
  });

  test("a status the platform refuses is a refusal giving the sentence the request log wrote", async (t) => {

    const { emit, entries, platform } = buildPlatform();

    t.after(() => emit(SHUTDOWN));
    await using dispatcher = installMockDispatcher();
    programStatusReply(dispatcher.agent, "setzone.php", 404);
    programStatusReply(dispatcher.agent, "setzone.php", 403);

    assert.deepEqual(await platform.command({ params: PARAMS }), { reason: "Invalid API key. Please check your Hydrawise API key.", status: "refused" },
      "an invalid key refuses the command with the sentence the request log uses");
    assert.deepEqual(await platform.command({ params: PARAMS }),
      { reason: "The Hydrawise API answered a request with an unexpected status of 403 Forbidden.", status: "refused" },
      "and so does any other status outside the success range");
    assert.ok(loggedAt(entries, "error", "Invalid API key. Please check your Hydrawise API key."), "the request log reports the invalid key");
    assert.ok(loggedAt(entries, "error", "The Hydrawise API answered a request with an unexpected status of 403 Forbidden."), "and the unexpected status");
  });

  test("a reached rate limit and a transport fault are failures giving the platform's sentence", async (t) => {

    const { emit, entries, platform } = buildPlatform();

    t.after(() => emit(SHUTDOWN));
    await using dispatcher = installMockDispatcher();
    programStatusReply(dispatcher.agent, "setzone.php", 429);
    dispatcher.agent.get(HYDRAWISE_ORIGIN).intercept({ method: "GET", path: addressesEndpoint("setzone.php") })
      .replyWithError(new errors.ConnectTimeoutError());

    const unmarked = new TypeError("fetch failed");

    unmarked.cause = { code: "EPIPE", message: "broken pipe" };
    dispatcher.agent.get(HYDRAWISE_ORIGIN).intercept({ method: "GET", path: addressesEndpoint("setzone.php") }).replyWithError(unmarked);

    assert.deepEqual(await platform.command({ params: PARAMS }), { reason: RATE_LIMIT, status: "failed" }, "a reached rate limit fails the command, naming the limit");
    assert.deepEqual(await platform.command({ params: PARAMS }), { reason: "Connection timed out.", status: "failed" },
      "a transport fault fails it, naming the fault in the sentence the plugin keeps for it");
    assert.deepEqual(await platform.command({ params: PARAMS }), { reason: "The request to the Hydrawise API failed: fetch failed.", status: "failed" },
      "and a failure carrying no marker gives a sentence that ends in the error's own message");
    assert.equal(logCount(entries, "error", RATE_LIMIT), 1, "the request log reports the rate limit");
    assert.ok(loggedAt(entries, "error", "Connection timed out."), "and the transport fault");
  });

  test("a deadline is a timeout, which the request log reports", async (t) => {

    const { emit, entries, platform } = buildPlatform();

    t.after(() => emit(SHUTDOWN));
    await using dispatcher = installMockDispatcher();
    dispatcher.agent.get(HYDRAWISE_ORIGIN).intercept({ method: "GET", path: addressesEndpoint("setzone.php") })
      .replyWithError(new errors.HeadersTimeoutError());

    assert.deepEqual(await platform.command({ params: PARAMS }), { status: "timeout" }, "a command no answer reached in time timed out");
    assert.ok(loggedAt(entries, "error", "taking too long"), "and the request log says so");
  });

  test("a shutdown aborts the command quietly", async () => {

    const { entries, platform } = buildPlatform();

    await using dispatcher = installMockDispatcher();
    programJsonReply(dispatcher.agent, "setzone.php", { message: "", message_type: "info" });

    await platform.shutdown();

    assert.deepEqual(await platform.command({ params: PARAMS }), { status: "aborted" }, "a command sent after shutdown is aborted");
    assert.equal(entries.filter(line => line.level === "error").length, 0, "and orderly teardown logs nothing");
  });

  test("a repeated failure is demoted by the request log a command shares with every request", async (t) => {

    // Debug is on so the demoted replay reaches the capture, through the warn channel the platform's debug gate emits on.
    const { emit, entries, platform } = buildPlatform({ debug: true });

    t.after(() => emit(SHUTDOWN));
    await using dispatcher = installMockDispatcher();
    programStatusReply(dispatcher.agent, "setzone.php", 429);
    programStatusReply(dispatcher.agent, "setzone.php", 429);

    await platform.command({ params: PARAMS });
    await platform.command({ params: PARAMS });

    assert.equal(logCount(entries, "error", "rate limit"), 1, "the rate limit is reported at error once");
    assert.equal(logCount(entries, "warn", "rate limit"), 1, "and its repeat is replayed at debug");
  });

  test("a command withdrawn while it waits for admission takes no slot and reaches nothing", async (t) => {

    const { clock, emit, entries, platform } = buildPlatform();

    t.after(() => emit(SHUTDOWN));
    await using dispatcher = installMockDispatcher();

    const served = programCountedReply(dispatcher.agent, "setzone.php", { message: "", message_type: "info" });

    // Spend every slot the command ceiling grants, so the next command waits on it.
    for(let call = 0; call < HYDRAWISE_COMMAND_BUDGET_CALLS; call++) {

      // eslint-disable-next-line no-await-in-loop
      await platform.command({ params: PARAMS });
    }

    const accountBeforeWaiting = budgetsOf(platform).account.available;
    const withdrawal = new AbortController();
    const waiting = platform.command({ params: PARAMS, signal: withdrawal.signal });

    // A request the MockAgent serves lands within a turn of being sent, so the turns settled here let a command the ceiling failed to hold reach the wire, while a
    // held one is parked on the platform's clock until the window the ceiling's slots were spent in has passed.
    await settle(2);

    assert.equal(served(), HYDRAWISE_COMMAND_BUDGET_CALLS, "the command is waiting for the command ceiling rather than on the wire");
    assert.equal(clock.pending, 1, "its wait for a slot is the one entry on the platform's clock");
    assert.equal(clock.nextDeadline, HYDRAWISE_COMMAND_BUDGET_WINDOW * 1000, "and it lasts until the spent slots leave the ceiling's window");

    withdrawal.abort();

    assert.deepEqual(await waiting, { status: "aborted" }, "a withdrawn command answers aborted");
    assert.equal(served(), HYDRAWISE_COMMAND_BUDGET_CALLS, "it never reached the wire");
    assert.equal(budgetsOf(platform).account.available, accountBeforeWaiting, "nor the account ceiling behind the command ceiling it left");
    assert.equal(entries.filter(line => line.level === "error").length, 0, "and a withdrawal is no failure, so nothing is logged");
  });

  test("a withdrawal reaches nothing once the command has been admitted", async (t) => {

    const { emit, platform } = buildPlatform();

    t.after(() => emit(SHUTDOWN));
    await using dispatcher = installMockDispatcher();

    const withdrawal = new AbortController();

    // The reply is composed as the request reaches the MockAgent, so the withdrawal inside it lands while the admitted request is on the wire and before its answer.
    dispatcher.agent.get(HYDRAWISE_ORIGIN).intercept({ method: "GET", path: addressesEndpoint("setzone.php") })
      .reply(async (): Promise<{ data: object; statusCode: number }> => {

        withdrawal.abort();

        return { data: { message: "", message_type: "info" }, statusCode: 200 };
      });

    const admitted = platform.command({ params: PARAMS, signal: withdrawal.signal });

    assert.deepEqual(await admitted, { status: "confirmed" }, "a command already on the wire carries on to Hydrawise's answer");
    assert.equal(withdrawal.signal.aborted, true, "though the withdrawal landed while it was there");
  });
});

describe("HydrawisePlatform command through a controller", () => {

  /* Discover the synthetic controller on a real platform and poll it once, with every command the platform sends answered by a reached rate limit, so the
   * platform's request log and the controller's report write through the one capturing log, in the order they were written. Each row builds its own platform and
   * fails one command on it, because the request log demotes a reason it has already reported.
   */
  async function failingController({ built, dispatcher }: { built: BuildPlatformResult; dispatcher: MockDispatcherHandle }): Promise<{
    accessory: PlatformAccessory; controller: HydrawiseController; }> {

    programJsonReply(dispatcher.agent, "customerdetails.php", makeCustomerDetails());
    programJsonReply(dispatcher.agent, "statusschedule.php", normalSchedule());
    programStatusReply(dispatcher.agent, "setzone.php", 429);
    built.emit(DID_FINISH_LAUNCHING);

    // The first poll's walk builds the zone valves, and a tap made after it is one the controller answers for.
    await settleUntil(() => built.registered()[0]?.getServiceById(Service.Valve, "700001") !== undefined, { description: "the valve for zone 700001 to appear" });

    return { accessory: present(built.registered()[0], "the controller accessory"),
      controller: present(built.platform.configuredDevices[built.platform.hap.uuid.generate(syntheticController.controller_id.toString())], "the built controller") };
  }

  test("one failed zone command writes the platform's line, then the zone's naming it", async (t) => {

    const built = buildPlatform();

    t.after(() => built.emit(SHUTDOWN));
    await using dispatcher = installMockDispatcher();

    const { accessory, controller } = await failingController({ built, dispatcher });
    const valve = present(accessory.getServiceById(Service.Valve, "700001"), "the valve for zone 700001");

    await triggerSet(valve.getCharacteristic(Characteristic.Active), Characteristic.Active.INACTIVE);
    await controller.commandsIdle;

    assert.deepEqual(linesAt(built.entries, "error"), [ RATE_LIMIT, "Test Controller: Front Lawn North [Zone 1]: Unable to stop this zone. " + RATE_LIMIT ],
      "the request log's line, then the zone's, and nothing more");
  });

  test("one failed Suspend All writes the platform's line, then the switch's own", async (t) => {

    const built = buildPlatform({ options: ["Enable.Device.Suspend.All"] });

    t.after(() => built.emit(SHUTDOWN));
    await using dispatcher = installMockDispatcher();

    const { accessory, controller } = await failingController({ built, dispatcher });
    const suspend = present(accessory.getServiceById(Service.Switch, HydrawiseReservedNames.SWITCH_SUSPEND_ALL), "the suspend-all switch");

    await triggerSet(suspend.getCharacteristic(Characteristic.On), true);
    await controller.commandsIdle;

    assert.deepEqual(linesAt(built.entries, "error"), [ RATE_LIMIT, "Test Controller: Unable to complete the suspend request." ],
      "the request log's line, then the switch's, and nothing more");
  });
});
