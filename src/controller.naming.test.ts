/* Copyright(C) 2017-2026, HJD (https://github.com/hjdhjd). All rights reserved.
 *
 * controller.naming.test.ts: Zone and controller naming, and the synchronization behind both. Asserts the effective name a valve is created with (the user's Name
 * option when set, otherwise the name Hydrawise reports), the synchronization that keeps it current while SyncName holds, the exact-compare that keeps a matching
 * name from being rewritten on every poll, the set Name option that applies whatever SyncName says, the creation-only behavior a SyncName opt-out restores where no
 * Name is set, the same contract applied to the controller's own surfaces - its irrigation system service, its accessory, and its suspend-all switch - the
 * scopes the framework enforces for the Name option at either grain, and the kind's word a name HomeKit cannot carry falls back to, with the warning it draws.
 */

// The Hydrawise API wire shapes use snake_case keys such as relay_id, so camelcase is disabled here to let the zone fixtures mirror the wire verbatim.
/* eslint-disable camelcase */
import { Characteristic, Service, buildController, makeV2Facts, makeZoneV2Facts, seedEstablished, waitFor } from "./testing/platform.helpers.ts";
import { FeatureOptions, acquireService, getServiceName, setAccessoryName, setServiceName } from "homebridge-plugin-utils";
import { HYDRAWISE_ACTIVE_ZONE_INDICATOR, HYDRAWISE_V2_FACTS_TTL } from "./settings.ts";
import { HYDRAWISE_CONTROLLER_FALLBACK_NAME, HYDRAWISE_ZONE_FALLBACK_NAME, HydrawiseReservedNames, scheduleStatus } from "./types.ts";
import type { Service as HapService, PlatformAccessory } from "homebridge";
import type { HydrawiseAccessoryContext, HydrawiseControllerIdentity, HydrawiseControllerV2Facts, HydrawiseZoneConfig, HydrawiseZoneIdentity,
  StatusScheduleResponse } from "./types.ts";
import type { HydrawiseControllerOption, HydrawiseControllerValueOption, HydrawiseZoneOption, HydrawiseZoneValueOption } from "./options.ts";
import { describe, test } from "node:test";
import { fastPolling, makeStatusSchedule, makeZone } from "./api.helpers.ts";
import { featureOptionCategories, featureOptions } from "./options.ts";
import { logCount, present, triggerSet, waitUntil } from "homebridge-plugin-utils/testing";
import type { BuildControllerResult } from "./testing/platform.helpers.ts";
import assert from "node:assert/strict";
import { bareSensors } from "./api.fixtures.ts";

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

// A name of emoji alone, the other shape HomeKit can carry nothing of, and the one a user is most likely to give a controller or a zone.
const EMOJI_NAME = "\u{1F331}\u{1F4A7}";

// The name the zone composer falls back to for the zone under test, which sits at relay 1.
const ZONE_FALLBACK_NAME = HYDRAWISE_ZONE_FALLBACK_NAME + " 1";

// The warning each fallback draws, as far as it names what HomeKit shows, so a count reads one tile's warnings and nothing else.
const CONTROLLER_FALLBACK_WARNING = "HomeKit cannot use the name of this controller (serial: " + CONTROLLER_SERIAL + "), so HomeKit shows it as " +
  HYDRAWISE_CONTROLLER_FALLBACK_NAME + ".";

const ZONE_FALLBACK_WARNING = "HomeKit cannot use this zone's name, so HomeKit shows it as " + ZONE_FALLBACK_NAME + ".";

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

/* Seed a cached valve already bearing a name, the shape Homebridge restores when an accessory returns from its cache carrying a rename the user made in the Home
 * app. The name lands on ConfiguredName, which is the characteristic a Home-app rename writes and the one the name helpers read first. It is written through the
 * HBPU helper production names a valve with, which registers ConfiguredName among the valve's optional characteristics before writing it, so the seed carries the
 * characteristic as a valve production named carries it, and HAP adds it without a warning.
 */
function seedNamedValve(name: string): (accessory: PlatformAccessory) => void {

  return (accessory: PlatformAccessory): void => {

    setServiceName(accessory.addService(new Service.Valve(name, ZONE_SUBTYPE)), name);
  };
}

// Wait for the zone's valve to exist, then hand it back.
async function valveOf(h: BuildControllerResult): Promise<HapService> {

  return waitFor(() => h.accessory.getServiceById(Service.Valve, ZONE_SUBTYPE), { description: "the zone valve to appear" });
}

// The name the valve presents to HomeKit, read through the same helper production reads it through.
function nameOf(valve: HapService): string | undefined {

  return getServiceName(valve);
}

// The values written to the name characteristics of one service, read from the accessory's change record. A valve takes routine writes on every poll - Active
// and its neighbors - so a claim about naming filters those out rather than reading every change the service raised.
function nameChanges(h: BuildControllerResult, service: HapService): unknown[] {

  return h.accessory.changesOn(service, Characteristic.ConfiguredName, Characteristic.Name).map(change => change.newValue);
}

// One refresh tick's facts for the CONTROLLER itself, carrying its account name and nothing else to say.
function controllerV2Facts(name: string): HydrawiseControllerV2Facts {

  return makeV2Facts({ name });
}

// The irrigation system service: this controller's primary HomeKit label, and the service every other controller rename is gated on.
function irrigationOf(h: BuildControllerResult): HapService {

  const service = h.accessory.getService(Service.IrrigationSystem);

  assert.ok(service, "the controller accessory carries an irrigation system service");

  return service;
}

// The accessory information service, whose name is the half of the accessory's display pair that lives on a service.
function informationOf(h: BuildControllerResult): HapService {

  const service = h.accessory.getService(Service.AccessoryInformation);

  assert.ok(service, "the controller accessory carries an information service");

  return service;
}

