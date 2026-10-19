/* Copyright(C) 2017-2026, HJD (https://github.com/hjdhjd). All rights reserved.
 *
 * controller.onset.test.ts: HomeKit set-handler behavior on the HydrawiseController valves and the suspend switch, driven through the captured onSet
 * handlers. Covers the manual run and stop commands and their recorded setzone parameters, the system in-use collapse when the only running zone stops, the
 * command-failure revert and the shutdown lifetime it answers to, and the suspend / resume commands including the floored suspend timestamp assertion (the bug 14 fix).
 */

// The Hydrawise API wire shapes use snake_case keys such as relay_id and controller_id, so camelcase is disabled here to let these literals mirror the wire verbatim.
/* eslint-disable camelcase */
import { Characteristic, Service } from "./testing/hap.helpers.ts";
import { HYDRAWISE_REVERT_DELAY, HYDRAWISE_SUSPEND_DURATION } from "./settings.ts";
import type { HydrawiseZoneConfig, StatusScheduleResponse } from "./types.ts";
import { buildController, waitFor } from "./testing/platform.helpers.ts";
import { describe, test } from "node:test";
import { expectAt, loggedAt, waitUntil } from "homebridge-plugin-utils/testing";
import { fastPolling, makeStatusSchedule, makeZone } from "./api.helpers.ts";
import assert from "node:assert/strict";
import { bareSensors } from "./api.fixtures.ts";
import { setTimeout as delay } from "node:timers/promises";

function schedule(zones: HydrawiseZoneConfig[]): StatusScheduleResponse {

  return fastPolling(makeStatusSchedule({ relays: zones, sensors: bareSensors }));
}

function scheduledZone(): HydrawiseZoneConfig {

  return makeZone({ name: "Alpha", relay: 1, relay_id: 700001, run: 480, time: 68000, timestr: "16:00" });
}

function runningZone(): HydrawiseZoneConfig {

  return makeZone({ name: "Alpha", relay: 1, relay_id: 700001, run: 600, time: 1, timestr: "" });
}

// A zone queued to run inside the active window, so every poll of it writes the same ACTIVE the optimistic set writes. The shutdown assertion below works from this
// shape deliberately: with the polling cadence unable to move the characteristic, a value that changes across the settle wait can only be a revert landing.
function activeSoonZone(): HydrawiseZoneConfig {

  return makeZone({ name: "Alpha", relay: 1, relay_id: 700001, run: 480, time: 1800, timestr: "16:30" });
}

// A second zone that every poll keeps reporting. The stale-tap scenarios below drop the first zone alone, so this one holds the enabled projection non-empty.
function siblingZone(): HydrawiseZoneConfig {

  return makeZone({ name: "Bravo", relay: 2, relay_id: 700002, run: 480, time: 68000, timestr: "16:00" });
}

