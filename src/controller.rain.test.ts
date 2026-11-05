/* Copyright(C) 2017-2026, HJD (https://github.com/hjdhjd). All rights reserved.
 *
 * controller.rain.test.ts: The rain sensors a controller carries: each sensor the account lists as a contact sensor on the controller's accessory, the answers that may
 * add or remove one, the read that refuses whenever the account's facts cannot vouch for it and the commands that keep going behind that refusal, the option and the
 * login that gate it, its MQTT topic, its name under Sync Name, the availability word that reads one verdict with the refusal, and the lines that say why the controller
 * stopped responding.
 */

// The Hydrawise API wire shapes use snake_case keys such as relay_id, so camelcase is disabled here to let the zone fixtures mirror the wire verbatim.
/* eslint-disable camelcase */
import { Characteristic, Service, buildController, makeV2Facts } from "./testing/platform.helpers.ts";
import { HAPStatus, getServiceName } from "homebridge-plugin-utils";
import { HYDRAWISE_API_JITTER, HYDRAWISE_V2_FACTS_GRACE, HYDRAWISE_V2_REFRESH_INTERVAL } from "./settings.ts";
import type { Characteristic as HapCharacteristic, Service as HapService, PlatformAccessory } from "homebridge";
import type { HydrawiseControllerV2Facts, HydrawiseV2ErrorPath, HydrawiseV2Sensor, StatusScheduleResponse } from "./types.ts";
import { TestClock, advanceThroughSchedule, hapStatus, linesAt, logCount, present, settle, triggerGet, triggerSet } from "homebridge-plugin-utils/testing";
import { bareSensors, syntheticController } from "./api.fixtures.ts";
import { controllerV2Facts, rainSensorSubtype } from "./types.ts";
import { describe, test } from "node:test";
import { makeStatusSchedule, makeZone } from "./api.helpers.ts";
import type { BuildControllerResult } from "./testing/platform.helpers.ts";
import type { Nullable } from "homebridge-plugin-utils";
import assert from "node:assert/strict";

const CONTROLLER_SERIAL = syntheticController.serial_number;
const SENSOR_ID = 394649;
const SENSOR_NAME = "Hunter Rain Freeze Sensor";
const SECOND_SENSOR_ID = 394650;
const SECOND_SENSOR_NAME = "Back Fence Sensor";
const RAIN_TOPIC = CONTROLLER_SERIAL + "/rainsensors";

// The span a reading stays current for, stated from its parts rather than through the lifetime's own constant, so a lifetime that lost its grace reads short here.
const LIFETIME = (HYDRAWISE_V2_REFRESH_INTERVAL * 2) + HYDRAWISE_V2_FACTS_GRACE;

const NOT_RESPONDING_LINE = "Rain sensors are not responding because your Hydrawise account details could not be refreshed.";
const RESPONDING_LINE = "Rain sensors are responding again.";
const RESTORED_LINE = "Restored the name the plugin owns for a service after the Home app renamed it.";

// The refusal HomeKit renders as No Response.
const noResponse = hapStatus(HAPStatus.SERVICE_COMMUNICATION_FAILURE);

// The contact states a rain sensor reads. A tripped sensor reads open, the polarity the family's moisture sensor takes.
const OPEN = Characteristic.ContactSensorState.CONTACT_NOT_DETECTED;
const CLOSED = Characteristic.ContactSensorState.CONTACT_DETECTED;

// A wire-realistic body carrying one zone, so a row driving its own clock steps the polling loop rather than racing a fast cadence.
const status = makeStatusSchedule({ relays: [makeZone({ name: "Front Lawn", relay: 1, relay_id: 700001 })], sensors: bareSensors });
const sleep = (status.nextpoll + HYDRAWISE_API_JITTER) * 1000;

// The same zone scheduled rather than running, so its valve shows the duration a tap runs it for.
const SCHEDULED = makeStatusSchedule({ relays: [makeZone({ name: "Front Lawn", relay: 1, relay_id: 700001, run: 480, time: 68000, timestr: "16:00" })],
  sensors: bareSensors });

// The captured sensor as the account lists it, on the wire and as the facts carry it.
const LISTING = makeV2Facts({ rainSensors: [[ SENSOR_ID, { name: SENSOR_NAME, tripped: true } ]] });
const WIRE_SENSOR = { id: SENSOR_ID, model: { sensorType: "LEVEL_CLOSED" }, name: SENSOR_NAME, status: { active: true }, zones: [{ id: 700001 }] };

// One controller's facts composed from a sensor list as the account answered it. The wire types state the schema, which marks a sensor's model and id as never null, so
// the cast is what lets a row state a nulled one.
function wireFacts(sensors: readonly unknown[] | undefined, errorPaths: readonly HydrawiseV2ErrorPath[] = []): HydrawiseControllerV2Facts {

  return controllerV2Facts({ id: 1058515, sensors: sensors as Nullable<HydrawiseV2Sensor>[] | undefined, zones: [] }, errorPaths);
}

