/* Copyright(C) 2017-2026, HJD (https://github.com/hjdhjd). All rights reserved.
 *
 * mqtt.test.ts: The parity net over the MQTT topic catalog - the declaration the controller's publish and subscribe sites and the generated document all read.
 *
 * The catalog is the one place the controller topic's tail and its log label are spelled, so this file states the shipped surface as literals and holds the
 * declaration to them, and it reads the rendered reference to prove the document the catalog generates names that topic beside the plugin's availability topic.
 */
import { MQTT_AVAILABILITY_TOPIC, renderMqttTopicsReference } from "homebridge-plugin-utils";
import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { mqttTopics } from "./mqtt.ts";

describe("the MQTT topic catalog", () => {

  test("declares the controller topic under its label, and renders it beside the availability topic", () => {

    assert.equal(mqttTopics.controller.topic, "controller", "the catalog's tail is the one the plugin ships");
    assert.equal(mqttTopics.controller.label, "controller", "and its label is the word the client's get and set log lines carry");

    const reference = renderMqttTopicsReference(mqttTopics);

    assert.ok(reference.published.includes("| `" + MQTT_AVAILABILITY_TOPIC + "`"), "the published tables document the availability topic the client publishes");
    assert.ok(reference.published.includes("| `controller`"), "and the controller topic");
    assert.ok(reference.subscribed.includes("| `controller/get`"), "the subscribed table documents the controller topic's get child");
    assert.ok(reference.subscribed.includes("| `controller/set`"), "and its set child");
  });
});
