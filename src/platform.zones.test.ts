/* Copyright(C) 2017-2026, HJD (https://github.com/hjdhjd). All rights reserved.
 *
 * platform.zones.test.ts: The standalone zone accessory contract the platform owns - reconcileZoneAccessories and the discovery-time orphan sweep's
 * kind dispatch. Drives the reconcile directly against a real HydrawisePlatform (it is public API; the controller is its one production caller, but the contract
 * belongs to the platform) and drives the sweep through the captured DID_FINISH_LAUNCHING handler exactly as the discovery suite does.
 *
 * Covers the persistence-critical UUID seed, the accessory category and sanitized name, the exclusive context key set, the field-wise refresh comparison, the
 * demotion split between configuration intent and wire absence with its poll-count grace, per-controller isolation, the per-zone promotion-failure
 * containment, and the undo that runs when a registered accessory fails to persist.
 */

// The Hydrawise API wire shapes use snake_case keys such as relay_id and controller_id, so camelcase is disabled here to let the fixtures mirror the wire verbatim.
/* eslint-disable camelcase */
import { HYDRAWISE_ZONE_ACCESSORY_CATEGORY, HYDRAWISE_ZONE_ACCESSORY_GRACE_POLLS } from "./settings.ts";
import type { HydrawiseControllerConfig, HydrawiseZoneConfig, HydrawiseZoneIdentity } from "./types.ts";
import { buildPlatform, installMockDispatcher, programJsonReply, seedAccessory } from "./testing/platform.helpers.ts";
import { controllerIdentity, zoneAccessoryId, zoneIdentity } from "./types.ts";
import { describe, test } from "node:test";
import { loggedAt, waitUntil } from "homebridge-plugin-utils/testing";
import { makeCustomerDetails, makeZone, normalSchedule } from "./api.helpers.ts";
import type { HydrawisePlatform } from "./platform.ts";
import assert from "node:assert/strict";
import { sanitizeName } from "homebridge-plugin-utils";
import { syntheticController } from "./api.fixtures.ts";

const DID_FINISH_LAUNCHING = "didFinishLaunching";
const SHUTDOWN = "shutdown";

// The wire zone name carries a character HomeKit disallows, so a raw name and its sanitized form are observably different values. Every test that asserts on a
// display name states that difference as a precondition, which is what keeps the assertion from passing vacuously against an implementation that never sanitizes.
const RAW_ZONE_NAME = "Front/Back Lawn";

// The effective name a Device.Name override would produce. It differs from the wire name above, which is what lets a test tell the two apart when they travel
// in the same request.
const OVERRIDE_ZONE_NAME = "Custom Zone";

const ZONE_RELAY_ID = 700001;
const SECOND_RELAY_ID = 700002;

// A relay id the synthetic wire matrix does not carry. The sweep assertions seed their zone accessories against it so the only decision under test is the sweep's own:
// a zone the wire still reports would also be answerable by the poll-cadence reconcile, which would make a surviving accessory ambiguous evidence.
const OFF_WIRE_RELAY_ID = 700099;

// A second controller, for the isolation assertion. Every identity field differs from the synthetic controller's.
const secondController: HydrawiseControllerConfig = { ...syntheticController, controller_id: 500002, name: "Second Controller", serial_number: "SN9Z8Y7X6W5" };

// Build a wire zone for the request fixtures.
function zoneFixture(overrides: Partial<HydrawiseZoneConfig> = {}): HydrawiseZoneConfig {

  return makeZone({ name: RAW_ZONE_NAME, relay: 1, relay_id: ZONE_RELAY_ID, ...overrides });
}

// The UUID HAP generates for a zone accessory's compound identity, the one the platform mints and the only form HAP's accessory constructor accepts.
function zoneUuid(platform: HydrawisePlatform, controllerId: number, relayId: number): string {

  return platform.hap.uuid.generate(zoneAccessoryId(controllerId, relayId));
}