// The whole second a clock reads, the unit every facts stamp speaks.
function seconds(clock: TestClock): number {

  return Math.floor(clock.now() / 1000);
}

// The instant a row that cares only about adoption stamps its facts with, comfortably inside the lifetime.
function now(): number {

  return Math.floor(Date.now() / 1000);
}

// A controller polling the body above on a clock the row drives.
function onClock(clock: TestClock, { body = status, ...options }: { body?: StatusScheduleResponse; hasV2Client?: boolean;
  seedContext?: (accessory: PlatformAccessory) => void; userOptions?: string[]; } = {}): BuildControllerResult {

  return buildController({ ...options, clock, mqtt: true, program: (recorder) => {

    recorder.programDefault("statusschedule.php", { body, kind: "response" });
  }, signalAborted: false });
}

// Seed an accessory with the rain sensor a previous session left in the cache.
function seedCachedSensor(accessory: PlatformAccessory): void {

  accessory.addService(new Service.ContactSensor(SENSOR_NAME, rainSensorSubtype(SENSOR_ID)));
}

// A rain sensor's service on the controller's accessory, or undefined where it carries none.
function sensorOf(h: BuildControllerResult, id = SENSOR_ID): HapService | undefined {

  return h.accessory.getServiceById(Service.ContactSensor, rainSensorSubtype(id));
}

// A rain sensor's contact state.
function stateOf(h: BuildControllerResult, id = SENSOR_ID): HapCharacteristic {

  return present(sensorOf(h, id), "the rain sensor").getCharacteristic(Characteristic.ContactSensorState);
}

// Every rain-class contact sensor the accessory carries.
function rainServices(h: BuildControllerResult): HapService[] {

  return h.accessory.services.filter(service => service.UUID === Service.ContactSensor.UUID);
}

// The irrigation system's Active, the characteristic that answers for the controller's own handlers.
function primary(h: BuildControllerResult): HapCharacteristic {

  return present(h.accessory.getService(Service.IrrigationSystem), "the irrigation system").getCharacteristic(Characteristic.Active);
}

// The last availability word published on this controller's own topic.
function lastWord(h: BuildControllerResult): unknown {

  return present(h.mqtt, "the MQTT recorder").publishedTo(CONTROLLER_SERIAL + "/availability").at(-1)?.payload;
}

// Every payload the rain sensors topic has carried.
function rainPayloads(h: BuildControllerResult): unknown[] {

  return present(h.mqtt, "the MQTT recorder").publishedTo(RAIN_TOPIC).map(entry => entry.payload);
}

// The rain lines at info, each with the prefix that names the controller left off.
function rainLines(h: BuildControllerResult): string[] {

  const prefix = syntheticController.name + ": ";

  return linesAt(h.entries, "info").filter(line => line.includes("Rain sensors")).map(line => line.replace(prefix, ""));
}

// Rename a service in the Home app, the way a HomeKit controller's write reaches it, and let the event loop's next turn pass, which is when a watch restores.
async function renameInHomeApp(service: HapService, name: string): Promise<void> {

  await triggerSet(service.getCharacteristic(Characteristic.ConfiguredName), name);
  await settle();
}

