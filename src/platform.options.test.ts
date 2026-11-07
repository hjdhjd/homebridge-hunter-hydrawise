/* Copyright(C) 2017-2026, HJD (https://github.com/hjdhjd). All rights reserved.
 *
 * platform.options.test.ts: The platform's consolidated setting resolution and its guarded MQTT construction, exercised against a REAL platform built
 * through the harness. Covers every arm of the precedence rule - option over legacy property, legacy property over catalog default, and the explicit disabled and
 * valueless option states - for the API key, the MQTT broker URL, the MQTT topic prefix, and the debug flag, plus the client the resolved values do or do not construct.
 *
 * Every value pair here is deliberately distinct, so a resolver reading the wrong arm cannot echo the right answer back and pass. A platform builds its client
 * through the harness's MQTT factory double, which answers a configured broker with a recording double and MQTT off with null, so no row dials a broker.
 */
import { describe, test } from "node:test";
import { expectAt, loggedAt } from "homebridge-plugin-utils/testing";
import assert from "node:assert/strict";
import { buildPlatform } from "./testing/platform.helpers.ts";

// APIEvent.SHUTDOWN's string value. Firing it aborts the platform's shutdown signal, which is what ends any MQTT client a test constructed.
const SHUTDOWN = "shutdown";

// The two API keys the assertions tell apart: the one a legacy configuration property carries, and the one a configured feature option carries.
const LEGACY_KEY = "AAAA-BBBB-CCCC-DDD";
const OPTION_KEY = "EEEE-FFFF-GGGG-HHH";

