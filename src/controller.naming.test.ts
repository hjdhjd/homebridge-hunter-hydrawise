/* Copyright(C) 2017-2026, HJD (https://github.com/hjdhjd). All rights reserved.
 *
 * controller.naming.test.ts: Zone and controller naming, and the synchronization behind both. Asserts the effective name a valve is created with (the user's Name
 * option when set, otherwise the name Hydrawise reports), the synchronization that keeps it current while SyncName holds, the exact-compare that keeps a matching
 * name from being rewritten on every poll, the creation-only behavior a SyncName opt-out restores, the same contract applied to the controller's own surfaces -
 * its irrigation system service, its accessory, and its suspend-all switch - and the scopes the framework enforces for the Name option at either grain.
 */

// The Hydrawise API wire shapes use snake_case keys such as relay_id, so camelcase is disabled here to let the zone fixtures mirror the wire verbatim.
/* eslint-disable camelcase */
import { Characteristic, Service } from "./testing/hap.helpers.ts";
import { FeatureOptions, getServiceName } from "homebridge-plugin-utils";
import { HYDRAWISE_ACTIVE_ZONE_INDICATOR, HYDRAWISE_V2_FACTS_TTL } from "./settings.ts";
import type { HydrawiseAccessoryContext, HydrawiseControllerIdentity, HydrawiseControllerV2Facts, HydrawiseZoneConfig, HydrawiseZoneIdentity,
  StatusScheduleResponse } from "./types.ts";
import type { HydrawiseControllerOption, HydrawiseControllerValueOption, HydrawiseZoneOption, HydrawiseZoneValueOption } from "./options.ts";
import { HydrawiseReservedNames, scheduleStatus } from "./types.ts";
import type { TestAccessory, TestService } from "./testing/hap.helpers.ts";
import { buildController, makeV2Facts, makeZoneV2Facts, waitFor } from "./testing/platform.helpers.ts";
import { describe, test } from "node:test";
import { fastPolling, makeStatusSchedule, makeZone } from "./api.helpers.ts";
import { featureOptionCategories, featureOptions } from "./options.ts";
import type { BuildControllerResult } from "./testing/platform.helpers.ts";
import type { Service as HapService } from "homebridge";
import assert from "node:assert/strict";
import { bareSensors } from "./api.fixtures.ts";
import { waitUntil } from "homebridge-plugin-utils/testing";

// The single zone every scenario here works against, and the names standing in for each source a valve's name can come from: what the wire reports, what a user
// renamed it to in the Home app, and what the Name option configures.
const ZONE_RELAY_ID = 700001;
const ZONE_SUBTYPE = "700001";
const CONTROLLER_SERIAL = "SN0A1B2C3D4";
const WIRE_NAME = "Front Lawn";
const WIRE_RENAMED = "Front Lawn North";
const HOME_APP_NAME = "Sprinklers Out Front";
const OVERRIDE_NAME = "Front Lawn Drip Line";

// A free-form override exercising the value grammar's full latitude: interior periods and an "=" past the payload delimiter both pass through to the runtime
// verbatim, and HomeKit's own naming rules then decide what the valve can actually be called.
const FREE_FORM_OVERRIDE = "Front Lawn 2.0 = North Bed";
const FREE_FORM_SANITIZED = "Front Lawn 2.0 North Bed";

// The name the account API reports for the same zone, longer than the key-based API can express. That length difference is the whole feature, so every name here
// differs from every other and no assertion can pass by coincidence. It deliberately EXTENDS the wire name, which is the only relationship the name-carry
// feature responds to: a truncated name and its untruncated form.
const ACCOUNT_NAME = "Front Lawn North Border Drip";

// A wire-side rename that lands OUTSIDE the truncation relationship: the held account name is not an extension of it, so it is what a genuine rename looks like
// rather than a cut form of a name already in hand.
const WIRE_UNRELATED = "Side Yard Beds";

// A second account name for the same zone, so a scenario can show a real facts answer REPLACING a carried one rather than merely coinciding with it.
const ACCOUNT_RENAMED = "Front Lawn South Border Drip";

/* The controller's own names, one per source and each on different terms: what the key-based wire reports (the synthetic controller's own), what the account
 * API calls it, and what a user configures. The suffix the suspend-all switch composes is stated once here rather than at each assertion.
 */
const CONTROLLER_WIRE_NAME = "Test Controller";

const CONTROLLER_ACCOUNT_NAME = "Backyard Irrigation System";

// The account's name for a controller whose wire name is the CUT form of it, which is the only shape the name carry offers anything under. The controller-grain
// outage assertion needs it, because a pair of unrelated names would leave that assertion proving nothing at all.
const CONTROLLER_ACCOUNT_EXTENDED = CONTROLLER_WIRE_NAME + " North Wing";

const CONTROLLER_OVERRIDE_NAME = "Garden Controller";

// A controller override carrying characters HomeKit's rules rewrite, so the name on the service can never equal the configured value and only a comparison that
// sanitizes both sides settles.
const CONTROLLER_FREE_FORM_OVERRIDE = "Garden 2.0 = North Wing";

const CONTROLLER_FREE_FORM_SANITIZED = "Garden 2.0 North Wing";

// A name with nothing HomeKit's rules will keep: every character is disallowed, so it sanitizes to the empty string.
const UNUSABLE_NAME = "***";

const SUSPEND_ALL_SUFFIX = " Suspend All Zones";

// The per-zone suspension switch's own suffix and the subtype it is published under, so the zone-grain naming assertions can read the companion the walk composes.
const ZONE_SUSPEND_SUFFIX = " Suspend";

const ZONE_SUSPEND_SUBTYPE = "Suspend." + ZONE_SUBTYPE;

// The persisted zone roster, read through the same confined cast the roster suite reads it through.
function rosterOf(h: BuildControllerResult): HydrawiseZoneIdentity[] {

  return (h.accessory.context as HydrawiseAccessoryContext).zones ?? [];
}

// The current whole second, the unit a facts snapshot's own stamp speaks.
function nowSeconds(): number {

  return Math.floor(Date.now() / 1000);
}

// One refresh tick's facts for the zone under test, carrying the account's name and nothing else to say.
function v2Facts(name: string): HydrawiseControllerV2Facts {

  return makeV2Facts({ zones: [[ ZONE_RELAY_ID, makeZoneV2Facts({ name }) ]] });
}

// A one-zone, fast-cadence schedule with a bare sensor block, so a live-loop test cycles in roughly 250ms.
function schedule(name: string): StatusScheduleResponse {

  return fastPolling(makeStatusSchedule({ relays: [zone(name)], sensors: bareSensors }));
}

// The zone under test, named as the wire reports it. It is scheduled well beyond the active-zone window, so a poll settles its valve without also driving a start
// or stop transition.
function zone(name: string): HydrawiseZoneConfig {

  return makeZone({ name, relay: 1, relay_id: ZONE_RELAY_ID, run: 480, time: 68000, timestr: "16:00" });
}

// Seed a cached valve already bearing a name, the shape Homebridge restores when an accessory returns from its cache carrying a rename the user made in the Home
// app. The name lands on ConfiguredName, which is the characteristic a Home-app rename writes and the one the name helpers read first.
function seedNamedValve(name: string): (accessory: TestAccessory) => void {

  return (accessory: TestAccessory): void => {

    accessory.addService(new Service.Valve(name, ZONE_SUBTYPE)).updateCharacteristic(Characteristic.ConfiguredName, name);
  };
}

// The double-to-HAP cast the real name helper requires, confined here so the test bodies stay cast-free.
function asHapService(service: object): HapService {

  return service as unknown as HapService;
}

