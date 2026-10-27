/* Copyright(C) 2017-2026, HJD (https://github.com/hjdhjd). All rights reserved.
 *
 * controller.updatestate.test.ts: Single-poll behavior of the HydrawiseController polling loop, driven live at the fast (~250ms) cadence against the
 * synthetic zone matrices. Covers valve creation and enumeration, the Active / InUse mapping across running, active-soon, and inactive zones, the
 * irrigation-system aggregate characteristics - program mode included - after one completed poll, and the one save a valve's attach or prune costs.
 */

// The Hydrawise API wire shapes use snake_case keys such as relay_id, so camelcase is disabled here to let the zone fixtures mirror the wire verbatim.
/* eslint-disable camelcase */
import { Characteristic, Service, buildController, pollsCompleted, seedEstablished } from "./testing/platform.helpers.ts";
import { HYDRAWISE_UNSCHEDULED_SENTINEL, controllerIdentity, scheduleStatus, zoneIdentity } from "./types.ts";
import { bareSensors, rainSensors, syntheticController } from "./api.fixtures.ts";
import { describe, test } from "node:test";
import { fastPolling, makeStatusSchedule, makeZone, normalSchedule } from "./api.helpers.ts";
import { HYDRAWISE_ACTIVE_ZONE_INDICATOR } from "./settings.ts";
import type { HydrawiseAccessoryContext } from "./types.ts";
import type { PlatformAccessory } from "homebridge";
import assert from "node:assert/strict";
import { waitUntil } from "homebridge-plugin-utils/testing";

