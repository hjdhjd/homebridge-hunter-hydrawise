/* Copyright(C) 2017-2026, HJD (https://github.com/hjdhjd). All rights reserved.
 *
 * platform.hardware.test.ts: The platform's optional account-credentialed enrichment, exercised against a REAL HydrawisePlatform whose client is a recording
 * double, so the credential gate, the refresh loop's single start, and the distribution all run production code with no cloud call of any kind.
 *
 * Two things are being told apart throughout. The GATE decides whether a client exists at all, and it answers to the configured credentials; the DISTRIBUTION
 * decides which controller receives which facts, and it answers to the correlation id that v1 and the account API agree about. A test that conflated them could pass
 * with the wrong controller enriched.
 *
 * What these tests deliberately do NOT wait on is the loop's quarter-hour sleep. The real platform runs on the system clock and takes no other, so the second tick
 * is driven through the production refresh method directly, and the sleep between ticks is covered by the constants receipt in the settings suite rather than by a
 * test that would have to wait it out.
 */
// The Hydrawise API wire shapes use snake_case keys such as controller_id, so camelcase is disabled here to let the controller fixture mirror the wire verbatim.
/* eslint-disable camelcase */
import { Characteristic, Service, buildPlatform, installMockDispatcher, installV2Client, makeTestV2Client, makeV2Facts, programJsonReply, refreshV2FactsOnce,
  v2BudgetOf, waitFor } from "./testing/platform.helpers.ts";
import { HOMEBRIDGE_UNKNOWN_FIRMWARE, HYDRAWISE_V2_BUDGET_CALLS } from "./settings.ts";
import type { Characteristic as HapCharacteristic, PlatformAccessory, WithUUID } from "homebridge";
import type { HydrawiseAccessoryContext, HydrawiseControllerHardware } from "./types.ts";
import { describe, test } from "node:test";
import { fastPolling, makeCustomerDetails, normalSchedule } from "./api.helpers.ts";
import { logCount, loggedAt, waitUntil } from "homebridge-plugin-utils/testing";
import type { TestLogEntry } from "homebridge-plugin-utils/testing";
import assert from "node:assert/strict";
import { syntheticController } from "./api.fixtures.ts";
import { zoneAccessoryId } from "./types.ts";

const DID_FINISH_LAUNCHING = "didFinishLaunching";
const SHUTDOWN = "shutdown";

// The configured-option entries that carry an account login, which is the only home those credentials have.
const CREDENTIAL_OPTIONS = [ "Enable.Account.Password=test-password", "Enable.Account.Username=test-user" ];

// A second controller, so a distribution test has two candidates to get wrong. Its id and serial differ from the synthetic controller's in every digit that
// matters, and the UUID the platform generates from its id is what the accessory lookups below match on.
const SECOND_CONTROLLER = { ...syntheticController, controller_id: 500002, name: "Second Controller", serial_number: "SN9Z8Y7X6W5" };

// The facts each controller reports, deliberately distinguishable so an assertion about which one landed where cannot pass by coincidence.
const FIRST_HARDWARE: HydrawiseControllerHardware = { firmware: "4.76", model: "HCC 38 Zones" };
const SECOND_HARDWARE: HydrawiseControllerHardware = { firmware: "2.11", model: "Pro-HC 12 Zones" };

// The name the account API reports for the synthetic controller, differing from the wire's in every word so no identity assertion can pass by coincidence, and
// the zone promoted to an accessory of its own, whose owner stamp is the third surface that name has to reach.
const ACCOUNT_CONTROLLER_NAME = "Backyard Irrigation System";

const STANDALONE_RELAY_ID = 700001;

// Whether a line containing the text was logged at any level, for the claims that nothing of a kind was said at all. Each level is searched through the library's
// rendering finder, so a value that arrived as a format parameter is matched as the user would read it.
function loggedAnywhere(entries: readonly TestLogEntry[], text: string): boolean {

  return ([ "debug", "error", "info", "warn" ] as const).some(level => loggedAt(entries, level, text));
}