describe("HydrawiseController rain sensors in HomeKit", () => {

  test("each listed rain sensor is a contact sensor under its subtype, named by Hydrawise, tripped reading open and clear reading closed", () => {

    const h = buildController({ hasV2Client: true });

    h.controller.applyFacts({ facts: makeV2Facts({ rainSensors: [ [ SENSOR_ID, { name: SENSOR_NAME, tripped: true } ],
      [ SECOND_SENSOR_ID, { name: SECOND_SENSOR_NAME, tripped: false } ] ] }), fetchedAt: now() });

    assert.equal(getServiceName(sensorOf(h)), SENSOR_NAME, "the tripped sensor carries its Hydrawise name");
    assert.equal(stateOf(h).value, OPEN, "and reads open");
    assert.equal(getServiceName(sensorOf(h, SECOND_SENSOR_ID)), SECOND_SENSOR_NAME, "the clear sensor carries its own name");
    assert.equal(stateOf(h, SECOND_SENSOR_ID).value, CLOSED, "and reads closed");

    h.controller.applyFacts({ facts: makeV2Facts({ rainSensors: [ [ SENSOR_ID, { name: SENSOR_NAME, tripped: false } ],
      [ SECOND_SENSOR_ID, { name: SECOND_SENSOR_NAME, tripped: true } ] ] }), fetchedAt: now() });

    assert.equal(stateOf(h).value, CLOSED, "a facts arrival writes each listed value");
    assert.equal(stateOf(h, SECOND_SENSOR_ID).value, OPEN, "whichever way it moved");
  });

  test("an add and a removal each mark the accessory for a save, and a tick that moves neither marks nothing for the sensors", () => {

    const h = buildController({ hasV2Client: true });
    const settled = h.flushes().length;

    h.controller.applyFacts({ facts: LISTING, fetchedAt: now() });
    assert.equal(h.flushes().length - settled, 1, "a sensor added is saved");

    const added = h.flushes().length;

    h.controller.applyFacts({ facts: LISTING, fetchedAt: now() });
    assert.equal(h.flushes().length - added, 0, "an unchanged list saves nothing");

    h.controller.applyFacts({ facts: makeV2Facts(), fetchedAt: now() });
    assert.equal(h.flushes().length - added, 1, "a sensor removed is saved");
  });

  test("complete facts that no longer list a sensor remove it, whatever else the accessory carries", () => {

    const h = buildController({ hasV2Client: true, userOptions: ["Enable.Device.Suspend.All"] });

    h.controller.applyFacts({ facts: makeV2Facts({ rainSensors: [ [ SENSOR_ID, { name: SENSOR_NAME, tripped: false } ],
      [ SECOND_SENSOR_ID, { name: SECOND_SENSOR_NAME, tripped: false } ] ] }), fetchedAt: now() });
    h.controller.applyFacts({ facts: makeV2Facts({ rainSensors: [[ SECOND_SENSOR_ID, { name: SECOND_SENSOR_NAME, tripped: false } ]] }), fetchedAt: now() });

    assert.equal(sensorOf(h), undefined, "the sensor the list dropped is removed");
    assert.ok(sensorOf(h, SECOND_SENSOR_ID), "the sensor it still names stays");
    assert.ok(h.accessory.getServiceById(Service.Switch, "All"), "and the suspend-all switch is no business of the sweep");

    h.controller.applyFacts({ facts: wireFacts([{ ...WIRE_SENSOR, model: { sensorType: "FLOW_METER" } }]), fetchedAt: now() });

    assert.equal(rainServices(h).length, 0, "a complete list naming only a sensor of another kind lists no rain sensor");
  });

  for(const [ label, facts ] of [

    [ "held a null entry", wireFacts([ WIRE_SENSOR, null ]) ],
    [ "carried an error under its sensors", wireFacts([WIRE_SENSOR], [[ "sensors", 0, "name" ]]) ],
    [ "carried a nulled sensorType with its error", wireFacts([{ ...WIRE_SENSOR, model: { sensorType: null } }], [[ "sensors", 0, "model", "sensorType" ]]) ],
    [ "carried a nulled model with its error", wireFacts([{ ...WIRE_SENSOR, model: null }], [[ "sensors", 0, "model" ]]) ],
    [ "carried a nulled id", wireFacts([{ ...WIRE_SENSOR, id: null }]) ],
    [ "carried an activity that is not a boolean", wireFacts([{ ...WIRE_SENSOR, status: { active: null } }]) ],
    [ "carried a sensor covering a null entry", wireFacts([{ ...WIRE_SENSOR, zones: [null] }]) ],
    [ "left the list out", wireFacts(undefined) ]
  ] as const) {

    test("facts that " + label + " keep a hosted sensor, with no throw", () => {

      const h = buildController({ hasV2Client: true });

      h.controller.applyFacts({ facts: LISTING, fetchedAt: now() });

      const hosted = sensorOf(h);

      assert.equal(facts.rainSensors, null, "the answer cannot say which sensors exist");
      assert.doesNotThrow(() => h.controller.applyFacts({ facts, fetchedAt: now() }), "no throw ends the refresh");
      assert.equal(sensorOf(h), hosted, "the sensor stays, the same service");
    });
  }

  // A sensor with no type, in each shape a read with no error beside it can answer that: a kind of null, or no model to carry one.
  for(const [ label, untyped ] of [

    [ "a nulled sensorType", { ...WIRE_SENSOR, id: SECOND_SENSOR_ID, model: { sensorType: null } } ],
    [ "a nulled model", { ...WIRE_SENSOR, id: SECOND_SENSOR_ID, model: null } ]
  ] as const) {

    test("a sensor with " + label + " and no error beside it counts as none, and the rain sensor beside it is listed and reads", async (t) => {

      const clock = new TestClock();
      const h = onClock(clock, { hasV2Client: true });
      const facts = wireFacts([ WIRE_SENSOR, untyped ]);

      t.after(() => h.abort());

      await advanceThroughSchedule(clock, []);

      assert.deepEqual(facts.rainSensors, new Map([[ SENSOR_ID, { name: SENSOR_NAME, tripped: true } ]]), "the list names the rain sensor alone");

      h.controller.applyFacts({ facts, fetchedAt: seconds(clock) });

      assert.equal(await triggerGet(stateOf(h)), OPEN, "the rain sensor reads");
      assert.equal(sensorOf(h, SECOND_SENSOR_ID), undefined, "and the other has no service");
    });

    test("a list holding only a sensor with " + label + " hosts nothing and leaves the word online", async (t) => {

      const clock = new TestClock();
      const h = onClock(clock, { hasV2Client: true });
      const facts = wireFacts([untyped]);

      t.after(() => h.abort());

      await advanceThroughSchedule(clock, []);

      assert.deepEqual(facts.rainSensors, new Map(), "it is a complete answer that lists none");

      h.controller.applyFacts({ facts, fetchedAt: seconds(clock) });

      assert.equal(rainServices(h).length, 0, "so nothing is hosted");
      assert.equal(lastWord(h), "online", "and nothing refuses");

      // A sensor hosted before such a list is one the complete list no longer names, so it goes rather than refusing for good.
      h.controller.applyFacts({ facts: LISTING, fetchedAt: seconds(clock) });
      h.controller.applyFacts({ facts, fetchedAt: seconds(clock) });

      assert.equal(rainServices(h).length, 0, "a hosted sensor the list no longer names is removed");
      assert.equal(lastWord(h), "online", "with the word still online");
    });
  }

  test("a sensor with no type stops nothing in the zone classification, and with no rain sensor beside it every zone is left unknown", () => {

    const untyped = { ...WIRE_SENSOR, id: SECOND_SENSOR_ID, model: { sensorType: null }, zones: [{ id: 700002 }] };
    const zonesOf = (sensors: Nullable<HydrawiseV2Sensor>[]): HydrawiseControllerV2Facts["zones"] => {

      return controllerV2Facts({ id: 1058515, sensors, zones: [ { id: 700001 }, { id: 700002 } ] }).zones;
    };

    assert.equal(zonesOf([ WIRE_SENSOR, untyped ]).get(700001)?.sensorStopped, true, "the rain sensor stops the zone it covers");
    assert.equal(zonesOf([ WIRE_SENSOR, untyped ]).get(700002)?.sensorStopped, false, "and the zone only the other covers is not stopped");
    assert.equal(zonesOf([untyped]).get(700002)?.sensorStopped, null, "alone, it leaves the question to the key-based inference");
  });

  test("facts with a null map add nothing, and aged facts add and remove nothing", () => {

    const h = buildController({ hasV2Client: true });

    h.controller.applyFacts({ facts: makeV2Facts({ rainSensors: null }), fetchedAt: now() });
    assert.equal(rainServices(h).length, 0, "an answer that cannot say which sensors exist adds none");

    h.controller.applyFacts({ facts: LISTING, fetchedAt: now() - LIFETIME - 1 });
    assert.equal(rainServices(h).length, 0, "facts past their lifetime add none");

    h.controller.applyFacts({ facts: LISTING, fetchedAt: now() });
    h.controller.applyFacts({ facts: makeV2Facts(), fetchedAt: now() - LIFETIME - 1 });
    assert.ok(sensorOf(h), "and remove none");
  });

  test("the account's list composes each counted sensor by id, with its name trimmed to null when empty, and passes over other kinds", () => {

    const facts = wireFacts([ { ...WIRE_SENSOR, name: "  " + SENSOR_NAME + "  " },
      { ...WIRE_SENSOR, id: SECOND_SENSOR_ID, name: "   ", status: { active: false } },
      { ...WIRE_SENSOR, id: 394651, model: { sensorType: "FLOW_METER" } } ]);

    assert.deepEqual(facts.rainSensors, new Map([ [ SENSOR_ID, { name: SENSOR_NAME, tripped: true } ], [ SECOND_SENSOR_ID, { name: null, tripped: false } ] ]),
      "the map holds exactly the sensors the zone classification counts");
    assert.deepEqual(wireFacts([]).rainSensors, new Map(), "an empty list is a complete answer that lists none");
  });
});