// Wait for the zone's valve to exist, then hand it back.
async function valveOf(h: BuildControllerResult): Promise<TestService> {

  return waitFor(() => h.accessory.getServiceById(Service.Valve, ZONE_SUBTYPE), { description: "the zone valve to appear" });
}

// The name the valve presents to HomeKit, read through the same helper production reads it through.
function nameOf(valve: TestService): string | undefined {

  return getServiceName(asHapService(valve));
}

// The values written to either name characteristic. A valve takes routine writes on every poll - Active and its neighbors - so a claim about naming filters those
// out rather than reading the whole write log.
function nameWrites(valve: TestService): unknown[] {

  return valve.writesFor(Characteristic.ConfiguredName, Characteristic.Name).map(write => write.value);
}

// One refresh tick's facts for the CONTROLLER itself, carrying its account name and nothing else to say.
function controllerV2Facts(name: string): HydrawiseControllerV2Facts {

  return makeV2Facts({ name });
}

// The irrigation system service: this controller's primary HomeKit label, and the service every other controller rename is gated on.
function irrigationOf(h: BuildControllerResult): TestService {

  const service = h.accessory.getService(Service.IrrigationSystem);

  assert.ok(service, "the controller accessory carries an irrigation system service");

  return service;
}

// The accessory information service, whose name is the half of the accessory's display pair that lives on a service.
function informationOf(h: BuildControllerResult): TestService {

  const service = h.accessory.getService(Service.AccessoryInformation);

  assert.ok(service, "the controller accessory carries an information service");

  return service;
}

// The service label service, acquired beside the irrigation system and carrying the same name, which is what the rename step brings along with it.
function labelOf(h: BuildControllerResult): TestService {

  const service = h.accessory.getService(Service.ServiceLabel);

  assert.ok(service, "the controller accessory carries a service label service");

  return service;
}

// The suspend-all switch, whose name is composed from the controller's own and therefore tracks it.
function suspendSwitchOf(h: BuildControllerResult): TestService {

  const service = h.accessory.getServiceById(Service.Switch, HydrawiseReservedNames.SWITCH_SUSPEND_ALL);

  assert.ok(service, "the suspend-all switch exists once the option is enabled");

  return service;
}

// The persisted self-identity, read through the same confined cast the roster reads through.
function identityOf(h: BuildControllerResult): HydrawiseControllerIdentity | undefined {

  return (h.accessory.context as HydrawiseAccessoryContext).controller;
}

// Let at least one complete polling pass run past the current one, so an assertion about what a later poll did or did not do has a poll to describe. Bounding on
// the second call ahead guarantees the intervening pass ran its zone loop to completion before we read.
async function pollPast(h: BuildControllerResult): Promise<void> {

  const seen = h.retrieve.callsTo("statusschedule.php").length;

  await waitUntil(() => h.retrieve.callsTo("statusschedule.php").length >= (seen + 2), { description: "the second status poll past the one in flight" });
}

describe("zone naming at creation", () => {

  test("creates a zone's valve with the name Hydrawise reports when no override is configured", async (t) => {

    const h = buildController({ program: (recorder) => recorder.programDefault("statusschedule.php", { body: schedule(WIRE_NAME), kind: "response" }),
      signalAborted: false });

    t.after(() => h.abort());

    assert.equal(nameOf(await valveOf(h)), WIRE_NAME, "an unconfigured zone's valve carries the name the wire reports");
  });

  test("creates a zone's valve bearing a free-form name override", async (t) => {

    const h = buildController({ program: (recorder) => recorder.programDefault("statusschedule.php", { body: schedule(WIRE_NAME), kind: "response" }),
      signalAborted: false, userOptions: ["Enable.Device.Name." + ZONE_SUBTYPE + "=" + FREE_FORM_OVERRIDE] });

    t.after(() => h.abort());

    // The configured value reaches the runtime verbatim - periods and the "=" past the payload delimiter and all - and HomeKit's naming rules then sanitize what
    // the valve is actually called, which is where the "=" becomes a space.
    const engine = new FeatureOptions(featureOptionCategories, featureOptions, ["Enable.Device.Name." + ZONE_SUBTYPE + "=" + FREE_FORM_OVERRIDE]);

    assert.equal(engine.value("Device.Name", ZONE_SUBTYPE, CONTROLLER_SERIAL), FREE_FORM_OVERRIDE, "the free-form value survives the grammar verbatim");
    assert.equal(nameOf(await valveOf(h)), FREE_FORM_SANITIZED, "the valve carries the override, sanitized to HomeKit's naming rules");
  });

  test("performs no further name write after the pass that created the valve", async (t) => {

    const h = buildController({ program: (recorder) => recorder.programDefault("statusschedule.php", { body: schedule(WIRE_NAME), kind: "response" }),
      signalAborted: false, userOptions: ["Enable.Device.Name." + ZONE_SUBTYPE + "=" + OVERRIDE_NAME] });

    t.after(() => h.abort());

    const valve = await valveOf(h);

    await pollPast(h);
    h.abort();

    // Creation applies the effective name once, through each name characteristic the kind supports. Nothing in the pass that created the valve, and nothing in the
    // passes after it, applies it again.
    assert.deepEqual(nameWrites(valve), [ OVERRIDE_NAME, OVERRIDE_NAME ], "the creating pass writes the name once per name characteristic and never again");
    assert.equal(nameOf(valve), OVERRIDE_NAME, "the valve carries the override");
  });
});

describe("zone name synchronization at its default", () => {

  test("re-asserts the effective name over a rename made in the Home app", async (t) => {

    const h = buildController({ program: (recorder) => recorder.programDefault("statusschedule.php", { body: schedule(WIRE_NAME), kind: "response" }),
      seedContext: seedNamedValve(HOME_APP_NAME), signalAborted: false });

    t.after(() => h.abort());

    const valve = await valveOf(h);

    await waitUntil(() => nameOf(valve) === WIRE_NAME, { description: "the valve to take the wire name" });

    assert.equal(nameOf(valve), WIRE_NAME, "a Home-app rename yields to the name Hydrawise reports");
  });

  test("re-asserts a configured override over a rename made in the Home app", async (t) => {

    const h = buildController({ program: (recorder) => recorder.programDefault("statusschedule.php", { body: schedule(WIRE_NAME), kind: "response" }),
      seedContext: seedNamedValve(HOME_APP_NAME), signalAborted: false, userOptions: ["Enable.Device.Name." + ZONE_SUBTYPE + "=" + OVERRIDE_NAME] });

    t.after(() => h.abort());

    const valve = await valveOf(h);

    await waitUntil(() => nameOf(valve) === OVERRIDE_NAME, { description: "the valve to take the override name" });

    assert.equal(nameOf(valve), OVERRIDE_NAME, "a Home-app rename yields to the configured override");
  });

  test("propagates a rename made on the Hydrawise side to the existing valve", async (t) => {

    // The seeded valve already matches the first poll's wire name, so the first pass writes nothing; the rename the second poll reports is then the sole cause of
    // any name write.
    const h = buildController({ program: (recorder) => {

      recorder.program("statusschedule.php", { body: schedule(WIRE_NAME), kind: "response" });
      recorder.programDefault("statusschedule.php", { body: schedule(WIRE_RENAMED), kind: "response" });
    }, seedContext: seedNamedValve(WIRE_NAME), signalAborted: false });

    t.after(() => h.abort());

    const valve = await valveOf(h);

    await waitUntil(() => nameOf(valve) === WIRE_RENAMED, { description: "the valve to take the renamed wire name" });

    assert.equal(nameOf(valve), WIRE_RENAMED, "a Hydrawise-side rename lands on the next poll");
  });

  test("does not rewrite a name that already matches", async (t) => {

    const h = buildController({ program: (recorder) => recorder.programDefault("statusschedule.php", { body: schedule(WIRE_NAME), kind: "response" }),
      seedContext: seedNamedValve(WIRE_NAME), signalAborted: false });

    t.after(() => h.abort());

    const valve = await valveOf(h);

    valve.clearWrites();

    await pollPast(h);
    h.abort();

    assert.deepEqual(nameWrites(valve), [], "a poll finding the name already correct performs no name write");
    assert.ok(valve.writes.length > 0, "the same poll still performs its routine writes, so the empty name-filtered view is a real skip");
  });

  test("does not rewrite an override whose HomeKit name differs from the configured value", async (t) => {

    // The override carries characters HomeKit's naming rules replace, so the name on the service can never equal the configured value. The comparison sanitizes
    // before comparing, which is what keeps this from rewriting the same name on every single poll.
    const h = buildController({ program: (recorder) => recorder.programDefault("statusschedule.php", { body: schedule(WIRE_NAME), kind: "response" }),
      signalAborted: false, userOptions: ["Enable.Device.Name." + ZONE_SUBTYPE + "=" + FREE_FORM_OVERRIDE] });

    t.after(() => h.abort());

    const valve = await valveOf(h);

    valve.clearWrites();

    await pollPast(h);
    h.abort();

    assert.deepEqual(nameWrites(valve), [], "a sanitized name that already matches is not rewritten on every poll");
    assert.equal(nameOf(valve), FREE_FORM_SANITIZED, "the valve still carries the sanitized override");
  });
});

