/* Copyright(C) 2017-2026, HJD (https://github.com/hjdhjd). All rights reserved.
 *
 * controller.hardware.test.ts: The controller's projection of optional hardware facts onto HomeKit's AccessoryInformation service. The design under test is
 * cache-resident: the characteristics are the only store these facts have, so every assertion here is a claim about what a characteristic READS after a construction or
 * an enrichment, never about a parallel copy.
 *
 * That makes the pre-seeded value the whole method. HAP round-trips characteristic values through Homebridge's accessory cache, so a warm restart begins with real
 * values already in place - a test models this by writing those values over the defaults HAP constructs each characteristic with. A test that started from an
 * untouched accessory could not tell "preserved the cached value" from "wrote nothing anywhere", which is exactly the distinction this design turns on. Homebridge
 * stamps its own firmware placeholder on every restore before the plugin sees the accessory, so the model carries over a restart and the firmware does not.
 */

// The Hydrawise API wire shapes use snake_case keys such as relay_id, so camelcase is disabled here to let the zone fixtures mirror the wire verbatim.
/* eslint-disable camelcase */
import { Characteristic, Service, buildController, makeV2Facts, restoreCached } from "./testing/platform.helpers.ts";
import type { CharacteristicValue, Characteristic as HapCharacteristic, PlatformAccessory, WithUUID } from "homebridge";
import { HAP_DEFAULT_MODEL, HOMEBRIDGE_UNKNOWN_FIRMWARE, HYDRAWISE_API_JITTER, HYDRAWISE_REVERT_DELAY, HYDRAWISE_V2_FACTS_TTL } from "./settings.ts";
import type { HydrawiseControllerHardware, StatusScheduleResponse } from "./types.ts";
import { TestClock, advanceThroughSchedule, hapStatus, logCount, present, triggerGet, triggerSet, waitUntil } from "homebridge-plugin-utils/testing";
import { controllerIdentity, suspendZoneSubtype, zoneAccessoryId } from "./types.ts";
import { describe, test } from "node:test";
import { fastPolling, makeStatusSchedule, makeZone } from "./api.helpers.ts";
import type { BuildControllerResult } from "./testing/platform.helpers.ts";
import { HAPStatus } from "homebridge-plugin-utils";
import assert from "node:assert/strict";
import { bareSensors } from "./api.fixtures.ts";

const CONTROLLER_SERIAL = "SN0A1B2C3D4";
const STANDALONE_RELAY_ID = 700001;
const STANDALONE_SUBTYPE = "700001";

// The option entry that promotes the zone onto an accessory of its own, and the one that gives each zone its suspension switch.
const STANDALONE_ON = "Enable.Device.Standalone." + STANDALONE_SUBTYPE;
const SUSPEND_ZONE_ON = "Enable.Device.Suspend.Zone." + CONTROLLER_SERIAL;

// The product-line name an unenriched controller displays.
const PLACEHOLDER_MODEL = "Hydrawise";

// The refusal HomeKit renders as No Response: HAP's communication-failure status from a deliberate refusal, which the matcher tells apart from a handler that
// faulted into the same status.
const noResponse = hapStatus(HAPStatus.SERVICE_COMMUNICATION_FAILURE);

// The facts a fetch reports, and the values a warm restart begins with. They are deliberately different from each other so an assertion can tell a preserved
// cached value from a freshly written one.
const FETCHED: HydrawiseControllerHardware = { firmware: "4.76", model: "HCC 38 Zones" };
const CACHED: HydrawiseControllerHardware = { firmware: "4.70", model: "HCC 24 Zones" };

// One accessory's information characteristic, which is what HomeKit shows the user for it.
function informationValue(accessory: PlatformAccessory, characteristic: WithUUID<new () => HapCharacteristic>): CharacteristicValue | null {

  return present(accessory.getService(Service.AccessoryInformation), "the information service HAP builds every accessory with").getCharacteristic(characteristic)
    .value;
}

// The instant a facts snapshot is stamped with. Tests that care only about adoption stamp it now, which is comfortably inside the freshness window every consumer
// gates on; the tests that care about that window stamp their own age instead.
function now(): number {

  return Math.floor(Date.now() / 1000);
}

// Seed an accessory the way HAP restores a cached one: real model and firmware values already sitting in the characteristics before anything configures it.
function seedCached(accessory: PlatformAccessory): void {

  const information = accessory.getService(Service.AccessoryInformation);

  information?.updateCharacteristic(Characteristic.Model, CACHED.model);
  information?.updateCharacteristic(Characteristic.FirmwareRevision, CACHED.firmware);
}

