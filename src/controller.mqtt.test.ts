/* Copyright(C) 2017-2026, HJD (https://github.com/hjdhjd). All rights reserved.
 *
 * controller.mqtt.test.ts: The controller's MQTT surface, driven through the recording MQTT double's invokeGet / invokeSet knobs. Covers the status
 * JSON the get handler answers, the set-command grammar (a start with or without a duration, a stop, and the throws for an invalid zone, command, or duration),
 * the per-poll publish including the client's guarded publish, which lands a publish rejection in the log rather than as an unhandled rejection, and the
 * availability word: its restatement on a new session, and the retained offline a teardown leaves as the last word, with nothing restated behind it.
 */

// The Hydrawise API wire shapes use snake_case keys such as relay_id and controller_id, so camelcase is disabled here to let these literals mirror the wire verbatim.
/* eslint-disable camelcase */
import { HYDRAWISE_API_RETRY_INTERVAL, HYDRAWISE_V2_FACTS_TTL } from "./settings.ts";
import type { HydrawiseControllerV2Facts, HydrawiseZoneConfig, StatusScheduleResponse } from "./types.ts";
import { Service, buildController, makeV2Facts, makeZoneV2Facts, pollBackoff, pollSleep } from "./testing/platform.helpers.ts";
import { advanceThroughSchedule, assertNoUnhandledRejections, expectAt, logCount, loggedAt, present, settleUntil } from "homebridge-plugin-utils/testing";
import { describe, test } from "node:test";
import { makeStatusSchedule, makeZone } from "./api.helpers.ts";
import type { BuildControllerResult } from "./testing/platform.helpers.ts";
import { HYDRAWISE_UNSCHEDULED_SENTINEL } from "./types.ts";
import assert from "node:assert/strict";
import { bareSensors } from "./api.fixtures.ts";

// A wire-realistic body, so a row that wants a later poll steps the controller's clock across the sleep the wire asks for.
function schedule(zones: HydrawiseZoneConfig[]): StatusScheduleResponse {

  return makeStatusSchedule({ relays: zones, sensors: bareSensors });
}

function runningZone(): HydrawiseZoneConfig {

  return makeZone({ name: "Alpha", relay: 1, relay_id: 700001, run: 600, time: 1, timestr: "" });
}

