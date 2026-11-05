/* Copyright(C) 2017-2026, HJD (https://github.com/hjdhjd). All rights reserved.
 *
 * controller.schedule.test.ts: The zone schedule projection the runtime persists into accessory context - the classifier that turns one wire zone into a
 * schedule state, the whole-body projection and its self-describing header, the guards that classify a cache read, and the one save a poll's marks reach the
 * cache through, which carries both persisted projections. These assertions lock in the zero-cloud-call source the webUI's schedule display reads back, and
 * above all its change-shaped cost: a poll whose facts did not move must cost no cache write at all, however far the wire's countdowns have fallen.
 */

// The Hydrawise API wire shapes use snake_case keys such as relay_id, so camelcase is disabled here to let the zone fixtures mirror the wire verbatim.
/* eslint-disable camelcase */
import { HYDRAWISE_RAIN_SENSOR_TYPE, HYDRAWISE_UNSCHEDULED_SENTINEL, controllerV2Facts, isScheduleStatus, isZoneAccessoryContext, isZoneScheduleStatus,
  sameScheduleStatus, scheduleStatus, zoneIdentity } from "./types.ts";
import type { HydrawiseAccessoryContext, HydrawiseScheduleStatus, HydrawiseZoneConfig, HydrawiseZoneIdentity, HydrawiseZoneScheduleState,
  StatusScheduleResponse } from "./types.ts";
import { bareSensors, normalZoneMatrix, rainSensors, sentinelZoneMatrix, syntheticController } from "./api.fixtures.ts";
import { buildController, buildPlatform, makeV2Facts, makeZoneV2Facts, pollsCompleted, seedEstablished } from "./testing/platform.helpers.ts";
import { describe, test } from "node:test";
import { expectAt, logCount, waitUntil } from "homebridge-plugin-utils/testing";
import { fastPolling, makeStatusSchedule, makeZone, normalSchedule, rainStopped } from "./api.helpers.ts";
import { HYDRAWISE_ACTIVE_ZONE_INDICATOR } from "./settings.ts";
import assert from "node:assert/strict";

// The wire root time the bespoke scenarios stamp, and the one-poll-interval step the drift scenarios advance it by. A nominal Hydrawise poll is sixty seconds, so
// stepping the root clock by sixty while the zones' countdowns fall by the same sixty is exactly the steady state a live controller reports.
const ROOT_TIME = 1715480009;
const POLL_STEP = 60;

// The relay ids the bespoke matrices use. The shared fixture matrix owns 700001 through 700019, and these scenarios stay inside that range so a relay id always
// reads as this account's.
const ALPHA_RELAY_ID = 700001;
const BETA_RELAY_ID = 700002;

// The suspension instant the live 2026-08-09 account capture recorded, kept verbatim so these assertions run against a real far-future value rather than a round number.
const SUSPENDED_UNTIL = 1903928399;

// Compose a fast-cadence schedule around a zone list and a sensor block, so a live-loop test cycles in roughly 250ms rather than the wire-realistic minute.
function schedule(zones: HydrawiseZoneConfig[], sensors: StatusScheduleResponse["sensors"] = bareSensors, time = ROOT_TIME): StatusScheduleResponse {

  return fastPolling(makeStatusSchedule({ relays: zones, sensors, time }));
}

// Compose a rain-class sensor block from one relay-id group per sensor, so a scenario states which zones each sensor covers and nothing more. Coverage and the rain
// class are the only sensor fields the classification reads.
function sensorsCovering(...groups: number[][]): StatusScheduleResponse["sensors"] {

  return groups.map(ids => ({ input: 0, mode: 1, relays: ids.map(id => ({ id })), type: HYDRAWISE_RAIN_SENSOR_TYPE }));
}

// A zone carrying the unscheduled sentinel. A rain-sensor stop, an owner's suspension, and a zone simply between runs present this shape identically, so which one
// a scenario is describing rests entirely on the covering sensor's group rather than on anything in the zone itself.
function sentinelZone(overrides: Partial<HydrawiseZoneConfig> = {}): HydrawiseZoneConfig {

  return makeZone({ name: "Alpha", relay: 1, relay_id: ALPHA_RELAY_ID, run: 0, time: HYDRAWISE_UNSCHEDULED_SENTINEL, timestr: "", ...overrides });
}

// A zone carrying a live schedule, which is what a covered sibling needs to prove its sensor is not tripping.
function scheduledZone(overrides: Partial<HydrawiseZoneConfig> = {}): HydrawiseZoneConfig {

  return makeZone({ name: "Beta", relay: 2, relay_id: BETA_RELAY_ID, run: 480, time: 68000, timestr: "16:00", ...overrides });
}

// The identity-only roster projection, so a scenario can seed the context with a roster its first poll matches: the roster marks nothing, so the schedule's
// write is what the row measures.
function zoneRoster(zones: readonly HydrawiseZoneConfig[]): HydrawiseZoneIdentity[] {

  return zones.map(zone => zoneIdentity(zone)).toSorted((a, b) => a.relay - b.relay);
}

// Read the accessory context back through its typed shape.
function contextOf(accessory: { context: unknown }): HydrawiseAccessoryContext {

  return accessory.context as HydrawiseAccessoryContext;
}

// Read the persisted schedule projection, failing the test rather than returning undefined when nothing was persisted, so every downstream assertion reads a real
// value instead of passing vacuously against an absent one.
function scheduleOf(accessory: { context: unknown }): HydrawiseScheduleStatus {

  const persisted = contextOf(accessory).schedule;

  assert.ok(persisted, "the accessory context carries a persisted schedule projection");

  return persisted;
}

// The all-scheduled drift matrix: two zones whose countdowns fall by exactly one poll interval per step while their run durations hold. The scheduled arm's stored
// absolutes are the sums of the root time and these countdowns, so every step of this matrix projects to the identical facts.
function scheduledDrift(step: number): HydrawiseZoneConfig[] {

  return [

    makeZone({ name: "Alpha", relay: 1, relay_id: ALPHA_RELAY_ID, run: 480, time: 68000 - (step * POLL_STEP), timestr: "16:00" }),
    makeZone({ name: "Beta", relay: 2, relay_id: BETA_RELAY_ID, run: 300, time: 69000 - (step * POLL_STEP), timestr: "16:08" })
  ];
}

// The running drift matrix: one zone running now, its remaining run falling by one poll interval per step while the wire's running marker holds. The running arm
// stores the end instant, which the root clock and the remaining run sum to identically at every step.
function runningDrift(step: number): HydrawiseZoneConfig[] {

  return [makeZone({ name: "Alpha", relay: 1, relay_id: ALPHA_RELAY_ID, run: 600 - (step * POLL_STEP), time: 1, timestr: "" })];
}

