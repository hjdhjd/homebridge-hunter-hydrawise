/* Copyright(C) 2017-2026, HJD (https://github.com/hjdhjd). All rights reserved.
 *
 * platform.configure.test.ts: Discovery and lifecycle behavior of the HydrawisePlatform, driven by firing the captured DID_FINISH_LAUNCHING handler to
 * run the private configureHydrawise against a MockAgent-backed wire. Covers the discovery happy path, the controller word a fresh accessory is minted under where
 * HomeKit can carry nothing of its name, the short-circuiting second pass and cached-accessory reuse,
 * orphan pruning, the bug-16 device gate in both directions, the no-API-key early return, the bug-2 debug routing, the MQTT client the platform builds through its
 * factory with its own clock and signal, the discovery retry failure paths and the report of a repeating one on the platform's clock, the quiet unwind of a
 * shutdown met while the controller list is read, the shutdown teardown and the retained offline each built controller states through the MQTT client's end ahead
 * of it, the refusal a restored accessory answers with until its controller vouches for it, the retained offline the platform states for a restored controller
 * this run does not build, and the one startup line an option set globally or on one controller writes across a whole account.
 *
 * Every platform here runs on the TestClock the harness builds it on, and builds its MQTT client through HBPU's factory double, so a row steps every retry and
 * grace it crosses and reads the client the platform built from the factory's record of the call.
 */

// The Hydrawise API wire shapes use snake_case keys such as controller_id, so camelcase is disabled here to let the controller fixture mirror the wire verbatim.
/* eslint-disable camelcase */
import type { BuildPlatformResult, TestMqttClient } from "./testing/platform.helpers.ts";
import { Characteristic, Service, buildPlatform, dispatcherOf, heldEndFor, installMockDispatcher, installV2Client, makeTestV2Client, programCountedReply,
  programJsonReply, programStatusReply, seedAccessory, v2DispatcherOf } from "./testing/platform.helpers.ts";
import { HAPStatus, MQTT_DEFAULT_END_GRACE_MS, createMqttClient, onAbort } from "homebridge-plugin-utils";
import { HYDRAWISE_API_RETRY_INTERVAL, HYDRAWISE_API_TIMEOUT } from "./settings.ts";
import { HYDRAWISE_CONTROLLER_FALLBACK_NAME, HydrawiseReservedNames, suspendZoneSubtype, zoneAccessoryId } from "./types.ts";
import type { Characteristic as HapCharacteristic, PlatformAccessory } from "homebridge";
import { describe, test } from "node:test";
import { expectAt, formatLogEntry, hapStatus, linesAt, logCount, loggedAt, present, settle, settlePastMqttEnd, settleUntil, triggerGet,
  triggerSet } from "homebridge-plugin-utils/testing";
import { makeCustomerDetails, normalSchedule } from "./api.helpers.ts";
import type { TestContext } from "node:test";
import type { TestLogEntry } from "homebridge-plugin-utils/testing";
import assert from "node:assert/strict";
import { stripVTControlCharacters } from "node:util";
import { syntheticController } from "./api.fixtures.ts";

// The subtype the suspend-all switch carries on a controller accessory, as the controller composes it.
const SUSPEND_ALL_SUBTYPE: string = HydrawiseReservedNames.SWITCH_SUSPEND_ALL;

const DID_FINISH_LAUNCHING = "didFinishLaunching";
const SHUTDOWN = "shutdown";

// The refusal HomeKit renders as No Response: HAP's communication-failure status from a deliberate refusal, which the matcher tells apart from a handler that
// faulted into the same status.
const noResponse = hapStatus(HAPStatus.SERVICE_COMMUNICATION_FAILURE);

// The customer-details body carrying a single synthetic controller whose name has surrounding whitespace, so discovery's name trim is observable.
function untrimmedCustomerDetails(): ReturnType<typeof makeCustomerDetails> {

  return makeCustomerDetails({ controllers: [{ ...syntheticController, name: "  Test Controller  " }] });
}

// The broker a row configures so the platform builds an MQTT client. The harness's factory double answers it with a recording double, so nothing ever dials it.
const BROKER_URL = "mqtt://127.0.0.1:1";

// The MQTT client double the platform built through the harness's factory, read from the factory's record of the call, so a row reads the final words shutdown's
// end states, and can refuse them, on the client the platform built and every controller registered its word on. The double arms its end's grace on the clock
// and lives on the signal the platform handed the factory, as the platform's real client does.
function builtMqtt({ mqttFactory }: Pick<BuildPlatformResult, "mqttFactory">): TestMqttClient {

  return present(expectAt(mqttFactory.createCalls, 0, "the MQTT client the platform built").client, "the double the factory answered a configured broker with");
}

// The synthetic controller's availability topic tail, composed as the controller composes the topic its word and its final offline go to.
const AVAILABILITY = syntheticController.serial_number + "/availability";

// Race a shutdown against the turns an MQTT end that nothing holds takes to finish, as HBPU's double states them, answering whether shutdown finished within
// them, so a row tells a teardown that ran at once from one waiting out the grace.
async function shutdownWithinATurn(platform: Parameters<typeof seedAccessory>[0]): Promise<boolean> {

  return Promise.race([ platform.shutdown().then(() => true), settlePastMqttEnd().then(() => false) ]);
}

