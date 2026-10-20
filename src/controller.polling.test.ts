/* Copyright(C) 2017-2026, HJD (https://github.com/hjdhjd). All rights reserved.
 *
 * controller.polling.test.ts: The structure of the polling loop, as distinct from what any single poll projects. Asserts the terminal fault - a poll body
 * that survives the shape guard but breaks the pass kills the loop once, reports once, and polls no more - the handler attachment for a valve that came back
 * from the accessory cache rather than being created by this pass, the ordering between the loop's wire half and its projection half, and the loop's
 * reachability verdict: lost after a run of failed polls, never on a shorter one, back on the next good poll, and lost at once when the loop itself ends.
 */

// The Hydrawise API wire shapes use snake_case keys such as relay_id, so camelcase is disabled here to let the zone fixtures mirror the wire verbatim.
/* eslint-disable camelcase */
import { Characteristic, Service } from "./testing/hap.helpers.ts";
import { HYDRAWISE_API_JITTER, HYDRAWISE_API_RETRY_INTERVAL } from "./settings.ts";
import type { HydrawiseZoneConfig, StatusScheduleResponse } from "./types.ts";
import { TestClock, advanceThroughSchedule, assertNoUnhandledRejections, expectAt, logCount, present, waitUntil } from "homebridge-plugin-utils/testing";
import { buildController, isNotResponding, waitFor } from "./testing/platform.helpers.ts";
import { describe, test } from "node:test";
import { fastPolling, makeStatusSchedule, makeZone } from "./api.helpers.ts";
import type { BuildControllerResult } from "./testing/platform.helpers.ts";
import type { TestAccessory } from "./testing/hap.helpers.ts";
import assert from "node:assert/strict";
import { bareSensors } from "./api.fixtures.ts";
import { setTimeout as delay } from "node:timers/promises";

// The single zone every scenario here works against.
const ZONE_RELAY_ID = 700001;
const ZONE_SUBTYPE = "700001";

// Roughly three fast-cadence poll intervals. Used where a test has to prove that something did NOT happen: a dead loop has to be given ample opportunity to poll
// again before the absence of a poll means anything.
const SEVERAL_CADENCES_MS = 800;

// How many completed polls the sequencing sampler observes before it renders a verdict. Two would prove the ordering once; a third makes the steady state, rather
// than the first pass, the thing being sampled.
const POLLS_OBSERVED = 3;

// A fast-cadence, single-zone schedule with a bare sensor block, so a live-loop test cycles in roughly 250ms.
function schedule(zones: HydrawiseZoneConfig[]): StatusScheduleResponse {

  return fastPolling(makeStatusSchedule({ relays: zones, sensors: bareSensors }));
}

// The zone under test, scheduled well beyond the active-zone window so a poll settles its valve without also driving a start or stop transition.
function scheduledZone(): HydrawiseZoneConfig {

  return makeZone({ name: "Alpha", relay: 1, relay_id: ZONE_RELAY_ID, run: 480, time: 68000, timestr: "16:00" });
}

/* A poll body that PASSES the shape guard and then breaks the loop's WIRE half. The guard is deliberately shallow - relays and sensors are arrays, nextpoll is a
 * number - so a relay entry carrying no name at all passes straight through it and fails at the name trim, the first thing the wire half does with the entry it
 * fetched. The cast is what lets the fixture express a body the wire could plausibly return but the wire types cannot describe.
 */
function wireCrashingSchedule(): StatusScheduleResponse {

  const nameless = { relay: 1, relay_id: ZONE_RELAY_ID, run: 480, time: 68000, timestr: "16:00" } as unknown as HydrawiseZoneConfig;

  return schedule([nameless]);
}

/* A poll body that clears every hurdle in the wire half and then breaks the PROJECTION half. Its relay carries a valid string name, so the shape guard admits it
 * and the name trim completes; what it lacks is a relay id. The roster persist merely copies that id, so the projection gets as far as asking whether the zone is
 * enabled before it reaches for the id as a value it can call a method on, and that read is inside the projection's own body.
 */
function applierCrashingSchedule(): StatusScheduleResponse {

  const idless = { name: "Alpha", relay: 1, run: 480, time: 68000, timestr: "16:00" } as unknown as HydrawiseZoneConfig;

  return schedule([idless]);
}

// Seed a cached valve for the zone under test, the shape Homebridge restores when an accessory returns from its cache. The valve exists before the controller is
// constructed, so the pass that follows finds it rather than creating it.
function seedCachedValve(accessory: TestAccessory): void {

  accessory.addService(new Service.Valve("Alpha", ZONE_SUBTYPE));
}

