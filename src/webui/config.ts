/* Copyright(C) 2017-2026, HJD (https://github.com/hjdhjd). All rights reserved.
 *
 * webui/config.ts: Pure interpreters over the injected Hydrawise platform configuration.
 */
import type { FeatureCategoryEntry, FeatureOptionEntry, FeatureOptions, displayedName, sanitizeName } from "homebridge-plugin-utils";
import type { HYDRAWISE_CONTROLLER_FALLBACK_NAME, HYDRAWISE_ZONE_FALLBACK_NAME, controllerDisplayName, zoneDisplayName } from "../types.ts";
import type { HydrawiseControllerOption, HydrawiseGlobalFlagOption, HydrawiseGlobalValueOption } from "../options.ts";

/* The single home for our plugin-config shape. Every function here is a pure interpreter of the primary platform-config entry the webUI framework injects into
 * our hooks - no I/O, no global reach, and no value imports, so the whole module is testable against the real feature-option engine by handing that engine in.
 * The framework owns reading and writing the persisted config through its session; this module owns the Hydrawise-specific knowledge of where a setting lives.
 *
 * Two settings substrates meet here. A feature option is where a setting lives, and a handful of configuration properties are a second home the plugin honors
 * so that a configuration nobody has opened the webUI on keeps working. Reconciling the two is this module's whole job: the interpreters read them in
 * precedence order, and the migration moves a property's value into its option and marks the property for deletion.
 *
 * The page's naming rule sits beside them on the same terms, pure and importing no values with HBPU's naming functions handed in, so the suites hold it to the
 * runtime's own composers under Node.
 */

/**
 * The number of characters in a Hydrawise API key, which is always nineteen. This is the VALIDATION fact the first-run screen gates on and stamps onto its
 * input. The catalog's matching inputSize is a render-width hint that happens to share the number; neither is derived from the other.
 */
export const API_KEY_LENGTH = 19;

/* Every consolidated setting, as the legacy configuration property that carries it paired with the feature option that supersedes it. This pairing is this
 * module's policy knowledge and the one address book both factories below read, so the migration's writes, the interpreters' reads, and the degraded-mode scan
 * can never disagree about where a setting lives. The plugin's runtime names the same option keys in TypeScript, and each name here is tied to the runtime's
 * option unions at compile time through the satisfies clause as well as by the config suite's round trip through a real platform.
 */
const CONSOLIDATED_SETTINGS = {

  apiKey: "Account.ApiKey",
  debug: "Log.Debug",
  mqttTopic: "Mqtt.Topic",
  mqttUrl: "Mqtt.Url"
} satisfies Record<string, HydrawiseGlobalFlagOption | HydrawiseGlobalValueOption>;

/* The account login the optional enhanced features authenticate with, as the feature options that carry it. These are kept apart from the table above because
 * they answer a different question: that table pairs a setting with the legacy configuration property it supersedes, and these have no property to supersede.
 * There has never been a config.json home for them, so there is nothing to migrate, nothing to read as a fallback, and nothing to delete on a write.
 */
const CREDENTIAL_SETTINGS = {

  password: "Account.Password",
  username: "Account.Username"
} satisfies Record<string, HydrawiseGlobalValueOption>;

// The canonical entry prefix the feature-option engine composes for an enabled value option, lowercased because entry matching is case-insensitive. The
// degraded-mode reader scans every option against this one composition, so each read agrees on the entry form by construction rather than by hand-typed strings.
const enabledPrefix = (option: string): string => "enable." + option.toLowerCase() + "=";

// The two action prefixes the entry grammar admits, lowercased for the same case-insensitive matching every other scan here uses.
const ACTION_PREFIXES = [ "disable.", "enable." ];

/* Feature options this plugin has RETIRED, paired with the name that supersedes each. A configured entry addressing a retired name is rewritten to its
 * replacement once, losslessly, so a user who configured the retired name keeps the behavior they chose without touching their configuration.
 *
 * The table is deliberately a plain map of names rather than anything cleverer: a rename is a fact about this plugin's history, and the catalog is what decides
 * everything else. It stays here after the transition because a configuration that has never been opened in the webUI can still be carrying the retired name years
 * later, and an entry that has already been rewritten costs nothing to re-examine.
 */