describe("HydrawisePlatform configure", () => {

  test("discovers controllers, trims their names, and registers accessories", async (t) => {

    const { emit, entries, registered } = buildPlatform();

    t.after(() => emit(SHUTDOWN));
    await using dispatcher = installMockDispatcher();
    programJsonReply(dispatcher.agent, "customerdetails.php", untrimmedCustomerDetails());
    programJsonReply(dispatcher.agent, "statusschedule.php", normalSchedule());

    emit(DID_FINISH_LAUNCHING);
    await settleUntil(() => registered().length >= 1, { description: "the first accessory registration" });

    assert.equal(registered().length, 1, "the single discovered controller should be registered once");
    assert.equal(registered()[0]?.displayName, "Test Controller", "the controller name should be trimmed of surrounding whitespace");
    assert.ok(loggedAt(entries, "info", "Discovered irrigation controller"), "discovery should log the controller it found");
  });

  test("registers a fresh accessory under the user's configured name", async (t) => {

    /* Discovery mints the accessory's display name, so a fresh accessory is born under the configured truth rather than renamed to it a poll later.
     *
     * The read presents the serial alone, which is the single-id rule every runtime reader of this option keeps.
     */
    const { emit, registered } = buildPlatform({ options: ["Enable.Device.Name.SN0A1B2C3D4=Garden Controller"] });

    t.after(() => emit(SHUTDOWN));
    await using dispatcher = installMockDispatcher();
    programJsonReply(dispatcher.agent, "customerdetails.php", makeCustomerDetails());
    programJsonReply(dispatcher.agent, "statusschedule.php", normalSchedule());

    emit(DID_FINISH_LAUNCHING);
    await settleUntil(() => registered().length >= 1, { description: "the first accessory registration" });

    assert.equal(registered()[0]?.displayName, "Garden Controller", "a fresh accessory carries the name the user configured rather than the wire's");
  });

  test("a fresh controller accessory's information service carries its name as the ConfiguredName a Home app rename writes once its controller is set up", async (t) => {

    /* HAP gives a new accessory's information service its Name alone, which the Home app cannot write, and the platform mints the accessory under its display
     * name alone, so the ConfiguredName is the one the controller's setup adds at construction, which discovery runs straight after the mint. Neither a Name nor
     * synchronization is set here, so no pass writes the controller's names, and the characteristic the row reads can only be the setup's.
     */
    const { emit, registered } = buildPlatform();

    t.after(() => emit(SHUTDOWN));
    await using dispatcher = installMockDispatcher();
    programJsonReply(dispatcher.agent, "customerdetails.php", makeCustomerDetails());
    programJsonReply(dispatcher.agent, "statusschedule.php", normalSchedule());

    emit(DID_FINISH_LAUNCHING);
    await settleUntil(() => registered().length >= 1, { description: "the first accessory registration" });

    const information = present(registered()[0]?.getService(Service.AccessoryInformation), "the fresh accessory's information service");

    assert.equal(information.testCharacteristic(Characteristic.ConfiguredName), true, "the set-up information service carries a ConfiguredName");
    assert.equal(information.getCharacteristic(Characteristic.ConfiguredName).value, registered()[0]?.displayName, "and it carries the accessory's name");
  });

  test("mints a controller whose name HomeKit cannot carry under the controller word, and goes on to configure every controller after it", async (t) => {

    /* HomeKit refuses an accessory minted under a name its rules empty, and discovery configures the account's controllers in turn, so the mint composes the
     * name through the controller composer: the controller Hydrawise names in emoji alone is minted under the word, and the controller listed after it is
     * configured too, with nothing ending discovery early.
     */
    const second = { ...syntheticController, controller_id: 500002, name: "Second Controller", serial_number: "SN9Z8Y7X6W5" };
    const { emit, entries, registered } = buildPlatform();

    t.after(() => emit(SHUTDOWN));
    await using dispatcher = installMockDispatcher();
    programJsonReply(dispatcher.agent, "customerdetails.php", makeCustomerDetails({ controllers: [ { ...syntheticController, name: "\u{1F331}\u{1F4A7}" },
      second ] }));
    programJsonReply(dispatcher.agent, "statusschedule.php", normalSchedule());

    emit(DID_FINISH_LAUNCHING);
    await settleUntil(() => registered().length >= 2, { description: "both controllers' accessory registrations" });

    assert.deepEqual(registered().map((accessory) => accessory.displayName), [ HYDRAWISE_CONTROLLER_FALLBACK_NAME, "Second Controller" ],
      "the controller HomeKit can carry no name for is minted under the word, and the next is minted under its own");
    assert.equal(logCount(entries, "info", "Configuring irrigation controller"), 2, "discovery configures both");
    assert.equal(logCount(entries, "error", "stopped unexpectedly"), 0, "and nothing ends it early");
  });

  test("leaves a cached accessory's display name alone at discovery, whatever the Name option says", async (t) => {

    /* Discovery establishes a name, it never corrects one. A cached accessory comes back under the name it was saved with, and bringing it into line is the
     * rename step's job on the poll cadence, which holds a set Name whatever synchronization says.
     *
     * No status reply is programmed, so no poll lands and discovery's own behavior is the only thing the assertions can be reading. A poll landing mid-assertion
     * would rename the accessory for an entirely legitimate reason, and the assertion would be reading the clock.
     */
    const { emit, platform, registered } = buildPlatform({ options: [ "Enable.Device.Name.SN0A1B2C3D4=Garden Controller",
      "Disable.Device.SyncName.SN0A1B2C3D4" ] });

    t.after(() => emit(SHUTDOWN));
    await using dispatcher = installMockDispatcher();
    const cached = seedAccessory(platform, "Test Controller", platform.hap.uuid.generate("500001"));

    programJsonReply(dispatcher.agent, "customerdetails.php", makeCustomerDetails());

    emit(DID_FINISH_LAUNCHING);
    await settleUntil(() => cached.getService(Service.IrrigationSystem) !== undefined, { description: "the cached accessory's irrigation system to appear" });

    assert.equal(registered().length, 0, "the cached accessory is reused rather than registered anew");
    assert.equal(cached.displayName, "Test Controller", "and discovery does not rename it");
  });

  test("short-circuits a second discovery pass without re-registering the controller", async (t) => {

    const { emit, entries, registered } = buildPlatform();

    t.after(() => emit(SHUTDOWN));
    await using dispatcher = installMockDispatcher();
    programJsonReply(dispatcher.agent, "customerdetails.php", makeCustomerDetails());
    programJsonReply(dispatcher.agent, "statusschedule.php", normalSchedule());

    emit(DID_FINISH_LAUNCHING);
    await settleUntil(() => logCount(entries, "info", "Successfully connected") >= 1, { description: "an info line containing \"Successfully connected\"" });

    emit(DID_FINISH_LAUNCHING);
    await settleUntil(() => logCount(entries, "info", "Successfully connected") >= 2, { description: "the second info line containing \"Successfully connected\"" });

    assert.equal(registered().length, 1, "the short-circuiting second pass should not register the controller again");
  });

  test("reuses a cached accessory rather than registering a new one", async (t) => {

    const { emit, platform, registered, updated } = buildPlatform();

    t.after(() => emit(SHUTDOWN));
    await using dispatcher = installMockDispatcher();
    const cached = seedAccessory(platform, "Test Controller", platform.hap.uuid.generate("500001"));

    // No status reply is programmed, so the controller's first poll never lands and discovery's own save of the reused accessory is the only one it can take.
    programJsonReply(dispatcher.agent, "customerdetails.php", makeCustomerDetails());

    emit(DID_FINISH_LAUNCHING);
    await settleUntil(() => updated().length >= 1, { description: "the first accessory cache update" });

    assert.equal(registered().length, 0, "a cached accessory should be reused, not registered anew");
    assert.ok(cached.getService(Service.IrrigationSystem), "the reused accessory should be configured with an irrigation system service");
    assert.ok(updated()[0]?.includes(cached), "and discovery saves it with everything its construction changed");
  });

  test("prunes an orphaned accessory that no discovered controller claims", async (t) => {

    const { emit, entries, platform, unregistered } = buildPlatform();

    t.after(() => emit(SHUTDOWN));
    await using dispatcher = installMockDispatcher();
    seedAccessory(platform, "Orphan", platform.hap.uuid.generate("999999"));

    programJsonReply(dispatcher.agent, "customerdetails.php", makeCustomerDetails());
    programJsonReply(dispatcher.agent, "statusschedule.php", normalSchedule());

    emit(DID_FINISH_LAUNCHING);
    await settleUntil(() => unregistered().length >= 1, { description: "the first accessory unregistration" });

    assert.equal(unregistered()[0]?.UUID, platform.hap.uuid.generate("999999"), "the orphaned accessory should be unregistered");
    assert.ok(!loggedAt(entries, "error", "stopped unexpectedly"), "and the bridge accepted the unregistration, so discovery ran on past the sweep");
  });

  test("a Disable.Device option keyed on the serial excludes the controller (the bug 16 fix)", async (t) => {

    const { emit, entries, registered } = buildPlatform({ options: ["Disable.Device.SN0A1B2C3D4"] });

    t.after(() => emit(SHUTDOWN));
    await using dispatcher = installMockDispatcher();
    programJsonReply(dispatcher.agent, "customerdetails.php", makeCustomerDetails());

    emit(DID_FINISH_LAUNCHING);

    // Discovery fetches the controller list successfully (the success log fires) and then the serial-keyed device gate excludes the controller before any
    // accessory is registered.
    await settleUntil(() => logCount(entries, "info", "Successfully connected") >= 1, { description: "an info line containing \"Successfully connected\"" });

    assert.equal(registered().length, 0, "a serial-keyed device disable should exclude the controller");
  });

  test("a serial-keyed disable removes an already-cached accessory (the bug 16 fix)", async (t) => {

    const { emit, entries, platform, unregistered } = buildPlatform({ options: ["Disable.Device.SN0A1B2C3D4"] });

    t.after(() => emit(SHUTDOWN));
    await using dispatcher = installMockDispatcher();
    seedAccessory(platform, "Test Controller", platform.hap.uuid.generate("500001"));

    programJsonReply(dispatcher.agent, "customerdetails.php", makeCustomerDetails());

    emit(DID_FINISH_LAUNCHING);

    // The cached accessory matches the discovered controller's UUID, but the serial-keyed device gate excludes it, so configureController removes the cached
    // accessory rather than leaving it stranded.
    await settleUntil(() => unregistered().length >= 1, { description: "the first accessory unregistration" });

    assert.equal(unregistered()[0]?.UUID, platform.hap.uuid.generate("500001"), "the disabled controller's cached accessory should be unregistered");
    assert.ok(!loggedAt(entries, "error", "stopped unexpectedly"), "and the bridge accepted the unregistration, so discovery ran on past it");
  });

  test("a Disable.Device option keyed on the controller id does not exclude the controller (the bug 16 fix)", async (t) => {

    const { emit, registered } = buildPlatform({ options: ["Disable.Device.500001"] });

    t.after(() => emit(SHUTDOWN));
    await using dispatcher = installMockDispatcher();
    programJsonReply(dispatcher.agent, "customerdetails.php", makeCustomerDetails());
    programJsonReply(dispatcher.agent, "statusschedule.php", normalSchedule());

    emit(DID_FINISH_LAUNCHING);
    await settleUntil(() => registered().length >= 1, { description: "the first accessory registration" });

    assert.equal(registered().length, 1, "a controller-id-keyed disable does not match the serial-scoped gate, so the controller is still configured");
  });

  test("logs an error and configures nothing when no API key is set", (t) => {

    const { emit, entries, registered } = buildPlatform({ apiKey: "" });

    t.after(() => emit(SHUTDOWN));

    // With no API key the constructor returns before wiring the discovery event, so firing it is a no-op.
    emit(DID_FINISH_LAUNCHING);

    assert.equal(registered().length, 0, "no accessories should be configured without an API key");
    assert.ok(loggedAt(entries, "error", "no Hunter Hydrawise API key"), "the missing key should be reported");
  });

  test("debug output routes through log.warn when debug is enabled (the bug 2 fix)", (t) => {

    const { emit, entries } = buildPlatform({ debug: true });

    t.after(() => emit(SHUTDOWN));

    // The constructor wraps the Homebridge logger in the library's config-gated composition and immediately logs the debug banner; with the user's debug setting
    // on, the gate emits through warn, so the banner surfaces at warning level in the capture.
    assert.ok(loggedAt(entries, "warn", "Debug logging on. Expect a lot of data."), "an enabled debug gate routes debug output to warning level");
  });

  test("debug output is suppressed when debug is disabled", (t) => {

    const { emit, entries } = buildPlatform({ debug: false });

    t.after(() => emit(SHUTDOWN));

    assert.ok(!loggedAt(entries, "warn", "Debug logging on. Expect a lot of data."), "a disabled debug gate emits nothing");
  });

  test("constructs an MQTT client for a valid broker URL, handing its factory the platform's own clock and signal", (t) => {

    const { emit, mqttFactory, platform } = buildPlatform({ mqttUrl: BROKER_URL });

    t.after(() => emit(SHUTDOWN));

    /* The handoff is what this plugin owns: the broker settings it resolved, its logger, the clock every wait it schedules reads, and the lifetime signal its
     * shutdown aborts. What the factory then makes of them, the double's lifetime composing that signal among it, is HBPU's, and its own suite proves it.
     */
    const call = expectAt(mqttFactory.createCalls, 0, "the MQTT client the platform built");

    assert.equal(mqttFactory.createCalls.length, 1, "the platform builds one client");
    assert.notEqual(call.client, null, "a valid broker URL should construct an MQTT client");
    assert.equal(platform.mqtt, call.client, "and the platform holds the client its factory answered");
    assert.equal(call.config.brokerUrl, BROKER_URL, "the factory is handed the broker URL the platform resolved");
    assert.equal(call.config.topicPrefix, platform.config.mqttTopic, "and the topic prefix");
    assert.equal(call.config.log, platform.log, "and the platform's own logger");

    const init = present(call.init, "the init the platform handed its factory");

    assert.equal(init.clock, platform.clock, "the client's waits run on the platform's own clock");
    assert.equal(init.signal, platform.signal, "and its lifetime is the platform's own signal");
  });

  test("degrades gracefully when the MQTT broker URL is invalid", (t) => {

    // HBPU's own factory, because the degradation is its own: mqtt.js refuses the URL before any socket or timer exists, and the factory reports it through the
    // platform's logger and answers null.
    const { emit, entries, platform } = buildPlatform({ mqttFactory: createMqttClient, mqttUrl: "not-a-valid-url" });

    t.after(() => emit(SHUTDOWN));

    assert.equal(platform.mqtt, null, "an invalid broker URL should leave the MQTT client null");
    assert.ok(loggedAt(entries, "error", "Unable to initialize MQTT client"), "the invalid broker URL should be reported");
  });

  test("propagates a null discovery response into the retry loop without configuring a controller", async (t) => {

    const { emit, entries, registered } = buildPlatform();

    t.after(() => emit(SHUTDOWN));
    await using dispatcher = installMockDispatcher();
    programStatusReply(dispatcher.agent, "customerdetails.php", 404);

    emit(DID_FINISH_LAUNCHING);
    await settleUntil(() => loggedAt(entries, "error", "Invalid API key"), { description: "an error line containing \"Invalid API key\"" });

    assert.equal(registered().length, 0, "a failed discovery fetch should configure no controller while it retries");
  });

  test("propagates a discovery parse failure into the retry loop", async (t) => {

    const { emit, entries, registered } = buildPlatform();

    t.after(() => emit(SHUTDOWN));
    await using dispatcher = installMockDispatcher();
    programStatusReply(dispatcher.agent, "customerdetails.php", 200, "this is not valid json");

    emit(DID_FINISH_LAUNCHING);
    await settleUntil(() => loggedAt(entries, "error", "Unable to retrieve the list of controllers"),
      { description: "an error line containing \"Unable to retrieve the list of controllers\"" });

    assert.equal(registered().length, 0, "a discovery parse failure should configure no controller while it retries");
  });

  test("an unreadable controller list that repeats is reported once at error and once at debug, each as one sentence", async (t) => {

    // Debug is on so the demoted repeat reaches the capture, through the warn channel the platform's debug gate emits on.
    const { clock, emit, entries } = buildPlatform({ debug: true });
    const failures = (): TestLogEntry[] => entries.filter(entry => formatLogEntry(entry).includes("Unable to retrieve the list of controllers"));

    t.after(() => emit(SHUTDOWN));
    await using dispatcher = installMockDispatcher();

    // Each status reply answers one request, in the order it was programmed.
    programStatusReply(dispatcher.agent, "customerdetails.php", 200, "this is not valid json");
    programStatusReply(dispatcher.agent, "customerdetails.php", 200, "this is not valid json");

    // Discovery waits out its retry on the platform's own clock, the one the row built it on, so the row crosses the retry interval by stepping that clock, and a
    // platform that kept a clock of its own would leave the repeat unreached.
    emit(DID_FINISH_LAUNCHING);
    await settleUntil(() => failures().length === 1, { description: "the first unreadable list's report" });

    clock.advance((HYDRAWISE_API_RETRY_INTERVAL * 1000) - 1);
    await settle();

    assert.equal(failures().length, 1, "a millisecond short of the retry interval discovery has not fetched the list again");

    clock.advance(1);
    await settleUntil(() => failures().length === 2, { description: "the repeat's report" });

    assert.deepEqual(failures().map(entry => entry.level), [ "error", "warn" ], "the first unreadable list is reported at error and its repeat at debug");
    assert.ok(failures().every(entry => !stripVTControlCharacters(formatLogEntry(entry)).includes("\n    at ")), "and neither report carries a stack frame");
  });

  test("a shutdown met while the controller list is read unwinds discovery quietly", async () => {

    /* The platform runs on a clock nothing advances, so the list request's deadline stands for as long as the request's scope does, and it leaves the clock only
     * as that scope exits with the read settled. Its release after the shutdown is the witness that the read met the abort and discovery has answered it.
     */
    const { clock, emit, entries, platform } = buildPlatform();
    const heldEnd = heldEndFor("customerdetails.php");

    await using dispatcher = installMockDispatcher({ heldEnd });

    const served = programCountedReply(dispatcher.agent, "customerdetails.php", makeCustomerDetails());

    emit(DID_FINISH_LAUNCHING);
    await heldEnd.reached;

    assert.equal(clock.pending, 1, "the list's bytes have arrived and its end is held, so its read is pending");
    assert.equal(clock.nextDeadline, HYDRAWISE_API_TIMEOUT * 1000, "and the one entry on the clock is the request's own deadline");

    emit(SHUTDOWN);
    await settleUntil(() => clock.pending === 0, { description: "the list request's deadline to be released as its read settles" });

    assert.equal(platform.signal.aborted, true, "the shutdown aborted the read through the platform's signal");
    assert.equal(served(), 1, "discovery fetched the list once and retries nothing after the shutdown");
    assert.equal(entries.filter(entry => formatLogEntry(entry).includes("Unable to retrieve the list of controllers")).length, 0,
      "an aborted read is no failure, so discovery says nothing about it");
    assert.ok(!loggedAt(entries, "info", "Successfully connected"), "and the list it never finished reading was never adopted");
    assert.equal(entries.filter(entry => entry.level === "error").length, 0, "nothing reaches error");
  });

  test("aborts the shutdown signal when Homebridge shuts down", async () => {

    const { emit, platform, registered } = buildPlatform();

    await using dispatcher = installMockDispatcher();
    programJsonReply(dispatcher.agent, "customerdetails.php", makeCustomerDetails());
    programJsonReply(dispatcher.agent, "statusschedule.php", normalSchedule());

    emit(DID_FINISH_LAUNCHING);
    await settleUntil(() => registered().length >= 1, { description: "the first accessory registration" });

    assert.equal(platform.signal.aborted, false, "the platform signal is live before shutdown");
    assert.equal(dispatcherOf(platform)?.destroyed, false, "the dispatcher is live before shutdown");

    // This row fires Homebridge's own event rather than calling shutdown(), so it is the one that proves the registration, and it waits for the abort because
    // the handler awaits the MQTT client's end before the teardown.
    emit(SHUTDOWN);
    await settleUntil(() => platform.signal.aborted, { description: "the shutdown handler's abort" });

    assert.equal(platform.signal.aborted, true, "the shutdown handler aborts the platform signal");
    assert.equal(dispatcherOf(platform)?.destroyed, true, "the shutdown handler destroys the platform dispatcher");
  });

  test("shutdown aborts the signal before it destroys the dispatcher", async () => {

    const { emit, platform, registered } = buildPlatform();

    await using dispatcher = installMockDispatcher();
    programJsonReply(dispatcher.agent, "customerdetails.php", makeCustomerDetails());
    programJsonReply(dispatcher.agent, "statusschedule.php", normalSchedule());

    emit(DID_FINISH_LAUNCHING);
    await settleUntil(() => registered().length >= 1, { description: "the first accessory registration" });

    let destroyedAtAbort: boolean | undefined;

    /* Sample the dispatcher AT ABORT TIME. Abort listeners run synchronously inside abort(), so this captures the world between the teardown steps, which is
     * the only place their order is observable: the end state after shutdown is the same either way, and converging flags cannot tell a correct registration from
     * an inverted one.
     */
    onAbort(platform.signal, () => {

      destroyedAtAbort = dispatcherOf(platform)?.destroyed;
    });

    await platform.shutdown();

    assert.equal(destroyedAtAbort, false, "the abort runs first, while the dispatcher is still live");
    assert.equal(dispatcherOf(platform)?.destroyed, true, "the dispatcher is destroyed by the time the awaited shutdown handler resolves");
  });

  test("shutdown destroys the account-credentialed dispatcher too, and aborts before it", async (t) => {

    /* The account-credentialed twin of the v1 dispatcher-teardown assertions above. Its own transport keeps its own keep-alive pool, so it owns a teardown
     * registration of its own, and without this assertion deleting that registration reds nothing: the pool simply outlives the plugin, holding a connection
     * nothing will ever use again.
     *
     * No wire traffic is needed. The client's pool is constructed with the platform and destroyed by the shutdown handler whether or not a request ever crossed it,
     * which is precisely the leak a missing defer would cause on an install that never spent a v2 call.
     */
    const { emit, platform } = buildPlatform({ options: [ "Enable.Account.Password=test-password", "Enable.Account.Username=test-user" ] });

    t.after(() => emit(SHUTDOWN));

    assert.equal(platform.hasV2Client, true, "the credentials build the client, so there is a second dispatcher to tear down");
    assert.equal(v2DispatcherOf(platform)?.destroyed, false, "the second dispatcher is live before shutdown");

    let destroyedAtAbort: boolean | undefined;

    // Sampled AT ABORT TIME for the reason the v1 ordering assertion states: the end state converges either way, so the frame between the teardown steps is the only
    // place the registration order is observable at all.
    onAbort(platform.signal, () => {

      destroyedAtAbort = v2DispatcherOf(platform)?.destroyed;
    });

    await platform.shutdown();

    assert.equal(destroyedAtAbort, false, "the abort runs first, while the second dispatcher is still live");
    assert.equal(v2DispatcherOf(platform)?.destroyed, true, "the shutdown handler destroys the account-credentialed dispatcher as well");
  });

  test("shutdown states each built controller offline, retained, and waits for the word to be written before it aborts the signal", async () => {

    const built = buildPlatform({ mqttUrl: BROKER_URL });
    const { emit, platform } = built;
    const mqtt = builtMqtt(built);

    await using dispatcher = installMockDispatcher();
    programJsonReply(dispatcher.agent, "customerdetails.php", makeCustomerDetails());
    programJsonReply(dispatcher.agent, "statusschedule.php", normalSchedule());

    emit(DID_FINISH_LAUNCHING);

    // The controller states offline as it is built and online once its first poll lands, so the row waits for the online word: an offline recorded after it can
    // only be the final word shutdown's end states.
    await settleUntil(() => mqtt.publishedTo(AVAILABILITY).at(-1)?.payload === "online", { description: "the controller's first online word" });

    const before = mqtt.publishedTo(AVAILABILITY).length;

    /* Sample the topic AT ABORT TIME, the frame the abort runs in, which is where the order between the word and the abort is observable: the end state reads the
     * same once both have happened, whichever came first. A recorded word was also published while the client was connected, because the double refuses every
     * publish while it is not.
     */
    let wordsAtAbort = mqtt.publishedTo(AVAILABILITY).slice(before);

    onAbort(platform.signal, () => {

      wordsAtAbort = mqtt.publishedTo(AVAILABILITY).slice(before);
    });

    // Hold the word in flight, where a real publish sits while mqtt.js puts it on the connection, so the row sees whether the teardown waits for the write.
    const release = mqtt.holdPublishes();
    const shutdown = platform.shutdown();

    await settle();

    assert.equal(platform.signal.aborted, false, "while the word is still being written, the teardown waits for it");
    assert.equal(mqtt.publishedTo(AVAILABILITY).length, before, "and the held word is not yet recorded");

    release();
    await shutdown;

    assert.equal(wordsAtAbort.length, 1, "one word reached the topic between the hold and the abort");

    const word = present(wordsAtAbort[0], "the word recorded before the abort");

    assert.equal(word.payload, "offline", "the word is offline");
    assert.equal(word.retain, true, "and retained, so a subscriber attaching after the plugin stops still reads it");
    assert.equal(platform.signal.aborted, true, "the teardown runs once the word is written");
  });

  test("a refused offline word holds nothing up: shutdown resolves at once and the abort still runs", async () => {

    // Debug is on so the refusal's debug line reaches the capture, through the warn channel the platform's debug gate emits on.
    const built = buildPlatform({ debug: true, mqttUrl: BROKER_URL });
    const { emit, entries, platform, registered } = built;
    const mqtt = builtMqtt(built);

    await using dispatcher = installMockDispatcher();
    programJsonReply(dispatcher.agent, "customerdetails.php", makeCustomerDetails());
    programJsonReply(dispatcher.agent, "statusschedule.php", normalSchedule());

    emit(DID_FINISH_LAUNCHING);
    await settleUntil(() => registered().length >= 1, { description: "the first accessory registration" });

    // The broker session is gone, so the word is refused at once, as the library's client refuses a publish it holds no session for.
    mqtt.connected = false;

    const refusedBefore = mqtt.rejectedPublishes;

    assert.equal(await shutdownWithinATurn(platform), true, "a refusal ends the wait at once rather than holding the teardown for the grace");
    assert.equal(platform.signal.aborted, true, "and the abort still runs");
    assert.ok(mqtt.rejectedPublishes > refusedBefore, "the offline word was refused rather than recorded");
    assert.ok(loggedAt(entries, "warn", AVAILABILITY + " offline at shutdown"),
      "the controller's handler notes the refusal at debug with its topic, since the plugin is stopping and the user has nothing to act on");
  });

  test("a word the broker never takes holds the teardown for the grace at most, and the abort still runs", async () => {

    // Debug is on so the abandoned word's debug line reaches the capture, through the warn channel the platform's debug gate emits on.
    const built = buildPlatform({ debug: true, mqttUrl: BROKER_URL });
    const { clock, emit, entries, platform } = built;
    const mqtt = builtMqtt(built);

    await using dispatcher = installMockDispatcher();
    programJsonReply(dispatcher.agent, "customerdetails.php", makeCustomerDetails());
    programJsonReply(dispatcher.agent, "statusschedule.php", normalSchedule());

    emit(DID_FINISH_LAUNCHING);
    await settleUntil(() => mqtt.publishedTo(AVAILABILITY).at(-1)?.payload === "online", { description: "the controller's first online word" });

    /* The end arms its default grace on the platform's clock, the one the factory handed the client, so the row crosses the grace by stepping that clock. The hold
     * is never released: it stands for a broker that never takes the write, so only the grace can end the wait. The teardown is read through the turns that
     * follow the step rather than awaited, so a grace left off the platform's clock cannot end it in real time inside the row's own timeout.
     */
    mqtt.holdPublishes();

    let tornDown = false;

    void platform.shutdown().then((): void => {

      tornDown = true;
    });

    clock.advance(MQTT_DEFAULT_END_GRACE_MS - 1);
    await settle();

    assert.equal(platform.signal.aborted, false, "the teardown waits out the grace for a word still being written");

    clock.advance(1);
    await settleUntil(() => tornDown, { description: "the grace to end the wait for the word and the teardown to run" });

    assert.equal(platform.signal.aborted, true, "the grace ends the wait, and the abort runs");
    assert.equal(mqtt.publishedTo(AVAILABILITY).at(-1)?.payload, "online", "the abandoned word was never recorded");
    assert.ok(loggedAt(entries, "warn", AVAILABILITY + " offline at shutdown: The operation was aborted due to timeout"),
      "the controller's handler notes the held word, rejected with the end's deadline as its reason");
  });

  test("with no MQTT client, shutdown states nothing and tears down at once", async () => {

    const { platform } = buildPlatform();

    assert.equal(platform.mqtt, null, "no broker URL is configured, so there is no client to state a word on");
    assert.equal(await shutdownWithinATurn(platform), true, "shutdown waits on no broker");
    assert.equal(platform.signal.aborted, true, "the abort runs");
    assert.equal(dispatcherOf(platform)?.destroyed, true, "and the dispatcher is destroyed after it");
  });
});