describe("HydrawisePlatform consolidated options", () => {

  test("resolves a legacy-only configuration through to the effective config", (t) => {

    const { emit, platform } = buildPlatform({ apiKey: LEGACY_KEY, mqttTopic: "legacy-topic", mqttUrl: "mqtt://127.0.0.1:1" });

    t.after(() => emit(SHUTDOWN));

    assert.equal(platform.config.apiKey, LEGACY_KEY, "a legacy API key property resolves as the effective key");
    assert.equal(platform.config.mqttUrl, "mqtt://127.0.0.1:1", "a legacy broker URL property resolves as the effective URL");
    assert.equal(platform.config.mqttTopic, "legacy-topic", "a legacy topic property outranks the catalog default rather than being overwritten by it");
  });

  test("resolves configured options with no legacy properties present", (t) => {

    // The harness always supplies the API key property, so an empty string is how a test says the configuration carries no legacy key at all.
    const { emit, platform } = buildPlatform({ apiKey: "", options: [ "Enable.Account.ApiKey=" + OPTION_KEY, "Enable.Mqtt.Topic=option-topic" ] });

    t.after(() => emit(SHUTDOWN));

    assert.equal(platform.config.apiKey, OPTION_KEY, "a configured API key option resolves with no legacy property in play");
    assert.equal(platform.config.mqttTopic, "option-topic", "a configured topic option resolves with no legacy property in play");
    assert.equal(platform.config.mqttUrl, null, "an unconfigured broker URL resolves to nothing");
    assert.equal(platform.mqtt, null, "no broker URL means no MQTT client and no connection");
  });

  test("a configured option outranks its legacy property for every consolidated setting", (t) => {

    const { emit, platform } = buildPlatform({ apiKey: LEGACY_KEY, mqttTopic: "legacy-topic", mqttUrl: "mqtt://127.0.0.2:1",
      options: [ "Enable.Account.ApiKey=" + OPTION_KEY, "Enable.Mqtt.Topic=option-topic", "Enable.Mqtt.Url=mqtt://127.0.0.1:1" ] });

    t.after(() => emit(SHUTDOWN));

    assert.equal(platform.config.apiKey, OPTION_KEY, "the API key option wins over the legacy property");
    assert.equal(platform.config.mqttUrl, "mqtt://127.0.0.1:1", "the broker URL option wins over the legacy property");
    assert.equal(platform.config.mqttTopic, "option-topic", "the topic option wins over the legacy property");
  });

  test("an explicitly disabled broker URL turns MQTT off despite a legacy property", (t) => {

    const { emit, platform } = buildPlatform({ mqttUrl: "mqtt://127.0.0.1:1", options: ["Disable.Mqtt.Url"] });

    t.after(() => emit(SHUTDOWN));

    assert.equal(platform.config.mqttUrl, null, "an explicit disable resolves to nothing rather than falling back to the legacy property");
    assert.equal(platform.mqtt, null, "a disabled broker URL constructs no client even with a usable legacy URL configured");
  });

  test("an unconfigured topic resolves to the catalog default", (t) => {

    const { emit, platform } = buildPlatform();

    t.after(() => emit(SHUTDOWN));

    assert.equal(platform.config.mqttTopic, "hydrawise", "with no topic property and no topic option, the catalog registration supplies the prefix");
  });

  test("an explicitly disabled topic turns MQTT off beside a usable broker URL", (t) => {

    const { emit, platform } = buildPlatform({ mqttTopic: "legacy-topic", mqttUrl: "mqtt://127.0.0.1:1", options: ["Disable.Mqtt.Topic"] });

    t.after(() => emit(SHUTDOWN));

    assert.equal(platform.config.mqttTopic, null, "an explicitly disabled topic resolves to nothing");
    assert.equal(platform.mqtt, null, "disabling either MQTT option turns the whole feature off, not just that one field");
  });

  test("a valueless topic entry resolves to nothing and turns MQTT off", (t) => {

    const { emit, platform } = buildPlatform({ mqttUrl: "mqtt://127.0.0.1:1", options: ["Enable.Mqtt.Topic"] });

    t.after(() => emit(SHUTDOWN));

    assert.equal(platform.config.mqttTopic, undefined, "an entry that exists carrying no value resolves to nothing, its emptiness included");
    assert.equal(platform.mqtt, null, "an empty topic prefix leaves MQTT off");
  });

  test("a valueless API key entry outranks the legacy key and stops startup", (t) => {

    const { emit, entries, platform } = buildPlatform({ apiKey: LEGACY_KEY, options: ["Enable.Account.ApiKey"] });

    t.after(() => emit(SHUTDOWN));

    assert.equal(platform.config.apiKey, "", "an explicit entry carrying no value resolves to an empty key rather than deferring to the legacy property");
    assert.ok(loggedAt(entries, "error", "no Hunter Hydrawise API key"), "an empty effective key stops startup at the missing-key gate");
  });

  test("an explicitly disabled API key outranks the legacy key and stops startup", (t) => {

    const { emit, entries, platform } = buildPlatform({ apiKey: LEGACY_KEY, options: ["Disable.Account.ApiKey"] });

    t.after(() => emit(SHUTDOWN));

    assert.equal(platform.config.apiKey, "", "an explicitly disabled key is no key, whatever the legacy property carries");
    assert.ok(loggedAt(entries, "error", "no Hunter Hydrawise API key"), "an empty effective key stops startup at the missing-key gate");
  });

  test("a legacy debug property resolves the flag on", (t) => {

    const { emit, entries, platform } = buildPlatform({ debug: true });

    t.after(() => emit(SHUTDOWN));

    assert.equal(platform.config.debug, true, "a legacy debug property resolves as the effective flag");
    assert.ok(loggedAt(entries, "warn", "Debug logging on."), "the resolved flag reaches behavior, routing debug output to warning level");
  });

  test("a configured debug option resolves the flag on over a legacy property that says otherwise", (t) => {

    // The harness leaves the legacy debug property unset by default, so a resolver preferring it would fall through to the catalog's own default of false rather
    // than reading a configured value.
    const { emit, entries, platform } = buildPlatform({ options: ["Enable.Log.Debug"] });

    t.after(() => emit(SHUTDOWN));

    assert.equal(platform.config.debug, true, "an explicitly enabled option outranks the legacy property");
    assert.ok(loggedAt(entries, "warn", "Debug logging on."), "an option-resolved flag reaches behavior just as a legacy property does");
  });

  test("an explicitly disabled debug option outranks a legacy property that says on", (t) => {

    const { emit, entries, platform } = buildPlatform({ debug: true, options: ["Disable.Log.Debug"] });

    t.after(() => emit(SHUTDOWN));

    assert.equal(platform.config.debug, false, "an explicit disable rules, whatever the legacy property carries");
    assert.ok(!loggedAt(entries, "warn", "Debug logging on."), "a disabled flag emits no debug output");
  });

  test("debug resolves off when neither the option nor the legacy property asks for it", (t) => {

    const { emit, platform } = buildPlatform();

    t.after(() => emit(SHUTDOWN));

    assert.equal(platform.config.debug, false, "an unasked-for flag resolves off");
  });

  test("a configured broker URL option constructs a client the platform teardown ends", async (t) => {

    const { emit, mqttFactory, platform } = buildPlatform({ options: ["Enable.Mqtt.Url=mqtt://127.0.0.1:1"] });

    t.after(() => emit(SHUTDOWN));

    // The client is the one the platform built through the harness's factory double, read from the factory's record of the call. assert.ok narrows the nullable
    // answer, which assert.notEqual cannot do, so the aborted read below type-checks without a cast.
    const { client } = expectAt(mqttFactory.createCalls, 0, "the MQTT client the platform built");

    assert.ok(client, "a broker URL configured as an option constructs a client with no legacy property in play");
    assert.equal(platform.mqtt, client, "and the platform holds the client its factory built");

    await platform.shutdown();

    assert.equal(client.aborted, true, "platform teardown ends the client, so nothing it holds outlives the test");
  });
});