describe("HydrawiseController updateState (single poll)", () => {

  test("creates one enumerated valve service per enabled zone", async (t) => {

    const h = buildController({ program: (recorder) => recorder.programDefault("statusschedule.php", { body: fastPolling(normalSchedule()), kind: "response" }),
      signalAborted: false });

    t.after(() => h.abort());

    // The last zone's valve appears only after the per-zone loop has processed every zone, so waiting on it confirms the whole first pass ran.
    await waitUntil(() => h.accessory.getServiceById(Service.Valve, "700019") !== undefined, { description: "the valve for zone 700019 to appear" });

    const valves = h.accessory.services.filter(service => service.UUID === Service.Valve.UUID);

    assert.equal(valves.length, 19, "a valve should be created for each of the 19 enabled zones");

    const firstValve = h.accessory.getServiceById(Service.Valve, "700001");

    assert.ok(firstValve, "the first zone's valve should exist under its relay_id subtype");
    assert.equal(firstValve.getCharacteristic(Characteristic.ServiceLabelIndex).value, 1, "the valve label index should match the zone relay number");
    assert.equal(firstValve.getCharacteristic(Characteristic.IsConfigured).value, Characteristic.IsConfigured.CONFIGURED, "a new valve should be configured");
    assert.equal(firstValve.getCharacteristic(Characteristic.ValveType).value, Characteristic.ValveType.IRRIGATION, "a valve should be typed as irrigation");

    // HAP builds the label index at its minimum of 1, so only the change record tells the creation's own write from HAP's default.
    assert.deepEqual(h.accessory.changesOn(firstValve, Characteristic.ServiceLabelIndex).map(change => change.newValue), [1],
      "the valve's creation writes its label index itself");
  });

  test("maps a running zone to Active and InUse with its remaining duration", async (t) => {

    const h = buildController({ program: (recorder) => recorder.programDefault("statusschedule.php", { body: fastPolling(normalSchedule()), kind: "response" }),
      signalAborted: false });

    t.after(() => h.abort());

    await waitUntil(() => h.accessory.getServiceById(Service.Valve, "700019") !== undefined, { description: "the valve for zone 700019 to appear" });

    const running = h.accessory.getServiceById(Service.Valve, "700001");

    assert.ok(running, "the running zone's valve should exist");
    assert.equal(running.getCharacteristic(Characteristic.Active).value, Characteristic.Active.ACTIVE, "a running zone should be active");
    assert.equal(running.getCharacteristic(Characteristic.InUse).value, Characteristic.InUse.IN_USE, "a running zone should be in use");
    assert.equal(running.getCharacteristic(Characteristic.RemainingDuration).value, 600, "the running zone should report its remaining runtime");
  });

  test("marks a zone queued within the active window active but not in use", async (t) => {

    const h = buildController({ program: (recorder) => recorder.programDefault("statusschedule.php", { body: fastPolling(normalSchedule()), kind: "response" }),
      signalAborted: false });

    t.after(() => h.abort());

    await waitUntil(() => h.accessory.getServiceById(Service.Valve, "700019") !== undefined, { description: "the valve for zone 700019 to appear" });

    // Relay 3 sits exactly on the 3600-second active-zone boundary, which is inclusive.
    const boundary = h.accessory.getServiceById(Service.Valve, "700003");

    assert.ok(boundary, "the boundary zone's valve should exist");
    assert.equal(boundary.getCharacteristic(Characteristic.Active).value, Characteristic.Active.ACTIVE, "a zone at the 3600s boundary should be active");
    assert.equal(boundary.getCharacteristic(Characteristic.InUse).value, Characteristic.InUse.NOT_IN_USE, "a queued-but-not-running zone should not be in use");

    // HAP builds InUse at not in use, so only the change record tells the poll's own write from HAP's default.
    assert.ok(h.accessory.changesOn(boundary, Characteristic.InUse).some(change => change.newValue === Characteristic.InUse.NOT_IN_USE),
      "the poll writes the queued zone's not-in-use itself");
  });

  test("marks a zone one second past the active window inactive", async (t) => {

    const h = buildController({ program: (recorder) => recorder.programDefault("statusschedule.php", { body: fastPolling(normalSchedule()), kind: "response" }),
      signalAborted: false });

    t.after(() => h.abort());

    await waitUntil(() => h.accessory.getServiceById(Service.Valve, "700019") !== undefined, { description: "the valve for zone 700019 to appear" });

    // Relay 4 sits one second past the 3600-second window, so it falls outside the active band.
    const justOver = h.accessory.getServiceById(Service.Valve, "700004");

    assert.ok(justOver, "the just-past-window zone's valve should exist");
    assert.equal(justOver.getCharacteristic(Characteristic.Active).value, Characteristic.Active.INACTIVE, "a zone past the active window should be inactive");

    // HAP builds Active at inactive, so only the change record tells the poll's own write from HAP's default.
    assert.ok(h.accessory.changesOn(justOver, Characteristic.Active).some(change => change.newValue === Characteristic.Active.INACTIVE),
      "the poll writes the zone's inactive itself");
  });

  test("aggregates the system into in-use with the scheduled program mode", async (t) => {

    const h = buildController({ program: (recorder) => recorder.programDefault("statusschedule.php", { body: fastPolling(normalSchedule()), kind: "response" }),
      signalAborted: false });

    t.after(() => h.abort());

    await waitUntil(() => h.accessory.getServiceById(Service.Valve, "700019") !== undefined, { description: "the valve for zone 700019 to appear" });

    const irrigation = h.accessory.getService(Service.IrrigationSystem);

    assert.ok(irrigation, "the irrigation system service should exist");
    assert.equal(irrigation.getCharacteristic(Characteristic.InUse).value, Characteristic.InUse.IN_USE, "the system is in use while a zone runs");
    assert.equal(irrigation.getCharacteristic(Characteristic.RemainingDuration).value, 600, "the system remaining duration should sum the running zones");
    assert.equal(irrigation.getCharacteristic(Characteristic.ProgramMode).value, Characteristic.ProgramMode.PROGRAM_SCHEDULED,
      "with no manual run and not every zone rain-stopped the program mode stays scheduled");
  });

  test("keeps the program scheduled when a disabled zone still holds a schedule under the same sensor", async (t) => {

    /* Every enabled zone carries the unscheduled sentinel under a sensor that covers all three zones, while the zone disabled at zone scope still holds a live
     * schedule under that same sensor. The sensor is demonstrably not tripping, so no enabled zone is rain-stopped and the program stays scheduled. A
     * classification that walked only the enabled zones - or that read each zone on its own - finds every enabled zone stopped and reports no program at all.
     */
    const relays = [ makeZone({ name: "Alpha", relay: 1, relay_id: 700001, run: 0, time: HYDRAWISE_UNSCHEDULED_SENTINEL, timestr: "" }),
      makeZone({ name: "Beta", relay: 2, relay_id: 700002, run: 0, time: HYDRAWISE_UNSCHEDULED_SENTINEL, timestr: "" }),
      makeZone({ name: "Gamma", relay: 3, relay_id: 700003, run: 480, time: 68000, timestr: "16:00" }) ];

    const h = buildController({ program: (recorder) => recorder.programDefault("statusschedule.php",
      { body: fastPolling(makeStatusSchedule({ relays, sensors: rainSensors })), kind: "response" }), signalAborted: false,
    userOptions: ["Disable.Device.700003"] });

    t.after(() => h.abort());

    // The disabled zone never gets a valve, so the second enabled zone's valve plus a completed poll is what marks the pass as fully through.
    await waitUntil(() => h.accessory.getServiceById(Service.Valve, "700002") !== undefined, { description: "the valve for zone 700002 to appear" });
    await waitUntil(() => h.retrieve.callsTo("statusschedule.php").length >= 2, { description: "the second status poll" });

    const irrigation = h.accessory.getService(Service.IrrigationSystem);

    assert.ok(irrigation, "the irrigation system service should exist");
    assert.equal(irrigation.getCharacteristic(Characteristic.ProgramMode).value, Characteristic.ProgramMode.PROGRAM_SCHEDULED,
      "a zone HomeKit never sees still breaks the sensor's group, because the sensor stops zones regardless of what the plugin exposes");
  });
});

