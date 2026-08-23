/* Copyright(C) 2017-2026, HJD (https://github.com/hjdhjd). All rights reserved.
 *
 * controller.defects.test.ts: Characterization pins for the HydrawiseController polling loop that fix current behavior with a distinguishing input,
 * including the preserved defects labeled with their bug-ledger numbers. Also covers the all-suspended versus rain-stopped program-mode distinction and the two
 * getStatus-failure backoff arms.
 */

// The Hydrawise API wire shapes use snake_case keys such as relay_id and controller_id, so camelcase is disabled here to let these literals mirror the wire verbatim.
/* eslint-disable camelcase */
import { Characteristic, Service } from "./testing/hap.helpers.ts";
import type { HydrawiseControllerV2Facts, HydrawiseZoneConfig, StatusScheduleResponse } from "./types.ts";
import { allSuspended, fastPolling, makeStatusSchedule, makeZone, rainStopped } from "./api.helpers.ts";
import { assertNoUnhandledRejections, firstOf } from "./testing.helpers.ts";
import { bareSensors, sentinelZoneMatrix } from "./api.fixtures.ts";
import { buildController, loggedAt, makeV2Facts, makeZoneV2Facts, waitFor } from "./testing/platform.helpers.ts";
import { describe, test } from "node:test";
import type { BuildControllerResult } from "./testing/platform.helpers.ts";
import assert from "node:assert/strict";

// Compose a fast-cadence single-zone schedule.
function schedule(zones: HydrawiseZoneConfig[], sensors: StatusScheduleResponse["sensors"] = bareSensors): StatusScheduleResponse {

  return fastPolling(makeStatusSchedule({ relays: zones, sensors }));
}

function scheduledZone(): HydrawiseZoneConfig {

  return makeZone({ name: "Alpha", relay: 1, relay_id: 700001, run: 480, time: 68000, timestr: "16:00" });
}

function runningZone(): HydrawiseZoneConfig {

  return makeZone({ name: "Alpha", relay: 1, relay_id: 700001, run: 600, time: 1, timestr: "" });
}

