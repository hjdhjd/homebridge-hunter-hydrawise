/* Copyright(C) 2017-2026, HJD (https://github.com/hjdhjd). All rights reserved.
 *
 * controller.transitions.test.ts: Multi-poll transition behavior of the HydrawiseController polling loop. Each test programs a queue of poll responses
 * and drives the live loop across them at the fast cadence, waiting on the observable each transition produces. Covers zone start / stop logging (globally and
 * per-zone by the Log.Zone feature), rain-sensor transitions, zone appearance and disappearance with valve pruning, zone-scoped Device disable, a suspension
 * arriving and lifting through an account-facts refresh, the suspended-until instant formatter's rendering tiers, and rain narration that follows the sensor's
 * own reading independent of a zone's suspension state.
 */

// The Hydrawise API wire shapes use snake_case keys such as relay_id, so camelcase is disabled here to let these literals mirror the wire verbatim.
/* eslint-disable camelcase */
import type { HydrawiseControllerV2Facts, HydrawiseZoneConfig, StatusScheduleResponse } from "./types.ts";
import { Service, buildController, makeV2Facts, makeZoneV2Facts } from "./testing/platform.helpers.ts";
import { bareSensors, rainSensors } from "./api.fixtures.ts";
import { describe, test } from "node:test";
import { fastPolling, makeStatusSchedule, makeZone } from "./api.helpers.ts";
import { formatLogEntry, logCount, loggedAt, waitUntil } from "homebridge-plugin-utils/testing";
import { HYDRAWISE_UNSCHEDULED_SENTINEL } from "./types.ts";
import assert from "node:assert/strict";

// Compose a fast-cadence schedule from a zone list and an optional sensor block (the bare, non-referencing sensor by default).
function schedule(zones: HydrawiseZoneConfig[], sensors: StatusScheduleResponse["sensors"] = bareSensors): StatusScheduleResponse {

  return fastPolling(makeStatusSchedule({ relays: zones, sensors }));
}

// A single zone scheduled to run later (not currently running, outside the active window).
function scheduledZone(overrides: Partial<HydrawiseZoneConfig> = {}): HydrawiseZoneConfig {

  return makeZone({ name: "Alpha", relay: 1, relay_id: 700001, run: 480, time: 68000, timestr: "16:00", ...overrides });
}

// A single zone running now.
function runningZone(overrides: Partial<HydrawiseZoneConfig> = {}): HydrawiseZoneConfig {

  return makeZone({ name: "Alpha", relay: 1, relay_id: 700001, run: 600, time: 1, timestr: "", ...overrides });
}

// A zone carrying the unscheduled sentinel with no run and no schedule string. A rain-sensor stop, an owner's suspension, and a zone between runs present this
// shape identically, so which one a scenario describes rests on the covering sensor's group: every covered zone sentineled reads as a rain stop, a scheduled
// sibling among them leaves the rest merely unscheduled.
function rainZone(overrides: Partial<HydrawiseZoneConfig> = {}): HydrawiseZoneConfig {

  return makeZone({ name: "Alpha", relay: 1, relay_id: 700001, run: 0, time: 1576800000, timestr: "", ...overrides });
}