// A status body carrying one zone, at the fast cadence a live-loop test needs.
function schedule(): StatusScheduleResponse {

  return fastPolling(makeStatusSchedule({ relays: [makeZone({ name: "Front Lawn", relay: 1, relay_id: STANDALONE_RELAY_ID })], sensors: bareSensors }));
}

describe("HydrawiseController hardware display without credentials", () => {

  test("a fresh accessory shows the placeholder model and the unknown-firmware marker", () => {

    const { accessory } = buildController();

    assert.equal(informationValue(accessory, Characteristic.Model), PLACEHOLDER_MODEL, "the model is the product line");
    assert.equal(informationValue(accessory, Characteristic.FirmwareRevision), HOMEBRIDGE_UNKNOWN_FIRMWARE,
      "the firmware is the marker Homebridge itself uses for an unknown version");
  });

  test("removing the credentials resets values a credentialed session left behind", () => {

    /* The model is the assertion omitting the write would fail, and the seeded start is what gives it teeth. The characteristic outlives the credentials that
     * populated it, so a controller that simply skipped the write when it had no facts would leave a real model on display permanently, with nothing left in the
     * plugin that could ever refresh or correct it. The firmware reads Homebridge's restore placeholder, which Homebridge stamps on every cached accessory before
     * the plugin sees it, so the version a credentialed session left never reaches this one.
     */
    const { accessory } = buildController({ seedContext: seedCached });

    assert.equal(informationValue(accessory, Characteristic.Model), PLACEHOLDER_MODEL, "the model returns to the product-line placeholder");
    assert.equal(informationValue(accessory, Characteristic.FirmwareRevision), HOMEBRIDGE_UNKNOWN_FIRMWARE, "the firmware reads Homebridge's restore placeholder");
  });
});

describe("HydrawiseController hardware display with credentials", () => {

  test("a warm restart leaves cached real values untouched", () => {

    /* The refresh that will confirm these values is already on its way, so the synchronous path writes neither: blanking a correct display for the length of a
     * network round trip would be a visible regression for a user who has done nothing but restart Homebridge. Homebridge stamps its firmware placeholder on every
     * restore before the plugin sees the accessory, so a warm restart shows that placeholder until the first refresh lands, and only the model carries over.
     */
    const { accessory } = buildController({ hasV2Client: true, seedContext: seedCached });

    assert.equal(informationValue(accessory, Characteristic.Model), CACHED.model, "the cached model survives the restart");
    assert.equal(informationValue(accessory, Characteristic.FirmwareRevision), HOMEBRIDGE_UNKNOWN_FIRMWARE,
      "the firmware reads Homebridge's restore placeholder until the first refresh lands");
  });

  test("a brand-new accessory is stamped with the placeholder rather than showing HAP's default", () => {

    // The one case where nothing is being preserved, told apart by the only value that can mean "nothing has ever written here". Without this arm a user adding a
    // controller would see a library-internal string until the first fetch landed.
    const h = buildController({ hasV2Client: true });
    const { accessory } = h;

    assert.equal(informationValue(accessory, Characteristic.Model), PLACEHOLDER_MODEL, "a fresh accessory is stamped with the product line");

    /* The firmware is left exactly as HAP constructed it, which is the other half of this arm: stamping the model does not drag the firmware along with it. The
     * assertion reads the firmware a freshly made accessory carries, HAP's own default, rather than a literal, so what it means is "nothing wrote here" rather than
     * "here is a value".
     */
    const fresh = new h.platform.api.platformAccessory("Unconfigured Controller", h.platform.api.hap.uuid.generate("unconfigured-controller"));

    assert.equal(informationValue(accessory, Characteristic.FirmwareRevision), informationValue(fresh, Characteristic.FirmwareRevision),
      "the firmware is left untouched for the fetch to fill in");
  });

  test("the preserve arm is decided by HAP's default alone, not by the credentials", () => {

    // Stated as its own assertion because an implementation that keyed on something other than HAP's default could still pass the warm-restart and fresh-accessory
    // tests above it. A model that is neither HAP's default nor a real controller name - the placeholder a previous unenriched session wrote - is still a
    // value the plugin put there, so it is preserved.
    const { accessory } = buildController({ hasV2Client: true,
      seedContext: (seed) => { seed.getService(Service.AccessoryInformation)?.updateCharacteristic(Characteristic.Model, PLACEHOLDER_MODEL); } });

    assert.notEqual(PLACEHOLDER_MODEL, HAP_DEFAULT_MODEL, "the placeholder and HAP's default must differ for this assertion to mean anything");
    assert.equal(informationValue(accessory, Characteristic.Model), PLACEHOLDER_MODEL, "an already-stamped accessory is left alone");
  });

  test("the manufacturer and serial always write, whichever arm the model takes", () => {

    // The two identity characteristics are unconditional in every arm, so the credential gate cannot accidentally take them with it.
    const { accessory, controllerConfig } = buildController({ hasV2Client: true, seedContext: seedCached });

    assert.equal(informationValue(accessory, Characteristic.Manufacturer), "Hunter", "the manufacturer is written");
    assert.equal(informationValue(accessory, Characteristic.SerialNumber), controllerConfig.serial_number, "the serial number is written");
  });
});

