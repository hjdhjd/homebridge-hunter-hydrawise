/* Copyright(C) 2017-2026, HJD (https://github.com/hjdhjd). All rights reserved.
 *
 * config.test.ts: The webUI's pure platform-configuration interpreters, exercised against the REAL feature-option engine and the REAL option catalog
 * so the pins bind to the same grammar the plugin's runtime resolves against. Covers the effective-key precedence, every arm of the legacy-settings migration -
 * what migrates, what deletes without migrating, and what declines entirely - the first-run write, the degraded-mode interpreter, a round trip proving a
 * migrated configuration runs the platform on the same effective values the legacy one did, and the page's naming rule held to the runtime's composers.
 *
 * One discipline binds every claim about a deleted property: a patch carries a deletion as a PRESENT key whose value is undefined, and carries a non-deletion by
 * omitting the key. An equality read cannot tell those apart, and the session's shallow-merge commit treats them oppositely, so presence is asserted with
 * Object.hasOwn and absence with its negation - never with a comparison against undefined.
 */
import { API_KEY_LENGTH, makeHydrawiseConfig, makeHydrawiseNames, makeLegacyHydrawiseConfig } from "../homebridge-ui/public/hydrawise-config.mjs";
import { FeatureOptions, displayedName, sanitizeName } from "homebridge-plugin-utils";
import { controllerDisplayName, zoneDisplayName } from "./types.ts";
import { describe, test } from "node:test";
import { featureOptionCategories, featureOptions } from "./options.ts";
import assert from "node:assert/strict";
import { buildPlatform } from "./testing/platform.helpers.ts";

// APIEvent.SHUTDOWN's string value, fired to tear down a platform the round-trip pin builds.
const SHUTDOWN = "shutdown";

// The two API keys the precedence pins tell apart: one carried by a legacy property, one carried by a configured option.
const LEGACY_KEY = "AAAA-BBBB-CCCC-DDD";
const OPTION_KEY = "EEEE-FFFF-GGGG-HHH";

// The optional account login. The username carries an "=" deliberately - an email address does not, but the entry grammar's own value delimiter does, so a value
// split on the last delimiter rather than the first would come back truncated here.
const ACCOUNT_USERNAME = "gardener=test@example.com";
const ACCOUNT_PASSWORD = "correct horse battery";

// The interpreter under test, built the way the webUI builds it: the real engine class and the real served catalog.
const config = makeHydrawiseConfig({ FeatureOptions, catalog: { categories: featureOptionCategories, options: featureOptions } });

// The entries in an options array that address a given option, case-insensitively, in either the enabled or the disabled form.
function entriesFor(options: string[] | undefined, option: string): string[] {

  const prefix = option.toLowerCase();

  return (options ?? []).filter((entry) => [ "enable." + prefix, "disable." + prefix ].some((form) => entry.toLowerCase().startsWith(form)));
}