describe("zone name synchronization opted out", () => {

  // The opt-out is honored wherever it is written: a single zone, or the controller the zone lives under.
  for(const { label, option } of [ { label: "the zone", option: "Disable.Device.SyncName." + ZONE_SUBTYPE },
    { label: "the controller", option: "Disable.Device.SyncName." + CONTROLLER_SERIAL } ]) {

    test("leaves a Home-app rename standing when synchronization is disabled at " + label, async (t) => {

      const h = buildController({ program: (recorder) => recorder.programDefault("statusschedule.php", { body: schedule(WIRE_NAME), kind: "response" }),
        seedContext: seedNamedValve(HOME_APP_NAME), signalAborted: false, userOptions: [option] });

      t.after(() => h.abort());

      const valve = await valveOf(h);

      valve.clearWrites();

      await pollPast(h);
      h.abort();

      assert.deepEqual(nameWrites(valve), [], "no poll re-asserts a name while synchronization is disabled");
      assert.equal(nameOf(valve), HOME_APP_NAME, "the rename made in the Home app stands");
    });
  }

  test("still creates a new valve with the effective name, and never re-asserts it afterwards", async (t) => {

    const h = buildController({ program: (recorder) => recorder.programDefault("statusschedule.php", { body: schedule(WIRE_NAME), kind: "response" }),
      signalAborted: false, userOptions: [ "Disable.Device.SyncName." + ZONE_SUBTYPE, "Enable.Device.Name." + ZONE_SUBTYPE + "=" + OVERRIDE_NAME ] });

    t.after(() => h.abort());

    const valve = await valveOf(h);

    assert.equal(nameOf(valve), OVERRIDE_NAME, "creation carries the override even with synchronization disabled");

    valve.clearWrites();

    await pollPast(h);
    h.abort();

    assert.deepEqual(nameWrites(valve), [], "nothing re-asserts the name after creation");
  });
});

describe("the zone name override's value semantics", () => {

  test("treats an empty configured value as no override", async (t) => {

    const h = buildController({ program: (recorder) => recorder.programDefault("statusschedule.php", { body: schedule(WIRE_NAME), kind: "response" }),
      signalAborted: false, userOptions: ["Enable.Device.Name." + ZONE_SUBTYPE + "="] });

    t.after(() => h.abort());

    assert.equal(nameOf(await valveOf(h)), WIRE_NAME, "an empty override leaves the wire name in place");
  });

  test("treats a value that is only whitespace as no override", async (t) => {

    const h = buildController({ program: (recorder) => recorder.programDefault("statusschedule.php", { body: schedule(WIRE_NAME), kind: "response" }),
      signalAborted: false, userOptions: ["Enable.Device.Name." + ZONE_SUBTYPE + "=    "] });

    t.after(() => h.abort());

    assert.equal(nameOf(await valveOf(h)), WIRE_NAME, "a whitespace-only override leaves the wire name in place");
  });

  test("applies a configured value with surrounding whitespace as its trimmed form", async (t) => {

    const h = buildController({ program: (recorder) => recorder.programDefault("statusschedule.php", { body: schedule(WIRE_NAME), kind: "response" }),
      signalAborted: false, userOptions: ["Enable.Device.Name." + ZONE_SUBTYPE + "=   " + OVERRIDE_NAME + "   "] });

    t.after(() => h.abort());

    assert.equal(nameOf(await valveOf(h)), OVERRIDE_NAME, "the override applies without its surrounding whitespace");
  });

  test("treats a disabled override as no override", async (t) => {

    const h = buildController({ program: (recorder) => recorder.programDefault("statusschedule.php", { body: schedule(WIRE_NAME), kind: "response" }),
      signalAborted: false, userOptions: ["Disable.Device.Name." + ZONE_SUBTYPE] });

    t.after(() => h.abort());

    assert.equal(nameOf(await valveOf(h)), WIRE_NAME, "a disabled name option resolves to no value at all, so the wire name stands");
  });
});