describe("HydrawiseController rain sensor refusal", () => {

  test("the read answers through the facts' whole lifetime and refuses a second past it, while the irrigation system still answers", async (t) => {

    const clock = new TestClock();
    const h = onClock(clock, { hasV2Client: true });

    t.after(() => h.abort());

    await advanceThroughSchedule(clock, []);

    h.controller.applyFacts({ facts: LISTING, fetchedAt: seconds(clock) - LIFETIME });

    assert.equal(await triggerGet(stateOf(h)), OPEN, "a reading aged exactly its lifetime still answers");

    clock.advance(1000);

    await assert.rejects(() => triggerGet(stateOf(h)), noResponse, "a second past it, the sensor refuses");
    assert.equal(await triggerGet(primary(h)), Characteristic.Active.ACTIVE, "while the irrigation system's own handler still answers");
  });

  test("a valve tap, a Suspend All tap and an MQTT start are each sent while the sensor's read refuses, with no line refusing a command", async (t) => {

    const clock = new TestClock();
    const h = onClock(clock, { body: SCHEDULED, hasV2Client: true, userOptions: ["Enable.Device.Suspend.All." + CONTROLLER_SERIAL] });
    const mqtt = present(h.mqtt, "the MQTT recorder");

    t.after(() => h.abort());

    await advanceThroughSchedule(clock, []);

    h.controller.applyFacts({ facts: LISTING, fetchedAt: seconds(clock) - LIFETIME });
    clock.advance(1000);

    await assert.rejects(() => triggerGet(stateOf(h)), noResponse, "the reading is a second past its lifetime, so the sensor's read refuses");

    // Each command settles before the next is made, so none can stand in for another in the queue.
    await triggerSet(present(h.accessory.getServiceById(Service.Valve, "700001"), "the valve").getCharacteristic(Characteristic.Active), Characteristic.Active.ACTIVE);
    await h.controller.commandsIdle;
    await triggerSet(present(h.accessory.getServiceById(Service.Switch, "All"), "the Suspend All switch").getCharacteristic(Characteristic.On), true);
    await h.controller.commandsIdle;
    await mqtt.invokeSet("controller/set", "start 1 300");
    await h.controller.commandsIdle;

    assert.deepEqual(h.commands.params.map(params => params["action"]), [ "run", "suspendall", "run" ], "the queue sends each one to Hydrawise");

    // The rain sensors' own line at info says why the accessory reads No Response, so a line refusing a command is read at the levels a refusal is said at.
    assert.equal(logCount(h.entries, "warn", "not responding"), 0, "no command is dropped for a controller that is not responding");
    assert.equal(logCount(h.entries, "error", "not responding"), 0, "and none is refused");
    assert.equal(lastWord(h), "offline", "though the word reads what the sensor's read reads");
  });

  test("the read refuses while the controller is unavailable, before first contact and on the cloud's offline word", async (t) => {

    const pending = buildController({ hasV2Client: true });

    pending.controller.applyFacts({ facts: LISTING, fetchedAt: now() });
    await assert.rejects(() => triggerGet(stateOf(pending)), noResponse, "no poll has landed, so a current reading still refuses");

    const clock = new TestClock();
    const h = onClock(clock, { hasV2Client: true });

    t.after(() => h.abort());

    await advanceThroughSchedule(clock, []);

    h.controller.applyFacts({ facts: makeV2Facts({ online: false, rainSensors: [[ SENSOR_ID, { name: SENSOR_NAME, tripped: true } ]] }), fetchedAt: seconds(clock) });
    await assert.rejects(() => triggerGet(stateOf(h)), noResponse, "and neither does a current reading answer once the cloud says the controller is offline");
  });

  test("a cached sensor refuses with the first poll landed and no facts, and a null map, until a reading lands", async (t) => {

    const clock = new TestClock();
    const h = onClock(clock, { hasV2Client: true, seedContext: seedCachedSensor });
    const cached = sensorOf(h);

    t.after(() => h.abort());

    await advanceThroughSchedule(clock, []);

    assert.equal(h.retrieve.callsTo("statusschedule.php").length, 1, "the first poll has landed");
    await assert.rejects(() => triggerGet(stateOf(h)), noResponse, "the cached sensor refuses with no facts in hand");
    assert.equal(await triggerGet(primary(h)), Characteristic.Active.ACTIVE, "while the irrigation system's own handler answers");

    h.controller.applyFacts({ facts: makeV2Facts({ rainSensors: null }), fetchedAt: seconds(clock) });
    await assert.rejects(() => triggerGet(stateOf(h)), noResponse, "an answer that cannot say which sensors exist leaves it refusing");

    h.controller.applyFacts({ facts: LISTING, fetchedAt: seconds(clock) });

    assert.equal(sensorOf(h), cached, "the listed sensor is the service the cache restored, not a new one");
    assert.equal(await triggerGet(stateOf(h)), OPEN, "and it answers once a reading lands");
  });
});