describe("hydrawise webUI config interpreters", () => {

  test("exports the API key length the first-run screen validates against", () => {

    assert.equal(API_KEY_LENGTH, 19, "a Hydrawise API key is always nineteen characters");
  });

  test("migrate declines when there is nothing to migrate", () => {

    assert.equal(config.migrate(undefined), null, "an absent config has nothing to migrate");
    assert.equal(config.migrate({}), null, "a config carrying none of the legacy properties has nothing to migrate");
    assert.equal(config.migrate({ options: [ "Enable.Account.ApiKey=" + OPTION_KEY, "Disable.Device.ABC123" ] }), null,
      "an already-migrated config finds nothing to do on a second pass");
  });

  test("each legacy property migrates into its option and leaves the property for deletion", () => {

    for(const [ property, option, value ] of [ [ "apiKey", "Account.ApiKey", LEGACY_KEY ], [ "mqttUrl", "Mqtt.Url", "mqtt://127.0.0.1:1883" ],
      [ "mqttTopic", "Mqtt.Topic", "garden" ] ] as [ string, string, string ][]) {

      const patch = config.migrate({ [property]: value });

      assert.ok(patch, "a config carrying " + property + " should produce a patch");
      assert.deepEqual(entriesFor(patch.options, option), ["Enable." + option + "=" + value], option + " should compose one entry carrying the exact value");
      assert.ok(Object.hasOwn(patch, property), property + " should ride the patch as a present key so the commit deletes it");
      assert.equal(patch[property as keyof typeof patch], undefined, property + " should be carried as undefined");
    }
  });

  test("an empty or non-string legacy value deletes without migrating", () => {

    const empty = config.migrate({ mqttTopic: "" });

    assert.ok(empty, "an empty legacy value still produces a deletion patch");
    assert.ok(Object.hasOwn(empty, "mqttTopic"), "the empty property should still be deleted");
    assert.ok(!Object.hasOwn(empty, "options"), "an empty value composes no entry, so the patch carries no options array");

    const numeric = config.migrate({ mqttTopic: 42 });

    assert.ok(numeric, "a hand-edited non-string value still produces a deletion patch");
    assert.ok(Object.hasOwn(numeric, "mqttTopic"), "the non-string property should still be deleted");
    assert.ok(!Object.hasOwn(numeric, "options"), "a non-string value composes no entry, so the patch carries no options array");
  });

  test("an already-configured option outranks the legacy property", () => {

    const patch = config.migrate({ mqttUrl: "mqtt://127.0.0.2:1883", options: ["Enable.Mqtt.Url=mqtt://127.0.0.1:1883"] });

    assert.ok(patch, "the legacy property should still be deleted");
    assert.ok(Object.hasOwn(patch, "mqttUrl"), "the superseded property rides the patch for deletion");
    assert.ok(!Object.hasOwn(patch, "options"), "an existing entry is the user's own choice, so nothing is composed over it");
  });

  test("an explicitly disabled option counts as configured", () => {

    const patch = config.migrate({ mqttUrl: "mqtt://127.0.0.1:1883", options: ["Disable.Mqtt.Url"] });

    assert.ok(patch, "the legacy property should still be deleted");
    assert.ok(Object.hasOwn(patch, "mqttUrl"), "the property rides the patch for deletion");
    assert.ok(!Object.hasOwn(patch, "options"), "a disable is a configured entry, so the legacy value does not overwrite it");
  });

  test("a legacy value equal to the option's registered default deletes without composing", () => {

    const patch = config.migrate({ mqttTopic: "hydrawise" });

    assert.ok(patch, "the property should still be deleted");
    assert.ok(Object.hasOwn(patch, "mqttTopic"), "the property rides the patch for deletion");
    assert.ok(!Object.hasOwn(patch, "options"), "a value that only restates the catalog default manufactures no configuration");
  });

  test("a multi-property config migrates every setting in one patch and preserves unrelated entries", () => {

    const patch = config.migrate({ apiKey: LEGACY_KEY, mqttTopic: "garden", mqttUrl: "mqtt://127.0.0.1:1883",
      options: [ "Disable.Device.ABC123", "Enable.Log.Zone.DEF456" ] });

    assert.ok(patch, "a config carrying all three properties should produce a patch");

    for(const property of [ "apiKey", "mqttTopic", "mqttUrl" ]) {

      assert.ok(Object.hasOwn(patch, property), property + " should ride the patch for deletion");
    }

    assert.deepEqual(entriesFor(patch.options, "Account.ApiKey"), ["Enable.Account.ApiKey=" + LEGACY_KEY], "the key should compose one entry");
    assert.deepEqual(entriesFor(patch.options, "Mqtt.Topic"), ["Enable.Mqtt.Topic=garden"], "the topic should compose one entry");
    assert.deepEqual(entriesFor(patch.options, "Mqtt.Url"), ["Enable.Mqtt.Url=mqtt://127.0.0.1:1883"], "the broker URL should compose one entry");

    for(const preserved of [ "Disable.Device.ABC123", "Enable.Log.Zone.DEF456" ]) {

      assert.ok(patch.options?.includes(preserved), preserved + " should survive the migration untouched");
    }
  });

  test("withFirstRun composes the key option, replacing any entry already addressing it", () => {

    const fresh = config.withFirstRun({}, { apiKey: OPTION_KEY });

    assert.deepEqual(entriesFor(fresh.options, "Account.ApiKey"), ["Enable.Account.ApiKey=" + OPTION_KEY], "a fresh config composes the entry");
    assert.ok(Object.hasOwn(fresh, "apiKey"), "the write always carries the legacy property for deletion");
    assert.equal(fresh.apiKey, undefined, "the legacy property is carried as undefined");

    const replaced = config.withFirstRun({ options: [ "Enable.Account.ApiKey=" + LEGACY_KEY, "Disable.Device.ABC123" ] }, { apiKey: OPTION_KEY });

    assert.deepEqual(entriesFor(replaced.options, "Account.ApiKey"), ["Enable.Account.ApiKey=" + OPTION_KEY],
      "an existing key entry is replaced rather than duplicated");
    assert.ok(replaced.options?.includes("Disable.Device.ABC123"), "unrelated entries survive the write");
  });

  test("withFirstRun composes the key and both account credentials into ONE patch", () => {

    const patch = config.withFirstRun({ options: ["Disable.Device.ABC123"] }, { apiKey: OPTION_KEY, password: ACCOUNT_PASSWORD, username: ACCOUNT_USERNAME });

    /* Every value withFirstRun composes has to survive the same patch. Each write through an engine answers its own complete snapshot of the options array, so
     * a writer that split them across separate engines and merged the results would keep only the last snapshot and silently drop the rest - which is exactly
     * what this assertion catches.
     */
    assert.deepEqual(entriesFor(patch.options, "Account.ApiKey"), ["Enable.Account.ApiKey=" + OPTION_KEY], "the key rides the patch");
    assert.deepEqual(entriesFor(patch.options, "Account.Username"), ["Enable.Account.Username=" + ACCOUNT_USERNAME], "the username rides the same patch");
    assert.deepEqual(entriesFor(patch.options, "Account.Password"), ["Enable.Account.Password=" + ACCOUNT_PASSWORD], "the password rides the same patch");
    assert.ok(patch.options?.includes("Disable.Device.ABC123"), "unrelated entries survive the write");
  });

  test("withFirstRun writes the account credentials only as a complete pair", () => {

    // Neither half authenticates alone, so writing one would configure a login that cannot work. A partial pair leaves the configuration exactly as it stood.
    for(const values of [ { apiKey: OPTION_KEY, username: ACCOUNT_USERNAME }, { apiKey: OPTION_KEY, password: ACCOUNT_PASSWORD },
      { apiKey: OPTION_KEY, password: "", username: ACCOUNT_USERNAME } ]) {

      const patch = config.withFirstRun({}, values);

      assert.deepEqual(entriesFor(patch.options, "Account.Username"), [], "a partial pair composes no username entry");
      assert.deepEqual(entriesFor(patch.options, "Account.Password"), [], "a partial pair composes no password entry");
      assert.deepEqual(entriesFor(patch.options, "Account.ApiKey"), ["Enable.Account.ApiKey=" + OPTION_KEY], "the key is still written");
    }
  });

  test("the account credentials read back from the option alone, with no legacy precedence", () => {

    const written = config.withFirstRun({}, { apiKey: OPTION_KEY, password: ACCOUNT_PASSWORD, username: ACCOUNT_USERNAME });

    assert.equal(config.username({ options: written.options }), ACCOUNT_USERNAME, "the username reads back from the entry the write composed");
    assert.equal(config.password({ options: written.options }), ACCOUNT_PASSWORD, "the password reads back from the entry the write composed");

    /* There is deliberately no legacy-property arm to test here, unlike the API key. These settings have never had a config.json property, so a raw property
     * carrying one is not an older configuration to honor - it is a hand edit addressing nothing, and it reads as nothing set.
     *
     * The hand edit reaches the reader through a cast because the config type declares no such properties, and declaring them would describe a home these
     * settings do not have. The cast is the honest model of where the shape comes from: a user's own config.json, which answers to no static type.
     */
    const handEdited = { password: "raw-password", username: "raw-username" } as unknown as Parameters<typeof config.username>[0];

    assert.equal(config.username(handEdited), "", "a raw property is not a home these settings have");
    assert.equal(config.password(handEdited), "", "and the same for the password");
    assert.equal(config.username({}), "", "an unconfigured account reads as nothing set");
    assert.equal(config.password({}), "", "and the same for the password");
  });

  test("an explicitly disabled credential option reads as nothing set", () => {

    assert.equal(config.username({ options: ["Disable.Account.Username"] }), "", "an explicitly disabled option is the user saying there is no username");
    assert.equal(config.password({ options: ["Enable.Account.Password"] }), "", "an entry carrying no value reads as nothing set");
  });

  test("the effective API key reads the option first and the property second", () => {

    assert.equal(config.apiKey({ apiKey: LEGACY_KEY, options: ["Enable.Account.ApiKey=" + OPTION_KEY] }), OPTION_KEY,
      "a configured option outranks the legacy property");
    assert.equal(config.apiKey({ apiKey: LEGACY_KEY }), LEGACY_KEY, "the legacy property answers when no entry exists");
    assert.equal(config.apiKey({}), "", "a config carrying neither reads as no key");
    assert.equal(config.apiKey({ options: ["Enable.Account.ApiKey"] }), "", "an entry carrying no value reads as no key");
    assert.equal(config.apiKey({ apiKey: LEGACY_KEY, options: ["Disable.Account.ApiKey"] }), "",
      "an explicitly disabled key is no key, and the legacy property does not override it");
  });

  test("a legacy debug flag set on migrates to a valueless enable entry", () => {

    const patch = config.migrate({ debug: true });

    assert.ok(patch, "a config carrying debug should produce a patch");
    assert.deepEqual(entriesFor(patch.options, "Log.Debug"), ["Enable.Log.Debug"], "a flag composes the valueless enable form, carrying no value");
    assert.ok(Object.hasOwn(patch, "debug"), "the legacy property rides the patch for deletion");
  });

  test("a legacy debug flag set off deletes without composing", () => {

    const patch = config.migrate({ debug: false });

    assert.ok(patch, "the property should still be deleted");
    assert.ok(Object.hasOwn(patch, "debug"), "the property rides the patch for deletion");
    assert.ok(!Object.hasOwn(patch, "options"), "off is what the catalog already declares, so no entry is manufactured for it");
  });

  test("a non-boolean debug value deletes without composing", () => {

    const patch = config.migrate({ debug: "yes" });

    assert.ok(patch, "a hand-edited non-boolean still produces a deletion patch");
    assert.ok(Object.hasOwn(patch, "debug"), "the property rides the patch for deletion");
    assert.ok(!Object.hasOwn(patch, "options"), "a value we decline to interpret composes nothing");
  });

  test("an explicitly disabled debug option outranks the legacy flag", () => {

    const patch = config.migrate({ debug: true, options: ["Disable.Log.Debug"] });

    assert.ok(patch, "the legacy property should still be deleted");
    assert.ok(Object.hasOwn(patch, "debug"), "the property rides the patch for deletion");
    assert.ok(!Object.hasOwn(patch, "options"), "a disable is a configured entry, so the legacy flag does not overwrite it");
  });

  test("an already-enabled debug option is not composed a second time", () => {

    const patch = config.migrate({ debug: true, options: [ "Enable.Log.Debug", "Disable.Device.ABC123" ] });

    assert.ok(patch, "the legacy property should still be deleted");
    assert.ok(Object.hasOwn(patch, "debug"), "the property rides the patch for deletion");
    assert.ok(!Object.hasOwn(patch, "options"), "an existing entry already says what the property says, so nothing is composed over it");
  });

  test("a migrated configuration runs the platform on the same effective values as the legacy one", (t) => {

    // debug is seeded true deliberately. Seeded false it would compare the catalog default against itself on both sides and prove nothing about the flag arm.
    const legacy = { apiKey: LEGACY_KEY, debug: true, mqttTopic: "garden", mqttUrl: "mqtt://127.0.0.1:1" };
    const patch = config.migrate(legacy);

    // The identity comparison below would pass vacuously against a migration that did nothing, so the patch is proven non-empty before it is applied.
    assert.ok(patch, "the migration should produce a patch");
    assert.ok(patch.options?.length, "the patch should carry composed entries");

    for(const property of [ "apiKey", "debug", "mqttTopic", "mqttUrl" ]) {

      assert.ok(Object.hasOwn(patch, property), property + " should ride the patch for deletion");
    }

    // Apply the patch the way the webUI stages it, then build a real platform on each configuration and compare what each resolves.
    const migrated = { ...legacy, ...patch };
    const before = buildPlatform(legacy);
    const after = buildPlatform({ apiKey: migrated.apiKey, debug: migrated.debug, mqttTopic: migrated.mqttTopic, mqttUrl: migrated.mqttUrl,
      options: migrated.options });

    t.after(() => {

      before.emit(SHUTDOWN);
      after.emit(SHUTDOWN);
    });

    assert.equal(after.platform.config.apiKey, before.platform.config.apiKey, "the migrated config resolves the same effective API key");
    assert.equal(after.platform.config.mqttUrl, before.platform.config.mqttUrl, "the migrated config resolves the same effective broker URL");
    assert.equal(after.platform.config.mqttTopic, before.platform.config.mqttTopic, "the migrated config resolves the same effective topic prefix");
    assert.equal(before.platform.config.debug, true, "the legacy configuration resolves debug on, so the comparison below is not two defaults agreeing");
    assert.equal(after.platform.config.debug, before.platform.config.debug, "the migrated config resolves the same effective debug flag");
  });

  test("a whitespace-padded legacy value migrates trimmed", () => {

    const patch = config.migrate({ mqttTopic: " garden " });

    assert.ok(patch, "the padded value should produce a patch");
    assert.deepEqual(entriesFor(patch.options, "Mqtt.Topic"), ["Enable.Mqtt.Topic=garden"], "the engine trims the value it stores");
    assert.ok(Object.hasOwn(patch, "mqttTopic"), "the property is still deleted");
  });

  test("a legacy key present with the value undefined counts as absent on its own", () => {

    assert.equal(config.migrate({ apiKey: undefined }), null, "a key staged to undefined is the terminal shape, so a second pass stages nothing");
  });

  test("a legacy key present with the value undefined is left out of a patch a defined sibling drives", () => {

    const patch = config.migrate({ apiKey: undefined, mqttTopic: "garden" });

    assert.ok(patch, "a genuinely defined sibling still migrates");
    assert.ok(!Object.hasOwn(patch, "apiKey"), "the already-staged key is not re-included, which would be churn");
    assert.ok(Object.hasOwn(patch, "mqttTopic"), "the defined sibling still rides the patch for deletion");
  });

  test("an options substrate that is not an array declines rather than guessing", () => {

    assert.equal(config.migrate({ apiKey: LEGACY_KEY, options: {} }), null, "an unparseable options substrate leaves the whole config alone");
  });

  test("the degraded-mode interpreter reads what the real interpreter writes", () => {

    const legacy = makeLegacyHydrawiseConfig();

    assert.equal(legacy.apiKey({ apiKey: LEGACY_KEY }), LEGACY_KEY, "the legacy property answers directly");
    assert.equal(legacy.migrate({ apiKey: LEGACY_KEY }), null, "degraded mode never migrates blind");
    assert.deepEqual(legacy.withFirstRun({}, { apiKey: OPTION_KEY }), { apiKey: OPTION_KEY }, "the degraded key write is the legacy-shaped one");
    assert.equal(legacy.apiKey({}), "", "a config carrying neither reads as no key");

    /* The scan is cross-checked end to end against what the real interpreter actually produces, never against a hand-typed entry, so a drifted prefix fails
     * here rather than silently sending a migrated install back through first run.
     */
    const written = { ...{}, ...config.withFirstRun({}, { apiKey: OPTION_KEY }) };

    assert.equal(legacy.apiKey(written), OPTION_KEY, "a first-run write is readable in a later degraded session");

    const source = { apiKey: LEGACY_KEY };
    const patch = config.migrate(source);

    assert.ok(patch, "the migration should produce a patch");
    assert.equal(legacy.apiKey({ ...source, ...patch }), LEGACY_KEY, "a migrated config is readable in a later degraded session");
  });

  test("the degraded interpreter writes the account credentials as option entries, not as properties", () => {

    const legacy = makeLegacyHydrawiseConfig();
    const patch = legacy.withFirstRun({ options: ["Disable.Device.ABC123"] }, { apiKey: OPTION_KEY, password: ACCOUNT_PASSWORD, username: ACCOUNT_USERNAME });

    /* The key writes a property because a property is always safe to write blind. The credentials cannot: there is no property home for them, so a property write
     * would land somewhere nothing ever reads and the user's validated login would silently evaporate. They compose the canonical entry instead.
     */
    assert.equal(patch.apiKey, OPTION_KEY, "the key still takes the safe property write");
    assert.deepEqual(entriesFor(patch.options, "Account.Username"), ["Enable.Account.Username=" + ACCOUNT_USERNAME], "the username composes an entry");
    assert.deepEqual(entriesFor(patch.options, "Account.Password"), ["Enable.Account.Password=" + ACCOUNT_PASSWORD], "the password composes an entry");
    assert.ok(patch.options?.includes("Disable.Device.ABC123"), "unrelated entries survive the write");
  });

  test("the degraded credential write replaces rather than accumulates", () => {

    const legacy = makeLegacyHydrawiseConfig();
    const first = legacy.withFirstRun({}, { apiKey: OPTION_KEY, password: "first-password", username: "first-user" });
    const second = legacy.withFirstRun({ options: first.options }, { apiKey: OPTION_KEY, password: ACCOUNT_PASSWORD, username: ACCOUNT_USERNAME });

    // Without a supersede pass there is no engine to deduplicate, so a second validation would leave two entries addressing the same option and the reader would
    // answer whichever it happened to reach first.
    assert.deepEqual(entriesFor(second.options, "Account.Username"), ["Enable.Account.Username=" + ACCOUNT_USERNAME], "exactly one username entry survives");
    assert.deepEqual(entriesFor(second.options, "Account.Password"), ["Enable.Account.Password=" + ACCOUNT_PASSWORD], "exactly one password entry survives");
  });

  test("the degraded credential write supersedes an explicitly disabled entry too", () => {

    const legacy = makeLegacyHydrawiseConfig();
    const patch = legacy.withFirstRun({ options: [ "Disable.Account.Username", "Enable.Account.Password" ] },
      { apiKey: OPTION_KEY, password: ACCOUNT_PASSWORD, username: ACCOUNT_USERNAME });

    // A disabled entry and a valueless enabled entry both address the option, so both are superseded. Leaving either behind would put two entries on the same
    // option with opposite meanings.
    assert.deepEqual(entriesFor(patch.options, "Account.Username"), ["Enable.Account.Username=" + ACCOUNT_USERNAME], "the disable is replaced, not stacked under");
    assert.deepEqual(entriesFor(patch.options, "Account.Password"), ["Enable.Account.Password=" + ACCOUNT_PASSWORD], "the valueless entry is replaced too");
  });

  test("the two interpreters read each other's credential writes", () => {

    const legacy = makeLegacyHydrawiseConfig();
    const values = { apiKey: OPTION_KEY, password: ACCOUNT_PASSWORD, username: ACCOUNT_USERNAME };

    /* Both directions matter, because a session can degrade or recover between one open and the next. What is on disk has to be ONE shape either way: a degraded
     * session's write must be readable once the catalog is back, and a healthy session's write must still be readable if the next one cannot fetch it.
     */
    const degradedWrite = { ...{}, ...legacy.withFirstRun({}, values) };

    assert.equal(config.username(degradedWrite), ACCOUNT_USERNAME, "a degraded write is readable by the catalog-backed interpreter");
    assert.equal(config.password(degradedWrite), ACCOUNT_PASSWORD, "and the password with it");

    const healthyWrite = { ...{}, ...config.withFirstRun({}, values) };

    assert.equal(legacy.username(healthyWrite), ACCOUNT_USERNAME, "a healthy write is readable by the degraded interpreter");
    assert.equal(legacy.password(healthyWrite), ACCOUNT_PASSWORD, "and the password with it");
  });

  test("the platform resolves the credentials a first-run write composed", (t) => {

    // The end-to-end claim: what the webUI writes is what the runtime reads. The interpreter composes the entries, a real platform is built on them, and the
    // effective configuration it assembles is what the account-credentialed client would be constructed from.
    const written = config.withFirstRun({}, { apiKey: OPTION_KEY, password: ACCOUNT_PASSWORD, username: ACCOUNT_USERNAME });
    const built = buildPlatform({ apiKey: "", options: written.options });

    t.after(() => built.emit(SHUTDOWN));

    assert.equal(built.platform.config.username, ACCOUNT_USERNAME, "the runtime resolves the username the webUI wrote");
    assert.equal(built.platform.config.password, ACCOUNT_PASSWORD, "the runtime resolves the password the webUI wrote");
    assert.equal(built.platform.hasV2Client, true, "and builds the account-credentialed client from them");
  });
});

