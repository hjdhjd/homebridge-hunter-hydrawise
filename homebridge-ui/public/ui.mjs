/* Copyright(C) 2017-2026, HJD (https://github.com/hjdhjd). All rights reserved.
 *
 * ui.mjs: Homebridge Hunter Hydrawise webUI.
 */
"use strict";

import { API_KEY_LENGTH, makeHydrawiseConfig, makeHydrawiseNames, makeLegacyHydrawiseConfig } from "./lib/webui/config.js";
import { FeatureOptions, buildCatalogIndex, enumerateConfiguredEntries, expandOption } from "homebridge-plugin-utils/featureOptions.js";
import { ZONE_STATE_LABELS, cachedAccessoryName, cachedControllerHardware, cachedValveName, deriveControllerDisplay, deriveControllerStrip, deriveZoneDisplay,
  deriveZoneStrip, formatRunTime, zoneScheduleState } from "./lib/webui/display.js";
import { createActionGuard, withDeadline } from "homebridge-plugin-utils/webUi-liveness.mjs";
import { displayedName, sanitizeName } from "homebridge-plugin-utils/homekit-name.js";
import { PluginConfigSession } from "homebridge-plugin-utils/pluginConfigSession.mjs";
import { webUi } from "homebridge-plugin-utils/webUi.mjs";

// The feature-option category the controller-scope options this webUI reasons about live in. One constant anchors the category everywhere this file names it - the
// floor-entry grammar, the catalog read, the enable-state oracle, and the custom-name override's own option key - while the plugin's runtime names it
// independently in TypeScript; the two meet at the wire.
const DEVICE_CATEGORY = "Device";

// The canonical option name of the custom-name override, composed through the engine's own grammar rather than spelled out here, so a rename of the option cannot
// silently break the lookup. One option answers at both grains - a controller and a zone alike - so one constant names it.
const NAME_OPTION = expandOption(DEVICE_CATEGORY, "Name");

// The guidance sentences the controller notice states render through the infoPanel. Complete sentences, shown verbatim to the user.
const NOTICE_DISABLED = "This controller is disabled in your Homebridge configuration, so its zones are not listed. " +
  "Use the refresh action on the Controllers heading to retrieve them.";
const NOTICE_DISABLED_LISTED = "This controller is disabled in your Homebridge configuration, so it is not published to HomeKit. " +
  "Its zones are listed for reference.";
const NOTICE_UNPUBLISHED = "The plugin has not published this controller's details yet. " +
  "Restart Homebridge, and its zones will appear here after the first update from Hydrawise completes.";
const NOTICE_UNDISCOVERED = "The plugin has not discovered this controller yet. Restart Homebridge to discover it.";

/* The copy the listing hooks hand the framework in place of its own wording, because the framework's defaults speak of a controller's connection details and of
 * adding controllers in the main settings tab, and neither fits a plugin whose controllers come from the account behind its API key and whose listings read the
 * local accessory cache. Complete sentences, shown verbatim to the user.
 */
const LIST_EMPTY = "No controllers were found for this API key. Check the key under the account settings, then use Refresh from Hydrawise.";
const LIST_CACHE_FAILED = "Unable to read the Homebridge accessory cache.";
const LIST_CACHE_GUIDANCE = "Retry, and restart Homebridge if the problem persists.";
const LIST_ZONES_CACHE_FAILED = "Unable to read this controller's zones from the Homebridge accessory cache.";
const LIST_ZONES_CLASSIFY_FAILED = "Unable to classify this controller's zones.";
const LIST_ZONES_CLASSIFY_GUIDANCE = "Use Refresh from Hydrawise, and restart Homebridge if the problem persists.";

/* The schedule ticker's cadence in milliseconds, one nominal poll interval. In the steady state a tick's cache read reaches the server fresh, because the browser's
 * own thirty-second cache has expired between ticks; interleaved page activity can instead serve a tick from that window, which bounds that tick's extra staleness
 * at thirty seconds. That is harmless for poll-cadence data, and it is stated here so the cadence is not read as a freshness guarantee.
 */
const SCHEDULE_TICK_MS = 60000;

/* The session stores. A settings-modal open forks a fresh webUI process that dies on close, so these live exactly as long as the user's session and never persist
 * across opens - the natural bound the design relies on. They only ever accumulate identity, never volatile state:
 *
 *   - sessionControllers: every controller this session has shown, keyed by case-folded serial. Seeded from the accessory cache, the config floor, a first-run login,
 *     and an explicit refresh, so a controller that appeared once stays listed for the session even after its backing drops.
 *   - sessionZones: the zones an explicit refresh fetched for a context-less (disabled) controller, keyed by case-folded serial, so its zones list without a live
 *     accessory.
 *   - sessionFloorSerials: every serial ever seen in the config floor this session, so a controller whose floor Disable the user removed this session can be marked
 *     as awaiting a restart rather than silently vanishing from the list.
 */
const sessionControllers = new Map();
const sessionFloorSerials = new Set();
const sessionZones = new Map();

/* The option catalog as this page reads it, derived from the framework's own read: the categories and options the framework fetched from the plugin's UI
 * server, plus the index the config-floor walk reads. The framework's catalog() is the page's one request to /getOptions - a local IPC, never a cloud call -
 * memoized for the page's life, bounded by its own deadline, and cleared when it fails. The derivation keeps a memo of its own keyed on the identity of the
 * promise the framework answers, so a repeat read reuses the index already built while a fresh promise after a failure builds it again.
 */
let catalogMemo = null;

/* The schedule ticker's module state, all of it scoped to one page cycle and reset when that cycle's signal aborts. The ticker serves every schedule-bearing surface
 * from one read - the sidebar's zone dots and the details panel among them - and only the panel needs tracking here, because the dots are found by query at the
 * moment they are painted:
 *
 *   - renderContext: a fresh { device, panel } object minted on every render of the details panel. Its OBJECT IDENTITY is what a tick's read compares against on
 *     resolution, which is how a read dispatched for a view the user has since left repaints no panel.
 *   - tickerSignal: the page cycle's signal the ticker armed against, or null while it is unarmed, and the ticker's one guard: a cycle arms one interval and
 *     registers one resume subscriber, however many renders it makes.
 *   - tickSequence / inFlightTick: the dispatch counter and the sequence number of the read currently in flight, which is how a slow read is superseded rather
 *     than allowed to latch the ticker shut.
 */
let renderContext = null;
let tickerSignal = null;
let tickSequence = 0;
let inFlightTick = null;

/* The account login first run has actually VALIDATED, held as the pair the submit will commit, or null when there is nothing validated to commit. Only a successful
 * validation puts a pair here, and editing either field clears it again, so what first run writes is always a pair the cloud has confirmed rather than whatever
 * happened to be sitting in the inputs when the user pressed the button.
 */
let validatedCredentials = null;

// Derive this page's catalog from one framework read: the categories and options it answered, checked for the Device category, and the index built over them.
const deriveCatalog = async (source) => {

  const { categories, options } = await source;

  // The framework checks for categories and an options record but not for the Device category. A catalog without it would make the enable-state oracle read every
  // controller as disabled off the engine's false fallback, so it is a failure rather than a default, and the guarded callers surface it.
  if(!Array.isArray(options[DEVICE_CATEGORY])) {

    throw new Error("Received a malformed response from the plugin option catalog.");
  }

  return { categories, index: buildCatalogIndex(categories, options), options };
};

const getCatalog = () => {

  const source = ui.featureOptions.catalog();

  if(catalogMemo?.source !== source) {

    catalogMemo = { derived: deriveCatalog(source), source };
  }

  return catalogMemo.derived;
};

/* The interpreter every configuration read in this file goes through. It is declared already holding the degraded-mode interpreter, so the binding is never
 * undefined in any window and no consumer needs a guard; the wiring below swaps in the catalog-backed interpreter the moment the catalog is in hand.
 */
let hydrawiseConfig = makeLegacyHydrawiseConfig({ FeatureOptions });

/* The page's naming rule, built once over HBPU's naming functions: every controller and zone name this page shows goes through it, so the page names each as the
 * runtime's composers name it in HomeKit. It needs no catalog, so it is whole from the first render.
 */
const hydrawiseNames = makeHydrawiseNames({ displayedName, sanitizeName });

/* The page's one rule for a controller's label, which every place this page names a controller reads: the user's configured override where HomeKit can carry it,
 * then the name HomeKit last showed on the controller's own cached accessory, then the identity name for a controller with no accessory cached. The tile's name
 * comes before the identity because it is what HomeKit shows, which the identity is not wherever the user owns the name: a rename they made in the Home app
 * stands on the tile, and a rename on the Hydrawise side reaches the identity alone. The identity is the name the session roster holds rather than a listing's
 * label, which carries sidebar decoration such as the pending-restart suffix.
 */
const controllerLabel = ({ accessory, identity, override }) => hydrawiseNames.controllerName({ override, reported: cachedAccessoryName(accessory) ?? identity });