describe("HydrawiseController updateState defect pins", () => {

  test("a single zone vanishing recomputes the program mode over the empty enabled domain to no-program-scheduled (the blessed ghost-domain divergence)", async (t) => {

    const h = buildController({ program: (recorder) => {

      recorder.program("statusschedule.php", { body: schedule([scheduledZone()]), kind: "response" });
      recorder.programDefault("statusschedule.php", { body: schedule([]), kind: "response" });
    }, signalAborted: false });

    t.after(() => h.abort());

    // The valve appears on poll 1 and is pruned once the zone vanishes. The program-mode aggregate projects over the current poll's enabled zones only, rather
    // than over all retained zone state, so a vanished zone's frozen flags can never select the program mode for a multi-zone controller. Here, with one zone,
    // the empty projection's 0 === 0 equality selects NO_PROGRAM_SCHEDULED.
    await waitFor(() => h.accessory.getServiceById(Service.Valve, "700001") ? true : undefined);
    await waitFor(() => (h.accessory.getServiceById(Service.Valve, "700001") === undefined) ? true : undefined);

    const irrigation = h.accessory.getService(Service.IrrigationSystem);

    assert.ok(irrigation, "the irrigation system service should exist");
    assert.equal(irrigation.getCharacteristic(Characteristic.ProgramMode).value, Characteristic.ProgramMode.NO_PROGRAM_SCHEDULED,
      "the empty enabled domain aggregates to no program scheduled");
  });

  test("a zone manually started, vanished, then reappearing while still running starts fresh, so the program mode recomputes to scheduled while the valve " +
    "reports in use (the bug 15 fix)", async (t) => {

    const h = buildController({ program: (recorder) => {

      recorder.program("statusschedule.php", { body: schedule([scheduledZone()]), kind: "response" });
      recorder.program("statusschedule.php", { body: schedule([]), kind: "response" });
      recorder.programDefault("statusschedule.php", { body: schedule([runningZone()]), kind: "response" });
      recorder.programDefault("setzone.php", { body: { message: "", message_type: "info" }, kind: "response" });
    }, signalAborted: false });

    t.after(() => h.abort());

    // Poll 1 seeds the valve; a manual start marks the zone manual and sets the program mode to manual mode.
    await waitFor(() => h.accessory.getServiceById(Service.Valve, "700001") ? true : undefined);

    const firstValve = h.accessory.getServiceById(Service.Valve, "700001");

    assert.ok(firstValve, "the zone valve should exist after the first poll");
    await firstValve.getCharacteristic(Characteristic.Active).triggerSet(Characteristic.Active.ACTIVE);

    // Poll 2 drops the zone (valve pruned; the empty domain recomputes the program mode to no-program-scheduled), and the prune drops the zone's hint entry with
    // it. The default poll brings the zone back still running.
    await waitFor(() => (h.accessory.getServiceById(Service.Valve, "700001") === undefined) ? true : undefined);
    await waitFor(() => h.accessory.getServiceById(Service.Valve, "700001") ? true : undefined);

    const reappeared = h.accessory.getServiceById(Service.Valve, "700001");
    const irrigation = h.accessory.getService(Service.IrrigationSystem);

    assert.ok(reappeared, "the zone valve should reappear");
    assert.ok(irrigation, "the irrigation system service should exist");

    // The reappeared entry starts fresh with isManual false - the prune dropped the stale entry when the zone vanished - so the aggregate guard fires and
    // recomputes: one running, non-rain-stopped zone selects program-scheduled, even as the valve reports in use.
    await waitFor(() => (reappeared.getCharacteristic(Characteristic.InUse).value === Characteristic.InUse.IN_USE) ? true : undefined);
    assert.equal(irrigation.getCharacteristic(Characteristic.ProgramMode).value, Characteristic.ProgramMode.PROGRAM_SCHEDULED,
      "the fresh entry lets the aggregate recompute to program-scheduled");
  });

  test("a malformed poll body throws so the loop retries and republishes recovered status, not the stale poll (the bug 10 fix)", async (t) => {

    const cleanup = assertNoUnhandledRejections();
    const h = buildController({ mqtt: true, program: (recorder) => {

      recorder.program("statusschedule.php", { body: schedule([runningZone()]), kind: "response" });
      recorder.program("statusschedule.php", { kind: "malformed" });
      recorder.programDefault("statusschedule.php", { body: schedule([scheduledZone()]), kind: "response" });
    }, signalAborted: false });

    t.after(() => h.abort());

    assert.ok(h.mqtt, "the MQTT recorder should be attached");
    const mqtt = h.mqtt;

    // Poll 1 publishes the running status. The malformed poll throws through getStatus, so the retry loop waits and re-polls rather than republishing; the second
    // publish is the recovered default (scheduled). We assert at exactly this checkpoint because the distinguishing shape holds only here: the second publish
    // differs from the stale first, and statusschedule.php has been called three times (poll 1, the malformed attempt, and the recovering retry) before it. A loop
    // that swallowed the malformed body instead would republish the stale status as the second publish after only two calls, converging by the third publish.
    await waitFor(() => (mqtt.published.length >= 2) ? true : undefined);

    const first = firstOf(mqtt.published, "MQTT publish").payload;

    assert.notEqual(mqtt.published[1]?.payload, first, "the malformed poll retries; the second publish is the recovered status, not the stale prior poll");
    assert.ok(h.retrieve.callsTo("statusschedule.php").length >= 3, "poll 1, the malformed attempt, and the recovering retry all precede the second publish");
    assert.ok(loggedAt(h.lines(), "error", "Unable to retrieve the current status"), "a malformed body should log the failure");

    cleanup();
  });

  test("a mis-shaped poll body missing relays throws so the loop retries instead of adopting it (the bug 10 fix)", async (t) => {

    const cleanup = assertNoUnhandledRejections();
    const h = buildController({ mqtt: true, program: (recorder) => {

      recorder.program("statusschedule.php", { body: schedule([runningZone()]), kind: "response" });
      recorder.program("statusschedule.php", { body: { nextpoll: 5, sensors: [] }, kind: "response" });
      recorder.programDefault("statusschedule.php", { body: schedule([scheduledZone()]), kind: "response" });
    }, signalAborted: false });

    t.after(() => h.abort());

    assert.ok(h.mqtt, "the MQTT recorder should be attached");
    const mqtt = h.mqtt;

    // A valid-JSON body missing relays fails the shape guard and throws through the same path as a parse failure, so the loop retries. The second publish is the
    // recovered default, reached after three statusschedule.php calls - the same distinguishing shape the malformed-body scenario pins.
    await waitFor(() => (mqtt.published.length >= 2) ? true : undefined);

    const first = firstOf(mqtt.published, "MQTT publish").payload;

    assert.notEqual(mqtt.published[1]?.payload, first, "the mis-shaped poll retries; the second publish is the recovered status, not the stale prior poll");
    assert.ok(h.retrieve.callsTo("statusschedule.php").length >= 3, "poll 1, the mis-shaped attempt, and the recovering retry all precede the second publish");
    assert.ok(loggedAt(h.lines(), "error", "Unable to retrieve the current status"), "a mis-shaped body should log the failure");

    cleanup();
  });

  test("all zones suspended aggregates to program-scheduled with the suspend switch on", async (t) => {

    const h = buildController({ program: (recorder) => recorder.programDefault("statusschedule.php", { body: fastPolling(allSuspended()), kind: "response" }),
      signalAborted: false, userOptions: ["Enable.Device.Suspend.All.SN0A1B2C3D4"] });

    t.after(() => h.abort());

    await waitFor(() => h.accessory.getServiceById(Service.Valve, "700019") ? true : undefined);

    const irrigation = h.accessory.getService(Service.IrrigationSystem);
    const suspend = h.accessory.getServiceById(Service.Switch, "All");

    assert.ok(irrigation, "the irrigation system service should exist");
    assert.ok(suspend, "the suspend switch should exist");
    assert.equal(irrigation.getCharacteristic(Characteristic.ProgramMode).value, Characteristic.ProgramMode.PROGRAM_SCHEDULED,
      "all-suspended zones are not sensor-stopped, so the program mode stays scheduled");
    assert.equal(suspend.getCharacteristic(Characteristic.On).value, true, "the suspend switch reports all zones suspended");
  });

  test("all zones rain-stopped aggregates to no-program-scheduled with the suspend switch off", async (t) => {

    const h = buildController({ program: (recorder) => recorder.programDefault("statusschedule.php", { body: fastPolling(rainStopped()), kind: "response" }),
      signalAborted: false, userOptions: ["Enable.Device.Suspend.All.SN0A1B2C3D4"] });

    t.after(() => h.abort());

    await waitFor(() => h.accessory.getServiceById(Service.Valve, "700019") ? true : undefined);

    const irrigation = h.accessory.getService(Service.IrrigationSystem);
    const suspend = h.accessory.getServiceById(Service.Switch, "All");

    assert.ok(irrigation, "the irrigation system service should exist");
    assert.ok(suspend, "the suspend switch should exist");
    assert.equal(irrigation.getCharacteristic(Characteristic.ProgramMode).value, Characteristic.ProgramMode.NO_PROGRAM_SCHEDULED,
      "every zone rain-stopped drives the program mode to no program scheduled");
    assert.equal(suspend.getCharacteristic(Characteristic.On).value, false, "a rain stop is not a suspend, so the suspend switch stays off");
  });

  test("a live sensor reporting itself quiet lifts the program mode the group inference alone would hold down", async (t) => {

    /* The credentialed twin of the rain-stopped pin directly above, and the two together are what make the account-credentialed sharpening visible at the
     * aggregate. Both drive the IDENTICAL wire fixture - the all-covered shape whose group inference says every zone is stopped - so the only thing that can move
     * the answer between them is whether a live sensor reading reached the classification.
     *
     * This has to run the REAL poll path rather than the classifier directly, because the routing under test is the whole chain: the classified state feeds the
     * hint ledger's stopped flag, and that flag is what the program-mode aggregate counts. A classifier-level assertion would prove the first link and say nothing
     * about the rest, which is exactly where a threading mistake would hide. ProgramMode is the observable end of that chain; the ledger itself is private.
     */
    const h = buildController({ hasV2Client: true,
      program: (recorder) => recorder.programDefault("statusschedule.php", { body: fastPolling(rainStopped()), kind: "response" }), signalAborted: false });

    t.after(() => h.abort());

    // The facts land before the first poll completes, so that poll's own walk classifies against them rather than against a snapshot that arrived too late.
    h.controller.applyFacts({ facts: makeV2Facts({ zones: sentinelZoneMatrix.map(zone => [ zone.relay_id, makeZoneV2Facts({ sensorStopped: false }) ]) }),
      fetchedAt: Math.floor(Date.now() / 1000) });

    await waitFor(() => h.accessory.getServiceById(Service.Valve, "700019") ? true : undefined);
    await waitFor(() => (h.retrieve.callsTo("statusschedule.php").length >= 2) ? true : undefined);

    const irrigation = h.accessory.getService(Service.IrrigationSystem);

    assert.ok(irrigation, "the irrigation system service should exist");
    assert.equal(irrigation.getCharacteristic(Characteristic.ProgramMode).value, Characteristic.ProgramMode.PROGRAM_SCHEDULED,
      "a rain stop the live sensor disproves stops counting toward the aggregate, so the schedule reads as standing");
  });

  test("a steady-state poll failure after a success recovers through the short backoff arm", async (t) => {

    const h = buildController({ program: (recorder) => {

      recorder.program("statusschedule.php", { body: schedule([runningZone()]), kind: "response" });
      recorder.program("statusschedule.php", { kind: "null" });
      recorder.programDefault("statusschedule.php", { body: schedule([scheduledZone()]), kind: "response" });
    }, signalAborted: false });

    t.after(() => h.abort());

    // Poll 1 succeeds (running, active); poll 2 returns null so getStatus throws and the isFirstRun-false ~250ms backoff arm runs; the recovering default poll
    // brings the zone back scheduled and inactive. Waiting for the valve to go inactive proves the recovery poll landed.
    await waitFor(() => {

      const valve = h.accessory.getServiceById(Service.Valve, "700001");

      return (valve?.getCharacteristic(Characteristic.Active).value === Characteristic.Active.INACTIVE) ? true : undefined;
    });

    assert.ok(h.retrieve.callsTo("statusschedule.php").length >= 3, "the loop should recover with a further poll after the failure");
  });

  test("a first-poll failure runs the fixed backoff arm and ends quietly on abort", async () => {

    const cleanup = assertNoUnhandledRejections();
    const h = buildController({ program: (recorder) => recorder.programDefault("statusschedule.php", { kind: "null" }), signalAborted: false });

    // The very first poll returns null, so getStatus throws and retry evaluates the isFirstRun-true fixed backoff (HYDRAWISE_API_RETRY_INTERVAL) synchronously
    // before suspending. A prompt abort ends that wait; because backoff() ran before delay() suspended, the arm is exercised without waiting out that interval.
    await waitFor(() => (h.retrieve.callsTo("statusschedule.php").length >= 1) ? true : undefined);

    h.abort();

    assert.equal(h.retrieve.callsTo("statusschedule.php").length, 1, "the loop should make exactly one poll before the abort ends the backoff wait");
    assert.ok(!loggedAt(h.lines(), "error", "stopped unexpectedly"), "a shutdown abort should unwind the loop without a fault report");

    cleanup();
  });
});

