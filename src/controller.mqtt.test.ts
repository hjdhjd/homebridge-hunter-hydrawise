/* Copyright(C) 2017-2026, HJD (https://github.com/hjdhjd). All rights reserved.
 *
 * controller.mqtt.test.ts: The controller's MQTT surface, driven through the recording MQTT double's invokeGet / invokeSet knobs. Covers the status
 * JSON the get handler answers, the set-command grammar (a start with or without a duration, a stop, and the throws for an invalid zone, command, or duration),
 * and the per-poll publish including the client's guarded publish, which lands a publish rejection in the log rather than as an unhandled rejection.
 */

// The Hydrawise API wire shapes use snake_case keys such as relay_id and controller_id, so camelcase is disabled here to let these literals mirror the wire verbatim.
/* eslint-disable camelcase */
import type { HydrawiseControllerV2Facts, HydrawiseZoneConfig, StatusScheduleResponse } from "./types.ts";
import { assertNoUnhandledRejections, firstOf } from "./testing.helpers.ts";
import { buildController, loggedAt, makeV2Facts, makeZoneV2Facts, waitFor } from "./testing/platform.helpers.ts";
import { describe, test } from "node:test";
import { fastPolling, makeStatusSchedule, makeZone } from "./api.helpers.ts";
import type { BuildControllerResult } from "./testing/platform.helpers.ts";
import { HYDRAWISE_UNSCHEDULED_SENTINEL } from "./types.ts";
import { HYDRAWISE_V2_FACTS_TTL } from "./settings.ts";
import { Service } from "./testing/hap.helpers.ts";
import assert from "node:assert/strict";
import { bareSensors } from "./api.fixtures.ts";

function schedule(zones: HydrawiseZoneConfig[]): StatusScheduleResponse {

  return fastPolling(makeStatusSchedule({ relays: zones, sensors: bareSensors }));
}

function runningZone(): HydrawiseZoneConfig {

  return makeZone({ name: "Alpha", relay: 1, relay_id: 700001, run: 600, time: 1, timestr: "" });
}