describe("HydrawiseController MQTT", () => {

  test("the get handler answers the current status as parseable JSON", async (t) => {

    const h = buildController({ mqtt: true, program: (recorder) => recorder.programDefault("statusschedule.php",
      { body: schedule([runningZone()]), kind: "response" }), signalAborted: false });

    t.after(() => h.abort());

    assert.ok(h.mqtt, "the MQTT recorder should be attached");
    const mqtt = h.mqtt;

    await settleUntil(() => h.accessory.getServiceById(Service.Valve, "700001") !== undefined, { description: "the valve for zone 700001 to appear" });

    const payload = await mqtt.invokeGet("controller/get");

    assert.ok(payload, "the get handler should answer a payload");

    const parsed = JSON.parse(payload) as { name: string; relay: number }[];
    const zone = expectAt(parsed, 0, "status zone");

    assert.equal(zone.relay, 1, "the status JSON should carry the zone relay number");
    assert.equal(zone.name, "Alpha", "the status JSON should carry the zone name");
  });

  test("the set handler runs a zone on a start command", async (t) => {

    const h = buildController({ mqtt: true, program: (recorder) => {

      recorder.programDefault("statusschedule.php", { body: schedule([runningZone()]), kind: "response" });
    }, signalAborted: false });

    t.after(() => h.abort());

    assert.ok(h.mqtt, "the MQTT recorder should be attached");
    const mqtt = h.mqtt;

    await settleUntil(() => h.accessory.getServiceById(Service.Valve, "700001") !== undefined, { description: "the valve for zone 700001 to appear" });
    await mqtt.invokeSet("controller/set", "start 1 300");
    await h.controller.commandsIdle;

    const command = expectAt(h.commands.params, 0, "setzone call");

    assert.equal(command["action"], "run", "a start command should send the run action");
    assert.equal(command["custom"], "300", "a start command should carry the requested duration");
  });

  test("the set handler stops a zone on a stop command", async (t) => {

    const h = buildController({ mqtt: true, program: (recorder) => {

      recorder.programDefault("statusschedule.php", { body: schedule([runningZone()]), kind: "response" });
    }, signalAborted: false });

    t.after(() => h.abort());

    assert.ok(h.mqtt, "the MQTT recorder should be attached");
    const mqtt = h.mqtt;

    await settleUntil(() => h.accessory.getServiceById(Service.Valve, "700001") !== undefined, { description: "the valve for zone 700001 to appear" });
    await mqtt.invokeSet("controller/set", "stop 1");
    await h.controller.commandsIdle;

    const command = expectAt(h.commands.params, 0, "setzone call");

    assert.equal(command["action"], "stop", "a stop command should send the stop action");
  });

  test("a zero-duration start hits the guard and sends no wire command", async (t) => {

    const h = buildController({ mqtt: true, program: (recorder) => {

      recorder.programDefault("statusschedule.php", { body: schedule([runningZone()]), kind: "response" });
    }, signalAborted: false });

    t.after(() => h.abort());

    assert.ok(h.mqtt, "the MQTT recorder should be attached");
    const mqtt = h.mqtt;

    await settleUntil(() => h.accessory.getServiceById(Service.Valve, "700001") !== undefined, { description: "the valve for zone 700001 to appear" });
    await mqtt.invokeSet("controller/set", "start 1 0");
    await h.controller.commandsIdle;

    // A run with a non-positive duration is declined before anything is queued, so no setzone call is recorded, and the set returns without a word.
    assert.equal(h.commands.calls.length, 0, "a zero-duration start should send no setzone command");
    assert.equal(h.entries.filter(line => line.level === "error").length, 0, "and nothing is reported as failing");
  });

  test("a start with no duration runs the zone for its own run value", async (t) => {

    const zone = runningZone();
    const h = buildController({ mqtt: true, program: (recorder) => {

      recorder.programDefault("statusschedule.php", { body: schedule([zone]), kind: "response" });
    }, signalAborted: false });

    t.after(() => h.abort());

    assert.ok(h.mqtt, "the MQTT recorder should be attached");
    const mqtt = h.mqtt;

    await settleUntil(() => h.accessory.getServiceById(Service.Valve, "700001") !== undefined, { description: "the valve for zone 700001 to appear" });
    await mqtt.invokeSet("controller/set", "start 1");
    await h.controller.commandsIdle;

    const command = expectAt(h.commands.params, 0, "setzone call");

    assert.equal(command["action"], "run", "a start with no duration should still send the run action");
    assert.equal(command["custom"], zone.run.toString(), "and carry the zone's own run value as its duration");
  });

  test("a start whose duration is not an integer is refused and sends no wire command", async (t) => {

    const h = buildController({ mqtt: true, program: (recorder) => {

      recorder.programDefault("statusschedule.php", { body: schedule([runningZone()]), kind: "response" });
    }, signalAborted: false });

    t.after(() => h.abort());

    assert.ok(h.mqtt, "the MQTT recorder should be attached");
    const mqtt = h.mqtt;

    await settleUntil(() => h.accessory.getServiceById(Service.Valve, "700001") !== undefined, { description: "the valve for zone 700001 to appear" });
    await assert.rejects(() => mqtt.invokeSet("controller/set", "start 1 abc"), /^Error: MQTT: Invalid duration specified\.$/,
      "a duration that does not parse to an integer should throw");

    assert.equal(h.commands.calls.length, 0, "and no setzone command should be sent");
  });

  test("a start with no duration on a zone with no scheduled run is refused and sends no wire command", async (t) => {

    const h = buildController({ mqtt: true, program: (recorder) => {

      recorder.programDefault("statusschedule.php", { body: schedule([makeZone({ name: "Alpha", relay: 1, relay_id: 700001, run: 0,
        time: HYDRAWISE_UNSCHEDULED_SENTINEL, timestr: "" })]), kind: "response" });
    }, signalAborted: false });

    t.after(() => h.abort());

    assert.ok(h.mqtt, "the MQTT recorder should be attached");
    const mqtt = h.mqtt;

    await settleUntil(() => h.accessory.getServiceById(Service.Valve, "700001") !== undefined, { description: "the valve for zone 700001 to appear" });
    await assert.rejects(() => mqtt.invokeSet("controller/set", "start 1"), /^Error: MQTT: No duration given and the zone has no scheduled run\.$/,
      "a start with no duration has nothing to run for on a zone with no scheduled run");

    assert.equal(h.commands.calls.length, 0, "and no setzone command should be sent");
  });

  test("the set handler throws on an unknown zone", async (t) => {

    const h = buildController({ mqtt: true, program: (recorder) => recorder.programDefault("statusschedule.php",
      { body: schedule([runningZone()]), kind: "response" }), signalAborted: false });

    t.after(() => h.abort());

    assert.ok(h.mqtt, "the MQTT recorder should be attached");
    const mqtt = h.mqtt;

    await settleUntil(() => h.accessory.getServiceById(Service.Valve, "700001") !== undefined, { description: "the valve for zone 700001 to appear" });
    await assert.rejects(() => mqtt.invokeSet("controller/set", "start 99 300"), /Invalid zone specified/, "a command for an unknown zone should throw");
  });

  test("the set handler throws on an unknown command", async (t) => {

    const h = buildController({ mqtt: true, program: (recorder) => recorder.programDefault("statusschedule.php",
      { body: schedule([runningZone()]), kind: "response" }), signalAborted: false });

    t.after(() => h.abort());

    assert.ok(h.mqtt, "the MQTT recorder should be attached");
    const mqtt = h.mqtt;

    await settleUntil(() => h.accessory.getServiceById(Service.Valve, "700001") !== undefined, { description: "the valve for zone 700001 to appear" });
    await assert.rejects(() => mqtt.invokeSet("controller/set", "toggle 1"), /Invalid command/, "an unknown command should throw");
  });

  test("each poll publishes the controller status", async (t) => {

    const h = buildController({ mqtt: true, program: (recorder) => recorder.programDefault("statusschedule.php",
      { body: schedule([runningZone()]), kind: "response" }), signalAborted: false });

    t.after(() => h.abort());

    assert.ok(h.mqtt, "the MQTT recorder should be attached");
    const mqtt = h.mqtt;

    await settleUntil(() => mqtt.publishedTo("controller").length >= 1, { description: "the first MQTT publish" });

    const record = expectAt(mqtt.publishedTo("controller"), 0, "MQTT publish");

    assert.ok(record.topic.endsWith("controller"), "the publish topic should be the controller topic");
    assert.ok(String(record.payload).includes("Alpha"), "the published payload should carry the zone status");
  });

  test("a publish rejection is guarded into the log rather than an unhandled rejection", async (t) => {

    await assertNoUnhandledRejections(async () => {

      const h = buildController({ mqtt: true, program: (recorder) => recorder.programDefault("statusschedule.php",
        { body: schedule([runningZone()]), kind: "response" }), signalAborted: false });

      t.after(() => h.abort());

      assert.ok(h.mqtt, "the MQTT recorder should be attached");
      const mqtt = h.mqtt;

      // Arm the publish rejection before the first poll's publish fires; the client's guarded publish must route it to the log.
      mqtt.publishRejection = new Error("broker gone");

      /* The failure line names the topic it could not reach, and that topic opens with this controller's serial. A household running several controllers reads
       * which one lost its broker from exactly that, so the assertion covers the named topic rather than the generic opening alone.
       */
      const failureLine = "Unable to publish to the MQTT topic " + h.controllerConfig.serial_number + "/controller";

      await settleUntil(() => loggedAt(h.entries, "error", failureLine), { description: "the failure line at error level" });

      assert.ok(loggedAt(h.entries, "error", failureLine), "a rejected publish should be reported by the client's guarded publish, naming its topic");
      assert.equal(mqtt.publishedTo("controller").length, 0, "and nothing should be recorded as published on the controller topic");
      assert.ok(mqtt.rejectedPublishes >= 1, "while the refusal itself is counted");
    });
  });
});

