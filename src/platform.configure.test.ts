/* Copyright(C) 2017-2026, HJD (https://github.com/hjdhjd). All rights reserved.
 *
 * platform.configure.test.ts: Discovery and lifecycle behavior of the HydrawisePlatform, driven by firing the captured DID_FINISH_LAUNCHING handler to
 * run the private configureHydrawise against a MockAgent-backed wire. Covers the discovery happy path, the short-circuiting second pass and cached-accessory reuse,
 * orphan pruning, the bug-16 device gate in both directions, the no-API-key early return, the bug-2 debug routing, the MQTT construction arms, the discovery
 * retry failure paths and the report of a repeating one, the shutdown teardown and the retained offline each built controller states through the MQTT client's
 * end ahead of it, the refusal a restored accessory answers with until its controller vouches for it, and the retained offline the platform states for a
 * restored controller this run does not build.
 */

// The Hydrawise API wire shapes use snake_case keys such as controller_id, so camelcase is disabled here to let the controller fixture mirror the wire verbatim.
/* eslint-disable camelcase */
import { Characteristic, Service, TestMqttClient, buildPlatform, dispatcherOf, installMockDispatcher, programJsonReply, programStatusReply, seedAccessory,
  v2DispatcherOf } from "./testing/platform.helpers.ts";
import { HAPStatus, MQTT_DEFAULT_END_GRACE_MS, MqttClient, onAbort } from "homebridge-plugin-utils";
import type { Characteristic as HapCharacteristic, PlatformAccessory } from "homebridge";
import { HydrawiseReservedNames, suspendZoneSubtype, zoneAccessoryId } from "./types.ts";
import { describe, test } from "node:test";
import { formatLogEntry, hapStatus, logCount, loggedAt, present, settle, settleUntil, triggerGet, triggerSet, waitUntil } from "homebridge-plugin-utils/testing";
import { makeCustomerDetails, normalSchedule } from "./api.helpers.ts";
import { HYDRAWISE_API_RETRY_INTERVAL } from "./settings.ts";
import type { MqttConnectHandler } from "homebridge-plugin-utils";
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

// Stand HBPU's recording MQTT double where the platform's client goes, so a row reads the final words shutdown's end states and can refuse them. The platform is
// built with no broker URL, so no client of its own is displaced, and a controller discovery builds registers its word on the double. The double arms its end's
// grace on the platform's clock, as the platform's client does. The double's lifetime is the row's own, which shutdown's end or the row's `await using` binding
// ends.
function installMqttDouble(platform: Parameters<typeof seedAccessory>[0]): TestMqttClient {

  const mqtt = new TestMqttClient({ clock: platform.clock });

  (platform as unknown as { mqtt: TestMqttClient }).mqtt = mqtt;

  return mqtt;
}

// The synthetic controller's availability topic tail, composed as the controller composes the topic its word and its final offline go to.
const AVAILABILITY = syntheticController.serial_number + "/availability";

// Race a shutdown against two macrotask turns, the one the end's write-flush yield costs and one more, answering which came first, so a row tells a teardown that
// ran at once from one waiting out the grace.
async function shutdownWithinATurn(platform: Parameters<typeof seedAccessory>[0]): Promise<boolean> {

  return Promise.race([ platform.shutdown().then(() => true), settle(2).then(() => false) ]);
}