// Build the feature-option engine over the cached catalog and the user's configured options. The engine is rebuilt per call because the configured options change
// underneath us as the user edits them, so an edit the user just saved is reflected the next time we ask. Every consult in this file resolves through here, which
// is what keeps the enable-state oracle and the zone-name lookup answering from one engine rather than two.
const getEngine = async (config) => {

  const { categories, options } = await getCatalog();

  return new FeatureOptions(categories, options, config?.options ?? []);
};

// Ask the feature-option engine whether the runtime publishes a controller, using the runtime's exact gate call so the webUI and the plugin cannot disagree
// about a controller's enabled state.
const isControllerEnabled = async (config, serialNumber) => (await getEngine(config)).test(DEVICE_CATEGORY, undefined, serialNumber);

/* Read the Name option a user configured for one thing - a controller named by its serial, or a zone named by its relay id - handing the raw value on as the
 * engine answers it, exactly as the runtime's own readers do: the page's naming rule alone decides whether it counts, through HBPU's override resolution, which
 * trims it and refuses one that is empty or that HomeKit cannot carry.
 *
 * The id is the WHOLE lookup, deliberately. The Name option resolves at the controller and the zone alike, so a read that presented both a zone id and its
 * controller's serial would answer an unnamed zone with the controller's name, and the sidebar would show every zone renamed. One id per read is what makes that
 * impossible here and in the runtime both.
 */
const readOverride = (engine, id) => engine.value(NAME_OPTION, id);

// Case-fold a serial for cross-source identity comparison, matching the runtime feature-option engine's serial lowercasing so the webUI and the plugin agree on a
// controller's identity.
const foldSerial = (serial) => String(serial).toLowerCase();

// Validate a persisted controller-identity entry read from the accessory cache or a cloud response. A malformed entry counts as absent, so a corrupt cache never
// crashes the reader or lists a phantom controller.
const isControllerIdentity = (value) => (typeof value === "object") && (value !== null) && (typeof value.controllerId === "number") &&
  (typeof value.name === "string") && (typeof value.serialNumber === "string");

// Validate a persisted zone-identity entry. Like the controller check, a malformed entry counts as absent.
const isZoneIdentity = (value) => (typeof value === "object") && (value !== null) && (typeof value.name === "string") && (typeof value.relay === "number") &&
  (typeof value.relayId === "number");

/* Whether a persisted accessory context belongs to a standalone zone accessory - the accessory that hosts one zone's valve on its own so the user can assign the
 * zone to a room. This is a PRESENCE check on the identity pair, deliberately simpler than the runtime's own predicate, which additionally requires every
 * controller-accessory field to be absent. At this consumer an ambiguous context - one carrying the controller shape and the zone pair at once - is already
 * excluded where it matters: the notice heuristic's other arm tests isControllerIdentity itself, and such a context passes that arm and is excluded regardless
 * of what this one answers.
 */
const isZoneAccessoryLike = (context) => isControllerIdentity(context?.ownerController) && isZoneIdentity(context?.zone);

// Validate one zone's persisted schedule entry. The state must be one the runtime's union declares, and the arm that state names must carry its own numeric fields,
// so a truncated cache entry - a running entry that lost its end instant - counts as absent here rather than rendering as a blank countdown.
const isZoneScheduleStatus = (value) => {

  if((typeof value !== "object") || (value === null) || (typeof value.relayId !== "number")) {

    return false;
  }

  switch(value.state) {

    case "running":

      return typeof value.endsAt === "number";

    case "scheduled":

      return (typeof value.durationSeconds === "number") && (typeof value.nextRunAt === "number");

    case "suspended":

      return typeof value.until === "number";

    case "sensor-stopped":
    case "unscheduled":

      // These states carry no facts beyond the state itself, so a well-formed relay id and a known state are the whole shape.
      return true;

    default:

      return false;
  }
};

// Validate a controller's persisted schedule projection. Like the identity checks, a malformed value counts as absent, so a corrupt cache renders an identity-only
// panel rather than a panel that lies. The controller's availability is optional - only an account-credentialed runtime records it - so absent and boolean both
// pass and anything else fails.
const isScheduleStatus = (value) => (typeof value === "object") && (value !== null) && (typeof value.activeWindowSeconds === "number") &&
  (typeof value.asOf === "number") && ((value.online === undefined) || (typeof value.online === "boolean")) && Array.isArray(value.zones) &&
  value.zones.every(isZoneScheduleStatus);

// Find the cached accessory that carries a controller's own identity, matched on the folded serial. The zone listing and the schedule ticker both have to locate
// the same accessory, so the match lives here once rather than being re-derived at each read site.
const matchControllerAccessory = (cached, targetSerial) => cached.find((accessory) => isControllerIdentity(accessory?.context?.controller) &&
  (foldSerial(accessory.context.controller.serialNumber) === targetSerial));

/* Extract the controller serials named by the config floor, through the engine's own grammar: one record per entry addressing the whole-device option, the id in
 * the casing the user wrote it. A global entry yields an empty id and is dropped; a zone-scope disable yields that zone's relay id, and the caller screens every
 * candidate against the known zones. An entry that is really some other option's address - a dotted tail, a value payload - yields nothing, because the engine
 * reads it as what it is.
 */
const floorSerials = (options, catalog) => {

  if(!Array.isArray(options)) {

    return [];
  }

  const serials = [];

  for(const entry of enumerateConfiguredEntries({ catalog: catalog.index, configuredOptions: options.filter((entry) => typeof entry === "string"),
    option: DEVICE_CATEGORY })) {

    if(entry.id.length) {

      serials.push(entry.id);
    }
  }

  return serials;
};

// Surface a failure sentence to the user. The Homebridge UI toast API is the primary channel; we fall back to the console when it is unavailable in this context.
const notifyError = (message) => {

  if(homebridge.toast?.error) {

    homebridge.toast.error(message, "Error");

    return;
  }

  // eslint-disable-next-line no-console
  console.error(message);
};

// Execute our first run screen if we don't have a valid Hydrawise API key. The framework injects our primary platform-config entry, so this is a pure predicate over
// the persisted config rather than a reach into the feature-options page's state, and the interpreter is what knows where a key can live.
const firstRunIsRequired = ({ config }) => hydrawiseConfig.apiKey(config).length !== API_KEY_LENGTH;

/* The classes a credential result line wears in every state. The tone is layered on top of this base, so a line's blank, failure, and success states are one layout with
 * one color decision between them rather than a separate class string per state, which is what would let the states drift apart.
 */
const RESULT_ROW_CLASS = "hbhh-result small mt-2";

/* Paint one credential validation's result line in the tone its outcome calls for - a Bootstrap text color, or an empty string for the blank state. The sentence
 * lands through textContent, so a reason the server reported renders as text rather than as markup, matching the trust boundary every other display in this file
 * holds. The line keeps its height while blank, which is what stops a card from shifting under the user as a validation answers.
 */
const renderResultRow = ({ id, text, tone }) => {

  const row = document.getElementById(id);

  row.className = tone.length ? (RESULT_ROW_CLASS + " " + tone) : RESULT_ROW_CLASS;
  row.textContent = text;
};

/* Build one validation surface: the action guard that says which invocation the page is still listening to, and the cleanup that runs whenever the surface is
 * retired.
 *
 * A validation spends a cloud call and paints what it learns when the call answers, and the bridge request carrying it has no way to abort - so an edit made while a
 * call is in flight cannot stop the call, only decide that its answer describes nothing on screen any more. The guard's signal is what carries that decision across
 * the await: an invocation holds the claim begin() hands it, and anything it would do afterward is conditioned on that claim still being current.
 */
const makeValidationScope = ({ inputs, onInvalidate }) => {

  const guard = createActionGuard();

  // Retire whatever this surface is currently showing or holding. Cancelling the guard is what disowns an invocation still in flight, and the cleanup is what takes
  // the retired verdict off screen...both halves are the same act, so no caller can perform one without the other.
  const invalidate = () => {

    guard.cancel();
    onInvalidate();
  };

  return {

    // Start a validation and hand back this invocation's claim on the surface, the signal of the guard's newest action. Starting retires whatever came before it,
    // which is the same clearing the surface does on an edit.
    begin: () => {

      invalidate();

      return guard.start();
    },
    inputs,
    invalidate,
    isCurrent: (claim) => !claim.aborted
  };
};

/* The first-run screen's validation surfaces, one per endpoint it can call. This declaration is the whole mapping's single source of truth: each surface names the
 * inputs whose edits retire it and the cleanup that retirement runs, and both the handlers and the input wiring derive from here rather than restating it.
 *
 * The surfaces count separately on purpose. Each validation calls its own endpoint against its own rate budget, so an edit to the API key must not throw away an
 * account-login answer the user already paid a call for, nor the reverse.
 */