// The suspend-all switch, whose name is composed from the controller's own and therefore tracks it.
function suspendSwitchOf(h: BuildControllerResult): HapService {

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
    await h.abort();

    /* Creation applies the effective name through each name characteristic the kind supports before the valve joins the accessory, which is where the accessory's
     * change record for the valve begins. The names the valve carries are what that creation wrote, and the record holds every name write after it: nothing in the
     * pass that created the valve, and nothing in the passes after it, applies the name again.
     */
    assert.equal(valve.getCharacteristic(Characteristic.ConfiguredName).value, OVERRIDE_NAME, "the creating pass writes the override to the configured name");
    assert.equal(valve.getCharacteristic(Characteristic.Name).value, OVERRIDE_NAME, "and to the name");
    assert.deepEqual(nameChanges(h, valve), [], "and nothing after it writes the name again");
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

    h.accessory.clearObservations();

    await pollPast(h);
    await h.abort();

    // The plugin's own compare stands between this poll and a write, and so does HBPU's compare-first name helper, so the claim is that no name write reaches HAP.
    assert.deepEqual(nameChanges(h, valve), [], "a poll finding the name already correct performs no name write");
    assert.ok(h.accessory.changesOn(valve).length > 0, "the same poll still performs its routine writes on the valve, so the empty name-filtered view is a real skip");
  });

  test("does not rewrite an override whose HomeKit name differs from the configured value", async (t) => {

    // The override carries characters HomeKit's naming rules replace, so the name on the service can never equal the configured value. The comparison sanitizes
    // before comparing, which is what keeps this from rewriting the same name on every single poll.
    const h = buildController({ program: (recorder) => recorder.programDefault("statusschedule.php", { body: schedule(WIRE_NAME), kind: "response" }),
      signalAborted: false, userOptions: ["Enable.Device.Name." + ZONE_SUBTYPE + "=" + FREE_FORM_OVERRIDE] });

    t.after(() => h.abort());

    const valve = await valveOf(h);

    h.accessory.clearObservations();

    await pollPast(h);
    await h.abort();

    // The plugin's sanitizing compare stands between this poll and a write, and so does HBPU's compare-first name helper, so the claim is that no name write
    // reaches HAP.
    assert.deepEqual(nameChanges(h, valve), [], "a sanitized name that already matches is not rewritten on every poll");
    assert.equal(nameOf(valve), FREE_FORM_SANITIZED, "the valve still carries the sanitized override");
  });
});