describe("HydrawiseController updateState transitions", () => {

  test("logs a zone start and stop when Log.Zone is at its enabled default", async (t) => {

    const h = buildController({ program: (recorder) => {

      recorder.program("statusschedule.php", { body: schedule([scheduledZone()]), kind: "response" });
      recorder.program("statusschedule.php", { body: schedule([runningZone()]), kind: "response" });
      recorder.programDefault("statusschedule.php", { body: schedule([scheduledZone()]), kind: "response" });
    }, signalAborted: false });

    t.after(() => h.abort());

    // Poll 1 seeds the valve (no transition), poll 2 turns it on (Started), the default poll turns it back off (Stopped).
    await waitUntil(() => loggedAt(h.entries, "info", "Stopped"), { description: "an info line containing \"Stopped\"" });

    assert.ok(loggedAt(h.entries, "info", "Started"), "turning a zone on across polls should log a start");
    assert.ok(loggedAt(h.entries, "info", "Stopped"), "turning a zone off across polls should log a stop");
  });

  test("suppresses a zone's start log when Log.Zone is disabled for that zone", async (t) => {

    // A sibling zone left at Log.Zone's enabled default starts on the same poll, so its start line is the control that this run narrates a start where allowed.
    const sibling: Partial<HydrawiseZoneConfig> = { name: "Bravo", relay: 2, relay_id: 700002 };
    const h = buildController({ program: (recorder) => {

      recorder.program("statusschedule.php", { body: schedule([ scheduledZone(), scheduledZone(sibling) ]), kind: "response" });
      recorder.programDefault("statusschedule.php", { body: schedule([ runningZone(), runningZone(sibling) ]), kind: "response" });
    }, signalAborted: false, userOptions: ["Disable.Log.Zone.700001"] });

    t.after(() => h.abort());

    // Wait until at least two polls have run so the on-transition has certainly been processed, then confirm it produced no start log.
    await waitUntil(() => h.retrieve.callsTo("statusschedule.php").length >= 3, { description: "the third status poll" });

    assert.ok(loggedAt(h.entries, "info", "Bravo [Zone 2]: Started"), "the sibling whose Log.Zone is at its default logs the start the same poll made");
    assert.ok(!loggedAt(h.entries, "info", "Alpha [Zone 1]: Started"), "a zone with Log.Zone disabled should not log its start");
  });

  test("logs the rain sensor stopping and then allowing irrigation", async (t) => {

    const h = buildController({ program: (recorder) => {

      recorder.program("statusschedule.php", { body: schedule([scheduledZone()]), kind: "response" });
      recorder.program("statusschedule.php", { body: schedule([rainZone()], rainSensors), kind: "response" });
      recorder.programDefault("statusschedule.php", { body: schedule([scheduledZone()]), kind: "response" });
    }, signalAborted: false });

    t.after(() => h.abort());

    await waitUntil(() => loggedAt(h.entries, "info", "Rain sensor is allowing irrigation"),
      { description: "an info line containing \"Rain sensor is allowing irrigation\"" });

    assert.ok(loggedAt(h.entries, "info", "Rain sensor is stopping irrigation"), "a rain stop should be logged");
    assert.ok(loggedAt(h.entries, "info", "Rain sensor is allowing irrigation"), "a rain clear should be logged");
  });

  test("names each zone's own state at its first sighting", async (t) => {

    // One covered zone carrying the sentinel while a covered sibling still holds a schedule, plus a zone running now, so a single first poll reports an unscheduled,
    // a scheduled, and a running zone side by side - each of which must reach the operator in its own sentence.
    const zones = [ rainZone(), scheduledZone({ name: "Beta", relay: 2, relay_id: 700002 }), runningZone({ name: "Gamma", relay: 3, relay_id: 700003 }) ];

    const h = buildController({ program: (recorder) => recorder.programDefault("statusschedule.php", { body: schedule(zones, rainSensors), kind: "response" }),
      signalAborted: false });

    t.after(() => h.abort());

    await waitUntil(() => loggedAt(h.entries, "info", "Gamma [Zone 3]: Currently running"),
      { description: "an info line containing \"Gamma [Zone 3]: Currently running\"" });

    assert.ok(loggedAt(h.entries, "info", "Alpha [Zone 1]: No runs are currently scheduled."), "an unscheduled zone states the absence rather than guessing a cause");
    assert.ok(loggedAt(h.entries, "info", "Beta [Zone 2]: Next run will be at 4:00 PM for 8 minutes."), "a scheduled zone reports the run its wire fields describe");
    assert.ok(loggedAt(h.entries, "info", "Gamma [Zone 3]: Currently running with 10 minutes remaining."), "a running zone reports the time it has left");
  });

  test("names a genuinely rain-stopped zone at its first sighting", async (t) => {

    const zones = [ rainZone(), rainZone({ name: "Beta", relay: 2, relay_id: 700002 }) ];

    const h = buildController({ program: (recorder) => recorder.programDefault("statusschedule.php", { body: schedule(zones, rainSensors), kind: "response" }),
      signalAborted: false });

    t.after(() => h.abort());

    await waitUntil(() => loggedAt(h.entries, "info", "Beta [Zone 2]:"), { description: "an info line containing \"Beta [Zone 2]:\"" });

    // Every zone the sensor covers carries the sentinel, so the sensor itself is the evidence and both zones read as rain-stopped rather than merely unscheduled.
    assert.ok(loggedAt(h.entries, "info", "Alpha [Zone 1]: Rain sensor is preventing irrigation."), "a fully sentineled covered group reads as a rain stop");
    assert.ok(loggedAt(h.entries, "info", "Beta [Zone 2]: Rain sensor is preventing irrigation."), "every zone of that group reads the same way");
  });

  test("a zone losing its schedule while a covered sibling still has one logs no rain transition", async (t) => {

    const before = [ rainZone(), scheduledZone({ name: "Beta", relay: 2, relay_id: 700002 }), scheduledZone({ name: "Gamma", relay: 3, relay_id: 700003 }) ];
    const after = [ rainZone(), rainZone({ name: "Beta", relay: 2, relay_id: 700002 }), scheduledZone({ name: "Gamma", relay: 3, relay_id: 700003 }) ];

    const h = buildController({ program: (recorder) => {

      recorder.program("statusschedule.php", { body: schedule(before, rainSensors), kind: "response" });
      recorder.programDefault("statusschedule.php", { body: schedule(after, rainSensors), kind: "response" });
    }, signalAborted: false });

    t.after(() => h.abort());

    // Wait past the poll that moves Beta so the transition has certainly been processed, then confirm it produced no rain line. Gamma still holds a schedule under
    // the same sensor, so the sensor is demonstrably not tripping and Beta is merely without a run - a state the rain sentence would misreport.
    await waitUntil(() => h.retrieve.callsTo("statusschedule.php").length >= 3, { description: "the third status poll" });

    assert.ok(loggedAt(h.entries, "info", "Alpha [Zone 1]: No runs are currently scheduled."), "the first poll's mixed body was processed");
    assert.equal(logCount(h.entries, "info", "Rain sensor is stopping irrigation"), 0, "suspending a zone under a sensor that is not tripping is not a rain stop");
  });

  test("the last covered sibling losing its schedule flips the whole group, and regaining it flips the group back", async (t) => {

    const mixed = [ rainZone(), scheduledZone({ name: "Beta", relay: 2, relay_id: 700002 }) ];
    const stopped = [ rainZone(), rainZone({ name: "Beta", relay: 2, relay_id: 700002 }) ];

    const h = buildController({ program: (recorder) => {

      recorder.program("statusschedule.php", { body: schedule(mixed, rainSensors), kind: "response" });
      recorder.program("statusschedule.php", { body: schedule(stopped, rainSensors), kind: "response" });
      recorder.programDefault("statusschedule.php", { body: schedule(mixed, rainSensors), kind: "response" });
    }, signalAborted: false });

    t.after(() => h.abort());

    await waitUntil(() => loggedAt(h.entries, "info", "Beta [Zone 2]: Rain sensor is allowing irrigation."),
      { description: "an info line containing \"Beta [Zone 2]: Rain sensor is allowing irrigation.\"" });

    /* Alpha's own wire body never moves across these three polls - it carries the sentinel throughout - so both of its lines are driven entirely by Beta, the last
     * covered sibling holding a schedule. Each line is asserted name-qualified because a bare substring cannot tell both zones logging from only the zone whose
     * own body changed, and Alpha's line is precisely the sibling-driven flip worth asserting.
     */
    assert.ok(loggedAt(h.entries, "info", "Alpha [Zone 1]: Rain sensor is stopping irrigation."), "the group completing stops the zone that never moved");
    assert.ok(loggedAt(h.entries, "info", "Beta [Zone 2]: Rain sensor is stopping irrigation."), "the group completing stops the zone that moved");
    assert.ok(loggedAt(h.entries, "info", "Alpha [Zone 1]: Rain sensor is allowing irrigation."), "the group breaking again releases the zone that never moved");
    assert.ok(loggedAt(h.entries, "info", "Beta [Zone 2]: Rain sensor is allowing irrigation."), "the group breaking again releases the zone that moved");
  });

  test("prunes a valve when its zone disappears from the response", async (t) => {

    const twoZones = [ scheduledZone(), makeZone({ name: "Beta", relay: 2, relay_id: 700002, run: 480, time: 69000, timestr: "16:08" }) ];

    const h = buildController({ program: (recorder) => {

      recorder.program("statusschedule.php", { body: schedule(twoZones), kind: "response" });
      recorder.programDefault("statusschedule.php", { body: schedule([scheduledZone()]), kind: "response" });
    }, signalAborted: false });

    t.after(() => h.abort());

    // Both valves appear on poll 1; Beta vanishes from every later poll, so its valve is pruned while Alpha's survives.
    await waitUntil(() => h.accessory.getServiceById(Service.Valve, "700002") !== undefined, { description: "the valve for zone 700002 to appear" });
    await waitUntil(() => h.accessory.getServiceById(Service.Valve, "700002") === undefined, { description: "the valve for zone 700002 to be removed" });

    assert.ok(h.accessory.getServiceById(Service.Valve, "700001"), "the surviving zone's valve should remain");
    assert.equal(h.accessory.getServiceById(Service.Valve, "700002"), undefined, "the vanished zone's valve should be pruned");
  });

  test("creates a valve for a zone that appears on a later poll", async (t) => {

    const h = buildController({ program: (recorder) => {

      recorder.program("statusschedule.php", { body: schedule([scheduledZone()]), kind: "response" });
      recorder.programDefault("statusschedule.php", { body: schedule([ scheduledZone(),
        makeZone({ name: "Gamma", relay: 3, relay_id: 700003, run: 480, time: 70000, timestr: "16:16" }) ]), kind: "response" });
    }, signalAborted: false });

    t.after(() => h.abort());

    await waitUntil(() => h.accessory.getServiceById(Service.Valve, "700003") !== undefined, { description: "the valve for zone 700003 to appear" });

    assert.ok(h.accessory.getServiceById(Service.Valve, "700003"), "a newly appearing zone should get a valve");
  });

  test("omits the valve for a zone disabled at zone scope", async (t) => {

    const threeZones = [ scheduledZone(), makeZone({ name: "Beta", relay: 2, relay_id: 700002, run: 480, time: 69000, timestr: "16:08" }),
      makeZone({ name: "Gamma", relay: 3, relay_id: 700003, run: 480, time: 70000, timestr: "16:16" }) ];

    const h = buildController({ program: (recorder) => recorder.programDefault("statusschedule.php", { body: schedule(threeZones), kind: "response" }),
      signalAborted: false, userOptions: ["Disable.Device.700002"] });

    t.after(() => h.abort());

    // Wait for the enabled zones' valves, then confirm the disabled zone never got one.
    await waitUntil(() => h.accessory.getServiceById(Service.Valve, "700003") !== undefined, { description: "the valve for zone 700003 to appear" });

    assert.ok(h.accessory.getServiceById(Service.Valve, "700001"), "the first enabled zone should have a valve");
    assert.equal(h.accessory.getServiceById(Service.Valve, "700002"), undefined, "the zone disabled at zone scope should have no valve");
    assert.ok(h.accessory.getServiceById(Service.Valve, "700003"), "the third enabled zone should have a valve");
  });

  test("a zone-scoped Enable override keeps one valve while a controller disable omits the siblings", async (t) => {

    const threeZones = [ scheduledZone(), makeZone({ name: "Beta", relay: 2, relay_id: 700002, run: 480, time: 69000, timestr: "16:08" }),
      makeZone({ name: "Gamma", relay: 3, relay_id: 700003, run: 480, time: 70000, timestr: "16:16" }) ];

    // The controller-scoped disable turns every zone off, and the zone-scoped enable override - resolved at the device slot ahead of the controller slot - flips
    // just zone 700001 back on. The controller itself is built directly, so the whole-device platform gate is not in play here.
    const h = buildController({ program: (recorder) => recorder.programDefault("statusschedule.php", { body: schedule(threeZones), kind: "response" }),
      signalAborted: false, userOptions: [ "Disable.Device.SN0A1B2C3D4", "Enable.Device.700001" ] });

    t.after(() => h.abort());

    // Wait for a full pass (the last enabled zone would be 700001 here) then confirm only the overridden zone got a valve.
    await waitUntil(() => h.accessory.getServiceById(Service.Valve, "700001") !== undefined, { description: "the valve for zone 700001 to appear" });
    await waitUntil(() => h.retrieve.callsTo("statusschedule.php").length >= 2, { description: "the second status poll" });

    assert.ok(h.accessory.getServiceById(Service.Valve, "700001"), "the zone with the enable override should have a valve");
    assert.equal(h.accessory.getServiceById(Service.Valve, "700002"), undefined, "a sibling zone under the controller disable should have no valve");
    assert.equal(h.accessory.getServiceById(Service.Valve, "700003"), undefined, "a sibling zone under the controller disable should have no valve");
  });
});

