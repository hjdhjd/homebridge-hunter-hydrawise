/* Copyright(C) 2017-2026, HJD (https://github.com/hjdhjd). All rights reserved.
 *
 * platform.helpers.test.ts: Self-test for the platform harness. Asserts the programmable retrieve recorder's record-and-program semantics, the MockAgent
 * installer's snapshot-and-restore discipline, the call views that read the Homebridge API double's record live, the reconcile stub's answer to a zone the
 * request drops, and the platform double's mutable debug channel and signal lifecycle - pre-aborted by default, abortable when requested.
 */

// The Hydrawise API wire shapes use snake_case keys such as relay_id and controller_id, so camelcase is disabled here to let these literals mirror the wire verbatim.
/* eslint-disable camelcase */
import { PLATFORM_NAME, PLUGIN_NAME } from "../settings.ts";
import { RetrieveRecorder, buildController, buildPlatform, installMockDispatcher, makeTestPlatform } from "./platform.helpers.ts";
import { describe, test } from "node:test";
import { loggedAt, present } from "homebridge-plugin-utils/testing";
import type { PlatformAccessory } from "homebridge";
import assert from "node:assert/strict";
import { getGlobalDispatcher } from "undici";
import { makeZone } from "../api.helpers.ts";
import { syntheticController } from "../api.fixtures.ts";
import { zoneIdentity } from "../types.ts";

describe("RetrieveRecorder", () => {

  test("records each call and returns the programmed response body", async () => {

    const recorder = new RetrieveRecorder();

    recorder.programDefault("statusschedule.php", { body: { nextpoll: 42 }, kind: "response" });

    assert.deepEqual(await recorder.retrieve("statusschedule.php", { controller_id: "500001" }), { body: { nextpoll: 42 }, status: "parsed" },
      "a programmed response answers its body as parsed");
    assert.equal(recorder.callsTo("statusschedule.php").length, 1, "the call should be recorded");
    assert.equal(recorder.calls[0]?.params?.["controller_id"], "500001", "the recorded call should carry the params");
  });

  test("drains a one-shot queue in FIFO order before falling to the default", async () => {

    const recorder = new RetrieveRecorder();

    recorder.program("statusschedule.php", { body: { nextpoll: 1 }, kind: "response" });
    recorder.program("statusschedule.php", { kind: "null" });
    recorder.programDefault("statusschedule.php", { body: { nextpoll: 99 }, kind: "response" });

    assert.deepEqual(await recorder.retrieve("statusschedule.php"), { body: { nextpoll: 1 }, status: "parsed" }, "the first queued response is consumed first");
    assert.equal(await recorder.retrieve("statusschedule.php"), null, "the second queued response is the null shape");
    assert.deepEqual(await recorder.retrieve("statusschedule.php"), { body: { nextpoll: 99 }, status: "parsed" }, "the drained queue falls to the default");
  });

  test("a malformed response answers an unreadable read carrying its error", async () => {

    const recorder = new RetrieveRecorder();

    recorder.programDefault("statusschedule.php", { kind: "malformed" });

    assert.deepEqual(await recorder.retrieve("statusschedule.php"), { error: new Error("Malformed response body."), status: "unreadable" },
      "a malformed response is an answered request whose body could not be read");
  });
});

describe("installMockDispatcher", () => {

  test("installs the mock agent as global and restores the prior dispatcher on dispose", async () => {

    const before = getGlobalDispatcher();

    {

      await using handle = installMockDispatcher();

      assert.equal(getGlobalDispatcher(), handle.agent, "the mock agent should be installed as the global dispatcher");
    }

    assert.equal(getGlobalDispatcher(), before, "the prior dispatcher should be restored after dispose");
  });
});

describe("the harness's call views", () => {

  test("read the API double's record when called, so a call made after a result was built and destructured is seen", (t) => {

    // Each result is destructured before any call is made, the way every suite holds one, and buildController's result is itself a spread of the platform
    // double's.
    const { api, emit, platform, registered, unregistered, updated } = buildPlatform();
    const { accessory, flushes, platform: double } = buildController();

    t.after(() => emit("shutdown"));

    const fresh = new api.platformAccessory("Views", api.hap.uuid.generate("platform-helpers-test.views"));

    // Each mark goes through a real persistence, whose window no row advances, so a save reaches a view only because the view closes the window itself.
    api.registerPlatformAccessories(PLUGIN_NAME, PLATFORM_NAME, [fresh]);
    platform.persistence.persist(fresh);

    assert.deepEqual(updated(), [[fresh]], "the save view closes the platform's window and reads the save it brings");

    platform.persistence.unregister([fresh]);
    double.persistence.persist(accessory);

    assert.deepEqual(registered(), [fresh], "the registration view reads the registration made after the result was built");
    assert.deepEqual(unregistered(), [fresh], "the unregistration view reads the unregistration made after it");
    assert.deepEqual(flushes(), [[accessory]], "and the controller harness's save view closes its own window after its result was spread and destructured");
  });
});