describe("HydrawiseController schedule classification", () => {

  test("classifies each zone of the shared matrix by its own reported state", () => {

    const status = normalSchedule();
    const projection = scheduleStatus(status, HYDRAWISE_ACTIVE_ZONE_INDICATOR);
    const running = expectAt(projection.zones, 0, "zone");

    // Relay 1 is the matrix's running zone: its end instant is the root time plus the run remaining, and the arm carries no duration at all - persisting the live
    // countdown is exactly what the absolute-time shape exists to avoid, so its absence is asserted on the key set rather than merely on a value.
    assert.deepEqual(running, { endsAt: status.time + 600, relayId: 700001, state: "running" }, "the running zone projects its end instant");
    assert.deepEqual(Object.keys(running).toSorted(), [ "endsAt", "relayId", "state" ], "the running arm carries no duration field");

    // Every other zone of the matrix is scheduled, whether inside the active window or far beyond it: the window is a display concern the projection describes
    // rather than a classification the projection makes.
    for(const zone of normalZoneMatrix.slice(1)) {

      const entry = projection.zones.find(candidate => candidate.relayId === zone.relay_id);

      assert.deepEqual(entry, { durationSeconds: zone.run, nextRunAt: status.time + zone.time, relayId: zone.relay_id, state: "scheduled" },
        "a scheduled zone projects its absolute next run and its duration");
    }
  });

  test("classifies a sensor-covered sentinel zone as sensor-stopped and an uncovered one as unscheduled", () => {

    const covered = makeZone({ name: "Alpha", relay: 1, relay_id: ALPHA_RELAY_ID, run: 0, time: HYDRAWISE_UNSCHEDULED_SENTINEL, timestr: "" });
    const uncovered = makeZone({ name: "Beta", relay: 2, relay_id: BETA_RELAY_ID, run: 0, time: HYDRAWISE_UNSCHEDULED_SENTINEL, timestr: "" });

    // Unlike the shared fixture matrix's own rain sensor, which covers every zone, this sensor's relay list names only Alpha's relay id, so Beta is excluded
    // only by absence from that list: the two zones differ solely in whether the sensor claims them.
    const sensors: StatusScheduleResponse["sensors"] = [{ input: 0, mode: 1, relays: [{ id: ALPHA_RELAY_ID }], type: HYDRAWISE_RAIN_SENSOR_TYPE }];
    const projection = scheduleStatus(makeStatusSchedule({ relays: [ covered, uncovered ], sensors, time: ROOT_TIME }), HYDRAWISE_ACTIVE_ZONE_INDICATOR);

    assert.deepEqual(projection.zones, [ { relayId: ALPHA_RELAY_ID, state: "sensor-stopped" }, { relayId: BETA_RELAY_ID, state: "unscheduled" } ],
      "the sensor block is what tells a rain stop from a suspension, since both carry the same sentinel");
  });

  test("a sensor-covered sentinel zone still reporting a run or a schedule string is unscheduled, not sensor-stopped", () => {

    // Each of these zones carries the sentinel AND sits in the rain sensor's relay list, so only the remaining conjuncts of the sensor predicate can tell them
    // apart from a genuine rain stop. A build that drops either conjunct classifies them as sensor-stopped and reds here.
    const withRun = makeZone({ name: "Alpha", relay: 1, relay_id: ALPHA_RELAY_ID, run: 480, time: HYDRAWISE_UNSCHEDULED_SENTINEL, timestr: "" });
    const withTimestr = makeZone({ name: "Beta", relay: 2, relay_id: BETA_RELAY_ID, run: 0, time: HYDRAWISE_UNSCHEDULED_SENTINEL, timestr: "16:00" });
    const projection = scheduleStatus(makeStatusSchedule({ relays: [ withRun, withTimestr ], sensors: rainSensors, time: ROOT_TIME }),
      HYDRAWISE_ACTIVE_ZONE_INDICATOR);

    assert.deepEqual(projection.zones.map(zone => zone.state), [ "unscheduled", "unscheduled" ] as HydrawiseZoneScheduleState[],
      "a covered zone that still reports a run or a start time is unscheduled, so every conjunct of the sensor predicate is carried");
  });

  test("a covered sentinel zone beside a scheduled sibling under the same sensor is unscheduled, not sensor-stopped", () => {

    const projection = scheduleStatus(makeStatusSchedule({ relays: [ sentinelZone(), scheduledZone() ],
      sensors: sensorsCovering([ ALPHA_RELAY_ID, BETA_RELAY_ID ]), time: ROOT_TIME }), HYDRAWISE_ACTIVE_ZONE_INDICATOR);

    assert.deepEqual(projection.zones.map(zone => zone.state), [ "unscheduled", "scheduled" ] as HydrawiseZoneScheduleState[],
      "a sensor stops every zone it covers, so a covered sibling holding a schedule proves the sensor is not tripping");
  });

  test("the whole covered group carrying the sentinel projects every zone sensor-stopped", () => {

    const projection = scheduleStatus(rainStopped(), HYDRAWISE_ACTIVE_ZONE_INDICATOR);

    assert.equal(projection.zones.length, sentinelZoneMatrix.length, "the projection carries every reported zone");
    assert.ok(projection.zones.every(zone => zone.state === "sensor-stopped"),
      "a rain delay stops every covered zone, so a fully sentineled group is the sensor's own evidence that it is tripping");
  });

  test("a running zone under the same sensor leaves its covered sentinel siblings sensor-stopped", () => {

    const relays = [ sentinelZone(), sentinelZone({ name: "Beta", relay: 2, relay_id: BETA_RELAY_ID }),
      makeZone({ name: "Gamma", relay: 3, relay_id: 700003, run: 600, time: 1, timestr: "" }) ];
    const projection = scheduleStatus(makeStatusSchedule({ relays, sensors: sensorsCovering([ ALPHA_RELAY_ID, BETA_RELAY_ID, 700003 ]), time: ROOT_TIME }),
      HYDRAWISE_ACTIVE_ZONE_INDICATOR);

    assert.deepEqual(projection.zones.map(zone => zone.state), [ "sensor-stopped", "sensor-stopped", "running" ] as HydrawiseZoneScheduleState[],
      "a forced run during a genuine rain delay is plausible, so a running zone settles nothing and stays outside the group walk");
  });

  test("a covered sibling still reporting a run or a start time breaks the group its sensor covers", () => {

    const cells = [

      { label: "a run", sibling: scheduledZone({ run: 480, time: HYDRAWISE_UNSCHEDULED_SENTINEL, timestr: "" }) },
      { label: "a start time", sibling: scheduledZone({ run: 0, time: HYDRAWISE_UNSCHEDULED_SENTINEL, timestr: "16:00" }) }
    ];

    // Each sibling carries the sentinel on `time` and sits in the same relay list as the target, so only the run and schedule-string conjuncts of the member test
    // keep it out of the stopped group. A member walk keyed to `time` alone reads the group as stopped and classifies the target sensor-stopped on both cells.
    for(const { label, sibling } of cells) {

      const projection = scheduleStatus(makeStatusSchedule({ relays: [ sentinelZone(), sibling ],
        sensors: sensorsCovering([ ALPHA_RELAY_ID, BETA_RELAY_ID ]), time: ROOT_TIME }), HYDRAWISE_ACTIVE_ZONE_INDICATOR);

      assert.equal(expectAt(projection.zones, 0, "zone").state, "unscheduled", "a sibling still reporting " + label + " leaves its sensor's group unstopped");
    }
  });

  test("a healthy group under one sensor says nothing about the group under another", () => {

    const relays = [ sentinelZone(), sentinelZone({ name: "Beta", relay: 2, relay_id: BETA_RELAY_ID }),
      makeZone({ name: "Gamma", relay: 3, relay_id: 700003, run: 480, time: 68000, timestr: "16:00" }) ];
    const projection = scheduleStatus(makeStatusSchedule({ relays, sensors: sensorsCovering([ ALPHA_RELAY_ID, BETA_RELAY_ID ], [700003]), time: ROOT_TIME }),
      HYDRAWISE_ACTIVE_ZONE_INDICATOR);

    assert.deepEqual(projection.zones.map(zone => zone.state), [ "sensor-stopped", "sensor-stopped", "scheduled" ] as HydrawiseZoneScheduleState[],
      "each sensor's group is walked on its own, so a scheduled zone another sensor covers is no evidence about this one");
  });

  test("a zone two sensors cover is stopped when either group is stopped", () => {

    // Alpha sits under both sensors: the first covers Alpha alone and is entirely sentineled, while the second also covers the scheduled Beta and is therefore not
    // stopping anything. A walk that required every covering sensor to agree would read Alpha as unscheduled.
    const projection = scheduleStatus(makeStatusSchedule({ relays: [ sentinelZone(), scheduledZone() ],
      sensors: sensorsCovering([ALPHA_RELAY_ID], [ ALPHA_RELAY_ID, BETA_RELAY_ID ]), time: ROOT_TIME }), HYDRAWISE_ACTIVE_ZONE_INDICATOR);

    assert.deepEqual(projection.zones.map(zone => zone.state), [ "sensor-stopped", "scheduled" ] as HydrawiseZoneScheduleState[],
      "one covering sensor evidently stopping is enough, so the walk answers across the sensors that cover a zone");
  });

  test("orders the projected zones by relay regardless of the order the wire reported them", () => {

    const shuffled = [

      makeZone({ name: "Third", relay: 9, relay_id: 700003, run: 480, time: 68000, timestr: "16:00" }),
      makeZone({ name: "First", relay: 1, relay_id: ALPHA_RELAY_ID, run: 480, time: 68000, timestr: "16:00" }),
      makeZone({ name: "Second", relay: 4, relay_id: BETA_RELAY_ID, run: 480, time: 68000, timestr: "16:00" })
    ];
    const projection = scheduleStatus(makeStatusSchedule({ relays: shuffled, sensors: bareSensors, time: ROOT_TIME }), HYDRAWISE_ACTIVE_ZONE_INDICATOR);

    assert.notDeepEqual(shuffled.map(zone => zone.relay_id), [ ALPHA_RELAY_ID, BETA_RELAY_ID, 700003 ], "the input order must differ from relay order to mean anything");
    assert.deepEqual(projection.zones.map(zone => zone.relayId), [ ALPHA_RELAY_ID, BETA_RELAY_ID, 700003 ], "the projection orders its zones by relay");
  });

  test("describes itself with the active window and the wire's own root time", () => {

    const status = normalSchedule();
    const projection = scheduleStatus(status, HYDRAWISE_ACTIVE_ZONE_INDICATOR);

    assert.equal(projection.activeWindowSeconds, HYDRAWISE_ACTIVE_ZONE_INDICATOR, "the active window travels with the data rather than being hardcoded by consumers");
    assert.equal(projection.asOf, status.time, "asOf is the wire's own root time, never a local clock read");
  });
});