describe("HydrawiseController suspension transitions", () => {

  // The suspension instant the live account capture recorded, kept verbatim so the narrated date is rendered from a real far-future value.
  const SUSPENDED_UNTIL = 1903928399;

  // One zone under the ambiguous sentinel shape, so whether it reads as suspended rests entirely on the account facts.
  function sentinelZone(): HydrawiseZoneConfig {

    return makeZone({ name: "Alpha", relay: 1, relay_id: 700001, run: 0, time: HYDRAWISE_UNSCHEDULED_SENTINEL, timestr: "" });
  }

  function suspendedFacts(): HydrawiseControllerV2Facts {

    return makeV2Facts({ zones: [[ 700001, makeZoneV2Facts({ suspendedUntil: SUSPENDED_UNTIL }) ]] });
  }

  test("a suspension arriving on a refresh is narrated with that refresh, and lifting it is narrated once", async (t) => {

    /* The transition is narrated from the REFRESH cadence rather than waiting for the next poll, which is the point of running the projection tail from both
     * cadences: a quarter hour is a long time to show a zone the wrong state.
     */
    const h = buildController({ hasV2Client: true,
      program: (recorder) => recorder.programDefault("statusschedule.php", { body: schedule([sentinelZone()]), kind: "response" }), signalAborted: false });

    t.after(() => h.abort());

    await waitUntil(() => h.accessory.getServiceById(Service.Valve, "700001") !== undefined, { description: "the valve for zone 700001 to appear" });

    h.controller.applyFacts({ facts: suspendedFacts(), fetchedAt: Math.floor(Date.now() / 1000) });

    assert.equal(logCount(h.entries, "info", "Suspended until"), 1, "the suspension is narrated exactly once");
    assert.ok(loggedAt(h.entries, "info", "[Zone 1]"), "the line names the zone the operator sees on the controller");

    // A repeat of the same facts is not a transition, so it says nothing further.
    h.controller.applyFacts({ facts: suspendedFacts(), fetchedAt: Math.floor(Date.now() / 1000) });
    assert.equal(logCount(h.entries, "info", "Suspended until"), 1, "an unchanged suspension narrates nothing further");

    // Clearing it is its own transition, narrated once and in its own words.
    h.controller.applyFacts({ facts: makeV2Facts({ zones: [[ 700001, makeZoneV2Facts() ]] }), fetchedAt: Math.floor(Date.now() / 1000) });

    assert.equal(logCount(h.entries, "info", "Suspension lifted."), 1, "lifting the suspension is narrated exactly once");
  });

  test("a zone first sighted while already suspended narrates no transition it never made", async (t) => {

    /* The seeding assertion, mirroring the rain-sensor seed. The ledger seeds a zone's suspension state from the live reading on first sighting, so a plugin restarting
     * while a zone is suspended does not announce a suspension that has been standing for days.
     */
    const h = buildController({ hasV2Client: true,
      program: (recorder) => recorder.programDefault("statusschedule.php", { body: schedule([sentinelZone()]), kind: "response" }), signalAborted: false });

    t.after(() => h.abort());

    // The facts land before any poll has completed, so the very first poll's walk seeds the zone already reading as suspended.
    h.controller.applyFacts({ facts: suspendedFacts(), fetchedAt: Math.floor(Date.now() / 1000) });

    await waitUntil(() => h.accessory.getServiceById(Service.Valve, "700001") !== undefined, { description: "the valve for zone 700001 to appear" });
    await waitUntil(() => h.retrieve.callsTo("statusschedule.php").length >= 2, { description: "the second status poll" });

    // The status sentence is the control that the facts landed before the first sighting, so the zone was seeded reading as suspended rather than never classified.
    assert.ok(loggedAt(h.entries, "info", "Watering is suspended until"), "the zone's first-sighting status names the suspension it was sighted under");
    assert.equal(logCount(h.entries, "info", "Suspended until"), 0, "a zone sighted already suspended announces nothing");
  });

  test("the suspension status sentence names the suspension rather than the unscheduled wording", async (t) => {

    // The threading assertion for the first-sighting status line: a credentialed suspended zone must not log the "no runs scheduled" sentence while the webUI says
    // Suspended, which is exactly what an unthreaded classifier call at that site would produce.
    const h = buildController({ hasV2Client: true,
      program: (recorder) => recorder.programDefault("statusschedule.php", { body: schedule([sentinelZone()]), kind: "response" }), signalAborted: false });

    t.after(() => h.abort());

    h.controller.applyFacts({ facts: suspendedFacts(), fetchedAt: Math.floor(Date.now() / 1000) });

    await waitUntil(() => h.accessory.getServiceById(Service.Valve, "700001") !== undefined, { description: "the valve for zone 700001 to appear" });

    assert.ok(loggedAt(h.entries, "info", "Watering is suspended until"), "the zone's status sentence names its suspension");
    assert.ok(!loggedAt(h.entries, "info", "No runs are currently scheduled"), "and never falls back to the unscheduled wording");
  });

  test("an install with no credentials narrates no suspension at all", async (t) => {

    // The parity restatement: nothing above is reachable without the account credentials, so the sentinel shape reads and reads out exactly as it always has.
    const h = buildController({ program: (recorder) => recorder.programDefault("statusschedule.php", { body: schedule([sentinelZone()]), kind: "response" }),
      signalAborted: false });

    t.after(() => h.abort());

    await waitUntil(() => h.accessory.getServiceById(Service.Valve, "700001") !== undefined, { description: "the valve for zone 700001 to appear" });

    assert.ok(loggedAt(h.entries, "info", "No runs are currently scheduled"), "the key-based sentence is what an unenriched zone reports");
    assert.equal(logCount(h.entries, "info", "suspended"), 0, "and no suspension is claimed anywhere");
  });
});