describe("HydrawiseController polling loop structure", () => {

  test("a poll body that breaks the wire half kills the loop once, reports once, and polls no more", async (t) => {

    await assertNoUnhandledRejections(async () => {

      const h = buildController({ program: (recorder) => recorder.programDefault("statusschedule.php", { body: wireCrashingSchedule(), kind: "response" }),
        signalAborted: false });

      t.after(() => h.abort());

      /* This fixture throws inside the loop's wire half, at the name trim. Its sibling below throws inside the projection half instead, and the two assert the
       * same observables: the halves sit under one envelope, so a fault from either has to arrive at the same reporter and end the same loop. Covering only one
       * side would leave a regression that swallowed the other side's throw free to pass.
       */
      await waitUntil(() => logCount(h.entries, "error", "stopped unexpectedly") >= 1, { description: "an error line containing \"stopped unexpectedly\"" });

      const pollsAtFault = h.retrieve.callsTo("statusschedule.php").length;

      // Give a loop that survived its fault every chance to poll again. The cadence is roughly 250ms, so this span covers several intervals; a loop that is genuinely
      // dead makes no further call in it.
      await delay(SEVERAL_CADENCES_MS);

      assert.equal(logCount(h.entries, "error", "stopped unexpectedly"), 1, "a terminal fault is reported exactly once, not once per poll");
      assert.equal(h.retrieve.callsTo("statusschedule.php").length, pollsAtFault, "the loop is dead until the plugin restarts, so no further poll is issued");
      assert.equal(pollsAtFault, 1, "the fault fires on the first poll, so exactly one poll preceded it");
    });
  });

  test("a poll body that breaks the projection half kills the loop once, reports once, and polls no more", async (t) => {

    await assertNoUnhandledRejections(async () => {

      const h = buildController({ program: (recorder) => recorder.programDefault("statusschedule.php", { body: applierCrashingSchedule(), kind: "response" }),
        signalAborted: false });

      t.after(() => h.abort());

      /* The sibling of the assertion above, aimed at the other half. This fixture survives everything the wire half does to it and throws in the projection's own body,
       * which is what makes the pair distinguishing: an envelope that covered only the wire half - a projection call wrapped in a swallowing catch, say - would
       * satisfy the assertion above while this one hung with no report at all.
       */
      await waitUntil(() => logCount(h.entries, "error", "stopped unexpectedly") >= 1, { description: "an error line containing \"stopped unexpectedly\"" });

      const pollsAtFault = h.retrieve.callsTo("statusschedule.php").length;

      // The same span the sibling allows, for the same reason: a loop that outlived its fault gets several cadences to prove it by polling again.
      await delay(SEVERAL_CADENCES_MS);

      assert.equal(logCount(h.entries, "error", "stopped unexpectedly"), 1, "a projection fault is reported exactly once, not once per poll");
      assert.equal(h.retrieve.callsTo("statusschedule.php").length, pollsAtFault, "the loop is dead until the plugin restarts, so no further poll is issued");
      assert.equal(pollsAtFault, 1, "the fault fires on the first poll, so exactly one poll preceded it");
    });
  });

  test("a valve restored from the accessory cache still gets its set handler attached on the first poll", async (t) => {

    const h = buildController({ program: (recorder) => {

      recorder.programDefault("statusschedule.php", { body: schedule([scheduledZone()]), kind: "response" });
      recorder.programDefault("setzone.php", { body: { message: "", message_type: "info" }, kind: "response" });
    }, seedContext: seedCachedValve, signalAborted: false });

    t.after(() => h.abort());

    /* The warm-restart case. The valve already exists, so the acquisition does not report a new service; what attaches the handler is that this process has not
     * yet bound this valve, a record the walk keeps per service rather than per poll. A walk that bound only what it created would leave this valve with no
     * handler, and a HomeKit set on it would silently do nothing.
     */
    const valve = await waitFor(() => h.accessory.getServiceById(Service.Valve, ZONE_SUBTYPE), { description: "the zone valve to appear" });

    // Waiting for the valve is not enough on its own: the seeded service exists before the first poll ever runs. Waiting for the zone's status line proves the pass
    // that attaches the handler has actually been through.
    await waitUntil(() => logCount(h.entries, "info", "Next run will be") >= 1, { description: "an info line containing \"Next run will be\"" });
    await valve.getCharacteristic(Characteristic.Active).triggerSet(Characteristic.Active.ACTIVE);

    const command = expectAt(h.retrieve.callsTo("setzone.php"), 0, "setzone call");

    assert.equal(command.params?.["action"], "run", "the set handler attached to the restored valve dispatches the run command");
    assert.equal(command.params["relay_id"], ZONE_SUBTYPE, "the dispatched command targets the restored valve's own zone");
  });

  test("the wire half never runs a poll ahead of the projection", async (t) => {

    const h = buildController({ mqtt: true, program: (recorder) => recorder.programDefault("statusschedule.php",
      { body: schedule([scheduledZone()]), kind: "response" }), signalAborted: false });

    t.after(() => h.abort());

    assert.ok(h.mqtt, "the MQTT recorder should be attached");

    const mqtt = h.mqtt;
    const samples: { fetches: number; published: number }[] = [];

    /* Read both recorders in ONE synchronous sample, repeatedly, across several polls. Under a single envelope the two halves run in lockstep, so at any instant
     * the fetches recorded can lead the publishes recorded by at most one - the poll currently in flight between the fetch and its projection. A wire half that
     * ran ahead of the projection, buffering completed polls for a decoupled consumer, would open that lead to two or more, which is what these samples catch.
     * Both counts come from recorders the harness already keeps; nothing here is instrumented for the occasion. The publishes counted are the controller topic's
     * alone, one per poll, so the availability word published beside them cannot pad the count.
     */
    await waitUntil(() => {

      samples.push({ fetches: h.retrieve.callsTo("statusschedule.php").length, published: mqtt.publishedTo("controller").length });

      return mqtt.publishedTo("controller").length >= POLLS_OBSERVED;
    }, { description: "the MQTT publish of every observed poll", pollMs: 1 });

    const worst = samples.reduce((lead, sample) => Math.max(lead, sample.fetches - sample.published), 0);

    assert.ok(samples.length > POLLS_OBSERVED, "the sampler took more than one reading per poll, so its verdict rests on more than the end state");
    assert.ok(worst <= 1, "the widest lead the wire half took over the projection was " + worst.toString() + " polls, expected at most one");
    assert.ok(mqtt.publishedTo("controller").length >= POLLS_OBSERVED, "the run observed the intended number of completed polls");
  });
});

