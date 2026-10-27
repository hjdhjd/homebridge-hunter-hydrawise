/* Copyright(C) 2017-2026, HJD (https://github.com/hjdhjd). All rights reserved.
 *
 * controller.roster.test.ts: The accessory-context identity rosters HydrawiseController persists - the self identity and denormalized account roster seeded
 * at construction (with a prior zone roster preserved or shape-degraded across the wipe), and the zone roster written and flushed on change from each poll. These
 * assertions fix the zero-cloud-call source the webUI reads back: the full reported zone set (feature-disabled zones included), identity fields only, flushed exactly
 * once per change and never on an unchanged poll.
 */

// The Hydrawise API wire shapes use snake_case keys such as relay_id, so camelcase is disabled here to let the zone fixtures mirror the wire verbatim.
/* eslint-disable camelcase */
import type { HydrawiseAccessoryContext, HydrawiseControllerIdentity, HydrawiseZoneConfig, HydrawiseZoneIdentity, StatusScheduleResponse } from "./types.ts";
import { bareSensors, normalZoneMatrix } from "./api.fixtures.ts";
import { describe, test } from "node:test";
import { expectAt, waitUntil } from "homebridge-plugin-utils/testing";
import { fastPolling, makeStatusSchedule, makeZone, normalSchedule } from "./api.helpers.ts";
import assert from "node:assert/strict";
import { assertSameShape } from "./testing.helpers.ts";
import { buildController } from "./testing/platform.helpers.ts";

// The synthetic controller identity the default fixture carries, and a disabled sibling, so the denormalized account roster the platform passes in carries more than
// one controller.
const SELF_IDENTITY: HydrawiseControllerIdentity = { controllerId: 500001, name: "Test Controller", serialNumber: "SN0A1B2C3D4" };
const SIBLING_IDENTITY: HydrawiseControllerIdentity = { controllerId: 500002, name: "Second Controller", serialNumber: "SN0E5F6G7H8" };

// Compose a fast-cadence schedule around a zone list with a bare sensor block, so a live-loop test cycles in roughly 250ms.
function schedule(zones: HydrawiseZoneConfig[]): StatusScheduleResponse {

  return fastPolling(makeStatusSchedule({ relays: zones, sensors: bareSensors }));
}

// The identity-only projection the runtime persists for a reported zone list - the exact shape the webUI reads back from cache. This helper preserves
// whatever order its input carries rather than sorting it itself, so callers pass an already relay-ordered zone list to match the runtime's own sorted
// persistence.
function zoneRoster(zones: readonly HydrawiseZoneConfig[]): HydrawiseZoneIdentity[] {

  return zones.map(zone => ({ name: zone.name, relay: zone.relay, relayId: zone.relay_id }));
}

// Read the accessory context back through its typed shape.
function contextOf(accessory: { context: unknown }): HydrawiseAccessoryContext {

  return accessory.context as HydrawiseAccessoryContext;
}

describe("HydrawiseController context rosters (construction)", () => {

  test("seeds its own identity and the full denormalized account roster, including a disabled sibling", () => {

    const { accessory } = buildController({ roster: [ SELF_IDENTITY, SIBLING_IDENTITY ] });
    const context = contextOf(accessory);

    assert.deepEqual(context.controller, SELF_IDENTITY, "the context carries the owning controller's own identity");
    assert.deepEqual(context.controllers, [ SELF_IDENTITY, SIBLING_IDENTITY ], "the context carries every account controller, the disabled sibling included");
  });

  test("preserves a well-formed prior zone roster across the constructor's context wipe", () => {

    const prior: HydrawiseZoneIdentity[] = [ { name: "Alpha", relay: 1, relayId: 700001 }, { name: "Beta", relay: 2, relayId: 700002 } ];
    const { accessory } = buildController({ seedContext: (seed) => { seed.context = { zones: prior }; } });

    assert.deepEqual(contextOf(accessory).zones, prior, "a well-formed prior zone roster survives the wipe-then-seed pass");
  });

  test("degrades a non-array prior zone roster to empty", () => {

    const { accessory } = buildController({ seedContext: (seed) => { seed.context = { zones: "not an array" }; } });

    assert.deepEqual(contextOf(accessory).zones, [], "a non-array prior value shape-degrades to an empty roster");
  });

  test("degrades a prior zone roster with a malformed entry to empty", () => {

    const { accessory } = buildController({ seedContext: (seed) => { seed.context = { zones: [{ name: "Alpha" }] }; } });

    assert.deepEqual(contextOf(accessory).zones, [], "an entry missing an identity field shape-degrades the whole roster to empty");
  });
});

