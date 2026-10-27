/* Copyright(C) 2017-2026, HJD (https://github.com/hjdhjd). All rights reserved.
 *
 * controller.suspension.test.ts: The per-zone suspension switches - where they exist, where they must not, what they show, and what a tap on one does. Covers the
 * creation gate and the subtype the sweep depends on, the name resynchronization a zone rename drives, the optimistic command and its revert, the command guard
 * that keeps a snapshot older than the user's own tap from undoing it, the account-wide command's per-zone stamp, and the subtype-scoped sweep that must never
 * touch the account-wide switch it shares a service type with. It also covers how a suspension command composes at once into the persisted schedule projection,
 * the MQTT payload, and the log line, including the window a running zone's honest projection holds open against an accepted command and a restart's carried
 * suspension reconciling against the first fresh facts to arrive.
 *
 * Every command but one runs against the platform double's recording suspension surface, so most of this file never reaches the account API or its client - the
 * client's own admission and transport behavior is asserted in its own suite, and what these tests assert is the projection above it. The one exception drives a real
 * account-credentialed client over a mocked transport, proving that a transport failure produces exactly one sentence for the user across every layer that could
 * have spoken about it.
 */

// The Hydrawise API wire shapes use snake_case keys such as relay_id, so camelcase is disabled here to let the zone fixtures mirror the wire verbatim.
/* eslint-disable camelcase */
import { Characteristic, Service, buildController, makeV2Facts, makeZoneV2Facts, pollsCompleted, seedEstablished, waitFor } from "./testing/platform.helpers.ts";
import { HAPStatus, RateBudget, getServiceName } from "homebridge-plugin-utils";
import { HYDRAWISE_ACTIVE_ZONE_INDICATOR, HYDRAWISE_SUSPEND_DURATION, HYDRAWISE_V2_BUDGET_CALLS, HYDRAWISE_V2_BUDGET_WINDOW, HYDRAWISE_V2_FACTS_TTL,
  HYDRAWISE_V2_GRAPH_ENDPOINT, HYDRAWISE_V2_MUTATION_BUDGET_CALLS, HYDRAWISE_V2_MUTATION_BUDGET_WINDOW, HYDRAWISE_V2_TOKEN_ENDPOINT } from "./settings.ts";
import { HYDRAWISE_RAIN_SENSOR_TYPE, scheduleStatus, suspendZoneSubtype, zoneIdentity } from "./types.ts";
import type { Service as HapService, PlatformAccessory } from "homebridge";
import type { HydrawiseAccessoryContext, HydrawiseZoneConfig, HydrawiseZoneScheduleStatus, HydrawiseZoneV2Facts,
  StatusScheduleResponse } from "./types.ts";
import { TestClock, advanceThroughSchedule, hapStatus, logCount, loggedAt, triggerGet, triggerSet, waitUntil } from "homebridge-plugin-utils/testing";
import { UNSCHEDULED_SENTINEL, bareSensors } from "./api.fixtures.ts";
import { describe, test } from "node:test";
import { fastPolling, makeStatusSchedule, makeZone } from "./api.helpers.ts";
import type { BuildControllerResult } from "./testing/platform.helpers.ts";
import { HydrawiseV2Client } from "./v2.ts";
import { MockAgent } from "undici";
import assert from "node:assert/strict";

const CONTROLLER_SERIAL = "SN0A1B2C3D4";
const ALPHA_RELAY_ID = 700001;
const BETA_RELAY_ID = 700002;
const ALPHA_VALVE_SUBTYPE = "700001";

/* The composed subtypes, written as LITERALS rather than through the composer. The composer is production's single home for this shape, so a test that called it
 * would agree with any shape it ever produced; the literal is what locks in the shape itself - and it is what a cached accessory in the field carries, so changing it
 * silently orphans every switch already published.
 */
const ALPHA_SWITCH_SUBTYPE = "Suspend.700001";

const BETA_SWITCH_SUBTYPE = "Suspend.700002";

// The account-wide switch's own subtype, which shares the Switch service type with the two above and must survive their sweep.
const SUSPEND_ALL_SUBTYPE = "All";

// The option entries each scenario names. The per-zone switches are enabled at the CONTROLLER scope here, which the engine resolves for every zone beneath it.
const SUSPEND_ZONE_ON = "Enable.Device.Suspend.Zone." + CONTROLLER_SERIAL;

const SUSPEND_ALL_ON = "Enable.Device.Suspend.All." + CONTROLLER_SERIAL;

const STANDALONE_ON = "Enable.Device.Standalone." + ALPHA_VALVE_SUBTYPE;

const BETA_DISABLED = "Disable.Device." + BETA_RELAY_ID.toString();

// A far-future suspension instant, in the shape the account API reports one.
const SUSPENDED_UNTIL = 1903928399;

// The reason a refused command carries back, which the controller's one sentence has to name.
const REFUSAL_SUMMARY = "Hydrawise refused this one.";

// The refusal HomeKit renders as No Response: HAP's communication-failure status from a deliberate refusal, which the matcher tells apart from a handler that
// faulted into the same status.
const noResponse = hapStatus(HAPStatus.SERVICE_COMMUNICATION_FAILURE);

// The v2 origin and paths the real client used by the combined-layers assertion below targets, derived from the endpoint constants exactly as the client derives its own.
const V2_ORIGIN = new URL(HYDRAWISE_V2_GRAPH_ENDPOINT).origin;

const GRAPH_PATH = new URL(HYDRAWISE_V2_GRAPH_ENDPOINT).pathname;

const TOKEN_PATH = new URL(HYDRAWISE_V2_TOKEN_ENDPOINT).pathname;

// A successful token grant, shaped as the live capture recorded it, so the command under test gets past the token chokepoint and reaches the transport.
const TOKEN_BODY = { access_token: "access-one", expires_in: 3600, refresh_token: "refresh-one" };

/* The zone under test, carrying the unscheduled sentinel shape. That shape is the one body the key-based wire cannot read further, so it is the only shape the
 * account API's suspension FACTS can classify - the facts arm sits inside the branch that owns it, and a running or scheduled zone answers from the wire there.
 *
 * A standing COMMAND is a different matter and reaches every shape below, which is the whole point of it: the account has just accepted the command and the poll
 * snapshot in hand predates it, so a zone still reporting a live schedule is exactly the case that needs answering. The scheduled and running fixtures below are
 * what put that under test, since a scenario built only on this shape would pass without ever exercising it.
 */
function alphaZone(overrides: Partial<HydrawiseZoneConfig> = {}): HydrawiseZoneConfig {

  return makeZone({ name: "Alpha", relay: 1, relay_id: ALPHA_RELAY_ID, run: 0, time: UNSCHEDULED_SENTINEL, timestr: "", ...overrides });
}

// A second zone in the same shape, so a scenario can turn one zone off while the projection stays non-empty.
function betaZone(overrides: Partial<HydrawiseZoneConfig> = {}): HydrawiseZoneConfig {

  return makeZone({ name: "Bravo", relay: 2, relay_id: BETA_RELAY_ID, run: 0, time: UNSCHEDULED_SENTINEL, timestr: "", ...overrides });
}

// The same zone carrying a LIVE SCHEDULE - a real countdown and a real duration - which is the shape a command has to reach past the wire to classify. It runs
// well beyond the active-zone window so a poll settles it without also driving a start transition.
function scheduledZone(overrides: Partial<HydrawiseZoneConfig> = {}): HydrawiseZoneConfig {

  return makeZone({ name: "Alpha", relay: 1, relay_id: ALPHA_RELAY_ID, run: 480, time: 68000, timestr: "16:00", ...overrides });
}

// The same zone RUNNING, which is the one reading no command overrules: water demonstrably flowing outranks an account's acceptance of anything.
function runningZone(overrides: Partial<HydrawiseZoneConfig> = {}): HydrawiseZoneConfig {

  return makeZone({ name: "Alpha", relay: 1, relay_id: ALPHA_RELAY_ID, run: 600, time: 1, timestr: "", ...overrides });
}