describe("HydrawiseController MQTT", () => {

  test("the get handler answers the current status as parseable JSON", async (t) => {

    const h = buildController({ mqtt: true, program: (recorder) => recorder.programDefault("statusschedule.php", { body: schedule([runningZone()]),
      kind: "response" }), signalAborted: false });

    t.after(() => h.abort());

    assert.ok(h.mqtt, "the MQTT recorder should be attached");
    const mqtt = h.mqtt;

    await waitFor(() => h.accessory.getServiceById(Service.Valve, "700001") ? true : undefined);

    const payload = await mqtt.invokeGet("controller/get");

    assert.ok(payload, "the get handler should answer a payload");

    const parsed = JSON.parse(payload) as { name: string; relay: number }[];
    const zone = firstOf(parsed, "status zone");

    assert.equal(zone.relay, 1, "the status JSON should carry the zone relay number");
    assert.equal(zone.name, "Alpha", "the status JSON should carry the zone name");
  });

  test("the set handler runs a zone on a start command", async (t) => {

    const h = buildController({ mqtt: true, program: (recorder) => {

      recorder.programDefault("statusschedule.php", { body: schedule([runningZone()]), kind: "response" });
      recorder.programDefault("setzone.php", { body: { message: "", message_type: "info" }, kind: "response" });
    }, signalAborted: false });

    t.after(() => h.abort());

    assert.ok(h.mqtt, "the MQTT recorder should be attached");
    const mqtt = h.mqtt;

    await waitFor(() => h.accessory.getServiceById(Service.Valve, "700001") ? true : undefined);
    await mqtt.invokeSet("controller/set", "start 1 300");

    const command = firstOf(h.retrieve.callsTo("setzone.php"), "setzone call");

    assert.equal(command.params?.["action"], "run", "a start command should send the run action");
    assert.equal(command.params?.["custom"], "300", "a start command should carry the requested duration");
  });

  test("the set handler stops a zone on a stop command", async (t) => {

    const h = buildController({ mqtt: true, program: (recorder) => {

      recorder.programDefault("statusschedule.php", { body: schedule([runningZone()]), kind: "response" });
      recorder.programDefault("setzone.php", { body: { message: "", message_type: "info" }, kind: "response" });
    }, signalAborted: false });

    t.after(() => h.abort());

    assert.ok(h.mqtt, "the MQTT recorder should be attached");
    const mqtt = h.mqtt;

    await waitFor(() => h.accessory.getServiceById(Service.Valve, "700001") ? true : undefined);
    await mqtt.invokeSet("controller/set", "stop 1");

    const command = firstOf(h.retrieve.callsTo("setzone.php"), "setzone call");

    assert.equal(command.params?.["action"], "stop", "a stop command should send the stop action");
  });

  test("a zero-duration start hits the guard and sends no wire command", async (t) => {

    const h = buildController({ mqtt: true, program: (recorder) => {

      recorder.programDefault("statusschedule.php", { body: schedule([runningZone()]), kind: "response" });
      recorder.programDefault("setzone.php", { body: { message: "", message_type: "info" }, kind: "response" });
    }, signalAborted: false });

    t.after(() => h.abort());

    assert.ok(h.mqtt, "the MQTT recorder should be attached");
    const mqtt = h.mqtt;

    await waitFor(() => h.accessory.getServiceById(Service.Valve, "700001") ? true : undefined);
    await mqtt.invokeSet("controller/set", "start 1 0");

    // A run command with a non-positive duration returns null from sendCommand before it reaches the wire, so no setzone call is recorded.
    assert.equal(h.retrieve.callsTo("setzone.php").length, 0, "a zero-duration start should send no setzone command");
  });

  test("a start with no duration runs the zone for its own run value", async (t) => {

    const zone = runningZone();
    const h = buildController({ mqtt: true, program: (recorder) => {

      recorder.programDefault("statusschedule.php", { body: schedule([zone]), kind: "response" });
      recorder.programDefault("setzone.php", { body: { message: "", message_type: "info" }, kind: "response" });
    }, signalAborted: false });

    t.after(() => h.abort());

    assert.ok(h.mqtt, "the MQTT recorder should be attached");
    const mqtt = h.mqtt;

    await waitFor(() => h.accessory.getServiceById(Service.Valve, "700001") ? true : undefined);
    await mqtt.invokeSet("controller/set", "start 1");

    const command = firstOf(h.retrieve.callsTo("setzone.php"), "setzone call");

    assert.equal(command.params?.["action"], "run", "a start with no duration should still send the run action");
    assert.equal(command.params?.["custom"], zone.run.toString(), "and carry the zone's own run value as its duration");
  });

  test("a start whose duration is not an integer is refused and sends no wire command", async (t) => {

    const h = buildController({ mqtt: true, program: (recorder) => {

      recorder.programDefault("statusschedule.php", { body: schedule([runningZone()]), kind: "response" });
      recorder.programDefault("setzone.php", { body: { message: "", message_type: "info" }, kind: "response" });
    }, signalAborted: false });

    t.after(() => h.abort());

    assert.ok(h.mqtt, "the MQTT recorder should be attached");
    const mqtt = h.mqtt;

    await waitFor(() => h.accessory.getServiceById(Service.Valve, "700001") ? true : undefined);
    await assert.rejects(() => mqtt.invokeSet("controller/set", "start 1 abc"), /^Error: MQTT: Invalid duration specified\.$/,
      "a duration that does not parse to an integer should throw");

    assert.equal(h.retrieve.callsTo("setzone.php").length, 0, "and no setzone command should be sent");
  });

  test("a start with no duration on a zone with no scheduled run is refused and sends no wire command", async (t) => {

    const h = buildController({ mqtt: true, program: (recorder) => {

      recorder.programDefault("statusschedule.php", { body: schedule([makeZone({ name: "Alpha", relay: 1, relay_id: 700001, run: 0,
        time: HYDRAWISE_UNSCHEDULED_SENTINEL, timestr: "" })]), kind: "response" });
      recorder.programDefault("setzone.php", { body: { message: "", message_type: "info" }, kind: "response" });
    }, signalAborted: false });

    t.after(() => h.abort());

    assert.ok(h.mqtt, "the MQTT recorder should be attached");
    const mqtt = h.mqtt;

    await waitFor(() => h.accessory.getServiceById(Service.Valve, "700001") ? true : undefined);
    await assert.rejects(() => mqtt.invokeSet("controller/set", "start 1"), /^Error: MQTT: No duration given and the zone has no scheduled run\.$/,
      "a start with no duration has nothing to run for on a zone with no scheduled run");

    assert.equal(h.retrieve.callsTo("setzone.php").length, 0, "and no setzone command should be sent");
  });

  test("the set handler throws on an unknown zone", async (t) => {

    const h = buildController({ mqtt: true, program: (recorder) => recorder.programDefault("statusschedule.php", { body: schedule([runningZone()]),
      kind: "response" }), signalAborted: false });

    t.after(() => h.abort());

    assert.ok(h.mqtt, "the MQTT recorder should be attached");
    const mqtt = h.mqtt;

    await waitFor(() => h.accessory.getServiceById(Service.Valve, "700001") ? true : undefined);
    await assert.rejects(() => mqtt.invokeSet("controller/set", "start 99 300"), /Invalid zone specified/, "a command for an unknown zone should throw");
  });

  test("the set handler throws on an unknown command", async (t) => {

    const h = buildController({ mqtt: true, program: (recorder) => recorder.programDefault("statusschedule.php", { body: schedule([runningZone()]),
      kind: "response" }), signalAborted: false });

    t.after(() => h.abort());

    assert.ok(h.mqtt, "the MQTT recorder should be attached");
    const mqtt = h.mqtt;

    await waitFor(() => h.accessory.getServiceById(Service.Valve, "700001") ? true : undefined);
    await assert.rejects(() => mqtt.invokeSet("controller/set", "toggle 1"), /Invalid command/, "an unknown command should throw");
  });

  test("each poll publishes the controller status", async (t) => {

    const h = buildController({ mqtt: true, program: (recorder) => recorder.programDefault("statusschedule.php", { body: schedule([runningZone()]),
      kind: "response" }), signalAborted: false });

    t.after(() => h.abort());

    assert.ok(h.mqtt, "the MQTT recorder should be attached");
    const mqtt = h.mqtt;

    await waitFor(() => (mqtt.published.length >= 1) ? true : undefined);

    const record = firstOf(mqtt.published, "MQTT publish");

    assert.ok(record.topic.endsWith("controller"), "the publish topic should be the controller topic");
    assert.ok(String(record.payload).includes("Alpha"), "the published payload should carry the zone status");
  });

  test("a publish rejection is guarded into the log rather than an unhandled rejection", async (t) => {

    const cleanup = assertNoUnhandledRejections();
    const h = buildController({ mqtt: true, program: (recorder) => recorder.programDefault("statusschedule.php", { body: schedule([runningZone()]),
      kind: "response" }), signalAborted: false });

    t.after(() => h.abort());

    assert.ok(h.mqtt, "the MQTT recorder should be attached");
    const mqtt = h.mqtt;

    // Arm the publish rejection before the first poll's publish fires; the client's guarded publish must route it to the log.
    mqtt.publishRejection = new Error("broker gone");

    /* The failure line names the topic it could not reach, and that topic opens with this controller's serial. A household running several controllers reads
     * which one lost its broker from exactly that, so the assertion covers the named topic rather than the generic opening alone.
     */
    const failureLine = "Unable to publish to the MQTT topic " + h.controllerConfig.serial_number + "/controller";

    await waitFor(() => loggedAt(h.lines(), "error", failureLine) ? true : undefined);

    assert.ok(loggedAt(h.lines(), "error", failureLine), "a rejected publish should be reported by the client's guarded publish, naming its topic");
    assert.equal(mqtt.published.length, 0, "and nothing should be recorded as published");
    assert.ok(mqtt.rejectedPublishes >= 1, "while the refusal itself is counted");

    cleanup();
  });
});

