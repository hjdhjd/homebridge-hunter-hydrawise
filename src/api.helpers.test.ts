/* Copyright(C) 2017-2026, HJD (https://github.com/hjdhjd). All rights reserved.
 *
 * api.helpers.test.ts: Self-test for the API response factories. Asserts the factory defaults, the override merge, the scenario composers' distinguishing
 * shapes, and the fresh-clone-per-call isolation that keeps production's reassign-and-trim from leaking across tests.
 */

// The Hydrawise API wire shapes use snake_case keys such as relay_id and controller_id, so camelcase is disabled here to let these literals mirror the wire verbatim.
/* eslint-disable camelcase */
import { UNSCHEDULED_SENTINEL, allRelayIds } from "./api.fixtures.ts";
import { allSuspended, makeCustomerDetails, makeStatusSchedule, makeZone, normalSchedule, rainStopped } from "./api.helpers.ts";
import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { expectAt } from "homebridge-plugin-utils/testing";

describe("makeZone", () => {

  test("defaults to a zone running now", () => {

    const zone = makeZone();

    assert.equal(zone.time, 1, "the default zone is running (time 1)");
    assert.equal(zone.run, 600, "the default zone has remaining runtime");
  });

  test("applies overrides over the defaults", () => {

    const zone = makeZone({ relay: 7, relay_id: 700099, time: 3600 });

    assert.equal(zone.relay, 7, "the relay override applies");
    assert.equal(zone.relay_id, 700099, "the relay_id override applies");
    assert.equal(zone.time, 3600, "the time override applies");
  });
});

describe("makeCustomerDetails", () => {

  test("defaults to the single synthetic controller", () => {

    const details = makeCustomerDetails();

    assert.equal(details.controller_id, 500001, "the default controller id is synthetic");
    assert.equal(details.controllers.length, 1, "one controller is present by default");
  });

  test("applies overrides", () => {

    const details = makeCustomerDetails({ customer_id: 111222 });

    assert.equal(details.customer_id, 111222, "the customer_id override applies");
  });
});

describe("makeStatusSchedule", () => {

  test("defaults to the 19-zone matrix at the wire cadence", () => {

    const schedule = makeStatusSchedule();

    assert.equal(schedule.nextpoll, 60, "the default cadence is the wire-realistic 60 seconds");
    assert.equal(schedule.relays.length, 19, "the default matrix carries 19 zones");
  });

  test("applies a relay override", () => {

    const schedule = makeStatusSchedule({ relays: [makeZone({ relay_id: 700001 })] });

    assert.equal(schedule.relays.length, 1, "the relay override replaces the matrix");
  });

  test("returns an independent clone each call", () => {

    const a = makeStatusSchedule();
    const b = makeStatusSchedule();

    expectAt(a.relays, 0, "relay").name = "mutated";

    assert.notEqual(expectAt(b.relays, 0, "relay").name, "mutated", "mutating one schedule's relays must not affect another");
  });
});

describe("scenario composers", () => {

  test("normalSchedule runs the first zone", () => {

    const schedule = normalSchedule();

    assert.equal(expectAt(schedule.relays, 0, "relay").time, 1, "the normal schedule's first zone is running");
  });

  test("rainStopped stamps every zone with the sentinel and references them from the sensor", () => {

    const schedule = rainStopped();

    assert.ok(schedule.relays.every(zone => zone.time === UNSCHEDULED_SENTINEL), "every rain-stopped zone carries the unscheduled sentinel");
    assert.deepEqual(expectAt(schedule.sensors, 0, "sensor").relays.map(relay => relay.id), [...allRelayIds], "the rain sensor references every zone relay");
  });

  test("allSuspended stamps the sentinel but the sensor references no zone", () => {

    const schedule = allSuspended();

    assert.ok(schedule.relays.every(zone => zone.time === UNSCHEDULED_SENTINEL), "every suspended zone carries the unscheduled sentinel");
    assert.equal(expectAt(schedule.sensors, 0, "sensor").relays.length, 0, "the bare sensor references no zone, distinguishing suspend from a rain stop");
  });
});