// A second zone carrying a live schedule, so an account-wide scenario can act on a population the sentinel shape does not cover.
function scheduledBeta(overrides: Partial<HydrawiseZoneConfig> = {}): HydrawiseZoneConfig {

  return makeZone({ name: "Bravo", relay: 2, relay_id: BETA_RELAY_ID, run: 300, time: 69000, timestr: "16:08", ...overrides });
}

// A fast-cadence status body carrying the given zones and a sensor block covering nothing, so no zone classifies as sensor-stopped and the suspension arm is the
// only thing that can move a switch.
function schedule(zones: HydrawiseZoneConfig[]): StatusScheduleResponse {

  return fastPolling(makeStatusSchedule({ relays: zones, sensors: bareSensors }));
}

/* The same body at the WIRE-REALISTIC cadence, which puts the next poll a minute away. Every claim about what a COMMAND alone costs needs that: the poll cadence
 * publishes unconditionally and re-derives on its own account, so a poll landing between the command and the assertion would inflate every count being read for
 * reasons that have nothing to do with the command.
 */
function pacedSchedule(zones: HydrawiseZoneConfig[], sensors: StatusScheduleResponse["sensors"] = bareSensors): StatusScheduleResponse {

  return makeStatusSchedule({ relays: zones, sensors });
}

// A rain-class sensor block covering the named zones, so a scenario can put a standing resume up against a sensor that is evidently stopping its whole group.
function sensorsCovering(...ids: number[]): StatusScheduleResponse["sensors"] {

  return [{ input: 0, mode: 1, relays: ids.map(id => ({ id })), type: HYDRAWISE_RAIN_SENSOR_TYPE }];
}

// The persisted schedule projection, which is the store the webUI reads and the one every claim about immediate reflection is made against.
function projectionOf(h: BuildControllerResult): HydrawiseZoneScheduleStatus[] {

  return (h.accessory.context as HydrawiseAccessoryContext).schedule?.zones ?? [];
}

// One zone's entry in that projection.
function entryOf(h: BuildControllerResult, relayId = ALPHA_RELAY_ID): HydrawiseZoneScheduleStatus | undefined {

  return projectionOf(h).find(entry => entry.relayId === relayId);
}

// The current whole second, which is the unit every command stamp and every facts snapshot speaks.
function now(): number {

  return Math.floor(Date.now() / 1000);
}

/* Hand the controller one refresh tick's worth of facts, stating each zone's suspension and the instant the fetch that carried them was made.
 *
 * That instant is stated by every caller rather than defaulted, because every guard comparison in this suite turns on whether the fetch predates or postdates the
 * user's own command - and in a test they otherwise land in the same whole second, where a real refresh is a quarter of an hour away from one.
 */
function applyFacts(h: BuildControllerResult, suspended: Record<number, boolean>, fetchedAt: number): void {

  const zones = Object.entries(suspended).map(([ relayId, isSuspended ]): [ number, HydrawiseZoneV2Facts ] => {

    return [ Number(relayId), makeZoneV2Facts({ suspendedUntil: isSuspended ? SUSPENDED_UNTIL : null }) ];
  });

  h.controller.applyFacts({ facts: makeV2Facts({ zones }), fetchedAt });
}

// One zone's companion switch on a given accessory, or undefined when it has none there.
function suspendSwitch(accessory: PlatformAccessory, subtype = ALPHA_SWITCH_SUBTYPE): HapService | undefined {

  return accessory.getServiceById(Service.Switch, subtype);
}

// Whether the switch reads the zone as SUSPENDED, which is what its characteristic carries directly: the switch speaks its own name's language, so On means
// suspended, exactly as the account-wide suspend switch has always read.
function readsSuspended(accessory: PlatformAccessory, subtype = ALPHA_SWITCH_SUBTYPE): unknown {

  return suspendSwitch(accessory, subtype)?.getCharacteristic(Characteristic.On).value;
}