describe("HydrawiseController suspension instant rendering", () => {

  // One zone under the ambiguous sentinel shape, so the narrated sentence rests entirely on the account facts.
  function sentinelZone(): HydrawiseZoneConfig {

    return makeZone({ name: "Alpha", relay: 1, relay_id: 700001, run: 0, time: HYDRAWISE_UNSCHEDULED_SENTINEL, timestr: "" });
  }

  // Drive a controller to narrate a suspension ending at the given instant, and hand back its captured lines.
  async function narrate(until: number): Promise<string[]> {

    const h = buildController({ hasV2Client: true,
      program: (recorder) => recorder.programDefault("statusschedule.php", { body: schedule([sentinelZone()]), kind: "response" }), signalAborted: false });

    h.controller.applyFacts({ facts: makeV2Facts({ zones: [[ 700001, makeZoneV2Facts({ suspendedUntil: until }) ]] }),
      fetchedAt: Math.floor(Date.now() / 1000) });

    await waitUntil(() => h.accessory.getServiceById(Service.Valve, "700001") !== undefined, { description: "the valve for zone 700001 to appear" });
    h.abort();

    return h.entries.map(formatLogEntry);
  }

  test("renders a suspension ending today as the clock alone, and one later in the week with its weekday", async () => {

    /* The runtime formatter's rendering tiers, driven through the sentence a user actually reads. Every expected string is computed through the identical Intl
     * call the formatter itself makes, so a host in another locale or timezone moves both sides together rather than reddening a correct implementation.
     */
    const soon = Math.floor(Date.now() / 1000) + 3600;
    const soonWhen = new Date(soon * 1000);
    const soonClock = soonWhen.toLocaleTimeString(undefined, { hour: "numeric", minute: "2-digit" });

    // An hour out can legitimately fall on tomorrow's calendar day near midnight, so the expectation is derived the same way the formatter decides it.
    const sameDay = soonWhen.toDateString() === new Date().toDateString();
    const expectedSoon = sameDay ? soonClock : (soonWhen.toLocaleDateString(undefined, { weekday: "short" }) + " " + soonClock);

    assert.ok((await narrate(soon)).some(line => line.includes("Watering is suspended until " + expectedSoon + ".")),
      "a near-term suspension renders through the clock tier");

    const later = Math.floor(Date.now() / 1000) + (3 * 24 * 3600);
    const laterWhen = new Date(later * 1000);
    const expectedLater = laterWhen.toLocaleDateString(undefined, { weekday: "short" }) + " " +
      laterWhen.toLocaleTimeString(undefined, { hour: "numeric", minute: "2-digit" });

    assert.ok((await narrate(later)).some(line => line.includes("Watering is suspended until " + expectedLater + ".")),
      "one a few days out carries its weekday");

    const distant = Math.floor(Date.now() / 1000) + (400 * 24 * 3600);

    assert.ok((await narrate(distant)).some(line => line.includes("Watering is suspended until " + new Date(distant * 1000).toLocaleDateString() + ".")),
      "and one beyond the week renders as a locale date, where a weekday alone would be ambiguous");
  });
});

