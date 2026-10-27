/* Copyright(C) 2017-2026, HJD (https://github.com/hjdhjd). All rights reserved.
 *
 * hydrawise-config.d.mts: Type declarations for the pure Hydrawise platform-configuration interpreters.
 */
import type { FeatureCategoryEntry, FeatureOptionEntry, FeatureOptions, displayedName, sanitizeName } from "homebridge-plugin-utils";

/** The number of characters in a Hydrawise API key. */
export declare const API_KEY_LENGTH: number;

/**
 * The primary platform-configuration entry, as it actually arrives from the Homebridge UI. Every consolidated setting is declared as an unknown-valued optional
 * property because that is the honest shape of an object read back from a user's `config.json`: a setting may be absent, may carry a hand-edited value of any
 * type, and may have been staged to `undefined` by this module's own patch. Interpreting exactly that is what the module is for.
 */
export interface HydrawiseConfig {

  apiKey?: unknown;
  debug?: unknown;
  mqttTopic?: unknown;
  mqttUrl?: unknown;
  options?: unknown;
}

/**
 * The option catalog the plugin's UI server publishes, as the interpreter consumes it.
 */
export interface HydrawiseConfigCatalog {

  categories: FeatureCategoryEntry[];
  options: Record<string, FeatureOptionEntry[]>;
}

/**
 * The commit-shaped patch the interpreter produces. A consumed legacy property rides here as a PRESENT key whose value is `undefined`, never as an omitted key:
 * the session's shallow-merge commit treats those two shapes oppositely, deleting the first and leaving the second untouched, and the type system cannot state
 * that difference. Assertions about this patch must therefore read own-property presence rather than compare against `undefined`.
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
 * is the deliberate difference between the two interpreters' write shapes; the account credentials have no legacy property, so they ride the options array in both
 * interpreters alike and this patch carries one only when a credential pair was written.
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

  apiKey: string;
  password?: string;
  username?: string;
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
 * The page's naming rule, mirroring the runtime's controller and zone composers in `src/types.ts`: each answers the name the page shows, sanitized as HomeKit
 * carries it.
 */
export interface HydrawiseNames {

  controllerName(names: { override?: string | null; reported: string }): string;
  zoneName(names: { override?: string | null; relay: number; reported: string }): string;
}

/**
 * Build the page's naming rule over HBPU's injected naming functions.
 *
 * @param injected.displayedName - HBPU's displayedName.
 * @param injected.sanitizeName  - HBPU's sanitizeName.
 *
 * @returns The page's names.
 */
export declare const makeHydrawiseNames: (injected: { displayedName: typeof displayedName; sanitizeName: typeof sanitizeName }) => HydrawiseNames;

/**
 * Build the interpreter over an injected feature-option engine class and the served option catalog.
 *
 * @param injected.FeatureOptions - The feature-option engine class.
 * @param injected.catalog        - The served catalog.
 *
 * @returns The interpreter.
 */
export declare const makeHydrawiseConfig: (injected: { FeatureOptions: typeof FeatureOptions; catalog: HydrawiseConfigCatalog }) => HydrawiseConfigInterpreter;

/**
 * Build the degraded-mode interpreter.
 *
 * @returns The degraded-mode interpreter.
 */
export declare const makeLegacyHydrawiseConfig: () => HydrawiseLegacyConfigInterpreter;