describe("HydrawiseController per-zone suspension switches", () => {

  test("the composed subtype is the shape every cached accessory in the field carries", () => {

    // Production's own composer, asserted against the literal the rest of this suite - and every accessory already published - depends on.
    assert.equal(suspendZoneSubtype(ALPHA_RELAY_ID), ALPHA_SWITCH_SUBTYPE, "a zone's switch subtype is the reserved prefix and its relay id");
    assert.notEqual(suspendZoneSubtype(ALPHA_RELAY_ID), ALPHA_VALVE_SUBTYPE, "and it cannot collide with the valve subtype the same zone already carries");
  });

  test("creates a companion switch beside the zone's valve, named for the zone", async (t) => {

    const h = buildController({ hasV2Client: true,
      program: (recorder) => recorder.programDefault("statusschedule.php", { body: schedule([alphaZone()]), kind: "response" }), signalAborted: false,
      userOptions: [SUSPEND_ZONE_ON] });

    t.after(() => h.abort());

    const service = await waitFor(() => suspendSwitch(h.accessory), { description: "Alpha's suspension switch to appear" });

    assert.equal(getServiceName(service), "Alpha Suspend", "the switch takes the zone's effective name and the suspend suffix");
    assert.ok(h.accessory.getServiceById(Service.Valve, ALPHA_VALVE_SUBTYPE), "and it sits beside the valve rather than replacing it");

    // ON means the zone is suspended, so an unsuspended zone reads off. The assertion that this one cannot make - a switch established on an ALREADY suspended zone,
    // where HAP's own default would be the wrong answer rather than accidentally the right one - is driven separately below.
    assert.equal(readsSuspended(h.accessory), false, "a zone under no suspension reads as unsuspended");

    // HAP builds On at false, so only the change record tells the establishment's own write from HAP's default.
    assert.ok(h.accessory.changesOn(service, Characteristic.On).some(change => change.newValue === false), "the walk writes the switch's starting state itself");
    assert.ok(loggedAt(h.entries, "info", "Per-zone suspension switches enabled."), "the enabled feature is reported once at the startup grain");
  });

  test("a companion switch attached to a restored accessory, and one removed from it, is each the only save of its poll", async (t) => {

    /* Each switch change measured where nothing else can stand in for it. Each accessory comes back from the cache carrying a context and a valve that already
     * match the first poll, so the switch the option adds to the first, and the one its absence sweeps from the second, is each the only thing that marks its
     * accessory.
     */
    const seedRestored = (accessory: PlatformAccessory): void => {

      accessory.context = { schedule: scheduleStatus(schedule([scheduledZone()]), HYDRAWISE_ACTIVE_ZONE_INDICATOR), zones: [zoneIdentity(scheduledZone())] };
      seedEstablished({ accessory, zones: [scheduledZone()] });
    };

    const attached = buildController({ hasV2Client: true, program: (recorder) => recorder.programDefault("statusschedule.php",
      { body: schedule([scheduledZone()]), kind: "response" }), seedContext: seedRestored, signalAborted: false, userOptions: [SUSPEND_ZONE_ON] });
    const removed = buildController({ hasV2Client: true, program: (recorder) => recorder.programDefault("statusschedule.php",
      { body: schedule([scheduledZone()]), kind: "response" }), seedContext: (accessory) => {

      seedRestored(accessory);
      accessory.addService(new Service.Switch("Alpha Suspend", ALPHA_SWITCH_SUBTYPE));
    }, signalAborted: false });

    t.after(() => {

      attached.abort();
      removed.abort();
    });

    await pollsCompleted(attached, 3);
    await pollsCompleted(removed, 3);
    attached.abort();
    removed.abort();

    assert.ok(suspendSwitch(attached.accessory), "the option attaches the switch");
    assert.equal(attached.flushes().length, 1, "and the attach saves the accessory once, the polls after it saving nothing");
    assert.equal(suspendSwitch(removed.accessory), undefined, "the switch the option does not want is swept");
    assert.equal(removed.flushes().length, 1, "and the removal saves the accessory once, the polls after it saving nothing");
  });

  test("a switch established on an already-suspended zone starts ON", async (t) => {

    /* The establishment write's own assertion, and the one the common case cannot make: an unsuspended zone's answer happens to coincide with HAP's own default for a
     * fresh characteristic, so a walk that wrote nothing at all would pass it. Here the answer is the opposite of that default, so only a real write satisfies it.
     *
     * The zone is brought in on a LATER poll, after facts have landed, because that is the only way a switch is first established with a classified suspension
     * already in hand - on the very first poll there are no facts yet for any zone.
     */
    const h = buildController({ hasV2Client: true, program: (recorder) => {

      recorder.program("statusschedule.php", { body: schedule([alphaZone()]), kind: "response" });
      recorder.programDefault("statusschedule.php", { body: schedule([ alphaZone(), betaZone() ]), kind: "response" });
    }, signalAborted: false, userOptions: [SUSPEND_ZONE_ON] });

    t.after(() => h.abort());

    await waitUntil(() => suspendSwitch(h.accessory) !== undefined, { description: "Alpha's suspension switch to appear" });

    applyFacts(h, { [ALPHA_RELAY_ID]: false, [BETA_RELAY_ID]: true }, now());

    const beta = await waitFor(() => suspendSwitch(h.accessory, BETA_SWITCH_SUBTYPE), { description: "Beta's suspension switch to appear" });

    assert.equal(beta.getCharacteristic(Characteristic.On).value, true, "a zone the account reports suspended shows its switch on the moment it is established");
    assert.equal(readsSuspended(h.accessory), false, "while its unsuspended sibling reads the other way");
  });

  test("creates none when the option is off", async (t) => {

    const h = buildController({ hasV2Client: true,
      program: (recorder) => recorder.programDefault("statusschedule.php", { body: schedule([alphaZone()]), kind: "response" }), signalAborted: false });

    t.after(() => h.abort());

    await waitUntil(() => h.accessory.getServiceById(Service.Valve, ALPHA_VALVE_SUBTYPE) !== undefined, { description: "Alpha's valve to appear" });
    await pollsCompleted(h, 2);

    assert.equal(suspendSwitch(h.accessory), undefined, "the default-off option publishes no switch at all");
    assert.equal(h.suspensions.length, 0, "and nothing can command a suspension");
    assert.ok(!loggedAt(h.entries, "info", "Per-zone suspension switches"), "a default left alone says nothing at startup");
  });

  test("creates none on an install without account credentials, however the option is set", async (t) => {

    /* The parity floor. The key-based API has no per-zone suspend to offer - its one suspend command carries no zone parameter and acts on the whole controller -
     * so a switch here would render and resolve while doing something else entirely, which is the trap the option exists to avoid rather than to walk into.
     */
    const h = buildController({ program: (recorder) => recorder.programDefault("statusschedule.php", { body: schedule([alphaZone()]), kind: "response" }),
      signalAborted: false, userOptions: [SUSPEND_ZONE_ON] });

    t.after(() => h.abort());

    await waitUntil(() => h.accessory.getServiceById(Service.Valve, ALPHA_VALVE_SUBTYPE) !== undefined, { description: "Alpha's valve to appear" });
    await pollsCompleted(h, 2);

    assert.equal(suspendSwitch(h.accessory), undefined, "an install with only an API key publishes no per-zone switch");
    assert.ok(!loggedAt(h.entries, "info", "Per-zone suspension switches"), "and never mentions a feature it cannot offer");
  });

  test("the switch follows the zone's suspension across refresh ticks", async (t) => {

    const h = buildController({ hasV2Client: true,
      program: (recorder) => recorder.programDefault("statusschedule.php", { body: schedule([alphaZone()]), kind: "response" }), signalAborted: false,
      userOptions: [SUSPEND_ZONE_ON] });

    t.after(() => h.abort());

    await waitUntil(() => suspendSwitch(h.accessory) !== undefined, { description: "Alpha's suspension switch to appear" });

    /* A suspension is a fact only the account API reports, so it arrives on the REFRESH cadence rather than on a poll. The switch has to move with it, which is
     * what the shared projection tail is for: a switch refreshed only by the walk would sit wrong for up to a full poll after a suspension landed.
     */
    applyFacts(h, { [ALPHA_RELAY_ID]: true }, now());

    assert.equal(readsSuspended(h.accessory), true, "a refresh reporting the zone suspended turns the switch on");

    applyFacts(h, { [ALPHA_RELAY_ID]: false }, now());

    assert.equal(readsSuspended(h.accessory), false, "and a refresh reporting the suspension lifted turns it back off");
  });

  test("the switch's name follows a zone renamed on the wire", async (t) => {

    const h = buildController({ hasV2Client: true, program: (recorder) => {

      recorder.program("statusschedule.php", { body: schedule([alphaZone()]), kind: "response" });
      recorder.programDefault("statusschedule.php", { body: schedule([alphaZone({ name: "Alpha North" })]), kind: "response" });
    }, signalAborted: false, userOptions: [SUSPEND_ZONE_ON] });

    t.after(() => h.abort());

    // A rename must reach the companion, not just the valve. Naming the switch once at creation would leave it wearing a stale name for the life of the accessory.
    await waitUntil(() => getServiceName(suspendSwitch(h.accessory)) === "Alpha North Suspend",
      { description: "Alpha's suspension switch to take the renamed zone's name" });
    assert.equal(getServiceName(h.accessory.getServiceById(Service.Valve, ALPHA_VALVE_SUBTYPE)), "Alpha North", "the valve moved with it");
  });
});