describe("HydrawiseController rain sensor option and login", () => {

  test("with the option off, no sensor exists whatever the facts list, a cached one is removed and saved, and one line says so", async (t) => {

    const clock = new TestClock();
    const h = onClock(clock, { hasV2Client: true, seedContext: seedCachedSensor, userOptions: [ "Disable.Device.Sensor.Rain", "Enable.Device.SyncName" ] });

    t.after(() => h.abort());

    assert.equal(rainServices(h).length, 0, "the cached sensor is removed at construction");
    assert.ok(h.flushes().at(-1)?.includes(h.accessory), "and the removal is saved");

    await advanceThroughSchedule(clock, []);

    h.controller.applyFacts({ facts: LISTING, fetchedAt: seconds(clock) });
    await advanceThroughSchedule(clock, [sleep]);

    assert.equal(rainServices(h).length, 0, "a listed sensor is not added");
    assert.equal(logCount(h.entries, "info", "Rain sensors disabled."), 1, "the option off logs its one line");
    assert.equal(lastWord(h), "online", "no sensor carried, so the word is the controller's own");
    assert.deepEqual(rainPayloads(h), [], "nothing is published on the rain sensors topic");
    assert.equal(present(h.mqtt, "the MQTT recorder").subscriptions.some(entry => entry.topic === RAIN_TOPIC + "/get"), false, "and its get is not subscribed");
  });

  test("with no credentials, no sensor exists, a cached one is removed, and no line is written, whatever the option says", async (t) => {

    const clock = new TestClock();
    const h = onClock(clock, { seedContext: seedCachedSensor, userOptions: ["Disable.Device.Sensor.Rain"] });

    t.after(() => h.abort());

    assert.equal(rainServices(h).length, 0, "the cached sensor is removed at construction");

    await advanceThroughSchedule(clock, []);

    // No client exists here to hand facts over, so this states what one would have said.
    h.controller.applyFacts({ facts: LISTING, fetchedAt: seconds(clock) });

    assert.equal(rainServices(h).length, 0, "a listed sensor is not added");
    assert.equal(logCount(h.entries, "info", "Rain sensors"), 0, "an install with no account login is not told about a feature it does not have");
    assert.deepEqual(rainPayloads(h), [], "and nothing is published on the rain sensors topic");
  });

  test("at the default, the option writes no line", () => {

    const h = buildController({ hasV2Client: true });

    h.controller.applyFacts({ facts: LISTING, fetchedAt: now() });

    assert.ok(sensorOf(h), "the sensor exists at the default");
    assert.equal(logCount(h.entries, "info", "Rain sensors"), 0, "and the default is restated nowhere");
  });
});

