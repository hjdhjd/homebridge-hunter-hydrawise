/* Copyright(C) 2017-2026, HJD (https://github.com/hjdhjd). All rights reserved.
 *
 * mqtt.ts: The single source of truth for the MQTT topics homebridge-hunter-hydrawise publishes and subscribes to.
 */
import { mqttAvailabilityEntryFor, mqttTopicCatalog } from "homebridge-plugin-utils";

/* The plugin's whole MQTT topic surface, declared once and read from here by everything that spells a topic. The controller composes its topics from these
 * entries' tails and logs its get and set lines under the controller entry's label, and the documentation build projects the catalog into the marked regions of
 * docs/MQTT.md, so what the document prints cannot disagree with what the plugin puts on the wire. The presence of `publish`, `get`, and `set` on an entry is the
 * declaration that the plugin performs each verb.
 *
 * The availability entry is the family's own, composed for this plugin's nouns: what the plugin reaches is the Hydrawise cloud, and what it declares available is a
 * controller, so the library's sentence carries those words while the library keeps the sentence itself.
 *
 * The library's builder validates the declaration the moment this module is evaluated, so a malformed catalog fails the plugin's own import rather than reaching a
 * broker. The export carries no type annotation because the builder types it: annotating it would widen the topic to `string` and silence the compile-time check
 * on its tail.
 *
 * This module imports the library and nothing else. The documentation CLI loads it compiled and standalone, exactly as it loads the feature-option catalog, so an
 * import from the controller side would drag the whole HomeKit accessory graph into that load.
 */
export const mqttTopics = mqttTopicCatalog({

  availability: mqttAvailabilityEntryFor({ reaches: "Hydrawise for this controller", subject: "A controller" }),
  controller: {

    get: "`true` requests a publish of the controller's current status on the `controller` topic.",
    label: "controller",
    publish: "A JSON array with one entry per zone, in the order Hydrawise reports them, carrying each zone's `name`, `relay`, `run`, `time`, and `timestr`. While " +
      "the enhanced-features data from your Hydrawise account login is current, each entry also carries `state`, and a suspended zone carries `suspendedUntil`.",
    set: "`start <zone> [<duration>]` runs a zone and `stop <zone>` stops it, where the zone is the zone number shown on the irrigation controller and the " +
      "duration is in seconds. With no duration, the zone runs for its next scheduled duration, or for its remaining time while already running. A duration " +
      "that is not an integer, or no duration for a zone with no scheduled run, is refused and logged. Every command is refused and logged while the controller " +
      "is not responding.",
    topic: "controller"
  }
});