describe("HydrawiseController schedule guards", () => {

  test("rejects a zone entry whose state is valid but whose own arm field is missing or mistyped", () => {

    assert.ok(isZoneScheduleStatus({ endsAt: ROOT_TIME, relayId: ALPHA_RELAY_ID, state: "running" }), "a well-formed running entry passes");
    assert.ok(!isZoneScheduleStatus({ relayId: ALPHA_RELAY_ID, state: "running" }), "a running entry missing its end instant fails");
    assert.ok(!isZoneScheduleStatus({ endsAt: "soon", relayId: ALPHA_RELAY_ID, state: "running" }), "a running entry whose end instant is not numeric fails");

    assert.ok(isZoneScheduleStatus({ durationSeconds: 480, nextRunAt: ROOT_TIME, relayId: ALPHA_RELAY_ID, state: "scheduled" }), "a well-formed scheduled entry passes");
    assert.ok(!isZoneScheduleStatus({ nextRunAt: ROOT_TIME, relayId: ALPHA_RELAY_ID, state: "scheduled" }), "a scheduled entry missing its duration fails");
    assert.ok(!isZoneScheduleStatus({ durationSeconds: 480, relayId: ALPHA_RELAY_ID, state: "scheduled" }), "a scheduled entry missing its next run fails");
    assert.ok(!isZoneScheduleStatus({ durationSeconds: 480, nextRunAt: "later", relayId: ALPHA_RELAY_ID, state: "scheduled" }),
      "a scheduled entry whose next run is not numeric fails");

    assert.ok(isZoneScheduleStatus({ relayId: ALPHA_RELAY_ID, state: "sensor-stopped" }), "a sensor-stopped entry needs nothing beyond its state");
    assert.ok(isZoneScheduleStatus({ relayId: ALPHA_RELAY_ID, state: "unscheduled" }), "an unscheduled entry needs nothing beyond its state");
    assert.ok(!isZoneScheduleStatus({ relayId: ALPHA_RELAY_ID, state: "watering" }), "a state the union does not declare fails");
    assert.ok(!isZoneScheduleStatus({ endsAt: ROOT_TIME, state: "running" }), "an entry with no relay id fails");
    assert.ok(!isZoneScheduleStatus(null), "a non-object fails");
  });

  test("rejects a projection whose header is malformed or whose zones do not all pass", () => {

    const zones = [{ endsAt: ROOT_TIME, relayId: ALPHA_RELAY_ID, state: "running" }];

    assert.ok(isScheduleStatus({ activeWindowSeconds: HYDRAWISE_ACTIVE_ZONE_INDICATOR, asOf: ROOT_TIME, zones }), "a well-formed projection passes");
    assert.ok(!isScheduleStatus({ asOf: ROOT_TIME, zones }), "a projection missing its active window fails");
    assert.ok(!isScheduleStatus({ activeWindowSeconds: HYDRAWISE_ACTIVE_ZONE_INDICATOR, zones }), "a projection missing its timestamp fails");
    assert.ok(!isScheduleStatus({ activeWindowSeconds: HYDRAWISE_ACTIVE_ZONE_INDICATOR, asOf: ROOT_TIME, zones: "none" }), "a non-array zone list fails");
    assert.ok(!isScheduleStatus({ activeWindowSeconds: HYDRAWISE_ACTIVE_ZONE_INDICATOR, asOf: ROOT_TIME,
      zones: [ ...zones, { relayId: BETA_RELAY_ID, state: "running" } ] }), "one malformed entry fails the whole projection");
    assert.ok(!isScheduleStatus(null), "a non-object fails");
  });
});