describe("HydrawiseController suspend switch with account facts", () => {

  // The suspension instant the live account capture recorded, kept verbatim so these pins run against a real far-future value.
  const SUSPENDED_UNTIL = 1903928399;

  // Every zone of the shared fixture matrix, reported as suspended until that instant.
  function allZonesSuspended(): HydrawiseControllerV2Facts {

    return makeV2Facts({ zones: sentinelZoneMatrix.map(zone => [ zone.relay_id, makeZoneV2Facts({ suspendedUntil: SUSPENDED_UNTIL }) ]) });
  }

  // The switch service, which every pin below reads its answer from.
  function suspendSwitch(h: BuildControllerResult): { getCharacteristic: (type: typeof Characteristic.On) => { value: unknown } } {

    const service = h.accessory.getServiceById(Service.Switch, "All");

    assert.ok(service, "the suspend switch should exist");

    return service;
  }

  test("a commanded suspend-all reads ON even where every zone is rain-covered", async (t) => {

    /* The blind spot this whole path exists to close, and the fixture is what makes the pin tell the two implementations apart. The rain-stopped shape has every
     * zone covered by a tripped sensor, so the key-based heuristic classifies every zone sensor-stopped and answers OFF - a 2026-08-04 live capture recorded
     * exactly that during a commanded suspend-all. Built on the all-suspended fixture instead, this pin would pass against unmodified code.
     */
    const h = buildController({ hasV2Client: true,
      program: (recorder) => recorder.programDefault("statusschedule.php", { body: fastPolling(rainStopped()), kind: "response" }),
      signalAborted: false, userOptions: ["Enable.Device.Suspend.All.SN0A1B2C3D4"] });

    t.after(() => h.abort());

    await waitFor(() => h.accessory.getServiceById(Service.Valve, "700019") ? true : undefined);

    assert.equal(suspendSwitch(h).getCharacteristic(Characteristic.On).value, false, "the key-based heuristic reads this shape as not suspended");

    h.controller.applyFacts({ facts: allZonesSuspended(), fetchedAt: Math.floor(Date.now() / 1000) });

    assert.equal(suspendSwitch(h).getCharacteristic(Characteristic.On).value, true, "the account facts resolve what the wire alone could not");
  });

  test("a zone forced into a manual run reads the switch OFF, even with every zone suspended", async (t) => {

    /* The case that makes reading the CLASSIFIED states right where reading the raw suspension facts would be wrong. The wire outranks the facts for a running
     * zone, so water actually flowing means the account is not all-suspended - the key-based heuristic answers OFF here.
     */
    const running = makeZone({ name: "Vegetable Garden", relay: 34, relay_id: 700019, run: 600, time: 1, timestr: "" });
    const relays = [ ...sentinelZoneMatrix.filter(zone => zone.relay_id !== 700019).map(zone => ({ ...zone })), running ];

    const h = buildController({ hasV2Client: true,
      program: (recorder) => recorder.programDefault("statusschedule.php", { body: schedule(relays), kind: "response" }),
      signalAborted: false, userOptions: ["Enable.Device.Suspend.All.SN0A1B2C3D4"] });

    t.after(() => h.abort());

    await waitFor(() => h.accessory.getServiceById(Service.Valve, "700019") ? true : undefined);

    h.controller.applyFacts({ facts: allZonesSuspended(), fetchedAt: Math.floor(Date.now() / 1000) });

    assert.equal(suspendSwitch(h).getCharacteristic(Characteristic.On).value, false, "a zone the user forced into a run means the account is not all-suspended");
  });

  test("a zone the snapshot does not name leaves the account short of all-suspended", async (t) => {

    const h = buildController({ hasV2Client: true,
      program: (recorder) => recorder.programDefault("statusschedule.php", { body: fastPolling(rainStopped()), kind: "response" }),
      signalAborted: false, userOptions: ["Enable.Device.Suspend.All.SN0A1B2C3D4"] });

    t.after(() => h.abort());

    await waitFor(() => h.accessory.getServiceById(Service.Valve, "700019") ? true : undefined);

    // Every zone but one is reported suspended. The omitted zone is an unknown rather than an implicit suspension, so the account is not all-suspended.
    const partial = makeV2Facts({ zones: sentinelZoneMatrix.filter(zone => zone.relay_id !== 700019)
      .map(zone => [ zone.relay_id, makeZoneV2Facts({ suspendedUntil: SUSPENDED_UNTIL }) ]) });

    h.controller.applyFacts({ facts: partial, fetchedAt: Math.floor(Date.now() / 1000) });

    assert.equal(suspendSwitch(h).getCharacteristic(Characteristic.On).value, false, "one unaccounted zone is enough to fall short of all-suspended");
  });

  test("a snapshot older than the user's own command never flips the switch back", async (t) => {

    /* The race the command guard closes, constructed so a guarded and an unguarded implementation visibly disagree. The stale snapshot reports every zone
     * unsuspended, which an ungated facts path would answer OFF; the user's own command is newer than that snapshot, so the guard holds the switch ON. A missing
     * or inverted comparison reds here.
     *
     * The wire under it is the all-suspended shape, so the key-based heuristic would answer ON as well. That agreement is deliberate - it keeps this pin about
     * the guard's OUTCOME rather than about which arm produced it - and the account-grain pin that does tell those arms apart runs against a non-sentinel wire
     * in the suspension suite, where the heuristic answers the other way.
     */
    const h = buildController({ hasV2Client: true, program: (recorder) => {

      recorder.programDefault("statusschedule.php", { body: fastPolling(allSuspended()), kind: "response" });
      recorder.programDefault("setzone.php", { body: { message: "", message_type: "info" }, kind: "response" });
    }, signalAborted: false, userOptions: ["Enable.Device.Suspend.All.SN0A1B2C3D4"] });

    t.after(() => h.abort());

    await waitFor(() => h.accessory.getServiceById(Service.Valve, "700019") ? true : undefined);

    const service = h.accessory.getServiceById(Service.Switch, "All");

    assert.ok(service, "the suspend switch should exist");

    // The user commands a suspend-all, which stamps the instant every later snapshot is judged against.
    await service.getCharacteristic(Characteristic.On).triggerSet(true);

    // A fetch that was already in flight when that command landed answers with facts that predate it, and so cannot know about it.
    h.controller.applyFacts({ facts: makeV2Facts({ zones: sentinelZoneMatrix.map(zone => [ zone.relay_id, makeZoneV2Facts() ]) }),
      fetchedAt: Math.floor(Date.now() / 1000) - 100 });

    assert.equal(suspendSwitch(h).getCharacteristic(Characteristic.On).value, true, "a snapshot older than the command is ignored and the switch stays on");
  });

  test("the two key-based topology pins are untouched by an install without credentials", async (t) => {

    // The parity restatement: with no credentials nothing above applies at all, and the heuristic answers from the wire alone for both topologies.
    const suspended = buildController({ program: (recorder) => recorder.programDefault("statusschedule.php", { body: fastPolling(allSuspended()),
      kind: "response" }), signalAborted: false, userOptions: ["Enable.Device.Suspend.All.SN0A1B2C3D4"] });

    t.after(() => suspended.abort());

    await waitFor(() => suspended.accessory.getServiceById(Service.Valve, "700019") ? true : undefined);
    assert.equal(suspendSwitch(suspended).getCharacteristic(Characteristic.On).value, true, "an all-sentinel account still reads as suspended");
  });
});

