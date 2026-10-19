/* Copyright(C) 2017-2026, HJD (https://github.com/hjdhjd). All rights reserved.
 *
 * controller.hardware.test.ts: The controller's projection of optional hardware facts onto HomeKit's AccessoryInformation service. The design under test is
 * cache-resident: the characteristics are the only store these facts have, so every assertion here is a claim about what a characteristic READS after a construction or
 * an enrichment, never about a parallel copy.
 *
 * That makes the pre-seeded value the whole method. HAP round-trips characteristic values through Homebridge's accessory cache, so a warm restart begins with real
 * values already in place - the double models this by seeding each kind with HAP's own registered default and letting a test write over it. A test that started
 * from an empty accessory could not tell "preserved the cached value" from "wrote nothing anywhere", which is exactly the distinction this design turns on.
 */

// The Hydrawise API wire shapes use snake_case keys such as relay_id, so camelcase is disabled here to let the zone fixtures mirror the wire verbatim.
/* eslint-disable camelcase */
import { Characteristic, Service, TestAccessory } from "./testing/hap.helpers.ts";
import { HAP_DEFAULT_MODEL, HOMEBRIDGE_UNKNOWN_FIRMWARE, HYDRAWISE_V2_FACTS_TTL } from "./settings.ts";
import type { HydrawiseControllerHardware, StatusScheduleResponse } from "./types.ts";
import { buildController, makeV2Facts } from "./testing/platform.helpers.ts";
import { describe, test } from "node:test";
import { fastPolling, makeStatusSchedule, makeZone } from "./api.helpers.ts";
import type { CharacteristicType } from "./testing/hap.helpers.ts";
import assert from "node:assert/strict";
import { bareSensors } from "./api.fixtures.ts";
import { waitUntil } from "homebridge-plugin-utils/testing";

const CONTROLLER_SERIAL = "SN0A1B2C3D4";
const STANDALONE_RELAY_ID = 700001;
const STANDALONE_SUBTYPE = "700001";

// The option entry that promotes the zone onto an accessory of its own.
const STANDALONE_ON = "Enable.Device.Standalone." + STANDALONE_SUBTYPE;

// The product-line name an unenriched controller displays.
const PLACEHOLDER_MODEL = "Hydrawise";

// The facts a fetch reports, and the values a warm restart begins with. They are deliberately different from each other so an assertion can tell a preserved
// cached value from a freshly written one.
const FETCHED: HydrawiseControllerHardware = { firmware: "4.76", model: "HCC 38 Zones" };
const CACHED: HydrawiseControllerHardware = { firmware: "4.70", model: "HCC 24 Zones" };

// One accessory's information characteristic, which is what HomeKit shows the user for it.
function informationValue(accessory: TestAccessory, characteristic: CharacteristicType): unknown {

  return accessory.getService(Service.AccessoryInformation)?.getCharacteristic(characteristic).value;
}

// The instant a facts snapshot is stamped with. Tests that care only about adoption stamp it now, which is comfortably inside the freshness window every consumer
// gates on; the tests that care about that window stamp their own age instead.
function now(): number {

  return Math.floor(Date.now() / 1000);
}

// Seed an accessory the way HAP restores a cached one: real model and firmware values already sitting in the characteristics before anything configures it.
function seedCached(accessory: TestAccessory): void {

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

    /* This is the assertion that omitting the writes would fail, and the seeded start is what gives it teeth. The characteristics outlive the credentials that populated
     * them, so a controller that simply skipped these writes when it had no facts would leave a real model and a real firmware version on display permanently,
     * with nothing left in the plugin that could ever refresh or correct them.
     */
    const { accessory } = buildController({ seedContext: seedCached });

    assert.equal(informationValue(accessory, Characteristic.Model), PLACEHOLDER_MODEL, "the model returns to the product-line placeholder");
    assert.equal(informationValue(accessory, Characteristic.FirmwareRevision), HOMEBRIDGE_UNKNOWN_FIRMWARE, "the firmware returns to the unknown marker");
  });
});

