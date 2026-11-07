/* Copyright(C) 2017-2026, HJD (https://github.com/hjdhjd). All rights reserved.
 *
 * options.ts: Feature option and type definitions for Hydrawise.
 */
import type { FeatureOptionEntry, FeatureOptionScope, Nullable } from "homebridge-plugin-utils";
import { buildComposedScopeDescribers, mqttFeatureOptions } from "homebridge-plugin-utils";
import { HYDRAWISE_MQTT_TOPIC } from "./settings.ts";

/* The plugin's effective configuration, assembled once by the platform constructor. Each setting here resolves there - the configured feature option first,
 * the legacy configuration property as its fallback - so this describes what the plugin actually runs on rather than mirroring the shape of config.json.
 *
 * The account-credential fields carry the feature-option engine's own tri-state answer: a string when a value resolves, null when the option is explicitly
 * disabled, and undefined when an entry exists carrying no value. Every absence means the same thing to the reader downstream - the optional enhanced features
 * stay dormant - which is why each is declared optional as well as nullable: the question mark is what admits the resolver's undefined arm.
 */
export interface HydrawiseOptions {

  apiKey: string;
  debug?: boolean;
  password?: Nullable<string>;
  username?: Nullable<string>;
}

/* A feature option entry for this plugin's catalog. Scope levels are the framework's own vocabulary: "controller" addresses a whole controller and every zone beneath
 * it, "device" addresses a single zone's valve, and "global" addresses every controller on the account. The framework enforces the declaration at every surface it
 * owns - which views an option renders on, and which levels it resolves at - and the runtime narrows its lookups against the option-name unions below.
 *
 * We close the base type's optional-scopes hole so every catalog entry must declare its levels: an entry that forgets them fails to compile rather than silently
 * becoming valid everywhere. An intersection with the base type does not work here - TypeScript resolves an intersected mutable-plus-readonly property as writable -
 * so we Omit the base declaration and redeclare it both required and readonly. The tuple is non-empty by construction, since an option declaring no level at all would
 * render nowhere and resolve nowhere.
 */
export interface HydrawiseFeatureOption extends Omit<FeatureOptionEntry, "scopes"> {

  readonly scopes: readonly [ FeatureOptionScope, ...FeatureOptionScope[] ];
}

// The controller-scopable boolean option names, mirroring at compile time the boolean-tested entries whose scopes declaration includes "controller". The
// value-centric Name entry carries "controller" too, but it resolves instead through the value-centric HydrawiseControllerValueOption union below, so this
// type covers only the boolean half of the controller-scoped catalog. This is the runtime's narrowed lookup key: a call to hasFeature must name one of
// these, so passing a zone-only option to the controller-level lookup is a type error. A catalog this small makes a derived mapping overkill, so we keep
// this compile-time mirror explicit and bind it by convention to the entries' scopes declarations below.
export type HydrawiseControllerOption = "Device" | "Device.Sensor.Rain" | "Device.Standalone" | "Device.Suspend.All" | "Device.Suspend.Zone" | "Device.SyncName" |
  "Log.Zone";

// The zone-scopable boolean option names, mirroring at compile time the boolean-tested entries whose scopes declaration includes "device" - the level this
// plugin projects as a zone. The value-centric Name entry carries "device" too, but it resolves instead through the value-centric HydrawiseZoneValueOption
// union below, so this type covers only the boolean half of the zone-scoped catalog. A call to hasZoneFeature must name one of these, so passing
// Device.Suspend.All (controller-only) with a zone id is a type error rather than a latent scope violation.
export type HydrawiseZoneOption = "Device" | "Device.Standalone" | "Device.Suspend.Zone" | "Device.SyncName" | "Log.Zone";

// The zone-scopable value-centric option names, mirroring at compile time the value-bearing entries the zone level admits. The value accessor narrows against this,
// so asking for a boolean option's value, or for a value option the zone level does not admit, is a type error.
export type HydrawiseZoneValueOption = "Device.Name";

// The controller-scopable value-centric option names, the controller grain's mirror of the union above. Each value-centric reader is separate from the
// others for the same reason the boolean readers are: it narrows against the grain it addresses, so handing a zone id where a controller serial belongs
// is a type error rather than a lookup that quietly resolves the wrong entry.
export type HydrawiseControllerValueOption = "Device.Name";

// The globally-scoped value-centric option names - the account credentials and the MQTT settings the plugin resolves once at startup. The platform's
// consolidated resolver narrows against this, so asking it for an option that carries no global value is a type error. The Mqtt members name the library
// factory's published entries and are bound to them by convention exactly as the unions above are bound to the catalog entries below; renaming any of
// those entries is a breaking change on the library's side.
export type HydrawiseGlobalValueOption = "Account.ApiKey" | "Account.Password" | "Account.Username" | "Mqtt.Topic" | "Mqtt.Url";

// The globally-scoped boolean option names - the settings the plugin resolves once at startup as a simple on or off. The platform's flag resolver narrows against
// this, so asking it for a value-bearing option, or for one no global lookup admits, is a type error. This is the boolean counterpart of the union above, and it is
// bound by convention to the catalog entries below in exactly the same way.
export type HydrawiseGlobalFlagOption = "Log.Debug";

/* The library's canonical MQTT option group, composed once at module scope and read by both the category list and the catalog below, so the two always describe
 * the same group. The factory's default scope is global, which is the only level that fits a plugin holding a single Hydrawise account, and this registration is
 * the runtime's only consumer of the default topic constant, so the prefix a user never overrides is answered by the catalog itself.
 */