describe("HydrawisePlatform configure", () => {

  test("discovers controllers, trims their names, and registers accessories", async (t) => {

    const { emit, entries, registered } = buildPlatform();

    t.after(() => emit(SHUTDOWN));
    await using dispatcher = installMockDispatcher();
    programJsonReply(dispatcher.agent, "customerdetails.php", untrimmedCustomerDetails());
    programJsonReply(dispatcher.agent, "statusschedule.php", normalSchedule());

    emit(DID_FINISH_LAUNCHING);
    await waitUntil(() => registered().length >= 1, { description: "the first accessory registration" });

    assert.equal(registered().length, 1, "the single discovered controller should be registered once");
    assert.equal(registered()[0]?.displayName, "Test Controller", "the controller name should be trimmed of surrounding whitespace");
    assert.ok(loggedAt(entries, "info", "Discovered irrigation controller"), "discovery should log the controller it found");
  });

  test("registers a fresh accessory under the user's configured name", async (t) => {

    /* Discovery mints the accessory's display name, so it is the only cadence that can establish it - a synchronization opt-out means the runtime never renames
     * the accessory afterwards, and the configured name would otherwise be unreachable for the life of that accessory.
     *
     * The read presents the serial alone, which is the single-id rule every runtime reader of this option keeps.
     */
    const { emit, registered } = buildPlatform({ options: ["Enable.Device.Name.SN0A1B2C3D4=Garden Controller"] });

    t.after(() => emit(SHUTDOWN));
    await using dispatcher = installMockDispatcher();
    programJsonReply(dispatcher.agent, "customerdetails.php", makeCustomerDetails());
    programJsonReply(dispatcher.agent, "statusschedule.php", normalSchedule());

    emit(DID_FINISH_LAUNCHING);
    await waitUntil(() => registered().length >= 1, { description: "the first accessory registration" });

    assert.equal(registered()[0]?.displayName, "Garden Controller", "a fresh accessory carries the name the user configured rather than the wire's");
  });

  test("leaves a cached accessory's display name alone at discovery, whatever the Name option says", async (t) => {

    /* Discovery establishes a name, it never corrects one. A cached accessory comes back under the name it was flushed with, and bringing it into line is the
     * rename step's job on the poll cadence, under the synchronization gate the user controls.
     *
     * Synchronization is turned OFF here so that gate can never fire, which leaves discovery's own behavior as the only thing the assertions can be reading.
     * With it on, a poll landing mid-assertion could rename the accessory for an entirely legitimate reason and the assertion would be reading the clock.
     */
    const { emit, platform, registered } = buildPlatform({ options: [ "Enable.Device.Name.SN0A1B2C3D4=Garden Controller",
      "Disable.Device.SyncName.SN0A1B2C3D4" ] });

    t.after(() => emit(SHUTDOWN));
    await using dispatcher = installMockDispatcher();
    const cached = seedAccessory(platform, "Test Controller", platform.hap.uuid.generate("500001"));

    programJsonReply(dispatcher.agent, "customerdetails.php", makeCustomerDetails());
    programJsonReply(dispatcher.agent, "statusschedule.php", normalSchedule());

    emit(DID_FINISH_LAUNCHING);
    await waitUntil(() => cached.getService(Service.IrrigationSystem) !== undefined, { description: "the cached accessory's irrigation system to appear" });

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
    await waitUntil(() => logCount(entries, "info", "Successfully connected") >= 1, { description: "an info line containing \"Successfully connected\"" });

    emit(DID_FINISH_LAUNCHING);
    await waitUntil(() => logCount(entries, "info", "Successfully connected") >= 2, { description: "the second info line containing \"Successfully connected\"" });

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
    await waitUntil(() => updated().length >= 1, { description: "the first accessory cache update" });

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
    await waitUntil(() => unregistered().length >= 1, { description: "the first accessory unregistration" });

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
    await waitUntil(() => logCount(entries, "info", "Successfully connected") >= 1, { description: "an info line containing \"Successfully connected\"" });

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
    await waitUntil(() => unregistered().length >= 1, { description: "the first accessory unregistration" });

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
    await waitUntil(() => registered().length >= 1, { description: "the first accessory registration" });

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

  test("constructs an MQTT client for a valid broker URL", (t) => {

    const { emit, platform } = buildPlatform({ mqttUrl: "mqtt://127.0.0.1:1" });

    t.after(() => emit(SHUTDOWN));

    assert.notEqual(platform.mqtt, null, "a valid broker URL should construct an MQTT client");
  });

  test("degrades gracefully when the MQTT broker URL is invalid", (t) => {

    const { emit, entries, platform } = buildPlatform({ mqttUrl: "not-a-valid-url" });

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
    await waitUntil(() => loggedAt(entries, "error", "Invalid API key"), { description: "an error line containing \"Invalid API key\"" });

    assert.equal(registered().length, 0, "a failed discovery fetch should configure no controller while it retries");
  });

  test("propagates a discovery parse failure into the retry loop", async (t) => {

    const { emit, entries, registered } = buildPlatform();

    t.after(() => emit(SHUTDOWN));
    await using dispatcher = installMockDispatcher();
    programStatusReply(dispatcher.agent, "customerdetails.php", 200, "this is not valid json");

    emit(DID_FINISH_LAUNCHING);
    await waitUntil(() => loggedAt(entries, "error", "Unable to retrieve the list of controllers"),
      { description: "an error line containing \"Unable to retrieve the list of controllers\"" });

    assert.equal(registered().length, 0, "a discovery parse failure should configure no controller while it retries");
  });

  test("an unreadable controller list that repeats is reported once at error and once at debug, each as one sentence", async (t) => {

    // Debug is on so the demoted repeat reaches the capture, through the warn channel the platform's debug gate emits on.
    const { emit, entries } = buildPlatform({ debug: true });
    const failures = (): TestLogEntry[] => entries.filter(entry => formatLogEntry(entry).includes("Unable to retrieve the list of controllers"));

    t.after(() => emit(SHUTDOWN));
    await using dispatcher = installMockDispatcher();

    // Each status reply answers one request, in the order it was programmed.
    programStatusReply(dispatcher.agent, "customerdetails.php", 200, "this is not valid json");
    programStatusReply(dispatcher.agent, "customerdetails.php", 200, "this is not valid json");

    // Discovery waits out its retry on the production clock, which arms the global timers, so the mock replaces them before discovery starts and the row crosses
    // the retry interval in virtual time rather than waiting it out.
    t.mock.timers.enable({ apis: ["setTimeout"] });
    emit(DID_FINISH_LAUNCHING);
    await settleUntil(() => failures().length === 1, { description: "the first unreadable list's report" });

    t.mock.timers.tick(HYDRAWISE_API_RETRY_INTERVAL * 1000);
    await settleUntil(() => failures().length === 2, { description: "the repeat's report" });

    assert.deepEqual(failures().map(entry => entry.level), [ "error", "warn" ], "the first unreadable list is reported at error and its repeat at debug");
    assert.ok(failures().every(entry => !stripVTControlCharacters(formatLogEntry(entry)).includes("\n    at ")), "and neither report carries a stack frame");
  });

  test("aborts the shutdown signal when Homebridge shuts down", async () => {

    const { emit, platform, registered } = buildPlatform();

    await using dispatcher = installMockDispatcher();
    programJsonReply(dispatcher.agent, "customerdetails.php", makeCustomerDetails());
    programJsonReply(dispatcher.agent, "statusschedule.php", normalSchedule());

    emit(DID_FINISH_LAUNCHING);
    await waitUntil(() => registered().length >= 1, { description: "the first accessory registration" });

    assert.equal(platform.signal.aborted, false, "the platform signal is live before shutdown");
    assert.equal(dispatcherOf(platform)?.destroyed, false, "the dispatcher is live before shutdown");

    // This row fires Homebridge's own event rather than calling shutdown(), so it is the one that proves the registration, and it waits for the abort because
    // the handler awaits the MQTT client's end before the teardown.
    emit(SHUTDOWN);
    await waitUntil(() => platform.signal.aborted, { description: "the shutdown handler's abort" });

    assert.equal(platform.signal.aborted, true, "the shutdown handler aborts the platform signal");
    assert.equal(dispatcherOf(platform)?.destroyed, true, "the shutdown handler destroys the platform dispatcher");
  });

  test("shutdown aborts the signal before it destroys the dispatcher", async () => {

    const { emit, platform, registered } = buildPlatform();

    await using dispatcher = installMockDispatcher();
    programJsonReply(dispatcher.agent, "customerdetails.php", makeCustomerDetails());
    programJsonReply(dispatcher.agent, "statusschedule.php", normalSchedule());

    emit(DID_FINISH_LAUNCHING);
    await waitUntil(() => registered().length >= 1, { description: "the first accessory registration" });

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

    const { emit, platform } = buildPlatform();

    await using mqtt = installMqttDouble(platform);
    await using dispatcher = installMockDispatcher();
    programJsonReply(dispatcher.agent, "customerdetails.php", makeCustomerDetails());
    programJsonReply(dispatcher.agent, "statusschedule.php", normalSchedule());

    emit(DID_FINISH_LAUNCHING);

    // The controller states offline as it is built and online once its first poll lands, so the row waits for the online word: an offline recorded after it can
    // only be the final word shutdown's end states.
    await waitUntil(() => mqtt.publishedTo(AVAILABILITY).at(-1)?.payload === "online", { description: "the controller's first online word" });

    const before = mqtt.publishedTo(AVAILABILITY).length;

    /* Sample the topic AT ABORT TIME. The double is not bound to the platform's signal, so under a shutdown that aborted first a later word would still be
     * recorded and the end state could not tell it from one published before; the frame the abort runs in is the only place the order is observable. A recorded
     * word was also published while the client was connected, because the double refuses every publish while it is not.
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
    const { emit, entries, platform, registered } = buildPlatform({ debug: true });

    await using mqtt = installMqttDouble(platform);
    await using dispatcher = installMockDispatcher();
    programJsonReply(dispatcher.agent, "customerdetails.php", makeCustomerDetails());
    programJsonReply(dispatcher.agent, "statusschedule.php", normalSchedule());

    emit(DID_FINISH_LAUNCHING);
    await waitUntil(() => registered().length >= 1, { description: "the first accessory registration" });

    // The broker session is gone, so the word is refused at once, as the library's client refuses a publish it holds no session for.
    mqtt.connected = false;

    const refusedBefore = mqtt.rejectedPublishes;

    assert.equal(await shutdownWithinATurn(platform), true, "a refusal ends the wait at once rather than holding the teardown for the grace");
    assert.equal(platform.signal.aborted, true, "and the abort still runs");
    assert.ok(mqtt.rejectedPublishes > refusedBefore, "the offline word was refused rather than recorded");
    assert.ok(loggedAt(entries, "warn", AVAILABILITY + " offline at shutdown"),
      "the controller's handler notes the refusal at debug with its topic, since the plugin is stopping and the user has nothing to act on");
  });

  test("a word the broker never takes holds the teardown for the grace at most, and the abort still runs", async (t) => {

    // Debug is on so the abandoned word's debug line reaches the capture, through the warn channel the platform's debug gate emits on.
    const { emit, entries, platform } = buildPlatform({ debug: true });

    await using mqtt = installMqttDouble(platform);
    await using dispatcher = installMockDispatcher();
    programJsonReply(dispatcher.agent, "customerdetails.php", makeCustomerDetails());
    programJsonReply(dispatcher.agent, "statusschedule.php", normalSchedule());

    emit(DID_FINISH_LAUNCHING);
    await waitUntil(() => mqtt.publishedTo(AVAILABILITY).at(-1)?.payload === "online", { description: "the controller's first online word" });

    /* The end arms its default grace on the platform's clock, the system clock, which reads the global timers the mock replaces from here on, so the row crosses
     * the grace in virtual time rather than waiting it out. The hold is never released: it stands for a broker that never takes the write, so only the grace can
     * end the wait.
     */
    t.mock.timers.enable({ apis: ["setTimeout"] });
    mqtt.holdPublishes();

    const shutdown = platform.shutdown();

    t.mock.timers.tick(MQTT_DEFAULT_END_GRACE_MS - 1);
    await settle();

    assert.equal(platform.signal.aborted, false, "the teardown waits out the grace for a word still being written");

    t.mock.timers.tick(1);
    await shutdown;

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
    await waitUntil(() => platform.configuredDevices[platform.hap.uuid.generate(OWNER.controllerId.toString())]?.unavailable === false,
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
    await waitUntil(() => loggedAt(entries, "error", "Invalid API key"), { description: "an error line containing \"Invalid API key\"" });

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
    await waitUntil(() => platform.configuredDevices[platform.hap.uuid.generate(OWNER.controllerId.toString())]?.unavailable === false,
      { description: "the controller's first poll to land" });

    await assert.rejects(() => triggerGet(active(malformed)), noResponse, "an accessory nothing in this run vouches for refuses");
  });

  test("a restored controller this run does not build is stated offline, retained, on connect and after discovery, and a built one is not", async (t) => {

    // The client is the library's real one, pointed at a port nothing listens on, with its connect registration and its guarded publish recorded rather than run,
    // so the platform's own registration is what a session's arrival drives.
    const connects: MqttConnectHandler[] = [];
    const publishes: { init: unknown; payload: unknown; topic: string }[] = [];

    t.mock.method(MqttClient.prototype, "onConnect", (handler: MqttConnectHandler): void => {

      connects.push(handler);
    });

    t.mock.method(MqttClient.prototype, "publishGuarded", (topic: string, payload: unknown, init?: unknown): void => {

      publishes.push({ init, payload, topic });
    });

    const { emit, platform } = buildPlatform({ mqttUrl: "mqtt://127.0.0.1:1", options: ["Disable.Device." + DISABLED.serial_number] });

    t.after(() => emit(SHUTDOWN));
    await using dispatcher = installMockDispatcher();

    restoreController(platform);
    restoreController(platform, { controllerId: DISABLED.controller_id, name: DISABLED.name, serialNumber: DISABLED.serial_number });

    // The platform registered its statement at construction, before any controller existed, so it is the first registration recorded.
    const platformConnect = present(connects[0], "the platform's connect registration");

    // The statement the platform makes: retained offline, with no change gate, which is what tells it apart from a controller stating its own word.
    const statedOffline = (serial: string, since = 0): number => publishes.slice(since).filter(entry => (entry.topic === serial + "/availability") &&
      (entry.payload === "offline") && (JSON.stringify(entry.init) === JSON.stringify({ retain: true }))).length;

    await platformConnect();

    assert.equal(statedOffline(OWNER.serialNumber), 1, "before discovery the controller about to be built is not yet built, so it is stated offline");
    assert.equal(statedOffline(DISABLED.serial_number), 1, "and so is the disabled one");

    const beforeDiscovery = publishes.length;

    programJsonReply(dispatcher.agent, "customerdetails.php", makeCustomerDetails({ controllers: [ { ...syntheticController }, { ...DISABLED } ] }));
    programJsonReply(dispatcher.agent, "statusschedule.php", normalSchedule());

    emit(DID_FINISH_LAUNCHING);
    await waitUntil(() => statedOffline(DISABLED.serial_number, beforeDiscovery) >= 1, { description: "the end of discovery to state the disabled controller" });

    assert.equal(statedOffline(OWNER.serialNumber, beforeDiscovery), 0, "discovery states nothing for the controller it built");

    const afterDiscovery = publishes.length;

    await platformConnect();

    assert.equal(statedOffline(DISABLED.serial_number, afterDiscovery), 1, "a later session restates the disabled controller, its accessory long removed");
    assert.equal(statedOffline(OWNER.serialNumber, afterDiscovery), 0, "and leaves the built controller to state its own word");
  });

  test("shutdown states the controller it built offline and leaves a restored controller it did not build to the word already standing", async () => {

    const { emit, platform } = buildPlatform({ options: ["Disable.Device." + DISABLED.serial_number] });

    await using mqtt = installMqttDouble(platform);
    await using dispatcher = installMockDispatcher();

    restoreController(platform);
    restoreController(platform, { controllerId: DISABLED.controller_id, name: DISABLED.name, serialNumber: DISABLED.serial_number });

    programJsonReply(dispatcher.agent, "customerdetails.php", makeCustomerDetails({ controllers: [ { ...syntheticController }, { ...DISABLED } ] }));
    programJsonReply(dispatcher.agent, "statusschedule.php", normalSchedule());

    const unbuilt = DISABLED.serial_number + "/availability";

    // Discovery states the disabled controller offline once it has settled which controllers it builds, so that word is the one standing when shutdown begins.
    emit(DID_FINISH_LAUNCHING);
    await waitUntil(() => mqtt.publishedTo(unbuilt).length >= 1, { description: "the end of discovery to state the disabled controller" });
    await waitUntil(() => mqtt.publishedTo(AVAILABILITY).at(-1)?.payload === "online", { description: "the built controller's first online word" });

    const unbuiltBefore = mqtt.publishedTo(unbuilt).length;

    await platform.shutdown();

    assert.equal(mqtt.publishedTo(unbuilt).length, unbuiltBefore, "shutdown states nothing for the controller this run did not build");
    assert.equal(mqtt.publishedTo(AVAILABILITY).at(-1)?.payload, "offline", "while the controller it built is stated offline");
  });
});
