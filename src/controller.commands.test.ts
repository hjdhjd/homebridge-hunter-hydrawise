/* Copyright(C) 2017-2026, HJD (https://github.com/hjdhjd). All rights reserved.
 *
 * controller.commands.test.ts: The controller's command queue, driven through the controls a user commands Hydrawise with - the Suspend All switch, a zone's valve,
 * and the MQTT set - against the platform double's command double, which can hold a command in flight until a row releases it. Covers what the queue promises:
 * a write that returns before its command is answered, the latest choice alone sent behind a command in flight, a reversal that sends nothing, a poll that cannot
 * move a control off a pending choice, a refusal that speaks only for the latest choice, the choice waiting behind a refused or unanswered command sent and a tap
 * back to that command's value sent too, a tap away and back behind a refused command that sends nothing further, a tap back sent while a resend waits for admission
 * or while the choice behind an unanswered command waits, the resend a timeout earns with one command still in flight and the warning when none is answered, a
 * failure that is not resent, the silence after shutdown, the order of the latest taps, the withdrawal of a command still waiting for admission, the drop of a command
 * whose controller stopped responding, an MQTT start that moves the valve as a tap does and survives a Suspend All confirmed over a wire reporting no zones, and a
 * valve run whose reply could not be read.
 */

// The Hydrawise API wire shapes use snake_case keys such as relay_id and controller_id, so camelcase is disabled here to let these literals mirror the wire verbatim.
/* eslint-disable camelcase */
import type { BuildControllerOptions, BuildControllerResult } from "./testing/platform.helpers.ts";
import { Characteristic, Service, advanceThroughPolls, buildController, crossRevertDelay, makeV2Facts, pollSleep } from "./testing/platform.helpers.ts";
import type { HydrawiseCommandOutcome, HydrawiseZoneConfig, StatusScheduleResponse } from "./types.ts";
import { describe, test } from "node:test";
import { logCount, loggedAt, present, settle, settleUntil, triggerGet, triggerSet } from "homebridge-plugin-utils/testing";
import { makeStatusSchedule, makeZone } from "./api.helpers.ts";
import { HYDRAWISE_COMMAND_ATTEMPTS } from "./settings.ts";
import type { Service as HapService } from "homebridge";
import assert from "node:assert/strict";
import { bareSensors } from "./api.fixtures.ts";

const SUSPEND_ALL_ON = "Enable.Device.Suspend.All.SN0A1B2C3D4";

// A zone running now, so the wire reads the account as not suspended and the Suspend All switch reads off with nothing pending.
function runningZone(): HydrawiseZoneConfig {

  return makeZone({ name: "Alpha", relay: 1, relay_id: 700001, run: 600, time: 1, timestr: "" });
}

// A zone scheduled well outside the active window, so the wire reads its valve inactive with nothing pending.
function scheduledZone(): HydrawiseZoneConfig {

  return makeZone({ name: "Bravo", relay: 2, relay_id: 700002, run: 480, time: 68000, timestr: "16:00" });
}

// A wire-realistic status body carrying the given zones and a sensor block covering nothing, so a row that wants a later poll steps the controller's clock across
// the sleep the wire asks for.
function schedule(zones: HydrawiseZoneConfig[]): StatusScheduleResponse {

  return makeStatusSchedule({ relays: zones, sensors: bareSensors });
}

// The sleep between polls of that body, the one entry a controller with nothing else pending holds on its clock.
const sleep = pollSleep(schedule([]));

/* A controller with the Suspend All switch, polling a running zone and a scheduled one on a clock the row steps, once its first poll has landed and the switch
 * answers HomeKit. The first poll goes out as the controller is built and lands within turns, so nothing waits on the clock for it.
 */