describe("HydrawiseController schedule persistence (poll)", () => {

  test("a fresh first poll seeds both projections through a single flush", async (t) => {

    const h = buildController({ program: (recorder) => recorder.programDefault("statusschedule.php", { body: fastPolling(normalSchedule()), kind: "response" }),
      signalAborted: false });

    t.after(() => h.abort());

    await pollsCompleted(h, 2);
    await h.abort();

    const persisted = scheduleOf(h.accessory);

    assert.equal(h.flushes().length, 2, "beside construction's flush, the roster seed and the schedule seed share one, and the unchanged second poll adds none");
    assert.equal(persisted.zones.length, normalZoneMatrix.length, "the projection carries every reported zone");
    assert.equal(persisted.asOf, normalSchedule().time, "the seeded projection carries the wire's root time");
  });

  test("a feature-disabled zone still appears in the persisted projection", async (t) => {

    const h = buildController({ program: (recorder) => recorder.programDefault("statusschedule.php", { body: fastPolling(normalSchedule()), kind: "response" }),
      signalAborted: false, userOptions: ["Disable.Device.700002"] });

    t.after(() => h.abort());

    // Construction saves the ConfiguredName the controller's setup adds before any poll, so the first poll's save is the second.
    await waitUntil(() => h.flushes().length >= 2, { description: "the first poll's accessory flush, after construction's" });

    // The projection takes no feature parameter and structurally cannot exclude a zone, so this assertion guards a future writer who threads the enabled-zone set into
    // it rather than distinguishing what the code does today.
    assert.ok(scheduleOf(h.accessory).zones.some(zone => zone.relayId === 700002), "the persisted projection is the complete reported set, feature options aside");
  });

  test("falling countdowns on a stable schedule cost no flush at all", async (t) => {

    const h = buildController({ program: (recorder) => {

      recorder.program("statusschedule.php", { body: schedule(scheduledDrift(0)), kind: "response" });
      recorder.programDefault("statusschedule.php", { body: schedule(scheduledDrift(1), bareSensors, ROOT_TIME + POLL_STEP), kind: "response" });
    }, signalAborted: false });

    t.after(() => h.abort());

    await pollsCompleted(h, 2);
    await h.abort();

    // The two wire bodies genuinely differ - the root clock advanced and every countdown fell - yet they describe the same scheduled instants, so the change gate
    // takes its no-change return and the seed remains the run's only flush beside construction's.
    assert.equal(h.flushes().length, 2, "a poll whose facts did not move costs no cache write, however far the wire's countdowns fell");
    assert.equal(scheduleOf(h.accessory).asOf, ROOT_TIME, "asOf holds at the poll that last changed the facts rather than tracking the wire clock");
  });

  test("a running zone's falling remaining time costs no flush at all", async (t) => {

    const h = buildController({ program: (recorder) => {

      recorder.program("statusschedule.php", { body: schedule(runningDrift(0)), kind: "response" });
      recorder.programDefault("statusschedule.php", { body: schedule(runningDrift(1), bareSensors, ROOT_TIME + POLL_STEP), kind: "response" });
    }, signalAborted: false });

    t.after(() => h.abort());

    await pollsCompleted(h, 2);
    await h.abort();

    const persisted = expectAt(scheduleOf(h.accessory).zones, 0, "zone");

    assert.equal(h.flushes().length, 2, "beside construction's and the seed's flushes, a running zone whose remaining time fell in lockstep with the clock costs none");
    assert.deepEqual(persisted, { endsAt: ROOT_TIME + 600, relayId: ALPHA_RELAY_ID, state: "running" },
      "the stored fact is the end instant, which held across both polls");
  });

  test("a genuine schedule move flushes once and advances asOf to the poll that moved it", async (t) => {

    // The second body breaks the drift pattern: the root clock advances a poll interval while Alpha's countdown falls by twice that, which is a schedule that
    // genuinely moved earlier rather than a countdown ticking down.
    const moved = scheduledDrift(1);

    moved[0] = makeZone({ name: "Alpha", relay: 1, relay_id: ALPHA_RELAY_ID, run: 480, time: 68000 - (2 * POLL_STEP), timestr: "16:00" });

    const h = buildController({ program: (recorder) => {

      recorder.program("statusschedule.php", { body: schedule(scheduledDrift(0)), kind: "response" });
      recorder.programDefault("statusschedule.php", { body: schedule(moved, bareSensors, ROOT_TIME + POLL_STEP), kind: "response" });
    }, signalAborted: false });

    t.after(() => h.abort());

    await pollsCompleted(h, 2);
    await h.abort();

    const persisted = scheduleOf(h.accessory);
    const alpha = expectAt(persisted.zones, 0, "zone");

    assert.equal(h.flushes().length, 3, "construction flushes once, the seed once and the moved schedule once");
    assert.deepEqual(alpha, { durationSeconds: 480, nextRunAt: ROOT_TIME + 68000 - POLL_STEP, relayId: ALPHA_RELAY_ID, state: "scheduled" },
      "the persisted next run adopted the moved instant");
    assert.equal(persisted.asOf, ROOT_TIME + POLL_STEP, "asOf advanced to the root time of the poll that moved the facts");
  });

  test("one zone swapped for another at the same zone count is a change, not a match", async (t) => {

    const before = scheduledDrift(0);
    const after = [ expectAt(before, 0, "zone"), makeZone({ name: "Gamma", relay: 3, relay_id: 700003, run: 300, time: 69000, timestr: "16:08" }) ];

    const h = buildController({ program: (recorder) => {

      recorder.program("statusschedule.php", { body: schedule(before), kind: "response" });
      recorder.programDefault("statusschedule.php", { body: schedule(after), kind: "response" });
    }, signalAborted: false });

    t.after(() => h.abort());

    await pollsCompleted(h, 2);
    await h.abort();

    // The two projections carry the same zone count and the same schedule facts at every index but one, so a comparison that stopped at the length - or that
    // compared only the arm's own facts without the relay id - would call these equal and never write the swap.
    assert.equal(h.flushes().length, 3, "construction flushes once, the seed once and the swapped zone once");
    assert.deepEqual(scheduleOf(h.accessory).zones.map(zone => zone.relayId), [ ALPHA_RELAY_ID, 700003 ], "the persisted projection adopted the swapped zone");
  });

  test("a roster-only change flushes exactly once and leaves the schedule value untouched", async (t) => {

    const alpha = makeZone({ name: "Alpha", relay: 1, relay_id: ALPHA_RELAY_ID, run: 480, time: 68000, timestr: "16:00" });
    const beta = makeZone({ name: "Beta", relay: 1, relay_id: ALPHA_RELAY_ID, run: 480, time: 68000, timestr: "16:00" });
    const seeded = scheduleStatus(schedule([alpha]), HYDRAWISE_ACTIVE_ZONE_INDICATOR);

    // Seed BOTH projections with what poll 1 reports, and the services earlier polls established, so poll 1 moves nothing and the rename on poll 2 is the only
    // change the run contains.
    const h = buildController({ program: (recorder) => {

      recorder.program("statusschedule.php", { body: schedule([alpha]), kind: "response" });
      recorder.programDefault("statusschedule.php", { body: schedule([beta]), kind: "response" });
    }, seedContext: (seed) => {

      seed.context = { schedule: seeded, zones: zoneRoster([alpha]) };
      seedEstablished({ accessory: seed, zones: [alpha] });
    }, signalAborted: false });

    t.after(() => h.abort());

    await pollsCompleted(h, 2);
    await h.abort();

    // A flush count alone cannot say which projection moved, because both travel through the one channel, so the schedule half's no-change claim is asserted on the
    // persisted value itself: a rename changes no schedule fact, and asOf therefore holds too.
    assert.equal(h.flushes().length, 1, "the matching first poll flushes nothing and the rename flushes exactly once");
    assert.deepEqual(scheduleOf(h.accessory), seeded, "a zone rename moves no schedule fact, asOf included");
    assert.equal(expectAt(contextOf(h.accessory).zones ?? [], 0, "zone").name, "Beta", "the persisted roster adopted the renamed zone");
  });
});

