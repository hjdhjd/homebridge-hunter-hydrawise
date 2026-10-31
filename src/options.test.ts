/* Copyright(C) 2017-2026, HJD (https://github.com/hjdhjd). All rights reserved.
 *
 * options.test.ts: The feature-option catalog and its documentation hook. Pins the catalog defaults, the scope-set drift between the catalog's declared
 * scopes and the compile-time controller/zone option-name unions the runtime narrows against, that the account credentials declare themselves secret where
 * the settings page must mask them, and the describeOptionScope prose the docs renderer consumes.
 */
import type { FeatureCategoryEntry, FeatureOptionEntry, FeatureOptionScope } from "homebridge-plugin-utils";
import type { HydrawiseControllerOption, HydrawiseZoneOption } from "./options.ts";
import { describe, test } from "node:test";
import { describeOptionScope, featureOptionCategories, featureOptions } from "./options.ts";
import assert from "node:assert/strict";

// Compute the full option name for a catalog entry, joining the category with the entry name (an empty entry name is the category-level option).
function fullName(category: string, entry: FeatureOptionEntry): string {

  return entry.name ? category + "." + entry.name : category;
}

// Look up a catalog entry by category and entry name, so an assertion names the option it pins rather than depending on where the entry sits in its array. A
// catalog that gains an option therefore shifts no expectation but its own.
function optionEntry(category: string, name: string): FeatureOptionEntry | undefined {

  return featureOptions[category]?.find(entry => entry.name === name);
}

// Look up a catalog category by name. The composed scope hook reads only the option, but the renderer's hook signature takes the category alongside it, so each
// pin below hands it the catalog's real entry rather than a stand-in.
function categoryEntry(name: string): FeatureCategoryEntry {

  const category = featureOptionCategories.find(entry => entry.name === name);

  assert.ok(category, "the " + name + " category should exist");

  return category;
}

// Collect the option names whose declared scopes include the given scope level, sorted for a stable comparison.
function scopedOptions(scope: FeatureOptionScope): string[] {

  const names: string[] = [];

  for(const [ category, entries ] of Object.entries(featureOptions)) {

    for(const entry of entries) {

      if(entry.scopes?.includes(scope)) {

        names.push(fullName(category, entry));
      }
    }
  }

  return names.toSorted();
}