describe("zone name synchronization saves", () => {

  test("a changed Name option renames the valve alone and saves it once, and an unchanged name saves nothing", async (t) => {

    /* The valve's rename measured where nothing else can stand in for it. The override is display, so the persisted roster keeps the name Hydrawise reports and
     * no projection moves: the valve's own rename is the only thing that can mark the accessory.
     */
    const h = buildController({ program: (recorder) => recorder.programDefault("statusschedule.php", { body: schedule(WIRE_NAME), kind: "response" }),
      signalAborted: false });

    t.after(() => h.abort());

    const valve = await valveOf(h);

    await pollPast(h);

    const settled = h.flushes().length;

    h.platform.featureOptions.configuredOptions = ["Enable.Device.Name." + ZONE_SUBTYPE + "=" + OVERRIDE_NAME];

    await waitUntil(() => nameOf(valve) === OVERRIDE_NAME, { description: "the valve to take the override name" });
    await pollPast(h);
    await h.abort();

    assert.equal(rosterOf(h)[0]?.name, WIRE_NAME, "the roster keeps the name Hydrawise reports, so it moved nothing");
    assert.equal(h.flushes().length, settled + 1, "the valve's rename saves exactly once, and the polls after it save nothing");
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

      h.accessory.clearObservations();

      await pollPast(h);
      await h.abort();

      assert.deepEqual(nameChanges(h, valve), [], "no poll re-asserts a name while synchronization is disabled");
      assert.equal(nameOf(valve), HOME_APP_NAME, "the rename made in the Home app stands");
    });
  }

  test("still creates a new valve with the effective name, and writes it no second time while the valve carries it", async (t) => {

    const h = buildController({ program: (recorder) => recorder.programDefault("statusschedule.php", { body: schedule(WIRE_NAME), kind: "response" }),
      signalAborted: false, userOptions: [ "Disable.Device.SyncName." + ZONE_SUBTYPE, "Enable.Device.Name." + ZONE_SUBTYPE + "=" + OVERRIDE_NAME ] });

    t.after(() => h.abort());

    const valve = await valveOf(h);

    assert.equal(nameOf(valve), OVERRIDE_NAME, "creation carries the override even with synchronization disabled");

    h.accessory.clearObservations();

    await pollPast(h);
    await h.abort();

    assert.deepEqual(nameChanges(h, valve), [], "a name the valve already carries is not written again");
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
    await h.abort();

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

    /* A faithful warm restart: Homebridge hands back the accessory with the services, the persisted state and the accessory's own name the previous session
     * saved, all of them carrying the account's full names. Seeding the schedule projection alongside them is what makes the cardinality claim below literal
     * rather than a claim about the schedule seed - a first poll that matched nothing would save on the schedule's account whatever the names did.
     */
    const h = buildController({ hasV2Client: true,
      program: (recorder) => recorder.programDefault("statusschedule.php", { body: schedule(WIRE_NAME), kind: "response" }),
      seedContext: (seed) => {

        seed.context = { controller: { controllerId: 500001, name: CONTROLLER_ACCOUNT_EXTENDED, serialNumber: CONTROLLER_SERIAL },
          schedule: scheduleStatus(schedule(WIRE_NAME), HYDRAWISE_ACTIVE_ZONE_INDICATOR), zones: [{ name: ACCOUNT_NAME, relay: 1, relayId: ZONE_RELAY_ID }] };

        setServiceName(seed.addService(Service.IrrigationSystem, CONTROLLER_ACCOUNT_EXTENDED), CONTROLLER_ACCOUNT_EXTENDED);
        setServiceName(seed.addService(Service.Valve, ACCOUNT_NAME, ZONE_SUBTYPE), ACCOUNT_NAME);
        setAccessoryName(seed, CONTROLLER_ACCOUNT_EXTENDED);
      }, signalAborted: false });

    t.after(() => h.abort());

    const valve = await valveOf(h);

    h.accessory.clearObservations();

    await pollPast(h);
    await h.abort();

    assert.equal(nameOf(valve), ACCOUNT_NAME, "the zone's valve keeps the name the previous session flushed, not the wire's cut form");
    assert.equal(nameOf(irrigationOf(h)), CONTROLLER_ACCOUNT_EXTENDED, "and the controller keeps its own");
    assert.equal(rosterOf(h)[0]?.name, ACCOUNT_NAME, "the roster still carries the full name rather than being rewritten to the wire's");

    /* The cardinality half, which is the half the user actually sees. Composing the same names the roster already holds means the first poll finds nothing
     * moved, so it renames nothing and writes nothing - where a fall-through would have paid one write to truncate every label and another to heal them.
     */
    assert.deepEqual(nameChanges(h, valve), [], "no rename touches the valve");
    assert.deepEqual(nameChanges(h, irrigationOf(h)), [], "nor the controller's own service");
    assert.equal(h.flushes().length, 0, "and the restart costs no cache write at all");
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
    await h.abort();

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
    await h.abort();

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
    await h.abort();

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
    await h.abort();

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

    bare.accessory.clearObservations();

    // The first poll's marks - the roster and schedule seeds, the valve it attaches, the name its information service gains - reach the cache as one save, so a
    // save past it can only be a rename.
    await waitUntil(() => bare.flushes().length >= 1, { description: "the first accessory flush" });

    const bareFlushesAfterFirstPoll = bare.flushes().length;

    await pollPast(bare);
    await bare.abort();

    /* The promise to an install carrying only an API key: nothing about this pass touches a name it has always had. The name helpers compare before they write,
     * and only a write marks the accessory, so the save count reads what they answered: an unchanged name costs no save.
     */
    assert.deepEqual(nameChanges(bare, bareIrrigation), [], "an install with no credentials performs no controller rename at all");
    assert.equal(bareFlushesAfterFirstPoll, 1, "the first poll costs exactly one cache write");
    assert.equal(bare.flushes().length, bareFlushesAfterFirstPoll, "and the polls after it rename nothing, so they write the cache no second time");
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
    await h.abort();

    assert.equal(nameOf(irrigation), CONTROLLER_ACCOUNT_EXTENDED, "an aged-out snapshot leaves the last account name standing on the service");
    assert.equal(identityOf(h)?.name, CONTROLLER_ACCOUNT_EXTENDED, "and the identity holds it too, which is the store the controller's carry reads back from");
  });

  test("a second poll under an unchanged name renames nothing and writes nothing", async (t) => {

    const h = buildController({ program: (recorder) => recorder.programDefault("statusschedule.php", { body: schedule(WIRE_NAME), kind: "response" }),
      signalAborted: false, userOptions: ["Enable.Device.Suspend.All"] });

    t.after(() => h.abort());

    const irrigation = irrigationOf(h);
    const suspendSwitch = suspendSwitchOf(h);

    // The first poll's marks reach the cache as one save; what this asserts is the poll after it.
    await waitUntil(() => h.flushes().length >= 1, { description: "the first accessory flush" });

    const flushesAfterFirstPoll = h.flushes().length;

    h.accessory.clearObservations();

    await pollPast(h);
    await h.abort();

    assert.equal(flushesAfterFirstPoll, 1, "the first poll costs exactly one cache write");
    assert.equal(h.flushes().length, 1, "and a poll that moved no name writes the cache no second time");
    assert.deepEqual(nameChanges(h, irrigation), [], "the sanitized compare finds the controller's name already correct and rewrites nothing");
    assert.deepEqual(nameChanges(h, suspendSwitch), [], "and the switch composed from it is left alone too");
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

    await waitUntil(() => h.flushes().length >= 1, { description: "the first accessory flush" });
    await pollPast(h);

    // The steady state: the seeding poll has paid its one write and the polls after it pay nothing.
    const settled = h.flushes().length;

    h.platform.featureOptions.configuredOptions = ["Enable.Device.Name." + CONTROLLER_SERIAL + "=" + CONTROLLER_OVERRIDE_NAME];

    await waitUntil(() => nameOf(irrigation) === CONTROLLER_OVERRIDE_NAME, { description: "the irrigation system to take the override name" });
    await pollPast(h);
    await h.abort();

    assert.equal(h.accessory.displayName, CONTROLLER_OVERRIDE_NAME, "the rename reaches the accessory's own display name");
    assert.equal(h.flushes().length, settled + 1, "and costs exactly one cache write, which the polls after it do not repeat");
  });

  test("an accessory missing its information service's ConfiguredName gains it on its first synced poll, saved once and not again", async (t) => {

    /* A cached accessory carries the characteristic only once the rename step has written it, because HAP declares it optional on the information service and
     * builds none. The accessory's display name already matches, and the context and the valve are restored as a warm restart restores them, so the information
     * service's half of the name is the only thing the first poll writes.
     */
    const h = buildController({ program: (recorder) => recorder.programDefault("statusschedule.php", { body: schedule(WIRE_NAME), kind: "response" }),
      seedContext: (seed) => {

        seed.context = { schedule: scheduleStatus(schedule(WIRE_NAME), HYDRAWISE_ACTIVE_ZONE_INDICATOR), zones: [{ name: WIRE_NAME, relay: 1, relayId: ZONE_RELAY_ID }] };
        acquireService({ accessory: seed, name: WIRE_NAME, serviceType: Service.Valve, subtype: ZONE_SUBTYPE });
      }, signalAborted: false });

    t.after(() => h.abort());

    const information = informationOf(h);

    assert.equal(information.testCharacteristic(Characteristic.ConfiguredName), false, "the restored information service carries no ConfiguredName");

    await pollPast(h);
    await pollPast(h);
    await h.abort();

    assert.equal(information.getCharacteristic(Characteristic.ConfiguredName).value, CONTROLLER_WIRE_NAME, "the first synced poll writes the controller's name to it");
    assert.equal(h.flushes().length, 1, "and saves the accessory once for it, the polls after it saving nothing");
  });

  test("a stale persisted identity is rewritten on the first poll, the run's only save", async (t) => {

    /* The identity's mark measured where nothing else can stand in for it. A previous session persisted a name other than the one the wire reports, and with no account
     * credentials nothing can carry it, so the first poll rewrites the identity, while the projections and the services earlier polls established are restored
     * to match that poll and write nothing.
     */
    const h = buildController({ program: (recorder) => recorder.programDefault("statusschedule.php", { body: schedule(WIRE_NAME), kind: "response" }),
      seedContext: (seed) => {

        seed.context = { controller: { controllerId: 500001, name: "Former Controller", serialNumber: CONTROLLER_SERIAL },
          schedule: scheduleStatus(schedule(WIRE_NAME), HYDRAWISE_ACTIVE_ZONE_INDICATOR), zones: [{ name: WIRE_NAME, relay: 1, relayId: ZONE_RELAY_ID }] };
        seedEstablished({ accessory: seed, zones: [zone(WIRE_NAME)] });
      }, signalAborted: false });

    t.after(() => h.abort());

    assert.equal(identityOf(h)?.name, "Former Controller", "the stale identity survives the context wipe for the first poll to judge");

    await pollPast(h);
    await h.abort();

    assert.equal(identityOf(h)?.name, CONTROLLER_WIRE_NAME, "the first poll rewrites the identity to the name the wire reports");
    assert.equal(h.flushes().length, 1, "and that rewrite is the only save the run makes");
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

    // The first poll's marks reach the cache as one save, so a save past it can only be a rename.
    await waitUntil(() => h.flushes().length >= 1, { description: "the first accessory flush" });

    const flushesAfterFirstPoll = h.flushes().length;

    h.accessory.clearObservations();

    await pollPast(h);
    await h.abort();

    /* The name helpers compare in the sanitized form, so the save count is what shows a configured value HomeKit's rules rewrite reading as unchanged:
     * a compare that read it raw would call every poll a rename, and every rename marks the accessory for a save.
     */
    assert.deepEqual(nameChanges(h, irrigation), [], "a sanitized name that already matches is not rewritten on every poll");
    assert.equal(flushesAfterFirstPoll, 1, "the first poll costs exactly one cache write");
    assert.equal(h.flushes().length, flushesAfterFirstPoll, "and the polls after it rename nothing, so they write the cache no second time");
    assert.equal(nameOf(irrigation), CONTROLLER_FREE_FORM_SANITIZED, "and the controller still carries the sanitized override");
    assert.equal(nameOf(suspendSwitchOf(h)), CONTROLLER_FREE_FORM_SANITIZED + SUSPEND_ALL_SUFFIX, "with the switch composed from the same name");
  });

  test("creation consults the Name option, so an opted-out controller is established under it", async (t) => {

    /* Creation consults the configured truth at the controller grain, so a service is born under the user's own name rather than renamed to it by a later pass.
     * The rename step holds a set Name on every poll whatever the opt-out says, so the creation half is read before the first poll can run.
     *
     * Facts land carrying a different name as well, so the end state distinguishes the override from the account's name: an implementation that let the account's
     * name stand in for a set Name would show it here.
     */
    const h = buildController({ hasV2Client: true,
      program: (recorder) => recorder.programDefault("statusschedule.php", { body: schedule(WIRE_NAME), kind: "response" }), signalAborted: false,
      userOptions: [ "Disable.Device.SyncName." + CONTROLLER_SERIAL, "Enable.Device.Suspend.All",
        "Enable.Device.Name." + CONTROLLER_SERIAL + "=" + CONTROLLER_OVERRIDE_NAME ] });

    t.after(() => h.abort());

    assert.equal(nameOf(irrigationOf(h)), CONTROLLER_OVERRIDE_NAME, "the irrigation system service is created under the user's own name, before any poll");

    h.controller.applyFacts({ facts: controllerV2Facts(CONTROLLER_ACCOUNT_NAME), fetchedAt: nowSeconds() });

    await waitUntil(() => identityOf(h)?.name === CONTROLLER_ACCOUNT_NAME, { description: "the persisted identity to carry the account name" });
    await pollPast(h);
    await h.abort();

    assert.equal(nameOf(irrigationOf(h)), CONTROLLER_OVERRIDE_NAME, "the irrigation system service keeps the user's own name");
    assert.equal(nameOf(suspendSwitchOf(h)), CONTROLLER_OVERRIDE_NAME + SUSPEND_ALL_SUFFIX, "and the switch composes its own from the same effective name");
    assert.equal(identityOf(h)?.name, CONTROLLER_ACCOUNT_NAME, "while the identity still records what the controller actually is");
  });

  test("creation consults the Name option for an opted-out zone's own accessory too", async (t) => {

    /* The same contract at the zone grain, on a zone promoted to an accessory of its own. The existing standalone assertions cover an override under synchronization
     * ON and an opt-out with no override configured; what neither can show is the two together. The poll's walk holds a set Name on the accessory whatever the
     * opt-out says, so the creation half is read from the request the accessory is minted from.
     */
    const h = buildController({ program: (recorder) => recorder.programDefault("statusschedule.php", { body: schedule(WIRE_NAME), kind: "response" }),
      signalAborted: false, userOptions: [ "Enable.Device.Standalone." + ZONE_SUBTYPE, "Disable.Device.SyncName." + ZONE_SUBTYPE,
        "Enable.Device.Name." + ZONE_SUBTYPE + "=" + OVERRIDE_NAME ] });

    t.after(() => h.abort());

    const zoneAccessory = await waitFor(() => h.zoneAccessories.get(ZONE_RELAY_ID), { description: "the zone's own accessory to appear" });

    await pollPast(h);
    await h.abort();

    assert.equal(h.reconciles[0]?.zones[0]?.displayName, OVERRIDE_NAME, "the zone's own accessory is requested under the user's name despite the opt-out");
    assert.equal(zoneAccessory.displayName, OVERRIDE_NAME, "and carries it");
    assert.equal(nameOf(await waitFor(() => zoneAccessory.getServiceById(Service.Valve, ZONE_SUBTYPE),
      { description: "the zone valve on the zone's own accessory to appear" })), OVERRIDE_NAME, "and so is the valve it hosts");
  });

  test("a tracked name that sanitizes to nothing renames every surface the controller names to the controller word", async (t) => {

    /* HomeKit's naming rules can empty a name outright, and a service has to answer to something, so the controller composer answers the controller word, and
     * every surface the rename step tracks takes it: the irrigation system, the accessory's display pair and the information service beneath it, and the
     * suspend-all switch, whose name composes from the word rather than from a half HomeKit cannot carry. This asserts every surface against a name every
     * character of which HomeKit's rules discard, arriving after a real one the plugin itself wrote.
     */
    const h = buildController({ hasV2Client: true,
      program: (recorder) => recorder.programDefault("statusschedule.php", { body: schedule(WIRE_NAME), kind: "response" }), signalAborted: false,
      userOptions: ["Enable.Device.Suspend.All"] });

    t.after(() => h.abort());

    h.controller.applyFacts({ facts: controllerV2Facts(CONTROLLER_ACCOUNT_NAME), fetchedAt: nowSeconds() });

    await waitUntil(() => h.accessory.displayName === CONTROLLER_ACCOUNT_NAME, { description: "the accessory to take the account name" });

    h.controller.applyFacts({ facts: controllerV2Facts(UNUSABLE_NAME), fetchedAt: nowSeconds() });

    await waitUntil(() => h.accessory.displayName === HYDRAWISE_CONTROLLER_FALLBACK_NAME, { description: "the accessory to take the controller word" });
    await pollPast(h);
    await h.abort();

    assert.equal(nameOf(irrigationOf(h)), HYDRAWISE_CONTROLLER_FALLBACK_NAME, "the irrigation system service takes the controller word");
    assert.equal(h.accessory.displayName, HYDRAWISE_CONTROLLER_FALLBACK_NAME, "and so does the accessory's display name");
    assert.equal(nameOf(informationOf(h)), HYDRAWISE_CONTROLLER_FALLBACK_NAME, "and the information service beneath it");
    assert.equal(nameOf(suspendSwitchOf(h)), HYDRAWISE_CONTROLLER_FALLBACK_NAME + SUSPEND_ALL_SUFFIX, "and the switch composes its own name from the word");
    assert.equal(logCount(h.entries, "warn", CONTROLLER_FALLBACK_WARNING), 1, "the move to the word is warned about once");
  });

  test("a tracked zone name that sanitizes to nothing renames its valve and its companion switch to the zone word and number", async (t) => {

    /* The same rule at the zone grain, where the walk's own rename gates answer for it. The composed switch name is the case worth stating: the zone half is the
     * composer's word and number, so the switch is renamed to a label that still names its zone rather than to its bare suffix.
     */
    const h = buildController({ hasV2Client: true, program: (recorder) => {

      recorder.program("statusschedule.php", { body: schedule(WIRE_NAME), kind: "response" });
      recorder.programDefault("statusschedule.php", { body: schedule(UNUSABLE_NAME), kind: "response" });
    }, signalAborted: false, userOptions: ["Enable.Device.Suspend.Zone." + CONTROLLER_SERIAL] });

    t.after(() => h.abort());

    const valve = await valveOf(h);
    const zoneSwitch = await waitFor(() => h.accessory.getServiceById(Service.Switch, ZONE_SUSPEND_SUBTYPE), { description: "the zone suspension switch to appear" });

    await waitUntil(() => nameOf(valve) === ZONE_FALLBACK_NAME, { description: "the valve to take the zone word and number" });
    await pollPast(h);
    await h.abort();

    assert.equal(nameOf(valve), ZONE_FALLBACK_NAME, "the valve takes the zone word and its relay number");
    assert.equal(nameOf(zoneSwitch), ZONE_FALLBACK_NAME + ZONE_SUSPEND_SUFFIX, "and its companion switch composes its own name from them");
    assert.equal(logCount(h.entries, "warn", ZONE_FALLBACK_WARNING), 1, "the move to the word is warned about once");
  });
});

