/* Copyright(C) 2017-2026, HJD (https://github.com/hjdhjd). All rights reserved.
 *
 * controller.polling.test.ts: The structure of the polling loop, as distinct from what any single poll projects. Asserts the terminal fault - a poll body
 * that survives the shape guard but breaks the pass kills the loop once, reports once, and polls no more - the first-run handler attachment for a valve that came
 * back from the accessory cache rather than being created by this pass, and the ordering between the loop's wire half and its projection half.
 */

// The Hydrawise API wire shapes use snake_case keys such as relay_id, so camelcase is disabled here to let the zone fixtures mirror the wire verbatim.
/* eslint-disable camelcase */
import { Characteristic, Service } from "./testing/hap.helpers.ts";
import type { HydrawiseZoneConfig, StatusScheduleResponse } from "./types.ts";
import { assertNoUnhandledRejections, expectAt, logCount, waitUntil } from "homebridge-plugin-utils/testing";
import { buildController, waitFor } from "./testing/platform.helpers.ts";
import { describe, test } from "node:test";
import { fastPolling, makeStatusSchedule, makeZone } from "./api.helpers.ts";
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

    /* The warm-restart case the pass distinguishes only by the first-run flag. The valve already exists, so the acquisition does not report a new service and the
     * new-valve arm never runs; what attaches the handler is the first-run flag alone, and that flag is read from the pre-fetch sentinel in the loop's wire half
     * and carried across to the projection. A break in that channel leaves this valve with no handler, and a HomeKit set on it would silently do nothing.
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
     * Both counts come from recorders the harness already keeps; nothing here is instrumented for the occasion.
     */
    await waitUntil(() => {

      samples.push({ fetches: h.retrieve.callsTo("statusschedule.php").length, published: mqtt.published.length });

      return mqtt.published.length >= POLLS_OBSERVED;
    }, { description: "the MQTT publish of every observed poll", pollMs: 1 });

    const worst = samples.reduce((lead, sample) => Math.max(lead, sample.fetches - sample.published), 0);

    assert.ok(samples.length > POLLS_OBSERVED, "the sampler took more than one reading per poll, so its verdict rests on more than the end state");
    assert.ok(worst <= 1, "the widest lead the wire half took over the projection was " + worst.toString() + " polls, expected at most one");
    assert.ok(mqtt.published.length >= POLLS_OBSERVED, "the run observed the intended number of completed polls");
  });
});
