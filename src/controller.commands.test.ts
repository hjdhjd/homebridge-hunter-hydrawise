/* Copyright(C) 2017-2026, HJD (https://github.com/hjdhjd). All rights reserved.
 *
 * controller.commands.test.ts: The controller's command queue, driven through the controls a user commands Hydrawise with - the Suspend All switch, a zone's valve,
 * and the MQTT set - against the platform double's command double, which can hold a command in flight until a row releases it. Covers what the queue promises:
 * a write that returns before its command is answered, the latest choice alone sent behind a command in flight, a reversal that sends nothing, a poll that cannot
 * move a control off a pending choice, a refusal that speaks only for the latest choice, the choice waiting behind a refused or unanswered command sent and a tap
 * back to that command's value sent too, a tap back sent while a resend waits for admission or while the choice behind an unanswered command waits, the resend a
 * timeout earns with one command still in flight and the warning when none is answered, a failure that is not resent, the silence after shutdown, the order of the
 * latest taps, the withdrawal of a command still waiting for admission, the drop of a command whose controller stopped responding, an MQTT start that moves the
 * valve as a tap does, and a valve run whose reply could not be read.
 */

// The Hydrawise API wire shapes use snake_case keys such as relay_id and controller_id, so camelcase is disabled here to let these literals mirror the wire verbatim.
/* eslint-disable camelcase */
import { Characteristic, Service, buildController, makeV2Facts, pollsCompleted, waitFor } from "./testing/platform.helpers.ts";
import type { HydrawiseCommandOutcome, HydrawiseZoneConfig, StatusScheduleResponse } from "./types.ts";
import { describe, test } from "node:test";
import { fastPolling, makeStatusSchedule, makeZone } from "./api.helpers.ts";
import { logCount, loggedAt, triggerGet, triggerSet, waitUntil } from "homebridge-plugin-utils/testing";
import type { BuildControllerResult } from "./testing/platform.helpers.ts";
import { HYDRAWISE_COMMAND_ATTEMPTS } from "./settings.ts";
import type { Service as HapService } from "homebridge";
import assert from "node:assert/strict";
import { bareSensors } from "./api.fixtures.ts";
import { setTimeout as delay } from "node:timers/promises";

const SUSPEND_ALL_ON = "Enable.Device.Suspend.All.SN0A1B2C3D4";

// How long, in milliseconds, a row gives a write that should have returned at once before it calls the write held. A write that returns at once settles within
// a few turns, so the span separates the two however the machine is loaded.
const SETTLE_MS = 500;

// A zone running now, so the wire reads the account as not suspended and the Suspend All switch reads off with nothing pending.
function runningZone(): HydrawiseZoneConfig {

  return makeZone({ name: "Alpha", relay: 1, relay_id: 700001, run: 600, time: 1, timestr: "" });
}

// A zone scheduled well outside the active window, so the wire reads its valve inactive with nothing pending.
function scheduledZone(): HydrawiseZoneConfig {

  return makeZone({ name: "Bravo", relay: 2, relay_id: 700002, run: 480, time: 68000, timestr: "16:00" });
}

// A fast-cadence status body carrying the given zones and a sensor block covering nothing.
function schedule(zones: HydrawiseZoneConfig[]): StatusScheduleResponse {

  return fastPolling(makeStatusSchedule({ relays: zones, sensors: bareSensors }));
}

// A controller with the Suspend All switch, polling a running zone and a scheduled one, once its first poll has landed and the switch answers HomeKit.
async function suspendAllController(options: Parameters<typeof buildController>[0] = {}): Promise<{ h: BuildControllerResult; valve: HapService;
  suspend: HapService; }> {

  const h = buildController({ program: (recorder) => recorder.programDefault("statusschedule.php", { body: schedule([ runningZone(), scheduledZone() ]),
    kind: "response" }), signalAborted: false, userOptions: [SUSPEND_ALL_ON], ...options });

  const valve = await waitFor(() => h.accessory.getServiceById(Service.Valve, "700002"), { description: "the valve for zone 700002 to appear" });
  const suspend = await waitFor(() => h.accessory.getServiceById(Service.Switch, "All"), { description: "the suspend-all switch to appear" });

  return { h, suspend, valve };
}