describe("HydrawiseController schedule restore (restart)", () => {

  test("a well-formed prior projection survives the context wipe and a matching first poll neither flushes nor re-times it", async (t) => {

    const zones = scheduledDrift(0);
    const prior: HydrawiseScheduleStatus = { ...scheduleStatus(schedule(zones), HYDRAWISE_ACTIVE_ZONE_INDICATOR), asOf: ROOT_TIME - 3600 };

    // The services earlier polls established are restored beside the context, as a warm restart restores them, so the first poll has nothing left to establish.
    const h = buildController({ program: (recorder) => recorder.programDefault("statusschedule.php", { body: schedule(zones), kind: "response" }),
      seedContext: (seed) => {

        seed.context = { schedule: prior, zones: zoneRoster(zones) };
        seedEstablished({ accessory: seed, zones });
      }, signalAborted: false });

    t.after(() => h.abort());

    assert.deepEqual(contextOf(h.accessory).schedule, prior, "the prior projection survives the constructor's wipe-then-seed pass");

    await pollsCompleted(h, 2);
    await h.abort();

    // Retaining the restored asOf is the deliberate conservatism of the design: the facts held when they were written and they still hold, and the only surface
    // that reads asOf is the display's staleness notice.
    assert.equal(h.flushes().length, 0, "a first poll that matches the restored projection writes nothing at all");
    assert.equal(scheduleOf(h.accessory).asOf, ROOT_TIME - 3600, "the restored timestamp is retained, because the facts it dates have not moved");
  });

  test("a malformed prior projection degrades to absent and the first poll writes fresh through one flush", async (t) => {

    const malformed = [

      { label: "a zone entry missing its arm field", value: { activeWindowSeconds: HYDRAWISE_ACTIVE_ZONE_INDICATOR, asOf: ROOT_TIME,
        zones: [{ relayId: ALPHA_RELAY_ID, state: "running" }] } },
      { label: "a zone entry whose arm field is mistyped", value: { activeWindowSeconds: HYDRAWISE_ACTIVE_ZONE_INDICATOR, asOf: ROOT_TIME,
        zones: [{ durationSeconds: 480, nextRunAt: "later", relayId: ALPHA_RELAY_ID, state: "scheduled" }] } },
      { label: "a state the union does not declare", value: { activeWindowSeconds: HYDRAWISE_ACTIVE_ZONE_INDICATOR, asOf: ROOT_TIME,
        zones: [{ relayId: ALPHA_RELAY_ID, state: "watering" }] } },
      { label: "a non-array zone list", value: { activeWindowSeconds: HYDRAWISE_ACTIVE_ZONE_INDICATOR, asOf: ROOT_TIME, zones: "none" } }
    ];

    for(const { label, value } of malformed) {

      const zones = scheduledDrift(0);

      // The roster and the services earlier polls established match what the first poll reports, so the projection's write is the only one that poll makes.
      const h = buildController({ program: (recorder) => recorder.programDefault("statusschedule.php", { body: schedule(zones), kind: "response" }),
        seedContext: (seed) => {

          seed.context = { schedule: value, zones: zoneRoster(zones) };
          seedEstablished({ accessory: seed, zones });
        }, signalAborted: false });

      t.after(() => h.abort());

      // eslint-disable-next-line no-await-in-loop
      await pollsCompleted(h, 2);

      // eslint-disable-next-line no-await-in-loop
      await h.abort();

      assert.equal(h.flushes().length, 1, "a first poll after " + label + " writes the projection fresh through exactly one flush");
      assert.equal(scheduleOf(h.accessory).asOf, ROOT_TIME, "the freshly written projection carries this poll's root time");
    }
  });

  test("a prior projection corrupt only in its timestamp is dropped at restore rather than surviving the first poll's compare", async (t) => {

    // This is the one corruption shape the first poll cannot heal: every compared fact matches what the poll will project, and the damage sits entirely in
    // asOf, the field the equality deliberately excludes. An unguarded restore would judge the projections equal, skip the flush, and persist the corrupt
    // timestamp indefinitely, so the restore guard is the only line between this value and the cache - which is exactly what this case distinguishes.
    const zones = scheduledDrift(0);
    const corrupt = { ...scheduleStatus(schedule(zones), HYDRAWISE_ACTIVE_ZONE_INDICATOR), asOf: "yesterday" };

    const h = buildController({ program: (recorder) => recorder.programDefault("statusschedule.php", { body: schedule(zones), kind: "response" }),
      seedContext: (seed) => {

        seed.context = { schedule: corrupt, zones: zoneRoster(zones) };
        seedEstablished({ accessory: seed, zones });
      }, signalAborted: false });

    t.after(() => h.abort());

    await pollsCompleted(h, 2);
    await h.abort();

    assert.equal(h.flushes().length, 1, "the corrupt-timestamp prior is dropped at restore, so the first poll seeds the projection through exactly one flush");
    assert.equal(scheduleOf(h.accessory).asOf, ROOT_TIME, "the freshly written projection carries this poll's numeric root time, never the corrupt value");
  });
});

describe("HydrawiseController schedule exclusivity", () => {

  test("a context carrying a schedule is not a zone accessory context", () => {

    const ownerController = { controllerId: 500001, name: "Test Controller", serialNumber: syntheticController.serial_number };
    const zone: HydrawiseZoneIdentity = { name: "Alpha", relay: 1, relayId: ALPHA_RELAY_ID };
    const projection = scheduleStatus(schedule(scheduledDrift(0)), HYDRAWISE_ACTIVE_ZONE_INDICATOR);

    /* The ambiguous shape inhabits neither arm of the context union - closing it off statically is what the arms are for - so it reaches the predicate through
     * the same cast the cache reader above uses. That is the honest model of where such an object comes from: Homebridge round-trips this context through its
     * on-disk cache, where a hand-edited or half-written entry answers to no static type, and the predicate is the guard that reads it.
     */
    const ambiguous = { ownerController, schedule: projection, zone } as unknown as HydrawiseAccessoryContext;

    assert.ok(isZoneAccessoryContext({ ownerController, zone }), "the schedule-free zone pair is a zone accessory context");
    assert.ok(!isZoneAccessoryContext(ambiguous), "a schedule leaking onto a zone accessory makes it classify as not-a-zone, the self-healing direction");
  });

  test("a reconciled standalone accessory's context carries the zone pair alone", () => {

    const zone = makeZone({ name: "Alpha", relay: 1, relay_id: ALPHA_RELAY_ID, run: 480, time: 68000, timestr: "16:00" });
    const { platform, registered } = buildPlatform();

    platform.reconcileZoneAccessories({ controller: syntheticController, presentRelayIds: new Set([ALPHA_RELAY_ID]),
      zones: [{ displayName: zone.name, identity: zoneIdentity(zone) }] });

    // Declared reach: the reconcile assigns a complete fresh object, so this assertion passes against the code as written and guards a future writer who reaches
    // for a field write instead.
    assert.deepEqual(Object.keys(expectAt(registered(), 0, "accessory").context).toSorted(), [ "ownerController", "zone" ],
      "no schedule projection reaches a standalone zone accessory's context");
  });
});