describe("HydrawiseController valve presence saves", () => {

  // Zones scheduled well beyond the active-zone window, so a poll settles each without a start or stop transition.
  const zones = [ makeZone({ name: "Alpha", relay: 1, relay_id: 700001, run: 480, time: 68000, timestr: "16:00" }),
    makeZone({ name: "Beta", relay: 2, relay_id: 700002, run: 300, time: 69000, timestr: "16:08" }) ];
  const status = fastPolling(makeStatusSchedule({ relays: zones, sensors: bareSensors }));

  // The context a previous session saved for these zones: the controller's own identity, and the roster and schedule projection the first poll reports again.
  function seedSavedContext(accessory: PlatformAccessory): void {

    accessory.context = { controller: controllerIdentity(syntheticController), schedule: scheduleStatus(status, HYDRAWISE_ACTIVE_ZONE_INDICATOR),
      zones: zones.map(zone => zoneIdentity(zone)) };
  }

  test("a zone newly enabled on a restored accessory has its valve attached, that poll's only mark, and saves once", async (t) => {

    /* The cache was saved while Beta was turned off, so the accessory comes back carrying Alpha's valve alone, against a roster, a schedule and an identity that
     * already match what the first poll reports. Beta's valve attach is then the only thing that can mark the accessory.
     */
    const h = buildController({ program: (recorder) => recorder.programDefault("statusschedule.php", { body: status, kind: "response" }), seedContext: (seed) => {

      seedSavedContext(seed);
      seedEstablished({ accessory: seed, zones: zones.slice(0, 1) });
    }, signalAborted: false });

    t.after(() => h.abort());

    await pollsCompleted(h, 3);
    await h.abort();

    assert.ok(h.accessory.getServiceById(Service.Valve, "700002"), "the newly enabled zone's valve is attached");
    assert.equal(h.flushes().length, 1, "and the attach saves the accessory once, the polls after it saving nothing");
  });

  test("a zone disabled by option has its cached valve pruned while the roster keeps it, that poll's only mark, and saves once", async (t) => {

    /* The accessory comes back carrying every zone's valve against a context that already matches, and Beta is turned off. The roster lists every reported zone
     * whatever its options say, so the prune of Beta's valve is the only thing that can mark the accessory.
     */
    const h = buildController({ program: (recorder) => recorder.programDefault("statusschedule.php", { body: status, kind: "response" }), seedContext: (seed) => {

      seedSavedContext(seed);
      seedEstablished({ accessory: seed, zones });
    }, signalAborted: false, userOptions: ["Disable.Device.700002"] });

    t.after(() => h.abort());

    await pollsCompleted(h, 3);
    await h.abort();

    assert.equal(h.accessory.getServiceById(Service.Valve, "700002"), undefined, "the disabled zone's valve is pruned");
    assert.ok((h.accessory.context as HydrawiseAccessoryContext).zones?.some(zone => zone.relayId === 700002), "while the roster keeps the zone");
    assert.equal(h.flushes().length, 1, "and the prune saves the accessory once, the polls after it saving nothing");
  });
});