describe("HydrawiseController facts adoption", () => {

  test("adopting hardware writes both characteristics and flushes exactly once", () => {

    const h = buildController({ hasV2Client: true });
    const before = h.flushes().length;

    h.controller.applyFacts({ facts: makeV2Facts({ hardware: FETCHED }), fetchedAt: now() });

    assert.equal(informationValue(h.accessory, Characteristic.Model), FETCHED.model, "the real model replaces the placeholder");
    assert.equal(informationValue(h.accessory, Characteristic.FirmwareRevision), FETCHED.firmware, "the real firmware replaces HAP's default");

    /* The flush count is the assertion, and it is exact in both directions. The characteristics are the only store these facts have, so zero flushes would lose them at
     * the next restart and spend a cloud call relearning something that never changes; more than one would be churn on a write that moved a single accessory.
     *
     * This is also the case that distinguishes a hardware comparison made against the PRIOR snapshot from one made after the new snapshot was stored. Nothing
     * else moved on this tick - no projection, no availability - so the only thing that can justify the write is hardware arriving against a null baseline, and a
     * comparison written after the overwrite would read the new value on both sides, find no difference, and flush zero times.
     */
    assert.equal(h.flushes().length - before, 1, "the first arrival carrying hardware flushes the accessory cache exactly once");
    assert.ok(h.flushes().at(-1)?.includes(h.accessory), "the save names the accessory that changed");
  });

  test("a tick that moves the hardware and the account roster saves the accessory once", () => {

    /* The hardware write and the recomposed roster's write land on one accessory in one tick, in the order the platform's refresh hands them over. Every mark
     * falls inside one save window, so the accessory cache is written once for the tick rather than once for each write.
     */
    const h = buildController({ hasV2Client: true });
    const before = h.flushes().length;

    h.controller.applyFacts({ facts: makeV2Facts({ hardware: FETCHED }), fetchedAt: now() });
    h.controller.applyRoster([ controllerIdentity(h.controllerConfig), { controllerId: 500002, name: "Second Controller", serialNumber: "SN9Z8Y7X6W5" } ]);

    assert.equal(h.flushes().length - before, 1, "the hardware and the roster share one cache write");
    assert.ok(h.flushes().at(-1)?.includes(h.accessory), "and that write carries the accessory the tick changed");
  });

  test("a tick that moves nothing flushes ZERO times", () => {

    /* The whole point of the change gate. On a recurring cadence an unconditional flush would write the accessory cache to disk every quarter hour for facts that
     * had not moved, for the life of the plugin.
     */
    const h = buildController({ hasV2Client: true });

    h.controller.applyFacts({ facts: makeV2Facts({ hardware: FETCHED }), fetchedAt: now() });

    const settled = h.flushes().length;

    h.controller.applyFacts({ facts: makeV2Facts({ hardware: FETCHED }), fetchedAt: now() + 1 });

    assert.equal(h.flushes().length - settled, 0, "an identical second answer is not worth a disk write");
  });

  test("hardware still writes unconditionally, with no compare-before-write of its own", () => {

    /* HAP sends HomeKit an event only for a value that changed, so a compare there would duplicate HAP's own work and add a second place for the plugin's answer
     * and HAP's to disagree. The change gate governs the durable FLUSH alone; the characteristic write itself stays unconditional, which is what this separates.
     */
    const h = buildController({ hasV2Client: true });
    const information = present(h.accessory.getService(Service.AccessoryInformation), "the information service");

    h.controller.applyFacts({ facts: makeV2Facts({ hardware: FETCHED }), fetchedAt: now() });

    // The window opens on an accessory that already holds exactly these values. HAP raises a change for every update, an unchanged value included, and the
    // accessory's change record holds each one, so whatever is recorded below is a write the plugin chose to perform against an unchanged fact.
    h.accessory.clearObservations();

    h.controller.applyFacts({ facts: makeV2Facts({ hardware: FETCHED }), fetchedAt: now() + 1 });

    assert.equal(h.accessory.changesOn(information, Characteristic.Model, Characteristic.FirmwareRevision).length, 2,
      "an identical second answer still reaches both characteristics rather than being gated in the plugin");
  });

  test("a changed firmware version is adopted and flushed", () => {

    // Hardware self-heals on every tick rather than being learned once, so a firmware upgrade the user performs in the Hydrawise app reaches HomeKit on its own.
    const h = buildController({ hasV2Client: true });

    h.controller.applyFacts({ facts: makeV2Facts({ hardware: FETCHED }), fetchedAt: now() });

    const settled = h.flushes().length;

    h.controller.applyFacts({ facts: makeV2Facts({ hardware: { firmware: "4.99", model: FETCHED.model } }), fetchedAt: now() + 1 });

    assert.equal(informationValue(h.accessory, Characteristic.FirmwareRevision), "4.99", "the upgraded firmware replaces the version already on display");
    assert.equal(h.flushes().length - settled, 1, "a genuine hardware change is worth exactly one write");
  });

  test("a tick carrying no hardware leaves the values a prior tick established", () => {

    // A controller whose hardware block comes back incomplete composes no hardware at all, and that absence must not blank a correct display.
    const h = buildController({ hasV2Client: true });

    h.controller.applyFacts({ facts: makeV2Facts({ hardware: FETCHED }), fetchedAt: now() });
    h.controller.applyFacts({ facts: makeV2Facts({ online: true }), fetchedAt: now() + 1 });

    assert.equal(informationValue(h.accessory, Characteristic.Model), FETCHED.model, "the established model stands");
    assert.equal(informationValue(h.accessory, Characteristic.FirmwareRevision), FETCHED.firmware, "and the established firmware with it");
  });

  test("adopted values survive into the next session untouched", () => {

    /* The end of the cache-resident story: what adoption wrote is what a restart reads back, and the credentialed synchronous path leaves it exactly as it found it.
     * The firmware is the exception Homebridge makes, stamping its placeholder on every restore before the plugin sees the accessory, so the next session shows
     * that placeholder until its first refresh lands.
     */
    const first = buildController({ hasV2Client: true });

    first.controller.applyFacts({ facts: makeV2Facts({ hardware: FETCHED }), fetchedAt: now() });

    const second = buildController({ hasV2Client: true, seedContext: (seed) => {

      const information = seed.getService(Service.AccessoryInformation);

      information?.updateCharacteristic(Characteristic.Model, informationValue(first.accessory, Characteristic.Model));
      information?.updateCharacteristic(Characteristic.FirmwareRevision, informationValue(first.accessory, Characteristic.FirmwareRevision));
    } });

    assert.equal(informationValue(second.accessory, Characteristic.Model), FETCHED.model, "the next session reads back the adopted model");
    assert.equal(informationValue(second.accessory, Characteristic.FirmwareRevision), HOMEBRIDGE_UNKNOWN_FIRMWARE,
      "and the firmware reads Homebridge's restore placeholder until the first refresh lands");
  });

  test("each controller's facts land on its own accessory", () => {

    /* The correlation claim at the receiving end. Two controllers are built with distinguishable facts and each is handed only its own, so an implementation that
     * distributed by position, or that let one controller's snapshot leak into another, shows up as the sibling's model here.
     */
    const first = buildController({ hasV2Client: true });
    const second = buildController({ controller: { controller_id: 500002, serial_number: "SN9Z8Y7X6W5" }, hasV2Client: true });

    first.controller.applyFacts({ facts: makeV2Facts({ hardware: FETCHED }), fetchedAt: now() });
    second.controller.applyFacts({ facts: makeV2Facts({ hardware: CACHED }), fetchedAt: now() });

    assert.equal(informationValue(first.accessory, Characteristic.Model), FETCHED.model, "the first controller shows its own model");
    assert.equal(informationValue(second.accessory, Characteristic.Model), CACHED.model, "and the second shows its own, not its sibling's");
  });
});