const RETIRED_OPTION_RENAMES = new Map<string, HydrawiseControllerOption>([[ "device.suspend", "Device.Suspend.All" ]]);

// The words a controller and a zone are named by where HomeKit can carry nothing of any name they could take: this module's own copies of the runtime's, since
// it imports no values, tied to them at compile time by their types as well as by the config suite's parity row.
const CONTROLLER_FALLBACK_NAME: typeof HYDRAWISE_CONTROLLER_FALLBACK_NAME = "Controller";
const ZONE_FALLBACK_NAME: typeof HYDRAWISE_ZONE_FALLBACK_NAME = "Zone";

/**
 * The primary platform-configuration entry, as it actually arrives from the Homebridge UI. Every consolidated setting is declared as an unknown-valued optional
 * property because that is the honest shape of an object read back from a user's `config.json`: a setting may be absent, may carry a hand-edited value of any
 * type, and may have been staged to `undefined` by this module's own patch. Interpreting exactly that is what the module is for. The entry carries other keys
 * besides, the platform's own name among them, so the index signature admits any property as the unknown value it is, which is what lets the migration read a
 * setting by the property name its address book pairs it with.
 */
export interface HydrawiseConfig {

  readonly [property: string]: unknown;
  readonly apiKey?: unknown;
  readonly debug?: unknown;
  readonly mqttTopic?: unknown;
  readonly mqttUrl?: unknown;
  readonly options?: unknown;
}

/**
 * The option catalog the plugin's UI server publishes, as the interpreter consumes it.
 */
export interface HydrawiseConfigCatalog {

  readonly categories: FeatureCategoryEntry[];
  readonly options: Record<string, FeatureOptionEntry[]>;
}

/**
 * The commit-shaped patch the interpreter produces. A consumed legacy property is carried here as a PRESENT key whose value is `undefined`, never as an omitted
 * key: the session's shallow-merge commit treats those two shapes oppositely, deleting the first and leaving the second untouched, and the type system cannot
 * state that difference. Assertions about this patch must therefore read own-property presence rather than compare against `undefined`.
 */
export interface HydrawiseConfigPatch {

  apiKey?: undefined;
  debug?: undefined;
  mqttTopic?: undefined;
  mqttUrl?: undefined;
  options?: string[];
}

/**
 * The commit-shaped patch the degraded-mode interpreter produces for a first-run write. The API key writes the legacy property rather than an option entry, which
 * is the deliberate difference from the catalog-backed interpreter's write shape; the account credentials have no legacy property, so they are carried on the
 * options array by the catalog-backed interpreter and this one alike, and this patch carries one only when a credential pair was written.
 */
export interface HydrawiseLegacyConfigPatch {

  apiKey: string;
  options?: string[];
}

/**
 * The values a first-run write commits. The API key is always present, because first run exists to collect it; the account credentials are optional and are only
 * ever written as a pair, since neither half authenticates on its own.
 */
export interface HydrawiseFirstRunValues {

  readonly apiKey: string;
  readonly password?: string;
  readonly username?: string;
}

/**
 * The interpreter over a fetched catalog: the effective settings, the legacy-settings migration, and the single first-run write.
 */
export interface HydrawiseConfigInterpreter {

  apiKey(config?: HydrawiseConfig): string;
  migrate(config?: HydrawiseConfig): HydrawiseConfigPatch | null;
  password(config?: HydrawiseConfig): string;
  username(config?: HydrawiseConfig): string;
  withFirstRun(config: HydrawiseConfig | undefined, values: HydrawiseFirstRunValues): HydrawiseConfigPatch;
}

/**
 * The degraded-mode interpreter, answering the same questions with no catalog and no engine. Its migration is always `null`, so a session whose fetches are failing
 * still loads and still completes first run.
 */
export interface HydrawiseLegacyConfigInterpreter {

  apiKey(config?: HydrawiseConfig): string;
  migrate(config?: HydrawiseConfig): null;
  password(config?: HydrawiseConfig): string;
  username(config?: HydrawiseConfig): string;
  withFirstRun(config: HydrawiseConfig | undefined, values: HydrawiseFirstRunValues): HydrawiseLegacyConfigPatch;
}

