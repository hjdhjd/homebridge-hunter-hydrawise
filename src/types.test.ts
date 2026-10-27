/* Copyright(C) 2017-2026, HJD (https://github.com/hjdhjd). All rights reserved.
 *
 * types.test.ts: The reserved-name constants, the controller and zone name composers, and the fixture-versus-interface conformance check. The interfaces are
 * compile-time contracts; this file asserts the reserved-name constant and its subtype compose/recognize pair, each source a composer answers from, and verifies
 * the synthetic fixtures carry the required wire fields with wire-accurate types.
 */
import { HYDRAWISE_CONTROLLER_FALLBACK_NAME, HYDRAWISE_ZONE_FALLBACK_NAME, HydrawiseReservedNames, controllerDisplayName, isSuspendZoneSubtype,
  suspendZoneSubtype, zoneDisplayName } from "./types.ts";
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

describe("hydrawise name composers", () => {

  test("a Name HomeKit can carry is answered trimmed and otherwise as the user typed it", () => {

    assert.deepEqual(controllerDisplayName({ override: "  Garden Controller  ", reported: "Back Yard" }), { name: "Garden Controller", source: "override" },
      "a controller's Name outranks the reported name, trimmed");
    assert.deepEqual(zoneDisplayName({ override: "Front/Back Lawn", relay: 3, reported: "Side Yard" }), { name: "Front/Back Lawn", source: "override" },
      "a zone's Name is answered unsanitized, since every HomeKit write sanitizes the name it applies");
    assert.deepEqual(zoneDisplayName({ override: "\u{1F331} Front Lawn", relay: 3, reported: "Side Yard" }),
      { name: "\u{1F331} Front Lawn", source: "override" }, "and so is a Name that keeps something HomeKit can carry beside an emoji");
  });

  test("a Name that is absent, empty or one HomeKit cannot carry yields to the reported name", () => {

    for(const override of [ undefined, null, "", "   ", "\u{1F331}\u{1F331}", "***" ]) {

      assert.deepEqual(controllerDisplayName({ override, reported: "Back Yard" }), { name: "Back Yard", source: "reported" },
        "a controller with the Name " + JSON.stringify(override) + " carries its reported name");
      assert.deepEqual(zoneDisplayName({ override, relay: 3, reported: "Side Yard" }), { name: "Side Yard", source: "reported" },
        "and so does a zone");
    }
  });

  test("a reported name HomeKit can carry is answered as it stands, a carriable name never moving", () => {

    for(const reported of [ "Front Lawn 2.0", "Front/Back Lawn", "Lawn #1", "\u{1F331} Herb Garden" ]) {

      assert.deepEqual(controllerDisplayName({ reported }), { name: reported, source: "reported" }, "the controller name " + reported + " stands");
      assert.deepEqual(zoneDisplayName({ relay: 4, reported }), { name: reported, source: "reported" }, "and so does the zone name " + reported);
    }
  });

  test("where HomeKit can carry nothing of the Name or the reported name, the kind's word answers, a zone's with its relay number", () => {

    for(const reported of [ "\u{1F331}", "***", "---", "" ]) {

      assert.deepEqual(controllerDisplayName({ override: "\u{1F4A7}", reported }), { name: HYDRAWISE_CONTROLLER_FALLBACK_NAME, source: "fallback" },
        "a controller reported as " + JSON.stringify(reported) + " is named Controller");
      assert.deepEqual(zoneDisplayName({ override: "\u{1F4A7}", relay: 3, reported }), { name: HYDRAWISE_ZONE_FALLBACK_NAME + " 3", source: "fallback" },
        "and a zone is named by its word and relay number");
    }

    assert.equal(zoneDisplayName({ relay: 12, reported: "***" }).name, "Zone 12", "the relay number is the zone's own");
  });

  test("a reported name that is the kind's word is the zone's or controller's own, not the fallback", () => {

    assert.deepEqual(controllerDisplayName({ reported: "Controller" }), { name: "Controller", source: "reported" }, "a controller Hydrawise names Controller");
    assert.deepEqual(zoneDisplayName({ relay: 3, reported: "Zone 3" }), { name: "Zone 3", source: "reported" }, "a zone Hydrawise names Zone 3 at relay 3");
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
