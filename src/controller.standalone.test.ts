/* Copyright(C) 2017-2026, HJD (https://github.com/hjdhjd). All rights reserved.
 *
 * controller.standalone.test.ts: The controller's projection of standalone zones onto accessories of their own. Asserts where a zone's valve is hosted and
 * where it is not, the enumeration difference a standalone host implies, the controller aggregates that deliberately still span standalone zones, the reconcile
 * request the projection builds, the zone accessory's information and name synchronization, the warm-restart handler attach, the fall back to controller hosting,
 * and the default-off parity floor.
 */

// The Hydrawise API wire shapes use snake_case keys such as relay_id, so camelcase is disabled here to let the zone fixtures mirror the wire verbatim.
/* eslint-disable camelcase */
import { Characteristic, Service, buildController, pollsCompleted, restoreCached } from "./testing/platform.helpers.ts";
import type { HydrawiseZoneConfig, StatusScheduleResponse } from "./types.ts";
import { UNSCHEDULED_SENTINEL, bareSensors, rainSensors, syntheticController } from "./api.fixtures.ts";
import { describe, test } from "node:test";
import { fastPolling, makeStatusSchedule, makeZone } from "./api.helpers.ts";
import { loggedAt, present, triggerSet, waitUntil } from "homebridge-plugin-utils/testing";
import assert from "node:assert/strict";
import { getServiceName } from "homebridge-plugin-utils";
import { zoneAccessoryId } from "./types.ts";

const CONTROLLER_SERIAL = "SN0A1B2C3D4";
const STANDALONE_RELAY_ID = 700001;
const STANDALONE_SUBTYPE = "700001";
const HOSTED_RELAY_ID = 700002;
const HOSTED_SUBTYPE = "700002";

// The option entry that promotes the first zone. Every scenario that wants a standalone zone names this one, so the grammar lives in one place.
const STANDALONE_ON = "Enable.Device.Standalone." + STANDALONE_SUBTYPE;

/* The wire name of the zone under test carries a character HomeKit disallows, so its raw and sanitized forms are observably different values. Every assertion that
 * asserts on a name states that difference as a precondition, which is what stops the assertion from passing vacuously against an implementation that writes the
 * raw name.
 */
const WIRE_NAME = "Front/Lawn North";
const WIRE_NAME_SANITIZED = "Front Lawn North";
const WIRE_RENAMED = "Rear/Lawn South";
const WIRE_RENAMED_SANITIZED = "Rear Lawn South";
const OVERRIDE_NAME = "Front Bed Drip Line";

// The standalone zone, running now by default, with the remaining runtime the aggregate assertion reads back off the controller accessory.
function standaloneZone(overrides: Partial<HydrawiseZoneConfig> = {}): HydrawiseZoneConfig {

  return makeZone({ name: WIRE_NAME, relay: 1, relay_id: STANDALONE_RELAY_ID, run: 600, time: 1, timestr: "", ...overrides });
}

// The overrides that make the zone scheduled rather than running. A manual-run assertion needs them: the walk writes SetDuration only for a zone that is not already
// running, and the run command the handler sends is a no-op without one.
const SCHEDULED: Partial<HydrawiseZoneConfig> = { run: 480, time: 68000, timestr: "16:00" };

// The overrides that give the zone the unscheduled sentinel shape. Served with a rain sensor whose relay list covers the zone, this is the wire state that
// classifies as a sensor stop.
const SENSOR_STOPPED: Partial<HydrawiseZoneConfig> = { run: 0, time: UNSCHEDULED_SENTINEL, timestr: "" };

// The controller-hosted zone: scheduled well beyond the active-zone window, so it neither runs nor drives a transition.
function hostedZone(): HydrawiseZoneConfig {

  return makeZone({ name: "Side Yard", relay: 2, relay_id: HOSTED_RELAY_ID, run: 480, time: 68000, timestr: "16:00" });
}

// A fast-cadence schedule around the given zones with a bare sensor block, so a live-loop test cycles in roughly 250ms.
function schedule(zones: HydrawiseZoneConfig[]): StatusScheduleResponse {

  return fastPolling(makeStatusSchedule({ relays: zones, sensors: bareSensors }));
}

/* A cadence deliberately slower than the fast one, in seconds. It leaves a gap after each poll's projection wide enough for a test to change what the NEXT poll
 * will see - a feature option, the programmed body - before that poll fetches. The fast cadence leaves no usable gap: its next fetch is already away by the
 * time an effect of the previous poll is observable.
 */