describe("HydrawiseController per-zone suspension commands", () => {

  test("turning the switch on suspends the zone for the account-wide duration", async (t) => {

    const h = buildController({ hasV2Client: true,
      program: (recorder) => recorder.programDefault("statusschedule.php", { body: schedule([alphaZone()]), kind: "response" }), signalAborted: false,
      userOptions: [SUSPEND_ZONE_ON] });

    t.after(() => h.abort());

    const service = await waitFor(() => suspendSwitch(h.accessory), { description: "Alpha's suspension switch to appear" });
    const before = now();

    await triggerSet(service.getCharacteristic(Characteristic.On), true);

    const after = now();

    assert.equal(h.suspensions.length, 1, "one tap sends exactly one command");
    assert.equal(h.suspensions[0]?.zoneId, ALPHA_RELAY_ID, "and it names the zone the switch belongs to");

    // The horizon is the account-wide suspend's own constant, bracketed by whole-second reads either side of the tap. One convention, one constant, both grains.
    const until = h.suspensions[0].until ?? 0;

    assert.ok((until >= (before + HYDRAWISE_SUSPEND_DURATION)) && (until <= (after + HYDRAWISE_SUSPEND_DURATION)),
      "the suspension runs to the same one-year horizon the account-wide suspend uses");
    assert.equal(readsSuspended(h.accessory), true, "and the switch holds the state the user just chose");
  });

  test("turning the switch off resumes the zone, carrying no instant at all", async (t) => {

    const h = buildController({ hasV2Client: true,
      program: (recorder) => recorder.programDefault("statusschedule.php", { body: schedule([alphaZone()]), kind: "response" }), signalAborted: false,
      userOptions: [SUSPEND_ZONE_ON] });

    t.after(() => h.abort());

    const service = await waitFor(() => suspendSwitch(h.accessory), { description: "Alpha's suspension switch to appear" });

    applyFacts(h, { [ALPHA_RELAY_ID]: true }, now());

    await triggerSet(service.getCharacteristic(Characteristic.On), false);

    // A null instant is what composes the resume rather than a suspension to some instant in the past, which is the shape the two commands are told apart by.
    assert.deepEqual(h.suspensions, [{ until: null, zoneId: ALPHA_RELAY_ID }], "a resume names the zone and no instant");
  });

  test("N accepted flips send exactly N commands", async (t) => {

    const h = buildController({ hasV2Client: true,
      program: (recorder) => recorder.programDefault("statusschedule.php", { body: schedule([alphaZone()]), kind: "response" }), signalAborted: false,
      userOptions: [SUSPEND_ZONE_ON] });

    t.after(() => h.abort());

    const service = await waitFor(() => suspendSwitch(h.accessory), { description: "Alpha's suspension switch to appear" });

    for(const value of [ true, false, true, false ]) {

      // eslint-disable-next-line no-await-in-loop
      await triggerSet(service.getCharacteristic(Characteristic.On), value);
    }

    /* BOTH bounds, by strict equality. The upper bound catches a handler that retried or read back after commanding; the lower catches one that coalesced a burst
     * into fewer commands than the user made, which is the queue-and-batch shape the design deliberately rejected.
     */
    assert.equal(h.suspensions.length, 4, "four taps are four commands, neither dropped nor doubled");
  });

  test("a refused command reverts the switch and says why, exactly once", async (t) => {

    const h = buildController({ hasV2Client: true,
      program: (recorder) => recorder.programDefault("statusschedule.php", { body: schedule([alphaZone()]), kind: "response" }), signalAborted: false,
      suspensionResult: { reason: REFUSAL_SUMMARY, status: "failed" }, userOptions: [SUSPEND_ZONE_ON] });

    t.after(() => h.abort());

    const service = await waitFor(() => suspendSwitch(h.accessory), { description: "Alpha's suspension switch to appear" });

    await triggerSet(service.getCharacteristic(Characteristic.On), true);
    await waitUntil(() => readsSuspended(h.accessory) === false, { description: "Alpha's suspension switch to read not suspended" });

    assert.equal(readsSuspended(h.accessory), false, "a command the account refused puts the switch back where it was");
    assert.ok(loggedAt(h.entries, "error", "Alpha [Zone 1]: Unable to suspend this zone. " + REFUSAL_SUMMARY),
      "and the one sentence names the zone and what the account said");

    /* The one-voice assertion. The layers below this one carry their outcome in a value rather than in a line, so a user reads exactly one sentence about a command they
     * made - the one written by the layer that knows which zone they touched.
     */
    assert.equal(h.entries.filter(line => line.level === "error").length, 1, "a refused command produces exactly one error line");
  });

  test("a command the ceiling would not admit reverts with the pacing sentence rather than the account's", async (t) => {

    const h = buildController({ hasV2Client: true,
      program: (recorder) => recorder.programDefault("statusschedule.php", { body: schedule([alphaZone()]), kind: "response" }), signalAborted: false,
      suspensionResult: { status: "rejected" }, userOptions: [SUSPEND_ZONE_ON] });

    t.after(() => h.abort());

    const service = await waitFor(() => suspendSwitch(h.accessory), { description: "Alpha's suspension switch to appear" });

    await triggerSet(service.getCharacteristic(Characteristic.On), true);
    await waitUntil(() => readsSuspended(h.accessory) === false, { description: "Alpha's suspension switch to read not suspended" });

    /* Reject-with-feedback, made legible. These two refusals ask the user for different things - wait a moment, against look at your account - so they must not
     * share a sentence, and a user who sees the pacing one knows their command was never sent.
     */
    assert.ok(loggedAt(h.entries, "error", "Alpha [Zone 1]: Unable to suspend this zone. The Hydrawise account API is pacing requests"),
      "a paced refusal says so, and asks for a moment rather than blaming the account");
    assert.ok(!loggedAt(h.entries, "error", REFUSAL_SUMMARY), "and it carries no summary, because no command reached the account to produce one");
    assert.equal(h.entries.filter(line => line.level === "error").length, 1, "a rejected command likewise produces exactly one error line");
  });

  test("a transport failure is narrated ONCE across every layer that saw it", async (t) => {

    /* The combined-layers assertion, and the one a per-layer suite structurally cannot write. Below the controller sits a REAL account-credentialed client over a mocked
     * transport, and every layer writes into one capture buffer, so what is counted here is every voice that could speak about one failed command.
     *
     * Both transport failure shapes are driven, because they classify in different places: a non-2xx status is read off the response, while a GraphQL errors array
     * arrives inside a clean HTTP 200 that no status check can see. Either way one command that did not take is ONE sentence for the user, carrying the reason and
     * naming the zone - and the switch goes back to where it was.
     */
    const shapes = [ { body: { message: "Bad Gateway" }, expected: "The Hydrawise API answered with status 502.", label: "a refused transport", status: 502 },
      { body: { errors: [{ message: "Cannot query field" }] }, expected: "Cannot query field.", label: "a GraphQL errors array", status: 200 } ];

    for(const shape of shapes) {

      const signal = new AbortController();
      const agent = Object.assign(new MockAgent(), { destroy: async (): Promise<void> => { await agent.close(); } });

      agent.disableNetConnect();
      agent.get(V2_ORIGIN).intercept({ method: "POST", path: TOKEN_PATH }).reply(200, (): object => TOKEN_BODY).persist();
      agent.get(V2_ORIGIN).intercept({ method: "POST", path: GRAPH_PATH }).reply(shape.status, (): object => shape.body).persist();

      const h = buildController({ hasV2Client: true,
        program: (recorder) => recorder.programDefault("statusschedule.php", { body: schedule([alphaZone()]), kind: "response" }), signalAborted: false,
        suspensionClient: (log) => new HydrawiseV2Client({ budget: new RateBudget({ capacity: HYDRAWISE_V2_BUDGET_CALLS, signal: signal.signal,
          window: HYDRAWISE_V2_BUDGET_WINDOW * 1000 }), dispatcherFactory: (): MockAgent => agent, log,
        mutationBudget: new RateBudget({ capacity: HYDRAWISE_V2_MUTATION_BUDGET_CALLS, signal: signal.signal,
          window: HYDRAWISE_V2_MUTATION_BUDGET_WINDOW * 1000 }), password: "test-password", signal: signal.signal,
        username: "test-user" }), userOptions: [SUSPEND_ZONE_ON] });

      t.after(() => { h.abort(); signal.abort("test-teardown"); });

      // eslint-disable-next-line no-await-in-loop
      const service = await waitFor(() => suspendSwitch(h.accessory), { description: "Alpha's suspension switch to appear" });

      // eslint-disable-next-line no-await-in-loop
      await triggerSet(service.getCharacteristic(Characteristic.On), true);

      // eslint-disable-next-line no-await-in-loop
      await waitUntil(() => readsSuspended(h.accessory) === false, { description: "Alpha's suspension switch to read not suspended" });

      const errors = h.entries.filter(line => line.level === "error");

      assert.equal(errors.length, 1, shape.label + " produces exactly one error line across the client and the controller");
      assert.ok(loggedAt(h.entries, "error", "Alpha [Zone 1]: Unable to suspend this zone. " + shape.expected),
        "and that line names the zone the user touched and the reason the command did not take");
      assert.equal(readsSuspended(h.accessory), false, "with the switch put back where it was");
    }
  });

  test("a command that finds no account client at all says what is missing", async (t) => {

    /* The missing-client answer, which no LIVE switch can produce: the switches exist only where a client does, and that is fixed at construction. Its sentence is
     * asserted here all the same, because the handler answers to every outcome the surface declares - and an unnamed one would compile into a switch reverting in
     * silence.
     */
    const h = buildController({ hasV2Client: true,
      program: (recorder) => recorder.programDefault("statusschedule.php", { body: schedule([alphaZone()]), kind: "response" }), signalAborted: false,
      suspensionResult: { status: "unavailable" }, userOptions: [SUSPEND_ZONE_ON] });

    t.after(() => h.abort());

    const service = await waitFor(() => suspendSwitch(h.accessory), { description: "Alpha's suspension switch to appear" });

    await triggerSet(service.getCharacteristic(Characteristic.On), true);
    await waitUntil(() => readsSuspended(h.accessory) === false, { description: "Alpha's suspension switch to read not suspended" });

    assert.ok(loggedAt(h.entries, "error", "Alpha [Zone 1]: Unable to suspend this zone. Enhanced features are not configured."),
      "the sentence names the configuration the command needed rather than blaming the account");
  });

  test("a command torn down by shutdown reverts nothing and says nothing", async (t) => {

    const h = buildController({ hasV2Client: true,
      program: (recorder) => recorder.programDefault("statusschedule.php", { body: schedule([alphaZone()]), kind: "response" }), signalAborted: false,
      suspensionResult: { status: "rejected" }, userOptions: [SUSPEND_ZONE_ON] });

    t.after(() => h.abort());

    const service = await waitFor(() => suspendSwitch(h.accessory), { description: "Alpha's suspension switch to appear" });

    h.abort();

    await triggerSet(service.getCharacteristic(Characteristic.On), true);

    // Orderly teardown is not a refusal. A shutdown that narrated one would put an error in the log of every restart a user performs.
    assert.equal(h.entries.filter(line => line.level === "error").length, 0, "a shutdown reaching a command in flight reports nothing");
  });
});