/**
 * The page's naming rule, mirroring the runtime's controller and zone composers in `src/types.ts` and taking each composer's own arguments: each answers the
 * name the page shows, sanitized as HomeKit carries it.
 */
export interface HydrawiseNames {

  controllerName(names: Parameters<typeof controllerDisplayName>[0]): string;
  zoneName(names: Parameters<typeof zoneDisplayName>[0]): string;
}

/**
 * What the naming rule is built over: HBPU's naming functions. Their types are declared here at module scope, where `typeof displayedName` names the imported
 * function, rather than in the factory's parameter, where the same words would name the parameter itself.
 */
export interface HydrawiseNamesDependencies {

  readonly displayedName: typeof displayedName;
  readonly sanitizeName: typeof sanitizeName;
}

/**
 * What the interpreter is built over: the feature-option engine class and the served catalog. The engine's type is declared here at module scope, where `typeof
 * FeatureOptions` names the imported class, rather than in the factory's parameter, where the same words would name the parameter itself.
 */
export interface HydrawiseConfigDependencies {

  readonly FeatureOptions: typeof FeatureOptions;
  readonly catalog: HydrawiseConfigCatalog;
}

/* The configured entries: the config's options array, less every entry that is not a string. This module-scope filter is every reader's and writer's single read
 * of the list - the catalog-backed engine and its retired-name rewrite, and the degraded-mode scans and first-run write alike. The entry grammar is text and every
 * reader reads each entry as text, so a hand-edited entry of any other kind is dropped here, once, as it is read, rather than handed on to throw inside the engine
 * or carried out of a degraded write through a patch that declares its entries as text. An options key that is absent, or that holds anything but an array,
 * reads as no entries at all.
 */
const optionsOf = (config?: HydrawiseConfig): string[] => {

  return Array.isArray(config?.options) ? config.options.filter((entry: unknown): entry is string => typeof entry === "string") : [];
};

/**
 * Build the page's naming rule over HBPU's naming functions, injected as the engine is below so this module imports no values. It mirrors the runtime's composers,
 * controllerDisplayName and zoneDisplayName in src/types.ts, and the config suite's parity row holds the two to one answer: the user's Name where HomeKit can carry
 * it, the reported name where HomeKit can carry that, and the kind's word otherwise, a zone's followed by its relay number. The name chosen is shown sanitized, as
 * the runtime applies it to HomeKit, so the page names each controller and zone as HomeKit carries it.
 *
 * It takes no catalog, so a name is answerable before the catalog loads, in the window the degraded-mode interpreter covers.
 *
 * @param injected.displayedName - HBPU's displayedName: the resolved Name, or the fallback, sanitized.
 * @param injected.sanitizeName  - HBPU's sanitizeName, which decides whether HomeKit can carry anything of the reported name.
 *
 * @returns The page's names: controllerName and zoneName, each taking the runtime composer's arguments and answering the name the page shows.
 */
export const makeHydrawiseNames = ({ displayedName, sanitizeName }: HydrawiseNamesDependencies): HydrawiseNames => {

  // The name a Name HomeKit cannot carry yields to: the reported name where HomeKit can carry something of it, and the kind's word otherwise.
  const fallbackOf = (reported: string, word: string): string => (sanitizeName(reported).length ? reported : word);

  return {

    controllerName: ({ override, reported }: Parameters<typeof controllerDisplayName>[0]): string => {

      return displayedName({ fallback: fallbackOf(reported, CONTROLLER_FALLBACK_NAME), override });
    },

    zoneName: ({ override, relay, reported }: Parameters<typeof zoneDisplayName>[0]): string => {

      return displayedName({ fallback: fallbackOf(reported, ZONE_FALLBACK_NAME + " " + relay.toString()), override });
    }
  };
};

/**
 * Build the interpreter over an injected feature-option engine class and the option catalog the plugin's own UI server publishes. Injecting both is what keeps
 * this module free of value imports and testable under node against the real engine and the real catalog, rather than against a stand-in that could drift from
 * either.
 *
 * @param injected.FeatureOptions - The feature-option engine class.
 * @param injected.catalog        - The served catalog, carrying its categories and its options record.
 *
 * @returns The interpreter: readers for the effective API key, account password, and account username, the legacy-settings migration, and the first-run
 *          write that commits all of them at once.
 */