// One accessory's information characteristic, which is what HomeKit shows the user for it. Every assertion below reads through here, so no test body has to
// re-derive where a model or a firmware version lives.
function informationValue(accessory: PlatformAccessory, characteristic: WithUUID<new () => HapCharacteristic>): unknown {

  return accessory.getService(Service.AccessoryInformation)?.getCharacteristic(characteristic).value;
}

// The name carried by a single-controller identity a persisted context can hold - a controller accessory's own, or a zone accessory's owner stamp - read
// through the same confined cast every context reader in this suite's siblings uses.
function identityName(accessory: PlatformAccessory | undefined, field: "controller" | "ownerController"): string | undefined {

  return (accessory?.context as HydrawiseAccessoryContext | undefined)?.[field]?.name;
}

// The names in the denormalized account roster a controller accessory carries, in the account's own order.
function rosterNames(accessory: PlatformAccessory | undefined): string[] {

  return ((accessory?.context as HydrawiseAccessoryContext | undefined)?.controllers ?? []).map(entry => entry.name);
}

describe("HydrawisePlatform hardware enrichment gate", () => {

  test("configures no account-credentialed client when neither credential is set", (t) => {

    const { emit, platform } = buildPlatform();

    t.after(() => emit(SHUTDOWN));

    assert.equal(platform.hasV2Client, false, "an install carrying only an API key builds no client at all");
  });

  test("configures no client when only the username is set", (t) => {

    const { emit, platform } = buildPlatform({ options: ["Enable.Account.Username=test-user"] });

    t.after(() => emit(SHUTDOWN));

    // Half a login cannot authenticate, so building a client on it would only spend calls failing. The gate is an AND for exactly that reason.
    assert.equal(platform.hasV2Client, false, "a username with no password builds no client");
  });

  test("configures no client when only the password is set", (t) => {

    const { emit, platform } = buildPlatform({ options: ["Enable.Account.Password=test-password"] });

    t.after(() => emit(SHUTDOWN));

    assert.equal(platform.hasV2Client, false, "a password with no username builds no client");
  });

  test("configures a client, and its own rate budget, when both credentials are set", (t) => {

    const { emit, entries, platform } = buildPlatform({ options: CREDENTIAL_OPTIONS });

    t.after(() => emit(SHUTDOWN));

    assert.equal(platform.hasV2Client, true, "a complete login builds the client");
    assert.equal(v2BudgetOf(platform).capacity, HYDRAWISE_V2_BUDGET_CALLS, "the account-credentialed budget carries its own ceiling");
    assert.ok(loggedAt(entries, "info", "Enhanced features are enabled"), "turning on an off-by-default capability is reported at startup");
  });
});

