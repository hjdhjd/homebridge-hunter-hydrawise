/* Copyright(C) 2017-2026, HJD (https://github.com/hjdhjd). All rights reserved.
 *
 * platform.configure.test.ts: Discovery and lifecycle behavior of the HydrawisePlatform, driven by firing the captured DID_FINISH_LAUNCHING handler to
 * run the private configureHydrawise against a MockAgent-backed wire. Covers the discovery happy path, the short-circuiting second pass and cached-accessory reuse,
 * orphan pruning, the bug-16 device gate in both directions, the no-API-key early return, the bug-2 debug routing, the MQTT construction arms, the discovery
 * retry failure paths, and the shutdown teardown.
 */
import { buildPlatform, countLogged, dispatcherOf, installMockDispatcher, loggedAt, programJsonReply, programStatusReply, seedAccessory, v2DispatcherOf, waitFor }
  from "./testing/platform.helpers.ts";
import { describe, test } from "node:test";
import { makeCustomerDetails, normalSchedule } from "./api.helpers.ts";
import { Service } from "./testing/hap.helpers.ts";
import assert from "node:assert/strict";
import { onAbort } from "homebridge-plugin-utils";
import { syntheticController } from "./api.fixtures.ts";

const DID_FINISH_LAUNCHING = "didFinishLaunching";
const SHUTDOWN = "shutdown";

// The customer-details body carrying a single synthetic controller whose name has surrounding whitespace, so discovery's name trim is observable.
function untrimmedCustomerDetails(): ReturnType<typeof makeCustomerDetails> {

  return makeCustomerDetails({ controllers: [{ ...syntheticController, name: "  Test Controller  " }] });
}