describe("HydrawiseController MQTT availability", () => {

  // The wire-realistic body the rows below poll, whose cadence their clock steps are derived from.
  const status = schedule([runningZone()]);
  const sleep = pollSleep(status);
  const backoff = pollBackoff(status);

  test("a set command is refused while the controller is lost, before it is parsed and with nothing sent", async (t) => {

    const h = buildController({ mqtt: true, program: (recorder) => {

      recorder.program("statusschedule.php", { body: status, kind: "response" });
    }, signalAborted: false });

    t.after(() => h.abort());

    const mqtt = present(h.mqtt, "the MQTT recorder");

    // A good poll, then a run of failures long enough to read lost.
    await advanceThroughSchedule(h.clock,[ sleep, backoff, backoff ]);

    assert.equal(logCount(h.entries, "info", "Hydrawise has stopped responding for this controller."), 1, "the controller reads lost");

    // The command names a zone the last good poll reported, so the only thing that can refuse it is the verdict.
    await assert.rejects(() => mqtt.invokeSet("controller/set", "start 1 300"), /^Error: MQTT: The controller is not responding\.$/,
      "a command is refused while the controller is not responding");

    assert.equal(h.commands.calls.length, 0, "and no setzone command is sent");
  });

  test("a new broker session restates the current word, retained", async (t) => {

    const h = buildController({ mqtt: true, program: (recorder) => recorder.programDefault("statusschedule.php", { body: status,
      kind: "response" }), signalAborted: false });

    t.after(() => h.abort());

    const mqtt = present(h.mqtt, "the MQTT recorder");
    const topic = h.controllerConfig.serial_number + "/availability";

    await advanceThroughSchedule(h.clock,[]);

    const before = mqtt.publishedTo(topic).length;

    assert.equal(mqtt.publishedTo(topic).at(-1)?.payload, "online", "the first poll has stated the controller online");

    // The session drops and returns. The client clears its change-gated memory on the new session, so the restatement goes out although nothing moved.
    mqtt.connected = false;
    mqtt.connected = true;

    await advanceThroughSchedule(h.clock,[]);

    assert.equal(mqtt.publishedTo(topic).length, before + 1, "the new session carries one restatement");
    assert.deepEqual(mqtt.publishedTo(topic).at(-1), { payload: "online", retain: true, topic }, "of the current word, retained");
  });

  test("a teardown leaves a retained offline as the last word on the controller's availability topic", async (t) => {

    const h = buildController({ mqtt: true, program: (recorder) => recorder.programDefault("statusschedule.php", { body: status,
      kind: "response" }), signalAborted: false });

    t.after(() => h.abort());

    const mqtt = present(h.mqtt, "the MQTT recorder");
    const topic = h.controllerConfig.serial_number + "/availability";

    await advanceThroughSchedule(h.clock,[]);

    assert.equal(mqtt.publishedTo(topic).at(-1)?.payload, "online", "the first poll has stated the controller online");

    // The lever ends the double before it aborts the platform's signal, as shutdown ends the client, so the final word goes out while the session still holds.
    await h.abort();

    assert.deepEqual(mqtt.publishedTo(topic).at(-1), { payload: "offline", retain: true, topic }, "the last word on the topic is the retained offline");
  });

  test("a verdict change inside the end's window, from a poll or a reconnect, publishes nothing behind the final word", async (t) => {

    // The first poll fails, so the controller still reads offline when the end begins, and the poll after the first-run backoff answers, so a poll landing inside
    // the window moves the verdict.
    const h = buildController({ mqtt: true, program: (recorder) => {

      recorder.program("statusschedule.php", { kind: "null" });
      recorder.programDefault("statusschedule.php", { body: status, kind: "response" });
    }, signalAborted: false });

    // The hold's release, a no-op until the hold is taken, is called by the teardown before it awaits the lever, so an assertion failing ahead of the release
    // below fails at once rather than leaving the end parked on a clock nothing advances until the test times out. The release is safe to call more than once.
    let release = (): void => undefined;

    t.after(async () => {

      release();
      await h.abort();
    });

    const mqtt = present(h.mqtt, "the MQTT recorder");
    const topic = h.controllerConfig.serial_number + "/availability";

    await advanceThroughSchedule(h.clock,[]);

    const before = mqtt.publishedTo(topic).length;

    /* Hold every publish in flight, so the end's window stays open with the final word parked in it, where a real word sits while mqtt.js writes it. Inside the
     * window a good poll lands and moves the verdict to reachable, and the broker session drops and returns, which clears the change-gated memory and runs the
     * connect restatement. Released, the held publishes are recorded in the order they were issued.
     */
    release = mqtt.holdPublishes();

    // The double arms the end's grace on the row's clock, so the row opens the end itself with a grace past the first-run backoff: the advance below then wakes
    // the poll inside the window rather than crossing the grace. The lever's own end() call is handed this same end, as every call after the first is.
    void mqtt.end({ grace: 2 * HYDRAWISE_API_RETRY_INTERVAL * 1000 });

    const ending = h.abort();

    await advanceThroughSchedule(h.clock,[HYDRAWISE_API_RETRY_INTERVAL * 1000]);

    assert.equal(h.retrieve.callsTo("statusschedule.php").length, 2, "a good poll has landed inside the end's window");
    assert.equal(h.controller.unavailable, false, "and moved the verdict to reachable");

    mqtt.connected = false;
    mqtt.connected = true;

    release();
    await ending;

    assert.deepEqual(mqtt.publishedTo(topic).slice(before), [{ payload: "offline", retain: true, topic }], "the final word is the only word stated once the end began");
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

    await settleUntil(() => h.accessory.getServiceById(Service.Valve, "700001") !== undefined, { description: "the valve for zone 700001 to appear" });

    assert.deepEqual(await payloadOf(h), [ { name: "Alpha", relay: 1, run: 0, time: HYDRAWISE_UNSCHEDULED_SENTINEL, timestr: "" },
      { name: "Beta", relay: 2, run: 0, time: HYDRAWISE_UNSCHEDULED_SENTINEL, timestr: "" } ], "no additive key reaches a key-based install");
  });

  test("a credentialed install carries the classified state, and the suspension lands on its OWN zone", async (t) => {

    const h = buildController({ hasV2Client: true, mqtt: true,
      program: (recorder) => recorder.programDefault("statusschedule.php", { body: schedule(sentinelPair()), kind: "response" }), signalAborted: false });

    t.after(() => h.abort());

    await settleUntil(() => h.accessory.getServiceById(Service.Valve, "700001") !== undefined, { description: "the valve for zone 700001 to appear" });

    h.controller.applyFacts({ facts: oneSuspended(), fetchedAt: Math.floor(h.clock.now() / 1000) });

    const parsed = await payloadOf(h);

    /* Attribution is the claim, so each zone is checked individually: the suspended zone carries its own instant and its sibling carries none at all. A substring
     * check against the whole payload could not tell a correctly attributed instant from one landed on the wrong zone.
     */
    assert.equal(parsed[0]?.state, "suspended", "the suspended zone reports its classified state");
    assert.equal(parsed[0].suspendedUntil, SUSPENDED_UNTIL, "and carries its own suspension instant");
    assert.equal(parsed[1]?.state, "unscheduled", "its sibling reports its own state");
    assert.ok(!("suspendedUntil" in parsed[1]), "and carries no suspension instant at all");

    // The zone's base wire fields are untouched beneath the additions, which is what makes this sharpening additive rather than a reshaping.
    assert.equal(parsed[0].name, "Alpha", "the wire name is unchanged");
    assert.equal(parsed[0].time, HYDRAWISE_UNSCHEDULED_SENTINEL, "and so is the wire time");
  });

  test("a credentialed install whose snapshot has aged out publishes the key-based payload byte for byte", async (t) => {

    /* The freshness gate's whole job. The credentials are configured and the projection exists either way, so without the gate a stale snapshot would go on
     * publishing classifications nothing is left to confirm.
     */
    const h = buildController({ hasV2Client: true, mqtt: true,
      program: (recorder) => recorder.programDefault("statusschedule.php", { body: schedule(sentinelPair()), kind: "response" }), signalAborted: false });

    t.after(() => h.abort());

    await settleUntil(() => h.accessory.getServiceById(Service.Valve, "700001") !== undefined, { description: "the valve for zone 700001 to appear" });

    h.controller.applyFacts({ facts: oneSuspended(), fetchedAt: Math.floor(h.clock.now() / 1000) - (HYDRAWISE_V2_FACTS_TTL + 1) });

    assert.deepEqual(await payloadOf(h), [ { name: "Alpha", relay: 1, run: 0, time: HYDRAWISE_UNSCHEDULED_SENTINEL, timestr: "" },
      { name: "Beta", relay: 2, run: 0, time: HYDRAWISE_UNSCHEDULED_SENTINEL, timestr: "" } ], "an expired snapshot publishes exactly what a key-based install does");
  });
});