describe("HydrawisePlatform restore-time refusal and unconfigured availability", () => {

  // The synthetic controller's persisted identity, as a previous session wrote it into its accessory's context and into each zone accessory's owner stamp.
  const OWNER = { controllerId: syntheticController.controller_id, name: syntheticController.name, serialNumber: syntheticController.serial_number };

  // A second account controller the user has disabled, so discovery settles it without building it.
  const DISABLED = { ...syntheticController, controller_id: 500002, name: "Second Controller", serial_number: "SN9Z8Y7X6W5" };

  // Restore the controller accessory a previous session left: its irrigation system and one cached valve, under the identity it persisted.
  function restoreController(platform: Parameters<typeof seedAccessory>[0], identity = OWNER): PlatformAccessory {

    return seedAccessory(platform, identity.name, platform.hap.uuid.generate(identity.controllerId.toString()), (seed) => {

      seed.context = { controller: identity };
      seed.addService(new Service.IrrigationSystem(identity.name));
      seed.addService(new Service.Valve("Front Lawn North", "700001"));
      seed.addService(new Service.Switch(identity.name + " Suspend All Zones", SUSPEND_ALL_SUBTYPE));
    });
  }

  // Restore a standalone zone accessory a previous session left: its valve, its suspension switch, and the identity pair the platform stamped on it.
  function restoreZone(platform: Parameters<typeof seedAccessory>[0]): PlatformAccessory {

    return seedAccessory(platform, "Front Lawn South", platform.hap.uuid.generate(zoneAccessoryId(OWNER.controllerId, 700002)), (seed) => {

      seed.context = { ownerController: OWNER, zone: { name: "Front Lawn South", relay: 2, relayId: 700002 } };
      seed.addService(new Service.Valve("Front Lawn South", "700002"));
      seed.addService(new Service.Switch("Front Lawn South Suspend", suspendZoneSubtype(700002)));
    });
  }

  // One restored suspension switch's On characteristic, located by its subtype.
  function suspend(accessory: PlatformAccessory, subtype: string): HapCharacteristic {

    return present(accessory.getServiceById(Service.Switch, subtype), "the restored suspension switch").getCharacteristic(Characteristic.On);
  }

  // One restored service's Active characteristic, located by its subtype or as the accessory's bare irrigation system.
  function active(accessory: PlatformAccessory, subtype?: string): HapCharacteristic {

    const service = (subtype === undefined) ? accessory.getService(Service.IrrigationSystem) : accessory.getServiceById(Service.Valve, subtype);

    return present(service, "the restored service").getCharacteristic(Characteristic.Active);
  }

  test("a restored controller accessory and a restored zone accessory refuse every bound handler before discovery, reads and writes", async (t) => {

    const { emit, platform } = buildPlatform();

    t.after(() => emit(SHUTDOWN));

    const controller = restoreController(platform);
    const zone = restoreZone(platform);

    await assert.rejects(() => triggerGet(active(controller)), noResponse, "the irrigation system refuses a read");
    await assert.rejects(() => triggerSet(active(controller), Characteristic.Active.INACTIVE), noResponse, "and a write");
    await assert.rejects(() => triggerSet(active(controller, "700001"), Characteristic.Active.ACTIVE), noResponse, "a cached valve on it refuses a write");
    await assert.rejects(() => triggerGet(active(zone, "700002")), noResponse, "the zone accessory's valve refuses a read");
    await assert.rejects(() => triggerSet(active(zone, "700002"), Characteristic.Active.ACTIVE), noResponse, "and a write");
    await assert.rejects(() => triggerSet(suspend(controller, SUSPEND_ALL_SUBTYPE), true), noResponse, "the cached suspend-all switch refuses a write");
    await assert.rejects(() => triggerSet(suspend(zone, suspendZoneSubtype(700002)), true), noResponse, "and so does the cached per-zone switch");
  });

  test("once discovery claims a restored controller accessory, it answers with its controller's verdict", async (t) => {

    const { emit, platform } = buildPlatform();

    t.after(() => emit(SHUTDOWN));
    await using dispatcher = installMockDispatcher();

    const controller = restoreController(platform);

    programJsonReply(dispatcher.agent, "customerdetails.php", makeCustomerDetails());
    programJsonReply(dispatcher.agent, "statusschedule.php", normalSchedule());

    emit(DID_FINISH_LAUNCHING);
    await settleUntil(() => platform.configuredDevices[platform.hap.uuid.generate(OWNER.controllerId.toString())]?.unavailable === false,
      { description: "the controller's first poll to land" });

    assert.equal(await triggerGet(active(controller)), Characteristic.Active.ACTIVE, "the claimed accessory answers once its controller reaches Hydrawise");
  });

  test("a discovery that never answers, as with a revoked key, leaves every restored accessory refusing", async (t) => {

    const { emit, entries, platform } = buildPlatform();

    t.after(() => emit(SHUTDOWN));
    await using dispatcher = installMockDispatcher();

    const controller = restoreController(platform);
    const zone = restoreZone(platform);

    programStatusReply(dispatcher.agent, "customerdetails.php", 404);

    emit(DID_FINISH_LAUNCHING);
    await settleUntil(() => loggedAt(entries, "error", "Invalid API key"), { description: "an error line containing \"Invalid API key\"" });

    await assert.rejects(() => triggerGet(active(controller)), noResponse, "the controller accessory still refuses");
    await assert.rejects(() => triggerGet(active(zone, "700002")), noResponse, "and so does the zone accessory");
  });

  test("a restored accessory whose context names no controller refuses, even while the controller its UUID resembles is reachable", async (t) => {

    const { emit, platform } = buildPlatform();

    t.after(() => emit(SHUTDOWN));
    await using dispatcher = installMockDispatcher();

    // A zone-shaped UUID under the synthetic controller, carrying a controller field that is no identity at all, so the context classifies as no zone of anyone's.
    const malformed = seedAccessory(platform, "Malformed", platform.hap.uuid.generate(zoneAccessoryId(OWNER.controllerId, 700003)), (seed) => {

      seed.context = { controller: "not an identity" };
      seed.addService(new Service.IrrigationSystem("Malformed"));
    });

    programJsonReply(dispatcher.agent, "customerdetails.php", makeCustomerDetails());
    programJsonReply(dispatcher.agent, "statusschedule.php", normalSchedule());

    emit(DID_FINISH_LAUNCHING);
    await settleUntil(() => platform.configuredDevices[platform.hap.uuid.generate(OWNER.controllerId.toString())]?.unavailable === false,
      { description: "the controller's first poll to land" });

    await assert.rejects(() => triggerGet(active(malformed)), noResponse, "an accessory nothing in this run vouches for refuses");
  });

  test("a restored controller this run does not build is stated offline, retained, on connect and after discovery, and a built one is not", async (t) => {

    /* The client is the factory double the platform built, which held its session from the start, so the platform's connect registration has run on no session
     * yet. The row drives each session through the double's connection lever, whose false-to-true edge runs every connect registration, as a broker session's
     * arrival runs them on the platform's real client.
     */
    const built = buildPlatform({ mqttUrl: BROKER_URL, options: ["Disable.Device." + DISABLED.serial_number] });
    const { emit, platform } = built;
    const mqtt = builtMqtt(built);

    t.after(() => emit(SHUTDOWN));
    await using dispatcher = installMockDispatcher();

    restoreController(platform);
    restoreController(platform, { controllerId: DISABLED.controller_id, name: DISABLED.name, serialNumber: DISABLED.serial_number });

    // Every word recorded on one controller's availability topic, and the platform's statement among them: a retained offline.
    const words = (serial: string): string[] => mqtt.publishedTo(serial + "/availability").map(entry => entry.payload.toString());
    const statedOffline = (serial: string, since = 0): number => mqtt.publishedTo(serial + "/availability").slice(since)
      .filter(entry => (entry.payload === "offline") && entry.retain).length;
    const startSession = async (): Promise<void> => {

      mqtt.connected = false;
      mqtt.connected = true;
      await settle();
    };

    await startSession();

    assert.equal(statedOffline(OWNER.serialNumber), 1, "before discovery the controller about to be built is not yet built, so it is stated offline");
    assert.equal(statedOffline(DISABLED.serial_number), 1, "and so is the disabled one");

    const ownerBefore = words(OWNER.serialNumber).length;
    const disabledBefore = words(DISABLED.serial_number).length;

    programJsonReply(dispatcher.agent, "customerdetails.php", makeCustomerDetails({ controllers: [ { ...syntheticController }, { ...DISABLED } ] }));
    programJsonReply(dispatcher.agent, "statusschedule.php", normalSchedule());

    /* The end of discovery states the disabled controller again in the session already held. The double records a change-gated repeat only when its payload
     * differs, so a second identical offline recorded here is the witness that the platform's statement carries no change gate.
     */
    emit(DID_FINISH_LAUNCHING);
    await settleUntil(() => statedOffline(DISABLED.serial_number, disabledBefore) >= 1, { description: "the end of discovery to state the disabled controller" });
    await settleUntil(() => words(OWNER.serialNumber).at(-1) === "online", { description: "the built controller's first online word" });

    assert.deepEqual(words(OWNER.serialNumber).slice(ownerBefore), [ "offline", "online" ],
      "discovery states nothing for the controller it built: its topic carries the controller's own words alone, offline as it is built and online once it polls");

    const ownerAfter = words(OWNER.serialNumber).length;
    const disabledAfter = words(DISABLED.serial_number).length;

    await startSession();

    assert.equal(statedOffline(DISABLED.serial_number, disabledAfter), 1, "a later session restates the disabled controller, its accessory long removed");
    assert.equal(statedOffline(OWNER.serialNumber, ownerAfter), 0, "and leaves the built controller to state its own word");
  });

  test("shutdown states the controller it built offline and leaves a restored controller it did not build to the word already standing", async () => {

    const built = buildPlatform({ mqttUrl: BROKER_URL, options: ["Disable.Device." + DISABLED.serial_number] });
    const { emit, platform } = built;
    const mqtt = builtMqtt(built);

    await using dispatcher = installMockDispatcher();

    restoreController(platform);
    restoreController(platform, { controllerId: DISABLED.controller_id, name: DISABLED.name, serialNumber: DISABLED.serial_number });

    programJsonReply(dispatcher.agent, "customerdetails.php", makeCustomerDetails({ controllers: [ { ...syntheticController }, { ...DISABLED } ] }));
    programJsonReply(dispatcher.agent, "statusschedule.php", normalSchedule());

    const unbuilt = DISABLED.serial_number + "/availability";

    // Discovery states the disabled controller offline once it has settled which controllers it builds, so that word is the one standing when shutdown begins.
    emit(DID_FINISH_LAUNCHING);
    await settleUntil(() => mqtt.publishedTo(unbuilt).length >= 1, { description: "the end of discovery to state the disabled controller" });
    await settleUntil(() => mqtt.publishedTo(AVAILABILITY).at(-1)?.payload === "online", { description: "the built controller's first online word" });

    const unbuiltBefore = mqtt.publishedTo(unbuilt).length;

    await platform.shutdown();

    assert.equal(mqtt.publishedTo(unbuilt).length, unbuiltBefore, "shutdown states nothing for the controller this run did not build");
    assert.equal(mqtt.publishedTo(AVAILABILITY).at(-1)?.payload, "offline", "while the controller it built is stated offline");
  });
});