describe("HydrawiseController MQTT with account facts", () => {

  // The suspension instant the live account capture recorded, kept verbatim so the payload carries a real far-future value.
  const SUSPENDED_UNTIL = 1903928399;

  // Two zones carrying the ambiguous sentinel shape, so which one reads as suspended rests entirely on the facts rather than on anything in the wire body.
  function sentinelPair(): HydrawiseZoneConfig[] {

    return [ makeZone({ name: "Alpha", relay: 1, relay_id: 700001, run: 0, time: HYDRAWISE_UNSCHEDULED_SENTINEL, timestr: "" }),
      makeZone({ name: "Beta", relay: 2, relay_id: 700002, run: 0, time: HYDRAWISE_UNSCHEDULED_SENTINEL, timestr: "" }) ];
  }

  // Only the first zone is suspended, which is what lets an attribution error show up as the wrong zone carrying the instant.
  function oneSuspended(): HydrawiseControllerV2Facts {

    return makeV2Facts({ online: true,
      zones: [ [ 700001, makeZoneV2Facts({ suspendedUntil: SUSPENDED_UNTIL }) ], [ 700002, makeZoneV2Facts() ] ] });
  }

  // One zone entry as the payload publishes it: the base wire fields this topic carries, and the fields the account credentials add. Every field is optional
  // because the additive pair is present only on a credentialed install whose facts are current, which is exactly what these assertions are checking.
  interface PublishedZone {

    name?: string;
    relay?: number;
    run?: number;
    state?: string;
    suspendedUntil?: number;
    time?: number;
    timestr?: string;
  }

  // The parsed payload the get handler answers, which every assertion below reads rather than matching substrings against the raw JSON.
  async function payloadOf(h: BuildControllerResult): Promise<PublishedZone[]> {

    assert.ok(h.mqtt, "the MQTT recorder should be attached");

    const raw = await h.mqtt.invokeGet("controller/get");

    assert.ok(raw, "the get handler should answer a payload");

    return JSON.parse(raw) as PublishedZone[];
  }

  test("an install with no credentials publishes exactly the five-field shape", async (t) => {

    /* The parity check, asserted as a DEEP EQUALITY rather than a field spot-check: any additive key leaking into an install that configured no credentials would
     * show up here, which a substring or per-field assertion would miss.
     */
    const h = buildController({ mqtt: true,
      program: (recorder) => recorder.programDefault("statusschedule.php", { body: schedule(sentinelPair()), kind: "response" }), signalAborted: false });

    t.after(() => h.abort());

    await waitFor(() => h.accessory.getServiceById(Service.Valve, "700001") ? true : undefined);

    assert.deepEqual(await payloadOf(h), [ { name: "Alpha", relay: 1, run: 0, time: HYDRAWISE_UNSCHEDULED_SENTINEL, timestr: "" },
      { name: "Beta", relay: 2, run: 0, time: HYDRAWISE_UNSCHEDULED_SENTINEL, timestr: "" } ], "no additive key reaches a key-based install");
  });

  test("a credentialed install carries the classified state, and the suspension lands on its OWN zone", async (t) => {

    const h = buildController({ hasV2Client: true, mqtt: true,
      program: (recorder) => recorder.programDefault("statusschedule.php", { body: schedule(sentinelPair()), kind: "response" }), signalAborted: false });

    t.after(() => h.abort());

    await waitFor(() => h.accessory.getServiceById(Service.Valve, "700001") ? true : undefined);

    h.controller.applyFacts({ facts: oneSuspended(), fetchedAt: Math.floor(Date.now() / 1000) });

    const parsed = await payloadOf(h);

    /* Attribution is the claim, so each zone is checked individually: the suspended zone carries its own instant and its sibling carries none at all. A substring
     * check against the whole payload could not tell a correctly attributed instant from one landed on the wrong zone.
     */
    assert.equal(parsed[0]?.state, "suspended", "the suspended zone reports its classified state");
    assert.equal(parsed[0]?.suspendedUntil, SUSPENDED_UNTIL, "and carries its own suspension instant");
    assert.equal(parsed[1]?.state, "unscheduled", "its sibling reports its own state");
    assert.ok(!("suspendedUntil" in (parsed[1] ?? {})), "and carries no suspension instant at all");

    // The zone's base wire fields are untouched beneath the additions, which is what makes this sharpening additive rather than a reshaping.
    assert.equal(parsed[0]?.name, "Alpha", "the wire name is unchanged");
    assert.equal(parsed[0]?.time, HYDRAWISE_UNSCHEDULED_SENTINEL, "and so is the wire time");
  });

  test("a credentialed install whose snapshot has aged out publishes the key-based payload byte for byte", async (t) => {

    /* The freshness gate's whole job. The credentials are configured and the projection exists either way, so without the gate a stale snapshot would go on
     * publishing classifications nothing is left to confirm.
     */
    const h = buildController({ hasV2Client: true, mqtt: true,
      program: (recorder) => recorder.programDefault("statusschedule.php", { body: schedule(sentinelPair()), kind: "response" }), signalAborted: false });

    t.after(() => h.abort());

    await waitFor(() => h.accessory.getServiceById(Service.Valve, "700001") ? true : undefined);

    h.controller.applyFacts({ facts: oneSuspended(), fetchedAt: Math.floor(Date.now() / 1000) - (HYDRAWISE_V2_FACTS_TTL + 1) });

    assert.deepEqual(await payloadOf(h), [ { name: "Alpha", relay: 1, run: 0, time: HYDRAWISE_UNSCHEDULED_SENTINEL, timestr: "" },
      { name: "Beta", relay: 2, run: 0, time: HYDRAWISE_UNSCHEDULED_SENTINEL, timestr: "" } ], "an expired snapshot publishes exactly what a key-based install does");
  });
});