describe("the zone name option's declared scope", () => {

  test("does not resolve a name written at the global scope", () => {

    const engine = new FeatureOptions(featureOptionCategories, featureOptions, ["Enable.Device.Name=Every Zone"]);

    assert.notEqual(engine.value("Device.Name", ZONE_SUBTYPE, CONTROLLER_SERIAL), "Every Zone", "a global entry does not reach a zone");
    assert.equal(engine.value("Device.Name", ZONE_SUBTYPE, CONTROLLER_SERIAL), null, "the zone resolves no value at all, since the option defaults to disabled");
  });

  test("does not resolve a controller's own name for a zone that has none of its own", () => {

    const engine = new FeatureOptions(featureOptionCategories, featureOptions, ["Enable.Device.Name." + CONTROLLER_SERIAL + "=Every Zone"]);

    /* The contract the runtime's zone reader actually rests on. The Name option resolves at the controller as well as the zone, so an engine ASKED with the serial
     * beside the zone id answers the controller's entry - which is why the zone reader presents the relay id alone. This asserts the call the runtime makes, and a
     * reader that reintroduced the serial argument would resolve "Every Zone" here and rename every unnamed zone on the controller.
     */
    assert.equal(engine.value("Device.Name", ZONE_SUBTYPE), null, "a zone read presenting its own id alone never reaches the controller's entry");
    assert.equal(engine.value("Device.Name", CONTROLLER_SERIAL), "Every Zone", "while the controller's own read, presenting the serial, resolves it");
  });

  test("leaves a valve at its wire name when a name is written outside the zone scope", async (t) => {

    const h = buildController({ program: (recorder) => recorder.programDefault("statusschedule.php", { body: schedule(WIRE_NAME), kind: "response" }),
      signalAborted: false, userOptions: ["Enable.Device.Name=Every Zone"] });

    t.after(() => h.abort());

    assert.equal(nameOf(await valveOf(h)), WIRE_NAME, "the runtime never sees a name the option's declared scope does not admit");
  });

  test("prefers the user's override, then the account's name, then the wire's", async (t) => {

    /* The precedence trio, driven through ONE fixture carrying all three answers at once: the override configured, the account reporting the full name, and the
     * wire reporting its truncated form. Only a fixture where all three differ can show which rung actually won.
     */
    const h = buildController({ hasV2Client: true,
      program: (recorder) => recorder.programDefault("statusschedule.php", { body: schedule(WIRE_NAME), kind: "response" }), signalAborted: false,
      userOptions: ["Enable.Device.Name." + ZONE_SUBTYPE + "=" + OVERRIDE_NAME] });

    t.after(() => h.abort());

    const valve = await valveOf(h);

    h.controller.applyFacts({ facts: v2Facts(ACCOUNT_NAME), fetchedAt: nowSeconds() });

    assert.equal(nameOf(valve), OVERRIDE_NAME, "the user's own name outranks everything, account name included");

    // Drop the override and let a poll re-resolve. The account's name is what remains, and it beats the truncated form the wire is still reporting.
    h.platform.featureOptions.configuredOptions = [];

    await waitUntil(() => nameOf(valve) === ACCOUNT_NAME, { description: "the valve to take the account name" });

    assert.equal(nameOf(valve), ACCOUNT_NAME, "with no override, the account's full name beats the wire's truncated one");
  });

  test("the account's name HOLDS through a refresh outage rather than flapping back to the truncated form", async (t) => {

    /* The mid-session outage, at the zone grain. Facts land once and the full name is adopted; then the refresh stalls and the snapshot ages past its lifetime.
     * The name has to hold at the account's own, because falling back would rewrite every label to the wire's cut form and heal it again a refresh later - the
     * flap this carry exists to end.
     *
     * The fixture must be TRUNCATION-SHAPED for this assertion to mean anything: the carry fires only where the account name extends the wire's, so an unrelated pair
     * of names would sail through asserting nothing. The guard below states that relationship rather than trusting the constants to keep it.
     */
    assert.ok(ACCOUNT_NAME.startsWith(WIRE_NAME), "the account's name must extend the wire's for the carry to be under test at all");
    assert.notEqual(ACCOUNT_NAME, WIRE_NAME, "and the two must differ, or holding one would be indistinguishable from falling back to the other");

    const h = buildController({ hasV2Client: true,
      program: (recorder) => recorder.programDefault("statusschedule.php", { body: schedule(WIRE_NAME), kind: "response" }), signalAborted: false });

    t.after(() => h.abort());

    const valve = await valveOf(h);

    h.controller.applyFacts({ facts: v2Facts(ACCOUNT_NAME), fetchedAt: nowSeconds() });

    await waitUntil(() => nameOf(valve) === ACCOUNT_NAME, { description: "the valve to take the account name" });

    h.controller.applyFacts({ facts: v2Facts(ACCOUNT_NAME), fetchedAt: nowSeconds() - (HYDRAWISE_V2_FACTS_TTL + 1) });

    await pollPast(h);
    h.abort();

    assert.equal(nameOf(valve), ACCOUNT_NAME, "an aged-out snapshot leaves the last account name standing on the valve");
    assert.equal(rosterOf(h)[0]?.name, ACCOUNT_NAME, "and the persisted roster holds it too, which is the store the carry reads back from");
  });

  test("a rename on the wire breaks the carry and shows through immediately", async (t) => {

    /* The other side of the carry's gate, and the case that keeps it honest. A genuine Hydrawise-side rename is not a truncation of the name already held, so
     * the prefix relationship breaks and the new name must reach the valve at once rather than being held behind a stale one. Without the gate the first name
     * this install ever composed would freeze every label for the life of the process.
     */
    assert.ok(!ACCOUNT_NAME.startsWith(WIRE_UNRELATED), "the held name must NOT extend the renamed wire name, or the carry would legitimately hold it");

    const h = buildController({ hasV2Client: true, program: (recorder) => {

      recorder.program("statusschedule.php", { body: schedule(WIRE_NAME), kind: "response" });
      recorder.programDefault("statusschedule.php", { body: schedule(WIRE_UNRELATED), kind: "response" });
    }, signalAborted: false });

    t.after(() => h.abort());

    const valve = await valveOf(h);

    h.controller.applyFacts({ facts: v2Facts(ACCOUNT_NAME), fetchedAt: nowSeconds() });

    await waitUntil(() => nameOf(valve) === ACCOUNT_NAME, { description: "the valve to take the account name" });

    // The facts age out and the wire reports a different name, so nothing is left that the held name can be the untruncated form OF.
    h.controller.applyFacts({ facts: v2Facts(ACCOUNT_NAME), fetchedAt: nowSeconds() - (HYDRAWISE_V2_FACTS_TTL + 1) });

    await waitUntil(() => nameOf(valve) === WIRE_UNRELATED, { description: "the valve to take the unrelated wire name" });

    assert.equal(nameOf(valve), WIRE_UNRELATED, "a wire rename outside the truncation relationship reaches the valve rather than being held");
  });

  test("the persisted roster and the MQTT payload carry the account's name, and the user's override never reaches them", async (t) => {

    /* Identity and display are different jobs, which this codebase already separates: what a zone IS goes to the roster and out over MQTT, while what HomeKit
     * SHOWS carries the user's private override on top. The account's name is the zone's own, so it belongs on both sides of that line; the override belongs only
     * on the display side, which is also why an install with no credentials publishes the same key-based shape regardless of the override.
     */
    const h = buildController({ hasV2Client: true, mqtt: true,
      program: (recorder) => recorder.programDefault("statusschedule.php", { body: schedule(WIRE_NAME), kind: "response" }), signalAborted: false,
      userOptions: ["Enable.Device.Name." + ZONE_SUBTYPE + "=" + OVERRIDE_NAME] });

    t.after(() => h.abort());

    const valve = await valveOf(h);

    h.controller.applyFacts({ facts: v2Facts(ACCOUNT_NAME), fetchedAt: nowSeconds() });

    // The roster rewrite goes through the same change-gated persistence any Hydrawise-side rename does, so it lands on the poll that first sees the new name.
    await waitUntil(() => rosterOf(h)[0]?.name === ACCOUNT_NAME, { description: "the persisted roster to carry the account name" });

    assert.equal(rosterOf(h)[0]?.name, ACCOUNT_NAME, "the roster persists the account's name");
    assert.equal(nameOf(valve), OVERRIDE_NAME, "while the valve the user looks at still carries their own");

    const published = JSON.parse((await h.mqtt?.invokeGet("controller/get")) ?? "[]") as { name: string }[];

    assert.equal(published[0]?.name, ACCOUNT_NAME, "and the MQTT payload publishes the account's name rather than the user's private label");
  });

  test("declares the name option as value-centric and the synchronization option as a plain toggle", () => {

    const engine = new FeatureOptions(featureOptionCategories, featureOptions, []);

    assert.equal(engine.isValue("Device.Name"), true, "the name option carries a value");
    assert.equal(engine.isValue("Device.SyncName"), false, "the synchronization option is a plain toggle");
    assert.equal(engine.test("Device.SyncName", ZONE_SUBTYPE, CONTROLLER_SERIAL), true, "synchronization is on by default");
  });

  test("names every scoped option in the union the runtime narrows against", () => {

    // The compile-time half of the scope contract: these literals only typecheck against the unions that admit them, so an option that changes scope without its
    // union changing fails here at build time rather than at a call site.
    const controllerOptions: HydrawiseControllerOption[] = [ "Device", "Device.Suspend.All", "Device.SyncName", "Log.Zone" ];
    const zoneOptions: HydrawiseZoneOption[] = [ "Device", "Device.SyncName", "Log.Zone" ];
    const controllerValueOptions: HydrawiseControllerValueOption[] = ["Device.Name"];
    const zoneValueOptions: HydrawiseZoneValueOption[] = ["Device.Name"];

    assert.equal(controllerOptions.length, 4, "the controller union admits every controller-scoped option");
    assert.equal(zoneOptions.length, 3, "the zone union admits every zone-scoped toggle");
    assert.deepEqual(controllerValueOptions, ["Device.Name"], "the controller value union admits the name option");
    assert.deepEqual(zoneValueOptions, ["Device.Name"], "and so does its zone counterpart, one union per grain");
  });
});