describe("HydrawiseController schedule classification with account facts", () => {

  test("a suspended zone classifies as suspended, carrying the instant its suspension lifts", () => {

    const projection = scheduleStatus(schedule([sentinelZone()]), HYDRAWISE_ACTIVE_ZONE_INDICATOR,
      { facts: makeV2Facts({ zones: [[ ALPHA_RELAY_ID, makeZoneV2Facts({ suspendedUntil: SUSPENDED_UNTIL }) ]] }) });

    assert.deepEqual(projection.zones, [{ relayId: ALPHA_RELAY_ID, state: "suspended", until: SUSPENDED_UNTIL }],
      "the account API resolves the one shape the key-based wire cannot read");
  });

  test("a zone the facts do not name, a null suspension and a suspension that ended at epoch zero all classify unscheduled", () => {

    /* A snapshot carrying no entry for the zone is how no suspension reaches it at all, and a null suspension is an entry that reached it and reported none. Zero
     * is a real instant the wire clock has long passed, so a suspension reported as ending then has lapsed and classifies with them.
     */
    const cells = [ { facts: makeV2Facts({ zones: [] }), label: "a zone the facts do not name" },
      { facts: makeV2Facts({ zones: [[ ALPHA_RELAY_ID, makeZoneV2Facts({ suspendedUntil: null }) ]] }), label: "a null suspension" },
      { facts: makeV2Facts({ zones: [[ ALPHA_RELAY_ID, { name: null, sensorStopped: null, suspendedUntil: 0 } ]] }), label: "a suspension at epoch zero" } ];

    for(const { facts, label } of cells) {

      const projection = scheduleStatus(schedule([sentinelZone()]), HYDRAWISE_ACTIVE_ZONE_INDICATOR, { facts });

      assert.equal(projection.zones[0]?.state, "unscheduled", label + " classifies as unscheduled");
    }
  });

  test("a suspension whose instant the WIRE clock has reached is lapsed, and one second short of it still stands", () => {

    // The facts arm compares against the same wire root time the carry does, so its comparison is held on both sides of the instant, as the sticky suspension
    // suite holds the carry's.
    const facts = makeV2Facts({ zones: [[ ALPHA_RELAY_ID, makeZoneV2Facts({ suspendedUntil: SUSPENDED_UNTIL }) ]] });
    const lapsed = scheduleStatus(schedule([sentinelZone()], bareSensors, SUSPENDED_UNTIL), HYDRAWISE_ACTIVE_ZONE_INDICATOR, { facts });

    assert.equal(lapsed.zones[0]?.state, "unscheduled", "an instant the wire clock has reached no longer suspends the zone");

    const standing = scheduleStatus(schedule([sentinelZone()], bareSensors, SUSPENDED_UNTIL - 1), HYDRAWISE_ACTIVE_ZONE_INDICATOR, { facts });

    assert.equal(standing.zones[0]?.state, "suspended", "and one second short of it still does");
  });

  test("a live sensor reporting itself quiet RETIRES the group inference that would have called the zone stopped", () => {

    /* The fixture is the all-covered rain shape, which the key-based group inference classifies as sensor-stopped on its own - that is what lets this assertion tell the
     * two readings apart, where a fixture the inference already agreed with could not. With the account API reporting the sensor quiet, it is not consulted.
     */
    const stopped = scheduleStatus(rainStopped(), HYDRAWISE_ACTIVE_ZONE_INDICATOR);

    assert.ok(stopped.zones.every(zone => zone.state === "sensor-stopped"), "without facts the group inference reads this shape as a rain stop");

    const quiet = scheduleStatus(rainStopped(), HYDRAWISE_ACTIVE_ZONE_INDICATOR,
      { facts: makeV2Facts({ zones: sentinelZoneMatrix.map(zone => [ zone.relay_id, makeZoneV2Facts({ sensorStopped: false }) ]) }) });

    assert.ok(quiet.zones.every(zone => zone.state === "unscheduled"), "a live sensor that is not tripped outranks the inference drawn from the group's shape");
  });

  test("an unknown sensor answer falls back to the group inference rather than denying a stop", () => {

    const unknown = scheduleStatus(rainStopped(), HYDRAWISE_ACTIVE_ZONE_INDICATOR,
      { facts: makeV2Facts({ zones: sentinelZoneMatrix.map(zone => [ zone.relay_id, makeZoneV2Facts({ sensorStopped: null }) ]) }) });

    assert.ok(unknown.zones.every(zone => zone.state === "sensor-stopped"), "a sensor answer this plugin cannot read degrades to exactly today's behavior");
  });

  test("a zone an error's path names is omitted from the facts, so a suspended zone stays suspended through its carry", async (t) => {

    const h = buildController({ hasV2Client: true, program: (recorder) => recorder.programDefault("statusschedule.php",
      { body: schedule([sentinelZone()]), kind: "response" }), signalAborted: false });

    t.after(() => h.abort());

    await waitUntil(() => contextOf(h.accessory).schedule !== undefined, { description: "the first poll to persist its projection" });

    h.controller.applyFacts({ facts: makeV2Facts({ zones: [[ ALPHA_RELAY_ID, makeZoneV2Facts({ suspendedUntil: SUSPENDED_UNTIL }) ]] }),
      fetchedAt: Math.floor(Date.now() / 1000) });

    assert.deepEqual(scheduleOf(h.accessory).zones, [{ relayId: ALPHA_RELAY_ID, state: "suspended", until: SUSPENDED_UNTIL }], "the zone starts out suspended");

    // The server nulled the zone's suspension for the error, which reads the same as a real "no suspension". The list's own indexes name the entry, a null entry ahead
    // of it counted, as the wire's path counts it.
    const facts = controllerV2Facts({ zones: [ null, { id: ALPHA_RELAY_ID, status: { suspendedUntil: null } },
      { id: BETA_RELAY_ID, status: { suspendedUntil: null } } ] }, [[ "zones", 1, "status", "suspendedUntil" ]]);

    assert.deepEqual([...facts.zones.keys()], [BETA_RELAY_ID], "the zone the error names is omitted, and the zone beside it stands");

    h.controller.applyFacts({ facts, fetchedAt: Math.floor(Date.now() / 1000) });

    assert.deepEqual(scheduleOf(h.accessory).zones, [{ relayId: ALPHA_RELAY_ID, state: "suspended", until: SUSPENDED_UNTIL }], "so it keeps its carry");
    assert.equal(logCount(h.entries, "info", "Suspension lifted."), 0, "and says nothing of a suspension that never lifted");
  });

  test("an incomplete sensor list makes every zone's reading unknown, and a complete one still answers", () => {

    const zones = [ { id: ALPHA_RELAY_ID }, { id: BETA_RELAY_ID } ];
    const quiet = { model: { sensorType: "LEVEL_CLOSED" }, status: { active: false }, zones: [{ id: BETA_RELAY_ID }] };
    const cells = [ { errorPaths: [], label: "a null entry", sensors: [ quiet, null ] },
      { errorPaths: [[ "sensors", 0, "status", "active" ]], label: "an error under the sensors", sensors: [quiet] },
      { errorPaths: [], label: "a counted sensor with no covered zones", sensors: [{ ...quiet, zones: undefined }] },
      { errorPaths: [], label: "a counted sensor whose covered zones hold a null entry", sensors: [{ ...quiet, zones: [ null, { id: BETA_RELAY_ID } ] }] } ];

    for(const { errorPaths, label, sensors } of cells) {

      const facts = controllerV2Facts({ sensors, zones }, errorPaths);

      assert.equal(facts.zones.get(ALPHA_RELAY_ID)?.sensorStopped, null, label + " leaves a zone no sensor it can read covers unknown");
      assert.equal(facts.zones.get(BETA_RELAY_ID)?.sensorStopped, null, label + " leaves a zone the quiet sensor covers unknown too");
    }

    const complete = controllerV2Facts({ sensors: [quiet], zones });

    assert.equal(complete.zones.get(ALPHA_RELAY_ID)?.sensorStopped, false, "a complete list reads an uncovered zone as clear");
    assert.equal(complete.zones.get(BETA_RELAY_ID)?.sensorStopped, false, "and a zone its quiet sensor covers as clear");
  });

  test("with two level sensors and one nulled, a zone the nulled sensor may cover is not read as clear", async (t) => {

    // Both zones under one type-1 sensor carry the unscheduled shape, which the key-based inference reads as a rain stop. A quiet reading from the facts would retire
    // that inference, so reading the nulled sensor as absent would call a real rain stop no stop at all.
    const body = schedule([ sentinelZone(), sentinelZone({ name: "Beta", relay: 2, relay_id: BETA_RELAY_ID }) ], sensorsCovering([ ALPHA_RELAY_ID, BETA_RELAY_ID ]));
    const h = buildController({ hasV2Client: true, program: (recorder) => recorder.programDefault("statusschedule.php", { body, kind: "response" }),
      signalAborted: false });

    t.after(() => h.abort());

    await waitUntil(() => contextOf(h.accessory).schedule !== undefined, { description: "the first poll to persist its projection" });

    const quiet = { model: { sensorType: "LEVEL_CLOSED" }, status: { active: false }, zones: [{ id: BETA_RELAY_ID }] };
    const facts = controllerV2Facts({ sensors: [ quiet, null ], zones: [ { id: ALPHA_RELAY_ID }, { id: BETA_RELAY_ID } ] });

    h.controller.applyFacts({ facts, fetchedAt: Math.floor(Date.now() / 1000) });

    assert.deepEqual(scheduleOf(h.accessory).zones.map(zone => zone.state), [ "sensor-stopped", "sensor-stopped" ], "the inference still decides for both");
  });

  test("a zone both suspended and covered by a tripped sensor classifies as suspended", () => {

    // The precedence assertion. Suspension is the longer-lived, user-created fact, and the sensor's claim returns on its own the moment the suspension clears.
    const projection = scheduleStatus(schedule([sentinelZone()]), HYDRAWISE_ACTIVE_ZONE_INDICATOR,
      { facts: makeV2Facts({ zones: [[ ALPHA_RELAY_ID, { name: null, sensorStopped: true, suspendedUntil: SUSPENDED_UNTIL } ]] }) });

    assert.equal(projection.zones[0]?.state, "suspended", "suspension outranks the sensor claim when both apply to one zone");
  });

  test("the availability stamp is present only when fresh facts carried one, and a flip compares as a change", () => {

    const bare = scheduleStatus(schedule([sentinelZone()]), HYDRAWISE_ACTIVE_ZONE_INDICATOR);
    const online = scheduleStatus(schedule([sentinelZone()]), HYDRAWISE_ACTIVE_ZONE_INDICATOR, { facts: makeV2Facts({ online: true }) });
    const offline = scheduleStatus(schedule([sentinelZone()]), HYDRAWISE_ACTIVE_ZONE_INDICATOR, { facts: makeV2Facts({ online: false }) });
    const unknown = scheduleStatus(schedule([sentinelZone()]), HYDRAWISE_ACTIVE_ZONE_INDICATOR, { facts: makeV2Facts({ online: null }) });

    assert.ok(!("online" in bare), "a projection composed without facts carries no availability key at all");
    assert.ok(!("online" in unknown), "and neither does one whose facts could not tell");
    assert.equal(online.online, true, "a reachable controller stamps its availability");
    assert.equal(offline.online, false, "and an unreachable one stamps its own");

    // Availability is compared rather than excluded, because a controller falling off the network and coming back is a real transition rather than churn.
    assert.ok(!sameScheduleStatus(online, offline), "two projections differing only in availability compare as changed");
    assert.ok(sameScheduleStatus(online, scheduleStatus(schedule([sentinelZone()]), HYDRAWISE_ACTIVE_ZONE_INDICATOR, { facts: makeV2Facts({ online: true }) })),
      "and two carrying the same availability compare as unchanged");
  });

  test("a suspended zone's projection is byte-stable across polls, so it costs no repeated write", () => {

    /* The flush-storm assertion. The suspension instant is ABSOLUTE, so it holds still while the wire's root clock advances; storing a countdown instead would move the
     * field every poll and turn every poll into a cache write.
     */
    const facts = makeV2Facts({ zones: [[ ALPHA_RELAY_ID, makeZoneV2Facts({ suspendedUntil: SUSPENDED_UNTIL }) ]] });
    const first = scheduleStatus(schedule([sentinelZone()], bareSensors, ROOT_TIME), HYDRAWISE_ACTIVE_ZONE_INDICATOR, { facts });
    const later = scheduleStatus(schedule([sentinelZone()], bareSensors, ROOT_TIME + POLL_STEP), HYDRAWISE_ACTIVE_ZONE_INDICATOR, { facts });

    assert.ok(sameScheduleStatus(first, later), "a poll that moved nothing but the clock compares as unchanged");
  });

  test("the guard accepts a suspended entry only when it carries a numeric instant", () => {

    assert.ok(isZoneScheduleStatus({ relayId: ALPHA_RELAY_ID, state: "suspended", until: SUSPENDED_UNTIL }), "a well-formed suspended entry passes");
    assert.ok(!isZoneScheduleStatus({ relayId: ALPHA_RELAY_ID, state: "suspended" }),
      "a truncated suspended entry counts as absent rather than rendering a blank instant");
    assert.ok(isScheduleStatus({ activeWindowSeconds: HYDRAWISE_ACTIVE_ZONE_INDICATOR, asOf: ROOT_TIME, online: true, zones: [] }),
      "a projection carrying a boolean availability passes");
    assert.ok(!isScheduleStatus({ activeWindowSeconds: HYDRAWISE_ACTIVE_ZONE_INDICATOR, asOf: ROOT_TIME, online: "yes", zones: [] }),
      "one carrying a non-boolean availability does not");
  });
});