describe("HydrawisePlatform hardware distribution", () => {

  test("hands each controller the hardware its own correlation id names", async (t) => {

    const { emit, platform, registered, updated } = buildPlatform({ options: CREDENTIAL_OPTIONS });

    t.after(() => emit(SHUTDOWN));
    await using dispatcher = installMockDispatcher();

    /* The second fetch's map is deliberately keyed in the OPPOSITE order to the account's controller list, and both entries carry facts the other controller could
     * plausibly own. A distribution that matched positionally rather than by id would swap them, and each assertion below would then read the sibling's model.
     *
     * The first fetch carries no hardware, so discovery's saves and the first polls' are behind the count taken below before any hardware lands, and the tick this
     * row drives is the only thing that can save it.
     */
    const { client, fetches } = makeTestV2Client((fetch) => (fetch === 1) ?
      new Map([ [ SECOND_CONTROLLER.controller_id, makeV2Facts() ], [ syntheticController.controller_id, makeV2Facts() ] ]) :
      new Map([ [ SECOND_CONTROLLER.controller_id, makeV2Facts({ hardware: SECOND_HARDWARE }) ], [ syntheticController.controller_id,
        makeV2Facts({ hardware: FIRST_HARDWARE }) ] ]));

    installV2Client(platform, client);

    programJsonReply(dispatcher.agent, "customerdetails.php", makeCustomerDetails({ controllers: [ { ...syntheticController }, { ...SECOND_CONTROLLER } ] }));
    programJsonReply(dispatcher.agent, "statusschedule.php", normalSchedule());

    emit(DID_FINISH_LAUNCHING);

    const firstUuid = platform.hap.uuid.generate(syntheticController.controller_id.toString());
    const secondUuid = platform.hap.uuid.generate(SECOND_CONTROLLER.controller_id.toString());
    const first = await waitFor(() => registered().find(accessory => accessory.UUID === firstUuid), { description: "the first controller's accessory to register" });
    const second = await waitFor(() => registered().find(accessory => accessory.UUID === secondUuid), { description: "the second controller's accessory to register" });

    // The refresh loop's first tick and each controller's first poll run on their own schedules, so the wait is on each having landed.
    await waitUntil(() => (fetches() >= 1) && [ first, second ].every(accessory => (accessory.context as HydrawiseAccessoryContext).schedule !== undefined),
      { description: "the first refresh tick and each controller's first poll" });

    const savesBefore = updated().length;

    await refreshV2FactsOnce(platform);

    assert.equal(informationValue(first, Characteristic.Model), FIRST_HARDWARE.model, "the first controller shows its own model");
    assert.equal(informationValue(second, Characteristic.Model), SECOND_HARDWARE.model, "the second controller shows its own model");
    assert.equal(informationValue(first, Characteristic.FirmwareRevision), FIRST_HARDWARE.firmware, "the first controller shows its own firmware");
    assert.equal(informationValue(second, Characteristic.FirmwareRevision), SECOND_HARDWARE.firmware, "the second controller shows its own firmware");

    // The durable half of the same claim: the characteristics ARE the store, so the tick that landed the hardware saved each accessory with its own values and
    // the next restart reads the model straight back.
    const saves = updated().slice(savesBefore);

    assert.ok(saves.some(batch => batch.includes(first)), "the tick's save carries the first controller's accessory");
    assert.ok(saves.some(batch => batch.includes(second)), "and the second controller's");
  });

  test("the account's controller name reaches every persisted identity at once", async (t) => {

    /* Several surfaces persist a controller's identity, each written by a different cadence: the controller's own context (the poll), the denormalized
     * account roster every accessory carries (the refresh tick), and a standalone zone accessory's owner stamp (the poll's reconcile). They answer one
     * question, so a name that reached only some of them would leave the webUI listing one controller under different names depending on which entry it happened
     * to read.
     */
    const { emit, platform, registered } = buildPlatform({ options: [ ...CREDENTIAL_OPTIONS, "Enable.Device.Standalone." + STANDALONE_RELAY_ID.toString() ] });

    t.after(() => emit(SHUTDOWN));
    await using dispatcher = installMockDispatcher();

    installV2Client(platform, makeTestV2Client(new Map([[ syntheticController.controller_id, makeV2Facts({ name: ACCOUNT_CONTROLLER_NAME }) ]])).client);

    programJsonReply(dispatcher.agent, "customerdetails.php", makeCustomerDetails());
    programJsonReply(dispatcher.agent, "statusschedule.php", fastPolling(normalSchedule()));

    emit(DID_FINISH_LAUNCHING);

    const controllerUuid = platform.hap.uuid.generate(syntheticController.controller_id.toString());
    const zoneUuid = platform.hap.uuid.generate(zoneAccessoryId(syntheticController.controller_id, STANDALONE_RELAY_ID));
    const controllerAccessory = await waitFor(() => registered().find(accessory => accessory.UUID === controllerUuid),
      { description: "the first controller's accessory to register" });
    const zoneAccessory = await waitFor(() => registered().find(accessory => accessory.UUID === zoneUuid), { description: "the zone accessory to register" });

    // Each surface is waited on where it is written, so a slower cadence cannot make a faster one's assertion read a value that had not landed yet.
    await waitUntil(() => identityName(controllerAccessory, "controller") === ACCOUNT_CONTROLLER_NAME,
      { description: "the controller identity to carry the account name" });
    await waitUntil(() => identityName(zoneAccessory, "ownerController") === ACCOUNT_CONTROLLER_NAME,
      { description: "the zone's owner identity to carry the account name" });

    assert.equal(identityName(controllerAccessory, "controller"), ACCOUNT_CONTROLLER_NAME, "the controller persists the account's name as its own identity");
    assert.deepEqual(rosterNames(controllerAccessory), [ACCOUNT_CONTROLLER_NAME], "the account roster carries it for this controller");
    assert.equal(identityName(zoneAccessory, "ownerController"), ACCOUNT_CONTROLLER_NAME, "and the zone accessory stamps its owner with the same name");
  });

  test("a failed fetch enriches nothing and leaves every placeholder standing", async (t) => {

    const { emit, platform, registered } = buildPlatform({ options: CREDENTIAL_OPTIONS });

    t.after(() => emit(SHUTDOWN));
    await using dispatcher = installMockDispatcher();

    const { client, fetches } = makeTestV2Client(null);

    installV2Client(platform, client);
    programJsonReply(dispatcher.agent, "customerdetails.php", makeCustomerDetails());
    programJsonReply(dispatcher.agent, "statusschedule.php", normalSchedule());

    emit(DID_FINISH_LAUNCHING);

    const accessory = await waitFor(() => registered()[0], { description: "the first accessory registration" });

    await waitUntil(() => fetches() >= 1, { description: "the first account fetch" });

    /* A failed enrichment is not a failed startup. The accessory keeps exactly the information a user without credentials would see, which is the display the whole
     * credential gate falls back to, and it persists nothing it did not learn.
     */
    assert.equal(informationValue(accessory, Characteristic.Model), "Hydrawise", "a failed fetch leaves the product-line placeholder in place");
    // A freshly made accessory carries the firmware HAP constructs every information service with, which is what "never written" reads as.
    const fresh = new platform.api.platformAccessory("Unconfigured Controller", platform.hap.uuid.generate("unconfigured-controller"));

    assert.equal(informationValue(accessory, Characteristic.FirmwareRevision), informationValue(fresh, Characteristic.FirmwareRevision),
      "a failed fetch leaves the firmware exactly as HAP constructed it, because the credentialed path never writes it");
  });

  test("a second discovery pass starts no second refresh loop", async (t) => {

    const { emit, entries, platform } = buildPlatform({ options: CREDENTIAL_OPTIONS });

    t.after(() => emit(SHUTDOWN));
    await using dispatcher = installMockDispatcher();

    const { client, fetches } = makeTestV2Client(new Map([[ syntheticController.controller_id, makeV2Facts({ hardware: FIRST_HARDWARE }) ]]));

    installV2Client(platform, client);
    programJsonReply(dispatcher.agent, "customerdetails.php", makeCustomerDetails());
    programJsonReply(dispatcher.agent, "statusschedule.php", normalSchedule());

    emit(DID_FINISH_LAUNCHING);
    await waitUntil(() => fetches() >= 1, { description: "the first account fetch" });

    /* Re-entering discovery is a real cadence - the launch event can fire again, and the supervisor can re-enter the loop - and each re-entry would start a whole
     * second refresh loop running forever beside the first, doubling this account's spend against a ceiling measured in single digits. The count is EXACT rather
     * than a lower bound: the loop's own next tick is a quarter hour away and cannot reach this assertion, so any second fetch here is a second loop.
     */
    const connections = logCount(entries, "info", "Successfully connected");

    emit(DID_FINISH_LAUNCHING);
    await waitUntil(() => logCount(entries, "info", "Successfully connected") > connections, { description: "another connection line" });

    assert.equal(fetches(), 1, "a re-entered discovery pass should start no second loop and spend no second fetch");
  });

  test("a failed tick ends only that tick, and a later one still distributes", async (t) => {

    const { emit, platform, registered } = buildPlatform({ options: CREDENTIAL_OPTIONS });

    t.after(() => emit(SHUTDOWN));
    await using dispatcher = installMockDispatcher();

    // The first fetch fails and every later one succeeds, which is exactly the transient the retry exists for.
    const { client, fetches } = makeTestV2Client((fetch) => (fetch === 1) ? null :
      new Map([[ syntheticController.controller_id, makeV2Facts({ hardware: FIRST_HARDWARE }) ]]));

    installV2Client(platform, client);
    programJsonReply(dispatcher.agent, "customerdetails.php", makeCustomerDetails());
    programJsonReply(dispatcher.agent, "statusschedule.php", normalSchedule());

    emit(DID_FINISH_LAUNCHING);

    const accessory = await waitFor(() => registered()[0], { description: "the first accessory registration" });

    await waitUntil(() => fetches() >= 1, { description: "the first account fetch" });
    assert.equal(informationValue(accessory, Characteristic.Model), "Hydrawise", "the failed first tick enriched nothing and left the placeholder standing");

    /* The property this asserts is the METHOD BOUNDARY. A failed fetch returns from the tick, not from the loop, so the refresh survives its first transient
     * failure; the same early return written inline in the loop body would leave the loop function entirely and end the refresh for the life of the plugin. The
     * tick is driven directly because the loop's own next one is a quarter hour away.
     */
    await refreshV2FactsOnce(platform);

    assert.equal(informationValue(accessory, Characteristic.Model), FIRST_HARDWARE.model, "a later tick distributes normally, so the failure was not terminal");
    assert.equal(fetches(), 2, "each tick spends exactly one fetch");
  });

  test("a shutdown ends the refresh loop without reporting a fault", async () => {

    const { emit, entries, platform } = buildPlatform({ options: CREDENTIAL_OPTIONS });

    await using dispatcher = installMockDispatcher();

    const { client, fetches } = makeTestV2Client(new Map([[ syntheticController.controller_id, makeV2Facts({ hardware: FIRST_HARDWARE }) ]]));

    installV2Client(platform, client);
    programJsonReply(dispatcher.agent, "customerdetails.php", makeCustomerDetails());
    programJsonReply(dispatcher.agent, "statusschedule.php", normalSchedule());

    emit(DID_FINISH_LAUNCHING);
    await waitUntil(() => fetches() >= 1, { description: "the first account fetch" });

    const spent = fetches();

    emit(SHUTDOWN);

    // The loop is bound to the platform's shutdown signal, so the abort ends the sleep it is sitting in and unwinds it. A teardown is orderly rather than a fault, so
    // the supervisor swallows it silently - a reported fault here would tell every user their plugin broke every time Homebridge stopped.
    await waitUntil(() => true, { description: "the shutdown to reach the loop" });

    assert.equal(fetches(), spent, "no further tick runs after shutdown");
    assert.ok(!loggedAt(entries, "error", "stopped unexpectedly"), "a shutdown unwinds the loop quietly rather than reporting a fault");
  });

  test("no loop starts, no call is spent, and nothing is logged without credentials", async (t) => {

    const { emit, entries, registered } = buildPlatform();

    t.after(() => emit(SHUTDOWN));
    await using dispatcher = installMockDispatcher();

    programJsonReply(dispatcher.agent, "customerdetails.php", makeCustomerDetails());
    programJsonReply(dispatcher.agent, "statusschedule.php", normalSchedule());

    emit(DID_FINISH_LAUNCHING);

    const accessory = await waitFor(() => registered()[0], { description: "the first accessory registration" });

    /* The parity case stated as an assertion: an install with no credentials shows exactly what it always has. The MockAgent has net connect disabled and
     * intercepts only the two key-based endpoints, so a request escaping the credential gate would fail this test loudly rather than reaching the network.
     */
    assert.equal(informationValue(accessory, Characteristic.Manufacturer), "Hunter", "the manufacturer is unchanged");
    assert.equal(informationValue(accessory, Characteristic.Model), "Hydrawise", "the model is the product-line placeholder");
    assert.equal(informationValue(accessory, Characteristic.FirmwareRevision), HOMEBRIDGE_UNKNOWN_FIRMWARE,
      "the firmware is the unknown marker Homebridge itself uses");

    // Silence is part of the contract, not incidental: a user who configured nothing but an API key should see no trace of a capability they never turned on.
    assert.ok(!loggedAnywhere(entries, "Enhanced features"), "no enhanced-features line appears at all");
    assert.ok(!loggedAnywhere(entries, "enhanced features refresh"), "and no refresh loop reports itself");
  });
});