const validationScopes = {

  // The optional account login. Retiring it discards the staged pair as well as the verdict, so the indicator on screen and the pair the submit would commit always
  // describe the same thing - what first run writes is a pair the cloud confirmed, never whatever was sitting in the fields when the button was pressed.
  account: makeValidationScope({

    inputs: [ "hydrawisePassword", "hydrawiseUsername" ],
    onInvalidate: () => {

      validatedCredentials = null;

      renderResultRow({ id: "validateV2Result", text: "", tone: "" });
    }
  }),

  // The API key. Nothing is staged for it - the submit reads the input itself - so retiring it is only a matter of taking the verdict off screen.
  apiKey: makeValidationScope({ inputs: ["apiKey"], onInvalidate: () => renderResultRow({ id: "apiKeyResult", text: "", tone: "" }) })
};

// Initialize our first run screen with any information from our existing configuration. The key's length is a validation fact the interpreter module owns, so the
// input's own bounds are stamped from it here rather than restated in the markup.
const firstRunOnStart = ({ config }) => {

  const input = document.getElementById("apiKey");

  input.maxLength = API_KEY_LENGTH;
  input.minLength = API_KEY_LENGTH;

  // Pre-populate with anything we might already have in our configuration.
  input.value = hydrawiseConfig.apiKey(config);

  // Pre-populate the optional account login the same way, so a user returning to this screen sees what is already configured rather than two empty fields. A
  // pre-populated pair is NOT a validated one - it is only rewritten if the user validates it again, and left exactly as it stands otherwise.
  document.getElementById("hydrawiseUsername").value = hydrawiseConfig.username(config);
  document.getElementById("hydrawisePassword").value = hydrawiseConfig.password(config);

  validationScopes.account.invalidate();

  return true;
};

/* Render the plugin's first-run login error display. Guidance sentences render as text nodes separated by <br> elements, and the failure detail - when present -
 * renders inside a <code class="text-danger"> via textContent, so a server-reported string is shown as text rather than interpreted as markup. Assembling DOM nodes
 * here rather than an assembled markup string keeps that trust boundary in one place, matching buildStatRow's discipline. An empty lines array renders no guidance,
 * and an omitted or empty detail renders no code element.
 */
const renderLoginError = (lines, detail) => {

  const nodes = [];

  for(const line of lines) {

    nodes.push(document.createTextNode(line), document.createElement("br"));
  }

  if(detail?.length) {

    const errorCode = document.createElement("code");

    errorCode.className = "text-danger";
    errorCode.textContent = detail;
    nodes.push(errorCode);
  }

  document.getElementById("loginError").replaceChildren(...nodes);
};

// Seed the session controller roster from a set of cloud-fetched controller identities, so a first-run login or an explicit refresh makes its controllers listable
// with no further call. Malformed entries are skipped.
const seedSessionControllers = (controllers) => {

  if(!Array.isArray(controllers)) {

    return;
  }

  for(const controller of controllers) {

    if(!isControllerIdentity(controller)) {

      continue;
    }

    sessionControllers.set(foldSerial(controller.serialNumber), { controllerId: controller.controllerId, name: controller.name, serialNumber: controller.serialNumber });
  }
};

// Validate our Hydrawise API key.
const firstRunOnSubmit = async ({ commit, config }) => {

  const apiKey = document.getElementById("apiKey").value;
  const loginError = document.getElementById("loginError");

  /* Clear both of the key card's result lines before the call, each through textContent so no text is routed through a markup assignment. The button's line clears
   * through its validation surface, which also retires any key validation still in flight - a late verdict must not paint over the row this submit just blanked,
   * and a verdict left standing would otherwise sit beside a submit that has just failed, saying the opposite.
   */
  loginError.textContent = "";
  validationScopes.apiKey.invalidate();

  // The /login endpoint answers a shaped object: a result sentence ("success" or the failure reason) plus the controllers it parsed from the same customerdetails
  // body it already fetched. On failure we render the sentence inline through the DOM helper, so the user sees the specific reason on the form.
  const { controllers, result } = await homebridge.request("/login", apiKey);

  if(result !== "success") {

    renderLoginError([], result);

    return false;
  }

  // Seed the session roster from the login response so a first-run user sees their controllers immediately, with no extra call, once the feature-options view opens.
  seedSessionControllers(controllers);

  /* Persist everything first run collected through commit, the framework's single write path, as ONE patch composed by the interpreter. One patch is required
   * rather than tidy: each interpreter write returns its own complete snapshot of the options array, so committing two of them would leave the shallow merge
   * holding only the second and silently dropping whatever the first composed.
   *
   * Only a VALIDATED account login joins the patch. An unvalidated edit sitting in the fields is not committed, and an absent pair leaves whatever the configuration
   * already held untouched.
   */
  await commit(hydrawiseConfig.withFirstRun(config, { apiKey, password: validatedCredentials?.password, username: validatedCredentials?.username }));

  return true;
};

// The controller-as-device pseudo-entry is tagged "controller"; every other entry the server returns is a zone.
const isController = (device) => device.kind === "controller";

/* Return the account's irrigation controllers for the two-level sidebar, with zero automatic cloud calls. We merge the following sources into the session roster
 * and return it: (a) the denormalized controller roster every cached accessory carries in its context - any one accessory knows every sibling, enabled or not;
 * (b) the config floor, whose Disable entries name controllers the user turned off (so they have no accessory), listed by serial until a refresh names them and
 * screened against the option catalog so a global-scope option entry never reads as a controller; and (c) the session roster itself, so a controller that
 * appeared once stays listed. A controller whose floor Disable the user removed this session, with no live accessory yet, is marked as awaiting a restart. The
 * apiKey is never consulted here - the listing is answered from the local accessory cache, the local config, and the option catalog the plugin's own UI server
 * publishes.
 *
 * The resolution carries the listing and the connection outcome together, which is the framework's contract for this hook. Reporting a failed read through the error
 * half rather than a toast is what lets the page tell "this account has no controllers configured" apart from "the controllers could not be read": the first is a
 * calm empty listing the user may have intended, the second routes to a retry view. A toast could say neither, because it leaves the empty listing on screen
 * underneath it saying the opposite.
 */
const getControllers = async ({ config }) => {

  const contextSerials = new Set();
  const knownZoneIds = new Set();
  let cached;

  // (a) The union of every validated cached accessory's denormalized controller roster, plus the zone ids those accessories own so a zone-scope floor entry is not
  // mistaken for a disabled controller below. The cache read is kept for the names below, which read each controller's own accessory from it.
  try {

    cached = await homebridge.getCachedAccessories();

    for(const accessory of cached) {

      const roster = accessory?.context?.controllers;

      if(Array.isArray(roster)) {

        for(const entry of roster) {

          if(!isControllerIdentity(entry)) {

            continue;
          }

          const key = foldSerial(entry.serialNumber);

          contextSerials.add(key);
          sessionControllers.set(key, { controllerId: entry.controllerId, name: entry.name, serialNumber: entry.serialNumber });
        }
      }

      const zones = accessory?.context?.zones;

      if(Array.isArray(zones)) {

        for(const zone of zones) {

          if(isZoneIdentity(zone)) {

            knownZoneIds.add(foldSerial(zone.relayId.toString()));
          }
        }
      }
    }
  } catch(err) {

    /* The accessory cache is the listing's primary source, so a read that fails leaves us with nothing trustworthy to show and the failure travels back as the
     * result's error half. Returning here rather than carrying on is deliberate: the later sources could still compose a partial roster, and a partial roster
     * rendered as though it were the whole account is a worse answer than an honest failure the user can retry.
     */
    return { controllers: [], error: "Unable to read the Homebridge accessory cache: " + ((err instanceof Error) ? err.message : String(err)),
      guidance: LIST_CACHE_GUIDANCE, headline: LIST_CACHE_FAILED };
  }

  /* (b) The config floor, read through the option catalog. Each named serial is remembered for the session; one that is neither a known controller nor a known
   * zone becomes a serial-labeled disabled entry the user can then refresh to name. The catalog read is unguarded on purpose: there is no floor walk without a
   * catalog, and a roster silently missing every floor-only controller is the same partial answer the accessory-cache read above rejects. A failure therefore
   * rejects this listing, which the framework routes to the same connection-error view with a retry that the error half above reaches, and the cached fetch
   * clears itself so the retry asks fresh.
   */
  const catalog = await getCatalog();
  const floorSet = new Set();

  for(const serial of floorSerials(config?.options, catalog)) {

    const key = foldSerial(serial);

    if(knownZoneIds.has(key)) {

      continue;
    }

    floorSet.add(key);
    sessionFloorSerials.add(key);

    if(!sessionControllers.has(key)) {

      sessionControllers.set(key, { controllerId: undefined, name: serial, serialNumber: serial });
    }
  }

  /* Each controller's Name option, read through one engine built for this listing over the catalog already in hand. The read is best effort and all-or-nothing,
   * as the zone listing's consult is: a name falling back to the one the controller is known by is a truthful answer, so an engine failure must not fail the
   * listing, and every controller then reads as having no Name set.
   */
  const overrides = new Map();

  try {

    const engine = await getEngine(config);

    for(const entry of sessionControllers.values()) {

      overrides.set(entry.serialNumber, readOverride(engine, entry.serialNumber));
    }
  } catch {

    overrides.clear();
  }

  /* (c) Resolve the session roster to the framework's controller shape, each name composed by controllerLabel, the rule the controller's panel entry reads too.
   * A session entry with no current backing whose serial was in the floor earlier this session is a re-enable awaiting a restart, so we mark it after composing;
   * the entry stays listed either way.
   */
  const resolved = [];

  for(const entry of sessionControllers.values()) {

    const key = foldSerial(entry.serialNumber);
    const backed = contextSerials.has(key) || floorSet.has(key);
    const pendingRestart = !backed && sessionFloorSerials.has(key);
    const name = controllerLabel({ accessory: matchControllerAccessory(cached, key), identity: entry.name, override: overrides.get(entry.serialNumber) });

    resolved.push({ controllerId: entry.controllerId, name: pendingRestart ? (name + " (pending restart)") : name, serialNumber: entry.serialNumber });
  }

  /* A successful read carries no error, empty roster or not: an account with every controller disabled and no floor entries is a legitimate empty listing. The
   * plugin supplies its own message for that empty listing, which the framework reads only when the roster is empty and the error is too, because its default
   * sends the user to the main settings tab while this plugin's controllers come from the account behind the API key.
   */
  return { controllers: resolved, emptyMessage: LIST_EMPTY, error: "" };
};