describe("HydrawiseController hardware display with credentials", () => {

  test("a warm restart leaves cached real values untouched", () => {

    /* The refresh that will confirm these values is already on its way, so the synchronous path writes neither: blanking a correct display for the length of a
     * network round trip would be a visible regression for a user who has done nothing but restart Homebridge.
     */
    const { accessory } = buildController({ hasV2Client: true, seedContext: seedCached });

    assert.equal(informationValue(accessory, Characteristic.Model), CACHED.model, "the cached model survives the restart");
    assert.equal(informationValue(accessory, Characteristic.FirmwareRevision), CACHED.firmware, "the cached firmware survives it too");
  });

  test("a brand-new accessory is stamped with the placeholder rather than showing HAP's default", () => {

    // The one case where nothing is being preserved, told apart by the only value that can mean "nothing has ever written here". Without this arm a user adding a
    // controller would see a library-internal string until the first fetch landed.
    const { accessory } = buildController({ hasV2Client: true });

    assert.equal(informationValue(accessory, Characteristic.Model), PLACEHOLDER_MODEL, "a fresh accessory is stamped with the product line");

    /* The firmware is left exactly as HAP constructed it, which is the other half of this arm: stamping the model does not drag the firmware along with it. The
     * assertion reads the double's own registered default rather than a literal, so what it means is "nothing wrote here" rather than "here is a value".
     */
    assert.equal(informationValue(accessory, Characteristic.FirmwareRevision), Characteristic.FirmwareRevision.DEFAULT_VALUE,
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
    const before = h.flushes.length;

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
    assert.equal(h.flushes.length - before, 1, "the first arrival carrying hardware flushes the accessory cache exactly once");
    assert.deepEqual(h.flushes[h.flushes.length - 1], [h.accessory], "the flush names the accessory that changed and nothing else");
  });

  test("a tick that moves nothing flushes ZERO times", () => {

    /* The whole point of the change gate. On a recurring cadence an unconditional flush would write the accessory cache to disk every quarter hour for facts that
     * had not moved, for the life of the plugin.
     */
    const h = buildController({ hasV2Client: true });

    h.controller.applyFacts({ facts: makeV2Facts({ hardware: FETCHED }), fetchedAt: now() });

    const settled = h.flushes.length;

    h.controller.applyFacts({ facts: makeV2Facts({ hardware: FETCHED }), fetchedAt: now() + 1 });

    assert.equal(h.flushes.length - settled, 0, "an identical second answer is not worth a disk write");
  });

  test("hardware still writes unconditionally, with no compare-before-write of its own", () => {

    /* HAP already drops a write whose value matches what the characteristic holds, so a compare there would duplicate the library's own work and add a second
     * place for the two answers to disagree. The change gate governs the durable FLUSH alone; the characteristic write itself stays unconditional, which is what
     * this separates.
     */
    const h = buildController({ hasV2Client: true });
    const information = h.accessory.getService(Service.AccessoryInformation);

    h.controller.applyFacts({ facts: makeV2Facts({ hardware: FETCHED }), fetchedAt: now() });

    // The window opens on an accessory that already holds exactly these values, so whatever is recorded below is a write the plugin chose to perform against an
    // unchanged fact.
    information?.clearWrites();

    h.controller.applyFacts({ facts: makeV2Facts({ hardware: FETCHED }), fetchedAt: now() + 1 });

    assert.equal(information?.writesFor(Characteristic.Model, Characteristic.FirmwareRevision).length, 2,
      "an identical second answer still reaches both characteristics rather than being gated in the plugin");
  });

  test("a changed firmware version is adopted and flushed", () => {

    // Hardware self-heals on every tick rather than being learned once, so a firmware upgrade the user performs in the Hydrawise app reaches HomeKit on its own.
    const h = buildController({ hasV2Client: true });

    h.controller.applyFacts({ facts: makeV2Facts({ hardware: FETCHED }), fetchedAt: now() });

    const settled = h.flushes.length;

    h.controller.applyFacts({ facts: makeV2Facts({ hardware: { firmware: "4.99", model: FETCHED.model } }), fetchedAt: now() + 1 });

    assert.equal(informationValue(h.accessory, Characteristic.FirmwareRevision), "4.99", "the upgraded firmware replaces the version already on display");
    assert.equal(h.flushes.length - settled, 1, "a genuine hardware change is worth exactly one write");
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

    // The end of the cache-resident story: what adoption wrote is what a restart reads back, and the credentialed synchronous path leaves it exactly as it found it.
    const first = buildController({ hasV2Client: true });

    first.controller.applyFacts({ facts: makeV2Facts({ hardware: FETCHED }), fetchedAt: now() });

    const second = buildController({ hasV2Client: true, seedContext: (seed) => {

      const information = seed.getService(Service.AccessoryInformation);

      information?.updateCharacteristic(Characteristic.Model, informationValue(first.accessory, Characteristic.Model));
      information?.updateCharacteristic(Characteristic.FirmwareRevision, informationValue(first.accessory, Characteristic.FirmwareRevision));
    } });

    assert.equal(informationValue(second.accessory, Characteristic.Model), FETCHED.model, "the next session reads back the adopted model");
    assert.equal(informationValue(second.accessory, Characteristic.FirmwareRevision), FETCHED.firmware, "and the adopted firmware with it");
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
     * Left in the preserve arm it would strand whatever the last session put on its firmware characteristic, so it takes the unconditional reset instead, exactly
     * as it would on an install with no credentials at all.
     */
    const h = buildController({ hasV2Client: true, program: (recorder) => recorder.programDefault("statusschedule.php", { body: schedule(), kind: "response" }),
      signalAborted: false, userOptions: [STANDALONE_ON] });

    t.after(() => h.abort());

    /* Hand the first poll an accessory that already carries values from some previous session, which is what a restart actually presents. Seeding it into the
     * reconcile's store BEFORE the poll runs is the only moment that models a restore, since the zone's information service is configured once when its valve is
     * first bound and not again on later polls.
     */
    const restored = new TestAccessory("Front Lawn", "500001.Zone.700001");
    const information = restored.getService(Service.AccessoryInformation);

    information?.updateCharacteristic(Characteristic.FirmwareRevision, "9.99");
    information?.updateCharacteristic(Characteristic.Model, "Some Stale Model");
    h.zoneAccessories.set(STANDALONE_RELAY_ID, restored);

    await waitUntil(() => restored.getServiceById(Service.Valve, STANDALONE_SUBTYPE) !== undefined,
      { description: "the standalone zone's valve on the restored accessory to appear" });

    assert.equal(informationValue(restored, Characteristic.FirmwareRevision), HOMEBRIDGE_UNKNOWN_FIRMWARE, "the stale zone firmware is reset");
    assert.equal(informationValue(restored, Characteristic.Model), PLACEHOLDER_MODEL, "and the stale zone model with it");
  });
});

describe("HydrawiseController controller availability", () => {

  // The fault characteristic on the irrigation system service, which is where HomeKit shows a controller Hydrawise cannot reach.
  function faultValue(h: { accessory: TestAccessory }): unknown {

    return h.accessory.getService(Service.IrrigationSystem)?.getCharacteristic(Characteristic.StatusFault).value;
  }

  // Whether that characteristic exists at all, which is the presence claim rather than the value claim.
  function hasFault(h: { accessory: TestAccessory }): boolean {

    return h.accessory.getService(Service.IrrigationSystem)?.testCharacteristic(Characteristic.StatusFault) ?? false;
  }

  test("an install with no credentials carries no fault characteristic at all", () => {

    // The plugin cannot learn reachability without the account credentials, so it publishes no characteristic claiming to know it.
    assert.equal(hasFault(buildController()), false, "the characteristic is absent where the fact cannot be learned");
  });

  test("a credentialed install starts with an explicit no-fault, before any refresh has answered", () => {

    /* Construction runs synchronously, long before a fetch can resolve, so the characteristic needs a stated starting value rather than whatever HAP would
     * default it to.
     */
    const h = buildController({ hasV2Client: true });

    assert.equal(hasFault(h), true, "the characteristic exists on a credentialed install");
    assert.equal(faultValue(h), Characteristic.StatusFault.NO_FAULT, "and it starts stating no fault");
  });

  test("a credentialed restore carrying a cached fault starts at no-fault", () => {

    /* The kept arm of the presence gate. The accessory comes back from the cache with the irrigation system service already carrying a fault reading, so the gate
     * keeps the characteristic rather than attaching it, and the starting state is written on that arm too: until a refresh answers, the cached reading is a
     * reachability nothing in this session has confirmed.
     */
    const h = buildController({ hasV2Client: true, seedContext: (seed) => {

      seed.addService(Service.IrrigationSystem).updateCharacteristic(Characteristic.StatusFault, Characteristic.StatusFault.GENERAL_FAULT);
    } });

    assert.equal(hasFault(h), true, "the characteristic stays on a credentialed install");
    assert.equal(faultValue(h), Characteristic.StatusFault.NO_FAULT, "and it starts stating no fault rather than the cached reading");
  });

  test("an accessory restored from a credentialed past has the characteristic REMOVED once the credentials are gone", () => {

    /* The same clean revert the firmware reset performs, and for the same reason: HAP round-trips characteristics through the accessory cache, so an accessory
     * that once had credentials would otherwise keep displaying a reachability nothing is left to update.
     */
    const h = buildController({ seedContext: (seed) => {

      seed.addService(Service.IrrigationSystem).updateCharacteristic(Characteristic.StatusFault, Characteristic.StatusFault.GENERAL_FAULT);
    } });

    assert.equal(hasFault(h), false, "a stale fault reading is removed rather than left standing");
  });

  test("the three readings are distinguished, and the unknown one is proven against a NON-default prior", () => {

    const h = buildController({ hasV2Client: true });

    h.controller.applyFacts({ facts: makeV2Facts({ online: true }), fetchedAt: now() });
    assert.equal(faultValue(h), Characteristic.StatusFault.NO_FAULT, "a reachable controller clears the fault");

    h.controller.applyFacts({ facts: makeV2Facts({ online: false }), fetchedAt: now() });
    assert.equal(faultValue(h), Characteristic.StatusFault.GENERAL_FAULT, "an unreachable one raises it");

    /* The unknown branch is asserted from the FAULTED state deliberately. Applied to the no-fault default it would pass trivially against an implementation that
     * always wrote no-fault, which is exactly the bug this branch exists to avoid.
     */
    h.controller.applyFacts({ facts: makeV2Facts({ online: null }), fetchedAt: now() });
    assert.equal(faultValue(h), Characteristic.StatusFault.GENERAL_FAULT, "a refresh that could not tell leaves the real reading standing");
  });

  test("a snapshot aged past its lifetime clears the fault rather than freezing it on display forever", () => {

    const h = buildController({ hasV2Client: true });

    h.controller.applyFacts({ facts: makeV2Facts({ online: false }), fetchedAt: now() });
    assert.equal(faultValue(h), Characteristic.StatusFault.GENERAL_FAULT, "the controller is displayed as unreachable");

    // A snapshot this old is untrustworthy, and an unknown state is not a fault - leaving the fault up would be a claim the user could never clear.
    h.controller.applyFacts({ facts: makeV2Facts({ online: false }), fetchedAt: now() - (HYDRAWISE_V2_FACTS_TTL + 1) });
    assert.equal(faultValue(h), Characteristic.StatusFault.NO_FAULT, "a stale snapshot returns the display to no-fault");
  });

  test("the freshness boundary is inclusive, so a snapshot exactly at its lifetime still counts as fresh", () => {

    // The off-by-one assertion on the comparison operator itself.
    const h = buildController({ hasV2Client: true });

    h.controller.applyFacts({ facts: makeV2Facts({ online: false }), fetchedAt: now() - HYDRAWISE_V2_FACTS_TTL });
    assert.equal(faultValue(h), Characteristic.StatusFault.GENERAL_FAULT, "a snapshot aged exactly its lifetime is still trusted");

    h.controller.applyFacts({ facts: makeV2Facts({ online: false }), fetchedAt: now() - (HYDRAWISE_V2_FACTS_TTL + 1) });
    assert.equal(faultValue(h), Characteristic.StatusFault.NO_FAULT, "one second older is not");
  });

  test("the first reading seeds silently, and only a genuine flip is narrated", () => {

    /* The characteristic cannot be the seed for this: it is constructed carrying no-fault, which is indistinguishable from a real first report of "reachable", so
     * a controller that is offline the very first time it is heard from would narrate an offline transition it never made.
     */
    const h = buildController({ hasV2Client: true });

    h.controller.applyFacts({ facts: makeV2Facts({ online: false }), fetchedAt: now() });

    assert.equal(h.entries.filter(line => line.message.includes("controller is")).length, 0, "a first reading of OFFLINE narrates nothing");

    h.controller.applyFacts({ facts: makeV2Facts({ online: true }), fetchedAt: now() });

    const back = h.entries.filter(line => (line.level === "info") && line.message.includes("back online"));

    assert.equal(back.length, 1, "the flip back is narrated exactly once");

    // A repeat of the same reading is not a transition, so it says nothing further.
    h.controller.applyFacts({ facts: makeV2Facts({ online: true }), fetchedAt: now() });
    assert.equal(h.entries.filter(line => line.message.includes("back online")).length, 1, "an unchanged reading narrates nothing further");

    h.controller.applyFacts({ facts: makeV2Facts({ online: null }), fetchedAt: now() });
    assert.equal(h.entries.filter(line => line.message.includes("controller is")).length, 1, "and neither does a refresh that could not tell");
  });
});