describe("HydrawisePlatform configure", () => {

  test("discovers controllers, trims their names, and registers accessories", async (t) => {

    const { emit, lines, registered } = buildPlatform();

    t.after(() => emit(SHUTDOWN));
    await using dispatcher = installMockDispatcher();
    programJsonReply(dispatcher.agent, "customerdetails.php", untrimmedCustomerDetails());
    programJsonReply(dispatcher.agent, "statusschedule.php", normalSchedule());

    emit(DID_FINISH_LAUNCHING);
    await waitFor(() => (registered.length >= 1) ? true : undefined);

    assert.equal(registered.length, 1, "the single discovered controller should be registered once");
    assert.equal(registered[0]?.displayName, "Test Controller", "the controller name should be trimmed of surrounding whitespace");
    assert.ok(loggedAt(lines(), "info", "Discovered irrigation controller"), "discovery should log the controller it found");
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
    await waitFor(() => (registered.length >= 1) ? true : undefined);

    assert.equal(registered[0]?.displayName, "Garden Controller", "a fresh accessory carries the name the user configured rather than the wire's");
  });

  test("leaves a cached accessory's display name alone at discovery, whatever the Name option says", async (t) => {

    /* Discovery establishes a name, it never corrects one. A cached accessory comes back under the name it was flushed with, and bringing it into line is the
     * rename step's job on the poll cadence, under the synchronization gate the user controls.
     *
     * Synchronization is turned OFF here so that gate can never fire, which leaves discovery's own behavior as the only thing the assertions can be reading.
     * With it on, a poll landing mid-assertion could rename the accessory for an entirely legitimate reason and the pin would be reading the clock.
     */
    const { emit, platform, registered } = buildPlatform({ options: [ "Enable.Device.Name.SN0A1B2C3D4=Garden Controller",
      "Disable.Device.SyncName.SN0A1B2C3D4" ] });

    t.after(() => emit(SHUTDOWN));
    await using dispatcher = installMockDispatcher();
    const cached = seedAccessory(platform, "Test Controller", "500001");

    programJsonReply(dispatcher.agent, "customerdetails.php", makeCustomerDetails());
    programJsonReply(dispatcher.agent, "statusschedule.php", normalSchedule());

    emit(DID_FINISH_LAUNCHING);
    await waitFor(() => (cached.getService(Service.IrrigationSystem) !== undefined) ? true : undefined);

    assert.equal(registered.length, 0, "the cached accessory is reused rather than registered anew");
    assert.equal(cached.displayName, "Test Controller", "and discovery does not rename it");
  });

  test("short-circuits a second discovery pass without re-registering the controller", async (t) => {

    const { emit, lines, registered } = buildPlatform();

    t.after(() => emit(SHUTDOWN));
    await using dispatcher = installMockDispatcher();
    programJsonReply(dispatcher.agent, "customerdetails.php", makeCustomerDetails());
    programJsonReply(dispatcher.agent, "statusschedule.php", normalSchedule());

    emit(DID_FINISH_LAUNCHING);
    await waitFor(() => (countLogged(lines(), "info", "Successfully connected") >= 1) ? true : undefined);

    emit(DID_FINISH_LAUNCHING);
    await waitFor(() => (countLogged(lines(), "info", "Successfully connected") >= 2) ? true : undefined);

    assert.equal(registered.length, 1, "the short-circuiting second pass should not register the controller again");
  });

  test("reuses a cached accessory rather than registering a new one", async (t) => {

    const { emit, platform, registered, updated } = buildPlatform();

    t.after(() => emit(SHUTDOWN));
    await using dispatcher = installMockDispatcher();
    const cached = seedAccessory(platform, "Test Controller", "500001");

    programJsonReply(dispatcher.agent, "customerdetails.php", makeCustomerDetails());
    programJsonReply(dispatcher.agent, "statusschedule.php", normalSchedule());

    emit(DID_FINISH_LAUNCHING);
    await waitFor(() => (updated.length >= 1) ? true : undefined);

    assert.equal(registered.length, 0, "a cached accessory should be reused, not registered anew");
    assert.ok(cached.getService(Service.IrrigationSystem), "the reused accessory should be configured with an irrigation system service");
  });

  test("prunes an orphaned accessory that no discovered controller claims", async (t) => {

    const { emit, platform, unregistered } = buildPlatform();

    t.after(() => emit(SHUTDOWN));
    await using dispatcher = installMockDispatcher();
    seedAccessory(platform, "Orphan", "999999");

    programJsonReply(dispatcher.agent, "customerdetails.php", makeCustomerDetails());
    programJsonReply(dispatcher.agent, "statusschedule.php", normalSchedule());

    emit(DID_FINISH_LAUNCHING);
    await waitFor(() => (unregistered.length >= 1) ? true : undefined);

    assert.equal(unregistered[0]?.UUID, "999999", "the orphaned accessory should be unregistered");
  });

  test("a Disable.Device option keyed on the serial excludes the controller (the bug 16 fix)", async (t) => {

    const { emit, lines, registered } = buildPlatform({ options: ["Disable.Device.SN0A1B2C3D4"] });

    t.after(() => emit(SHUTDOWN));
    await using dispatcher = installMockDispatcher();
    programJsonReply(dispatcher.agent, "customerdetails.php", makeCustomerDetails());

    emit(DID_FINISH_LAUNCHING);

    // Discovery fetches the controller list successfully (the success log fires) and then the serial-keyed device gate excludes the controller before any
    // accessory is registered.
    await waitFor(() => (countLogged(lines(), "info", "Successfully connected") >= 1) ? true : undefined);

    assert.equal(registered.length, 0, "a serial-keyed device disable should exclude the controller");
  });

  test("a serial-keyed disable removes an already-cached accessory (the bug 16 fix)", async (t) => {

    const { emit, platform, unregistered } = buildPlatform({ options: ["Disable.Device.SN0A1B2C3D4"] });

    t.after(() => emit(SHUTDOWN));
    await using dispatcher = installMockDispatcher();
    seedAccessory(platform, "Test Controller", "500001");

    programJsonReply(dispatcher.agent, "customerdetails.php", makeCustomerDetails());

    emit(DID_FINISH_LAUNCHING);

    // The cached accessory matches the discovered controller's UUID, but the serial-keyed device gate excludes it, so configureController removes the cached
    // accessory rather than leaving it stranded.
    await waitFor(() => (unregistered.length >= 1) ? true : undefined);

    assert.equal(unregistered[0]?.UUID, "500001", "the disabled controller's cached accessory should be unregistered");
  });

  test("a Disable.Device option keyed on the controller id does not exclude the controller (the bug 16 fix)", async (t) => {

    const { emit, registered } = buildPlatform({ options: ["Disable.Device.500001"] });

    t.after(() => emit(SHUTDOWN));
    await using dispatcher = installMockDispatcher();
    programJsonReply(dispatcher.agent, "customerdetails.php", makeCustomerDetails());
    programJsonReply(dispatcher.agent, "statusschedule.php", normalSchedule());

    emit(DID_FINISH_LAUNCHING);
    await waitFor(() => (registered.length >= 1) ? true : undefined);

    assert.equal(registered.length, 1, "a controller-id-keyed disable does not match the serial-scoped gate, so the controller is still configured");
  });

  test("logs an error and configures nothing when no API key is set", (t) => {

    const { emit, lines, registered } = buildPlatform({ apiKey: "" });

    t.after(() => emit(SHUTDOWN));

    // With no API key the constructor returns before wiring the discovery event, so firing it is a no-op.
    emit(DID_FINISH_LAUNCHING);

    assert.equal(registered.length, 0, "no accessories should be configured without an API key");
    assert.ok(loggedAt(lines(), "error", "no Hunter Hydrawise API key"), "the missing key should be reported");
  });

  test("debug output routes through log.warn when debug is enabled (the bug 2 fix)", (t) => {

    const { emit, lines } = buildPlatform({ debug: true });

    t.after(() => emit(SHUTDOWN));

    // The constructor wraps the Homebridge logger in the library's config-gated composition and immediately logs the debug banner; with the user's debug setting
    // on, the gate emits through warn, so the banner surfaces at warning level in the capture.
    assert.ok(loggedAt(lines(), "warn", "Debug logging on. Expect a lot of data."), "an enabled debug gate routes debug output to warning level");
  });

  test("debug output is suppressed when debug is disabled", (t) => {

    const { emit, lines } = buildPlatform({ debug: false });

    t.after(() => emit(SHUTDOWN));

    assert.ok(!loggedAt(lines(), "warn", "Debug logging on. Expect a lot of data."), "a disabled debug gate emits nothing");
  });

  test("constructs an MQTT client for a valid broker URL", (t) => {

    const { emit, platform } = buildPlatform({ mqttUrl: "mqtt://127.0.0.1:1" });

    t.after(() => emit(SHUTDOWN));

    assert.notEqual(platform.mqtt, null, "a valid broker URL should construct an MQTT client");
  });

  test("degrades gracefully when the MQTT broker URL is invalid", (t) => {

    const { emit, lines, platform } = buildPlatform({ mqttUrl: "not-a-valid-url" });

    t.after(() => emit(SHUTDOWN));

    assert.equal(platform.mqtt, null, "an invalid broker URL should leave the MQTT client null");
    assert.ok(loggedAt(lines(), "error", "Unable to initialize MQTT client"), "the invalid broker URL should be reported");
  });

  test("propagates a null discovery response into the retry loop without configuring a controller", async (t) => {

    const { emit, lines, registered } = buildPlatform();

    t.after(() => emit(SHUTDOWN));
    await using dispatcher = installMockDispatcher();
    programStatusReply(dispatcher.agent, "customerdetails.php", 404);

    emit(DID_FINISH_LAUNCHING);
    await waitFor(() => loggedAt(lines(), "error", "Invalid API key") ? true : undefined);

    assert.equal(registered.length, 0, "a failed discovery fetch should configure no controller while it retries");
  });

  test("propagates a discovery parse failure into the retry loop", async (t) => {

    const { emit, lines, registered } = buildPlatform();

    t.after(() => emit(SHUTDOWN));
    await using dispatcher = installMockDispatcher();
    programStatusReply(dispatcher.agent, "customerdetails.php", 200, "this is not valid json");

    emit(DID_FINISH_LAUNCHING);
    await waitFor(() => loggedAt(lines(), "error", "Unable to retrieve the list of controllers") ? true : undefined);

    assert.equal(registered.length, 0, "a discovery parse failure should configure no controller while it retries");
  });

  test("aborts the shutdown signal when Homebridge shuts down", async () => {

    const { emit, platform, registered } = buildPlatform();

    await using dispatcher = installMockDispatcher();
    programJsonReply(dispatcher.agent, "customerdetails.php", makeCustomerDetails());
    programJsonReply(dispatcher.agent, "statusschedule.php", normalSchedule());

    emit(DID_FINISH_LAUNCHING);
    await waitFor(() => (registered.length >= 1) ? true : undefined);

    assert.equal(platform.signal.aborted, false, "the platform signal is live before shutdown");
    assert.equal(dispatcherOf(platform)?.destroyed, false, "the dispatcher is live before shutdown");

    emit(SHUTDOWN);

    assert.equal(platform.signal.aborted, true, "the shutdown handler aborts the platform signal");
    assert.equal(dispatcherOf(platform)?.destroyed, true, "the shutdown handler destroys the platform dispatcher");
  });

  test("shutdown aborts the signal before it destroys the dispatcher", async () => {

    const { emit, platform, registered } = buildPlatform();

    await using dispatcher = installMockDispatcher();
    programJsonReply(dispatcher.agent, "customerdetails.php", makeCustomerDetails());
    programJsonReply(dispatcher.agent, "statusschedule.php", normalSchedule());

    emit(DID_FINISH_LAUNCHING);
    await waitFor(() => (registered.length >= 1) ? true : undefined);

    let destroyedAtAbort: boolean | undefined;

    /* Sample the dispatcher AT ABORT TIME. Abort listeners run synchronously inside abort(), so this captures the world between the two teardown steps, which is
     * the only place their order is observable: the end state after shutdown is the same either way, and converging flags cannot tell a correct registration from
     * an inverted one.
     */
    onAbort(platform.signal, () => {

      destroyedAtAbort = dispatcherOf(platform)?.destroyed;
    });

    emit(SHUTDOWN);

    assert.equal(destroyedAtAbort, false, "the abort runs first, while the dispatcher is still live");
    assert.equal(dispatcherOf(platform)?.destroyed, true, "the dispatcher is destroyed by the time the shutdown handler returns, in the same synchronous frame");
  });

  test("shutdown destroys the account-credentialed dispatcher too, and aborts before it", (t) => {

    /* The account-credentialed twin of the v1 dispatcher-teardown pins above. Its own transport keeps its own keep-alive pool, so it owns a teardown
     * registration of its own, and without this pin deleting that registration reds nothing: the pool simply outlives the plugin, holding a connection
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

    // Sampled AT ABORT TIME for the reason the v1 ordering pin states: the end state converges either way, so the frame between the two teardown steps is the only
    // place the registration order is observable at all.
    onAbort(platform.signal, () => {

      destroyedAtAbort = v2DispatcherOf(platform)?.destroyed;
    });

    emit(SHUTDOWN);

    assert.equal(destroyedAtAbort, false, "the abort runs first, while the second dispatcher is still live");
    assert.equal(v2DispatcherOf(platform)?.destroyed, true, "the shutdown handler destroys the account-credentialed dispatcher as well");
  });
});