describe("HydrawiseController valve and suspend onSet", () => {

  test("a manual run sends the run command with the custom duration and manual period", async (t) => {

    const h = buildController({ program: (recorder) => {

      recorder.programDefault("statusschedule.php", { body: schedule([scheduledZone()]), kind: "response" });
      recorder.programDefault("setzone.php", { body: { message: "", message_type: "info" }, kind: "response" });
    }, signalAborted: false });

    t.after(() => h.abort());

    const valve = await waitFor(() => h.accessory.getServiceById(Service.Valve, "700001"), { description: "the valve for zone 700001 to appear" });

    await valve.getCharacteristic(Characteristic.Active).triggerSet(Characteristic.Active.ACTIVE);

    const command = expectAt(h.retrieve.callsTo("setzone.php"), 0, "setzone call");

    assert.equal(command.params?.["action"], "run", "a manual start should send the run action");
    assert.equal(command.params["relay_id"], "700001", "the run command should target the zone relay");
    assert.equal(command.params["custom"], "480", "the run command should carry the scheduled duration");
    assert.equal(command.params["period_id"], "999", "the run command should use the manual period id");
  });

  test("a manual stop sends the stop command for the zone", async (t) => {

    const h = buildController({ program: (recorder) => {

      recorder.programDefault("statusschedule.php", { body: schedule([runningZone()]), kind: "response" });
      recorder.programDefault("setzone.php", { body: { message: "", message_type: "info" }, kind: "response" });
    }, signalAborted: false });

    t.after(() => h.abort());

    const valve = await waitFor(() => h.accessory.getServiceById(Service.Valve, "700001"), { description: "the valve for zone 700001 to appear" });

    await valve.getCharacteristic(Characteristic.Active).triggerSet(Characteristic.Active.INACTIVE);

    const command = expectAt(h.retrieve.callsTo("setzone.php"), 0, "setzone call");

    assert.equal(command.params?.["action"], "stop", "a manual stop should send the stop action");
    assert.equal(command.params["relay_id"], "700001", "the stop command should target the zone relay");
    assert.equal(command.params["custom"], undefined, "a stop command carries no custom duration");
  });

  test("stopping the only running zone collapses the system to not in use", async (t) => {

    const h = buildController({ program: (recorder) => {

      recorder.programDefault("statusschedule.php", { body: schedule([runningZone()]), kind: "response" });
      recorder.programDefault("setzone.php", { body: { message: "", message_type: "info" }, kind: "response" });
    }, signalAborted: false });

    t.after(() => h.abort());

    const valve = await waitFor(() => h.accessory.getServiceById(Service.Valve, "700001"), { description: "the valve for zone 700001 to appear" });

    await valve.getCharacteristic(Characteristic.Active).triggerSet(Characteristic.Active.INACTIVE);

    const irrigation = h.accessory.getService(Service.IrrigationSystem);

    assert.ok(irrigation, "the irrigation system service should exist");
    assert.equal(irrigation.getCharacteristic(Characteristic.InUse).value, Characteristic.InUse.NOT_IN_USE,
      "stopping the last running zone leaves the system not in use");
  });

  test("a manual run holds program mode across polls that still report the zone running", async (t) => {

    const h = buildController({ program: (recorder) => {

      recorder.program("statusschedule.php", { body: schedule([scheduledZone()]), kind: "response" });
      recorder.programDefault("statusschedule.php", { body: schedule([runningZone()]), kind: "response" });
      recorder.programDefault("setzone.php", { body: { message: "", message_type: "info" }, kind: "response" });
    }, signalAborted: false });

    t.after(() => h.abort());

    const valve = await waitFor(() => h.accessory.getServiceById(Service.Valve, "700001"), { description: "the valve for zone 700001 to appear" });
    const irrigation = h.accessory.getService(Service.IrrigationSystem);

    assert.ok(irrigation, "the irrigation system service should exist");
    await valve.getCharacteristic(Characteristic.Active).triggerSet(Characteristic.Active.ACTIVE);

    assert.equal(irrigation.getCharacteristic(Characteristic.ProgramMode).value, Characteristic.ProgramMode.PROGRAM_SCHEDULED_MANUAL_MODE,
      "a manual start puts the controller in manual program mode");

    /* Let the wire confirm the run. Bounding each wait on the poll AFTER the one under test is what makes these assertions mean something: a poll's projection
     * has certainly completed once the next poll has begun, and every call counted from here started after the change that precedes it.
     */
    const afterStart = h.retrieve.callsTo("statusschedule.php").length;

    await waitUntil(() => h.retrieve.callsTo("statusschedule.php").length > (afterStart + 1), { description: "the second status poll past the start" });

    assert.equal(irrigation.getCharacteristic(Characteristic.ProgramMode).value, Characteristic.ProgramMode.PROGRAM_SCHEDULED_MANUAL_MODE,
      "a poll that still reports the zone running leaves the manual activation standing");

    // Then let the run complete on the wire. The zone reporting as not running is the whole trigger for clearing the manual activation - nothing in HomeKit was
    // touched - so program mode returns to the schedule on its own.
    h.retrieve.programDefault("statusschedule.php", { body: schedule([scheduledZone()]), kind: "response" });

    const afterCompletion = h.retrieve.callsTo("statusschedule.php").length;

    await waitUntil(() => h.retrieve.callsTo("statusschedule.php").length > (afterCompletion + 1), { description: "the second status poll past the completion" });

    assert.equal(irrigation.getCharacteristic(Characteristic.ProgramMode).value, Characteristic.ProgramMode.PROGRAM_SCHEDULED,
      "the wire reporting the zone stopped clears the manual activation and returns program mode to the schedule");
  });

  /* A HomeKit tap that lands after the poll walk has already dropped the zone. HomeKit holds its own view of an accessory, so a tap can arrive against a valve
   * the plugin has already removed, and the handler then addresses the ledger entry that went with it. Marking a missing entry is the silent no-op the ledger
   * states, and the no-throw is this assertion's contract half: an unguarded write would fault right here, inside a set handler HomeKit is awaiting. The program-mode
   * read that follows is corroboration - it shows no phantom manual state outlived the prune, which is what the aggregate would report if one had.
   *
   * Both zones bind on the first poll and the target alone vanishes on the next, so the sibling holds the enabled projection non-empty. A single-zone scenario
   * would land the empty domain's own arm instead - the no-program-scheduled divergence the defects suite asserts - and would be asserting something else.
   */
  test("a manual start on a zone the last poll dropped completes as a no-op on the missing ledger entry", async (t) => {

    const h = buildController({ program: (recorder) => {

      recorder.program("statusschedule.php", { body: schedule([ scheduledZone(), siblingZone() ]), kind: "response" });
      recorder.programDefault("statusschedule.php", { body: schedule([siblingZone()]), kind: "response" });
      recorder.programDefault("setzone.php", { body: { message: "", message_type: "info" }, kind: "response" });
    }, signalAborted: false });

    t.after(() => h.abort());

    const valve = await waitFor(() => h.accessory.getServiceById(Service.Valve, "700001"), { description: "the valve for zone 700001 to appear" });
    const irrigation = h.accessory.getService(Service.IrrigationSystem);

    assert.ok(irrigation, "the irrigation system service should exist");

    // The vanish poll prunes the target's ledger entry and removes its valve, while the sibling keeps both of its own.
    await waitUntil(() => h.accessory.getServiceById(Service.Valve, "700001") === undefined, { description: "the valve for zone 700001 to be removed" });

    assert.ok(h.accessory.getServiceById(Service.Valve, "700002"), "the sibling zone should still be published");
    await assert.doesNotReject(() => valve.getCharacteristic(Characteristic.Active).triggerSet(Characteristic.Active.ACTIVE),
      "a manual start against a dropped zone completes rather than faulting");

    // Bounded on the poll after the one already in flight, so the aggregate read below is certainly a recomputation that ran after the mark.
    const afterStart = h.retrieve.callsTo("statusschedule.php").length;

    await waitUntil(() => h.retrieve.callsTo("statusschedule.php").length > (afterStart + 1), { description: "the second status poll past the start" });

    assert.equal(irrigation.getCharacteristic(Characteristic.ProgramMode).value, Characteristic.ProgramMode.PROGRAM_SCHEDULED,
      "the aggregate recomputes over the sibling's domain alone, so the dropped zone recorded no manual activation");
  });

  /* The same stale tap in the stop direction, where clearing a missing entry takes the no-op path marking one does. The no-throw is again the whole contract
   * half. The program-mode read here is corroboration only, and says so plainly: the stop handler recomputes the aggregate itself, and with the dropped zone
   * outside the enabled projection that recomputation lands on the schedule whether or not the clear found anything to do.
   */
  test("a manual stop on a zone the last poll dropped completes as a no-op on the missing ledger entry", async (t) => {

    const h = buildController({ program: (recorder) => {

      recorder.program("statusschedule.php", { body: schedule([ runningZone(), siblingZone() ]), kind: "response" });
      recorder.programDefault("statusschedule.php", { body: schedule([siblingZone()]), kind: "response" });
      recorder.programDefault("setzone.php", { body: { message: "", message_type: "info" }, kind: "response" });
    }, signalAborted: false });

    t.after(() => h.abort());

    const valve = await waitFor(() => h.accessory.getServiceById(Service.Valve, "700001"), { description: "the valve for zone 700001 to appear" });
    const irrigation = h.accessory.getService(Service.IrrigationSystem);

    assert.ok(irrigation, "the irrigation system service should exist");
    await waitUntil(() => h.accessory.getServiceById(Service.Valve, "700001") === undefined, { description: "the valve for zone 700001 to be removed" });

    assert.ok(h.accessory.getServiceById(Service.Valve, "700002"), "the sibling zone should still be published");
    await assert.doesNotReject(() => valve.getCharacteristic(Characteristic.Active).triggerSet(Characteristic.Active.INACTIVE),
      "a manual stop against a dropped zone completes rather than faulting");

    assert.equal(irrigation.getCharacteristic(Characteristic.ProgramMode).value, Characteristic.ProgramMode.PROGRAM_SCHEDULED,
      "the handler's own recomputation over the sibling's domain leaves the controller on its schedule");
  });

  test("a failed command reverts the valve state after the revert delay", async (t) => {

    const h = buildController({ program: (recorder) => {

      recorder.programDefault("statusschedule.php", { body: schedule([scheduledZone()]), kind: "response" });
      recorder.programDefault("setzone.php", { kind: "null" });
    }, signalAborted: false });

    t.after(() => h.abort());

    const valve = await waitFor(() => h.accessory.getServiceById(Service.Valve, "700001"), { description: "the valve for zone 700001 to appear" });

    await valve.getCharacteristic(Characteristic.Active).triggerSet(Characteristic.Active.ACTIVE);

    // The null command schedules a HYDRAWISE_REVERT_DELAY revert that flips the optimistic ACTIVE back to INACTIVE.
    await waitUntil(() => valve.getCharacteristic(Characteristic.Active).value === Characteristic.Active.INACTIVE, { description: "the valve to read inactive" });

    assert.equal(valve.getCharacteristic(Characteristic.Active).value, Characteristic.Active.INACTIVE, "a failed run should revert the valve to inactive");
  });

  test("a revert pending at shutdown drains, and one scheduled afterward stays inert", async (t) => {

    const h = buildController({ program: (recorder) => {

      recorder.programDefault("statusschedule.php", { body: schedule([activeSoonZone()]), kind: "response" });
      recorder.programDefault("setzone.php", { kind: "null" });
    }, signalAborted: false });

    t.after(() => h.abort());

    const valve = await waitFor(() => h.accessory.getServiceById(Service.Valve, "700001"), { description: "the valve for zone 700001 to appear" });
    const active = valve.getCharacteristic(Characteristic.Active);

    /* Phase one: a failed command schedules a revert, and the platform shuts down while that revert is still pending. Every wait here is computed from the
     * production delay rather than restating it - half of it lands the abort squarely inside the window, and a few multiples of it settle well past the beat the
     * revert would have fired on.
     */
    await active.triggerSet(Characteristic.Active.ACTIVE);
    await delay(HYDRAWISE_REVERT_DELAY / 2);

    h.abort();

    await delay(HYDRAWISE_REVERT_DELAY * 3);

    assert.equal(h.retrieve.callsTo("setzone.php").length, 1, "the failed command reached the wire, so a revert was genuinely scheduled");
    assert.equal(active.value, Characteristic.Active.ACTIVE, "a revert pending when the platform shuts down drains instead of landing");

    // Phase two: the platform is down, so the registry is disposed and the revert this failed command asks for is never armed at all.
    await active.triggerSet(Characteristic.Active.INACTIVE);
    await delay(HYDRAWISE_REVERT_DELAY * 3);

    assert.equal(h.retrieve.callsTo("setzone.php").length, 2, "the second command reached the wire, so the revert site ran again");
    assert.equal(active.value, Characteristic.Active.INACTIVE, "a revert scheduled after shutdown never fires");
  });

  test("the suspend command floors its timestamp to a whole second (the bug 14 fix)", async (t) => {

    const h = buildController({ program: (recorder) => {

      recorder.programDefault("statusschedule.php", { body: schedule([runningZone()]), kind: "response" });
      recorder.programDefault("setzone.php", { body: { message: "", message_type: "info" }, kind: "response" });
    }, signalAborted: false, userOptions: ["Enable.Device.Suspend.All.SN0A1B2C3D4"] });

    t.after(() => h.abort());

    // Wait until the first poll has run so the switch reflects live state, then drive the suspend.
    await waitUntil(() => h.accessory.getServiceById(Service.Valve, "700001") !== undefined, { description: "the valve for zone 700001 to appear" });

    const suspend = h.accessory.getServiceById(Service.Switch, "All");

    assert.ok(suspend, "the suspend switch should exist");

    // The production timestamp is Math.floor(Date.now() / 1000) + HYDRAWISE_SUSPEND_DURATION - the one-year offset added onto a whole-second floor. We bracket the
    // invocation with before/after Date.now() reads floored the same way: the captured custom param must be an integer lying inside the floored bracket.
    const before = Date.now();

    await suspend.getCharacteristic(Characteristic.On).triggerSet(true);

    const after = Date.now();
    const command = expectAt(h.retrieve.callsTo("setzone.php"), 0, "setzone call");

    assert.equal(command.params?.["action"], "suspendall", "the suspend should send the suspendall action");
    assert.equal(command.params["period_id"], "999", "the suspend should use the manual period id");
    assert.equal(command.params["relay_id"], undefined, "a controller-wide suspend carries no relay id");

    const custom = Number(command.params["custom"]);
    const low = Math.floor(before / 1000) + HYDRAWISE_SUSPEND_DURATION;
    const high = Math.floor(after / 1000) + HYDRAWISE_SUSPEND_DURATION;

    assert.ok((custom >= low) && (custom <= high), "the floored suspend timestamp lies in the whole-second before/after bracket");
    assert.equal(custom % 1, 0, "the suspend timestamp is floored to a whole second");
  });

  test("a suspend command rejected by the API reverts the switch and logs the failure", async (t) => {

    const h = buildController({ program: (recorder) => {

      recorder.programDefault("statusschedule.php", { body: schedule([runningZone()]), kind: "response" });
      recorder.programDefault("setzone.php", { body: { message: "denied", message_type: "error" }, kind: "response" });
    }, signalAborted: false, userOptions: ["Enable.Device.Suspend.All.SN0A1B2C3D4"] });

    t.after(() => h.abort());

    await waitUntil(() => h.accessory.getServiceById(Service.Switch, "All") !== undefined, { description: "the suspend-all switch to appear" });

    const suspend = h.accessory.getServiceById(Service.Switch, "All");

    assert.ok(suspend, "the suspend switch should exist");
    await suspend.getCharacteristic(Characteristic.On).triggerSet(true);

    // An error response schedules the 50ms revert that flips the optimistic true back off.
    await waitUntil(() => suspend.getCharacteristic(Characteristic.On).value === false, { description: "the suspend-all switch to read off" });

    assert.ok(loggedAt(h.entries, "error", "Unable to complete the suspend request"), "the suspend failure should be logged");
  });

  test("a suspend command with a malformed API response logs the read failure and reverts", async (t) => {

    const h = buildController({ program: (recorder) => {

      recorder.programDefault("statusschedule.php", { body: schedule([runningZone()]), kind: "response" });
      recorder.programDefault("setzone.php", { kind: "malformed" });
    }, signalAborted: false, userOptions: ["Enable.Device.Suspend.All.SN0A1B2C3D4"] });

    t.after(() => h.abort());

    await waitUntil(() => h.accessory.getServiceById(Service.Switch, "All") !== undefined, { description: "the suspend-all switch to appear" });

    const suspend = h.accessory.getServiceById(Service.Switch, "All");

    assert.ok(suspend, "the suspend switch should exist");
    await suspend.getCharacteristic(Characteristic.On).triggerSet(true);

    await waitUntil(() => suspend.getCharacteristic(Characteristic.On).value === false, { description: "the suspend-all switch to read off" });

    assert.ok(loggedAt(h.entries, "error", "Unable to retrieve the result of the suspend request"), "the malformed suspend response should be logged");
  });

  test("a resume command sends suspendall with the current-time offset", async (t) => {

    const h = buildController({ program: (recorder) => {

      recorder.programDefault("statusschedule.php", { body: schedule([runningZone()]), kind: "response" });
      recorder.programDefault("setzone.php", { body: { message: "", message_type: "info" }, kind: "response" });
    }, signalAborted: false, userOptions: ["Enable.Device.Suspend.All.SN0A1B2C3D4"] });

    t.after(() => h.abort());

    await waitUntil(() => h.accessory.getServiceById(Service.Valve, "700001") !== undefined, { description: "the valve for zone 700001 to appear" });

    const suspend = h.accessory.getServiceById(Service.Switch, "All");

    assert.ok(suspend, "the suspend switch should exist");

    const before = Date.now();

    await suspend.getCharacteristic(Characteristic.On).triggerSet(false);

    const after = Date.now();
    const command = expectAt(h.retrieve.callsTo("setzone.php"), 0, "setzone call");
    const custom = Number(command.params?.["custom"]);

    assert.equal(command.params?.["action"], "suspendall", "a resume also sends the suspendall action");
    assert.ok((custom >= Math.floor(before / 1000)) && (custom <= Math.floor(after / 1000)), "a resume timestamp is the current whole second, no one-year offset");
  });
});