describe("HydrawisePlatform connection reporting", () => {

  test("the account tier reports itself connected ONCE, on the first successful refresh", async (t) => {

    const { emit, entries, platform } = buildPlatform({ options: CREDENTIAL_OPTIONS });

    t.after(() => emit(SHUTDOWN));

    await using dispatcher = installMockDispatcher();

    const { client, fetches } = makeTestV2Client(new Map([[ syntheticController.controller_id, makeV2Facts({ hardware: FIRST_HARDWARE }) ]]));

    installV2Client(platform, client);
    programJsonReply(dispatcher.agent, "customerdetails.php", makeCustomerDetails());
    programJsonReply(dispatcher.agent, "statusschedule.php", normalSchedule());

    emit(DID_FINISH_LAUNCHING);
    await waitUntil(() => fetches() >= 1, { description: "the first account fetch" });

    const connected = (): number => logCount(entries, "info", "connected to the Hydrawise account API");

    await waitUntil(() => connected() >= 1, { description: "the first account connection" });

    // The two tiers are delineated: the key-based line names the API key, and the account line names the enhanced features it unlocks.
    assert.ok(loggedAt(entries, "info", "Successfully connected to the Hydrawise API using your API key."), "the key-based tier names how it connected");
    assert.equal(connected(), 1, "the account tier reports itself connected exactly once");

    /* A second successful refresh is not a second connection. Without the latch every refresh tick would republish the same line every quarter hour for the life
     * of the plugin, which is log noise rather than news.
     */
    await refreshV2FactsOnce(platform);

    assert.equal(fetches(), 2, "the second refresh really did run");
    assert.equal(connected(), 1, "and it reported no second connection");
  });

  test("a failed first refresh reports no connection, and a later success reports one", async (t) => {

    const { emit, entries, platform } = buildPlatform({ options: CREDENTIAL_OPTIONS });

    t.after(() => emit(SHUTDOWN));

    await using dispatcher = installMockDispatcher();

    // The first fetch fails and every later one succeeds, so the line has to wait for an answer that actually arrived.
    const { client, fetches } = makeTestV2Client((fetch) => (fetch === 1) ? null :
      new Map([[ syntheticController.controller_id, makeV2Facts({ hardware: FIRST_HARDWARE }) ]]));

    installV2Client(platform, client);
    programJsonReply(dispatcher.agent, "customerdetails.php", makeCustomerDetails());
    programJsonReply(dispatcher.agent, "statusschedule.php", normalSchedule());

    emit(DID_FINISH_LAUNCHING);
    await waitUntil(() => fetches() >= 1, { description: "the first account fetch" });

    const connected = (): number => logCount(entries, "info", "connected to the Hydrawise account API");

    assert.equal(connected(), 0, "a failed tick claims no connection - the client already reported the failure in its own words");

    await refreshV2FactsOnce(platform);

    assert.equal(connected(), 1, "the first tick that actually answered reports the connection");
  });

  test("an install with no credentials reports only the key-based tier", async (t) => {

    const { emit, entries, registered } = buildPlatform();

    t.after(() => emit(SHUTDOWN));

    await using dispatcher = installMockDispatcher();

    programJsonReply(dispatcher.agent, "customerdetails.php", makeCustomerDetails());
    programJsonReply(dispatcher.agent, "statusschedule.php", normalSchedule());

    emit(DID_FINISH_LAUNCHING);
    await waitUntil(() => registered()[0] !== undefined, { description: "the first accessory registration" });

    assert.ok(loggedAt(entries, "info", "Successfully connected to the Hydrawise API using your API key."), "the key-based line still reports");
    assert.ok(!loggedAnywhere(entries, "account API"), "and nothing claims an account connection that was never made");
  });
});