describe("HydrawiseController per-zone suspension command guard", () => {

  test("a snapshot older than the user's own command cannot undo it, and a newer one does", async (t) => {

    const h = buildController({ hasV2Client: true,
      program: (recorder) => recorder.programDefault("statusschedule.php", { body: schedule([alphaZone()]), kind: "response" }), signalAborted: false,
      userOptions: [SUSPEND_ZONE_ON] });

    t.after(() => h.abort());

    const service = await waitFor(() => suspendSwitch(h.accessory), { description: "Alpha's suspension switch to appear" });

    await triggerSet(service.getCharacteristic(Characteristic.On), true);

    /* A fetch already in flight when the user tapped knows nothing about their command. Letting it answer would flip the switch straight back under their finger,
     * which is the whole reason the guard exists.
     */
    applyFacts(h, { [ALPHA_RELAY_ID]: false }, now() - 5);

    assert.equal(readsSuspended(h.accessory), true, "an older snapshot leaves the command standing");

    /* The tie, which every real refresh is a quarter of an hour away from and which a test lands on by default. Both instants are whole seconds, so a fetch stamped
     * in the same second as the command could have been dispatched either side of it: the tie goes to the user, whose command holds for one more refresh rather
     * than being undone by a snapshot that may well predate it.
     */
    applyFacts(h, { [ALPHA_RELAY_ID]: false }, now());

    assert.equal(readsSuspended(h.accessory), true, "a snapshot from the command's own second does not outrank it");

    /* The other direction, and the half a never-clearing guard would fail: facts that genuinely POSTDATE the command are the account's own confirmation - or
     * correction - and they take over. A guard that never retired an entry would hold this switch off for the life of the process.
     */
    applyFacts(h, { [ALPHA_RELAY_ID]: false }, now() + 2);

    assert.equal(readsSuspended(h.accessory), false, "and a snapshot that postdates it retires the command and shows what the account says");
  });

  test("the guard carries WHICH WAY the command went, not merely that one happened", async (t) => {

    const h = buildController({ hasV2Client: true,
      program: (recorder) => recorder.programDefault("statusschedule.php", { body: schedule([alphaZone()]), kind: "response" }), signalAborted: false,
      userOptions: [SUSPEND_ZONE_ON] });

    t.after(() => h.abort());

    const service = await waitFor(() => suspendSwitch(h.accessory), { description: "Alpha's suspension switch to appear" });

    // Start from a suspended zone, so the classification and the command disagree and only the command's DIRECTION can produce the right answer.
    applyFacts(h, { [ALPHA_RELAY_ID]: true }, now());
    assert.equal(readsSuspended(h.accessory), true, "the zone starts out suspended");

    await triggerSet(service.getCharacteristic(Characteristic.On), false);

    applyFacts(h, { [ALPHA_RELAY_ID]: true }, now() - 5);

    /* A guard holding only a timestamp would fall through to the classification here and render the zone suspended again - the very state the user just commanded
     * their way out of. Carrying the commanded direction is what makes the optimistic display honest in both directions.
     */
    assert.equal(readsSuspended(h.accessory), false, "a resume renders unsuspended against an older snapshot that still says otherwise");
  });

  test("a command the account refused stamps nothing", async (t) => {

    const h = buildController({ hasV2Client: true,
      program: (recorder) => recorder.programDefault("statusschedule.php", { body: schedule([alphaZone()]), kind: "response" }), signalAborted: false,
      suspensionResult: { reason: REFUSAL_SUMMARY, status: "failed" }, userOptions: [SUSPEND_ZONE_ON] });

    t.after(() => h.abort());

    const service = await waitFor(() => suspendSwitch(h.accessory), { description: "Alpha's suspension switch to appear" });

    await triggerSet(service.getCharacteristic(Characteristic.On), true);
    await waitUntil(() => readsSuspended(h.accessory) === false, { description: "Alpha's suspension switch to read not suspended" });

    /* The snapshot below is OLDER than the tap, so a guard entry stamped by the failed command would stand and render the zone suspended. Nothing was commanded in
     * the end, so nothing may claim to have been: the account's own answer is the only thing left to show.
     */
    applyFacts(h, { [ALPHA_RELAY_ID]: false }, now() - 5);

    assert.equal(readsSuspended(h.accessory), false, "a refused command leaves the display answering to the account alone");
  });

  test("a standing command survives the facts aging out from under it", async (t) => {

    const h = buildController({ hasV2Client: true,
      program: (recorder) => recorder.programDefault("statusschedule.php", { body: schedule([alphaZone()]), kind: "response" }), signalAborted: false,
      userOptions: [SUSPEND_ZONE_ON] });

    t.after(() => h.abort());

    const service = await waitFor(() => suspendSwitch(h.accessory), { description: "Alpha's suspension switch to appear" });

    await triggerSet(service.getCharacteristic(Characteristic.On), true);

    /* No trustworthy snapshot at all - none ever arrived, the last aged out, or the refresh has stalled. Nothing newer has contradicted the user, so their own
     * command is the honest thing to display; treating "we cannot tell" as "not suspended" would silently undo a command the account accepted.
     */
    applyFacts(h, { [ALPHA_RELAY_ID]: false }, now() - (HYDRAWISE_V2_FACTS_TTL + 1));

    assert.equal(readsSuspended(h.accessory), true, "an expired snapshot supersedes nothing, so the command stands");
  });

  test("an account-wide command stamps every zone the WIRE reported, enabled or not", async (t) => {

    /* The source assertion. The account-wide command has to stamp every zone the wire named, not the enabled projection: that projection is empty before the first poll
     * completes and silently omits any zone a feature option turned off. Bravo is turned off here precisely so the two populations differ - a fixture where they
     * matched could not tell the right source from the wrong one.
     */
    const h = buildController({ hasV2Client: true, program: (recorder) => {

      recorder.programDefault("statusschedule.php", { body: schedule([ alphaZone(), betaZone() ]), kind: "response" });
      recorder.programDefault("setzone.php", { body: { message: "", message_type: "info" }, kind: "response" });
    }, signalAborted: false, userOptions: [ SUSPEND_ZONE_ON, SUSPEND_ALL_ON, BETA_DISABLED ] });

    t.after(() => h.abort());

    const all = await waitFor(() => suspendSwitch(h.accessory, SUSPEND_ALL_SUBTYPE), { description: "the suspend-all switch to appear" });

    // The account-wide switch exists from construction, while the controller answers HomeKit only once its first poll has landed, which Alpha's own switch marks.
    await waitUntil(() => suspendSwitch(h.accessory) !== undefined, { description: "Alpha's suspension switch to appear" });

    assert.equal(suspendSwitch(h.accessory, BETA_SWITCH_SUBTYPE), undefined, "the disabled zone has no switch of its own to be stamped through");

    await triggerSet(all.getCharacteristic(Characteristic.On), true);

    // The snapshot predates the account-wide command, so without a per-zone stamp it would fight the account-wide switch's optimistic state zone by zone.
    applyFacts(h, { [ALPHA_RELAY_ID]: false, [BETA_RELAY_ID]: false }, now() - 5);

    assert.equal(readsSuspended(h.accessory), true, "the reported zone reads suspended from the account-wide command's own stamp");

    // Bring the disabled zone back into the projection. Its switch is established now, and what it shows is whether the account-wide command reached it at all.
    h.platform.featureOptions.configuredOptions = [ SUSPEND_ZONE_ON, SUSPEND_ALL_ON ];

    const beta = await waitFor(() => suspendSwitch(h.accessory, BETA_SWITCH_SUBTYPE), { description: "Beta's suspension switch to appear" });

    assert.equal(beta.getCharacteristic(Characteristic.On).value, true, "and so does the zone the wire reported while a feature option had it turned off");
  });

  test("an account-wide resume stamps every zone the other way", async (t) => {

    const h = buildController({ hasV2Client: true, program: (recorder) => {

      recorder.programDefault("statusschedule.php", { body: schedule([alphaZone()]), kind: "response" });
      recorder.programDefault("setzone.php", { body: { message: "", message_type: "info" }, kind: "response" });
    }, signalAborted: false, userOptions: [ SUSPEND_ZONE_ON, SUSPEND_ALL_ON ] });

    t.after(() => h.abort());

    // The account-wide switch is established at construction while a zone's own switch waits on the first poll, so both are awaited before the account-wide command
    // is driven - the zone switch is what this assertion reads its answer off.
    const all = await waitFor(() => suspendSwitch(h.accessory, SUSPEND_ALL_SUBTYPE), { description: "the suspend-all switch to appear" });

    await waitUntil(() => suspendSwitch(h.accessory) !== undefined, { description: "Alpha's suspension switch to appear" });

    applyFacts(h, { [ALPHA_RELAY_ID]: true }, now());
    assert.equal(readsSuspended(h.accessory), true, "the zone starts out suspended");

    await triggerSet(all.getCharacteristic(Characteristic.On), false);

    applyFacts(h, { [ALPHA_RELAY_ID]: true }, now() - 5);

    // Both directions, because a stamp that only ever recorded suspensions would leave a resume-all fighting the same stale facts it was meant to outrank.
    assert.equal(readsSuspended(h.accessory), false, "an account-wide resume renders every zone unsuspended against an older snapshot");
  });
});