describe("HydrawiseController zone-roster persistence (poll)", () => {

  test("the first poll persists the full reported zone roster, feature-disabled zones included, identity fields only", async (t) => {

    const h = buildController({ program: (recorder) => recorder.programDefault("statusschedule.php", { body: fastPolling(normalSchedule()), kind: "response" }),
      signalAborted: false, userOptions: ["Disable.Device.700002"] });

    t.after(() => h.abort());

    await waitUntil(() => h.flushes().length >= 1, { description: "the first accessory flush" });

    const zones = contextOf(h.accessory).zones;

    // The persisted roster carries every reported zone in relay order, the feature-disabled 700002 included, and each entry carries only its identity fields - a
    // deepEqual against the projection also proves no volatile wire field (run, time, timestr) leaked into the persisted context.
    assert.deepEqual(zones, zoneRoster(normalZoneMatrix), "the persisted roster is the full reported zone set projected to identity fields, ordered by relay");
    assert.equal(zones.length, normalZoneMatrix.length, "the persisted roster length equals the full reported relay count");
    assert.ok(zones.some(zone => zone.relayId === 700002), "a feature-disabled zone still appears in the persisted roster");
    assert.deepEqual(Object.keys(expectAt(zones, 0, "zone")).toSorted(), [ "name", "relay", "relayId" ], "each entry carries exactly the three identity fields");
  });

  test("an unchanged second poll does not re-flush", async (t) => {

    const h = buildController({ program: (recorder) => recorder.programDefault("statusschedule.php", { body: fastPolling(normalSchedule()), kind: "response" }),
      signalAborted: false });

    t.after(() => h.abort());

    // Poll 1 seeds the roster from the empty seed and flushes once; every later poll reports the identical set. Bounding on the third call guarantees poll 2 fully
    // ran its field-wise comparison before we read, so a single flush proves the unchanged poll took the no-change return.
    await waitUntil(() => h.retrieve.callsTo("statusschedule.php").length >= 3, { description: "the third status poll" });
    h.abort();

    assert.equal(h.flushes().length, 1, "only the first poll flushes; an unchanged poll does not re-flush");
  });

  test("the schedule seed and a zone rename each flush exactly once", async (t) => {

    const alpha = makeZone({ name: "Alpha", relay: 1, relay_id: 700001, run: 480, time: 68000, timestr: "16:00" });
    const beta = makeZone({ name: "Beta", relay: 1, relay_id: 700001, run: 480, time: 68000, timestr: "16:00" });

    // Seed the context with the pre-rename roster so poll 1 matches and does not flush; the rename is then the sole flush.
    const h = buildController({ program: (recorder) => {

      recorder.program("statusschedule.php", { body: schedule([alpha]), kind: "response" });
      recorder.programDefault("statusschedule.php", { body: schedule([beta]), kind: "response" });
    }, seedContext: (seed) => { seed.context = { zones: zoneRoster([alpha]) }; }, signalAborted: false });

    t.after(() => h.abort());

    await waitUntil(() => h.retrieve.callsTo("statusschedule.php").length >= 3, { description: "the third status poll" });
    h.abort();

    assert.equal(h.flushes().length, 2, "the matching first poll flushes the schedule seed alone; the rename then flushes exactly once");
    assert.equal(expectAt(contextOf(h.accessory).zones ?? [], 0, "zone").name, "Beta", "the persisted roster adopted the renamed zone");
  });

  test("the schedule seed and a zone disappearance each flush exactly once", async (t) => {

    const first = makeZone({ name: "First", relay: 1, relay_id: 700001, run: 480, time: 68000, timestr: "16:00" });
    const second = makeZone({ name: "Second", relay: 2, relay_id: 700002, run: 480, time: 68000, timestr: "16:00" });

    // Seed the context with both zones so poll 1 matches; the disappearance of the second zone is then the sole flush.
    const h = buildController({ program: (recorder) => {

      recorder.program("statusschedule.php", { body: schedule([ first, second ]), kind: "response" });
      recorder.programDefault("statusschedule.php", { body: schedule([first]), kind: "response" });
    }, seedContext: (seed) => { seed.context = { zones: zoneRoster([ first, second ]) }; }, signalAborted: false });

    t.after(() => h.abort());

    await waitUntil(() => h.retrieve.callsTo("statusschedule.php").length >= 3, { description: "the third status poll" });
    h.abort();

    assert.equal(h.flushes().length, 2, "the matching first poll flushes the schedule seed alone; the vanished zone then flushes exactly once");
    assert.equal(contextOf(h.accessory).zones?.length, 1, "the persisted roster dropped the vanished zone");
  });

  test("a runtime-built context conforms to the persisted identity shapes and survives a JSON round trip", async (t) => {

    const h = buildController({ program: (recorder) => recorder.programDefault("statusschedule.php", { body: fastPolling(normalSchedule()), kind: "response" }),
      roster: [ SELF_IDENTITY, SIBLING_IDENTITY ], signalAborted: false });

    t.after(() => h.abort());

    await waitUntil(() => h.flushes().length >= 1, { description: "the first accessory flush" });

    const context = contextOf(h.accessory);
    const referenceController: HydrawiseControllerIdentity = { controllerId: 0, name: "", serialNumber: "" };
    const referenceZone: HydrawiseZoneIdentity = { name: "", relay: 0, relayId: 0 };

    assertSameShape(context.controller ?? {}, referenceController, "the runtime-built self identity");

    for(const entry of context.controllers ?? []) {

      assertSameShape(entry, referenceController, "a runtime-built account-roster entry");
    }

    for(const entry of context.zones ?? []) {

      assertSameShape(entry, referenceZone, "a runtime-built zone-roster entry");
    }

    // The whole context is plain, JSON-serializable data: a round trip through JSON returns an equal value, so Homebridge's cache save can never fail on a
    // non-serializable context field.
    assert.deepEqual(JSON.parse(JSON.stringify(context)), context, "the persisted context is plain data that survives a JSON round trip");
  });
});