describe("makeTestPlatform", () => {

  test("exposes a mutable debug channel the capture observes", () => {

    const { entries, platform } = makeTestPlatform();

    // The capture's debug channel is a plain writable slot, so a test can interpose its own function on it and still have the capture record what comes through.
    // The cast bridges the readonly HomebridgePluginLogging.debug declaration the double is typed against.
    (platform.log as { debug: (message: string) => void }).debug = (message: string): void => platform.log.error(message);
    platform.log.debug("routed debug line");

    assert.ok(loggedAt(entries, "error", "routed debug line"), "a reassigned debug channel should still land in the capture");
  });

  test("defaults the platform signal to pre-aborted", () => {

    const { platform } = makeTestPlatform();

    assert.equal(platform.signal.aborted, true, "the default signal starts pre-aborted so a constructed loop exits at once");
  });

  test("offers a live signal when requested", () => {

    const { abort, platform } = makeTestPlatform({ signalAborted: false });

    assert.equal(platform.signal.aborted, false, "a live signal starts unaborted");
    void abort();
    assert.equal(platform.signal.aborted, true, "the abort lever aborts the live signal");
  });

  test("the reconcile stub unregisters a zone the request drops while the wire reports it, and mints it afresh on the bridge when it returns", () => {

    const zone = makeZone({ name: "Front Lawn", relay: 1, relay_id: 700001 });
    const request = { displayName: zone.name, identity: zoneIdentity(zone) };
    const reported = new Set([zone.relay_id]);
    const { platform, zoneAccessories } = makeTestPlatform();
    const unregistered = (): (readonly PlatformAccessory[])[] => platform.api.calls.flatMap(call => (call.kind === "unregister") ? [call.accessories] : []);
    const first = present(platform.reconcileZoneAccessories({ controller: syntheticController, presentRelayIds: reported, zones: [request] }).get(zone.relay_id),
      "the requested zone's accessory");

    // The wire still reports the zone and the request leaves it out, which production reads as configuration intent and demotes on the same call.
    const dropped = platform.reconcileZoneAccessories({ controller: syntheticController, presentRelayIds: reported, zones: [] });

    assert.equal(dropped.size, 0, "the dropped zone is not hosted");
    assert.deepEqual(unregistered(), [[first]], "its accessory is unregistered, as the platform's demotion unregisters it");
    assert.equal(zoneAccessories.has(zone.relay_id), false, "and the stub drops it");

    const again = present(platform.reconcileZoneAccessories({ controller: syntheticController, presentRelayIds: reported, zones: [request] }).get(zone.relay_id),
      "the returning zone's accessory");

    assert.notEqual(again, first, "the zone's return mints a fresh accessory");
    assert.equal(again._associatedHAPAccessory.bridged, true, "which Homebridge takes onto the bridge, since no accessory of its UUID is left there");
  });

  test("the reconcile stub holds a zone the request drops while the wire leaves it out, registered and unhosted", () => {

    const zone = makeZone({ name: "Front Lawn", relay: 1, relay_id: 700001 });
    const request = { displayName: zone.name, identity: zoneIdentity(zone) };
    const { platform, zoneAccessories } = makeTestPlatform();
    const unregistered = (): (readonly PlatformAccessory[])[] => platform.api.calls.flatMap(call => (call.kind === "unregister") ? [call.accessories] : []);
    const first = present(platform.reconcileZoneAccessories({ controller: syntheticController, presentRelayIds: new Set([zone.relay_id]), zones: [request] })
      .get(zone.relay_id), "the requested zone's accessory");

    // The wire leaves the zone out as well, which production holds through its grace rather than demoting.
    const absent = platform.reconcileZoneAccessories({ controller: syntheticController, presentRelayIds: new Set(), zones: [] });

    assert.equal(absent.size, 0, "the wire-absent zone is not hosted");
    assert.deepEqual(unregistered(), [], "its accessory is not unregistered");
    assert.equal(first._associatedHAPAccessory.bridged, true, "so it stays on the bridge");
    assert.equal(zoneAccessories.get(zone.relay_id), first, "and the stub holds it, to hand back when the zone returns");
  });
});