describe("HydrawiseController sticky suspension", () => {

  // The prior projection a carry is drawn from: one zone recorded as suspended until the captured instant.
  function priorSuspended(): Map<number, number> {

    return new Map([[ ALPHA_RELAY_ID, SUSPENDED_UNTIL ]]);
  }

  test("a suspended zone carries forward across a pass that has no fresh facts about it", () => {

    /* The restart-and-gap assertion. Without the carry a suspended zone flaps to "not scheduled" and back every time a refresh is missed or the plugin restarts, which
     * is both a wrong display and a cache write each way.
     */
    const projection = scheduleStatus(schedule([sentinelZone()]), HYDRAWISE_ACTIVE_ZONE_INDICATOR, { priorSuspended: priorSuspended() });

    assert.deepEqual(projection.zones, [{ relayId: ALPHA_RELAY_ID, state: "suspended", until: SUSPENDED_UNTIL }],
      "the prior suspension stands while nothing contradicts it");

    // The carried instant is the PERSISTED value verbatim rather than a recomputed one, which is what keeps the carried arm byte-stable poll after poll.
    const later = scheduleStatus(schedule([sentinelZone()], bareSensors, ROOT_TIME + POLL_STEP), HYDRAWISE_ACTIVE_ZONE_INDICATOR,
      { priorSuspended: priorSuspended() });

    assert.ok(sameScheduleStatus(projection, later), "a carried suspension does not move as the wire clock advances");
  });

  test("a fresh facts entry for the zone ENDS the carry, null suspension included", () => {

    // A present entry is a real answer either way, so it reasserts or clears the state; only an absent one lets the carry apply.
    const cleared = scheduleStatus(schedule([sentinelZone()]), HYDRAWISE_ACTIVE_ZONE_INDICATOR,
      { facts: makeV2Facts({ zones: [[ ALPHA_RELAY_ID, makeZoneV2Facts({ suspendedUntil: null }) ]] }), priorSuspended: priorSuspended() });

    assert.equal(cleared.zones[0]?.state, "unscheduled", "an entry reporting no suspension clears the carried one");
  });

  test("a fresh snapshot that simply does not name the zone leaves its carry standing", () => {

    /* The per-zone half of the rule. The composer omits an entry it cannot complete, and an omitted entry is an unknown rather than an implicit "not suspended",
     * so judging the carry account-wide would let one zone's fresh answer silently clear a sibling it never covered.
     */
    const projection = scheduleStatus(schedule([ sentinelZone(), scheduledZone() ]), HYDRAWISE_ACTIVE_ZONE_INDICATOR,
      { facts: makeV2Facts({ zones: [[ BETA_RELAY_ID, makeZoneV2Facts() ]] }), priorSuspended: priorSuspended() });

    assert.equal(projection.zones[0]?.state, "suspended", "a zone the snapshot does not name keeps what the prior projection said");
  });

  test("a wire contradiction ends the carry", () => {

    // The zone presents a real schedule rather than the ambiguous shape, so there is nothing left to disambiguate and the wire's own reading wins outright.
    const projection = scheduleStatus(schedule([scheduledZone({ relay: 1, relay_id: ALPHA_RELAY_ID })]), HYDRAWISE_ACTIVE_ZONE_INDICATOR,
      { priorSuspended: priorSuspended() });

    assert.equal(projection.zones[0]?.state, "scheduled", "a zone that reports a real schedule is not suspended, whatever was carried");
  });

  test("a suspension whose instant has passed on the WIRE clock expires out of the carry", () => {

    // The comparison is against the wire's own root time rather than a local read, which keeps the classifier pure and lets an elapsed suspension lapse on its own.
    const expired = scheduleStatus(schedule([sentinelZone()], bareSensors, SUSPENDED_UNTIL), HYDRAWISE_ACTIVE_ZONE_INDICATOR,
      { priorSuspended: priorSuspended() });

    assert.equal(expired.zones[0]?.state, "unscheduled", "an instant the wire clock has reached no longer carries");

    const standing = scheduleStatus(schedule([sentinelZone()], bareSensors, SUSPENDED_UNTIL - 1), HYDRAWISE_ACTIVE_ZONE_INDICATOR,
      { priorSuspended: priorSuspended() });

    assert.equal(standing.zones[0]?.state, "suspended", "and one second short of it still does");
  });
});