describe("the name carry across a restart", () => {

  /* The window a restart opens: Homebridge restores the accessory, the first poll runs, and the account token grant has not completed yet, so the pass composes
   * with no facts at all. Everything here answers what the names do in that window, and the store they answer from is the persisted roster and self-identity the
   * previous session left behind - the carry keeps no state of its own.
   */
  test("a restored roster holds its full names through a facts-absent first poll, and writes nothing", async (t) => {

    /* A faithful warm restart: Homebridge hands back the accessory with the services and the persisted state the previous session flushed, all of them carrying
     * the account's full names. Seeding the schedule projection alongside them is what makes the cardinality claim below literal rather than a claim about the
     * schedule seed - a first poll that matched nothing would flush on the schedule's account whatever the names did.
     */
    const h = buildController({ hasV2Client: true,
      program: (recorder) => recorder.programDefault("statusschedule.php", { body: schedule(WIRE_NAME), kind: "response" }),
      seedContext: (seed) => {

        seed.context = { controller: { controllerId: 500001, name: CONTROLLER_ACCOUNT_EXTENDED, serialNumber: CONTROLLER_SERIAL },
          schedule: scheduleStatus(schedule(WIRE_NAME), HYDRAWISE_ACTIVE_ZONE_INDICATOR), zones: [{ name: ACCOUNT_NAME, relay: 1, relayId: ZONE_RELAY_ID }] };

        seed.addService(Service.IrrigationSystem, CONTROLLER_ACCOUNT_EXTENDED).updateCharacteristic(Characteristic.ConfiguredName, CONTROLLER_ACCOUNT_EXTENDED);
        seed.addService(Service.Valve, ACCOUNT_NAME, ZONE_SUBTYPE).updateCharacteristic(Characteristic.ConfiguredName, ACCOUNT_NAME);
      }, signalAborted: false });

    t.after(() => h.abort());

    const valve = await valveOf(h);

    valve.clearWrites();
    irrigationOf(h).clearWrites();

    await pollPast(h);
    h.abort();

    assert.equal(nameOf(valve), ACCOUNT_NAME, "the zone's valve keeps the name the previous session flushed, not the wire's cut form");
    assert.equal(nameOf(irrigationOf(h)), CONTROLLER_ACCOUNT_EXTENDED, "and the controller keeps its own");
    assert.equal(rosterOf(h)[0]?.name, ACCOUNT_NAME, "the roster still carries the full name rather than being rewritten to the wire's");

    /* The cardinality half, which is the half the user actually sees. Composing the same names the roster already holds means the first poll finds nothing
     * moved, so it renames nothing and writes nothing - where a fall-through would have paid one write to truncate every label and another to heal them.
     */
    assert.deepEqual(nameWrites(valve), [], "no rename touches the valve");
    assert.deepEqual(nameWrites(irrigationOf(h)), [], "nor the controller's own service");
    assert.equal(h.flushes.length, 0, "and the restart costs no cache write at all");
  });

  test("the controller's prior identity survives the context wipe and is what its carry reads", async (t) => {

    /* Construction wipes the accessory context and reseeds it, so the identity the previous session persisted has to be captured and restored across that wipe -
     * without it the carry would read the wire projection it was just handed and hold the very name it exists to replace.
     *
     * A malformed prior is the other half: it degrades to the wire projection, because there is nothing there to carry.
     */
    const h = buildController({ hasV2Client: true,
      program: (recorder) => recorder.programDefault("statusschedule.php", { body: schedule(WIRE_NAME), kind: "response" }),
      seedContext: (seed) => { seed.context = { controller: { controllerId: 500001, name: CONTROLLER_ACCOUNT_EXTENDED, serialNumber: CONTROLLER_SERIAL } }; },
      signalAborted: false });

    t.after(() => h.abort());

    assert.equal(identityOf(h)?.name, CONTROLLER_ACCOUNT_EXTENDED, "the restored identity is in place before the first poll runs");

    await waitUntil(() => nameOf(irrigationOf(h)) === CONTROLLER_ACCOUNT_EXTENDED, { description: "the irrigation system to take the extended account name" });

    const malformed = buildController({ hasV2Client: true,
      program: (recorder) => recorder.programDefault("statusschedule.php", { body: schedule(WIRE_NAME), kind: "response" }),
      seedContext: (seed) => { seed.context = { controller: { name: 42 } }; }, signalAborted: false });

    t.after(() => malformed.abort());

    assert.equal(identityOf(malformed)?.name, CONTROLLER_WIRE_NAME, "a malformed prior degrades to the wire's own projection rather than being trusted");
  });

  test("a facts entry with no usable name HOLDS the carry, while a real one replaces it", async (t) => {

    /* The null asymmetry, which differs from the suspension carry's on purpose. The projection normalizes an empty or whitespace-only account name to null, so a
     * null here means nothing usable arrived rather than the account denying a name - an absence, which holds. A real name is an answer, which replaces.
     */
    const h = buildController({ hasV2Client: true,
      program: (recorder) => recorder.programDefault("statusschedule.php", { body: schedule(WIRE_NAME), kind: "response" }),
      seedContext: (seed) => { seed.context = { zones: [{ name: ACCOUNT_NAME, relay: 1, relayId: ZONE_RELAY_ID }] }; }, signalAborted: false });

    t.after(() => h.abort());

    const valve = await valveOf(h);

    h.controller.applyFacts({ facts: makeV2Facts({ zones: [[ ZONE_RELAY_ID, makeZoneV2Facts({ name: null }) ]] }), fetchedAt: nowSeconds() });

    await pollPast(h);

    assert.equal(nameOf(valve), ACCOUNT_NAME, "a facts entry carrying no name leaves the carried name standing");

    h.controller.applyFacts({ facts: v2Facts(ACCOUNT_RENAMED), fetchedAt: nowSeconds() });

    await waitUntil(() => nameOf(valve) === ACCOUNT_RENAMED, { description: "the valve to take the renamed account name" });

    assert.equal(nameOf(valve), ACCOUNT_RENAMED, "and a facts entry that does carry one replaces it outright");
  });

  test("removing the credentials returns every name to the wire's, whatever the roster holds", async (t) => {

    /* The credential-off revert, unchanged by the carry: the rung is offered only where the credentials that produced those names are configured. Without them
     * nothing could ever refresh or correct a carried name, so holding one would strand it on display permanently.
     */
    const h = buildController({ program: (recorder) => recorder.programDefault("statusschedule.php", { body: schedule(WIRE_NAME), kind: "response" }),
      seedContext: (seed) => {

        seed.context = { controller: { controllerId: 500001, name: CONTROLLER_ACCOUNT_EXTENDED, serialNumber: CONTROLLER_SERIAL },
          zones: [{ name: ACCOUNT_NAME, relay: 1, relayId: ZONE_RELAY_ID }] };
      }, signalAborted: false });

    t.after(() => h.abort());

    const valve = await valveOf(h);

    await waitUntil(() => nameOf(irrigationOf(h)) === CONTROLLER_WIRE_NAME, { description: "the irrigation system to take the wire name" });
    await pollPast(h);
    h.abort();

    assert.equal(nameOf(valve), WIRE_NAME, "the zone reads the wire's name over a restored roster full of account names");
    assert.equal(nameOf(irrigationOf(h)), CONTROLLER_WIRE_NAME, "and so does the controller");
    assert.equal(rosterOf(h)[0]?.name, WIRE_NAME, "the roster is rewritten to what the wire reports, leaving nothing stranded");
  });

  test("a fresh install with nothing persisted composes the wire's names", async (t) => {

    // The floor the carry must not disturb: with no prior entry there is nothing to offer, so an enriched install that has not yet heard from the account reads
    // exactly as a key-only install does.
    const h = buildController({ hasV2Client: true,
      program: (recorder) => recorder.programDefault("statusschedule.php", { body: schedule(WIRE_NAME), kind: "response" }), signalAborted: false });

    t.after(() => h.abort());

    const valve = await valveOf(h);

    await pollPast(h);
    h.abort();

    assert.equal(nameOf(valve), WIRE_NAME, "the zone carries the name the wire reports");
    assert.equal(nameOf(irrigationOf(h)), CONTROLLER_WIRE_NAME, "and so does the controller");
  });
});