describe("hydrawise webUI retired-option rename migration", () => {

  const SERIAL = "SN0A1B2C3D4";

  // The options array a patch carries, failing the test rather than returning undefined so no assertion below passes vacuously against an absent write.
  function migratedOptions(source: { apiKey?: string; options?: string[] }): string[] {

    const patch = config.migrate(source);

    assert.ok(patch, "the migration should stage a patch");
    assert.ok(patch.options, "the patch should carry the rewritten options array");

    return patch.options;
  }

  test("every shape of a retired entry is rewritten losslessly", () => {

    /* The four shapes the grammar admits, each carrying information the rewrite must preserve: the action prefix says what the user chose, and the trailing
     * identifier says which controller they chose it for, in the casing they typed.
     */
    const cells = [

      { expected: "Enable.Device.Suspend.All", label: "enabled globally", source: "Enable.Device.Suspend" },
      { expected: "Disable.Device.Suspend.All", label: "disabled globally", source: "Disable.Device.Suspend" },
      { expected: "Enable.Device.Suspend.All." + SERIAL, label: "enabled at a controller", source: "Enable.Device.Suspend." + SERIAL },
      { expected: "Disable.Device.Suspend.All." + SERIAL, label: "disabled at a controller", source: "Disable.Device.Suspend." + SERIAL }
    ];

    for(const { expected, label, source } of cells) {

      assert.deepEqual(migratedOptions({ options: [source] }), [expected], "an entry " + label + " keeps its action and its scope");
    }
  });

  test("an entry already addressing the new family passes through untouched", () => {

    /* The collision the catalog anchoring exists to prevent. A naive "retired name plus one trailing segment" match would read `Enable.Device.Suspend.All` as the
     * retired option scoped to a device called "All" and rewrite it to nonsense, and would do the same to every sibling the family later grows.
     */
    const family = makeHydrawiseConfig({ FeatureOptions, catalog: { categories: featureOptionCategories,
      options: { ...featureOptions, ["Device"]: [ ...(featureOptions["Device"] ?? []),
        { default: false, description: "Suspend one zone.", name: "Suspend.Zone", scopes: [ "controller", "device", "global" ] } ] } } });

    const untouched = [ "Enable.Device.Suspend.All", "Disable.Device.Suspend.All." + SERIAL, "Enable.Device.Suspend.Zone", "Enable.Device.Suspend.Zone.700001" ];

    assert.equal(family.migrate({ options: untouched }), null, "a configuration already speaking the new vocabulary needs no migration at all");
  });

  test("the rename runs on a configuration that carries no legacy properties at all", () => {

    /* The gating pin, and the one that decides whether this migration reaches anybody. The property scan answers null the moment a configuration carries no legacy
     * properties, which is true of nearly every install that has already been migrated once - so a rename gated behind it would never run for them.
     */
    assert.deepEqual(migratedOptions({ options: [ "Enable.Device.Suspend." + SERIAL, "Enable.Log.Zone" ] }),
      [ "Enable.Device.Suspend.All." + SERIAL, "Enable.Log.Zone" ], "the rename lands and every unrelated entry is left exactly as it was");
  });

  test("running the migration twice changes nothing the second time", () => {

    const once = migratedOptions({ options: [ "Enable.Device.Suspend", "Disable.Device.Suspend." + SERIAL ] });

    // Run-twice is a no-op by construction rather than by a guard: the rewritten entries address a current catalog key, which the first rule passes through.
    assert.equal(config.migrate({ options: once }), null, "a second pass finds nothing left to rename");
  });

  test("a configuration with no retired entries is left alone", () => {

    assert.equal(config.migrate({ options: [ "Enable.Device.Standalone.700001", "Disable.Device.ABC123" ] }), null, "nothing to rename means nothing to stage");
    assert.equal(config.migrate({}), null, "and neither does an empty configuration");
  });

  test("a legacy property and a retired option name both migrate in ONE pass", () => {

    /* The same-pass pin. Both migrations compose one options array, so neither write can clobber the other - which is exactly what two independent writers each
     * answering a whole array would do under the session's shallow merge.
     */
    // The cast is the same honest model used for the hand-edited value above: migrate() comes from an untyped module, so the shape asserted here is where it
    // comes from, not something the module itself declares.
    const patch = config.migrate({ apiKey: LEGACY_KEY, options: ["Enable.Device.Suspend." + SERIAL] }) as { apiKey?: string; options?: string[] } | null;

    assert.ok(patch, "the migration should stage a patch");
    assert.ok(Object.hasOwn(patch, "apiKey"), "the legacy key is staged for deletion");
    assert.deepEqual(entriesFor(patch.options, "Account.ApiKey"), ["Enable.Account.ApiKey=" + LEGACY_KEY], "the key became its option entry");
    assert.deepEqual(entriesFor(patch.options, "Device.Suspend.All"), ["Enable.Device.Suspend.All." + SERIAL], "and the retired name was renamed in the same array");
  });

  test("the module's catalog anchoring agrees with the engine's own composition for every served option", () => {

    /* The matching-parity pin. The module composes its current-key set from the served catalog by hand, because it is import-free and can consume no engine
     * export; this asserts that the hand composition agrees with the engine's own expandOption for every option the catalog declares, which is the drift this
     * rule would otherwise be exposed to. An entry addressing a current key must always pass through, and passing through is observable as "nothing staged".
     */
    const engine = new FeatureOptions(featureOptionCategories, featureOptions, []);
    const keys = Object.entries(featureOptions).flatMap(([ category, entries ]) => entries.map((entry) => engine.expandOption(category, entry.name)));

    assert.ok(keys.length > 5, "the catalog should carry enough options for this sweep to mean something");

    for(const key of keys) {

      assert.equal(config.migrate({ options: [ "Enable." + key, "Disable." + key + "." + SERIAL ] }), null,
        "an entry addressing the current option " + key + " is never rewritten");
    }
  });
});

