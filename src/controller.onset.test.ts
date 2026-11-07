/* Copyright(C) 2017-2026, HJD (https://github.com/hjdhjd). All rights reserved.
 *
 * controller.onset.test.ts: HomeKit set-handler behavior on the HydrawiseController valves, the suspend switch and the irrigation system, driven through the
 * captured onSet handlers. Covers the manual run and stop commands and their recorded setzone parameters, the system in-use collapse when the only running zone
 * stops, the command-failure revert and the irrigation system's write revert with the shutdown lifetime each answers to, the zero-duration guard, and the suspend /
 * resume commands including the floored suspend timestamp assertion (the bug 14 fix). Every row reads what a command did once the controller's command queue has
 * fallen idle.
 */

// The Hydrawise API wire shapes use snake_case keys such as relay_id and controller_id, so camelcase is disabled here to let these literals mirror the wire verbatim.
/* eslint-disable camelcase */
import { Characteristic, Service, advanceThroughPolls, buildController, crossRevertDelay } from "./testing/platform.helpers.ts";
import { HYDRAWISE_REVERT_DELAY, HYDRAWISE_SUSPEND_DURATION } from "./settings.ts";
import type { HydrawiseZoneConfig, StatusScheduleResponse } from "./types.ts";
import { advanceUntil, expectAt, loggedAt, present, settle, settleUntil, triggerSet } from "homebridge-plugin-utils/testing";
import { describe, test } from "node:test";
import { makeStatusSchedule, makeZone } from "./api.helpers.ts";
import type { BuildControllerResult } from "./testing/platform.helpers.ts";
import type { Service as HapService } from "homebridge";
import assert from "node:assert/strict";
import { bareSensors } from "./api.fixtures.ts";

// A wire-realistic status body, so a row that wants a later poll steps the controller's clock across the sleep the wire asks for.
function schedule(zones: HydrawiseZoneConfig[]): StatusScheduleResponse {

  return makeStatusSchedule({ relays: zones, sensors: bareSensors });
}