describe("HydrawiseController suspension commands composed into the projection", () => {

  test("a suspend of a SCHEDULED zone reflects in the projection, MQTT, and the log at once", async (t) => {

    /* The case the whole composition exists for. The zone is carrying a live schedule, so the wire says nothing about suspension and the account's facts cannot
     * speak for it either - the classifier's facts arm only reaches the ambiguous sentinel shape. What answers is the command the account just accepted, and it
     * has to answer everywhere at once rather than on the switch alone with the rest of the surfaces a refresh interval behind.
     *
     * No refresh tick and no second poll are involved: the assertions run against what the command's own handler produced.
     */
    const h = buildController({ hasV2Client: true, mqtt: true,
      program: (recorder) => recorder.programDefault("statusschedule.php", { body: pacedSchedule([scheduledZone()]), kind: "response" }), signalAborted: false,
      userOptions: [ SUSPEND_ZONE_ON, "Enable.Log.Zone" ] });

    t.after(() => h.abort());

    const service = await waitFor(() => suspendSwitch(h.accessory), { description: "Alpha's suspension switch to appear" });

    await waitUntil(() => entryOf(h)?.state === "scheduled", { description: "Alpha to classify as scheduled" });

    /* A refresh lands BEFORE the command, which is the ordinary state of an install that has these switches at all - they exist only where the credentials do,
     * and the refresh cadence brings facts every quarter hour. It matters to the MQTT half specifically: the payload's classified fields are gated on having a
     * trustworthy snapshot, which is the promise that keeps a key-only install's payload byte-identical to what it has always been.
     */
    applyFacts(h, { [ALPHA_RELAY_ID]: false }, now());

    const publishesBefore = h.mqtt?.published.length ?? 0;

    await triggerSet(service.getCharacteristic(Characteristic.On), true);

    const entry = entryOf(h);

    assert.equal(entry?.state, "suspended", "the persisted projection reads the zone as suspended without waiting for a refresh");
    assert.equal(entry.until, Math.floor(Date.now() / 1000) + HYDRAWISE_SUSPEND_DURATION,
      "and carries the instant the command actually asked for");

    const payload = JSON.parse(String(h.mqtt?.published.at(-1)?.payload ?? "[]")) as { state?: string; suspendedUntil?: number }[];

    assert.equal(h.mqtt?.published.length, publishesBefore + 1, "the command's own handler publishes exactly once");
    assert.equal(payload[0]?.state, "suspended", "and the payload it published carries the composed state");
    assert.equal(logCount(h.entries, "info", "Suspended until"), 1, "the transition narrates once, in the command's own handler");
  });

  test("a suspend of a RUNNING zone holds the switch on while the projection honestly reads running", async (t) => {

    /* The one documented window. Water demonstrably flowing is wire truth that no command record overwrites, so the projection keeps saying running - while the
     * switch still shows the user that their command was accepted, because those are different questions answered from one standing judgment.
     *
     * The poll after it is what closes the window: the wire reports the zone stopped and carrying the sentinel shape, and the same standing command then
     * composes the suspension the user asked for.
     */
    const h = buildController({ hasV2Client: true, program: (recorder) => {

      recorder.program("statusschedule.php", { body: schedule([runningZone()]), kind: "response" });
      recorder.programDefault("statusschedule.php", { body: schedule([alphaZone()]), kind: "response" });
    }, signalAborted: false, userOptions: [SUSPEND_ZONE_ON] });

    t.after(() => h.abort());

    const service = await waitFor(() => suspendSwitch(h.accessory), { description: "Alpha's suspension switch to appear" });

    await waitUntil(() => entryOf(h)?.state === "running", { description: "Alpha to classify as running" });

    h.accessory.clearObservations();

    await triggerSet(service.getCharacteristic(Characteristic.On), true);

    /* The claim is about what the re-derive INSIDE this handler wrote, which the cached value cannot answer: a set caches the value it was handed once the
     * handler resolves, so reading it back would report the user's own tap whatever the reader beneath it decided. The change record is what distinguishes them - a
     * reader collapsed onto composed state would have written the switch off here, because the projection honestly reads running. The tap's own write, which HAP
     * raises once the handler resolves with the request's connection as its originator, is the control that the record is the switch's.
     */
    const onChanges = h.accessory.changesOn(service, Characteristic.On);

    assert.ok(onChanges.some(change => (change.originator !== undefined) && (change.newValue === true)), "the record holds the tap's own write");
    assert.ok(!onChanges.some(change => change.newValue === false), "nothing in the command's handler turns the switch back off");
    assert.equal(entryOf(h)?.state, "running", "while the projection keeps reporting the water that is demonstrably flowing");

    // The next poll finds the run finished, and the standing command classifies the zone it was issued against.
    await waitUntil(() => entryOf(h)?.state === "suspended", { description: "Alpha to classify as suspended" });

    assert.equal(entryOf(h)?.state, "suspended", "the poll that ends the run closes the window");
  });

  test("a resume clears a composed suspension at once, and does not call off a rain delay", async (t) => {

    /* The other direction, which is suppression rather than a claim: a standing resume silences the suspension arms and lets the zone fall through to the sensor
     * test. Resuming a zone tells the account to stop withholding it, which says nothing at all about whether a rain sensor is stopping it right now.
     */
    const h = buildController({ hasV2Client: true,
      program: (recorder) => recorder.programDefault("statusschedule.php",
        { body: pacedSchedule([alphaZone()], sensorsCovering(ALPHA_RELAY_ID)), kind: "response" }), signalAborted: false, userOptions: [SUSPEND_ZONE_ON] });

    t.after(() => h.abort());

    const service = await waitFor(() => suspendSwitch(h.accessory), { description: "Alpha's suspension switch to appear" });

    await triggerSet(service.getCharacteristic(Characteristic.On), true);

    assert.equal(entryOf(h)?.state, "suspended", "the suspension composes first, outranking the sensor as the longer-lived fact");

    await triggerSet(service.getCharacteristic(Characteristic.On), false);

    assert.equal(entryOf(h)?.state, "sensor-stopped", "the resume clears the suspension and the sensor's own claim returns rather than a clean schedule");
  });

  test("an account-wide command reflects across a NON-SENTINEL snapshot, its own switch included", async (t) => {

    /* The account grain, driven against zones carrying live schedules so nothing here could pass on the sentinel shape alone. The switch assertion is the one
     * that matters most: the re-derive fires inside the command's own handler and refreshes that switch from the composed state, so a reader that consulted only
     * the composition - built from a poll snapshot taken before the account accepted anything - would flip the switch straight back off under the user's finger.
     */
    const h = buildController({ hasV2Client: true, program: (recorder) => {

      recorder.programDefault("statusschedule.php", { body: pacedSchedule([ scheduledZone(), scheduledBeta() ]), kind: "response" });
      recorder.programDefault("setzone.php", { body: { message: "", message_type: "info" }, kind: "response" });
    }, signalAborted: false, userOptions: [ SUSPEND_ZONE_ON, SUSPEND_ALL_ON ] });

    t.after(() => h.abort());

    const all = await waitFor(() => suspendSwitch(h.accessory, SUSPEND_ALL_SUBTYPE), { description: "the suspend-all switch to appear" });

    await waitUntil(() => entryOf(h)?.state === "scheduled", { description: "Alpha to classify as scheduled" });

    await triggerSet(all.getCharacteristic(Characteristic.On), true);

    assert.equal(entryOf(h)?.state, "suspended", "every reported zone composes as suspended at once");
    assert.equal(entryOf(h, BETA_RELAY_ID)?.state, "suspended", "the sibling included");

    /* What the switch READS is what its own handler answers, which is the question HomeKit actually asks and the one the reader has to get right. Reading the
     * cached value instead would prove nothing here: a set caches the value it was given once the handler resolves, so it reports the user's own tap back
     * whatever the reader beneath it thinks.
     *
     * The re-derive runs inside this command's handler and refreshes this switch from composed state built on a poll snapshot taken BEFORE the account accepted
     * anything, so a reader that consulted only that composition answers off here and the switch drops back under the user's finger.
     */
    assert.equal(await triggerGet(all.getCharacteristic(Characteristic.On)), true, "and the account-wide switch reads on after the re-derive its handler ran");

    await triggerSet(all.getCharacteristic(Characteristic.On), false);

    assert.equal(entryOf(h)?.state, "scheduled", "a resume-all returns every zone to what the wire reports");
    assert.equal(await triggerGet(all.getCharacteristic(Characteristic.On)), false, "and the switch follows it back off");
  });

  test("strictly newer facts retire a command and own the projection, while an older snapshot changes nothing", async (t) => {

    // The retirement rule reaching the projection rather than the switch alone. A command is the freshest witness only until the account answers past it.
    const h = buildController({ hasV2Client: true,
      program: (recorder) => recorder.programDefault("statusschedule.php", { body: pacedSchedule([alphaZone()]), kind: "response" }), signalAborted: false,
      userOptions: [SUSPEND_ZONE_ON] });

    t.after(() => h.abort());

    const service = await waitFor(() => suspendSwitch(h.accessory), { description: "Alpha's suspension switch to appear" });

    await triggerSet(service.getCharacteristic(Characteristic.On), true);

    assert.equal(entryOf(h)?.state, "suspended", "the command composes the suspension");

    applyFacts(h, { [ALPHA_RELAY_ID]: false }, now() - 5);

    assert.equal(entryOf(h)?.state, "suspended", "a snapshot that predates the command leaves it standing in the projection too");

    applyFacts(h, { [ALPHA_RELAY_ID]: false }, now() + 2);

    assert.equal(entryOf(h)?.state, "unscheduled", "and one that postdates it retires the command, handing the projection back to the account");
  });

  test("a command costs exactly one flush, one publish, and one narration - and a no-op command costs none", async (t) => {

    /* Cardinality, read before any poll can intervene: the poll cadence publishes unconditionally and re-derives on its own account, so its arrival would
     * inflate every count here for reasons unrelated to the command.
     *
     * The second half is the change gate doing its job. Suspending a zone the account's own facts already report as suspended moves no classification, so the
     * re-derive writes nothing, publishes nothing, and narrates nothing.
     */
    const h = buildController({ hasV2Client: true, mqtt: true,
      program: (recorder) => recorder.programDefault("statusschedule.php", { body: pacedSchedule([scheduledZone()]), kind: "response" }), signalAborted: false,
      userOptions: [ SUSPEND_ZONE_ON, "Enable.Log.Zone" ] });

    t.after(() => h.abort());

    const service = await waitFor(() => suspendSwitch(h.accessory), { description: "Alpha's suspension switch to appear" });

    await waitUntil(() => entryOf(h)?.state === "scheduled", { description: "Alpha to classify as scheduled" });

    // A refresh lands first, for the same reason the assertion above states, and every count below is taken after it settles.
    applyFacts(h, { [ALPHA_RELAY_ID]: false }, now());

    const flushesBefore = h.flushes().length;
    const publishesBefore = h.mqtt?.published.length ?? 0;

    await triggerSet(service.getCharacteristic(Characteristic.On), true);

    assert.equal(h.flushes().length, flushesBefore + 1, "the command writes the accessory cache exactly once");
    assert.equal(h.mqtt?.published.length, publishesBefore + 1, "publishes exactly once");
    assert.equal(logCount(h.entries, "info", "Suspended until"), 1, "and narrates exactly once");

    // The same command again, against a classification that already reads suspended. Nothing moved, so nothing is written, published, or said.
    await triggerSet(service.getCharacteristic(Characteristic.On), true);

    assert.equal(h.flushes().length, flushesBefore + 1, "a command that moves no classification writes nothing");
    assert.equal(h.mqtt.published.length, publishesBefore + 1, "publishes nothing");
    assert.equal(logCount(h.entries, "info", "Suspended until"), 1, "and narrates nothing a second time");
  });

  test("a suspend-all issued before the first poll is refused, and sends, stamps, and writes nothing", async (t) => {

    /* The pre-first-poll window, where nothing in this run has reached Hydrawise. The controller cannot vouch for the account-wide switch yet, so the write is
     * refused with the communication failure before the handler runs: no command reaches the wire, no stamp is recorded for a later snapshot to be judged
     * against, and the accessory cache is not written.
     */
    const h = buildController({ hasV2Client: true, program: (recorder) => {

      recorder.programDefault("setzone.php", { body: { message: "", message_type: "info" }, kind: "response" });
    }, signalAborted: true, userOptions: [ SUSPEND_ZONE_ON, SUSPEND_ALL_ON ] });

    t.after(() => h.abort());

    const all = await waitFor(() => suspendSwitch(h.accessory, SUSPEND_ALL_SUBTYPE), { description: "the suspend-all switch to appear" });
    const constructed = all.getCharacteristic(Characteristic.On).value;

    await assert.rejects(() => triggerSet(all.getCharacteristic(Characteristic.On), !constructed), noResponse, "the write is refused with the communication failure");

    assert.equal(h.retrieve.callsTo("setzone.php").length, 0, "no command reaches the wire");
    assert.equal(all.getCharacteristic(Characteristic.On).value, constructed, "the switch keeps the state it was constructed with");
    assert.deepEqual(projectionOf(h), [], "nothing is classified, because no poll has reported a zone to classify");
    assert.equal(h.flushes().length, 0, "and the accessory cache is not written");
  });

  test("a command's stamp and a snapshot's stamp read one clock, so the guard holds on a virtual timeline too", async (t) => {

    /* The stamps the guard compares come from the platform's clock: the instant a command was accepted and the instant a fetch was made. On a virtual timeline
     * that starts at zero, a command stamped from any other clock would read decades newer than every snapshot, and the newer snapshot below could never retire it.
     */
    const clock = new TestClock();
    const h = buildController({ clock, hasV2Client: true,
      program: (recorder) => recorder.programDefault("statusschedule.php", { body: pacedSchedule([alphaZone()]), kind: "response" }), signalAborted: false,
      userOptions: [SUSPEND_ZONE_ON] });

    t.after(() => h.abort());

    await advanceThroughSchedule(clock, []);

    const service = await waitFor(() => suspendSwitch(h.accessory), { description: "Alpha's suspension switch to appear" });
    const clockSeconds = (): number => Math.floor(clock.now() / 1000);

    await triggerSet(service.getCharacteristic(Characteristic.On), true);

    applyFacts(h, { [ALPHA_RELAY_ID]: false }, clockSeconds());
    assert.equal(readsSuspended(h.accessory), true, "a snapshot stamped in the command's own second leaves the command standing");

    clock.advance(1000);

    applyFacts(h, { [ALPHA_RELAY_ID]: false }, clockSeconds());
    assert.equal(readsSuspended(h.accessory), false, "a snapshot stamped a second later on the same clock retires it");
  });

  test("a projection restored carrying a commanded suspension survives the restart and reconciles on fresh facts", async (t) => {

    /* Restart honesty. The command records die with the process, so what comes back is the composed projection alone - and the carry holds its suspension
     * through the window before the first refresh answers, exactly as it holds one the account reported. A fresh snapshot then reconciles it, which is what
     * keeps a restart from stranding a claim nothing can clear.
     */
    const restored = scheduleStatus(pacedSchedule([alphaZone()]), HYDRAWISE_ACTIVE_ZONE_INDICATOR,
      { commands: new Map([[ ALPHA_RELAY_ID, SUSPENDED_UNTIL ]]) });

    const h = buildController({ hasV2Client: true,
      program: (recorder) => recorder.programDefault("statusschedule.php", { body: pacedSchedule([alphaZone()]), kind: "response" }),
      seedContext: (seed) => { seed.context = { schedule: restored }; }, signalAborted: false, userOptions: [SUSPEND_ZONE_ON] });

    t.after(() => h.abort());

    await waitUntil(() => suspendSwitch(h.accessory) !== undefined, { description: "Alpha's suspension switch to appear" });

    assert.equal(entryOf(h)?.state, "suspended", "the restored suspension carries through the first poll, which has no facts and no command of its own");

    applyFacts(h, { [ALPHA_RELAY_ID]: false }, now());

    assert.equal(entryOf(h)?.state, "unscheduled", "and the first real answer from the account reconciles it");
  });
});