describe("HydrawiseController standalone zone hardware", () => {

  test("a standalone zone accessory carries no controller firmware, even on a credentialed install", async (t) => {

    /* The credentialed path is where this has to be checked. An install without credentials enriches nothing anywhere, so the same assertion there would pass
     * against an implementation that happily stamped a zone with its controller's firmware the moment credentials appeared.
     */
    const h = buildController({ hasV2Client: true, program: (recorder) => recorder.programDefault("statusschedule.php", { body: schedule(), kind: "response" }),
      signalAborted: false, userOptions: [STANDALONE_ON] });

    t.after(() => h.abort());

    h.controller.applyFacts({ facts: makeV2Facts({ hardware: FETCHED }), fetchedAt: now() });

    await waitUntil(() => h.zoneAccessories.get(STANDALONE_RELAY_ID)?.getServiceById(Service.Valve, STANDALONE_SUBTYPE) !== undefined,
      { description: "the standalone zone's valve on its own accessory to appear" });

    const zoneAccessory = h.zoneAccessories.get(STANDALONE_RELAY_ID);

    assert.ok(zoneAccessory, "the zone should have an accessory of its own");
    assert.equal(informationValue(h.accessory, Characteristic.FirmwareRevision), FETCHED.firmware,
      "the controller itself does show the firmware, so the zone assertion below is not passing because nothing was enriched at all");

    // Model and firmware describe the controller, not one valve hanging off it, so the zone accessory carries the unenriched pair.
    assert.equal(informationValue(zoneAccessory, Characteristic.FirmwareRevision), HOMEBRIDGE_UNKNOWN_FIRMWARE, "the zone accessory shows no controller firmware");
    assert.equal(informationValue(zoneAccessory, Characteristic.Model), PLACEHOLDER_MODEL, "the zone accessory shows no controller model either");
    assert.equal(informationValue(zoneAccessory, Characteristic.SerialNumber), CONTROLLER_SERIAL + "-" + STANDALONE_SUBTYPE,
      "the zone accessory keeps its own synthesized serial");
  });

  test("a zone accessory restored carrying a stale firmware value is reset, not preserved", async (t) => {

    /* The preserve arm exists to protect values an enrichment is about to refresh, and a zone accessory has none coming - nothing will ever write hardware to it.
     * Left in the preserve arm it would strand whatever model the last session put on it, so it takes the unconditional reset instead, exactly as it would on an
     * install with no credentials at all. Its firmware reads Homebridge's restore placeholder, which Homebridge stamps on every cached accessory before the
     * plugin sees it.
     */
    const h = buildController({ hasV2Client: true, program: (recorder) => recorder.programDefault("statusschedule.php", { body: schedule(), kind: "response" }),
      signalAborted: false, userOptions: [STANDALONE_ON] });

    t.after(() => h.abort());

    /* Hand the first poll an accessory that already carries values from some previous session, which is what a restart actually presents. Seeding it into the
     * reconcile's store BEFORE the poll runs is the only moment that models a restore, since the zone's information service is configured once when its valve is
     * first bound and not again on later polls.
     */
    const { api } = h.platform;
    const restored = new api.platformAccessory("Front Lawn", api.hap.uuid.generate(zoneAccessoryId(h.controllerConfig.controller_id, STANDALONE_RELAY_ID)));
    const information = restored.getService(Service.AccessoryInformation);

    information?.updateCharacteristic(Characteristic.FirmwareRevision, "9.99");
    information?.updateCharacteristic(Characteristic.Model, "Some Stale Model");
    restoreCached(api, restored);
    h.zoneAccessories.set(STANDALONE_RELAY_ID, restored);

    await waitUntil(() => restored.getServiceById(Service.Valve, STANDALONE_SUBTYPE) !== undefined,
      { description: "the standalone zone's valve on the restored accessory to appear" });

    assert.equal(informationValue(restored, Characteristic.FirmwareRevision), HOMEBRIDGE_UNKNOWN_FIRMWARE,
      "the stale zone firmware reads Homebridge's restore placeholder");
    assert.equal(informationValue(restored, Characteristic.Model), PLACEHOLDER_MODEL, "and the stale zone model with it");
  });
});

