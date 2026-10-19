/* Copyright(C) 2017-2026, HJD (https://github.com/hjdhjd). All rights reserved.
 *
 * types.test.ts: The reserved-name constants and the fixture-versus-interface conformance check. The interfaces are compile-time contracts; this file
 * asserts the reserved-name constant and its subtype compose/recognize pair, and verifies the synthetic fixtures carry the required wire fields with
 * wire-accurate types.
 */
import { HydrawiseReservedNames, isSuspendZoneSubtype, suspendZoneSubtype } from "./types.ts";
import { UNSCHEDULED_SENTINEL, normalZoneMatrix, sentinelZoneMatrix, syntheticController, syntheticCustomerDetails } from "./api.fixtures.ts";
import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { expectAt } from "homebridge-plugin-utils/testing";

describe("hydrawise reserved names", () => {

  test("names the suspend-all switch subtype", () => {

    assert.equal(HydrawiseReservedNames.SWITCH_SUSPEND_ALL, "All", "the suspend-all switch subtype is All");
  });

  test("composes and recognizes a zone's own suspension switch subtype", () => {

    /* The two readings of one prefix, asserted together. Composition and recognition have to agree by construction, because the sweep that removes these switches
     * decides what to keep by composing and what to consider by recognizing - and a disagreement there either strands a switch or destroys one.
     */
    assert.equal(suspendZoneSubtype(700001), "Suspend.700001", "a zone's switch subtype is the reserved prefix and its relay id");
    assert.ok(isSuspendZoneSubtype(suspendZoneSubtype(700001)), "what the composer produces, the recognizer recognizes");

    // The account-wide switch shares the Switch service type with these, so telling the two apart is the whole of what keeps a sweep from destroying it.
    assert.ok(!isSuspendZoneSubtype(HydrawiseReservedNames.SWITCH_SUSPEND_ALL), "the account-wide switch is never mistaken for a zone's own");
    assert.ok(!isSuspendZoneSubtype("700001"), "and neither is a valve subtype");
    assert.ok(!isSuspendZoneSubtype(undefined), "a service carrying no subtype at all is not this sweep's business");
  });
});

describe("fixture conformance", () => {

  test("the synthetic controller carries the required controller fields with the right types", () => {

    assert.equal(typeof syntheticController.controller_id, "number", "controller_id is a number");
    assert.equal(typeof syntheticController.last_contact, "number", "last_contact is a number");
    assert.equal(typeof syntheticController.name, "string", "name is a string");
    assert.equal(typeof syntheticController.serial_number, "string", "serial_number is a string");
    assert.equal(typeof syntheticController.status, "string", "status is a string");
  });

  test("the synthetic customer details reference the controller list", () => {

    assert.equal(typeof syntheticCustomerDetails.customer_id, "number", "customer_id is a number");
    assert.equal(syntheticCustomerDetails.controllers.length, 1, "one synthetic controller is present");
    assert.equal(expectAt(syntheticCustomerDetails.controllers, 0, "controller").serial_number, syntheticController.serial_number,
      "the controller list carries the synthetic controller");
  });

  test("the normal zone matrix mirrors the 19-zone wire shape with the required zone fields", () => {

    assert.equal(normalZoneMatrix.length, 19, "the normal matrix carries 19 zones");

    const zone = expectAt(normalZoneMatrix, 0, "zone");

    assert.equal(typeof zone.name, "string", "name is a string");
    assert.equal(typeof zone.relay, "number", "relay is a number");
    assert.equal(typeof zone.relay_id, "number", "relay_id is a number");
    assert.equal(typeof zone.run, "number", "run is a number");
    assert.equal(typeof zone.time, "number", "time is a number");
    assert.equal(typeof zone.timestr, "string", "timestr is a string");
  });

  test("the sentinel matrix stamps every zone with the unscheduled sentinel and an empty schedule", () => {

    assert.equal(sentinelZoneMatrix.length, 19, "the sentinel matrix carries 19 zones");
    assert.ok(sentinelZoneMatrix.every(zone => zone.time === UNSCHEDULED_SENTINEL), "every sentinel zone carries the unscheduled sentinel");
    assert.ok(sentinelZoneMatrix.every(zone => (zone.run === 0) && (zone.timestr === "")), "every sentinel zone has no run and no schedule string");
  });
});
