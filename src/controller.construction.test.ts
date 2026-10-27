/* Copyright(C) 2017-2026, HJD (https://github.com/hjdhjd). All rights reserved.
 *
 * controller.construction.test.ts: Construction-time behavior of HydrawiseController, exercised against a pre-aborted platform signal so the controller
 * wires its services and subscriptions fully while its polling loop exits silently. Covers the irrigation-system and service-label services, the AccessoryInformation
 * fields, the optional suspend switch and its feature-log line, and the MQTT subscriptions.
 */
import { Characteristic, Service, buildController } from "./testing/platform.helpers.ts";
import { describe, test } from "node:test";
import { expectAt, loggedAt } from "homebridge-plugin-utils/testing";
import assert from "node:assert/strict";

describe("HydrawiseController construction", () => {

  test("wires the irrigation system service with its resting characteristics", () => {

    const { accessory, retrieve } = buildController();
    const irrigation = accessory.getService(Service.IrrigationSystem);

    assert.ok(irrigation, "an IrrigationSystem service should be created");
    assert.equal(irrigation.getCharacteristic(Characteristic.Active).value, Characteristic.Active.ACTIVE, "the system should rest Active");
    assert.equal(irrigation.getCharacteristic(Characteristic.InUse).value, Characteristic.InUse.NOT_IN_USE, "the system should rest not in use");
    assert.equal(irrigation.getCharacteristic(Characteristic.ProgramMode).value, Characteristic.ProgramMode.PROGRAM_SCHEDULED, "the system should rest scheduled");
    assert.equal(retrieve.calls.length, 0, "the pre-aborted polling loop should make no retrieve calls");

    // HAP builds InUse at not in use, so the value alone cannot tell the configuration's write from HAP's own default, and the change record is what can.
    assert.deepEqual(accessory.changesOn(irrigation, Characteristic.InUse).map(change => change.newValue), [Characteristic.InUse.NOT_IN_USE],
      "the configuration writes the resting not-in-use itself");
  });

  test("adds a service label service enumerated with arabic numerals", () => {

    const { accessory } = buildController();
    const label = accessory.getService(Service.ServiceLabel);

    assert.ok(label, "a ServiceLabel service should be created for zone enumeration");
    assert.equal(label.getCharacteristic(Characteristic.ServiceLabelNamespace).value, Characteristic.ServiceLabelNamespace.ARABIC_NUMERALS,
      "the label namespace should be arabic numerals");
  });

  test("populates the accessory information with the Hunter Hydrawise identity", () => {

    const { accessory, controllerConfig } = buildController();
    const info = accessory.getService(Service.AccessoryInformation);

    assert.ok(info, "an AccessoryInformation service should exist");
    assert.equal(info.getCharacteristic(Characteristic.Manufacturer).value, "Hunter", "the manufacturer should be Hunter");
    assert.equal(info.getCharacteristic(Characteristic.Model).value, "Hydrawise", "the model should be Hydrawise");
    assert.equal(info.getCharacteristic(Characteristic.SerialNumber).value, controllerConfig.serial_number, "the serial number should match the controller");
  });

  test("omits the suspend switch when the feature is at its disabled default", () => {

    const { accessory } = buildController();

    assert.equal(accessory.getServiceById(Service.Switch, "All"), undefined, "no suspend switch should exist without the feature option");
  });

  test("adds the suspend switch and logs the deviation when the feature is enabled", () => {

    const { accessory, controllerConfig, entries } = buildController({ userOptions: ["Enable.Device.Suspend.All." + controllerConfigSerial()] });
    const suspend = accessory.getServiceById(Service.Switch, "All");

    assert.ok(suspend, "a suspend switch should exist when Device.Suspend.All is enabled");

    // Before the first poll the status carries an empty relay list, so isAllSuspended is vacuously true (an empty some() is false, negated to true) and the
    // switch rests on. This is the construction-time reading; the first poll replaces it with the reported zone state.
    assert.equal(suspend.getCharacteristic(Characteristic.On).value, true, "the suspend switch rests on over the empty pre-poll status");
    assert.ok(loggedAt(entries, "info", "Suspend all zones switch enabled."), "enabling the non-default suspend feature should log the deviation");

    // The serial the enabling option targets is the controller's own serial, confirming the option resolved at controller scope.
    assert.equal(controllerConfig.serial_number, controllerConfigSerial(), "the enabling option should target the controller serial");
  });

  test("registers the MQTT get and set subscriptions when MQTT is configured", () => {

    const { mqtt } = buildController({ mqtt: true });

    assert.ok(mqtt, "the MQTT recorder should be attached");

    const gets = mqtt.subscriptions.filter(entry => entry.kind === "get");
    const sets = mqtt.subscriptions.filter(entry => entry.kind === "set");

    assert.equal(gets.length, 1, "one controller get subscription should be registered");
    assert.equal(sets.length, 1, "one controller set subscription should be registered");
    assert.ok(expectAt(gets, 0, "MQTT get subscription").topic.endsWith("controller/get"), "the get topic should be the controller topic");
    assert.ok(expectAt(sets, 0, "MQTT set subscription").topic.endsWith("controller/set"), "the set topic should be the controller topic");
  });

  test("registers no MQTT subscriptions when MQTT is not configured", () => {

    const { mqtt } = buildController();

    assert.equal(mqtt, null, "no MQTT recorder should be attached without the mqtt option");
  });
});

// The synthetic controller serial the default fixture carries. Kept as a helper so the enabling-option string and the assertion read from one source.
function controllerConfigSerial(): string {

  return "SN0A1B2C3D4";
}