// Build one reconcile request entry. Every call constructs a fresh object graph, so two calls carrying equal values are reference-distinct - the input that tells a
// field-wise comparison apart from a reference comparison.
function zoneRequest(zone: HydrawiseZoneConfig, displayName: string = zone.name): { displayName: string; identity: HydrawiseZoneIdentity } {

  return { displayName, identity: zoneIdentity(zone) };
}

describe("HydrawisePlatform zone accessories (reconcile)", () => {

  test("promotes a requested zone onto an accessory seeded with the compound identity", () => {

    const zone = zoneFixture();
    const { platform, registered, updated } = buildPlatform();

    assert.notEqual(sanitizeName(RAW_ZONE_NAME), RAW_ZONE_NAME, "the fixture name must differ from its sanitized form for the name assertion below to mean anything");

    const hosts = platform.reconcileZoneAccessories({ controller: syntheticController, presentRelayIds: new Set([ZONE_RELAY_ID]),
      zones: [zoneRequest(zone)] });

    assert.equal(registered().length, 1, "a requested zone with no accessory should be registered once");

    const [promoted] = registered();

    // The UUID is HAP's hash of the seed string, so a relay-only or controller-only seed hashes to another UUID and fails here.
    assert.equal(promoted?.UUID, zoneUuid(platform, 500001, 700001), "the accessory UUID is seeded from the controller id and the relay id");
    assert.equal(promoted.displayName, sanitizeName(RAW_ZONE_NAME), "the accessory carries the sanitized display name");
    assert.equal(promoted.category, HYDRAWISE_ZONE_ACCESSORY_CATEGORY, "the accessory declares the sprinkler category");
    assert.deepEqual(Object.keys(promoted.context).toSorted(), [ "ownerController", "zone" ],
      "the zone context carries exactly the zone-accessory pair and no controller-accessory field");
    assert.deepEqual(promoted.context["ownerController"], controllerIdentity(syntheticController), "the context stamps the owning controller's identity");
    assert.equal(updated().length, 1, "seeding the context flushes the accessory once");
    assert.equal(hosts.get(ZONE_RELAY_ID)?.UUID, zoneUuid(platform, 500001, 700001), "the returned map hosts the requested zone");
  });

  test("logs the identity-change guidance when a zone is promoted", () => {

    const zone = zoneFixture();
    const { entries, platform } = buildPlatform();

    platform.reconcileZoneAccessories({ controller: syntheticController, presentRelayIds: new Set([ZONE_RELAY_ID]), zones: [zoneRequest(zone)] });

    assert.ok(loggedAt(entries, "info", "must be set up again in the Home app"), "a promotion narrates the identity change it makes");
  });

  test("carries the wire name in the persisted identity and the effective name on the accessory", () => {

    const zone = zoneFixture();
    const { platform, registered } = buildPlatform();

    // The override case: the request's displayName is the effective name while its identity still carries the name Hydrawise reported. An implementation that wrote
    // the effective name into the identity would fail the context assertion below.
    platform.reconcileZoneAccessories({ controller: syntheticController, presentRelayIds: new Set([ZONE_RELAY_ID]),
      zones: [zoneRequest(zone, OVERRIDE_ZONE_NAME)] });

    const [promoted] = registered();

    assert.equal(promoted?.displayName, OVERRIDE_ZONE_NAME, "the accessory takes the effective display name");
    assert.deepEqual(promoted.context["zone"], { name: RAW_ZONE_NAME, relay: 1, relayId: ZONE_RELAY_ID }, "the persisted identity carries the wire name");
  });

  test("a second reconcile of an unchanged zone registers and flushes nothing", () => {

    const zone = zoneFixture();
    const { platform, registered, updated } = buildPlatform();

    platform.reconcileZoneAccessories({ controller: syntheticController, presentRelayIds: new Set([ZONE_RELAY_ID]), zones: [zoneRequest(zone)] });

    const flushesAfterFirst = updated().length;

    // Freshly constructed request objects whose field values equal the first call's. A reference comparison would read them as changed and flush.
    platform.reconcileZoneAccessories({ controller: syntheticController, presentRelayIds: new Set([ZONE_RELAY_ID]), zones: [zoneRequest(zoneFixture())] });

    assert.equal(registered().length, 1, "an existing zone accessory is reused rather than registered again");
    assert.equal(updated().length, flushesAfterFirst, "an unchanged identity pair writes and flushes nothing");
  });

  test("a changed zone name rewrites the whole context and flushes exactly once", () => {

    const { platform, registered, updated } = buildPlatform();

    platform.reconcileZoneAccessories({ controller: syntheticController, presentRelayIds: new Set([ZONE_RELAY_ID]), zones: [zoneRequest(zoneFixture())] });

    const flushesAfterFirst = updated().length;

    platform.reconcileZoneAccessories({ controller: syntheticController, presentRelayIds: new Set([ZONE_RELAY_ID]),
      zones: [zoneRequest(zoneFixture({ name: "Renamed Zone" }))] });

    assert.equal(registered().length, 1, "a rename reuses the accessory rather than minting a new identity");
    assert.equal(updated().length, flushesAfterFirst + 1, "a changed identity flushes exactly once");
    assert.deepEqual(registered()[0]?.context["zone"], { name: "Renamed Zone", relay: 1, relayId: ZONE_RELAY_ID }, "the refreshed context carries the new wire name");
  });

  test("rewrites an ambiguous stored context whose values already match", () => {

    const zone = zoneFixture();
    const { platform, registered, updated } = buildPlatform();
    const cached = seedAccessory(platform, sanitizeName(RAW_ZONE_NAME), zoneUuid(platform, syntheticController.controller_id, ZONE_RELAY_ID));

    /* The stored pair equals what the fresh computation produces, so no VALUE difference can explain a rewrite. The one extra controller-shaped field is the only
     * trigger: it makes the context fail the zone-kind predicate, which is how a corrupt or ambiguous cache entry heals.
     */
    cached.context = { controller: controllerIdentity(syntheticController), ownerController: controllerIdentity(syntheticController), zone: zoneIdentity(zone) };

    platform.reconcileZoneAccessories({ controller: syntheticController, presentRelayIds: new Set([ZONE_RELAY_ID]), zones: [zoneRequest(zone)] });

    assert.equal(registered().length, 0, "a cache-restored accessory is reused, never registered a second time");
    assert.equal(updated().length, 1, "the ambiguous context is rewritten and flushed once");
    assert.deepEqual(Object.keys(cached.context).toSorted(), [ "ownerController", "zone" ], "the rewrite assigns a complete fresh object, dropping the stray field");
  });

  test("demotes a wire-present zone the request omits, on that same call", () => {

    const zone = zoneFixture();
    const { entries, platform, unregistered } = buildPlatform();

    platform.reconcileZoneAccessories({ controller: syntheticController, presentRelayIds: new Set([ZONE_RELAY_ID]), zones: [zoneRequest(zone)] });

    // The zone is still on the wire but absent from the request, which can only be a configuration change - so there is nothing to grace.
    platform.reconcileZoneAccessories({ controller: syntheticController, presentRelayIds: new Set([ZONE_RELAY_ID]), zones: [] });

    assert.equal(unregistered().length, 1, "a configuration-intent demotion acts immediately");
    assert.equal(unregistered()[0]?.UUID, zoneUuid(platform, 500001, 700001), "the demoted accessory is the zone's own");
    assert.ok(loggedAt(entries, "info", "must be set up again in the Home app"), "a demotion narrates the identity change it makes");
  });

  test("holds a wire-absent zone through the grace window and demotes it at the end of it", () => {

    const zone = zoneFixture();
    const { platform, unregistered } = buildPlatform();

    platform.reconcileZoneAccessories({ controller: syntheticController, presentRelayIds: new Set([ZONE_RELAY_ID]), zones: [zoneRequest(zone)] });

    // A graceless implementation unregisters on the first absent call, which is what makes these interim assertions the distinguishing ones.
    for(let absence = 1; absence < HYDRAWISE_ZONE_ACCESSORY_GRACE_POLLS; absence++) {

      platform.reconcileZoneAccessories({ controller: syntheticController, presentRelayIds: new Set(), zones: [] });

      assert.equal(unregistered().length, 0, "a zone missing from the wire report survives inside the grace window");
    }

    platform.reconcileZoneAccessories({ controller: syntheticController, presentRelayIds: new Set(), zones: [] });

    assert.equal(unregistered().length, 1, "sustained absence demotes the accessory once the grace window is spent");
  });

  test("resets the grace window when an absent zone reappears", () => {

    const zone = zoneFixture();
    const { platform, unregistered } = buildPlatform();

    platform.reconcileZoneAccessories({ controller: syntheticController, presentRelayIds: new Set([ZONE_RELAY_ID]), zones: [zoneRequest(zone)] });
    platform.reconcileZoneAccessories({ controller: syntheticController, presentRelayIds: new Set(), zones: [] });
    platform.reconcileZoneAccessories({ controller: syntheticController, presentRelayIds: new Set(), zones: [] });

    // The reappearance clears the counter, so the absence that follows counts from zero rather than exhausting a window two polls deep.
    platform.reconcileZoneAccessories({ controller: syntheticController, presentRelayIds: new Set([ZONE_RELAY_ID]), zones: [zoneRequest(zone)] });
    platform.reconcileZoneAccessories({ controller: syntheticController, presentRelayIds: new Set(), zones: [] });

    assert.equal(unregistered().length, 0, "an absent-absent-present-absent sequence leaves the accessory in place");
  });

  test("gives a re-promoted zone a fresh grace window after an earlier removal", () => {

    const zone = zoneFixture();
    const { platform, registered, unregistered } = buildPlatform();

    platform.reconcileZoneAccessories({ controller: syntheticController, presentRelayIds: new Set([ZONE_RELAY_ID]), zones: [zoneRequest(zone)] });

    for(let absence = 0; absence < HYDRAWISE_ZONE_ACCESSORY_GRACE_POLLS; absence++) {

      platform.reconcileZoneAccessories({ controller: syntheticController, presentRelayIds: new Set(), zones: [] });
    }

    assert.equal(unregistered().length, 1, "the grace window is spent and the accessory is gone");

    // The same zone comes back at the same UUID, then goes absent once. A counter inherited across the removal would demote it immediately.
    platform.reconcileZoneAccessories({ controller: syntheticController, presentRelayIds: new Set([ZONE_RELAY_ID]), zones: [zoneRequest(zone)] });

    assert.equal(registered().length, 2, "the zone is promoted again onto a fresh accessory");

    platform.reconcileZoneAccessories({ controller: syntheticController, presentRelayIds: new Set(), zones: [] });

    assert.equal(unregistered().length, 1, "the re-promoted accessory starts a fresh grace window rather than inheriting a spent one");
  });

  test("promotes one zone and demotes another on a single call", () => {

    const first = zoneFixture();
    const second = zoneFixture({ name: "Side Yard", relay: 2, relay_id: SECOND_RELAY_ID });
    const { platform, registered, unregistered } = buildPlatform();

    platform.reconcileZoneAccessories({ controller: syntheticController, presentRelayIds: new Set([ZONE_RELAY_ID]), zones: [zoneRequest(first)] });

    platform.reconcileZoneAccessories({ controller: syntheticController, presentRelayIds: new Set([ ZONE_RELAY_ID, SECOND_RELAY_ID ]),
      zones: [zoneRequest(second)] });

    assert.equal(registered().length, 2, "the newly requested zone is promoted on the same call");
    assert.equal(unregistered().length, 1, "the zone dropped from the request is demoted on the same call");
    assert.equal(unregistered()[0]?.UUID, zoneUuid(platform, 500001, 700001), "the demoted accessory is the one whose zone left the request");
    assert.equal(registered()[1]?.UUID, zoneUuid(platform, 500001, 700002), "the promoted accessory is the one whose zone joined it");
  });

  test("leaves another controller's zone accessories alone", () => {

    const ownZone = zoneFixture();
    const otherZone = zoneFixture({ name: "Side Yard", relay: 2, relay_id: SECOND_RELAY_ID });
    const { platform, registered, unregistered } = buildPlatform();

    platform.reconcileZoneAccessories({ controller: syntheticController, presentRelayIds: new Set([ZONE_RELAY_ID]), zones: [zoneRequest(ownZone)] });
    platform.reconcileZoneAccessories({ controller: secondController, presentRelayIds: new Set([SECOND_RELAY_ID]), zones: [zoneRequest(otherZone)] });

    assert.equal(registered().length, 2, "each controller promotes its own zone");

    /* Reconcile the second controller repeatedly, past the whole grace window, with the first controller's zone in neither its present relay ids nor its requested
     * zones. An owned-set derivation missing the owning-controller filter would count those polls as absences and demote the first controller's accessory here.
     */
    for(let poll = 0; poll <= HYDRAWISE_ZONE_ACCESSORY_GRACE_POLLS; poll++) {

      platform.reconcileZoneAccessories({ controller: secondController, presentRelayIds: new Set([SECOND_RELAY_ID]), zones: [zoneRequest(otherZone)] });
    }

    assert.equal(unregistered().length, 0, "one controller's reconcile never touches another controller's zone accessories");
  });

  test("contains a promotion failure to its own zone and retries it on the next reconcile", () => {

    const failing = zoneFixture();
    const healthy = zoneFixture({ name: "Side Yard", relay: 2, relay_id: SECOND_RELAY_ID });
    const { entries, failRegistrationUuids, platform, registered, unregistered } = buildPlatform();
    const present = new Set([ ZONE_RELAY_ID, SECOND_RELAY_ID ]);

    failRegistrationUuids.add(zoneUuid(platform, syntheticController.controller_id, ZONE_RELAY_ID));

    const hosts = platform.reconcileZoneAccessories({ controller: syntheticController, presentRelayIds: present,
      zones: [ zoneRequest(failing), zoneRequest(healthy) ] });

    assert.equal(hosts.has(ZONE_RELAY_ID), false, "the faulted zone is omitted from the hosting map, so the controller keeps hosting its valve");
    assert.equal(hosts.get(SECOND_RELAY_ID)?.UUID, zoneUuid(platform, 500001, 700002), "the other zone's accessory still lands");
    assert.equal(registered().length, 1, "only the healthy zone is registered");
    assert.equal(unregistered().length, 0, "the throw preceded the registration, so there is nothing to undo");
    assert.ok(loggedAt(entries, "error", "Unable to establish a standalone accessory"), "the fault is reported against the zone it belongs to");

    failRegistrationUuids.clear();

    // A ghost entry left in the tracked array would satisfy the find-by-UUID lookup and short-circuit this retry.
    platform.reconcileZoneAccessories({ controller: syntheticController, presentRelayIds: present, zones: [ zoneRequest(failing), zoneRequest(healthy) ] });

    assert.equal(registered().length, 2, "the faulted zone leaves no residue behind, so the next reconcile retries its registration");
  });

  test("undoes a promotion whose seed flush fails and retries the zone once the flush recovers", () => {

    const failing = zoneFixture();
    const healthy = zoneFixture({ name: "Side Yard", relay: 2, relay_id: SECOND_RELAY_ID });
    const { entries, failUpdateUuids, platform, registered, unregistered, updated } = buildPlatform();
    const present = new Set([ ZONE_RELAY_ID, SECOND_RELAY_ID ]);
    const failingUuid = zoneUuid(platform, syntheticController.controller_id, ZONE_RELAY_ID);

    /* Failing the CACHE FLUSH rather than the registration is what reaches the undo arm: the registration succeeds, so this pass has an accessory of its own to
     * take back. The knob cannot deadlock that undo either - removeAccessory splices the accessory out of the tracked array before its own tail flush, so the
     * accessory the knob names is already gone from the array that flush carries, and the scenario terminates.
     */
    failUpdateUuids.add(failingUuid);

    const hosts = platform.reconcileZoneAccessories({ controller: syntheticController, presentRelayIds: present,
      zones: [ zoneRequest(failing), zoneRequest(healthy) ] });

    assert.equal(registered().length, 2, "both zones register - it is the flush that fails here, not the registration");
    assert.equal(unregistered().length, 1, "the failed pass takes back exactly the accessory it created");
    assert.equal(unregistered()[0]?.UUID, failingUuid, "the undo unregisters the zone whose flush threw");
    assert.equal(hosts.has(ZONE_RELAY_ID), false, "the faulted zone is omitted from the hosting map, so the controller keeps hosting its valve");
    assert.equal(hosts.get(SECOND_RELAY_ID)?.UUID, zoneUuid(platform, 500001, 700002), "the other zone's accessory still lands");
    assert.ok(loggedAt(entries, "error", "Unable to establish a standalone accessory"), "the fault is reported against the zone it belongs to");

    const updatesAfterFailure = updated().length;

    failUpdateUuids.clear();

    const retried = platform.reconcileZoneAccessories({ controller: syntheticController, presentRelayIds: present,
      zones: [ zoneRequest(failing), zoneRequest(healthy) ] });

    /* The signals below are what tell a cleared knob from one still stuck open. A knob still throwing would omit the zone from the hosting map again, log
     * again, and grow the unregistered buffer again; registration-buffer growth on its own could not tell the two apart, because addAccessory registers before
     * the gated flush ever runs. That fresh registration is the residue proof: a ghost left in the tracked array would satisfy the find-by-UUID lookup and
     * short-circuit it, the same idiom the containment assertion above rests on.
     */
    assert.equal(retried.get(ZONE_RELAY_ID)?.UUID, failingUuid, "a recovered flush lets the zone take an accessory of its own");
    assert.equal(unregistered().length, 1, "the retry undoes nothing, so the unregistered buffer stands where the failed pass left it");
    assert.equal(updated().length, updatesAfterFailure + 1, "the retry records the seed flush the failed pass never completed");
    assert.equal(registered().length, 3, "the faulted zone leaves no residue behind, so the retry registers it afresh");
  });
});