// The Suspend All commands the controller sent, in order, as the direction each went.
function suspendAlls(h: BuildControllerResult): string[] {

  return h.commands.params.filter(params => params["action"] === "suspendall").map(params => (Number(params["custom"]) > (Date.now() / 1000)) ? "suspend" : "resume");
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

    assert.equal(await Promise.race([ write, delay(SETTLE_MS).then(() => "held") ]), "returned", "HomeKit's write returns without waiting on Hydrawise");

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
    await pollsCompleted(h, h.retrieve.callsTo("statusschedule.php").length + 1);

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
    await delay(SETTLE_MS / 5);

    assert.deepEqual(h.commands.params.map(params => params["action"]), [ "suspendall", "suspendall" ], "the resend is the one command in flight, the run behind it");

    resend.release();
    await h.controller.commandsIdle;

    assert.deepEqual(h.commands.params.map(params => params["action"]), [ "suspendall", "suspendall", "run" ], "and the run goes once the resend is answered");
  });

  test("two timeouts then a confirmation leave the switch on and stamp once", async (t) => {

    const { h, suspend } = await suspendAllController();

    t.after(() => h.abort());

    h.commands.program({ status: "timeout" }, { status: "timeout" });

    await triggerSet(suspend.getCharacteristic(Characteristic.On), true);
    await h.controller.commandsIdle;

    assert.deepEqual(suspendAlls(h), [ "suspend", "suspend", "suspend" ], "an unanswered command is sent again until Hydrawise answers");
    assert.equal(new Set(h.commands.params.map(params => params["custom"])).size, 1, "every resend carries the instant its turn took");
    assert.equal(logCount(h.entries, "info", "Suspending scheduled watering for all zones."), 1, "the confirmation is taken once");
    assert.equal(h.entries.filter(line => line.level === "warn").length, 0, "with nothing to warn about");

    // The confirmation stamped the record, so a snapshot older than it leaves the switch on even though the wire reads the account as running.
    h.controller.applyFacts({ facts: makeV2Facts(), fetchedAt: Math.floor(Date.now() / 1000) - 100 });

    assert.equal(await triggerGet(suspend.getCharacteristic(Characteristic.On)), true, "the switch stays on");
  });

  test("an unanswered command warns once after its last attempt and puts the switch back", async (t) => {

    const { h, suspend } = await suspendAllController();

    t.after(() => h.abort());

    h.commands.programDefault({ status: "timeout" });

    await triggerSet(suspend.getCharacteristic(Characteristic.On), true);
    await h.controller.commandsIdle;
    await waitUntil(() => suspend.getCharacteristic(Characteristic.On).value === false, { description: "the suspend-all switch to read off" });

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
    await waitUntil(() => suspend.getCharacteristic(Characteristic.On).value === false, { description: "the suspend-all switch to read off" });

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
    await delay(SETTLE_MS / 5);

    assert.equal(h.commands.calls.length, 1, "the run still waiting its turn is never sent");
    assert.equal(logCount(h.entries, "info", "scheduled watering for all zones"), 0, "a confirmation landing after shutdown is not taken");
    assert.equal(h.entries.filter(line => [ "error", "warn" ].includes(line.level)).length, 0, "and nothing is said");
    assert.equal(suspend.getCharacteristic(Characteristic.On).value, true, "the switch is left where the tap put it");
  });

  test("sends follow the order of the latest taps", async (t) => {

    const { h, suspend, valve } = await suspendAllController();

    t.after(() => h.abort());

    // A held stop keeps the one command in flight while the taps below queue behind it. The valve's run, tapped first, is tapped again with a new length after the
    // Suspend All, which moves it behind the Suspend All.
    const held = h.commands.hold();
    const alpha = await waitFor(() => h.accessory.getServiceById(Service.Valve, "700001"), { description: "the valve for zone 700001 to appear" });

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
    h.controller.applyFacts({ facts: makeV2Facts({ online: false }), fetchedAt: Math.floor(Date.now() / 1000) });

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

  test("a valve run refused in its reply puts the valve back and says why", async (t) => {

    const { h, valve } = await suspendAllController();

    t.after(() => h.abort());

    h.commands.programDefault({ reason: "Zone is disabled.", status: "refused" });

    await triggerSet(valve.getCharacteristic(Characteristic.Active), Characteristic.Active.ACTIVE);
    await h.controller.commandsIdle;
    await waitUntil(() => valve.getCharacteristic(Characteristic.Active).value === Characteristic.Active.INACTIVE, { description: "the valve to read inactive" });

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
    await waitUntil(() => valve.getCharacteristic(Characteristic.Active).value === Characteristic.Active.INACTIVE, { description: "the valve to read inactive" });

    assert.equal(h.commands.calls.length, 1, "a reply that could not be read is not resent");
    assert.equal(logCount(h.entries, "error", "Bravo [Zone 2]: Unable to start this zone. The answer from Hydrawise could not be read."), 1,
      "the zone's line names the zone and the reason");
    assert.equal(h.entries.filter(line => [ "error", "warn" ].includes(line.level)).length, 1, "and nothing more is said");
  });
});