async function suspendAllController(options: BuildControllerOptions = {}): Promise<{ h: BuildControllerResult; valve: HapService;
  suspend: HapService; }> {

  const h = buildController({ program: (recorder) => recorder.programDefault("statusschedule.php",
    { body: schedule([ runningZone(), scheduledZone() ]), kind: "response" }), signalAborted: false, userOptions: [SUSPEND_ALL_ON], ...options });

  await settleUntil(() => (h.accessory.getServiceById(Service.Valve, "700002") !== undefined) && (h.accessory.getServiceById(Service.Switch, "All") !== undefined),
    { description: "the valve for zone 700002 and the suspend-all switch to appear" });

  return { h, suspend: present(h.accessory.getServiceById(Service.Switch, "All"), "the suspend-all switch"),
    valve: present(h.accessory.getServiceById(Service.Valve, "700002"), "the valve for zone 700002") };
}

// The Suspend All commands the controller sent, in order, as the direction each went: a suspension runs past the instant the controller's clock reads, and a
// resume carries that instant itself.
function suspendAlls(h: BuildControllerResult): string[] {

  return h.commands.params.filter(params => params["action"] === "suspendall").map(params => (Number(params["custom"]) > (h.clock.now() / 1000)) ? "suspend" : "resume");
}

/* Put a Suspend All in flight and take the switch back while it is, answer the Suspend All with the given outcome, and tap the switch on again before the choice
 * waiting behind it is sent: a valve run, tapped while the Suspend All was in flight, goes ahead of that choice and is held, so the last tap lands while it waits.
 * The controller is idle by the time this returns.
 */
async function tapBackBehind(outcome: HydrawiseCommandOutcome): Promise<{ h: BuildControllerResult; suspend: HapService }> {

  const { h, suspend, valve } = await suspendAllController();
  const first = h.commands.hold();

  await triggerSet(suspend.getCharacteristic(Characteristic.On), true);
  await first.reached;
  await triggerSet(valve.getCharacteristic(Characteristic.Active), Characteristic.Active.ACTIVE);
  await triggerSet(suspend.getCharacteristic(Characteristic.On), false);

  const run = h.commands.hold();

  first.release(outcome);
  await run.reached;
  await triggerSet(suspend.getCharacteristic(Characteristic.On), true);
  run.release();
  await h.controller.commandsIdle;

  return { h, suspend };
}