describe("HydrawiseController sticky suspension across a restart", () => {

  // A prior projection recording one zone as suspended, exactly as a credentialed session would have persisted it before the plugin stopped.
  function priorProjection(): HydrawiseScheduleStatus {

    return { activeWindowSeconds: HYDRAWISE_ACTIVE_ZONE_INDICATOR, asOf: ROOT_TIME - 3600,
      zones: [{ relayId: ALPHA_RELAY_ID, state: "suspended", until: SUSPENDED_UNTIL }] };
  }

  test("a credentialed restart carries the suspension through the window before the first refresh answers", async (t) => {

    /* The restart-churn case. The plugin comes back with the cached projection but no facts yet, and the zone still presents the ambiguous sentinel shape, so
     * without the carry it would flap to "not scheduled" and back the moment the first refresh landed - a wrong display and a pair of cache writes.
     */
    // The zone roster and the services earlier polls established are seeded alongside the projection, so nothing but the schedule could mark the accessory,
    // isolating the schedule half this assertion is about.
    const h = buildController({ hasV2Client: true,
      program: (recorder) => recorder.programDefault("statusschedule.php", { body: schedule([sentinelZone()]), kind: "response" }),
      seedContext: (seed) => {

        seed.context = { schedule: priorProjection(), zones: zoneRoster([sentinelZone()]) };
        seedEstablished({ accessory: seed, zones: [sentinelZone()] });
      }, signalAborted: false });

    t.after(() => h.abort());

    await pollsCompleted(h, 2);
    await h.abort();

    assert.deepEqual(scheduleOf(h.accessory).zones, [{ relayId: ALPHA_RELAY_ID, state: "suspended", until: SUSPENDED_UNTIL }],
      "the suspension stands until something can actually confirm or clear it");

    // The carried instant is the persisted value verbatim, so the restored projection matches and no poll writes anything at all.
    assert.equal(h.flushes().length, 0, "a carried suspension costs no cache write");
  });

  test("an install whose credentials are GONE re-classifies a restored suspension cleanly", async (t) => {

    /* The gate that keeps the parity promise. Without the credentials nothing can ever confirm or clear a carried suspension, so honoring one would strand a claim
     * on screen forever with no way to correct it. The zone returns to what the key-based wire alone supports.
     */
    const h = buildController({ program: (recorder) => recorder.programDefault("statusschedule.php", { body: schedule([sentinelZone()]), kind: "response" }),
      seedContext: (seed) => { seed.context = { schedule: priorProjection(), zones: zoneRoster([sentinelZone()]) }; }, signalAborted: false });

    t.after(() => h.abort());

    await pollsCompleted(h, 2);
    await h.abort();

    assert.deepEqual(scheduleOf(h.accessory).zones, [{ relayId: ALPHA_RELAY_ID, state: "unscheduled" }],
      "a cache restored from a credentialed past re-classifies rather than carrying a claim nothing can update");
  });
});