describe("HydrawisePlatform zone accessories (orphan sweep)", () => {

  test("keeps a zone accessory whose owning controller is live and enabled", async (t) => {

    const { emit, entries, platform, unregistered, updated } = buildPlatform();

    t.after(() => emit(SHUTDOWN));
    await using dispatcher = installMockDispatcher();
    const cached = seedAccessory(platform, sanitizeName(RAW_ZONE_NAME), zoneUuid(platform, syntheticController.controller_id, OFF_WIRE_RELAY_ID));

    cached.context = { ownerController: controllerIdentity(syntheticController), zone: zoneIdentity(zoneFixture({ relay_id: OFF_WIRE_RELAY_ID })) };

    programJsonReply(dispatcher.agent, "customerdetails.php", makeCustomerDetails());
    programJsonReply(dispatcher.agent, "statusschedule.php", normalSchedule());

    emit(DID_FINISH_LAUNCHING);

    // The controller accessory's own flush lands inside configureController, which the sweep follows in the same synchronous frame.
    await waitUntil(() => updated().length >= 1, { description: "the first accessory cache update" });

    assert.equal(unregistered().length, 0, "the sweep leaves a zone accessory whose owner is present and enabled in place");
    assert.ok(!loggedAt(entries, "error", "stopped unexpectedly"), "and discovery ran through the sweep without a fault, so the kept accessory is the sweep's verdict");
  });

  test("removes a zone accessory whose owning controller is gone from the account", async (t) => {

    const { emit, entries, platform, unregistered } = buildPlatform();

    t.after(() => emit(SHUTDOWN));
    await using dispatcher = installMockDispatcher();
    const cached = seedAccessory(platform, sanitizeName(RAW_ZONE_NAME), zoneUuid(platform, 500999, OFF_WIRE_RELAY_ID));

    cached.context = { ownerController: { controllerId: 500999, name: "Retired Controller", serialNumber: "SN0RETIRED" },
      zone: zoneIdentity(zoneFixture({ relay_id: OFF_WIRE_RELAY_ID })) };

    programJsonReply(dispatcher.agent, "customerdetails.php", makeCustomerDetails());
    programJsonReply(dispatcher.agent, "statusschedule.php", normalSchedule());

    emit(DID_FINISH_LAUNCHING);
    await waitUntil(() => unregistered().length >= 1, { description: "the first accessory unregistration" });

    assert.equal(unregistered()[0]?.UUID, zoneUuid(platform, 500999, 700099), "a zone accessory whose owner the account does not list is swept away");
    assert.ok(!loggedAt(entries, "error", "stopped unexpectedly"), "and the bridge accepted the unregistration, so discovery ran on past the sweep");
  });

  test("removes a zone accessory whose owning controller the device gate turns off", async (t) => {

    const { emit, entries, platform, unregistered } = buildPlatform({ options: ["Disable.Device.SN0A1B2C3D4"] });

    t.after(() => emit(SHUTDOWN));
    await using dispatcher = installMockDispatcher();
    const cached = seedAccessory(platform, sanitizeName(RAW_ZONE_NAME), zoneUuid(platform, syntheticController.controller_id, ZONE_RELAY_ID));

    cached.context = { ownerController: controllerIdentity(syntheticController), zone: zoneIdentity(zoneFixture()) };

    programJsonReply(dispatcher.agent, "customerdetails.php", makeCustomerDetails());

    emit(DID_FINISH_LAUNCHING);
    await waitUntil(() => unregistered().length >= 1, { description: "the first accessory unregistration" });

    assert.equal(unregistered()[0]?.UUID, zoneUuid(platform, 500001, 700001), "a zone accessory whose owner is disabled is swept away with it");
    assert.ok(!loggedAt(entries, "error", "stopped unexpectedly"), "and the bridge accepted the unregistration, so discovery ran on past the sweep");
  });

  test("removes an accessory whose zone context is malformed even though its owner is live", async (t) => {

    const { emit, entries, platform, unregistered } = buildPlatform();

    t.after(() => emit(SHUTDOWN));
    await using dispatcher = installMockDispatcher();
    const cached = seedAccessory(platform, sanitizeName(RAW_ZONE_NAME), zoneUuid(platform, syntheticController.controller_id, ZONE_RELAY_ID));

    /* The owner fragment references the LIVE, ENABLED controller while the zone half is malformed. That is the distinguishing fixture: a classifier that routed
     * this down the zone arm would KEEP the accessory, because the owner rule it would then apply is satisfied.
     */
    cached.context = { ownerController: controllerIdentity(syntheticController), zone: { name: "Half A Zone" } };

    programJsonReply(dispatcher.agent, "customerdetails.php", makeCustomerDetails());
    programJsonReply(dispatcher.agent, "statusschedule.php", normalSchedule());

    emit(DID_FINISH_LAUNCHING);
    await waitUntil(() => unregistered().length >= 1, { description: "the first accessory unregistration" });

    assert.equal(unregistered()[0]?.UUID, zoneUuid(platform, 500001, 700001),
      "an unreadable context takes the controller arm and is swept, so the next poll can rebuild it");
    assert.ok(!loggedAt(entries, "error", "stopped unexpectedly"), "and the bridge accepted the unregistration, so discovery ran on past the sweep");
  });
});