describe("HydrawiseController command queue", () => {

  test("a write returns while its command is still in flight", async (t) => {

    const { h, suspend } = await suspendAllController();

    t.after(() => h.abort());

    const held = h.commands.hold();
    const write = triggerSet(suspend.getCharacteristic(Characteristic.On), true).then(() => "returned");

    // A write that returns at once settles within a turn or two, while the command it answers stays held in flight until the row releases it.
    assert.equal(await Promise.race([ write, settle(2).then(() => "held") ]), "returned", "HomeKit's write returns without waiting on Hydrawise");

    await held.reached;
    held.release();
    await h.controller.commandsIdle;

    assert.equal(h.commands.calls.length, 1, "and the command still reaches Hydrawise once");
  });

  test("four alternating taps with the first held in flight send two commands", async (t) => {

    const { h, suspend } = await suspendAllController();

    t.after(() => h.abort());

    const held = h.commands.hold();

    await triggerSet(suspend.getCharacteristic(Characteristic.On), true);
    await held.reached;

    for(const value of [ false, true, false ]) {

      // eslint-disable-next-line no-await-in-loop
      await triggerSet(suspend.getCharacteristic(Characteristic.On), value);
    }

    held.release();
    await h.controller.commandsIdle;

    assert.deepEqual(suspendAlls(h), [ "suspend", "resume" ], "the command in flight, then the latest choice behind it");
    assert.equal(await triggerGet(suspend.getCharacteristic(Characteristic.On)), false, "and the switch reads the latest choice");
  });

  test("a reversal before sending sends nothing", async (t) => {

    const { h, suspend, valve } = await suspendAllController();

    t.after(() => h.abort());

    // A valve run holds the one command in flight, so the Suspend All taps below wait their turn and never reach the wire before the second one reverses the first.
    const held = h.commands.hold();

    await triggerSet(valve.getCharacteristic(Characteristic.Active), Characteristic.Active.ACTIVE);
    await held.reached;
    await triggerSet(suspend.getCharacteristic(Characteristic.On), true);
    await triggerSet(suspend.getCharacteristic(Characteristic.On), false);

    held.release();
    await h.controller.commandsIdle;

    assert.deepEqual(suspendAlls(h), [], "a choice taken back before its turn sends nothing");
    assert.equal(h.commands.calls.length, 1, "while the valve's run went out as asked");
  });

  test("a poll landing while a choice waits leaves the switch on it", async (t) => {

    const { h, suspend } = await suspendAllController();

    t.after(() => h.abort());

    const held = h.commands.hold();

    await triggerSet(suspend.getCharacteristic(Characteristic.On), true);
    await held.reached;
    await advanceThroughPolls(h, h.retrieve.callsTo("statusschedule.php").length + 1);

    // The wire still reports a zone running, which reads the account as not suspended, and every poll writes the switch from its reader.
    assert.equal(suspend.getCharacteristic(Characteristic.On).value, true, "the poll writes the pending choice rather than the wire's reading");

    held.release();
    await h.controller.commandsIdle;
  });

  test("a refused command superseded by a newer choice re-renders nothing and says nothing", async (t) => {

    const { h, suspend } = await suspendAllController();

    t.after(() => h.abort());

    const held = h.commands.hold();

    await triggerSet(suspend.getCharacteristic(Characteristic.On), true);
    await held.reached;
    await triggerSet(suspend.getCharacteristic(Characteristic.On), false);

    held.release({ reason: "denied", status: "refused" });
    await h.controller.commandsIdle;

    assert.equal(h.entries.filter(line => line.level === "error").length, 0, "a refusal the user has already moved past is not news");
    assert.deepEqual(suspendAlls(h), [ "suspend", "resume" ], "and the newer choice is sent as asked");
  });

  test("a tap back to a refused command's value, made before the newer choice behind it is sent, is sent too", async (t) => {

    const { h, suspend } = await tapBackBehind({ reason: "denied", status: "refused" });

    t.after(() => h.abort());

    assert.deepEqual(suspendAlls(h), [ "suspend", "suspend" ], "the refused suspend, then the suspend the last tap asked for");
    assert.equal(await triggerGet(suspend.getCharacteristic(Characteristic.On)), true, "and the switch reads the last tap");
    assert.equal(h.entries.filter(line => [ "error", "warn" ].includes(line.level)).length, 0, "a refusal the user has moved past is not news");
  });

  test("a tap back to a timed-out command's value, made before the newer choice behind it is sent, is sent too", async (t) => {

    const { h, suspend } = await tapBackBehind({ status: "timeout" });

    t.after(() => h.abort());

    assert.deepEqual(suspendAlls(h), [ "suspend", "suspend" ], "the unanswered suspend, then the suspend the last tap asked for");
    assert.equal(await triggerGet(suspend.getCharacteristic(Characteristic.On)), true, "and the switch reads the last tap");
    assert.equal(h.entries.filter(line => [ "error", "warn" ].includes(line.level)).length, 0, "a timeout the user has moved past is not news");
  });

  test("a tap away and back, made while the choice behind a refused command waits, sends nothing further", async (t) => {

    const { h, suspend, valve } = await suspendAllController();

    t.after(() => h.abort());

    const first = h.commands.hold();

    await triggerSet(suspend.getCharacteristic(Characteristic.On), true);
    await first.reached;
    await triggerSet(valve.getCharacteristic(Characteristic.Active), Characteristic.Active.ACTIVE);
    await triggerSet(suspend.getCharacteristic(Characteristic.On), false);

    // The valve run goes ahead of the choice the refusal put back in line and is held, so the taps below land while that choice waits.
    const run = h.commands.hold();

    first.release({ reason: "denied", status: "refused" });
    await run.reached;
    await triggerSet(suspend.getCharacteristic(Characteristic.On), true);
    await triggerSet(suspend.getCharacteristic(Characteristic.On), false);

    run.release();
    await h.controller.commandsIdle;

    assert.deepEqual(suspendAlls(h), ["suspend"], "a refused command never took, so returning to what the switch first showed is a reversal");
    assert.equal(await triggerGet(suspend.getCharacteristic(Characteristic.On)), false, "and the switch reads the last tap");
  });

  test("a tap back while a resend waits for admission is sent, because the unanswered command may have taken", async (t) => {

    const { h, suspend } = await suspendAllController();

    t.after(() => h.abort());

    h.commands.program({ status: "timeout" });

    const resend = h.commands.hold({ admission: true });

    await triggerSet(suspend.getCharacteristic(Characteristic.On), true);
    await resend.reached;
    await triggerSet(suspend.getCharacteristic(Characteristic.On), false);
    await h.controller.commandsIdle;

    assert.deepEqual(suspendAlls(h), [ "suspend", "suspend", "resume" ], "the unanswered suspend, its withdrawn resend, then the resume the tap back asked for");
    assert.equal(await triggerGet(suspend.getCharacteristic(Characteristic.On)), false, "and the switch reads the tap back");
    assert.equal(h.entries.filter(line => [ "error", "warn" ].includes(line.level)).length, 0, "a withdrawal is not news");
  });

  test("a tap back to what the switch first showed, made while the choice behind an unanswered command waits, is sent too", async (t) => {

    const { h, suspend, valve } = await suspendAllController();

    t.after(() => h.abort());

    const first = h.commands.hold();

    await triggerSet(suspend.getCharacteristic(Characteristic.On), true);
    await first.reached;
    await triggerSet(valve.getCharacteristic(Characteristic.Active), Characteristic.Active.ACTIVE);
    await triggerSet(suspend.getCharacteristic(Characteristic.On), false);

    // The valve run goes ahead of the choice the timeout put back in line and is held, so both taps below land while that choice waits.
    const run = h.commands.hold();

    first.release({ status: "timeout" });
    await run.reached;
    await triggerSet(suspend.getCharacteristic(Characteristic.On), true);
    await triggerSet(suspend.getCharacteristic(Characteristic.On), false);

    run.release();
    await h.controller.commandsIdle;

    assert.deepEqual(suspendAlls(h), [ "suspend", "resume" ], "the suspend may have taken, so the last tap is sent rather than read as a reversal");
    assert.equal(await triggerGet(suspend.getCharacteristic(Characteristic.On)), false, "and the switch reads the last tap");
  });

  test("a timeout resent while another command waits keeps one command in flight", async (t) => {

    const { h, suspend, valve } = await suspendAllController();

    t.after(() => h.abort());

    const first = h.commands.hold();

    await triggerSet(suspend.getCharacteristic(Characteristic.On), true);
    await first.reached;
    await triggerSet(valve.getCharacteristic(Characteristic.Active), Characteristic.Active.ACTIVE);

    const resend = h.commands.hold();

    first.release({ status: "timeout" });
    await resend.reached;

    // The queue sends on promises alone, so the turns that would carry the run out beside the resend pass here.
    await settle();

    assert.deepEqual(h.commands.params.map(params => params["action"]), [ "suspendall", "suspendall" ], "the resend is the one command in flight, the run behind it");
    assert.deepEqual([ h.clock.pending, h.clock.nextDeadline ], [ 1, sleep ], "with the next poll's sleep the one entry on the clock, so no send waits on a step");

    resend.release();
    await h.controller.commandsIdle;

    assert.deepEqual(h.commands.params.map(params => params["action"]), [ "suspendall", "suspendall", "run" ], "and the run goes once the resend is answered");
  });

  test("two timeouts then a confirmation leave the switch on and stamp once", async (t) => {

    const { h, suspend } = await suspendAllController();

    t.after(() => h.abort());

    h.commands.program({ status: "timeout" }, { status: "timeout" });

    // A snapshot requested before the tap, read from the controller's clock on that side of the command.
    const requestedAt = Math.floor(h.clock.now() / 1000);

    await triggerSet(suspend.getCharacteristic(Characteristic.On), true);
    await h.controller.commandsIdle;

    assert.deepEqual(suspendAlls(h), [ "suspend", "suspend", "suspend" ], "an unanswered command is sent again until Hydrawise answers");
    assert.equal(new Set(h.commands.params.map(params => params["custom"])).size, 1, "every resend carries the instant its turn took");
    assert.equal(logCount(h.entries, "info", "Suspending scheduled watering for all zones."), 1, "the confirmation is taken once");
    assert.equal(h.entries.filter(line => line.level === "warn").length, 0, "with nothing to warn about");

    /* The confirmation stamped the record, so a snapshot requested before it leaves the switch on even though the wire reads the account as running. The clock has
     * not moved since the tap, so the snapshot shares the confirmation's own second, the closest a snapshot can come and still not postdate the command.
     */
    h.controller.applyFacts({ facts: makeV2Facts(), fetchedAt: requestedAt });

    assert.equal(await triggerGet(suspend.getCharacteristic(Characteristic.On)), true, "the switch stays on");
  });

  test("an unanswered command warns once after its last attempt and puts the switch back", async (t) => {

    const { h, suspend } = await suspendAllController();

    t.after(() => h.abort());

    h.commands.programDefault({ status: "timeout" });

    await triggerSet(suspend.getCharacteristic(Characteristic.On), true);
    await h.controller.commandsIdle;
    await crossRevertDelay(h.clock);

    assert.equal(suspend.getCharacteristic(Characteristic.On).value, false, "the switch is put back once the revert delay passes");
    assert.equal(h.commands.calls.length, HYDRAWISE_COMMAND_ATTEMPTS, "the command is sent as many times as an unanswered command earns and no more");
    assert.equal(logCount(h.entries, "warn", "All zones: Hydrawise did not answer the suspend command after " + HYDRAWISE_COMMAND_ATTEMPTS.toString() +
      " attempts, so it shows its last confirmed state."), 1, "the warning is said once, counting the attempts it made");
    assert.equal(h.entries.filter(line => line.level === "error").length, 0, "and nothing is reported as a refusal");
  });

  test("a reached rate limit sends once, says so, and puts the switch back", async (t) => {

    const { h, suspend } = await suspendAllController();

    t.after(() => h.abort());

    h.commands.programDefault({ reason: "Hydrawise API rate limit has been exceeded.", status: "failed" });

    await triggerSet(suspend.getCharacteristic(Characteristic.On), true);
    await h.controller.commandsIdle;
    await crossRevertDelay(h.clock);

    assert.equal(suspend.getCharacteristic(Characteristic.On).value, false, "the switch is put back once the revert delay passes");
    assert.equal(h.commands.calls.length, 1, "a failure a resend would only meet again is not resent");
    assert.equal(logCount(h.entries, "error", "Unable to complete the suspend request."), 1, "and the switch says the command did not take");
  });

  test("nothing is sent, stamped, said or written once the platform has shut down", async (t) => {

    const { h, suspend, valve } = await suspendAllController();

    t.after(() => h.abort());

    // The Suspend All is held in flight across the shutdown, with a valve run waiting its turn behind it.
    const held = h.commands.hold();

    await triggerSet(suspend.getCharacteristic(Characteristic.On), true);
    await held.reached;
    await triggerSet(valve.getCharacteristic(Characteristic.Active), Characteristic.Active.ACTIVE);
    await h.abort();

    held.release();
    await h.controller.commandsIdle;

    // The queue sends on promises alone, so the turns that would carry the waiting run out pass here.
    await settle();

    assert.equal(h.commands.calls.length, 1, "the run still waiting its turn is never sent");
    assert.equal(logCount(h.entries, "info", "scheduled watering for all zones"), 0, "a confirmation landing after shutdown is not taken");
    assert.equal(h.entries.filter(line => [ "error", "warn" ].includes(line.level)).length, 0, "and nothing is said");
    assert.equal(suspend.getCharacteristic(Characteristic.On).value, true, "the switch is left where the tap put it");
    assert.equal(h.clock.pending, 0, "with the poll's sleep ended by the shutdown and no write left armed on the clock to land later");
  });

  test("sends follow the order of the latest taps", async (t) => {

    const { h, suspend, valve } = await suspendAllController();

    t.after(() => h.abort());

    // A held stop keeps the one command in flight while the taps below queue behind it. The valve's run, tapped first, is tapped again with a new length after the
    // Suspend All, which moves it behind the Suspend All.
    const held = h.commands.hold();
    const alpha = present(h.accessory.getServiceById(Service.Valve, "700001"), "the valve for zone 700001, which the first poll hosts");

    await triggerSet(alpha.getCharacteristic(Characteristic.Active), Characteristic.Active.INACTIVE);
    await held.reached;
    await triggerSet(valve.getCharacteristic(Characteristic.Active), Characteristic.Active.ACTIVE);
    await triggerSet(suspend.getCharacteristic(Characteristic.On), true);
    valve.updateCharacteristic(Characteristic.SetDuration, 900);
    await triggerSet(valve.getCharacteristic(Characteristic.Active), Characteristic.Active.ACTIVE);

    held.release();
    await h.controller.commandsIdle;

    assert.deepEqual(h.commands.params.slice(1).map(params => params["action"]), [ "suspendall", "run" ], "the Suspend All goes ahead of the run tapped again after it");
    assert.equal(h.commands.params.at(-1)?.["custom"], "900", "and the run carries the length of the latest tap");
  });

  test("a command still waiting for admission is withdrawn by a reversal, and nothing more is sent", async (t) => {

    const { h, suspend } = await suspendAllController();

    t.after(() => h.abort());

    const held = h.commands.hold({ admission: true });

    await triggerSet(suspend.getCharacteristic(Characteristic.On), true);
    await held.reached;
    await triggerSet(suspend.getCharacteristic(Characteristic.On), false);
    await h.controller.commandsIdle;

    assert.equal(h.commands.calls.length, 1, "the waiting command is the only one ever asked for");
    assert.equal(h.commands.calls[0]?.signal?.aborted, true, "and the reversal withdrew it before it was admitted");
    assert.equal(h.entries.filter(line => [ "error", "warn" ].includes(line.level)).length, 0, "a withdrawal is not news");
  });

  test("a command whose controller stopped responding while it waited is dropped, saying why", async (t) => {

    const { h, suspend, valve } = await suspendAllController({ hasV2Client: true });

    t.after(() => h.abort());

    const held = h.commands.hold();

    await triggerSet(valve.getCharacteristic(Characteristic.Active), Characteristic.Active.ACTIVE);
    await held.reached;
    await triggerSet(suspend.getCharacteristic(Characteristic.On), true);

    // The account reports the controller offline while the Suspend All waits its turn.
    h.controller.applyFacts({ facts: makeV2Facts({ online: false }), fetchedAt: Math.floor(h.clock.now() / 1000) });

    held.release();
    await h.controller.commandsIdle;

    assert.deepEqual(suspendAlls(h), [], "the command is not sent to a controller that is not responding");
    assert.ok(loggedAt(h.entries, "warn", "All zones: The suspend command was not sent because the controller is not responding."), "and the drop is said");
  });
});