describe("controller naming", () => {

  test("adopts the account's full name across every surface the controller names", async (t) => {

    /* The whole rename, driven by one fact arriving. The account's name has to reach the service HomeKit shows, the accessory's own display pair, the information
     * service beneath it, and the companion switch that composes its name from the controller's - a rename that reached only some of them would leave the
     * controller answering to two names at once.
     */
    const h = buildController({ hasV2Client: true,
      program: (recorder) => recorder.programDefault("statusschedule.php", { body: schedule(WIRE_NAME), kind: "response" }), signalAborted: false,
      userOptions: ["Enable.Device.Suspend.All"] });

    t.after(() => h.abort());

    const irrigation = irrigationOf(h);

    assert.equal(nameOf(irrigation), CONTROLLER_WIRE_NAME, "the controller starts out carrying the name the key-based wire reports");

    h.controller.applyFacts({ facts: controllerV2Facts(CONTROLLER_ACCOUNT_NAME), fetchedAt: nowSeconds() });

    await waitUntil(() => nameOf(irrigation) === CONTROLLER_ACCOUNT_NAME, { description: "the irrigation system to take the account name" });

    assert.equal(nameOf(irrigation), CONTROLLER_ACCOUNT_NAME, "the irrigation system service adopts the account's name on the next poll");
    assert.equal(h.accessory.displayName, CONTROLLER_ACCOUNT_NAME, "the accessory's own display name follows it");
    assert.equal(nameOf(informationOf(h)), CONTROLLER_ACCOUNT_NAME, "as does the information service beneath it");
    assert.equal(nameOf(suspendSwitchOf(h)), CONTROLLER_ACCOUNT_NAME + SUSPEND_ALL_SUFFIX, "and the suspend-all switch recomposes its own name from it");
  });

  test("renames nothing when synchronization is disabled at the controller, and still records the account's name as its identity", async (t) => {

    const h = buildController({ hasV2Client: true,
      program: (recorder) => recorder.programDefault("statusschedule.php", { body: schedule(WIRE_NAME), kind: "response" }), signalAborted: false,
      userOptions: [ "Disable.Device.SyncName." + CONTROLLER_SERIAL, "Enable.Device.Suspend.All" ] });

    t.after(() => h.abort());

    const irrigation = irrigationOf(h);

    h.controller.applyFacts({ facts: controllerV2Facts(CONTROLLER_ACCOUNT_NAME), fetchedAt: nowSeconds() });

    // The identity is what tells the opt-out from a failure to learn the name at all: synchronization governs what HomeKit is SHOWN, never what the plugin knows.
    await waitUntil(() => identityOf(h)?.name === CONTROLLER_ACCOUNT_NAME, { description: "the persisted identity to carry the account name" });

    await pollPast(h);
    h.abort();

    assert.equal(nameOf(irrigation), CONTROLLER_WIRE_NAME, "no poll re-asserts a name while synchronization is disabled");
    assert.equal(h.accessory.displayName, CONTROLLER_WIRE_NAME, "the accessory keeps the name it had");
    assert.equal(nameOf(suspendSwitchOf(h)), CONTROLLER_WIRE_NAME + SUSPEND_ALL_SUFFIX, "and so does the switch composed from it");
    assert.equal(identityOf(h)?.name, CONTROLLER_ACCOUNT_NAME, "while the persisted identity still carries what the account calls this controller");
  });

  test("shows the user's own name while the identity keeps the account's", async (t) => {

    /* The display-versus-identity line, at the controller grain. Both answers exist at once here - the override configured and the account reporting something
     * else - so an implementation that let either one stand in for the other fails on one assertion or the other.
     */
    /* The accessory is seeded under the override, which is the shape the platform's own creation path produces: discovery consults the Name option and mints a
     * fresh accessory under it, so its display name and the service's are established together from one value. Seeding it under the wire name instead would
     * model a state production cannot reach for a fresh accessory and would put those stores out of step before the scenario began.
     */
    const h = buildController({ accessoryName: CONTROLLER_OVERRIDE_NAME, hasV2Client: true,
      program: (recorder) => recorder.programDefault("statusschedule.php", { body: schedule(WIRE_NAME), kind: "response" }), signalAborted: false,
      userOptions: ["Enable.Device.Name." + CONTROLLER_SERIAL + "=" + CONTROLLER_OVERRIDE_NAME] });

    t.after(() => h.abort());

    const irrigation = irrigationOf(h);

    await waitUntil(() => nameOf(irrigation) === CONTROLLER_OVERRIDE_NAME, { description: "the irrigation system to take the override name" });

    h.controller.applyFacts({ facts: controllerV2Facts(CONTROLLER_ACCOUNT_NAME), fetchedAt: nowSeconds() });

    await waitUntil(() => identityOf(h)?.name === CONTROLLER_ACCOUNT_NAME, { description: "the persisted identity to carry the account name" });
    await pollPast(h);

    assert.equal(nameOf(irrigation), CONTROLLER_OVERRIDE_NAME, "the user's own name outranks the account's everywhere HomeKit shows it");
    assert.equal(h.accessory.displayName, CONTROLLER_OVERRIDE_NAME, "including on the accessory itself");
    assert.equal(identityOf(h)?.name, CONTROLLER_ACCOUNT_NAME, "while the identity carries what the controller actually is");
  });

  test("a name configured for the controller never reaches a zone that has none of its own", async (t) => {

    /* The no-cascade assertion. The Name option resolves at the controller as well as the zone, so the zone reader presents the relay id ALONE - reintroducing the
     * controller serial beside it would resolve the controller's entry here and rename every unnamed zone on the controller.
     */
    const h = buildController({ program: (recorder) => recorder.programDefault("statusschedule.php", { body: schedule(WIRE_NAME), kind: "response" }),
      signalAborted: false, userOptions: ["Enable.Device.Name." + CONTROLLER_SERIAL + "=" + CONTROLLER_OVERRIDE_NAME] });

    t.after(() => h.abort());

    const valve = await valveOf(h);

    await waitUntil(() => nameOf(irrigationOf(h)) === CONTROLLER_OVERRIDE_NAME, { description: "the irrigation system to take the override name" });
    await pollPast(h);
    h.abort();

    assert.equal(nameOf(valve), WIRE_NAME, "the zone keeps the name Hydrawise reports for it");
    assert.equal(nameOf(irrigationOf(h)), CONTROLLER_OVERRIDE_NAME, "while the controller itself carries the name that was written for it");
  });

  test("a zone's own configured name still wins for that zone", async (t) => {

    // The other half of the same claim: closing the cascade must not cost a zone its own entry, so both entries are configured at once and each lands where it
    // was written.
    const h = buildController({ program: (recorder) => recorder.programDefault("statusschedule.php", { body: schedule(WIRE_NAME), kind: "response" }),
      signalAborted: false, userOptions: [ "Enable.Device.Name." + CONTROLLER_SERIAL + "=" + CONTROLLER_OVERRIDE_NAME,
        "Enable.Device.Name." + ZONE_SUBTYPE + "=" + OVERRIDE_NAME ] });

    t.after(() => h.abort());

    const valve = await valveOf(h);

    await waitUntil(() => nameOf(irrigationOf(h)) === CONTROLLER_OVERRIDE_NAME, { description: "the irrigation system to take the override name" });

    assert.equal(nameOf(valve), OVERRIDE_NAME, "the zone carries the name written for the zone");
    assert.equal(nameOf(irrigationOf(h)), CONTROLLER_OVERRIDE_NAME, "and the controller the name written for the controller");
  });

  test("holds the wire's name on an install with no account credentials, and the account's through a refresh outage", async (t) => {

    const bare = buildController({ program: (recorder) => recorder.programDefault("statusschedule.php", { body: schedule(WIRE_NAME), kind: "response" }),
      signalAborted: false });

    t.after(() => bare.abort());

    const bareIrrigation = irrigationOf(bare);

    bareIrrigation.clearWrites();

    await pollPast(bare);
    bare.abort();

    // The promise to an install carrying only an API key: nothing about this pass touches a name it has always had.
    assert.deepEqual(nameWrites(bareIrrigation), [], "an install with no credentials performs no controller rename at all");
    assert.equal(nameOf(bareIrrigation), CONTROLLER_WIRE_NAME, "and keeps the name the wire reports");

    const h = buildController({ hasV2Client: true,
      program: (recorder) => recorder.programDefault("statusschedule.php", { body: schedule(WIRE_NAME), kind: "response" }), signalAborted: false });

    t.after(() => h.abort());

    const irrigation = irrigationOf(h);

    /* The controller grain's own mid-session outage, and the fixture rule the zone grain's assertion states applies here identically: the carry offers a name only
     * where the account's extends the wire's, so the account name under test is the wire name plus a suffix. An unrelated pair would fall through to the wire
     * name and the assertion would pass while proving nothing.
     */
    assert.ok(CONTROLLER_ACCOUNT_EXTENDED.startsWith(CONTROLLER_WIRE_NAME), "the account's name must extend the wire's for the carry to be under test");

    h.controller.applyFacts({ facts: controllerV2Facts(CONTROLLER_ACCOUNT_EXTENDED), fetchedAt: nowSeconds() });

    await waitUntil(() => nameOf(irrigation) === CONTROLLER_ACCOUNT_EXTENDED, { description: "the irrigation system to take the extended account name" });

    h.controller.applyFacts({ facts: controllerV2Facts(CONTROLLER_ACCOUNT_EXTENDED), fetchedAt: nowSeconds() - (HYDRAWISE_V2_FACTS_TTL + 1) });

    await pollPast(h);
    h.abort();

    assert.equal(nameOf(irrigation), CONTROLLER_ACCOUNT_EXTENDED, "an aged-out snapshot leaves the last account name standing on the service");
    assert.equal(identityOf(h)?.name, CONTROLLER_ACCOUNT_EXTENDED, "and the identity holds it too, which is the store the controller's carry reads back from");
  });

  test("a second poll under an unchanged name renames nothing and writes nothing", async (t) => {

    const h = buildController({ program: (recorder) => recorder.programDefault("statusschedule.php", { body: schedule(WIRE_NAME), kind: "response" }),
      signalAborted: false, userOptions: ["Enable.Device.Suspend.All"] });

    t.after(() => h.abort());

    const irrigation = irrigationOf(h);
    const suspendSwitch = suspendSwitchOf(h);

    // The first poll seeds the roster and the schedule projection through the one flush the chokepoint performs; what this asserts is the poll after it.
    await waitUntil(() => h.flushes.length >= 1, { description: "the first accessory flush" });

    const flushesAfterFirstPoll = h.flushes.length;

    irrigation.clearWrites();
    suspendSwitch.clearWrites();

    await pollPast(h);
    h.abort();

    assert.equal(flushesAfterFirstPoll, 1, "the first poll costs exactly one cache write");
    assert.equal(h.flushes.length, 1, "and a poll that moved no name writes the cache no second time");
    assert.deepEqual(nameWrites(irrigation), [], "the sanitized compare finds the controller's name already correct and rewrites nothing");
    assert.deepEqual(nameWrites(suspendSwitch), [], "and the switch composed from it is left alone too");
  });

  test("a rename joins the poll's single cache write, and costs none when nothing moved", async (t) => {

    /* A rename has to reach Homebridge's cache, because the accessory's display name lives there rather than being derived at each start - without the write the
     * controller comes back under its old label at the next restart.
     *
     * The rename under test is a changed Name OPTION, deliberately, because it is the only rename that moves the display and NOTHING else: the persisted identity
     * carries what the controller is rather than what the user calls it, and the roster and schedule are untouched. Any other trigger would flush on its own
     * account and the assertion could not tell which reason paid for the write.
     */
    const h = buildController({ program: (recorder) => recorder.programDefault("statusschedule.php", { body: schedule(WIRE_NAME), kind: "response" }),
      signalAborted: false, userOptions: ["Enable.Device.Suspend.All"] });

    t.after(() => h.abort());

    const irrigation = irrigationOf(h);

    await waitUntil(() => h.flushes.length >= 1, { description: "the first accessory flush" });
    await pollPast(h);

    // The steady state: the seeding poll has paid its one write and the polls after it pay nothing.
    const settled = h.flushes.length;

    h.platform.featureOptions.configuredOptions = ["Enable.Device.Name." + CONTROLLER_SERIAL + "=" + CONTROLLER_OVERRIDE_NAME];

    await waitUntil(() => nameOf(irrigation) === CONTROLLER_OVERRIDE_NAME, { description: "the irrigation system to take the override name" });
    await pollPast(h);
    h.abort();

    assert.equal(h.accessory.displayName, CONTROLLER_OVERRIDE_NAME, "the rename reaches the accessory's own display name");
    assert.equal(h.flushes.length, settled + 1, "and costs exactly one cache write, which the polls after it do not repeat");
  });

  test("does not rewrite a controller name whose HomeKit form differs from the configured value", async (t) => {

    /* The other half of the rename-loop guard, and the half a clean name cannot show. HomeKit's rules rewrite this override, so the name the service carries can
     * never equal what the user configured; a comparison that did not sanitize both sides would call every poll a rename and rewrite the same name forever.
     */
    const h = buildController({ program: (recorder) => recorder.programDefault("statusschedule.php", { body: schedule(WIRE_NAME), kind: "response" }),
      signalAborted: false, userOptions: [ "Enable.Device.Name." + CONTROLLER_SERIAL + "=" + CONTROLLER_FREE_FORM_OVERRIDE, "Enable.Device.Suspend.All" ] });

    t.after(() => h.abort());

    const irrigation = irrigationOf(h);

    await waitUntil(() => nameOf(irrigation) === CONTROLLER_FREE_FORM_SANITIZED, { description: "the irrigation system to take the sanitized free-form name" });

    irrigation.clearWrites();

    await pollPast(h);
    h.abort();

    assert.deepEqual(nameWrites(irrigation), [], "a sanitized name that already matches is not rewritten on every poll");
    assert.equal(nameOf(irrigation), CONTROLLER_FREE_FORM_SANITIZED, "and the controller still carries the sanitized override");
    assert.equal(nameOf(suspendSwitchOf(h)), CONTROLLER_FREE_FORM_SANITIZED + SUSPEND_ALL_SUFFIX, "with the switch composed from the same name");
  });

  test("creation consults the Name option, so an opted-out controller is established under it", async (t) => {

    /* What a synchronization opt-out means at the controller grain: names are established at creation from the configured truth and never touched again. The
     * consult has to happen at CREATION for that to hold, because the rename step returns immediately under the opt-out - a service born under the wire's name
     * would keep it for the life of the accessory, with the option the user set to correct it unreachable.
     *
     * Facts land carrying a different name as well, so the assertion distinguishes "established from the override" from "never renamed at all": an implementation that
     * ignored the override at creation would show the wire's name here, and one that ignored the opt-out would show the account's.
     */
    const h = buildController({ hasV2Client: true,
      program: (recorder) => recorder.programDefault("statusschedule.php", { body: schedule(WIRE_NAME), kind: "response" }), signalAborted: false,
      userOptions: [ "Disable.Device.SyncName." + CONTROLLER_SERIAL, "Enable.Device.Suspend.All",
        "Enable.Device.Name." + CONTROLLER_SERIAL + "=" + CONTROLLER_OVERRIDE_NAME ] });

    t.after(() => h.abort());

    h.controller.applyFacts({ facts: controllerV2Facts(CONTROLLER_ACCOUNT_NAME), fetchedAt: nowSeconds() });

    await waitUntil(() => identityOf(h)?.name === CONTROLLER_ACCOUNT_NAME, { description: "the persisted identity to carry the account name" });
    await pollPast(h);
    h.abort();

    assert.equal(nameOf(irrigationOf(h)), CONTROLLER_OVERRIDE_NAME, "the irrigation system service is established under the user's own name");
    assert.equal(nameOf(suspendSwitchOf(h)), CONTROLLER_OVERRIDE_NAME + SUSPEND_ALL_SUFFIX, "and the switch composes its own from the same effective name");
    assert.equal(identityOf(h)?.name, CONTROLLER_ACCOUNT_NAME, "while the identity still records what the controller actually is");
  });

  test("creation consults the Name option for an opted-out zone's own accessory too", async (t) => {

    /* The same contract at the zone grain, on a zone promoted to an accessory of its own. The existing standalone assertions cover an override under synchronization
     * ON and an opt-out with no override configured; what neither can show is the two together, which is where a creation that ignored the override would
     * strand the accessory under the wire's name permanently.
     */
    const h = buildController({ program: (recorder) => recorder.programDefault("statusschedule.php", { body: schedule(WIRE_NAME), kind: "response" }),
      signalAborted: false, userOptions: [ "Enable.Device.Standalone." + ZONE_SUBTYPE, "Disable.Device.SyncName." + ZONE_SUBTYPE,
        "Enable.Device.Name." + ZONE_SUBTYPE + "=" + OVERRIDE_NAME ] });

    t.after(() => h.abort());

    const zoneAccessory = await waitFor(() => h.zoneAccessories.get(ZONE_RELAY_ID), { description: "the zone's own accessory to appear" });

    await pollPast(h);
    h.abort();

    assert.equal(zoneAccessory.displayName, OVERRIDE_NAME, "the zone's own accessory is created under the user's name despite the opt-out");
    assert.equal(nameOf(await waitFor(() => zoneAccessory.getServiceById(Service.Valve, ZONE_SUBTYPE),
      { description: "the zone valve on the zone's own accessory to appear" })), OVERRIDE_NAME, "and so is the valve it hosts");
  });

  test("a name that sanitizes to nothing leaves every surface the controller names standing", async (t) => {

    /* HomeKit's naming rules can empty a name outright, and a service has to answer to something. The library's accessory helper declines a blank rename on its
     * own, but the service helper writes whatever it is handed, so every service this step renames needs the emptiness decided before the write - otherwise an
     * unusable name blanks the very labels the user navigates by. This asserts all of them against a name every character of which HomeKit's rules discard.
     */
    const h = buildController({ hasV2Client: true,
      program: (recorder) => recorder.programDefault("statusschedule.php", { body: schedule(WIRE_NAME), kind: "response" }), signalAborted: false,
      userOptions: ["Enable.Device.Suspend.All"] });

    t.after(() => h.abort());

    // A real name lands first, so what the gate protects is a value the plugin itself wrote rather than the absence of one.
    h.controller.applyFacts({ facts: controllerV2Facts(CONTROLLER_ACCOUNT_NAME), fetchedAt: nowSeconds() });

    await waitUntil(() => h.accessory.displayName === CONTROLLER_ACCOUNT_NAME, { description: "the accessory to take the account name" });

    /* Clear the name-write log on every surface before the unusable name arrives. The claim is that the step writes NOTHING, which is stronger than any value
     * comparison and is the only claim available for the service label, whose name characteristic the HAP double does not model.
     */
    const label = labelOf(h);

    irrigationOf(h).clearWrites();
    label.clearWrites();
    suspendSwitchOf(h).clearWrites();

    h.controller.applyFacts({ facts: controllerV2Facts(UNUSABLE_NAME), fetchedAt: nowSeconds() });

    await pollPast(h);
    h.abort();

    assert.deepEqual(nameWrites(irrigationOf(h)), [], "the irrigation system service takes no name write at all");
    assert.deepEqual(nameWrites(label), [], "nor does the service label enumerating the zones");
    assert.deepEqual(nameWrites(suspendSwitchOf(h)), [], "nor the switch composed from the controller's name");
    assert.equal(h.accessory.displayName, CONTROLLER_ACCOUNT_NAME, "the accessory keeps the display name it had");
    assert.equal(nameOf(informationOf(h)), CONTROLLER_ACCOUNT_NAME, "and the information service beneath it keeps its own");
    assert.equal(nameOf(irrigationOf(h)), CONTROLLER_ACCOUNT_NAME, "the irrigation system service keeps the label the user navigates by");
    assert.equal(nameOf(suspendSwitchOf(h)), CONTROLLER_ACCOUNT_NAME + SUSPEND_ALL_SUFFIX, "and the switch composed from it keeps its own");
  });

  test("a zone whose name sanitizes to nothing leaves its valve and its companion switch standing", async (t) => {

    /* The same rule at the zone grain, where the walk's own rename gates answer for it. The composed switch name is the case worth stating: it would sanitize
     * to the bare suffix rather than to nothing, so a gate asking only whether the COMPOSED name survives would happily rename the switch to a label naming no
     * zone at all. Asking the zone half is what prevents that.
     */
    const h = buildController({ hasV2Client: true, program: (recorder) => {

      recorder.program("statusschedule.php", { body: schedule(WIRE_NAME), kind: "response" });
      recorder.programDefault("statusschedule.php", { body: schedule(UNUSABLE_NAME), kind: "response" });
    }, signalAborted: false, userOptions: ["Enable.Device.Suspend.Zone." + CONTROLLER_SERIAL] });

    t.after(() => h.abort());

    const valve = await valveOf(h);
    const zoneSwitch = await waitFor(() => h.accessory.getServiceById(Service.Switch, ZONE_SUSPEND_SUBTYPE), { description: "the zone suspension switch to appear" });

    await pollPast(h);
    h.abort();

    assert.equal(nameOf(valve), WIRE_NAME, "the valve keeps the name it was created with rather than being blanked");
    assert.equal(nameOf(zoneSwitch), WIRE_NAME + ZONE_SUSPEND_SUFFIX, "and its companion switch keeps the composed name rather than falling back to the suffix");
  });
});