describe("hydrawise feature options", () => {

  test("declares the expected categories", () => {

    assert.deepEqual(featureOptionCategories.map(category => category.name).toSorted(), [ "Account", "Device", "Log", "Mqtt" ],
      "the catalog should declare the account, device, logging, and MQTT categories");
  });

  test("carries the catalog defaults for each option", () => {

    const device = optionEntry("Device", "");
    const name = optionEntry("Device", "Name");
    const suspend = optionEntry("Device", "Suspend.All");
    const suspendZone = optionEntry("Device", "Suspend.Zone");
    const syncName = optionEntry("Device", "SyncName");
    const logZone = optionEntry("Log", "Zone");

    assert.ok(device && name && suspend && suspendZone && syncName && logZone, "every catalog entry the runtime names should exist");
    assert.equal(device.default, true, "the base Device option defaults to enabled");
    assert.equal(name.default, false, "the name option defaults to disabled, so an unconfigured controller or zone resolves no override at all");
    assert.equal(name.defaultValue, "", "the name option is value-centric and defaults to empty, which the runtime reads as no override");
    assert.equal(suspend.default, false, "the suspend switch defaults to disabled");
    assert.equal(suspendZone.default, false, "the per-zone suspension switches default to disabled");
    assert.equal(syncName.default, false, "name synchronization defaults to disabled, so a zone's or a controller's name is the user's and a Home app rename stands");
    assert.equal(logZone.default, true, "zone logging defaults to enabled");

    /* The account login is a prose requirement rather than a gate - no mechanism withholds this option from an install without credentials - so the description
     * is the only place a user learns that the switches need one. Losing that sentence would leave the option silently doing nothing for them.
     */
    assert.ok(suspendZone.description.includes("account login"), "the per-zone suspension description states the account login it needs");
  });

  test("the controller-scopable options match the controller option-name union", () => {

    /* This is the runtime half of the scope-union contract: the set derived from the catalog's scopes must equal the compile-time controller unions - the boolean
     * HydrawiseControllerOption plus the value-centric HydrawiseControllerValueOption, which is where the name override is named. A catalog scope change that is
     * not mirrored in either surfaces here.
     */
    assert.deepEqual(scopedOptions("controller"), [ "Device", "Device.Name", "Device.Standalone", "Device.Suspend.All", "Device.Suspend.Zone", "Device.SyncName",
      "Log.Zone" ], "every controller-scoped option should be named in one of the controller unions");
  });

  test("the zone-scopable options match the zone option-name union", () => {

    // The framework's "device" level is the zone level in this plugin's projection, so this set is the mirror of HydrawiseZoneOption plus the value-centric
    // HydrawiseZoneValueOption. The account-wide suspend option is controller-only and stays out of it; its per-zone sibling is exactly the opposite case.
    assert.deepEqual(scopedOptions("device"), [ "Device", "Device.Name", "Device.Standalone", "Device.Suspend.Zone", "Device.SyncName", "Log.Zone" ],
      "every zone-scoped option should be named in one of the zone unions");
  });

  test("the name override declares exactly the two levels a name is meaningful at", () => {

    const name = optionEntry("Device", "Name");

    assert.ok(name, "the name option should exist");

    /* The scopes array itself, pinned as a value rather than only through the derived sets above. The two levels are what the whole naming contract rests on: the
     * webUI renders the row on a controller view because "controller" is declared here, the runtime's readers each address one of these grains, and the global
     * level is deliberately absent because one name cannot be right for everything on an account.
     */
    assert.deepEqual(name.scopes, [ "controller", "device" ], "a custom name is configurable at a controller and at a zone, and nowhere else");
  });

  test("the globally-scopable options are the account-wide ones", () => {

    // A globally-scoped option applies across every controller on the account. The name override is deliberately absent: one name cannot be right for every
    // controller and zone at once, so it resolves at those grains alone.
    assert.deepEqual(scopedOptions("global"), [ "Account.ApiKey", "Account.Password", "Account.Username", "Device", "Device.Standalone", "Device.Suspend.All",
      "Device.Suspend.Zone", "Device.SyncName", "Log.Debug", "Log.Zone", "Mqtt.Topic", "Mqtt.Url" ],
    "the name override is the only option that does not resolve globally");
  });

  test("the per-zone suspension option is named in BOTH unions its scopes declare", () => {

    /* The runtime pin above compares the catalog against string literals, which is blind to a stale TypeScript union - the literals would still match a catalog
     * whose new option no member of either union names. These are the compile-time half, and they are two SEPARATE checks on purpose: a single check against the
     * combined union is satisfied by membership in either one, so it would pass on a zone-only union while the controller-scope lookup failed to compile.
     */
    const asControllerOption = { option: "Device.Suspend.Zone" } satisfies { option: HydrawiseControllerOption };
    const asZoneOption = { option: "Device.Suspend.Zone" } satisfies { option: HydrawiseZoneOption };

    assert.equal(asControllerOption.option, asZoneOption.option, "one option name resolves at both the controller and the zone");
  });

  test("the account login options are value-centric and unset by default", () => {

    const password = optionEntry("Account", "Password");
    const username = optionEntry("Account", "Username");

    assert.ok(password && username, "both halves of the optional account login should exist");

    // Off with an empty registered value is what makes these optional in the only way that matters: an install that never touches them resolves nothing, so the
    // enhanced features stay dormant and the plugin runs on its API key alone.
    assert.equal(password.default, false, "the account password defaults to unconfigured");
    assert.equal(password.defaultValue, "", "the account password is value-centric and defaults to empty");
    assert.equal(username.default, false, "the account username defaults to unconfigured");
    assert.equal(username.defaultValue, "", "the account username is value-centric and defaults to empty");
  });

  test("the account credentials declare themselves secret, and the username does not", () => {

    const apiKey = optionEntry("Account", "ApiKey");
    const password = optionEntry("Account", "Password");
    const username = optionEntry("Account", "Username");

    assert.ok(apiKey && password && username, "every account entry should exist");

    /* The flag is what makes the settings page render these masked behind a reveal, and nothing else in this repo asserts it, so without this pin the masking could
     * be dropped in a routine edit and no gate would notice - the page would simply start showing the values in clear text.
     */
    assert.equal(apiKey.secret, true, "the API key is masked on the settings page");
    assert.equal(password.secret, true, "the account password is masked on the settings page");

    // The username is an email address rather than a credential of its own, and masking a field the user needs to read back would cost legibility for no protection.
    assert.equal(username.secret, undefined, "the account username is not masked");
  });

  test("describeOptionScope renders the multi-scope prose", () => {

    const device = optionEntry("Device", "");

    assert.ok(device, "the base Device option should exist");
    assert.equal(describeOptionScope(device, categoryEntry("Device")),
      " <BR>*Configurable on the whole controller, on each zone, or globally across every controller.*", "an option configurable at every level lists all three");
  });

  test("describeOptionScope renders the two-scope prose", () => {

    const suspend = optionEntry("Device", "Suspend.All");

    assert.ok(suspend, "the suspend option should exist");
    assert.equal(describeOptionScope(suspend, categoryEntry("Device")), " <BR>*Configurable on the whole controller or globally across every controller.*",
      "a controller-and-global option lists both levels");
  });

  test("describeOptionScope renders the single-scope prose", () => {

    // The API key is the catalog's own single-level entry: an account credential belongs to the account, so it declares the global level and nothing else, and its
    // rendered suffix names that one level with no list joiner at all.
    const apiKey = optionEntry("Account", "ApiKey");

    assert.ok(apiKey, "the API key option should exist");
    assert.equal(describeOptionScope(apiKey, categoryEntry("Account")), " <BR>*Configurable globally across every controller.*",
      "a global-only option lists just the global level");
  });

  test("describeOptionScope omits the suffix when an option declares no scope", () => {

    // An entry that declares no scopes (the base renderer's generic entry shape permits it) yields no scope suffix.
    assert.equal(describeOptionScope({ default: true, description: "No scope here.", name: "Bare" }, categoryEntry("Device")), undefined,
      "a scopeless option should render no suffix");
  });
});