export const makeHydrawiseConfig = ({ FeatureOptions, catalog }: HydrawiseConfigDependencies): HydrawiseConfigInterpreter => {

  // A feature-option engine over the served catalog and the config's text entries, which the filter above hands it as an array of its own, so nothing the engine
  // does can reach the configuration's own array.
  const engineFor = (config?: HydrawiseConfig): FeatureOptions => new FeatureOptions(catalog.categories, catalog.options, optionsOf(config));

  /* Every option key the SERVED catalog currently declares, lowercased. The composition is the feature-option engine's own rule - a category name joined to an
   * option name by a dot, with a nameless option addressing its category alone - stated here rather than imported because this module deliberately imports no
   * values and receives the catalog as data.
   *
   * This set is what makes the rename below catalog-anchored instead of hand-rolled string surgery.
   */
  const currentOptionKeys = (): Set<string> => {

    const keys = new Set<string>();

    for(const [ category, entries ] of Object.entries(catalog.options)) {

      for(const entry of entries) {

        keys.add((entry.name ? category + "." + entry.name : category).toLowerCase());
      }
    }

    return keys;
  };

  /* Rewrite any configured entry that addresses a RETIRED option name to the name that superseded it, and answer the new array - or null when nothing needed
   * rewriting, so a caller can tell a pass that changed something from one that did not.
   *
   * The matching order is what keeps a family from eating its own members. An entry that addresses a name the catalog CURRENTLY declares is always left alone,
   * whether it addresses that option globally or at a scope, and only an entry that matches nothing current is considered for a rename. Without that ordering the
   * naive reading - a retired name plus one trailing segment - would misread `Enable.Device.Suspend.All` as the retired option scoped to a device called "All"
   * and rewrite it to nonsense; anchoring on the catalog means the new family's own members are recognized as themselves.
   *
   * A rewrite is lossless in both directions it can carry information: the action prefix is preserved as written, and so is any scope identifier, in the casing
   * the user typed. Running twice is a no-op by construction rather than by a guard - the first pass leaves entries addressing a current key, which the first
   * rule passes straight through.
   */
  const renameRetiredOptions = (options: readonly string[]): string[] | null => {

    const current = currentOptionKeys();

    // One entry's rewrite, or undefined for an entry that is left exactly as the user wrote it.
    const renameEntry = (entry: string): string | undefined => {

      const lower = entry.toLowerCase();
      const action = ACTION_PREFIXES.find((prefix) => lower.startsWith(prefix));

      if(!action) {

        return undefined;
      }

      // The addressed key is the tail up to any value payload, since a value never participates in naming the option.
      const tail = entry.slice(action.length);
      const delimiter = tail.indexOf("=");
      const key = ((delimiter === -1) ? tail : tail.slice(0, delimiter));
      const payload = (delimiter === -1) ? "" : tail.slice(delimiter);
      const lowerKey = key.toLowerCase();
      const lastDot = lowerKey.lastIndexOf(".");
      const head = (lastDot === -1) ? "" : lowerKey.slice(0, lastDot);

      /* An entry addressing a current option globally is this catalog's own and passes through - the rule that recognizes the new family's members as themselves.
       *
       * A retired name is then matched EXACTLY, ahead of the scoped-entry reading below, because the two readings genuinely collide: every option name in this
       * catalog sits under a category that is itself an option, so `Enable.Device.Suspend` is readable both as the retired `Device.Suspend` and as the `Device`
       * option scoped to something called "Suspend". The retired table is what settles it, exactly as the engine's own resolution lets the catalog settle which
       * of two candidate names a key addresses.
       */
      if(current.has(lowerKey)) {

        return undefined;
      }

      const globalRename = RETIRED_OPTION_RENAMES.get(lowerKey);
      const scopedRename = ((head.length > 0) && !current.has(head)) ? RETIRED_OPTION_RENAMES.get(head) : undefined;

      // A global rewrite carries the replacement alone; a scoped one carries the identifier the entry named, sliced from the original so its casing survives.
      const replacement = globalRename ?? ((scopedRename === undefined) ? undefined : scopedRename + key.slice(lastDot));

      // Anything else addressing a current option at a scope, or addressing nothing this plugin knows, is left exactly as the user wrote it.
      if(replacement === undefined) {

        return undefined;
      }

      return entry.slice(0, action.length) + replacement + payload;
    };

    const migrated: string[] = [];
    let rewritten = false;

    for(const entry of options) {

      const renamed = renameEntry(entry);

      rewritten ||= (renamed !== undefined);
      migrated.push(renamed ?? entry);
    }

    return rewritten ? migrated : null;
  };

  return {

    /* The effective API key, as the string the plugin would run on. An explicitly configured option rules in every one of its states, its empty ones included:
     * an option enabled with no value, and an option explicitly disabled, both mean the user has told us there is no key. Only when no entry exists at all does
     * the legacy property answer.
     *
     * @param config - The platform configuration entry.
     *
     * @returns The effective key, or an empty string when there is none.
     */
    apiKey: (config?: HydrawiseConfig): string => {

      const engine = engineFor(config);
      const option = CONSOLIDATED_SETTINGS.apiKey;

      if(engine.exists(option)) {

        return engine.value(option) ?? "";
      }

      return (typeof config?.apiKey === "string") ? config.apiKey : "";
    },

    /* Move any legacy configuration properties into their feature options, as a patch for the session to stage. This is transitional work with a planned end:
     * once a configuration has been through it, there is nothing left to find and every later pass answers null.
     *
     * Ahead of that property scan, every pass also rewrites any configured entry addressing a RETIRED option name to the name that superseded it. That
     * rewrite runs unconditionally rather than only when a legacy property is present, so a configuration carrying no legacy properties at all still gets
     * any retired name brought current.
     *
     * A property that is present with a defined value always leaves, carried on the patch as an explicitly undefined key so the shallow-merge commit deletes
     * it rather than skipping it. Whether its value additionally becomes an option entry depends on which kind of option it addresses, and the kind is read
     * from the catalog rather than declared here: the engine treats an entry that declares a defaultValue as value-centric, so an option whose registered
     * default comes back undefined is a flag. That keeps the address table a plain map of names and leaves the catalog the single authority on kind.
     *
     * A value migrates when all of the following hold: it is a non-empty string, its option is not already configured (an existing entry is the user's own
     * choice and outranks a property, whether that entry enables or disables the option), and it is not byte-equal to the option's registered default
     * (migrating a value that only restates the default would manufacture configuration out of nothing).
     *
     * A flag composes a valueless enable entry on exactly one input: the boolean true, with its option not already configured. False needs no entry, because
     * off is what the catalog already declares, and writing one would manufacture configuration for no gain - the same minimal-config rule the value arm
     * follows. Anything that is not a boolean is a hand-edit we decline to interpret, and it leaves without composing.
     *
     * Two shapes decline entirely. A legacy key present with the value undefined is the terminal shape this very patch produces, so it reads as absent and a
     * second pass over an already-staged config stages nothing. And an options array that is not an array at all is a substrate we cannot parse, so the
     * migration leaves the whole config alone rather than guessing at it.
     *
     * @param config - The platform configuration entry.
     *
     * @returns The patch to commit, or null when there is nothing to do.
     */
    migrate: (config?: HydrawiseConfig): HydrawiseConfigPatch | null => {

      if(!config || ((config.options !== undefined) && !Array.isArray(config.options))) {

        return null;
      }

      /* The retired-name rewrite is its OWN step and runs on every pass, deliberately ahead of the property scan and outside its preconditions. The property
       * migration answers null the moment a configuration carries no legacy properties, which is true of nearly every installation that has already been through
       * it once - gating the rename behind that scan would leave exactly those configurations carrying the retired name forever.
       */
      const renamed = renameRetiredOptions(optionsOf(config));
      const carried = Object.entries(CONSOLIDATED_SETTINGS).filter(([property]) => config[property] !== undefined);

      if(!carried.length) {

        return renamed ? { options: renamed } : null;
      }

      // The engine reads the RENAMED array, so a pass carrying both a legacy property and a retired option name composes one array holding both migrations rather
      // than two writers each producing a whole array and the last one winning.
      const engine = engineFor(renamed ? { ...config, options: renamed } : config);
      const patch: HydrawiseConfigPatch = Object.fromEntries(carried.map(([property]): [ string, undefined ] => [ property, undefined ]));
      let composed = false;

      for(const [ property, option ] of carried) {

        const value = config[property];
        const catalogDefault = engine.valueDefault(option);

        // An option the catalog gives no registered default is a flag, and a flag's whole payload is the entry's existence.
        if(catalogDefault === undefined) {

          if((value !== true) || engine.exists(option)) {

            continue;
          }

          engine.setOption({ enabled: true, option });
          composed = true;

          continue;
        }

        if((typeof value !== "string") || !value.length || engine.exists(option) || (value === catalogDefault)) {

          continue;
        }

        engine.setOption({ enabled: true, option, value });
        composed = true;
      }

      // The entries go into the patch when this pass composed one, and otherwise whenever the rename rewrote something, so a config whose properties all decline
      // stages a pure deletion and one whose only work was the rename still carries it.
      if(composed) {

        patch.options = engine.configuredOptions;
      } else if(renamed) {

        patch.options = renamed;
      }

      return patch;
    },

    /* The effective account password for the optional enhanced features. Unlike the API key above this has no legacy-property arm, because the setting lives in its
     * feature option and nowhere else, so an unconfigured option simply reads as nothing set.
     *
     * @param config - The platform configuration entry.
     *
     * @returns The configured password, or an empty string when there is none.
     */
    password: (config?: HydrawiseConfig): string => engineFor(config).value(CREDENTIAL_SETTINGS.password) ?? "",

    /* The effective account username, on exactly the terms the password reader above states.
     *
     * @param config - The platform configuration entry.
     *
     * @returns The configured username, or an empty string when there is none.
     */
    username: (config?: HydrawiseConfig): string => engineFor(config).value(CREDENTIAL_SETTINGS.username) ?? "",

    /* The first-run write: compose every value first run collected as its feature option, replacing any entry already addressing it. The legacy API-key property
     * goes into the patch as an explicitly undefined key, so a configuration that carried one is left with exactly one home for the key once the patch is written.
     *
     * All of it composes through ONE engine and returns ONE patch, which is the whole reason this is a single writer rather than a call per value. Each engine
     * answers `configuredOptions` as its own complete snapshot of the options array, so two independent writers would produce two whole arrays and the session's
     * shallow-merge commit would keep only the last of them - silently discarding every value the other one composed.
     *
     * The credentials are written only as a PAIR, and only when both carry something. Neither half authenticates alone, so writing one would configure a login that
     * cannot work; omitting both leaves whatever the configuration already held untouched, which is what lets a user complete first run without supplying them.
     *
     * @param config            - The platform configuration entry.
     * @param values            - The validated values to write.
     * @param values.apiKey     - The validated API key.
     * @param values.password   - The validated account password, or nothing to leave the credentials alone.
     * @param values.username   - The validated account username, or nothing to leave the credentials alone.
     *
     * @returns The patch to commit.
     */
    withFirstRun: (config: HydrawiseConfig | undefined, { apiKey, password, username }: HydrawiseFirstRunValues): HydrawiseConfigPatch => {

      const engine = engineFor(config);

      engine.setOption({ enabled: true, option: CONSOLIDATED_SETTINGS.apiKey, value: apiKey });

      if(password?.length && username?.length) {

        engine.setOption({ enabled: true, option: CREDENTIAL_SETTINGS.password, value: password });
        engine.setOption({ enabled: true, option: CREDENTIAL_SETTINGS.username, value: username });
      }

      return { apiKey: undefined, options: engine.configuredOptions };
    }
  };
};