/* Return a selected controller's zones for the two-level sidebar, with zero automatic cloud calls. We resolve the zones from the accessory whose own controller
 * identity matches the selection (an enabled controller), falling back to the zones an explicit refresh stored this session (a disabled controller the user has
 * refreshed). Every value read from the cache is shape-checked, so a malformed read counts as absent. Two empty cases are distinct: an enabled controller with a
 * legitimately empty zone set resolves the controller pseudo-entry with a zero zone count, while a controller whose zones we cannot resolve at all resolves the
 * pseudo-entry alone, carrying the guidance sentence for the state it is in.
 *
 * The pseudo-entry's notice field is the channel for that guidance, rendered by the infoPanel: a controller the configuration disables, one whose published details
 * are unusable, and one the plugin has never discovered each read differently to the user and each prescribe a different remedy. A listable controller the
 * configuration disables carries its own notice alongside the zone count, so a refresh that lists its zones cannot make it look published. The error half of the
 * result therefore means exactly what the framework defines it to mean - a genuine fetch failure, which routes to the connection-error view - and none of these
 * states travel through it.
 */
const getDevices = async (controller, { config } = {}) => {

  if(!controller) {

    return { devices: [], error: "" };
  }

  const targetSerial = foldSerial(controller.serialNumber);
  const identityName = sessionControllers.get(targetSerial)?.name ?? controller.name;
  let cached;
  let matched;
  let zones = null;

  // Resolve the zones from the matching cached accessory's own context. A fresh cache read per invocation is the accepted cost of an unconditionally current listing.
  // Both the cache and the match are function-scoped, because classifying an unresolvable controller below reads the same cache rather than fetching it a second time.
  try {

    cached = await homebridge.getCachedAccessories();
    matched = matchControllerAccessory(cached, targetSerial);

    if(matched && Array.isArray(matched.context.zones) && matched.context.zones.every(isZoneIdentity)) {

      zones = matched.context.zones;
    }
  } catch(err) {

    return { devices: [], error: (err instanceof Error) ? err.message : String(err), guidance: LIST_CACHE_GUIDANCE, headline: LIST_ZONES_CACHE_FAILED };
  }

  // A context-less controller (no live accessory, or a malformed cache) falls back to the zones an explicit refresh stored this session.
  if(zones === null) {

    const refreshed = sessionZones.get(targetSerial);

    if(Array.isArray(refreshed) && refreshed.every(isZoneIdentity)) {

      zones = refreshed;
    }
  }

  if(zones === null) {

    // No zones are resolvable for this controller. Classify why, and answer a calm zero-zone listing whose guidance renders through the infoPanel rather than
    // routing a non-failure through the framework's connection-error view. A genuine catalog failure still takes the error channel: the framework's contract
    // requires this hook to RESOLVE the { devices, error } shape, and a rejection would escape into its failure plumbing instead of the calm listing this
    // state is, so every failure path here resolves the shape rather than rejects.
    try {

      const enabled = await isControllerEnabled(config, controller.serialNumber);
      let notice = NOTICE_UNDISCOVERED;

      if(!enabled) {

        notice = NOTICE_DISABLED;

      /* Enabled with no accessory of its own still splits in two: matched covers this controller having a live accessory whose zones simply failed to
       * resolve, and the cache scan covers one with no accessory of its own at all. That scan is not hunting for another controller's accessory - every
       * accessory this plugin's own writers currently produce carries one of the two well-formed shapes isZoneAccessoryLike and isControllerIdentity test
       * for - so a cached entry matching neither shape can only be a leftover or malformed one. Even that is still evidence the plugin has written to the
       * accessory cache before, which is why its presence favors the milder "not published yet" notice over the harsher "never discovered" one.
       */
      } else if(matched || cached.some((accessory) => !isZoneAccessoryLike(accessory?.context) && !isControllerIdentity(accessory?.context?.controller))) {

        notice = NOTICE_UNPUBLISHED;
      }

      /* The controller's own name composes through controllerLabel exactly as the healthy listing below composes it, so a controller the plugin cannot list
       * zones for still carries the name its owner gave it.
       *
       * The read takes a try/catch of ITS OWN rather than joining the branch's. This branch escalates an engine failure to the error channel, which is the right
       * answer for the classification above it - a notice derived from a failed gate read would be a guess. A name is different: falling back to the identity
       * name is a truthful answer, so a failure here must not turn a calm listing into a connection-error view.
       */
      let override;

      try {

        override = readOverride(await getEngine(config), controller.serialNumber);
      } catch {

        override = undefined;
      }

      return { devices: [{ kind: "controller", name: controllerLabel({ accessory: matched, identity: identityName, override }), notice,
        serialNumber: controller.serialNumber, sidebarGroup: "hidden" }], error: "" };
    } catch(error) {

      return { devices: [], error: (error instanceof Error) ? error.message : String(error), guidance: LIST_ZONES_CLASSIFY_GUIDANCE,
        headline: LIST_ZONES_CLASSIFY_FAILED };
    }
  }

  /* One consult answers every question this listing asks of the configuration: whether the controller is published, whether each zone is published, and what name
   * the user has set for the controller and for each zone. A disabled controller can still list zones (a refresh stored them, or its accessory survives until the
   * next restart), so the listing carries the disabled notice alongside the zone count. The whole consult is best-effort and all-or-nothing: a catalog or engine
   * failure is treated as no consult at all - the controller and every zone read as enabled, and every label falls through to the arms below - so a failure can
   * never break a healthy listing, and the consumers cannot end up disagreeing about whether the engine answered.
   */
  let controllerOverride;
  let enabled = true;
  const overrides = new Map();
  const zoneEnabled = new Map();

  try {

    const engine = await getEngine(config);

    enabled = engine.test(DEVICE_CATEGORY, undefined, controller.serialNumber);

    controllerOverride = readOverride(engine, controller.serialNumber);

    for(const zone of zones) {

      // The zone's own name, asked with the relay id and NOTHING else. The Name option resolves at the controller as well as the zone, so a read that also
      // presented the serial would answer every unnamed zone with its controller's name - the runtime's readers keep the same single-id rule for the same reason.
      overrides.set(zone.relayId, readOverride(engine, zone.relayId.toString()));

      // The zone-scope gate, asked with the relay id in the device position and the controller serial in the controller position - the runtime's own scoping
      // convention, so the sidebar and the plugin agree on which zones reach HomeKit.
      zoneEnabled.set(zone.relayId, engine.test(DEVICE_CATEGORY, zone.relayId.toString(), controller.serialNumber));
    }
  } catch {

    controllerOverride = undefined;
    enabled = true;
    overrides.clear();
    zoneEnabled.clear();
  }

  /* The zone rows, sorted by relay, keyed by the relay id the runtime scopes zone options against; then the controller-as-device pseudo-entry the two-level sidebar
   * selects on load, hidden from the zone list and reporting the zone count.
   *
   * A zone's sidebar label is its relay number and its effective name: the user's configured override where HomeKit can carry it - so a just-saved edit reads
   * back immediately - then the name HomeKit last showed, then the name Hydrawise reported. The sidebar number is an affordance only; it is part of a HomeKit name
   * only where the zone's word names it, and the controller pseudo-entry carries no number at all.
   *
   * A zone row carries the bare name and its published state alongside that composed label, which is what the sidebar's own row renderer lays the number and the
   * name out in aligned columns from. The composed name stays the row's identity surface and the fallback whenever that renderer declines a row.
   */
  /* The cached standalone accessories hosting this controller's zones, keyed by relay id. A zone the user has given its own accessory carries its last-flushed
   * HomeKit name on that accessory rather than on the controller accessory, so the label arm below has to read the accessory the valve actually lives on.
   * Ownership is matched on the folded serial, exactly as the controller match above matches its own.
   */
  const zoneHosts = new Map();

  for(const accessory of cached) {

    if(isZoneAccessoryLike(accessory?.context) && (foldSerial(accessory.context.ownerController.serialNumber) === targetSerial)) {

      zoneHosts.set(accessory.context.zone.relayId, accessory);
    }
  }

  /* Each zone's effective display name, resolved once and read by every consumer below - the sidebar label and the controller entry's name map - so a zone reads
   * as the same name wherever it is named. The arms and their order are the listing's own: the configured override, then the name HomeKit last showed on whichever
   * accessory hosts the valve, then the name Hydrawise reported, composed through the page's naming rule, so an override HomeKit cannot carry yields to the arms
   * after it and a zone HomeKit can carry no name for reads as its word and number, each name shown as HomeKit carries it.
   */
  const displayNames = new Map(zones.map((zone) => [ zone.relayId, hydrawiseNames.zoneName({ override: overrides.get(zone.relayId), relay: zone.relay,
    reported: cachedValveName(zoneHosts.get(zone.relayId) ?? matched, zone.relayId) ?? zone.name }) ]));

  /* The controller's persisted schedule projection, resolved once from the same matched accessory the zones came from and shape-checked before any consumer reads
   * it. A context-less controller, a legacy cache written before this projection existed, and a corrupt entry all resolve to null, and every renderer treats that
   * as identity-only display. The two row kinds below carry the projection under DISTINCT field names - a zone row's own entry as zoneSchedule, the controller's
   * whole projection as schedule - so no consumer can mistake one shape for the other.
   */
  const schedule = isScheduleStatus(matched?.context?.schedule) ? matched.context.schedule : null;
  const zoneRows = zones.slice().sort((a, b) => a.relay - b.relay).map((zone) => ({ displayName: displayNames.get(zone.relayId),
    enabled: zoneEnabled.get(zone.relayId) ?? true, kind: "zone", name: zone.relay.toString() + ". " + displayNames.get(zone.relayId),
    ownerSerial: controller.serialNumber, relay: zone.relay, relayId: zone.relayId,
    scheduleMeta: schedule ? { activeWindowSeconds: schedule.activeWindowSeconds, asOf: schedule.asOf } : undefined,
    serialNumber: zone.relayId.toString(), zoneSchedule: schedule?.zones.find((entry) => entry.relayId === zone.relayId) }));
  // The hardware HomeKit last showed for this controller, resolved from the same matched accessory everything else here reads. It is absent on an install that has
  // never enriched, and the panel renders those cells only when it is present.
  const hardware = cachedControllerHardware(matched);

  // The controller row's own name, composed by controllerLabel on the terms a zone's label above follows.
  const name = controllerLabel({ accessory: matched, identity: identityName, override: controllerOverride });
  const controllerEntry = { hardware, kind: "controller", name, ...(enabled ? {} : { notice: NOTICE_DISABLED_LISTED }),
    schedule: schedule ?? undefined, serialNumber: controller.serialNumber, sidebarGroup: "hidden", zoneCount: zoneRows.length,
    zoneNames: Object.fromEntries(zones.map((zone) => [ zone.relayId.toString(), displayNames.get(zone.relayId) ])) };

  return { devices: [ controllerEntry, ...zoneRows ], error: "" };
};

