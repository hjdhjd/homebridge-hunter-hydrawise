/* Copyright(C) 2017-2026, HJD (https://github.com/hjdhjd). All rights reserved.
 *
 * hap.helpers.test.ts: Self-test for the HAP double. Asserts that the REAL homebridge-plugin-utils service helpers (acquireService, validService, getServiceName,
 * setServiceName) run unmodified against the marker namespaces - the seeded first characteristic lets getCharacteristicConstructor recover a constructor without
 * throwing, and the cross-kind statics let the name predicates answer per kind the way they do against real HAP - and that the characteristic trigger knobs, the
 * write recorder, the service accessors, and the accessory accessors behave as production expects.
 */
import { Characteristic, Service, TestService, makeTestAccessory } from "./hap.helpers.ts";
import type { Service as HapService, PlatformAccessory } from "homebridge";
import { acquireService, getServiceName, setServiceName, validService } from "homebridge-plugin-utils";
import { describe, test } from "node:test";
import type { AcquireServiceTarget } from "homebridge-plugin-utils";
import assert from "node:assert/strict";

// Confine the double-to-HAP casts the real service helpers require to these adapters, so most test bodies below stay cast-free; the one exception is the
// cross-kind namespace test, which casts its own constructor argument to index it by kind name, a shape none of these adapters cover.
function asAccessory(accessory: ReturnType<typeof makeTestAccessory>): PlatformAccessory {

  return accessory as unknown as PlatformAccessory;
}

function asTarget(service: typeof Service[keyof typeof Service]): AcquireServiceTarget {

  return service as unknown as AcquireServiceTarget;
}

function asTestService(service: object): TestService {

  return service as unknown as TestService;
}

function asHapService(service: object): HapService {

  return service as unknown as HapService;
}

// Acquire a service against a fresh accessory and hand back the double, which the assertions below cast through asHapService() when they need the HAP view.
function acquireDouble(kind: typeof Service[keyof typeof Service], name: string, subtype?: string): TestService {

  const { service, transition } = acquireService({ accessory: asAccessory(makeTestAccessory()), name, serviceType: asTarget(kind), subtype });

  assert.equal(transition, "attached", "the double should acquire a " + name + " service");

  return asTestService(service);
}

describe("acquireService against the HAP double", () => {

  test("creates a new service and recovers the characteristic constructor without throwing", () => {

    const accessory = makeTestAccessory();
    const { transition } = acquireService({ accessory: asAccessory(accessory), name: "Test Valve", serviceType: asTarget(Service.Valve), subtype: "700001" });

    assert.equal(transition, "attached", "the real acquireService should create a valve against the double");
    assert.ok(accessory.getServiceById(Service.Valve, "700001"), "the created valve should be retrievable by its subtype");
  });

  test("returns the existing service on re-acquisition rather than creating a duplicate", () => {

    const accessory = makeTestAccessory();

    acquireService({ accessory: asAccessory(accessory), name: "Test Valve", serviceType: asTarget(Service.Valve), subtype: "700001" });

    const { transition } = acquireService({ accessory: asAccessory(accessory), name: "Test Valve", serviceType: asTarget(Service.Valve), subtype: "700001" });

    const valves = accessory.services.filter(service => service.UUID === "Valve");

    assert.equal(transition, "kept", "re-acquiring the same subtype should answer the existing service");
    assert.equal(valves.length, 1, "re-acquiring the same subtype should not duplicate the service");
  });

  test("validService removes a service when validation fails", () => {

    const accessory = makeTestAccessory();

    acquireService({ accessory: asAccessory(accessory), name: "Test Switch", serviceType: asTarget(Service.Switch), subtype: "All" });
    assert.ok(accessory.getServiceById(Service.Switch, "All"), "the switch should exist before validation");

    validService({ accessory: asAccessory(accessory), name: "Test Switch", serviceType: asTarget(Service.Switch), subtype: "All", validate: false });
    assert.equal(accessory.getServiceById(Service.Switch, "All"), undefined, "a false validation should remove the service");
  });
});