describe("HydrawiseController rain transitions speak for the sensor", () => {

  // The suspension instant the live account capture recorded, kept verbatim so these assertions run against a real far-future value.
  const SUSPENDED_UNTIL = 1903928399;

  function now(): number {

    return Math.floor(Date.now() / 1000);
  }

  // The facts one refresh reports for the single covered zone: what the sensor says, and whether a suspension stands.
  function facts(sensorStopped: boolean, suspendedUntil: number | null): HydrawiseControllerV2Facts {

    return makeV2Facts({ zones: [[ 700001, { name: null, sensorStopped, suspendedUntil } ]] });
  }

  /* Drive a controller whose single zone is covered by a rain sensor and carries the sentinel, hand it a first facts snapshot, let a poll settle, then hand it a
   * second and let another poll settle. The rain hint is refreshed in the poll walk, so a transition can only be observed after a poll that followed the facts.
   */
  async function driveFacts(first: HydrawiseControllerV2Facts, second: HydrawiseControllerV2Facts): Promise<string[]> {

    const h = buildController({ hasV2Client: true,
      program: (recorder) => recorder.programDefault("statusschedule.php", { body: schedule([rainZone()], rainSensors), kind: "response" }),
      signalAborted: false });

    h.controller.applyFacts({ facts: first, fetchedAt: now() });

    await waitUntil(() => h.accessory.getServiceById(Service.Valve, "700001") !== undefined, { description: "the valve for zone 700001 to appear" });
    await waitUntil(() => h.retrieve.callsTo("statusschedule.php").length >= 2, { description: "the second status poll" });

    const settled = h.retrieve.callsTo("statusschedule.php").length;

    h.controller.applyFacts({ facts: second, fetchedAt: now() });

    await waitUntil(() => h.retrieve.callsTo("statusschedule.php").length > (settled + 1), { description: "the second status poll past the settled one" });
    h.abort();

    return h.entries.map(formatLogEntry);
  }

  test("a suspension landing while the sensor is STILL tripped narrates no rain transition", async () => {

    /* The soak's exact case: the sensor does not change across the two snapshots - it reports itself tripped throughout - and only the suspension arrives. A hint
     * derived from the classified state would see the zone flip from sensor-stopped to suspended and narrate that reclassification as the sensor allowing
     * irrigation again, one minute after a suspension, while rain was still falling.
     */
    const lines = await driveFacts(facts(true, null), facts(true, SUSPENDED_UNTIL));

    assert.equal(lines.filter(line => line.includes("Rain sensor is allowing irrigation")).length, 0,
      "the sensor never changed, so no rain transition may be narrated");
  });

  test("a sensor that genuinely quiets narrates the transition even on a zone that is suspended", async () => {

    /* The other direction: rain narration reads the sensor's own reading rather than simply ignoring suspended zones. A suspension does not make a zone deaf to
     * its sensor: when the rain actually stops, that is a real transition and the operator is told, whatever else is true of the zone.
     */
    const lines = await driveFacts(facts(true, SUSPENDED_UNTIL), facts(false, SUSPENDED_UNTIL));

    assert.equal(lines.filter(line => line.includes("Rain sensor is allowing irrigation")).length, 1,
      "a sensor that stops tripping is narrated even while the zone stays suspended");
  });

  test("a sensor that starts tripping narrates the stop on a zone that is already suspended", async () => {

    // The same claim in the opposite direction, so neither edge of the transition is silently tied to the classification.
    const lines = await driveFacts(facts(false, SUSPENDED_UNTIL), facts(true, SUSPENDED_UNTIL));

    assert.equal(lines.filter(line => line.includes("Rain sensor is stopping irrigation")).length, 1,
      "a sensor that begins tripping is narrated even while the zone stays suspended");
  });
});