/* Refine which feature options a device row shows, by the scope levels the option declares. The framework's own view-kind gate has already run by the time we are
 * asked, admitting an option to a device view when it declares either the controller or the device level; this narrows that to the kind of device in hand, so the
 * controller pseudo-entry shows only controller-scopable options and a zone shows only zone-scopable ones. The optional chaining is what keeps an entry that
 * declares no scopes from throwing here - such an entry is excluded from every device-scoped view, since neither branch's includes() can find a scope in an
 * undefined list - and the global case returns true unconditionally because only options the framework already admitted globally ever reach it.
 */
const validOption = (device, option) => {

  if(!device) {

    return true;
  }

  if(isController(device)) {

    return option.scopes?.includes("controller") === true;
  }

  return option.scopes?.includes("device") === true;
};

/* Build one row of the device-stats grid. We construct DOM nodes directly via createElement / textContent rather than concatenating a markup string so any HTML
 * metacharacter in a field value renders as text instead of being interpreted as markup. The discovery boundary is the trust line, and treating server-reported
 * strings as data rather than HTML is the cleanest place to enforce it.
 */
const buildStatRow = (label, value, valueClassName) => {

  const item = document.createElement("div");

  item.className = "stat-item";

  const labelSpan = document.createElement("span");

  labelSpan.className = "stat-label";
  labelSpan.textContent = label;

  const valueSpan = document.createElement("span");

  valueSpan.className = valueClassName;
  valueSpan.textContent = value ?? "";

  item.append(labelSpan, valueSpan);

  return item;
};

/* Build one guidance paragraph for below the stats grid. Its text is assigned through textContent, so a notice renders as text rather than markup, matching the
 * trust boundary buildStatRow holds for every other value we display.
 */
const buildNotice = (text) => {

  const notice = document.createElement("p");

  notice.className = "hbhh-device-notice small mb-0 mt-2";
  notice.textContent = text;

  return notice;
};

// The controller serial a device row's schedule belongs to: a controller pseudo-entry answers with its own serial, a zone row with the owner serial its listing
// stamped on it. One accessor, so the ticker locates the owning accessory the same way for either row kind.
const ownerSerialOf = (device) => (isController(device) ? device.serialNumber : device.ownerSerial);

// Whether a device row carries schedule surface at all - the field its own kind carries it on. A zone answers on its listing's projection metadata rather than on
// its own entry, so a zone momentarily missing from the projection still refreshes rather than going quiet for the rest of the page cycle.
const scheduleSurface = (device) => (isController(device) ? device.schedule !== undefined : device.scheduleMeta !== undefined);

// The instant a device row's projection was last CHANGED, read from whichever field its kind carries it on. This is what the staleness notice dates itself by.
const scheduleAsOf = (device) => (isController(device) ? device.schedule?.asOf : device.scheduleMeta?.asOf);

// A device row with its schedule fields replaced by what the cache holds now, which is what one tick renders. Building a copy rather than mutating the listing's
// own row leaves the row the framework handed us untouched, so a later render of the same selection still starts from the listing's own truth.
const withSchedule = (device, schedule) => {

  if(isController(device)) {

    return { ...device, schedule: schedule ?? undefined };
  }

  return { ...device, scheduleMeta: schedule ? { activeWindowSeconds: schedule.activeWindowSeconds, asOf: schedule.asOf } : undefined,
    zoneSchedule: schedule?.zones.find((entry) => entry.relayId === device.relayId) };
};

/* Paint the details panel for one device row. The controller pseudo-entry reports its serial number, and its zone count whenever the count is known - a controller
 * whose zones cannot be resolved carries no count, so the row is omitted rather than reporting a zero that would read as a controller with no zones. A zone reports
 * its display relay number and its relay id. Both kinds then append whatever schedule rows their persisted facts derive to, and a pseudo-entry carrying a notice
 * renders that guidance below the grid rather than as a stat cell, keeping prose out of a row layout the framework may hide as it narrows.
 *
 * This is the internal renderer, separated from the framework's hook below so the ticker can repaint the panel on screen with a fresher projection without going
 * through the framework's own render cycle. Every value is carried on the device object by the read hooks' shapes, so it reads no field those shapes do not
 * declare, and every value reaches the DOM through buildStatRow or textContent rather than a markup string.
 */
const renderDeviceDetails = ({ device, panel }) => {

  // No device specified, we must be in a global context.
  if(!device) {

    panel.replaceChildren();

    return;
  }

  // Build the device-details grid fresh so successive selections do not stack stale rows.
  const grid = document.createElement("div");

  grid.className = "device-stats-grid";

  // One instant for the whole pass, so every countdown and the staleness verdict answer to the same "now" rather than to whatever the clock read as each was built.
  const nowSeconds = Math.floor(Date.now() / 1000);
  let derived;

  if(isController(device)) {

    /* A controller renders inside one bordered box as an identity-and-state strip across the top, then whatever detail the schedule has to add. The framework's
     * status-grid modifier is a column grid whose track count the grid states for itself through the `--fo-status-tracks` variable, exactly as HBPU's own status
     * panel does, so the layout is composed from the shared classes rather than from new local CSS. The strip states one track per cell, which lays the whole strip
     * on the first line and starts the detail on the line beneath, flowing along the same tracks; a grid that states no count falls to the modifier's single track
     * and stacks every cell in one column. Which cells the strip carries, and in what order, is the display module's derivation; this renderer only turns each row
     * into its element.
     */
    const controllerDisplay = deriveControllerDisplay(device.schedule, device.zoneNames, nowSeconds);
    const strip = deriveControllerStrip({ hardware: device.hardware, serialNumber: device.serialNumber, status: controllerDisplay.status,
      zoneCount: device.zoneCount });

    grid.classList.add("fo-status-grid");
    grid.style.setProperty("--fo-status-tracks", strip.length.toString());

    grid.append(...strip.map((row) => buildStatRow(row.label, row.value, row.monospace ? "stat-value font-monospace" : "stat-value")));

    derived = { rows: controllerDisplay.detail, stale: controllerDisplay.stale };
  } else {

    grid.append(...deriveZoneStrip({ relay: device.relay, relayId: device.relayId }).map((row) => buildStatRow(row.label, row.value,
      row.monospace ? "stat-value font-monospace" : "stat-value")));

    derived = deriveZoneDisplay(device.zoneSchedule, device.scheduleMeta, nowSeconds);
  }

  for(const [ label, value ] of derived.rows) {

    grid.append(buildStatRow(label, value, "stat-value"));
  }

  const nodes = [grid];

  // The guidance sentence, when the read hooks attached one, follows the grid as a paragraph of its own.
  if(device.notice !== undefined) {

    nodes.push(buildNotice(device.notice));
  }

  // A schedule instant that a live runtime would already have moved past says something the rows themselves cannot: what is on screen may be describing a plugin
  // that has stopped. We date the notice by the projection's own timestamp, so the user can see how far behind it is.
  const asOf = scheduleAsOf(device);

  if(derived.stale && (asOf !== undefined)) {

    nodes.push(buildNotice("This schedule was last updated " + formatRunTime(asOf, nowSeconds) +
      " and may be out of date. Verify that Homebridge and this plugin are running."));
  }

  panel.replaceChildren(...nodes);
};