describe("HydrawisePlatform feature option startup lines", () => {

  // A second controller on the account, so a line written per controller and a line written once read differently.
  const SECOND_CONTROLLER = { ...syntheticController, controller_id: 500002, name: "Second Controller", serial_number: "SN9Z8Y7X6W5" };

  // Discover both controllers under the account login, which every option's line is open under, and answer the startup lines one label wrote, as a user reads them.
  async function startupLines(t: TestContext, label: string, option: string): Promise<string[]> {

    const { emit, entries, platform, registered } = buildPlatform({ options: [ "Enable.Account.Password=test-password", "Enable.Account.Username=test-user", option ] });

    t.after(() => emit(SHUTDOWN));
    await using dispatcher = installMockDispatcher();

    installV2Client(platform, makeTestV2Client({ status: "failed" }).client);
    programJsonReply(dispatcher.agent, "customerdetails.php", makeCustomerDetails({ controllers: [ { ...syntheticController }, { ...SECOND_CONTROLLER } ] }));
    programJsonReply(dispatcher.agent, "statusschedule.php", normalSchedule());

    emit(DID_FINISH_LAUNCHING);
    await settleUntil(() => registered().length === 2, { description: "both controllers' accessories to register" });

    return linesAt(entries, "info").filter(line => line.includes(label));
  }

  for(const [ label, option ] of [ [ "Name synchronization", "Device.SyncName" ], [ "Per-zone suspension switches", "Device.Suspend.Zone" ],
    [ "Suspend all zones switch", "Device.Suspend.All" ] ] as const) {

    test(option + " set globally writes one line through the plugin's logger however many controllers there are", async (t) => {

      assert.deepEqual(await startupLines(t, label, "Enable." + option), [label + " enabled."],
        "both controllers ask, and the plugin's logger writes the setting's one line, naming no controller");
    });

    test(option + " set on a controller writes one line through that controller's logger", async (t) => {

      assert.deepEqual(await startupLines(t, label, "Enable." + option + "." + SECOND_CONTROLLER.serial_number), [SECOND_CONTROLLER.name + ": " + label + " enabled."],
        "the line names the controller the setting was made on, and its sibling writes nothing");
    });
  }

  // The rain sensors default to on, so the setting a user makes is turning them off, and the default writes no line at all.
  test("Device.Sensor.Rain turned off globally writes one line through the plugin's logger however many controllers there are", async (t) => {

    assert.deepEqual(await startupLines(t, "Rain sensors", "Disable.Device.Sensor.Rain"), ["Rain sensors disabled."],
      "the plugin's logger writes the setting's one line, naming no controller");
  });

  test("Device.Sensor.Rain turned off on a controller writes one line through that controller's logger", async (t) => {

    assert.deepEqual(await startupLines(t, "Rain sensors", "Disable.Device.Sensor.Rain." + SECOND_CONTROLLER.serial_number),
      [SECOND_CONTROLLER.name + ": Rain sensors disabled."], "the line names the controller the setting was made on, and its sibling writes nothing");
  });
});