/**
 * Build the degraded-mode interpreter, which is what the webUI falls back to when the option catalog cannot be fetched. It answers the same questions without an
 * engine, so the settings page still loads and first-run still works in a session whose local requests are failing.
 *
 * Its write shapes are chosen per setting, by where the setting can actually live. The API key writes the legacy property: composing an option entry by hand with
 * no catalog to validate it against is how a webUI corrupts a config, writing the property instead is always safe, and the next healthy session migrates it
 * forward on its own. The account credentials have no legacy property at all, so that safety valve does not exist for them - a property write would land somewhere
 * nothing ever reads - and they compose the canonical option entry directly. That is a narrow, well-understood exception: the entry form is one line of grammar
 * shared with the reader below, and the password and username options are known to be value-centric without consulting any catalog.
 *
 * @returns The degraded-mode interpreter.
 */
export const makeLegacyHydrawiseConfig = (): HydrawiseLegacyConfigInterpreter => {

  /* Read one option's value out of the configured entries, through the module-scope filter that is every reader's and writer's single read of the list. This is
   * the engine-free half of the same grammar the catalog-backed reader resolves through, and the original entry is sliced rather than its lowercased copy, so a
   * value keeps the casing the user typed. Only the enabled-with-value form is scanned for, which is honest for every entry a migration or a first-run write could
   * have produced, since the engine composes only that form for a value option.
   */
  const scanOption = (config: HydrawiseConfig | undefined, option: string): string => {

    const prefix = enabledPrefix(option);

    for(const entry of optionsOf(config)) {

      if(entry.toLowerCase().startsWith(prefix)) {

        return entry.slice(prefix.length);
      }
    }

    return "";
  };

  return {

    /* The effective API key, read without an engine. The legacy property answers first, and when it is gone - which is exactly what a completed migration
     * leaves behind - the configured entries are scanned for the canonical entry, through the module-scope filter that is every reader's and writer's single
     * read of the list. Without that scan a degraded session would read a fully migrated install as having no key at all and send the user back through
     * first-run.
     *
     * @param config - The platform configuration entry.
     *
     * @returns The effective key, or an empty string when there is none.
     */
    apiKey: (config?: HydrawiseConfig): string => {

      if(typeof config?.apiKey === "string") {

        return config.apiKey;
      }

      return scanOption(config, CONSOLIDATED_SETTINGS.apiKey);
    },

    // Never migrate without a catalog. A migration decides what to write by consulting the catalog's registered defaults and the entries already configured,
    // and neither question can be answered here.
    migrate: (): null => null,

    /* The effective account password, scanned from the options array. There is no property arm to try first, because this setting has no property home.
     *
     * @param config - The platform configuration entry.
     *
     * @returns The configured password, or an empty string when there is none.
     */
    password: (config?: HydrawiseConfig): string => scanOption(config, CREDENTIAL_SETTINGS.password),

    /* The effective account username, on the terms the password reader above states.
     *
     * @param config - The platform configuration entry.
     *
     * @returns The configured username, or an empty string when there is none.
     */
    username: (config?: HydrawiseConfig): string => scanOption(config, CREDENTIAL_SETTINGS.username),

    /* The first-run write in degraded mode: the legacy property for the key, and canonical option entries for the credentials, per the split this interpreter's
     * own documentation states. The credentials are written only as a pair and only when both carry something, exactly as the catalog-backed writer does.
     *
     * Any entry already addressing either credential option is dropped before the new one is appended, in the disabled form as well as the enabled one, so a
     * second pass replaces rather than accumulates - the same thing the engine's own set does, done by hand because there is no engine here. The entries it keeps
     * are read through the module-scope filter, so a hand-edited entry that is not text is left out of the list it writes.
     *
     * @param config          - The platform configuration entry.
     * @param values          - The validated values to write.
     * @param values.apiKey   - The validated API key.
     * @param values.password - The validated account password, or nothing to leave the credentials alone.
     * @param values.username - The validated account username, or nothing to leave the credentials alone.
     *
     * @returns The patch to commit.
     */
    withFirstRun: (config: HydrawiseConfig | undefined, { apiKey, password, username }: HydrawiseFirstRunValues): HydrawiseLegacyConfigPatch => {

      if(!password?.length || !username?.length) {

        return { apiKey };
      }

      const written: [ string, string ][] = [ [ CREDENTIAL_SETTINGS.password, password ], [ CREDENTIAL_SETTINGS.username, username ] ];

      // Both action forms are superseded, and each is matched without its value delimiter, so an entry that addresses the option while carrying no value at all is
      // dropped alongside the ones that do.
      const superseded = written.flatMap(([option]) => [ "disable." + option.toLowerCase(), "enable." + option.toLowerCase() ]);
      const options = optionsOf(config).filter((entry) => !superseded.some((prefix) => entry.toLowerCase().startsWith(prefix)));

      for(const [ option, value ] of written) {

        options.push("Enable." + option + "=" + value);
      }

      return { apiKey, options };
    }
  };
};