/* Put a sidebar dot into the state given, the single writer of a dot's whole presentation - its color class, its tooltip, and how a screen reader treats it. The
 * initial render and every repaint the ticker drives both come through here, so a dot's look and the word describing it can never be set by two code paths that
 * have drifted apart.
 *
 * A null state is a zone with nothing to say. Such a dot keeps its column, so the numbers and names beside it stay aligned, but it carries no color, no tooltip,
 * and no accessible name - an invisible spacer rather than a claim about the zone.
 */
const applyDotState = (dot, state) => {

  dot.classList.remove(...[...dot.classList].filter((name) => name.startsWith("hbhh-dot-")));

  if(state === null) {

    dot.removeAttribute("aria-label");
    dot.removeAttribute("role");
    dot.removeAttribute("title");
    dot.setAttribute("aria-hidden", "true");

    return;
  }

  // A colored dot is genuinely information, so it is exposed as an image with the state's own word as its accessible name rather than being hidden from assistive
  // technology as decoration would be. The tooltip carries the same word, which is what makes the color legible to anyone who has not memorized the palette.
  dot.classList.add("hbhh-dot-" + state);
  dot.removeAttribute("aria-hidden");
  dot.setAttribute("aria-label", ZONE_STATE_LABELS[state]);
  dot.setAttribute("role", "img");
  dot.setAttribute("title", ZONE_STATE_LABELS[state]);
};

/* Compose a sidebar row's content. The framework asks this once per device per sidebar build, with the very device object our own listing produced, and renders
 * whatever we return in place of the device name; a null return leaves the framework's default name rendering alone, which is how the controller pseudo-entry
 * keeps its plain label.
 *
 * A zone renders as aligned columns - its state dot, its number, and its name - because a right-aligned number column is what makes every name start at one
 * shared edge, however many digits the numbers around it carry. A zone the configuration disables is still a real zone at Hydrawise, so it is set apart rather
 * than struck out: an italic, muted name with a tooltip saying what is different about it.
 *
 * Every value reaches the DOM through textContent, the same trust boundary buildStatRow holds - a name reported by Hydrawise or typed by the user renders as text
 * and is never parsed as markup. The framework owns the link element around this content, so nothing here is interactive: an interactive element would fight the
 * link's own delegated click.
 */
const renderDeviceContent = (device) => {

  if(device.kind !== "zone") {

    return null;
  }

  const row = document.createElement("span");

  row.className = "hbhh-zone-row";

  const dot = document.createElement("span");

  dot.className = "hbhh-zone-dot";
  dot.dataset.ownerSerial = device.ownerSerial;
  dot.dataset.relayId = device.relayId.toString();

  // The dot's identity travels in its own data attributes rather than in a closure, which is what lets the ticker find every rendered dot by query and repaint it
  // without holding a reference to the row that built it.
  applyDotState(dot, zoneScheduleState(device.zoneSchedule, device.scheduleMeta, Math.floor(Date.now() / 1000)));

  const number = document.createElement("span");

  number.className = "hbhh-zone-number";
  number.textContent = device.relay.toString() + ".";

  const name = document.createElement("span");

  name.className = "hbhh-zone-name";
  name.textContent = device.displayName ?? device.name;

  if(device.enabled === false) {

    name.classList.add("hbhh-zone-disabled");
    name.title = "Not published to HomeKit.";
  }

  row.append(dot, number, name);

  return row;
};

/* One tick of the schedule ticker, refreshing both schedule-bearing surfaces from ONE read of the accessory cache: the sidebar's zone dots and the details panel on
 * screen. A poll that landed since the last render therefore shows up in both at once, and a running countdown keeps counting down while the user watches. The read
 * is homebridge.getCachedAccessories, a LOCAL call, so the webUI's zero-automatic-cloud-call property is untouched by the cadence.
 *
 * The two surfaces are reached differently, and deliberately so. The panel belongs to one render, so its repaint is gated on that render still being the one on
 * screen; the dots are found by query at the top of the tick, so they belong to whatever the sidebar is actually showing and need no such gate.
 */
const scheduleTick = async () => {

  const context = renderContext;
  const dots = document.querySelectorAll("#devicesContainer .hbhh-zone-dot[data-relay-id]");
  const wantsPanel = Boolean(context?.device) && scheduleSurface(context.device);

  // Neither surface reads a schedule, so there is nothing to refresh and the cache is left alone. The interval itself keeps running until the page cycle ends,
  // which a no-op this cheap makes entirely acceptable.
  if(!wantsPanel && !dots.length) {

    return;
  }

  const sequence = ++tickSequence;

  /* Supersede rather than latch. The plugin-ui bridge's RPC carries no timeout of its own, so a read can hang forever and a boolean busy flag would latch the
   * ticker shut for the rest of the page cycle; bounding an in-flight read at two ticks lets a later tick proceed while the checks below keep the older read's late
   * resolution harmless.
   */
  if((inFlightTick !== null) && ((sequence - inFlightTick) < 2)) {

    return;
  }

  inFlightTick = sequence;

  let cached;

  try {

    cached = await homebridge.getCachedAccessories();
  } catch {

    // A rejected read clears its own record and leaves the last render standing: a failed refresh is no reason to blank a panel that is showing good data.
    if(inFlightTick === sequence) {

      inFlightTick = null;
    }

    return;
  }

  // A read that a later tick already superseded is dropped rather than painted, since the newer read is the one that describes the cache as it is now.
  if(inFlightTick !== sequence) {

    return;
  }

  inFlightTick = null;

  /* The sidebar dots first, and unconditionally: they were queried from the DOM rather than carried on a render, so they are the sidebar the user is looking at
   * whatever the panel beside them is showing. Dots are grouped by their owning controller so each controller's accessory is located and validated once however
   * many zones it lists, and the whole pass shares one instant, so no two dots of a pass answer to a different "now".
   *
   * A sidebar rebuilt while this read was in flight has already painted its own fresh dots from the listing that rebuilt it, so the nodes gathered above are then
   * detached and writing to them changes nothing the user can see.
   */
  const nowSeconds = Math.floor(Date.now() / 1000);

  for(const [ serial, group ] of Map.groupBy(dots, (dot) => foldSerial(dot.dataset.ownerSerial))) {

    const owner = matchControllerAccessory(cached, serial);
    const schedule = isScheduleStatus(owner?.context?.schedule) ? owner.context.schedule : null;
    const meta = schedule ? { activeWindowSeconds: schedule.activeWindowSeconds, asOf: schedule.asOf } : undefined;

    for(const dot of group) {

      applyDotState(dot, zoneScheduleState(schedule?.zones.find((zone) => zone.relayId === Number(dot.dataset.relayId)), meta, nowSeconds));
    }
  }

  // The dots were this tick's whole work when the view on screen reads no schedule of its own.
  if(!wantsPanel) {

    return;
  }

  // Discard unless the view that dispatched this read is still the one on screen. The context object is minted fresh on every render, so an identity check asks
  // exactly the right question - is this still the same render - and a read that resolves after the user navigated leaves the panel alone.
  if(renderContext !== context) {

    return;
  }

  const owner = matchControllerAccessory(cached, foldSerial(ownerSerialOf(context.device)));
  const schedule = isScheduleStatus(owner?.context?.schedule) ? owner.context.schedule : null;

  renderDeviceDetails({ device: withSchedule(context.device, schedule), panel: context.panel });
};

/* Show the details for the selected sidebar entry. The framework invokes this with a single options bag carrying the selected device, the panel element to render
 * into, and the page cycle's signal, and this hook consumes all three: it paints through the internal renderer above and arms the schedule ticker against the
 * page cycle.
 *
 * The render-context bookkeeping runs UNCONDITIONALLY on every invocation - a fresh object per render, schedule-bearing or not and an undefined device included -
 * so the tick guards always describe the view actually on screen. A fresh object per render is exactly what gives the ticker's same-object discard its meaning.
 */
