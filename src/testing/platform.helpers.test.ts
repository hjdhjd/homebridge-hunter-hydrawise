/* Copyright(C) 2017-2026, HJD (https://github.com/hjdhjd). All rights reserved.
 *
 * platform.helpers.test.ts: Self-test for the platform harness. Asserts the programmable retrieve recorder's record-and-program semantics, the MQTT recorder's
 * capture and invoke knobs, the MockAgent installer's snapshot-and-restore discipline, the API double's capture-and-invoke event contract, and the platform
 * double's mutable debug channel and signal lifecycle - pre-aborted by default, abortable when requested.
 */

// The Hydrawise API wire shapes use snake_case keys such as relay_id and controller_id, so camelcase is disabled here to let these literals mirror the wire verbatim.
/* eslint-disable camelcase */
import { RetrieveRecorder, installMockDispatcher, makeTestApi, makeTestPlatform } from "./platform.helpers.ts";
import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { getGlobalDispatcher } from "undici";
import { loggedAt } from "homebridge-plugin-utils/testing";

// The subset of the API double's surface this self-test drives directly. The harness returns the api as an opaque value for the platform constructor cast; here
// we describe just the methods we exercise.
interface ApiDouble {

  on: (event: string, handler: () => void) => unknown;
  registerPlatformAccessories: (plugin: string, platform: string, accessories: unknown[]) => void;
}

describe("RetrieveRecorder", () => {

  test("records each call and returns the programmed response body", async () => {

    const recorder = new RetrieveRecorder();

    recorder.programDefault("statusschedule.php", { body: { nextpoll: 42 }, kind: "response" });

    const response = await recorder.retrieve("statusschedule.php", { controller_id: "500001" });

    assert.ok(response, "a programmed response should be returned");
    assert.deepEqual(await response.body.json(), { nextpoll: 42 }, "the response body should answer the programmed data");
    assert.equal(recorder.callsTo("statusschedule.php").length, 1, "the call should be recorded");
    assert.equal(recorder.calls[0]?.params?.["controller_id"], "500001", "the recorded call should carry the params");
  });

  test("drains a one-shot queue in FIFO order before falling to the default", async () => {

    const recorder = new RetrieveRecorder();

    recorder.program("statusschedule.php", { body: { nextpoll: 1 }, kind: "response" });
    recorder.program("statusschedule.php", { kind: "null" });
    recorder.programDefault("statusschedule.php", { body: { nextpoll: 99 }, kind: "response" });

    assert.deepEqual(await (await recorder.retrieve("statusschedule.php"))?.body.json(), { nextpoll: 1 }, "the first queued response is consumed first");
    assert.equal(await recorder.retrieve("statusschedule.php"), null, "the second queued response is the null shape");
    assert.deepEqual(await (await recorder.retrieve("statusschedule.php"))?.body.json(), { nextpoll: 99 }, "the drained queue falls to the default");
  });

  test("a malformed response rejects on body.json()", async () => {

    const recorder = new RetrieveRecorder();

    recorder.programDefault("statusschedule.php", { kind: "malformed" });

    const response = await recorder.retrieve("statusschedule.php");

    assert.ok(response, "a malformed response is still non-null");
    await assert.rejects(() => response.body.json(), /Malformed response body/, "the malformed body should reject when parsed");
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

describe("makeTestApi", () => {

  test("captures event handlers and invokes them on emit", () => {

    const { api, emit } = makeTestApi();
    let ran = 0;

    (api as ApiDouble).on("did-finish", () => { ran++; });
    emit("did-finish");
    emit("did-finish");

    assert.equal(ran, 2, "each emit should invoke the captured handler");
  });

  test("records registered accessories", () => {

    const { api, makeAccessory, registered } = makeTestApi();
    const accessory = makeAccessory("Test", "u1");

    (api as ApiDouble).registerPlatformAccessories("plugin", "platform", [accessory]);

    assert.equal(registered.length, 1, "the registered accessory should be recorded");
    assert.equal(registered[0]?.UUID, "u1", "the recorded accessory should carry its UUID");
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
    abort();
    assert.equal(platform.signal.aborted, true, "the abort lever aborts the live signal");
  });
});