describe("the naming rule", () => {

  test("with synchronization disabled, a set Name option reaches every surface and a rename made in the Home app yields to it", async (t) => {

    /* The family rule: a Name the user set applies on every pass, whatever synchronization says. Every surface the Home app can rename is renamed there, the
     * controller accessory and its suspend-all switch at the controller, and the valve, its companion switch and the accessory hosting them at the zone, so a
     * gate that still read synchronization alone at the controller or at the zone leaves its half standing under the Home app's name. HomeKit carries no
     * ConfiguredName on an irrigation system, so a rename of the controller lands on its accessory's information service, and the irrigation system, read
     * through its Name characteristic, carries the Name it was created under.
     */
    const h = buildController({ accessoryName: CONTROLLER_OVERRIDE_NAME, hasV2Client: true,
      program: (recorder) => recorder.programDefault("statusschedule.php", { body: schedule(WIRE_NAME), kind: "response" }), signalAborted: false,
      userOptions: [ "Disable.Device.SyncName", "Enable.Device.Name." + CONTROLLER_SERIAL + "=" + CONTROLLER_OVERRIDE_NAME,
        "Enable.Device.Name." + ZONE_SUBTYPE + "=" + OVERRIDE_NAME, "Enable.Device.Standalone." + ZONE_SUBTYPE, "Enable.Device.Suspend.All",
        "Enable.Device.Suspend.Zone." + CONTROLLER_SERIAL ] });

    t.after(() => h.abort());

    const host = await waitFor(() => h.zoneAccessories.get(ZONE_RELAY_ID), { description: "the zone's own accessory to appear" });
    const valve = await waitFor(() => host.getServiceById(Service.Valve, ZONE_SUBTYPE), { description: "the zone valve on its own accessory to appear" });
    const zoneSwitch = await waitFor(() => host.getServiceById(Service.Switch, ZONE_SUSPEND_SUBTYPE), { description: "the zone suspension switch to appear" });

    await pollPast(h);

    const hostInformation = present(host.getService(Service.AccessoryInformation), "the zone accessory's information service");
    const surfaces = [ informationOf(h), suspendSwitchOf(h), valve, zoneSwitch, hostInformation ];

    for(const service of surfaces) {

      // eslint-disable-next-line no-await-in-loop
      await triggerSet(service.getCharacteristic(Characteristic.ConfiguredName), HOME_APP_NAME);
    }

    assert.ok(surfaces.every(service => nameOf(service) === HOME_APP_NAME), "every surface carries the Home app's name before the next poll");

    await pollPast(h);
    await h.abort();

    assert.equal(nameOf(informationOf(h)), CONTROLLER_OVERRIDE_NAME, "the controller accessory takes the controller's Name back");
    assert.equal(irrigationOf(h).getCharacteristic(Characteristic.Name).value, CONTROLLER_OVERRIDE_NAME, "the irrigation system carries it");
    assert.equal(nameOf(suspendSwitchOf(h)), CONTROLLER_OVERRIDE_NAME + SUSPEND_ALL_SUFFIX, "and so does the suspend-all switch composed from it");
    assert.equal(nameOf(valve), OVERRIDE_NAME, "the valve takes the zone's Name back");
    assert.equal(nameOf(zoneSwitch), OVERRIDE_NAME + ZONE_SUSPEND_SUFFIX, "and so does its companion switch");
    assert.equal(nameOf(hostInformation), OVERRIDE_NAME, "and so does the accessory hosting them");
  });

  test("with synchronization disabled and no Name set, a rename made in the Home app stands across polls", async (t) => {

    /* The other half of the rule: with nothing set, the opt-out means a name is written once, when its service is created, so nothing writes over the user's own.
     * The controller's rename lands on its accessory's information service, as the Home app renames it, and the irrigation system, which carries no
     * ConfiguredName, is read through the Name its creation wrote. The accessory is seeded as an earlier synced session left it, named through HBPU's
     * setAccessoryName, so its information service carries the ConfiguredName the Home app writes...with the opt-out and no Name set, nothing this session
     * writes would add it.
     */
    const h = buildController({ program: (recorder) => recorder.programDefault("statusschedule.php", { body: schedule(WIRE_NAME), kind: "response" }),
      seedContext: (seed) => setAccessoryName(seed, CONTROLLER_WIRE_NAME), signalAborted: false,
      userOptions: [ "Disable.Device.SyncName", "Enable.Device.Suspend.All" ] });

    t.after(() => h.abort());

    const valve = await valveOf(h);

    await pollPast(h);

    // The seed is read on ConfiguredName itself, because the name helpers fall back to the information service's Name, which carries the wire name without it.
    assert.equal(informationOf(h).testCharacteristic(Characteristic.ConfiguredName), true, "the seeded information service carries a ConfiguredName");
    assert.equal(informationOf(h).getCharacteristic(Characteristic.ConfiguredName).value, CONTROLLER_WIRE_NAME, "and it carries the name the seed wrote");

    const surfaces = [ informationOf(h), suspendSwitchOf(h), valve ];

    for(const service of surfaces) {

      // eslint-disable-next-line no-await-in-loop
      await triggerSet(service.getCharacteristic(Characteristic.ConfiguredName), HOME_APP_NAME);
    }

    await pollPast(h);
    await pollPast(h);
    await h.abort();

    assert.equal(nameOf(informationOf(h)), HOME_APP_NAME, "the controller accessory keeps the Home app's name");
    assert.equal(nameOf(suspendSwitchOf(h)), HOME_APP_NAME, "and so does the suspend-all switch");
    assert.equal(nameOf(valve), HOME_APP_NAME, "and so does the valve");
    assert.equal(irrigationOf(h).getCharacteristic(Characteristic.Name).value, CONTROLLER_WIRE_NAME, "while the irrigation system keeps the name it was created with");
  });
});