describe("HydrawiseController per-zone suspension hosting and sweeps", () => {

  test("a standalone zone's switch lives on its own accessory, and the refresh cadence reaches it there", async (t) => {

    const h = buildController({ hasV2Client: true,
      program: (recorder) => recorder.programDefault("statusschedule.php", { body: schedule([alphaZone()]), kind: "response" }), signalAborted: false,
      userOptions: [ SUSPEND_ZONE_ON, STANDALONE_ON ] });

    t.after(() => h.abort());

    const zoneAccessory = await waitFor(() => h.zoneAccessories.get(ALPHA_RELAY_ID), { description: "the zone's own accessory to appear" });

    await waitUntil(() => suspendSwitch(zoneAccessory) !== undefined, { description: "Alpha's suspension switch on the zone's own accessory to appear" });

    assert.equal(suspendSwitch(h.accessory), undefined, "the switch follows its zone's valve rather than staying behind on the controller");

    /* The refresh cadence reaching a standalone host is what the recorded hosting map exists for. Without it the tail would have nowhere to look, and a suspension
     * landing between polls would not reach a promoted zone at all.
     */
    applyFacts(h, { [ALPHA_RELAY_ID]: true }, now());

    assert.equal(readsSuspended(zoneAccessory), true, "a refresh tick reaches the switch on the accessory that hosts it");
  });

  test("the sweep is scoped to the composed subtype, so the account-wide switch survives it", async (t) => {

    const h = buildController({ hasV2Client: true, program: (recorder) => {

      recorder.programDefault("statusschedule.php", { body: schedule([alphaZone()]), kind: "response" });
      recorder.programDefault("setzone.php", { body: { message: "", message_type: "info" }, kind: "response" });
    }, signalAborted: false, userOptions: [ SUSPEND_ZONE_ON, SUSPEND_ALL_ON ] });

    t.after(() => h.abort());

    await waitUntil(() => suspendSwitch(h.accessory) !== undefined, { description: "Alpha's suspension switch to appear" });
    assert.ok(suspendSwitch(h.accessory, SUSPEND_ALL_SUBTYPE), "both switches start out published");

    // Turn the per-zone switches off, leaving the account-wide one enabled. The two share the Switch service type, so a sweep matching on that type alone would
    // take both - and the user would silently lose a switch they never touched.
    h.platform.featureOptions.configuredOptions = [SUSPEND_ALL_ON];

    await waitUntil(() => suspendSwitch(h.accessory) === undefined, { description: "Alpha's suspension switch to be removed" });

    assert.ok(suspendSwitch(h.accessory, SUSPEND_ALL_SUBTYPE), "the account-wide switch is untouched by the per-zone sweep");
  });

  test("a zone that leaves the wire takes its switch and its standing command with it", async (t) => {

    const h = buildController({ hasV2Client: true, program: (recorder) => {

      recorder.program("statusschedule.php", { body: schedule([ alphaZone(), betaZone() ]), kind: "response" });
      recorder.programDefault("statusschedule.php", { body: schedule([betaZone()]), kind: "response" });
    }, signalAborted: false, userOptions: [SUSPEND_ZONE_ON] });

    t.after(() => h.abort());

    const service = await waitFor(() => suspendSwitch(h.accessory), { description: "Alpha's suspension switch to appear" });

    await triggerSet(service.getCharacteristic(Characteristic.On), true);

    // The zone falls off the wire, which takes its switch with it - the sweep answers to the walk, not to what was published last time.
    await waitUntil(() => suspendSwitch(h.accessory) === undefined, { description: "Alpha's suspension switch to be removed" });

    /* And its standing command goes too. Bringing the zone back with a snapshot that PREDATES that command is what makes the difference visible: a command left
     * behind would still be standing and would render the returning zone suspended, against an account that says it is not.
     */
    h.retrieve.programDefault("statusschedule.php", { body: schedule([ alphaZone(), betaZone() ]), kind: "response" });

    const restored = await waitFor(() => suspendSwitch(h.accessory), { description: "Alpha's suspension switch to appear" });

    applyFacts(h, { [ALPHA_RELAY_ID]: false, [BETA_RELAY_ID]: false }, now() - 5);

    assert.equal(restored.getCharacteristic(Characteristic.On).value, false, "a returning zone answers to the account rather than to a command it outlived");
  });

  test("a v1-only install publishes nothing and logs nothing, whatever a poll reports", async (t) => {

    // The whole parity floor in one pass: no switch, no command surface, and no line about a feature that does not exist here.
    const h = buildController({ program: (recorder) => {

      recorder.programDefault("statusschedule.php", { body: schedule([ alphaZone(), betaZone() ]), kind: "response" });
    }, signalAborted: false, userOptions: [ SUSPEND_ZONE_ON, STANDALONE_ON ] });

    t.after(() => h.abort());

    await pollsCompleted(h, 2);

    assert.equal(h.accessory.services.filter(service => (service.UUID === Service.Switch.UUID)).length, 0, "no switch of any kind is published");
    assert.equal(logCount(h.entries, "error", "Unable to"), 0, "and nothing failed trying");
  });
});