describe("HydrawiseController valve commands", () => {

  test("an MQTT start moves the valve and is taken as a manual start", async (t) => {

    const { h, valve } = await suspendAllController({ mqtt: true });

    t.after(() => h.abort());

    const held = h.commands.hold();

    await h.mqtt?.invokeSet("controller/set", "start 2 300");

    assert.equal(valve.getCharacteristic(Characteristic.Active).value, Characteristic.Active.ACTIVE, "the valve moves the moment the command is queued");

    await held.reached;
    held.release();
    await h.controller.commandsIdle;

    assert.equal(valve.getCharacteristic(Characteristic.InUse).value, Characteristic.InUse.IN_USE, "and the confirmation shows the water flowing");
    assert.ok(loggedAt(h.entries, "info", "Bravo [Zone 2]: Manually started (duration: 5 minutes)."), "narrated as a manual start");
  });

  test("a Suspend All confirmed while the wire reports no zones leaves an MQTT start queued behind it to be sent", async (t) => {

    const { h, suspend } = await suspendAllController({ mqtt: true });

    t.after(() => h.abort());

    const held = h.commands.hold();

    await triggerSet(suspend.getCharacteristic(Characteristic.On), true);
    await held.reached;
    await h.mqtt?.invokeSet("controller/set", "start 2 300");

    // Every later poll reads this body, so the wire reports no zones from the moment the poll counted here completes.
    h.retrieve.programDefault("statusschedule.php", { body: schedule([]), kind: "response" });
    await advanceThroughPolls(h, h.retrieve.callsTo("statusschedule.php").length + 1);

    held.release();
    await h.controller.commandsIdle;

    assert.deepEqual(h.commands.params.map(params => params["action"]), [ "suspendall", "run" ], "a confirmation weighs nothing against the wire, so each is sent");
    assert.equal(h.commands.params.at(-1)?.["relay_id"], "700002", "the run for the zone it named");
  });

  test("a valve run refused in its reply puts the valve back and says why", async (t) => {

    const { h, valve } = await suspendAllController();

    t.after(() => h.abort());

    h.commands.programDefault({ reason: "Zone is disabled.", status: "refused" });

    await triggerSet(valve.getCharacteristic(Characteristic.Active), Characteristic.Active.ACTIVE);
    await h.controller.commandsIdle;
    await crossRevertDelay(h.clock);

    assert.equal(valve.getCharacteristic(Characteristic.Active).value, Characteristic.Active.INACTIVE, "the valve is put back once the revert delay passes");
    assert.ok(loggedAt(h.entries, "error", "Bravo [Zone 2]: Unable to start this zone. Zone is disabled."), "the refusal names the zone and Hydrawise's reason");
    assert.ok(!loggedAt(h.entries, "info", "Manually started"), "and nothing is narrated as started");
    assert.notEqual(valve.getCharacteristic(Characteristic.InUse).value, Characteristic.InUse.IN_USE, "nor shown as running");
  });

  test("a valve run whose reply cannot be read puts the valve back, names the zone and the reason, and is not sent again", async (t) => {

    const { h, valve } = await suspendAllController();

    t.after(() => h.abort());

    h.commands.programDefault({ reason: "The answer from Hydrawise could not be read.", status: "unreadable" });

    await triggerSet(valve.getCharacteristic(Characteristic.Active), Characteristic.Active.ACTIVE);
    await h.controller.commandsIdle;
    await crossRevertDelay(h.clock);

    assert.equal(valve.getCharacteristic(Characteristic.Active).value, Characteristic.Active.INACTIVE, "the valve is put back once the revert delay passes");
    assert.equal(h.commands.calls.length, 1, "a reply that could not be read is not resent");
    assert.equal(logCount(h.entries, "error", "Bravo [Zone 2]: Unable to start this zone. The answer from Hydrawise could not be read."), 1,
      "the zone's line names the zone and the reason");
    assert.equal(h.entries.filter(line => [ "error", "warn" ].includes(line.level)).length, 1, "and nothing more is said");
  });
});