const showDeviceDetails = ({ device, panel, signal }) => {

  renderContext = { device, panel };

  renderDeviceDetails(renderContext);

  // Arming is conditional, unlike the bookkeeping above: there is nothing to tick for a view that reads no schedule.
  if(!device || !scheduleSurface(device)) {

    return;
  }

  /* Arm the ticker once for this page cycle. The framework hands every render within one cycle the SAME signal object - switching between zones, the controller
   * entry, and back mints no new one and fires no abort - so the signal is the cycle's identity, and keying the arm on it is what keeps a panel switch from
   * stacking a second interval or a second resume subscriber. The teardown is registered BEFORE the interval is armed, so no interval runs without the abort that
   * stops it, and the signal is recorded only once the teardown and the interval are in place, because the recorded signal is this block's own re-entry guard: a
   * throw ahead of the record leaves it unrecorded, so the next render of the cycle arms again rather than finding the cycle armed with nothing running.
   *
   * The page cycle is the deliberate lifetime. This data is per-selected-device and its read is a cheap local call, so the ticker dies with the cycle and re-arms
   * on the next one; nothing here is worth keeping warm across a navigation the way an expensive cloud fetch would be.
   */
  if(tickerSignal !== signal) {

    signal.addEventListener("abort", () => {

      clearInterval(timer);
      tickerSignal = null;
      renderContext = null;
      inFlightTick = null;
    }, { once: true });

    const timer = setInterval(() => void scheduleTick(), SCHEDULE_TICK_MS);

    tickerSignal = signal;

    // A wake from an OS-level freeze should not have to wait out the remainder of a tick, so the page's resume detector runs one the moment it notices. It is
    // bound to the same cycle signal the interval is, and registered under the same guard, so each cycle registers it exactly once.
    ui.liveness.onResume(() => void scheduleTick(), { signal });
  }

  /* One tick immediately, rather than leaving the panel to wait out the first interval. The paint above renders from the device row the SIDEBAR LISTING carried,
   * whose schedule snapshot dates from the listing's own read in this page cycle, so a panel opened some way into a session can show state up to a tick behind the very
   * dots beside it - which the ticker has been refreshing all along. This heals it within one local cache read.
   *
   * It costs nothing to run alongside the interval: the read is getCachedAccessories, a local call that leaves the zero-automatic-cloud-call property intact, and
   * the tick's own sequence guards make an overlap with an interval tick harmless - the later read wins and the earlier one is dropped unpainted.
   */
  void scheduleTick();
};

// Parameters for our feature options webUI.
const featureOptionsParams = {

  getControllers: getControllers,
  getDevices: getDevices,
  infoPanel: showDeviceDetails,
  sidebar: {

    deviceContent: renderDeviceContent,
    deviceLabel: "Zones",

    /* The refresh action the framework docks on the Controllers heading, and this page's ONE on-demand cloud touch. Every read hook here answers from the accessory
     * cache, the configuration, and the session stores without reaching Hydrawise at all, so asking a server to re-read - the framework's whole contract for this
     * handler - means the cloud fetch itself: it re-reads the account and seeds the session stores those hooks consult, and the framework then re-enters through its
     * own show() so the refreshed roster renders. Nothing here disables a control or repaints a view, because the framework owns the button's in-flight state, the
     * re-entry, and the toast a rejection surfaces through.
     *
     * A refreshed roster costs one Hydrawise call, plus one request that loops server-side over the controllers with no live accessory - whatever kept them from
     * getting one, since their zones are otherwise unresolvable on this page - so a successful refresh drives 1 + K upstream calls for K such controllers.
     *
     * The failure postures differ by what has already succeeded. A failed controller fetch throws, which is what leaves the page exactly as it stands: the framework
     * declines to re-enter, so a refresh that learned nothing cannot present as one that did. The partial failures after the roster is seeded resolve instead, and
     * report through a toast of their own - the fresh roster is real by then, and rejecting would withhold the very re-entry that puts it on screen.
     *
     * Resolving on an ended page cycle is inert, since the re-entry that follows answers to that cycle's own aborted signal.
     */
    refresh: {

      label: "Refresh from Hydrawise",
      onRefresh: async () => {

        const apiKey = hydrawiseConfig.apiKey((await homebridge.getPluginConfig())?.[0]);
        const { controllers, error } = await homebridge.request("/refreshControllers", { apiKey });

        if(error) {

          throw new Error(error);
        }

        // Update the session roster from the refreshed controllers.
        const identities = Array.isArray(controllers) ? controllers.filter(isControllerIdentity) : [];

        seedSessionControllers(identities);

        // Determine which refreshed controllers have no live accessory. A cache-read failure here leaves the list empty, so we skip the zones fetch rather than
        // fetch every controller's zones; the roster refresh above still stands.
        let contextless = [];

        try {

          const cached = await homebridge.getCachedAccessories();
          const contextSerials = new Set();

          for(const accessory of cached) {

            if(isControllerIdentity(accessory?.context?.controller)) {

              contextSerials.add(foldSerial(accessory.context.controller.serialNumber));
            }
          }

          contextless = identities.filter((identity) => !contextSerials.has(foldSerial(identity.serialNumber)));
        } catch(err) {

          notifyError((err instanceof Error) ? err.message : String(err));
        }

        // Fetch the zones for the context-less controllers - the owner-ruled explicit fetch that keeps a disabled controller's zones listable - and store them by
        // serial.
        if(contextless.length > 0) {

          const { error: zonesError, zones } = await homebridge.request("/refreshZones", { apiKey,
            controllers: contextless.map((identity) => ({ controllerId: identity.controllerId, serialNumber: identity.serialNumber })) });

          if(zonesError) {

            notifyError(zonesError);
          } else if(zones && (typeof zones === "object")) {

            for(const [ serial, zoneList ] of Object.entries(zones)) {

              if(Array.isArray(zoneList) && zoneList.every(isZoneIdentity)) {

                sessionZones.set(foldSerial(serial), zoneList);
              }
            }
          }
        }
      }
    }
  },
  ui: {

    isController: isController,
    validOption: validOption
  }
};

// Parameters for our plugin webUI.
const webUiParams = {

  featureOptions: featureOptionsParams,
  firstRun: {

    isRequired: firstRunIsRequired,
    onStart: firstRunOnStart,
    onSubmit: firstRunOnSubmit
  },
  name: "Hydrawise"
};

// Instantiate the webUI.
const ui = new webUi(webUiParams);

/* Adopt the framework's theming for this page - the design tokens, the themed canvas, the dark-mode corrections, the page-kit classes, and the host's own accent -
 * with one call that holds for the life of the page. Theming is a page concern rather than a view one, so first run, the settings form, and support all wear it
 * from here. The promise is voided rather than awaited because the framework owns its rejection posture: a failed initial lighting-mode read still leaves the
 * sheets adopted and the host's theme signals followed, so the next announcement the host makes brings the page into step.
 */
void ui.registerTheming();

/* Validate the Hydrawise API key on demand, during first run. It is early feedback and nothing else: the submit validates the key through this same endpoint before
 * it commits anything, so a user who never presses the button is no worse off, and one who does learns whether their key works before committing a configuration.
 *
 * The length is answered locally rather than by the cloud. The interpreter module owns what a key's length must be and first run stamps the input's own bounds from
 * it, so an incomplete key is already known to be invalid and spending a call against the account's rate budget to be told so would buy nothing.
 */
const onValidateApiKey = async () => {

  const button = document.getElementById("validateApiKey");
  const apiKey = document.getElementById("apiKey").value;

  if(apiKey.length !== API_KEY_LENGTH) {

    renderResultRow({ id: "apiKeyResult", text: "Enter your complete Hydrawise API key.", tone: "text-danger" });

    return;
  }

  // Whatever the last validation said is stale the moment a new one starts, so the line is blanked before the call rather than after it - a call that never
  // resolves must not leave an older verdict standing beside newer input. Beginning the validation is what blanks it, and what hands this invocation its claim.
  const claim = validationScopes.apiKey.begin();

  button.disabled = true;

  try {

    const { result } = await homebridge.request("/login", apiKey);

    /* A verdict lands only while this invocation's claim is still current. An edit to the key, or a newer validation of it, retires this call, and its verdict
     * would otherwise land beside a key it never described. A superseded invocation discards silently - the surface has already cleared itself.
     */
    if(!validationScopes.apiKey.isCurrent(claim)) {

      return;
    }

    if(result !== "success") {

      renderResultRow({ id: "apiKeyResult", text: result, tone: "text-danger" });

      return;
    }

    renderResultRow({ id: "apiKeyResult", text: "Your Hydrawise API key is valid.", tone: "text-success" });
  } finally {

    /* The re-enable is unconditional, superseded or not: the invocation that disabled the control is the only thing that can balance its own disable, so an
     * invocation that returned without re-enabling would leave the control disabled with no other owner of that duty.
     */
    button.disabled = false;
  }
};