describe("the real name helpers against the HAP double", () => {

  test("round-trips a name through setServiceName and getServiceName", () => {

    const valve = acquireDouble(Service.Valve, "Front Lawn", "700001");

    assert.equal(getServiceName(asHapService(valve)), "Front Lawn", "the name acquireService applied should read back through the real helper");

    setServiceName(asHapService(valve), "Front Lawn Drip Line");

    assert.equal(getServiceName(asHapService(valve)), "Front Lawn Drip Line", "a written name should read back through the real helper");
    assert.equal(valve.displayName, "Front Lawn Drip Line", "setServiceName should assign the service's display name alongside the characteristics");
  });

  test("materializes the name characteristics each service kind supports", () => {

    const valve = acquireDouble(Service.Valve, "Front Lawn", "700001");
    const irrigation = acquireDouble(Service.IrrigationSystem, "Back Yard");
    const label = acquireDouble(Service.ServiceLabel, "Zones");

    assert.equal(valve.testCharacteristic(Characteristic.ConfiguredName), true, "a valve supports ConfiguredName");
    assert.equal(valve.testCharacteristic(Characteristic.Name), true, "a valve supports Name");
    assert.equal(irrigation.testCharacteristic(Characteristic.ConfiguredName), false, "an irrigation system supports Name but not ConfiguredName");
    assert.equal(irrigation.testCharacteristic(Characteristic.Name), true, "an irrigation system supports Name");
    assert.equal(getServiceName(asHapService(irrigation)), "Back Yard", "an irrigation system's name resolves through its Name characteristic");
    assert.equal(label.testCharacteristic(Characteristic.ConfiguredName), false, "a service label supports neither name characteristic");
    assert.equal(label.testCharacteristic(Characteristic.Name), false, "a service label supports neither name characteristic");
    assert.equal(getServiceName(asHapService(label)), undefined, "a kind with no name characteristic reads back as unnamed");
  });

  test("every service marker resolves the same cross-kind namespace", () => {

    // The helpers' name-set initializer reads these off whichever service it sees FIRST and caches the result for the process, so any drift between markers would
    // make naming depend on the order services happen to be created in.
    const kinds = [ "AccessoryInformation", "IrrigationSystem", "ServiceLabel", "Switch", "Valve" ];
    const namespaceOf = (ctor: object): (string | undefined)[] => kinds.map(kind => (ctor as Record<string, { UUID?: string } | undefined>)[kind]?.UUID);

    assert.deepEqual(namespaceOf(TestService), kinds, "the base should resolve every kind to its own identity string");

    for(const [ name, marker ] of Object.entries(Service)) {

      assert.deepEqual(namespaceOf(marker), kinds, "the " + name + " marker should resolve the same namespace as the base and its siblings");
    }
  });
});

describe("the characteristic write recorder", () => {

  test("records each write with the kind that was written", () => {

    const service = new TestService(Service.Valve, "Test", "700001");

    service.updateCharacteristic(Characteristic.Active, 1);
    service.updateCharacteristic(Characteristic.ConfiguredName, "Front Lawn");

    assert.equal(service.writes.length, 2, "both writes should be recorded");
    assert.deepEqual(service.writesFor(Characteristic.ConfiguredName).map(write => write.value), ["Front Lawn"], "the filtered view should carry only the named kind");
    assert.equal(service.writesFor(Characteristic.Name).length, 0, "a kind that was never written should filter to nothing");
  });

  test("clearWrites opens a window that excludes what came before it", () => {

    const service = new TestService(Service.Valve, "Test", "700001");

    service.updateCharacteristic(Characteristic.ConfiguredName, "Front Lawn");
    service.clearWrites();
    service.updateCharacteristic(Characteristic.Active, 1);

    assert.equal(service.writesFor(Characteristic.ConfiguredName).length, 0, "a write made before the window should not appear in it");
    assert.equal(service.writes.length, 1, "the window should carry exactly the write made inside it");
  });

  test("a HomeKit-originated set lands through the same write funnel", async () => {

    const service = new TestService(Service.Valve, "Test", "700001");

    await service.getCharacteristic(Characteristic.Active).triggerSet(1);

    assert.deepEqual(service.writesFor(Characteristic.Active).map(write => write.value), [1], "triggerSet should record its value like any other write");
  });
});

describe("TestCharacteristic", () => {

  test("triggerGet returns the bound onGet handler's value", async () => {

    const service = new TestService(Service.Valve, "Test", "700001");
    const characteristic = service.getCharacteristic(Characteristic.On);

    characteristic.onGet(() => "handler-value");

    assert.equal(await characteristic.triggerGet(), "handler-value", "triggerGet should invoke the bound read handler");
  });

  test("triggerGet falls through to the cached value with no handler bound", async () => {

    const service = new TestService(Service.Valve, "Test", "700001");
    const characteristic = service.getCharacteristic(Characteristic.On);

    characteristic.updateValue("cached");

    assert.equal(await characteristic.triggerGet(), "cached", "triggerGet should read the cache when no handler is bound");
  });

  test("triggerSet runs the bound onSet handler and then caches the value", async () => {

    const service = new TestService(Service.Valve, "Test", "700001");
    const characteristic = service.getCharacteristic(Characteristic.Active);
    const received: unknown[] = [];

    characteristic.onSet(value => { received.push(value); });
    await characteristic.triggerSet(1);

    assert.deepEqual(received, [1], "triggerSet should invoke the bound write handler with the value");
    assert.equal(characteristic.value, 1, "triggerSet should cache the value after the handler resolves");
  });
});

describe("TestService and TestAccessory accessors", () => {

  test("getCharacteristic returns the same instance across calls", () => {

    const service = new TestService(Service.Valve, "Test", "700001");

    assert.equal(service.getCharacteristic(Characteristic.Active), service.getCharacteristic(Characteristic.Active), "the same kind should resolve to one instance");
  });

  test("testCharacteristic is a pure predicate that does not create", () => {

    const service = new TestService(Service.Valve, "Test", "700001");

    assert.equal(service.testCharacteristic(Characteristic.On), false, "an unseen characteristic should test false without being created");

    service.getCharacteristic(Characteristic.On);

    assert.equal(service.testCharacteristic(Characteristic.On), true, "a created characteristic should test true");
  });

  test("removeService detaches a service from the accessory", () => {

    const accessory = makeTestAccessory();
    const { service, transition } = acquireService({ accessory: asAccessory(accessory), name: "Test Valve", serviceType: asTarget(Service.Valve), subtype: "700001" });

    assert.equal(transition, "attached", "the valve should be created");
    accessory.removeService(asTestService(service));
    assert.equal(accessory.getServiceById(Service.Valve, "700001"), undefined, "the removed valve should be gone");
  });
});