// The valve the first poll hosts for zone 700001. The first poll goes out as the controller is built and lands within turns, so nothing waits on the clock for it.
async function firstValve(h: BuildControllerResult): Promise<HapService> {

  await settleUntil(() => h.accessory.getServiceById(Service.Valve, "700001") !== undefined, { description: "the valve for zone 700001 to appear" });

  return present(h.accessory.getServiceById(Service.Valve, "700001"), "the valve for zone 700001");
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
    }, signalAborted: false });

    t.after(() => h.abort());

    const valve = await firstValve(h);

    await triggerSet(valve.getCharacteristic(Characteristic.Active), Characteristic.Active.ACTIVE);
    await h.controller.commandsIdle;

    const command = expectAt(h.commands.params, 0, "setzone call");

    assert.equal(command["action"], "run", "a manual start should send the run action");
    assert.equal(command["relay_id"], "700001", "the run command should target the zone relay");
    assert.equal(command["custom"], "480", "the run command should carry the scheduled duration");
    assert.equal(command["period_id"], "999", "the run command should use the manual period id");
  });

  test("a manual stop sends the stop command for the zone", async (t) => {

    const h = buildController({ program: (recorder) => {

      recorder.programDefault("statusschedule.php", { body: schedule([runningZone()]), kind: "response" });
    }, signalAborted: false });

    t.after(() => h.abort());

    const valve = await firstValve(h);

    await triggerSet(valve.getCharacteristic(Characteristic.Active), Characteristic.Active.INACTIVE);
    await h.controller.commandsIdle;

    const command = expectAt(h.commands.params, 0, "setzone call");

    assert.equal(command["action"], "stop", "a manual stop should send the stop action");
    assert.equal(command["relay_id"], "700001", "the stop command should target the zone relay");
    assert.equal(command["custom"], undefined, "a stop command carries no custom duration");
  });

  test("stopping the only running zone collapses the system to not in use", async (t) => {

    const h = buildController({ program: (recorder) => {

      recorder.programDefault("statusschedule.php", { body: schedule([runningZone()]), kind: "response" });
    }, signalAborted: false });

    t.after(() => h.abort());

    const valve = await firstValve(h);

    await triggerSet(valve.getCharacteristic(Characteristic.Active), Characteristic.Active.INACTIVE);
    await h.controller.commandsIdle;

    const irrigation = h.accessory.getService(Service.IrrigationSystem);

    assert.ok(irrigation, "the irrigation system service should exist");
    assert.equal(irrigation.getCharacteristic(Characteristic.InUse).value, Characteristic.InUse.NOT_IN_USE,
      "stopping the last running zone leaves the system not in use");
  });

  test("a manual run holds program mode across polls that still report the zone running", async (t) => {

    const h = buildController({ program: (recorder) => {

      recorder.program("statusschedule.php", { body: schedule([scheduledZone()]), kind: "response" });
      recorder.programDefault("statusschedule.php", { body: schedule([runningZone()]), kind: "response" });
    }, signalAborted: false });

    t.after(() => h.abort());

    const valve = await firstValve(h);
    const irrigation = h.accessory.getService(Service.IrrigationSystem);

    assert.ok(irrigation, "the irrigation system service should exist");
    await triggerSet(valve.getCharacteristic(Characteristic.Active), Characteristic.Active.ACTIVE);
    await h.controller.commandsIdle;

    assert.equal(irrigation.getCharacteristic(Characteristic.ProgramMode).value, Characteristic.ProgramMode.PROGRAM_SCHEDULED_MANUAL_MODE,
      "a manual start puts the controller in manual program mode");

    /* Let the wire confirm the run. Bounding each wait on the poll AFTER the one under test is what makes these assertions mean something: a poll's projection
     * has certainly completed once the next poll has begun, and every call counted from here started after the change that precedes it.
     */
    const afterStart = h.retrieve.callsTo("statusschedule.php").length;

    await advanceThroughPolls(h, afterStart + 1);

    assert.equal(irrigation.getCharacteristic(Characteristic.ProgramMode).value, Characteristic.ProgramMode.PROGRAM_SCHEDULED_MANUAL_MODE,
      "a poll that still reports the zone running leaves the manual activation standing");

    // Then let the run complete on the wire. The zone reporting as not running is the whole trigger for clearing the manual activation - nothing in HomeKit was
    // touched - so program mode returns to the schedule on its own.
    h.retrieve.programDefault("statusschedule.php", { body: schedule([scheduledZone()]), kind: "response" });

    const afterCompletion = h.retrieve.callsTo("statusschedule.php").length;

    await advanceThroughPolls(h, afterCompletion + 1);

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
    }, signalAborted: false });

    t.after(() => h.abort());

    const valve = await firstValve(h);
    const irrigation = h.accessory.getService(Service.IrrigationSystem);

    assert.ok(irrigation, "the irrigation system service should exist");

    // The vanish poll prunes the target's ledger entry and removes its valve, while the sibling keeps both of its own.
    await advanceUntil(h.clock, () => h.accessory.getServiceById(Service.Valve, "700001") === undefined, { description: "the valve for zone 700001 to be removed" });

    assert.ok(h.accessory.getServiceById(Service.Valve, "700002"), "the sibling zone should still be published");
    await assert.doesNotReject(() => triggerSet(valve.getCharacteristic(Characteristic.Active), Characteristic.Active.ACTIVE),
      "a manual start against a dropped zone completes rather than faulting");

    // Bounded on the poll after the one already in flight, so the aggregate read below is certainly a recomputation that ran after the mark.
    const afterStart = h.retrieve.callsTo("statusschedule.php").length;

    await advanceThroughPolls(h, afterStart + 1);

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
    }, signalAborted: false });

    t.after(() => h.abort());

    const valve = await firstValve(h);
    const irrigation = h.accessory.getService(Service.IrrigationSystem);

    assert.ok(irrigation, "the irrigation system service should exist");
    await advanceUntil(h.clock, () => h.accessory.getServiceById(Service.Valve, "700001") === undefined, { description: "the valve for zone 700001 to be removed" });

    assert.ok(h.accessory.getServiceById(Service.Valve, "700002"), "the sibling zone should still be published");
    await assert.doesNotReject(() => triggerSet(valve.getCharacteristic(Characteristic.Active), Characteristic.Active.INACTIVE),
      "a manual stop against a dropped zone completes rather than faulting");

    assert.equal(irrigation.getCharacteristic(Characteristic.ProgramMode).value, Characteristic.ProgramMode.PROGRAM_SCHEDULED,
      "the handler's own recomputation over the sibling's domain leaves the controller on its schedule");
  });

  test("a failed command reverts the valve state after the revert delay", async (t) => {

    const h = buildController({ program: (recorder) => {

      recorder.programDefault("statusschedule.php", { body: schedule([scheduledZone()]), kind: "response" });
    }, signalAborted: false });

    t.after(() => h.abort());

    const valve = await firstValve(h);

    h.commands.programDefault({ reason: "Hydrawise API rate limit has been exceeded.", status: "failed" });

    await triggerSet(valve.getCharacteristic(Characteristic.Active), Characteristic.Active.ACTIVE);
    await h.controller.commandsIdle;

    // The record and the poll count are taken once the command has failed, so what follows is measured from the failure.
    h.accessory.clearObservations();

    const pollsAtTap = h.retrieve.callsTo("statusschedule.php").length;

    // The failed command schedules a HYDRAWISE_REVERT_DELAY write of what the valve reads, which flips the ACTIVE the tap stored back to INACTIVE when the
    // controller's clock crosses it, and not a millisecond before.
    h.clock.advance(HYDRAWISE_REVERT_DELAY - 1);
    await settle();

    assert.equal(valve.getCharacteristic(Characteristic.Active).value, Characteristic.Active.ACTIVE, "a millisecond short of the delay, the tap's value stands");

    h.clock.advance(1);
    await settle();

    assert.equal(valve.getCharacteristic(Characteristic.Active).value, Characteristic.Active.INACTIVE, "a failed run should revert the valve to inactive");
    assert.ok(loggedAt(h.entries, "error", "Alpha [Zone 1]: Unable to start this zone. Hydrawise API rate limit has been exceeded."),
      "and the failure is said once, naming the zone, what it was asked to do, and why");

    /* Every poll of this scheduled zone writes INACTIVE as well, so the value alone cannot say which write put it there. The revert lands a beat after the tap,
     * well inside the poll cadence, so with no poll fetched since the tap, the one change to Active the record holds is the revert's own.
     */
    assert.equal(h.retrieve.callsTo("statusschedule.php").length, pollsAtTap, "no poll has run since the tap");
    assert.deepEqual(h.accessory.changesOn(valve, Characteristic.Active).map(change => change.newValue), [Characteristic.Active.INACTIVE],
      "the change that put the valve back is the revert's own write");
  });

  test("a revert pending at shutdown drains, and a set after shutdown sends nothing and reverts nothing", async (t) => {

    const h = buildController({ program: (recorder) => {

      recorder.programDefault("statusschedule.php", { body: schedule([activeSoonZone()]), kind: "response" });
    }, signalAborted: false });

    t.after(() => h.abort());

    const valve = await firstValve(h);
    const active = valve.getCharacteristic(Characteristic.Active);

    h.commands.programDefault({ reason: "Hydrawise API rate limit has been exceeded.", status: "failed" });

    /* Phase one: a failed command schedules a revert, and the platform shuts down while that revert is still pending. Every step here is computed from the
     * production delay rather than restating it - half of it lands the abort squarely inside the window, and a few multiples of it cross well past the beat the
     * revert would have fired on. The revert writes what the valve reads, which for this zone is the ACTIVE the tap stored, so the clock is what shows the revert
     * left with the shutdown rather than landing on a value it could not move.
     */
    await triggerSet(active, Characteristic.Active.ACTIVE);
    await h.controller.commandsIdle;

    assert.equal(h.clock.nextDeadline, HYDRAWISE_REVERT_DELAY, "the failed command armed its revert, the next deadline on the controller's clock");

    h.clock.advance(HYDRAWISE_REVERT_DELAY / 2);
    await h.abort();
    await settle();

    assert.equal(h.clock.pending, 0, "the shutdown drained the revert with the platform's timers and ended the poll's sleep, so nothing is left to land");

    h.clock.advance(HYDRAWISE_REVERT_DELAY * 3);
    await settle();

    assert.equal(h.commands.calls.length, 1, "the failed command reached the wire, so a revert was genuinely scheduled");
    assert.equal(active.value, Characteristic.Active.ACTIVE, "a revert pending when the platform shuts down drains instead of landing");

    // Phase two: the platform is down, so the queue takes no new command at all, and the value HomeKit stored is left as it stands.
    await triggerSet(active, Characteristic.Active.INACTIVE);
    await h.controller.commandsIdle;
    h.clock.advance(HYDRAWISE_REVERT_DELAY * 3);
    await settle();

    assert.equal(h.commands.calls.length, 1, "a set after shutdown sends nothing");
    assert.equal(active.value, Characteristic.Active.INACTIVE, "and nothing writes over what HomeKit stored");
    assert.equal(h.clock.pending, 0, "with nothing armed on the clock to write over it later");
  });

  test("an irrigation system revert pending at shutdown drains, leaving the write HomeKit made", async (t) => {

    const h = buildController({ program: (recorder) => {

      recorder.programDefault("statusschedule.php", { body: schedule([scheduledZone()]), kind: "response" });
    }, signalAborted: false });

    t.after(() => h.abort());

    await firstValve(h);

    const active = present(h.accessory.getService(Service.IrrigationSystem), "the irrigation system").getCharacteristic(Characteristic.Active);

    /* A write to the irrigation system's Active has nothing to command, so it is accepted and Active is put back after the revert beat, on the platform's timers as
     * every revert is. The platform shuts down halfway through that beat, and a revert that left with the platform's timers never puts Active back, so the
     * INACTIVE HomeKit wrote is what shows it drained, and the clock is what shows the beat it would have fired on was crossed.
     */
    await triggerSet(active, Characteristic.Active.INACTIVE);

    assert.equal(h.clock.nextDeadline, HYDRAWISE_REVERT_DELAY, "the write armed its revert, the next deadline on the controller's clock");

    h.clock.advance(HYDRAWISE_REVERT_DELAY / 2);
    await h.abort();
    await settle();

    assert.equal(h.clock.pending, 0, "the shutdown drained the revert with the platform's timers and ended the poll's sleep, so nothing is left to land");

    h.clock.advance(HYDRAWISE_REVERT_DELAY * 3);
    await settle();

    assert.equal(active.value, Characteristic.Active.INACTIVE, "a revert pending when the platform shuts down drains instead of putting Active back");
    assert.deepEqual([ h.clock.now(), h.clock.pending ], [ (HYDRAWISE_REVERT_DELAY / 2) + (HYDRAWISE_REVERT_DELAY * 3), 0 ],
      "across a span well past the beat the revert would have fired on, with nothing armed after it");
  });

  test("a run with no duration to give is no command, and the valve is put back without a word", async (t) => {

    // A zone with no scheduled run carries a SetDuration of zero, so a tap on its valve asks for a run of no length at all, which the guard declines before
    // anything is queued.
    const h = buildController({ program: (recorder) => {

      recorder.programDefault("statusschedule.php", { body: schedule([makeZone({ name: "Alpha", relay: 1, relay_id: 700001, run: 0, time: 68000, timestr: "16:00" })]),
        kind: "response" });
    }, signalAborted: false });

    t.after(() => h.abort());

    const valve = await firstValve(h);

    await triggerSet(valve.getCharacteristic(Characteristic.Active), Characteristic.Active.ACTIVE);
    await h.controller.commandsIdle;
    await crossRevertDelay(h.clock);

    assert.equal(valve.getCharacteristic(Characteristic.Active).value, Characteristic.Active.INACTIVE, "the valve is put back once the revert delay passes");
    assert.equal(h.commands.calls.length, 0, "a run of no length sends nothing");
    assert.equal(h.entries.filter(line => line.level === "error").length, 0, "and says nothing, since nothing was asked of Hydrawise");
  });

  test("the suspend command floors its timestamp to a whole second (the bug 14 fix)", async (t) => {

    const h = buildController({ program: (recorder) => {

      recorder.programDefault("statusschedule.php", { body: schedule([runningZone()]), kind: "response" });
    }, signalAborted: false, userOptions: ["Enable.Device.Suspend.All.SN0A1B2C3D4"] });

    t.after(() => h.abort());

    // Wait until the first poll has run so the switch reflects live state, then drive the suspend.
    await firstValve(h);

    const suspend = h.accessory.getServiceById(Service.Switch, "All");

    assert.ok(suspend, "the suspend switch should exist");

    /* The production timestamp is the controller's clock floored to a whole second plus HYDRAWISE_SUSPEND_DURATION - the one-year offset added onto a whole-second
     * floor. The clock is stepped to the middle of a second first, well short of the next poll's sleep, so a timestamp left unfloored would carry the fraction. We
     * bracket the invocation with before and after reads of that clock floored the same way: the captured custom param must be an integer inside the bracket.
     */
    h.clock.advance(1500);

    const before = h.clock.now();

    await triggerSet(suspend.getCharacteristic(Characteristic.On), true);
    await h.controller.commandsIdle;

    const after = h.clock.now();
    const command = expectAt(h.commands.params, 0, "setzone call");

    assert.equal(command["action"], "suspendall", "the suspend should send the suspendall action");
    assert.equal(command["period_id"], "999", "the suspend should use the manual period id");
    assert.equal(command["relay_id"], undefined, "a controller-wide suspend carries no relay id");

    const custom = Number(command["custom"]);
    const low = Math.floor(before / 1000) + HYDRAWISE_SUSPEND_DURATION;
    const high = Math.floor(after / 1000) + HYDRAWISE_SUSPEND_DURATION;

    assert.ok((custom >= low) && (custom <= high), "the floored suspend timestamp lies in the whole-second before/after bracket");
    assert.equal(custom % 1, 0, "the suspend timestamp is floored to a whole second");
  });

  test("a suspend command rejected by the API reverts the switch and logs the failure", async (t) => {

    const h = buildController({ program: (recorder) => {

      recorder.programDefault("statusschedule.php", { body: schedule([runningZone()]), kind: "response" });
    }, signalAborted: false, userOptions: ["Enable.Device.Suspend.All.SN0A1B2C3D4"] });

    t.after(() => h.abort());

    h.commands.programDefault({ reason: "denied", status: "refused" });

    // Wait until the first poll has run, so the controller answers HomeKit, then drive the suspend.
    await firstValve(h);

    const suspend = h.accessory.getServiceById(Service.Switch, "All");

    assert.ok(suspend, "the suspend switch should exist");
    await triggerSet(suspend.getCharacteristic(Characteristic.On), true);
    await h.controller.commandsIdle;

    // The record and the poll count are taken once the command has been refused, so what follows is measured from the refusal.
    h.accessory.clearObservations();

    const pollsAtTap = h.retrieve.callsTo("statusschedule.php").length;

    // A refusal schedules the revert-delay write of what the switch reads, which flips the true the tap stored back off when the controller's clock crosses it.
    await crossRevertDelay(h.clock);

    assert.equal(suspend.getCharacteristic(Characteristic.On).value, false, "the switch is put back once the revert delay passes");
    assert.ok(loggedAt(h.entries, "error", "Unable to complete the suspend request"), "the suspend failure should be logged");

    /* Every poll writes the switch's own reading as well, which for a running zone is off, so the value alone cannot say which write put it there. The revert
     * lands a beat after the tap, well inside the poll cadence, so with no poll fetched since the tap, the one change to On the record holds is the revert's own.
     */
    assert.equal(h.retrieve.callsTo("statusschedule.php").length, pollsAtTap, "no poll has run since the tap");
    assert.deepEqual(h.accessory.changesOn(suspend, Characteristic.On).map(change => change.newValue), [false],
      "the change that put the switch back is the revert's own write");
  });

  test("a suspend command with a malformed API response logs the read failure and reverts", async (t) => {

    const h = buildController({ program: (recorder) => {

      recorder.programDefault("statusschedule.php", { body: schedule([runningZone()]), kind: "response" });
    }, signalAborted: false, userOptions: ["Enable.Device.Suspend.All.SN0A1B2C3D4"] });

    t.after(() => h.abort());

    // A reply carrying no verdict the platform could read is unreadable.
    h.commands.programDefault({ reason: "The answer from Hydrawise could not be read.", status: "unreadable" });

    // Wait until the first poll has run, so the controller answers HomeKit, then drive the suspend.
    await firstValve(h);

    const suspend = h.accessory.getServiceById(Service.Switch, "All");

    assert.ok(suspend, "the suspend switch should exist");
    await triggerSet(suspend.getCharacteristic(Characteristic.On), true);
    await h.controller.commandsIdle;
    await crossRevertDelay(h.clock);

    assert.equal(suspend.getCharacteristic(Characteristic.On).value, false, "the switch is put back once the revert delay passes");
    assert.ok(loggedAt(h.entries, "error", "Unable to retrieve the result of the suspend request"), "the malformed suspend response should be logged");
    assert.equal(h.commands.calls.length, 1, "and a reply that could not be read is not resent");
  });

  test("a resume command sends suspendall with the current-time offset", async (t) => {

    const h = buildController({ program: (recorder) => {

      recorder.programDefault("statusschedule.php", { body: schedule([runningZone()]), kind: "response" });
    }, signalAborted: false, userOptions: ["Enable.Device.Suspend.All.SN0A1B2C3D4"] });

    t.after(() => h.abort());

    await firstValve(h);

    const suspend = h.accessory.getServiceById(Service.Switch, "All");

    assert.ok(suspend, "the suspend switch should exist");

    // The clock is stepped to the middle of a second, short of the next poll's sleep, so a timestamp that is not the floored whole second reads outside the bracket.
    h.clock.advance(1500);

    const before = h.clock.now();

    await triggerSet(suspend.getCharacteristic(Characteristic.On), false);
    await h.controller.commandsIdle;

    const after = h.clock.now();
    const command = expectAt(h.commands.params, 0, "setzone call");
    const custom = Number(command["custom"]);

    assert.equal(command["action"], "suspendall", "a resume also sends the suspendall action");
    assert.ok((custom >= Math.floor(before / 1000)) && (custom <= Math.floor(after / 1000)), "a resume timestamp is the current whole second, no one-year offset");
  });
});