/* Validate the optional account login on demand, during first run. This is the only cloud call first run makes beyond the API-key check, it is spent solely on an
 * explicit click, and it changes nothing on disk: a successful validation stages the pair in memory, and the submit below is what commits it.
 *
 * Staging rather than writing is what makes the button's meaning honest. The pair that gets committed is the pair the cloud confirmed, so a user who validates and
 * then edits a field cannot end up with an unchecked credential written as though it had been checked - the edit handlers below clear the staged pair.
 *
 * The validation begins before the empty-field check here, the reverse of the API key handler's order, so a press with a field left empty retires any account
 * validation still in flight and clears the staged pair before it reports the missing field, and it does so without locking the button.
 */
const onValidateV2 = async () => {

  const button = document.getElementById("validateV2");
  const username = document.getElementById("hydrawiseUsername").value;
  const password = document.getElementById("hydrawisePassword").value;

  // Anything already staged is stale the moment a new validation starts, so it is cleared before the call rather than after it - a call that never resolves must
  // not leave an older result standing beside newer input. Beginning the validation is what clears it, and what hands this invocation its claim.
  const claim = validationScopes.account.begin();

  if(!username.length || !password.length) {

    renderResultRow({ id: "validateV2Result", text: "Enter both your Hydrawise username and password.", tone: "text-danger" });

    return;
  }

  button.disabled = true;

  try {

    const { result: outcome } = await homebridge.request("/loginV2", { password, username });

    /* Neither a verdict nor a staged pair lands unless this invocation's claim is still current, and that check is what makes the button's meaning honest across
     * the await: a user who edits either field while the call is out has retired this pair, so staging it here would commit a login the cloud confirmed for input
     * that has since left the screen. A superseded invocation discards silently - the surface has already cleared itself, and there is no wire to cancel.
     */
    if(!validationScopes.account.isCurrent(claim)) {

      return;
    }

    if(outcome !== "success") {

      renderResultRow({ id: "validateV2Result", text: outcome, tone: "text-danger" });

      return;
    }

    validatedCredentials = { password, username };

    renderResultRow({ id: "validateV2Result", text: "Your Hydrawise account login is valid.", tone: "text-success" });
  } finally {

    /* The re-enable is unconditional, superseded or not, for the reason the API key validation's own finally states: the invocation that disabled the control is
     * the only thing that can balance its own disable.
     */
    button.disabled = false;
  }
};

// A reveal toggle's accessible name, naming what the NEXT click will do rather than what the field is doing now, which is what a control announced as a button
// wants to say. The subject is the field's own plain name, so each toggle on the page announces which credential it acts on.
const revealLabel = (subject, revealed) => (revealed ? "Hide the " : "Show the ") + subject + ".";

/* Flip one masked credential between hidden and shown. Every reveal on the page comes through here: a toggle names the field it serves and the subject its
 * accessible name uses on its own data attributes, so a field gains a reveal by carrying a button in the markup rather than by growing a handler of its own. The
 * sidebar's zone dots carry their identity the same way, for the same reason.
 *
 * The field's type, the toggle's accessible name, and its pressed state describe one state between them, so they are written together and no path can move one and
 * leave the others saying something else. Nothing here touches a value or the staged pair: whether a secret is on screen right now says nothing about the
 * configuration, so the flip commits nothing and invalidates nothing.
 */
const toggleReveal = (toggle) => {

  const input = document.getElementById(toggle.dataset.reveal);
  const revealed = input.type === "password";

  input.type = revealed ? "text" : "password";
  toggle.setAttribute("aria-label", revealLabel(toggle.dataset.revealSubject, revealed));
  toggle.setAttribute("aria-pressed", revealed ? "true" : "false");
};

/* Wire the first-run validations, the credential reveals, and the edits that invalidate a verdict already on screen. Each lookup by id reaches its listener
 * through an optional chain, so a control this page's markup omits costs that control's wiring alone rather than the whole page's.
 */
document.getElementById("validateApiKey")?.addEventListener("click", () => void onValidateApiKey());
document.getElementById("validateV2")?.addEventListener("click", () => void onValidateV2());

// The edits that retire a verdict, derived from the surface declarations rather than restated here: a field earns its invalidation by being named in its surface's
// inputs, so the mapping of which field retires which validation is stated once and read everywhere.
for(const scope of Object.values(validationScopes)) {

  for(const id of scope.inputs) {

    document.getElementById(id)?.addEventListener("input", scope.invalidate);
  }
}

// Each masked credential's reveal, bound from the markup itself: a toggle declares the field it serves, so the page grows a reveal without this wiring changing.
// The query answers only toggles that exist, so these bindings need no absent-target tolerance.
for(const toggle of document.querySelectorAll("[data-reveal]")) {

  toggle.addEventListener("click", () => toggleReveal(toggle));
}

/* The bound in seconds on the whole load-time wiring below. Five seconds settles the envelope provably inside the page boot monitor's ten-second watchdog, so a
 * wiring step that hangs against an unresponsive host can never be what makes the settings panel look broken.
 */
const WIRING_DEADLINE = 5;

// The load-time wiring's own lifecycle, and the signal its cancellation points read. Aborting it is how an envelope that failed or expired tells a continuation
// still running underneath it that it must not stage anything after the fact.
const wiringController = new AbortController();

/* Wire the configuration interpreter and run the legacy-settings migration, once, at load.
 *
 * The envelope is awaited here rather than at module top, so the page's chrome and its first-run controls arm immediately instead of waiting on a bridge round
 * trip. ui.show() runs only after the envelope settles, which is the ordering that matters: the framework opens its own configuration session inside the
 * launch path that ui.show() starts, so every replica it hands to a hook - the first-run config, the options page's persist path - is read after the migration
 * has settled, and none of them can commit a pre-migration snapshot over it.
 *
 * A migration that composes a patch persists it to disk itself, without waiting for the user to press Save. Most people never open this panel to save
 * anything, so a migration that waited for one would leave a fleet split between two configuration shapes indefinitely, and the plumbing that reconciles them
 * could never retire. The write is gated on there being a patch, which is what bounds it: only a session that actually found legacy settings writes, so a
 * migrated install's every later open reads, finds nothing to do, and touches the disk not at all. The host's restart indicator therefore appears at most once
 * per install, in the single session that converts it.
 *
 * The weaker outcomes are deliberate. A save the deadline overtakes, and a save the host rejects, both leave the migration sitting in the modal's pending
 * configuration, where the user's own Save picks it up.
 *
 * Reopening the panel is convergent rather than racing. Each open runs a fresh copy of this module in a fresh frame, with wiring of its own, but a second open
 * reads the saved configuration, finds no legacy keys in it, and so composes nothing and writes nothing. Two genuinely simultaneous wirings read the same
 * configuration and compose identical patches, so either ordering of their commits and saves leaves the same disk state. The sidebar's refresh handler reads
 * the interpreter too, and it cannot outrun the envelope: the framework builds that action inside ui.show(), which this module reaches only once the envelope
 * has settled, so what the handler reads is always whatever the wiring left behind.
 *
 * One bound stated honestly: the check before the commit is the last cancellation point. A commit whose bridge round trip is already in flight cannot be
 * recalled - the session takes no signal, and the deadline bounds only the await - so an envelope that expires during that round trip still lands its commit,
 * and only the save after it is skipped.
 *
 * When the envelope fails, the interpreter settles at whatever the wiring reached. A catalog fetch that never succeeded leaves the degraded-mode interpreter in
 * place, which reads through the engine over the account declaration and writes the key to its legacy property, so the page still loads and first run still
 * works; a migration that stumbled after the catalog arrived keeps the catalog-backed interpreter, because one failed attempt is no reason to degrade every read
 * for the session. The migration itself simply waits for a session whose fetches succeed.
 */
const wireHydrawiseConfig = async () => {

  hydrawiseConfig = makeHydrawiseConfig({ FeatureOptions, catalog: await getCatalog() });

  // The library's session is the single conduit the framework's own writes use, so the patch merges onto a replica synced just now rather than onto a snapshot
  // taken before the page opened.
  const session = await PluginConfigSession.open({ host: homebridge, name: "Hydrawise" });
  const patch = hydrawiseConfig.migrate(session.platform);

  // The signal is read immediately before the write, so an envelope that expired while the session was still opening cannot stage a patch after the fact.
  if(patch && !wiringController.signal.aborted) {

    await session.commit(patch);

    // The signal is read a second time, because the commit itself was an await and the envelope may have expired across it. A save the deadline overtakes is
    // skipped rather than forced, which leaves the migration staged for the user's own save - the weaker outcome, and the honest one.
    if(!wiringController.signal.aborted) {

      await homebridge.savePluginConfig();
    }
  }
};

try {

  await withDeadline({ promise: wireHydrawiseConfig(), seconds: WIRING_DEADLINE, signal: wiringController.signal });
} catch(error) {

  wiringController.abort(error);
}

// Display the webUI.
ui.show();