describe("HydrawiseController controller availability", () => {

  // A wire-realistic body carrying the one zone, so a row driving its own clock steps the polling loop rather than racing a fast cadence.
  const status = makeStatusSchedule({ relays: [makeZone({ name: "Front Lawn", relay: 1, relay_id: STANDALONE_RELAY_ID })], sensors: bareSensors });
  const sleep = (status.nextpoll + HYDRAWISE_API_JITTER) * 1000;

  // The option entry that turns on the suspend-all switch, so a row can read the controller accessory's second refusing characteristic.
  const SUSPEND_ALL_ON = "Enable.Device.Suspend.All." + CONTROLLER_SERIAL;

  // The whole second a clock reads, the unit every facts stamp speaks.
  function seconds(clock: TestClock): number {

    return Math.floor(clock.now() / 1000);
  }

  // A controller polling the body above on a clock the row drives.
  function onClock(clock: TestClock, options: { hasV2Client?: boolean; userOptions?: string[] } = {}): BuildControllerResult {

    return buildController({ ...options, clock, mqtt: true, program: (recorder) => {

      recorder.programDefault("statusschedule.php", { body: status, kind: "response" });
      recorder.programDefault("setzone.php", { body: { message: "", message_type: "info" }, kind: "response" });
    }, signalAborted: false });
  }

  // The irrigation system's Active, the characteristic HomeKit reads the controller accessory's availability from.
  function primary(h: { accessory: PlatformAccessory }): HapCharacteristic {

    return present(h.accessory.getService(Service.IrrigationSystem), "the irrigation system").getCharacteristic(Characteristic.Active);
  }

  // The standalone zone accessory's valve, its own primary characteristic.
  function standaloneValve(h: BuildControllerResult): HapCharacteristic {

    return present(h.zoneAccessories.get(STANDALONE_RELAY_ID)?.getServiceById(Service.Valve, STANDALONE_SUBTYPE), "the standalone zone's valve")
      .getCharacteristic(Characteristic.Active);
  }

  // The last availability word published on this controller's own topic.
  function lastWord(h: BuildControllerResult): unknown {

    return present(h.mqtt, "the MQTT recorder").publishedTo(h.controllerConfig.serial_number + "/availability").at(-1)?.payload;
  }

  test("before first contact, the irrigation system and the suspend-all switch refuse reads and writes", async () => {

    // The platform double's signal starts aborted, so the loop never polls and the controller never reaches Hydrawise this run.
    const h = buildController({ userOptions: [SUSPEND_ALL_ON] });
    const suspendAll = present(h.accessory.getServiceById(Service.Switch, "All"), "the suspend-all switch").getCharacteristic(Characteristic.On);

    await assert.rejects(() => triggerGet(primary(h)), noResponse, "the irrigation system's Active refuses a read");
    await assert.rejects(() => triggerSet(primary(h), Characteristic.Active.INACTIVE), noResponse, "and a write");
    await assert.rejects(() => triggerGet(suspendAll), noResponse, "the suspend-all switch refuses a read");
    await assert.rejects(() => triggerSet(suspendAll, true), noResponse, "and a write");
  });

  test("the cloud's word that the controller is offline refuses a standalone valve, and a good poll does not clear it", async (t) => {

    const clock = new TestClock();
    const h = onClock(clock, { hasV2Client: true, userOptions: [STANDALONE_ON] });

    t.after(() => h.abort());

    await advanceThroughSchedule(clock, []);
    assert.equal(await triggerGet(standaloneValve(h)), Characteristic.Active.ACTIVE, "the hosted valve answers once the first poll has landed");

    h.controller.applyFacts({ facts: makeV2Facts({ online: false }), fetchedAt: seconds(clock) });
    await assert.rejects(() => triggerGet(standaloneValve(h)), noResponse, "the cloud's offline word refuses the valve on its own accessory");

    // The next poll lands and rewrites the valve's value, which is exactly what a stored refusal could not survive and a handler-served one does.
    await advanceThroughSchedule(clock, [sleep]);

    assert.equal(h.retrieve.callsTo("statusschedule.php").length, 2, "the next poll has landed");
    await assert.rejects(() => triggerGet(standaloneValve(h)), noResponse, "and the valve still refuses");
  });

  test("the cloud's offline word refuses a zone's manual run and its suspension switch as well as its reads", async (t) => {

    const clock = new TestClock();
    const h = onClock(clock, { hasV2Client: true, userOptions: [ STANDALONE_ON, SUSPEND_ZONE_ON ] });

    t.after(() => h.abort());

    await advanceThroughSchedule(clock, []);

    const zoneSwitch = present(h.zoneAccessories.get(STANDALONE_RELAY_ID)?.getServiceById(Service.Switch, suspendZoneSubtype(STANDALONE_RELAY_ID)),
      "the standalone zone's suspension switch").getCharacteristic(Characteristic.On);

    h.controller.applyFacts({ facts: makeV2Facts({ online: false }), fetchedAt: seconds(clock) });

    const commandsBefore = h.retrieve.callsTo("setzone.php").length;
    const suspensionsBefore = h.suspensions.length;

    // Every write on the zone's accessory refuses, the manual run and the suspension alike, and neither reaches the wire.
    await assert.rejects(() => triggerSet(standaloneValve(h), Characteristic.Active.ACTIVE), noResponse, "the manual run refuses while the cloud says offline");
    await assert.rejects(() => triggerSet(zoneSwitch, true), noResponse, "and so does the suspension switch");
    assert.equal(h.retrieve.callsTo("setzone.php").length, commandsBefore, "no command reached the API");
    assert.equal(h.suspensions.length, suspensionsBefore, "and no suspension reached the account API");
  });

  test("facts aged exactly their lifetime still refuse, a second older refuse nothing, and the word follows on the next poll", async (t) => {

    const clock = new TestClock();
    const h = onClock(clock, { hasV2Client: true });

    t.after(() => h.abort());

    await advanceThroughSchedule(clock, []);
    assert.equal(lastWord(h), "online", "the first poll states the controller online");

    h.controller.applyFacts({ facts: makeV2Facts({ online: false }), fetchedAt: seconds(clock) - HYDRAWISE_V2_FACTS_TTL });

    await assert.rejects(() => triggerGet(primary(h)), noResponse, "a snapshot aged exactly its lifetime is still trusted, so it refuses");
    assert.equal(lastWord(h), "offline", "and the word follows the facts as they land");

    // One second later the same snapshot has aged out. Nothing marks that moment, so the handlers answer at once while the word waits for the next poll.
    clock.advance(1000);

    assert.equal(await triggerGet(primary(h)), Characteristic.Active.ACTIVE, "one second older, the snapshot is past its lifetime and refuses nothing");
    assert.equal(lastWord(h), "offline", "the word has had no event to re-judge it");

    await advanceThroughSchedule(clock, [sleep - 1000]);

    assert.equal(lastWord(h), "online", "the next poll re-judges the word");
  });

  test("an install with an API key alone answers on the same wire, whatever the cloud would say", async (t) => {

    const clock = new TestClock();
    const h = onClock(clock, { userOptions: [STANDALONE_ON] });

    t.after(() => h.abort());

    await advanceThroughSchedule(clock, []);

    // No client exists here to hand facts over, so this states what one would have said; the verdict reads the cloud's word only where credentials fetch it.
    h.controller.applyFacts({ facts: makeV2Facts({ online: false }), fetchedAt: seconds(clock) });

    assert.equal(await triggerGet(primary(h)), Characteristic.Active.ACTIVE, "the irrigation system answers");
    assert.equal(await triggerGet(standaloneValve(h)), Characteristic.Active.ACTIVE, "and so does the standalone valve");
    assert.equal(lastWord(h), "online", "the word stays online");
  });

  test("a write to the irrigation system's Active returns to Active after the revert beat, and a read answers Active", async (t) => {

    const clock = new TestClock();
    const h = onClock(clock);

    t.after(() => h.abort());

    await advanceThroughSchedule(clock, []);
    await triggerSet(primary(h), Characteristic.Active.INACTIVE);

    assert.equal(primary(h).value, Characteristic.Active.INACTIVE, "HomeKit's write lands for the beat");

    clock.advance(HYDRAWISE_REVERT_DELAY);

    assert.equal(primary(h).value, Characteristic.Active.ACTIVE, "and Active is put back after it");
    assert.equal(await triggerGet(primary(h)), Characteristic.Active.ACTIVE, "a read answers Active");
  });

  test("a cached standalone zone accessory no poll hosts refuses, binds when a poll first hosts it, and refuses again when unhosted", async (t) => {

    const clock = new TestClock();
    const sibling = makeZone({ name: "Back Lawn", relay: 2, relay_id: STANDALONE_RELAY_ID + 1 });
    const zone = makeZone({ name: "Front Lawn", relay: 1, relay_id: STANDALONE_RELAY_ID });
    const h = buildController({ clock, program: (recorder) => {

      recorder.program("statusschedule.php", { body: { ...status, relays: [sibling] }, kind: "response" });
      recorder.program("statusschedule.php", { body: { ...status, relays: [ zone, sibling ] }, kind: "response" });
      recorder.programDefault("statusschedule.php", { body: { ...status, relays: [sibling] }, kind: "response" });
      recorder.programDefault("setzone.php", { body: { message: "", message_type: "info" }, kind: "response" });
    }, signalAborted: false, userOptions: [STANDALONE_ON] });

    t.after(() => h.abort());

    // The zone's accessory as the cache restores it, carrying its valve. The first poll does not report the zone, so nothing hosts the accessory.
    const { api } = h.platform;
    const restored = new api.platformAccessory("Front Lawn", api.hap.uuid.generate(zoneAccessoryId(h.controllerConfig.controller_id, STANDALONE_RELAY_ID)));
    const valve = restored.addService(new Service.Valve("Front Lawn", STANDALONE_SUBTYPE)).getCharacteristic(Characteristic.Active);

    restoreCached(api, restored);

    await advanceThroughSchedule(clock, []);
    assert.equal(h.retrieve.callsTo("statusschedule.php").length, 1, "the first poll has landed without the zone");

    // The platform keeps the accessory through its grace and hands it back when the zone returns; the reconcile double models that by reusing what it holds.
    h.zoneAccessories.set(STANDALONE_RELAY_ID, restored);

    await advanceThroughSchedule(clock, [sleep]);

    assert.equal(await triggerGet(valve), Characteristic.Active.ACTIVE, "the cached valve answers the value the poll that hosts it projected");

    await triggerSet(valve, Characteristic.Active.INACTIVE);

    assert.equal(h.retrieve.callsTo("setzone.php").length, 1, "a stop reaches the wire, so the valve was bound when a poll first hosted it");

    // The zone drops off the wire again, and the accessory is held through its grace with nothing describing it.
    await advanceThroughSchedule(clock, [sleep]);

    await assert.rejects(() => triggerGet(valve), noResponse, "an accessory the last poll did not host refuses");
  });

  test("a cached fault reading is removed on a credentialed restore", () => {

    const h = buildController({ hasV2Client: true, seedContext: (seed) => {

      const irrigation = seed.addService(Service.IrrigationSystem).updateCharacteristic(Characteristic.StatusFault, Characteristic.StatusFault.GENERAL_FAULT);

      assert.equal(irrigation.testCharacteristic(Characteristic.StatusFault), true, "the cache carries a fault reading for the restore to remove");
    } });

    assert.equal(h.accessory.getService(Service.IrrigationSystem)?.testCharacteristic(Characteristic.StatusFault), false,
      "the plugin learns no hardware fault, so a cached reading is removed even with credentials");
  });

  test("a cached fault reading is removed on a restore with an API key alone", () => {

    const h = buildController({ seedContext: (seed) => {

      const irrigation = seed.addService(Service.IrrigationSystem).updateCharacteristic(Characteristic.StatusFault, Characteristic.StatusFault.GENERAL_FAULT);

      assert.equal(irrigation.testCharacteristic(Characteristic.StatusFault), true, "the cache carries a fault reading for the restore to remove");
    } });

    assert.equal(h.accessory.getService(Service.IrrigationSystem)?.testCharacteristic(Characteristic.StatusFault), false,
      "a cached reading is removed without credentials too");
  });

  test("a first reading that says offline is narrated and refuses", async (t) => {

    const clock = new TestClock();
    const h = onClock(clock, { hasV2Client: true });

    t.after(() => h.abort());

    await advanceThroughSchedule(clock, []);

    h.controller.applyFacts({ facts: makeV2Facts({ online: false }), fetchedAt: seconds(clock) });

    assert.equal(logCount(h.entries, "info", "The controller is offline."), 1, "the controller refuses on this reading, so the log says why");
    await assert.rejects(() => triggerGet(primary(h)), noResponse, "and the controller accessory refuses");
  });

  test("a first reading that says online seeds silently, and only a genuine flip is narrated", () => {

    const h = buildController({ hasV2Client: true });
    const now = Math.floor(Date.now() / 1000);

    h.controller.applyFacts({ facts: makeV2Facts({ online: true }), fetchedAt: now });
    assert.equal(logCount(h.entries, "info", "The controller is"), 0, "a first reading of online narrates nothing");

    h.controller.applyFacts({ facts: makeV2Facts({ online: false }), fetchedAt: now });
    assert.equal(logCount(h.entries, "info", "The controller is offline."), 1, "the flip to offline is narrated once");

    h.controller.applyFacts({ facts: makeV2Facts({ online: true }), fetchedAt: now });
    assert.equal(logCount(h.entries, "info", "The controller is back online."), 1, "the flip back is narrated once");

    // A repeat of the same reading is not a transition, and neither is a refresh that could not tell.
    h.controller.applyFacts({ facts: makeV2Facts({ online: true }), fetchedAt: now });
    h.controller.applyFacts({ facts: makeV2Facts({ online: null }), fetchedAt: now });
    assert.equal(logCount(h.entries, "info", "The controller is"), 2, "an unchanged reading and an unknown one narrate nothing further");
  });
});