describe("HydrawiseController reachability verdict", () => {

  // The wire-realistic body every scenario here polls, whose own cadence the waits below are derived from.
  const status = makeStatusSchedule({ relays: [scheduledZone()], sensors: bareSensors });

  // The sleep between good polls, and the backoff after a failed poll that follows a good one, each as the loop computes it from the body's cadence.
  const sleep = (status.nextpoll + HYDRAWISE_API_JITTER) * 1000;
  const backoff = Math.min(status.nextpoll + HYDRAWISE_API_JITTER, HYDRAWISE_API_RETRY_INTERVAL * 2) * 1000;

  // A controller with its suspend-all switch, polling on a clock the row drives, every answer after the programmed ones a failure.
  function verdictController(clock: TestClock, program: (programmed: (kind: "fail" | "ok") => void) => void): BuildControllerResult {

    return buildController({ clock, mqtt: true, program: (recorder) => program((kind) => recorder.program("statusschedule.php",
      (kind === "ok") ? { body: status, kind: "response" } : { kind: "null" })), signalAborted: false, userOptions: ["Enable.Device.Suspend.All.SN0A1B2C3D4"] });
  }

  // A read of the irrigation system's Active, the characteristic HomeKit reads the controller accessory's availability from.
  async function primary(h: BuildControllerResult): Promise<unknown> {

    return present(h.accessory.getService(Service.IrrigationSystem), "the irrigation system").getCharacteristic(Characteristic.Active).triggerGet();
  }

  // A read of the suspend-all switch, which answers through the same rule.
  async function suspendAll(h: BuildControllerResult): Promise<unknown> {

    return present(h.accessory.getServiceById(Service.Switch, "All"), "the suspend-all switch").getCharacteristic(Characteristic.On).triggerGet();
  }

  // The availability word's record, read by its full topic so the client's own plugin-level statement can never match it.
  function words(h: BuildControllerResult): { payload: unknown; retain: boolean }[] {

    return present(h.mqtt, "the MQTT recorder").publishedTo(h.controllerConfig.serial_number + "/availability").map(({ payload, retain }) => ({ payload, retain }));
  }

  test("polls failing from the start read lost on the threshold, with one line, and refuse before it", async (t) => {

    const clock = new TestClock();
    const h = verdictController(clock, () => undefined);

    t.after(() => h.abort());

    const firstRunBackoff = HYDRAWISE_API_RETRY_INTERVAL * 1000;

    await advanceThroughSchedule(clock, [firstRunBackoff]);

    assert.equal(h.retrieve.callsTo("statusschedule.php").length, 2, "two polls have failed");
    assert.equal(logCount(h.entries, "info", "for this controller"), 0, "two failures are not yet a loss, so nothing is said");
    await assert.rejects(() => primary(h), isNotResponding, "a controller that has not reached Hydrawise this run already refuses");

    await advanceThroughSchedule(clock, [firstRunBackoff]);

    assert.equal(h.retrieve.callsTo("statusschedule.php").length, 3, "the third poll has failed");
    assert.equal(logCount(h.entries, "info", "Hydrawise is not responding for this controller."), 1, "the loss is said once");
    await assert.rejects(() => primary(h), isNotResponding, "the irrigation system refuses with the communication failure");
    await assert.rejects(() => suspendAll(h), isNotResponding, "and so does the suspend-all switch");
    assert.deepEqual(words(h), [{ payload: "offline", retain: true }], "the word is the retained offline it has held since construction");
  });

  test("a good poll then a run of failures reads lost on the threshold and not before", async (t) => {

    const clock = new TestClock();
    const h = verdictController(clock, (programmed) => programmed("ok"));

    t.after(() => h.abort());

    await advanceThroughSchedule(clock, [ sleep, backoff ]);

    assert.equal(h.retrieve.callsTo("statusschedule.php").length, 3, "a good poll and two failed ones have run");
    assert.equal(await primary(h), Characteristic.Active.ACTIVE, "two failures after a good poll still answer");

    await advanceThroughSchedule(clock, [backoff]);

    assert.equal(h.retrieve.callsTo("statusschedule.php").length, 4, "the third failure has run");
    await assert.rejects(() => primary(h), isNotResponding, "the third failure refuses");
    assert.equal(logCount(h.entries, "info", "Hydrawise has stopped responding for this controller."), 1, "the loss is said once");
    assert.deepEqual(words(h), [ { payload: "offline", retain: true }, { payload: "online", retain: true }, { payload: "offline", retain: true } ],
      "the retained word went online on the good poll and ends offline");
  });

  test("two failures then a good poll never read lost", async (t) => {

    const clock = new TestClock();
    const h = verdictController(clock, (programmed) => {

      programmed("ok");
      programmed("fail");
      programmed("fail");
      programmed("ok");
    });

    t.after(() => h.abort());

    await advanceThroughSchedule(clock, [ sleep, backoff, backoff ]);

    assert.equal(h.retrieve.callsTo("statusschedule.php").length, 4, "the good poll after the two failures has run");
    assert.equal(await primary(h), Characteristic.Active.ACTIVE, "the controller answers throughout");
    assert.equal(logCount(h.entries, "info", "for this controller"), 0, "and nothing about reachability is said");
    assert.deepEqual(words(h), [ { payload: "offline", retain: true }, { payload: "online", retain: true } ], "the word went online once and stayed there");
  });

  test("the next good poll after a loss answers again, with its line and the retained online", async (t) => {

    const clock = new TestClock();
    const h = verdictController(clock, (programmed) => {

      programmed("ok");
      programmed("fail");
      programmed("fail");
      programmed("fail");
      programmed("ok");
    });

    t.after(() => h.abort());

    await advanceThroughSchedule(clock, [ sleep, backoff, backoff ]);
    await assert.rejects(() => primary(h), isNotResponding, "the controller is lost");

    await advanceThroughSchedule(clock, [backoff]);

    assert.equal(await primary(h), Characteristic.Active.ACTIVE, "the good poll answers again");
    assert.equal(logCount(h.entries, "info", "Hydrawise is responding again for this controller."), 1, "the recovery is said once");
    assert.deepEqual(words(h).at(-1), { payload: "online", retain: true }, "the retained word is online again");
  });

  test("a loop that dies after a good poll refuses and says offline, with no line of the controller's own", async (t) => {

    await assertNoUnhandledRejections(async () => {

      const clock = new TestClock();
      const h = buildController({ clock, mqtt: true, program: (recorder) => {

        recorder.program("statusschedule.php", { body: status, kind: "response" });
        recorder.programDefault("statusschedule.php", { body: applierCrashingSchedule(), kind: "response" });
      }, signalAborted: false });

      t.after(() => h.abort());

      await advanceThroughSchedule(clock, []);
      assert.equal(await primary(h), Characteristic.Active.ACTIVE, "the good poll answers");

      await advanceThroughSchedule(clock, [sleep]);

      assert.equal(logCount(h.entries, "error", "stopped unexpectedly"), 1, "the fault reporter says why the loop ended");
      await assert.rejects(() => primary(h), isNotResponding, "a loop that has ended vouches for nothing");
      assert.equal(logCount(h.entries, "info", "for this controller"), 0, "and the controller adds no line of its own about the same fault");
      assert.deepEqual(words(h).at(-1), { payload: "offline", retain: true }, "the retained word is offline");
    });
  });
});