describe("names HomeKit cannot carry", () => {

  test("a fresh controller minted under its word is warned about exactly once across its construction and two polls", async (t) => {

    /* Discovery mints a controller Hydrawise names in emoji alone under the controller word, which is the name the harness is handed here. Creating the irrigation
     * system decides the controller's warning, and each poll's rename step decides it again, while the suspend-all switch created between them composes from the
     * accessory's own name, which HomeKit already carries, and decides nothing - so the warning is said once rather than once per pass that names the word.
     */
    const h = buildController({ accessoryName: HYDRAWISE_CONTROLLER_FALLBACK_NAME, controller: { name: EMOJI_NAME },
      program: (recorder) => recorder.programDefault("statusschedule.php", { body: schedule(WIRE_NAME), kind: "response" }), signalAborted: false,
      userOptions: ["Enable.Device.Suspend.All"] });

    t.after(() => h.abort());

    assert.equal(logCount(h.entries, "warn", CONTROLLER_FALLBACK_WARNING), 1, "creating the irrigation system under the word warns about it at once");

    await pollPast(h);
    await pollPast(h);
    await h.abort();

    assert.equal(logCount(h.entries, "warn", CONTROLLER_FALLBACK_WARNING), 1, "and the polls after it say nothing more while the word still applies");
    assert.equal(nameOf(irrigationOf(h)), HYDRAWISE_CONTROLLER_FALLBACK_NAME, "the irrigation system carries the word");
    assert.equal(nameOf(suspendSwitchOf(h)), HYDRAWISE_CONTROLLER_FALLBACK_NAME + SUSPEND_ALL_SUFFIX, "and the switch composes its own name from it");
  });

  test("a zone that leaves its word and returns to it is warned about again on its return, and on no pass between", async (t) => {

    const h = buildController({ program: (recorder) => {

      recorder.program("statusschedule.php", { body: schedule(UNUSABLE_NAME), kind: "response" });
      recorder.program("statusschedule.php", { body: schedule(UNUSABLE_NAME), kind: "response" });
      recorder.program("statusschedule.php", { body: schedule(WIRE_NAME), kind: "response" });
      recorder.programDefault("statusschedule.php", { body: schedule(UNUSABLE_NAME), kind: "response" });
    }, signalAborted: false });

    t.after(() => h.abort());

    const valve = await valveOf(h);

    await waitUntil(() => nameOf(valve) === WIRE_NAME, { description: "the valve to take the wire's name", timeoutMs: 5000 });

    assert.equal(logCount(h.entries, "warn", ZONE_FALLBACK_WARNING), 1, "a valve created under the word and held there a second poll is warned about once");

    await waitUntil(() => nameOf(valve) === ZONE_FALLBACK_NAME, { description: "the valve to return to the zone word", timeoutMs: 5000 });
    await pollPast(h);
    await h.abort();

    assert.equal(logCount(h.entries, "warn", ZONE_FALLBACK_WARNING), 2, "and its return to the word is warned about once more");
  });

  test("a zone that leaves the wire for a poll and returns under its word is warned about again", async (t) => {

    /* A poll reporting only another zone takes this one out of the enabled projection, so the walk removes its valve and forgets the warning it said. Its return
     * under its word creates the valve anew, and that creation warns again, as it would for a zone this run had never seen.
     */
    const other = makeZone({ name: "Back Beds", relay: 2, relay_id: 700002, run: 480, time: 68000, timestr: "16:00" });
    const h = buildController({ program: (recorder) => {

      recorder.program("statusschedule.php", { body: schedule(UNUSABLE_NAME), kind: "response" });
      recorder.program("statusschedule.php", { body: fastPolling(makeStatusSchedule({ relays: [other], sensors: bareSensors })), kind: "response" });
      recorder.programDefault("statusschedule.php", { body: schedule(UNUSABLE_NAME), kind: "response" });
    }, signalAborted: false });

    t.after(() => h.abort());

    await valveOf(h);
    await waitUntil(() => h.retrieve.callsTo("statusschedule.php").length >= 3, { description: "the poll that returns the zone", timeoutMs: 5000 });
    await pollPast(h);
    await h.abort();

    assert.equal(logCount(h.entries, "warn", ZONE_FALLBACK_WARNING), 2, "the zone's return under its word is warned about again");
  });

  test("a restart over a zone its word already names warns about it once again, writing nothing", async (t) => {

    // The previous session left the valve under the word, so this run's first pass finds nothing to write, and the warning it still says is the run's own.
    const h = buildController({ program: (recorder) => recorder.programDefault("statusschedule.php", { body: schedule(UNUSABLE_NAME), kind: "response" }),
      seedContext: seedNamedValve(ZONE_FALLBACK_NAME), signalAborted: false });

    t.after(() => h.abort());

    const valve = await valveOf(h);

    h.accessory.clearObservations();

    await pollPast(h);
    await h.abort();

    assert.deepEqual(nameChanges(h, valve), [], "the valve already carries the word, so no pass writes it");
    assert.equal(logCount(h.entries, "warn", ZONE_FALLBACK_WARNING), 1, "while the run's first deciding pass warns about it once");
  });

  test("with synchronization disabled, a cached controller and zone neither rename nor warn, whatever HomeKit can carry of their names", async (t) => {

    /* The previous session left the controller under its word and the user renamed the valve in the Home app. With synchronization off and no Name set, no pass
     * decides either tile, so neither is renamed and neither is warned about after the restart.
     */
    const h = buildController({ accessoryName: HYDRAWISE_CONTROLLER_FALLBACK_NAME, controller: { name: EMOJI_NAME },
      program: (recorder) => recorder.programDefault("statusschedule.php", { body: schedule(UNUSABLE_NAME), kind: "response" }),
      seedContext: (seed) => {

        setServiceName(seed.addService(Service.IrrigationSystem, HYDRAWISE_CONTROLLER_FALLBACK_NAME), HYDRAWISE_CONTROLLER_FALLBACK_NAME);
        seedNamedValve(HOME_APP_NAME)(seed);
      }, signalAborted: false, userOptions: ["Disable.Device.SyncName"] });

    t.after(() => h.abort());

    const valve = await valveOf(h);

    h.accessory.clearObservations();

    await pollPast(h);
    await h.abort();

    assert.deepEqual(nameChanges(h, valve), [], "no pass renames the valve");
    assert.equal(nameOf(valve), HOME_APP_NAME, "so the name the Home app gave it stands");
    assert.equal(nameOf(irrigationOf(h)), HYDRAWISE_CONTROLLER_FALLBACK_NAME, "and the controller keeps the name it came back with");
    assert.equal(logCount(h.entries, "warn", "HomeKit cannot use"), 0, "and neither tile is warned about");
  });

  test("with synchronization disabled, a controller and a zone created under their words are each warned about once", async (t) => {

    // Creation names a service once with synchronization off, so creation is the one pass that decides each tile's warning.
    const h = buildController({ accessoryName: HYDRAWISE_CONTROLLER_FALLBACK_NAME, controller: { name: EMOJI_NAME },
      program: (recorder) => recorder.programDefault("statusschedule.php", { body: schedule(UNUSABLE_NAME), kind: "response" }), signalAborted: false,
      userOptions: ["Disable.Device.SyncName"] });

    t.after(() => h.abort());

    const valve = await valveOf(h);

    await pollPast(h);
    await h.abort();

    assert.equal(nameOf(irrigationOf(h)), HYDRAWISE_CONTROLLER_FALLBACK_NAME, "the irrigation system is created under the controller word");
    assert.equal(nameOf(valve), ZONE_FALLBACK_NAME, "and the valve under the zone word and number");
    assert.equal(logCount(h.entries, "warn", CONTROLLER_FALLBACK_WARNING), 1, "the controller is warned about once");
    assert.equal(logCount(h.entries, "warn", ZONE_FALLBACK_WARNING), 1, "and so is the zone");
  });

  test("a controller and a zone Hydrawise names by the kind's word carry those names as their own and draw no warning", async (t) => {

    // The warning reads the composer's source rather than comparing the name with the word, so a zone named "Zone 1" at relay 1 is no fallback at all.
    const h = buildController({ controller: { name: HYDRAWISE_CONTROLLER_FALLBACK_NAME },
      program: (recorder) => recorder.programDefault("statusschedule.php", { body: schedule(ZONE_FALLBACK_NAME), kind: "response" }), signalAborted: false });

    t.after(() => h.abort());

    const valve = await valveOf(h);

    await pollPast(h);
    await h.abort();

    assert.equal(nameOf(irrigationOf(h)), HYDRAWISE_CONTROLLER_FALLBACK_NAME, "the controller carries the name Hydrawise reports");
    assert.equal(nameOf(valve), ZONE_FALLBACK_NAME, "and so does the zone");
    assert.equal(logCount(h.entries, "warn", "HomeKit cannot use"), 0, "and neither is warned about");
  });

  test("a Name HomeKit cannot carry yields to the reported name, the suspend-all switch composing its own from it", async (t) => {

    // A Name of emoji alone counts as no Name at all, so creation and every pass after it name each surface as if the user had set none.
    const h = buildController({ program: (recorder) => recorder.programDefault("statusschedule.php", { body: schedule(WIRE_NAME), kind: "response" }),
      signalAborted: false, userOptions: [ "Enable.Device.Name." + CONTROLLER_SERIAL + "=" + EMOJI_NAME, "Enable.Device.Name." + ZONE_SUBTYPE + "=" + EMOJI_NAME,
        "Enable.Device.Suspend.All" ] });

    t.after(() => h.abort());

    assert.equal(nameOf(irrigationOf(h)), CONTROLLER_WIRE_NAME, "the irrigation system is created under the name Hydrawise reports");
    assert.equal(nameOf(suspendSwitchOf(h)), CONTROLLER_WIRE_NAME + SUSPEND_ALL_SUFFIX, "and the switch is created as that name with its suffix");

    const valve = await valveOf(h);

    await pollPast(h);
    await h.abort();

    assert.equal(nameOf(valve), WIRE_NAME, "the valve takes the name Hydrawise reports for the zone");
    assert.equal(h.accessory.displayName, CONTROLLER_WIRE_NAME, "and the accessory keeps the controller's");
    assert.equal(logCount(h.entries, "warn", "HomeKit cannot use"), 0, "and nothing is named by its word, so nothing is warned about");
  });

  test("with synchronization disabled, a zone Name HomeKit cannot carry leaves a rename made in the Home app standing on the valve and its switch", async (t) => {

    // A Name HomeKit cannot carry holds no name gate, so with synchronization off nothing writes over the user's own name on either surface.
    const h = buildController({ hasV2Client: true,
      program: (recorder) => recorder.programDefault("statusschedule.php", { body: schedule(WIRE_NAME), kind: "response" }), signalAborted: false,
      userOptions: [ "Disable.Device.SyncName", "Enable.Device.Name." + ZONE_SUBTYPE + "=" + EMOJI_NAME, "Enable.Device.Suspend.Zone." + CONTROLLER_SERIAL ] });

    t.after(() => h.abort());

    const valve = await valveOf(h);
    const zoneSwitch = await waitFor(() => h.accessory.getServiceById(Service.Switch, ZONE_SUSPEND_SUBTYPE), { description: "the zone suspension switch to appear" });

    await pollPast(h);

    assert.equal(nameOf(valve), WIRE_NAME, "the valve is created under the name Hydrawise reports");
    assert.equal(nameOf(zoneSwitch), WIRE_NAME + ZONE_SUSPEND_SUFFIX, "and its switch under that name with its suffix");

    for(const service of [ valve, zoneSwitch ]) {

      // eslint-disable-next-line no-await-in-loop
      await triggerSet(service.getCharacteristic(Characteristic.ConfiguredName), HOME_APP_NAME);
    }

    await pollPast(h);
    await pollPast(h);
    await h.abort();

    assert.equal(nameOf(valve), HOME_APP_NAME, "the valve keeps the Home app's name");
    assert.equal(nameOf(zoneSwitch), HOME_APP_NAME, "and so does its companion switch");
  });
});