describe("HydrawiseController program mode reads the sensor, not the classification", () => {

  const SUSPENDED_UNTIL = 1903928399;

  test("a suspended zone a tripped sensor still covers counts toward the stopped aggregate", async (t) => {

    /* The aggregate reads the sensor, not the classified per-zone state. Every zone is covered by a tripped sensor and one of them is also suspended, so a hint
     * derived from the classified state would drop that zone out of the stopped count - suspension outranks the sensor for DISPLAY - and lift the whole
     * controller back to program-scheduled while rain is still falling. Reading the sensor instead keeps the aggregate honest regardless of whether account
     * facts are configured.
     */
    const h = buildController({ hasV2Client: true,
      program: (recorder) => recorder.programDefault("statusschedule.php", { body: fastPolling(rainStopped()), kind: "response" }), signalAborted: false });

    t.after(() => h.abort());

    const zones = sentinelZoneMatrix.map(zone => [ zone.relay_id,
      { name: null, sensorStopped: true, suspendedUntil: (zone.relay_id === 700019) ? SUSPENDED_UNTIL : null } ] as const);

    h.controller.applyFacts({ facts: makeV2Facts({ zones }), fetchedAt: Math.floor(Date.now() / 1000) });

    await waitFor(() => h.accessory.getServiceById(Service.Valve, "700019") ? true : undefined);
    await waitFor(() => (h.retrieve.callsTo("statusschedule.php").length >= 2) ? true : undefined);

    const irrigation = h.accessory.getService(Service.IrrigationSystem);

    assert.ok(irrigation, "the irrigation system service should exist");
    assert.equal(irrigation.getCharacteristic(Characteristic.ProgramMode).value, Characteristic.ProgramMode.NO_PROGRAM_SCHEDULED,
      "a suspended zone under a tripped sensor is still sensor-blocked, so the aggregate stays at no program scheduled");
  });
});