describe("hydrawise webUI names", () => {

  // The page's naming rule, built the way the webUI builds it, over HBPU's own naming functions.
  const names = makeHydrawiseNames({ displayedName, sanitizeName });

  test("the page names every controller and zone as the runtime's composers name it in HomeKit", () => {

    /* The parity row. The page's naming module is import-free and carries its own copies of the kind's words, so this holds its answer to the runtime's composers,
     * sanitized as every HomeKit write sanitizes them, over every source a name can come from. The table carries a Name that sanitizing rewrites, so a page that
     * showed a name unsanitized fails it, reported names HomeKit can carry nothing of, so a page that named them by another word or dropped a zone's number fails
     * it, reported names that are the kind's word, which read as themselves, and more than one relay, so a zone's number cannot come from anywhere but its own.
     */
    const overrides = [ undefined, null, "   ", "\u{1F331}\u{1F331}", "Front/Back Lawn", "\u{1F331} Front Lawn", "Garden Controller" ];

    for(const relay of [ 1, 3 ]) {

      for(const reported of [ "\u{1F331}", "***", "Side Yard", "Controller", "Zone " + relay.toString() ]) {

        for(const override of overrides) {

          const label = "the Name " + JSON.stringify(override) + " over the reported name " + JSON.stringify(reported);

          assert.equal(names.controllerName({ override, reported }), sanitizeName(controllerDisplayName({ override, reported }).name),
            "a controller with " + label + " reads as HomeKit carries it");
          assert.equal(names.zoneName({ override, relay, reported }), sanitizeName(zoneDisplayName({ override, relay, reported }).name),
            "a zone at relay " + relay.toString() + " with " + label + " reads as HomeKit carries it");
        }
      }
    }
  });
});