const PACED_POLL_SECONDS = 0.3;

// A paced-cadence schedule around the given zones and sensor block.
function pacedSchedule(zones: HydrawiseZoneConfig[], sensors: StatusScheduleResponse["sensors"]): StatusScheduleResponse {

  return makeStatusSchedule({ nextpoll: PACED_POLL_SECONDS, relays: zones, sensors });
}

describe("HydrawiseController standalone zones", () => {

  test("hosts a standalone zone's valve on its own accessory and prunes it from the controller", async (t) => {

    /* The controller accessory comes back from Homebridge's cache already carrying a valve for BOTH zones, which is the state a restart after opting a zone in
     * actually restores. That seed is what makes the absence assertion below distinguishing: without a pre-existing controller-side valve there is nothing for a
     * mis-derived keep-set to leave behind, and the assertion would pass against a prune that never learned about the hosting map at all.
     */
    const h = buildController({ program: (recorder) => recorder.programDefault("statusschedule.php",
      { body: schedule([ standaloneZone(), hostedZone() ]), kind: "response" }),
    seedContext: (seed) => {

      seed.addService(new Service.Valve(WIRE_NAME_SANITIZED, STANDALONE_SUBTYPE));
      seed.addService(new Service.Valve("Side Yard", HOSTED_SUBTYPE));
    }, signalAborted: false, userOptions: [STANDALONE_ON] });

    t.after(() => h.abort());
    await waitUntil(() => h.zoneAccessories.get(STANDALONE_RELAY_ID)?.getServiceById(Service.Valve, STANDALONE_SUBTYPE) !== undefined,
      { description: "the standalone zone's valve on its own accessory to appear" });

    // Both sides of the move: the valve is on the zone accessory AND the cached one is gone from the controller accessory.
    assert.ok(h.zoneAccessories.get(STANDALONE_RELAY_ID)?.getServiceById(Service.Valve, STANDALONE_SUBTYPE), "the standalone zone's valve lives on its accessory");
    assert.equal(h.accessory.getServiceById(Service.Valve, STANDALONE_SUBTYPE), undefined, "the promoted zone's cached controller-side valve is pruned");
    assert.ok(h.accessory.getServiceById(Service.Valve, HOSTED_SUBTYPE), "a zone the user left alone keeps its valve on the controller accessory");
  });

  test("writes no service label index on a standalone valve", async (t) => {

    const h = buildController({ program: (recorder) => recorder.programDefault("statusschedule.php",
      { body: schedule([ standaloneZone(), hostedZone() ]), kind: "response" }), signalAborted: false, userOptions: [STANDALONE_ON] });

    t.after(() => h.abort());
    await waitUntil(() => h.zoneAccessories.get(STANDALONE_RELAY_ID)?.getServiceById(Service.Valve, STANDALONE_SUBTYPE) !== undefined,
      { description: "the standalone zone's valve on its own accessory to appear" });

    const zoneAccessory = present(h.zoneAccessories.get(STANDALONE_RELAY_ID), "the standalone zone's own accessory");
    const valve = present(zoneAccessory.getServiceById(Service.Valve, STANDALONE_SUBTYPE), "the standalone zone's valve");

    // A standalone accessory hosts no ServiceLabel service for an index to enumerate against. The controller-hosted polarity is already asserted by the
    // updateState suite, so only the new signal is asserted here.
    assert.equal(zoneAccessory.changesOn(valve, Characteristic.ServiceLabelIndex).length, 0, "a standalone valve takes no service label index");
    assert.equal(valve.getCharacteristic(Characteristic.IsConfigured).value, Characteristic.IsConfigured.CONFIGURED, "a standalone valve is still configured");
    assert.equal(valve.getCharacteristic(Characteristic.ValveType).value, Characteristic.ValveType.IRRIGATION, "a standalone valve is still typed as irrigation");
  });

  test("counts a standalone zone in the controller's irrigation aggregates", async (t) => {

    // Only the standalone zone is running. An implementation that dropped standalone zones from the aggregate would read NOT_IN_USE with no remaining duration.
    const h = buildController({ program: (recorder) => recorder.programDefault("statusschedule.php",
      { body: schedule([ standaloneZone(), hostedZone() ]), kind: "response" }), signalAborted: false, userOptions: [STANDALONE_ON] });

    t.after(() => h.abort());
    await waitUntil(() => h.zoneAccessories.get(STANDALONE_RELAY_ID)?.getServiceById(Service.Valve, STANDALONE_SUBTYPE) !== undefined,
      { description: "the standalone zone's valve on its own accessory to appear" });

    const irrigation = h.accessory.getService(Service.IrrigationSystem);

    assert.equal(irrigation?.getCharacteristic(Characteristic.InUse).value, Characteristic.InUse.IN_USE,
      "a running standalone zone puts the controller's irrigation system in use");
    assert.equal(irrigation.getCharacteristic(Characteristic.RemainingDuration).value, 600,
      "the running standalone zone's remaining runtime reaches the controller aggregate");
  });

  test("a manual run on a standalone valve still drives the controller's program mode", async (t) => {

    const h = buildController({ program: (recorder) => recorder.programDefault("statusschedule.php",
      { body: schedule([ standaloneZone(SCHEDULED), hostedZone() ]), kind: "response" }), signalAborted: false, userOptions: [STANDALONE_ON] });

    t.after(() => h.abort());
    await waitUntil(() => h.zoneAccessories.get(STANDALONE_RELAY_ID)?.getServiceById(Service.Valve, STANDALONE_SUBTYPE) !== undefined,
      { description: "the standalone zone's valve on its own accessory to appear" });

    const valve = h.zoneAccessories.get(STANDALONE_RELAY_ID)?.getServiceById(Service.Valve, STANDALONE_SUBTYPE);

    assert.ok(valve, "the standalone valve should exist");

    // Program the command reply, then fire the handler the walk attached to the valve on its own accessory.
    h.retrieve.programDefault("setzone.php", { body: { message: "Running zone", message_type: "info" }, kind: "response" });
    await triggerSet(valve.getCharacteristic(Characteristic.Active), Characteristic.Active.ACTIVE);

    assert.equal(h.accessory.getService(Service.IrrigationSystem)?.getCharacteristic(Characteristic.ProgramMode).value,
      Characteristic.ProgramMode.PROGRAM_SCHEDULED_MANUAL_MODE, "a manual run started from a standalone valve reaches the controller's program mode");
  });

  test("sends the wire name in the reconcile identity and the effective name as the display name", async (t) => {

    /* Two distinguishing inputs share this one scenario. The active Name override is what tells a wire-name identity from an effective-name one: without an
     * override both names coincide and the assertion would pass either way. And the second zone is DEVICE-DISABLED, so the pre-enablement rule for the
     * present-relay set has a witness - a set built from the enabled projection instead of the raw report would omit it.
     */
    const h = buildController({ program: (recorder) => recorder.programDefault("statusschedule.php",
      { body: schedule([ standaloneZone(), hostedZone() ]), kind: "response" }), signalAborted: false,
    userOptions: [ STANDALONE_ON, "Disable.Device." + HOSTED_SUBTYPE, "Enable.Device.Name." + STANDALONE_SUBTYPE + "=" + OVERRIDE_NAME ] });

    t.after(() => h.abort());
    await waitUntil(() => h.reconciles.length >= 1, { description: "the first zone accessory reconcile" });

    const request = h.reconciles[0];

    assert.equal(request?.zones.length, 1, "the standalone zone is the whole request");
    assert.equal(request.zones[0]?.identity.name, WIRE_NAME, "the persisted identity carries the name Hydrawise reported");
    assert.equal(request.zones[0].displayName, OVERRIDE_NAME, "the accessory's display name carries the effective name");
    assert.deepEqual([...request.presentRelayIds].toSorted(), [ STANDALONE_RELAY_ID, HOSTED_RELAY_ID ],
      "the present-relay set is the whole reported population, disabled zones included");
  });

  test("promotes every zone on the controller under a controller-scoped entry", async (t) => {

    /* The entry names the controller serial and no relay id, so only the controller position of the scope walk can satisfy it - an implementation that reads the
     * device position alone resolves nothing here and asks for nothing.
     */
    const h = buildController({ program: (recorder) => recorder.programDefault("statusschedule.php",
      { body: schedule([ standaloneZone(), hostedZone() ]), kind: "response" }), signalAborted: false,
    userOptions: ["Enable.Device.Standalone." + CONTROLLER_SERIAL] });

    t.after(() => h.abort());
    await waitUntil(() => h.reconciles.length >= 1, { description: "the first zone accessory reconcile" });

    assert.deepEqual(h.reconciles[0]?.zones.map(zone => zone.identity.relayId).toSorted(), [ STANDALONE_RELAY_ID, HOSTED_RELAY_ID ],
      "a controller-scoped entry carries every zone on the controller into the request");
    await waitUntil(() => h.zoneAccessories.size === 2, { description: "the second zone accessory" });

    assert.equal(h.zoneAccessories.size, 2, "both zones end up on accessories of their own");
  });

  test("promotes every zone under a global entry", async (t) => {

    // The bare entry sits at the global position of the scope walk, the account-wide answer when neither the zone nor the controller says otherwise.
    const h = buildController({ program: (recorder) => recorder.programDefault("statusschedule.php",
      { body: schedule([ standaloneZone(), hostedZone() ]), kind: "response" }), signalAborted: false, userOptions: ["Enable.Device.Standalone"] });

    t.after(() => h.abort());
    await waitUntil(() => h.reconciles.length >= 1, { description: "the first zone accessory reconcile" });

    assert.deepEqual(h.reconciles[0]?.zones.map(zone => zone.identity.relayId).toSorted(), [ STANDALONE_RELAY_ID, HOSTED_RELAY_ID ],
      "a global entry carries every zone into the request");
    await waitUntil(() => h.zoneAccessories.size === 2, { description: "the second zone accessory" });

    assert.equal(h.zoneAccessories.size, 2, "both zones end up on accessories of their own");
  });

  test("stamps the zone accessory with its own information identity", async (t) => {

    const h = buildController({ program: (recorder) => recorder.programDefault("statusschedule.php",
      { body: schedule([standaloneZone()]), kind: "response" }), signalAborted: false, userOptions: [STANDALONE_ON] });

    t.after(() => h.abort());
    await waitUntil(() => h.zoneAccessories.get(STANDALONE_RELAY_ID)?.getServiceById(Service.Valve, STANDALONE_SUBTYPE) !== undefined,
      { description: "the standalone zone's valve on its own accessory to appear" });

    const info = h.zoneAccessories.get(STANDALONE_RELAY_ID)?.getService(Service.AccessoryInformation);

    assert.equal(info?.getCharacteristic(Characteristic.Manufacturer).value, "Hunter", "the zone accessory reports the same manufacturer");
    assert.equal(info.getCharacteristic(Characteristic.Model).value, "Hydrawise", "the zone accessory reports the same model");
    assert.equal(info.getCharacteristic(Characteristic.SerialNumber).value, CONTROLLER_SERIAL + "-" + STANDALONE_SUBTYPE,
      "a zone carries no wire serial, so the accessory takes the controller serial compounded with its relay id");
  });

  test("synchronizes the zone accessory's own name on a later poll", async (t) => {

    assert.notEqual(WIRE_RENAMED_SANITIZED, WIRE_RENAMED, "the renamed fixture must differ from its sanitized form for the assertions below to mean anything");

    const h = buildController({ program: (recorder) => {

      recorder.program("statusschedule.php", { body: schedule([standaloneZone()]), kind: "response" });
      recorder.programDefault("statusschedule.php", { body: schedule([standaloneZone({ name: WIRE_RENAMED })]), kind: "response" });
    }, signalAborted: false, userOptions: [STANDALONE_ON] });

    t.after(() => h.abort());
    await waitUntil(() => h.zoneAccessories.get(STANDALONE_RELAY_ID)?.displayName === WIRE_RENAMED_SANITIZED,
      { description: "the standalone accessory to take the renamed wire name" });

    // The two-poll shape is the point: the accessory was established under the first name, so a rename landing here proves the synchronization runs every poll
    // rather than only at establishment.
    const zoneAccessory = h.zoneAccessories.get(STANDALONE_RELAY_ID);

    assert.equal(zoneAccessory?.displayName, WIRE_RENAMED_SANITIZED, "the rename lands on the accessory's display name, sanitized");
    assert.equal(zoneAccessory._associatedHAPAccessory.displayName, WIRE_RENAMED_SANITIZED, "and on the display-name mirror Homebridge maintains beside it");

    assert.equal(getServiceName(zoneAccessory.getService(Service.AccessoryInformation)), WIRE_RENAMED_SANITIZED, "and on the information service's own name");

    await pollsCompleted(h, 4);
    h.abort();

    assert.equal(h.flushes().filter(batch => batch[0] === zoneAccessory).length, 1, "the name change flushes the zone accessory exactly once across the run");
  });

  test("leaves the zone accessory's name alone when synchronization is off", async (t) => {

    const h = buildController({ program: (recorder) => {

      recorder.program("statusschedule.php", { body: schedule([standaloneZone()]), kind: "response" });
      recorder.programDefault("statusschedule.php", { body: schedule([standaloneZone({ name: WIRE_RENAMED })]), kind: "response" });
    }, signalAborted: false, userOptions: [ STANDALONE_ON, "Disable.Device.SyncName." + STANDALONE_SUBTYPE ] });

    t.after(() => h.abort());
    await pollsCompleted(h, 3);
    h.abort();

    // The accessory was created under the first poll's name and is never re-touched, so the rename does not reach it.
    assert.equal(h.zoneAccessories.get(STANDALONE_RELAY_ID)?.displayName, WIRE_NAME_SANITIZED, "an opted-out zone keeps the name its accessory was created with");
    assert.equal(h.flushes().filter(batch => batch[0] === h.zoneAccessories.get(STANDALONE_RELAY_ID)).length, 0, "and nothing flushes the accessory");
  });

  test("attaches the manual-run handler to a cache-restored valve on a warm restart", async (t) => {

    const h = buildController({ program: (recorder) => recorder.programDefault("statusschedule.php",
      { body: schedule([standaloneZone(SCHEDULED)]), kind: "response" }), signalAborted: false, userOptions: [STANDALONE_ON] });

    t.after(() => h.abort());

    /* Seed a zone accessory that ALREADY carries the zone's valve, the shape Homebridge restores from its cache. Seeding synchronously here is safe: the polling
     * loop's first fetch awaits before any projection runs, so this lands ahead of the first poll. The pre-built valve is mandatory - without it the valve would
     * be created this pass and the assertion would pass vacuously through the new-valve arm instead of proving the first-run arm covers a restored one.
     */
    const { api } = h.platform;
    const restored = new api.platformAccessory(WIRE_NAME_SANITIZED, api.hap.uuid.generate(zoneAccessoryId(h.controllerConfig.controller_id, STANDALONE_RELAY_ID)));

    restored.addService(new Service.Valve(WIRE_NAME_SANITIZED, STANDALONE_SUBTYPE));
    restoreCached(api, restored);
    h.zoneAccessories.set(STANDALONE_RELAY_ID, restored);

    await pollsCompleted(h, 1);

    const valve = restored.getServiceById(Service.Valve, STANDALONE_SUBTYPE);

    assert.equal(restored.services.filter(service => service.UUID === Service.Valve.UUID).length, 1, "the restored valve is reused rather than duplicated");
    assert.ok(valve, "the restored valve should still be there");

    h.retrieve.programDefault("setzone.php", { body: { message: "Running zone", message_type: "info" }, kind: "response" });
    await triggerSet(valve.getCharacteristic(Characteristic.Active), Characteristic.Active.ACTIVE);

    assert.equal(valve.getCharacteristic(Characteristic.InUse).value, Characteristic.InUse.IN_USE,
      "the first poll bound a handler to the restored valve, so firing it drives the zone");
  });

  test("hosts a zone the reconcile does not answer for back on the controller accessory", async (t) => {

    const h = buildController({ program: (recorder) => recorder.programDefault("statusschedule.php",
      { body: schedule([ standaloneZone(), hostedZone() ]), kind: "response" }), signalAborted: false, userOptions: [STANDALONE_ON] });

    t.after(() => h.abort());

    // A zone accessory left over for a zone the request does not name. The reconcile answers with no host for it, and the projection has to put its valve back
    // on the controller accessory rather than leaving the zone with no HomeKit surface at all.
    const { api } = h.platform;
    const stale = new api.platformAccessory("Side Yard", api.hap.uuid.generate(zoneAccessoryId(h.controllerConfig.controller_id, HOSTED_RELAY_ID)));

    stale.addService(new Service.Valve("Side Yard", HOSTED_SUBTYPE));
    restoreCached(api, stale);
    h.zoneAccessories.set(HOSTED_RELAY_ID, stale);

    await waitUntil(() => h.accessory.getServiceById(Service.Valve, HOSTED_SUBTYPE) !== undefined, { description: "the hosted zone's valve to appear" });

    assert.ok(h.accessory.getServiceById(Service.Valve, HOSTED_SUBTYPE), "a zone absent from the hosting map gets its valve on the controller accessory");
    assert.equal(h.zoneAccessories.has(HOSTED_RELAY_ID), false, "and it is no longer named in the request the reconcile answers");
  });

  test("with no zone opted in, the projection asks for nothing and behaves exactly as before", async (t) => {

    const h = buildController({ program: (recorder) => recorder.programDefault("statusschedule.php",
      { body: schedule([ standaloneZone(), hostedZone() ]), kind: "response" }), signalAborted: false });

    t.after(() => h.abort());

    // Bounding on the third call guarantees poll 2 fully ran, which is the same window the roster suite's flush-count expectation is measured over.
    await pollsCompleted(h, 2);
    h.abort();

    assert.ok(h.reconciles.length >= 1, "the reconcile is still called every poll");
    assert.ok(h.reconciles.every(request => request.zones.length === 0), "with no zone opted in, every request is empty");
    assert.equal(h.zoneAccessories.size, 0, "no zone accessory exists");
    assert.ok(h.accessory.getServiceById(Service.Valve, STANDALONE_SUBTYPE), "both zones keep their valves on the controller accessory");
    assert.ok(h.accessory.getServiceById(Service.Valve, HOSTED_SUBTYPE), "both zones keep their valves on the controller accessory");
    assert.equal(h.flushes().length, 1, "only the first poll's roster seed flushes, exactly as it does without this feature");
    assert.equal(h.controllerConfig.serial_number, syntheticController.serial_number, "the scenario ran against the synthetic controller");
  });

  test("a zone promoted on the poll that first reports it sensor-stopped logs no rain transition", async (t) => {

    const h = buildController({ program: (recorder) => recorder.programDefault("statusschedule.php",
      { body: pacedSchedule([standaloneZone(SCHEDULED)], rainSensors), kind: "response" }), signalAborted: false });

    t.after(() => h.abort());

    // Poll 1 hosts the zone on the controller accessory against a normal schedule, which seeds its stored rain state false.
    await waitUntil(() => h.accessory.getServiceById(Service.Valve, STANDALONE_SUBTYPE) !== undefined, { description: "the standalone zone's valve to appear" });

    /* Opt the zone in through the platform double's REAL feature-options engine - the same instance the controller consults on every poll - so the promotion
     * arrives at a controller that ALREADY holds a hint entry for this zone. Building a second controller would seed a fresh ledger and quietly defeat the
     * existing-entry premise this assertion exists to exercise. The paced cadence is what lets the option and the body change together: the gap after one poll's
     * projection is wide enough to make both changes before the next poll fetches.
     */
    h.platform.featureOptions.configuredOptions = [ ...h.platform.featureOptions.configuredOptions, STANDALONE_ON ];
    h.retrieve.programDefault("statusschedule.php", { body: pacedSchedule([standaloneZone(SENSOR_STOPPED)], rainSensors), kind: "response" });

    // Poll 2 promotes the zone and reports it sensor-stopped in the same pass, so the valve is re-acquired on a new host while the live sensor state differs
    // from the value stored for the zone. Observing the valve is what proves the promotion happened rather than the scenario passing vacuously.
    await waitUntil(() => h.zoneAccessories.get(STANDALONE_RELAY_ID)?.getServiceById(Service.Valve, STANDALONE_SUBTYPE) !== undefined,
      { description: "the standalone zone's valve on its own accessory to appear" });

    assert.ok(h.zoneAccessories.get(STANDALONE_RELAY_ID)?.getServiceById(Service.Valve, STANDALONE_SUBTYPE), "the valve genuinely landed on the standalone host");
    assert.ok(!loggedAt(h.entries, "info", "Rain sensor is stopping irrigation"),
      "a valve rediscovery refreshes the stored sensor state before the comparison, so a promotion narrates no transition the zone never made");

    // Clearing the stop is the positive control: the line firing here proves Log.Zone is live for this zone and that the promotion poll stored the live
    // stopped state rather than leaving the seeded false standing.
    h.retrieve.programDefault("statusschedule.php", { body: pacedSchedule([standaloneZone(SCHEDULED)], rainSensors), kind: "response" });

    await waitUntil(() => loggedAt(h.entries, "info", "Rain sensor is allowing irrigation"),
      { description: "an info line containing \"Rain sensor is allowing irrigation\"" });

    assert.ok(loggedAt(h.entries, "info", "Rain sensor is allowing irrigation"), "the sensor clearing after the promotion does narrate its transition");
  });
});