const mqtt = mqttFeatureOptions({ defaultTopic: HYDRAWISE_MQTT_TOPIC });

// Feature option categories.
export const featureOptionCategories = [

  { description: "Account feature options.", name: "Account" },
  { description: "Device feature options.", name: "Device" },
  { description: "Logging feature options.", name: "Log" },
  mqtt.category
];

/* eslint-disable @stylistic/max-len */

/* Account options. Each is a value option rather than a schema property so that every setting this plugin has lives in one substrate, and each is global because one
 * account addresses every controller beneath it.
 *
 * The key and the login are different credentials answering to different halves of the Hydrawise API, and only the key is required. The API key drives everything
 * the plugin schedules and controls; the account login unlocks a second, read-only surface that reports details the key-based API does not carry, so leaving the
 * login unset costs nothing beyond those details.
 *
 * The key and the password declare themselves secret, so the settings page renders them masked behind a reveal the user operates. The username does not: it is an
 * email address, it is not a credential on its own, and masking it would only make a field the user needs to read back harder to check. Masking is a presentation
 * choice about who can read the screen, not protection at rest - all three land in config.json as plain text like every other option value.
 *
 * The catalog order is the settings page's render order, so it is deliberate rather than alphabetical: the key first as the required credential, then the login
 * pair in the order a sign-in form reads - username, then password.
 */
const accountOptions: HydrawiseFeatureOption[] = [

  { default: false, defaultValue: "", description: "The API key for your Hydrawise account, generated under Account Details → Account Settings on the Hydrawise website.", inputSize: 19, name: "ApiKey", scopes: ["global"], secret: true },
  { default: false, defaultValue: "", description: "The username for your Hydrawise account, which is the email address you sign in with. Optional: setting it alongside your password enables enhanced features - accurate rain and suspension state for each zone, your rain sensors in HomeKit and on MQTT, whether each controller is reachable, and its real model and firmware details in HomeKit and the webUI.", inputSize: 30, name: "Username", scopes: ["global"] },
  { default: false, defaultValue: "", description: "The password for your Hydrawise account. Optional: setting it alongside your username enables enhanced features - accurate rain and suspension state for each zone, your rain sensors in HomeKit and on MQTT, whether each controller is reachable, and its real model and firmware details in HomeKit and the webUI.", inputSize: 20, name: "Password", scopes: ["global"], secret: true }
];

// Device options.
const deviceOptions: HydrawiseFeatureOption[] = [

  { default: true, description: "Make this device available in HomeKit.", name: "", scopes: [ "controller", "device", "global" ] },
  { default: false, defaultValue: "", description: "Custom HomeKit name for this zone or controller and its parts. It always applies, so a rename in the Home app yields to it wherever HomeKit allows.", inputSize: 30, name: "Name", scopes: [ "controller", "device" ] },
  { default: true, description: "Enable one contact sensor for each rain sensor on this controller, open while the rain sensor is tripped. Requires your Hydrawise account login (enhanced features).", name: "Sensor.Rain", scopes: [ "controller", "global" ] },
  { default: false, description: "Expose this zone as its own HomeKit accessory, assignable to any room. Toggling this changes the zone's HomeKit identity, so automations, scenes, and room assignments tied to it must be recreated.", name: "Standalone", scopes: [ "controller", "device", "global" ] },
  { default: false, description: "Enable a switch accessory that suspends and resumes every zone on the controller at once.", name: "Suspend.All", scopes: [ "controller", "global" ] },
  { default: false, description: "Enable a switch accessory that suspends and resumes an individual zone. Requires your Hydrawise account login (enhanced features).", name: "Suspend.Zone", scopes: [ "controller", "device", "global" ] },
  { default: false, description: "Synchronize the Hydrawise name of this zone or controller and its parts with HomeKit. A rename in the Home app yields to it wherever HomeKit allows. A custom Name takes precedence.", name: "SyncName", scopes: [ "controller", "device", "global" ] }
];

// Logging options.
const logOptions: HydrawiseFeatureOption[] = [

  { default: false, description: "Enable debug logging.", name: "Debug", scopes: ["global"] },
  { default: true, description: "Log zone start and stop events in Homebridge.", name: "Zone", scopes: [ "controller", "device", "global" ] }
];

/* eslint-enable @stylistic/max-len */

/* The full option catalog, assembled from the categories this plugin authors and the group the library contributes. Each authored entry declares the scope
 * levels it may be configured at; the framework gates row visibility and scope resolution on those, and the runtime narrows its lookups through the
 * option-name unions above.
 *
 * Two types are at work here on purpose, and neither needs a cast. The authored arrays are typed as our own entry, which is what enforces the scopes
 * declaration at the site where an entry is written and a forgotten declaration is a compile error. The exported record speaks the framework's own entry
 * vocabulary, which is the wider type, so a library-composed group drops straight in beside the authored ones.
 */
export const featureOptions: Record<string, FeatureOptionEntry[]> = {

  "Account": accountOptions,
  "Device": deviceOptions,
  "Log": logOptions,
  [mqtt.category.name]: mqtt.options
};

/* The documentation hooks the docs renderer consumes, composed by the library: the vocabulary below is this plugin's own name for each scope level, as a complete
 * phrase carrying its own preposition, and the sentence around the list - the leading word, the "or" grammar, the italics - is the renderer family's.
 */
export const { describeCategoryScope, describeOptionScope } = buildComposedScopeDescribers({

  vocabulary: { "controller": "on the whole controller", "device": "on each zone", "global": "globally across every controller" }
});