describe("HydrawiseController rain sensors topic", () => {

  test("publishes the sensor when facts land, nothing for an unchanged tick, an empty array at the first poll after they age out, and answers its get", async (t) => {

    const clock = new TestClock();
    const h = onClock(clock, { hasV2Client: true });
    const mqtt = present(h.mqtt, "the MQTT recorder");
    const captured = "[{\"id\":394649,\"name\":\"Hunter Rain Freeze Sensor\",\"tripped\":true}]";

    t.after(() => h.abort());

    await advanceThroughSchedule(clock, []);

    assert.deepEqual(rainPayloads(h), ["[]"], "the first poll has no reading to state");
    assert.equal(await mqtt.invokeGet(RAIN_TOPIC + "/get"), "[]", "and the get answers the same");

    h.controller.applyFacts({ facts: LISTING, fetchedAt: seconds(clock) - LIFETIME });

    assert.equal(rainPayloads(h).at(-1), captured, "facts carrying the sensor publish it");
    assert.equal(await mqtt.invokeGet(RAIN_TOPIC + "/get"), captured, "and the get answers it");

    const published = rainPayloads(h).length;

    h.controller.applyFacts({ facts: LISTING, fetchedAt: seconds(clock) - LIFETIME });

    assert.equal(rainPayloads(h).length, published, "an unchanged tick publishes nothing");

    await advanceThroughSchedule(clock, [sleep]);

    assert.equal(rainPayloads(h).at(-1), "[]", "the first poll after the reading ages out publishes the empty array");
  });

  test("an answer that cannot say which sensors exist publishes the empty array, and a sensor with no usable name publishes a null name", async (t) => {

    const clock = new TestClock();
    const h = onClock(clock, { hasV2Client: true });

    t.after(() => h.abort());

    await advanceThroughSchedule(clock, []);

    h.controller.applyFacts({ facts: makeV2Facts({ rainSensors: [[ SENSOR_ID, { name: null, tripped: false } ]] }), fetchedAt: seconds(clock) });
    assert.equal(rainPayloads(h).at(-1), "[{\"id\":394649,\"name\":null,\"tripped\":false}]", "a sensor with no usable name states it as null");

    h.controller.applyFacts({ facts: makeV2Facts({ rainSensors: null }), fetchedAt: seconds(clock) });
    assert.equal(rainPayloads(h).at(-1), "[]", "and a null map states no reading");
  });
});

describe("HydrawiseController rain sensor names", () => {

  test("with Sync Name on, a sensor renamed in Hydrawise is renamed at the next poll and held there", async (t) => {

    const clock = new TestClock();
    const h = onClock(clock, { hasV2Client: true, userOptions: ["Enable.Device.SyncName"] });

    t.after(() => h.abort());

    await advanceThroughSchedule(clock, []);

    h.controller.applyFacts({ facts: LISTING, fetchedAt: seconds(clock) });
    h.controller.applyFacts({ facts: makeV2Facts({ rainSensors: [[ SENSOR_ID, { name: SECOND_SENSOR_NAME, tripped: true } ]] }), fetchedAt: seconds(clock) });

    const sensor = present(sensorOf(h), "the rain sensor");

    assert.equal(getServiceName(sensor), SENSOR_NAME, "a refresh tick renames nothing, so a name held from it cannot fight the poll's");

    const saved = h.flushes().length;

    await advanceThroughSchedule(clock, [sleep]);

    assert.equal(getServiceName(sensor), SECOND_SENSOR_NAME, "the next poll takes the name Hydrawise reports");
    assert.equal(h.flushes().length - saved, 1, "and the rename is saved");

    await renameInHomeApp(sensor, "Rain Gauge");

    assert.equal(getServiceName(sensor), SECOND_SENSOR_NAME, "a rename in the Home app is put back at once");
    assert.equal(logCount(h.entries, "info", RESTORED_LINE), 1, "in one line");
  });

  test("with Sync Name off a Hydrawise rename and a Home app rename each stand as the user's, and a null name decides nothing under it", async (t) => {

    const clock = new TestClock();
    const off = onClock(clock, { hasV2Client: true });

    t.after(() => off.abort());

    await advanceThroughSchedule(clock, []);

    off.controller.applyFacts({ facts: LISTING, fetchedAt: seconds(clock) });
    off.controller.applyFacts({ facts: makeV2Facts({ rainSensors: [[ SENSOR_ID, { name: SECOND_SENSOR_NAME, tripped: true } ]] }), fetchedAt: seconds(clock) });
    await advanceThroughSchedule(clock, [sleep]);

    const sensor = present(sensorOf(off), "the rain sensor");

    assert.equal(getServiceName(sensor), SENSOR_NAME, "with synchronization off, the poll leaves the name as it stands");

    await renameInHomeApp(sensor, "Rain Gauge");

    assert.equal(getServiceName(sensor), "Rain Gauge", "and a rename made in the Home app stands");

    const syncClock = new TestClock();
    const on = onClock(syncClock, { hasV2Client: true, userOptions: ["Enable.Device.SyncName"] });

    t.after(() => on.abort());

    await advanceThroughSchedule(syncClock, []);

    on.controller.applyFacts({ facts: LISTING, fetchedAt: seconds(syncClock) });
    on.controller.applyFacts({ facts: makeV2Facts({ rainSensors: [[ SENSOR_ID, { name: null, tripped: true } ]] }), fetchedAt: seconds(syncClock) });
    await advanceThroughSchedule(syncClock, [sleep]);

    assert.equal(getServiceName(sensorOf(on)), SENSOR_NAME, "a null name holds the current one, under Sync Name too");
  });

  for(const [ label, name ] of [ [ "punctuation alone", "***" ], [ "an emoji alone", "\u{1F327}" ], [ "nothing", null ] ] as const) {

    test("a sensor whose name holds " + label + " is named by the controller's name followed by Rain Sensor", () => {

      const h = buildController({ hasV2Client: true });

      h.controller.applyFacts({ facts: makeV2Facts({ rainSensors: [[ SENSOR_ID, { name, tripped: false } ]] }), fetchedAt: now() });

      assert.equal(getServiceName(sensorOf(h)), syntheticController.name + " Rain Sensor", "the sensor is created under a name HomeKit can carry");
    });
  }

  test("the fallback composes from the controller's Name option, as the suspend-all switch's name does", () => {

    const h = buildController({ hasV2Client: true, userOptions: ["Enable.Device.Name." + CONTROLLER_SERIAL + "=Garden"] });

    h.controller.applyFacts({ facts: makeV2Facts({ rainSensors: [[ SENSOR_ID, { name: null, tripped: false } ]] }), fetchedAt: now() });

    assert.equal(getServiceName(sensorOf(h)), "Garden Rain Sensor", "the controller's configured name leads the sensor's");
  });
});

describe("HydrawiseController rain sensor verdict and its lines", () => {

  test("the word reads offline at the first poll after a reading ages out and online when facts return, one verdict with the refusal", async (t) => {

    const clock = new TestClock();
    const h = onClock(clock, { hasV2Client: true });

    t.after(() => h.abort());

    await advanceThroughSchedule(clock, []);

    h.controller.applyFacts({ facts: LISTING, fetchedAt: seconds(clock) - LIFETIME });
    assert.equal(lastWord(h), "online", "a current reading leaves the word online");

    clock.advance(1000);

    await assert.rejects(() => triggerGet(stateOf(h)), noResponse, "the reading has aged out, so the sensor refuses at once");
    assert.equal(lastWord(h), "online", "while the word has had no event to re-judge it");

    await advanceThroughSchedule(clock, [sleep - 1000]);

    assert.equal(lastWord(h), "offline", "the next poll re-judges it, so it reads what the refusal reads");

    h.controller.applyFacts({ facts: LISTING, fetchedAt: seconds(clock) });

    assert.equal(lastWord(h), "online", "and facts returning bring it back");
    assert.equal(await triggerGet(stateOf(h)), OPEN, "along with the read");
  });

  test("a cached sensor reads offline from the first poll, on a controller whose poll is good", async (t) => {

    const clock = new TestClock();
    const h = onClock(clock, { hasV2Client: true, seedContext: seedCachedSensor });

    t.after(() => h.abort());

    await advanceThroughSchedule(clock, []);

    assert.equal(lastWord(h), "offline", "the accessory refuses, so the word says so");
  });

  test("with no sensor carried, aged facts leave the word online", async (t) => {

    const clock = new TestClock();
    const h = onClock(clock, { hasV2Client: true });

    t.after(() => h.abort());

    await advanceThroughSchedule(clock, []);

    h.controller.applyFacts({ facts: makeV2Facts(), fetchedAt: seconds(clock) - LIFETIME });
    await advanceThroughSchedule(clock, [sleep]);

    assert.equal(lastWord(h), "online", "the word is as it is with no rain sensors at all");
  });

  test("the rain lines are written once each, in order, across a reading that is current, then gone, then current", async (t) => {

    const clock = new TestClock();
    const h = onClock(clock, { hasV2Client: true });

    t.after(() => h.abort());

    await advanceThroughSchedule(clock, []);

    h.controller.applyFacts({ facts: LISTING, fetchedAt: seconds(clock) - LIFETIME });
    assert.deepEqual(rainLines(h), [], "a first reading is no transition");

    await advanceThroughSchedule(clock, [ sleep, sleep ]);
    assert.deepEqual(rainLines(h), [NOT_RESPONDING_LINE], "the poll that finds the reading gone says why, and the next says nothing further");

    h.controller.applyFacts({ facts: LISTING, fetchedAt: seconds(clock) });
    h.controller.applyFacts({ facts: LISTING, fetchedAt: seconds(clock) });
    assert.deepEqual(rainLines(h), [ NOT_RESPONDING_LINE, RESPONDING_LINE ], "the reading returning says so once");
  });

  test("a process with no reading yet writes neither line, and its first reading writes none", async (t) => {

    const clock = new TestClock();
    const h = onClock(clock, { hasV2Client: true, seedContext: seedCachedSensor });

    t.after(() => h.abort());

    await advanceThroughSchedule(clock, []);
    await advanceThroughSchedule(clock, [sleep]);

    h.controller.applyFacts({ facts: makeV2Facts({ rainSensors: null }), fetchedAt: seconds(clock) });
    assert.deepEqual(rainLines(h), [], "a cached sensor with nothing to read has lost nothing this run");

    h.controller.applyFacts({ facts: LISTING, fetchedAt: seconds(clock) });
    assert.deepEqual(rainLines(h), [], "and a first reading has returned from nothing");
  });

  test("a sensor whose reading aged out and whose list then stops naming it ends the record, so a later age-out or a new sensor writes no second line", async (t) => {

    const clock = new TestClock();
    const h = onClock(clock, { hasV2Client: true });

    t.after(() => h.abort());

    await advanceThroughSchedule(clock, []);

    h.controller.applyFacts({ facts: LISTING, fetchedAt: seconds(clock) - LIFETIME });
    await advanceThroughSchedule(clock, [sleep]);

    assert.deepEqual(rainLines(h), [NOT_RESPONDING_LINE], "the reading ages out, and the first line says why");

    h.controller.applyFacts({ facts: makeV2Facts(), fetchedAt: seconds(clock) - LIFETIME });

    assert.equal(rainServices(h).length, 0, "a complete list drops the sensor");

    await advanceThroughSchedule(clock, [sleep]);

    assert.equal(lastWord(h), "online", "no sensor carried, so the aged facts refuse nothing");

    h.controller.applyFacts({ facts: makeV2Facts({ rainSensors: [[ SECOND_SENSOR_ID, { name: SECOND_SENSOR_NAME, tripped: false } ]] }), fetchedAt: seconds(clock) });

    assert.ok(sensorOf(h, SECOND_SENSOR_ID), "a later list names a new sensor");
    assert.deepEqual(rainLines(h), [NOT_RESPONDING_LINE], "and no second line is written, since a new sensor's first reading has returned from nothing");
  });
});
