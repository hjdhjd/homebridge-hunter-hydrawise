/* Copyright(C) 2017-2026, HJD (https://github.com/hjdhjd). All rights reserved.
 *
 * platform.ts: homebridge-hunter-hydrawise platform class.
 */
import type { API, Characteristic, DynamicPlatformPlugin, HAP, Logging, PlatformAccessory, PlatformConfig } from "homebridge";
import { APIEvent, AccessoryPersistence, FeatureOptions, MQTT_AVAILABILITY_OFFLINE, RateBudget, TimerRegistry, armDeadline, classifyTransportError,
  composeSignals, createApiDispatcher, createMqttClient, debugGatedLog, exponentialBackoff, formatErrorMessage, loopFaultReporter, mqttConnectionSettings, mqttTopic,
  notResponding, readOptionsSetting, repeatDemotedLog, retry, sanitizeName, superviseLoop, systemClock } from "homebridge-plugin-utils";
import type { Categories, Clock, HomebridgePluginLogging, MqttClient, Nullable, RepeatDemotedLog } from "homebridge-plugin-utils";
import type { CustomerDetailsResponse, HydrawiseAccessory, HydrawiseAccessoryContext, HydrawiseCommandOutcome, HydrawiseControllerAccessory,
  HydrawiseControllerConfig, HydrawiseControllerIdentity, HydrawiseEndpoint, HydrawiseZoneIdentity, SetZoneResponse } from "./types.ts";
import { HYDRAWISE_API_BASE_URL, HYDRAWISE_API_BUDGET_CALLS, HYDRAWISE_API_BUDGET_WINDOW, HYDRAWISE_API_RETRY_ATTEMPTS, HYDRAWISE_API_RETRY_INTERVAL,
  HYDRAWISE_API_RETRY_STATUS_CODES, HYDRAWISE_API_TIMEOUT, HYDRAWISE_COMMAND_BUDGET_CALLS, HYDRAWISE_COMMAND_BUDGET_WINDOW, HYDRAWISE_COMMAND_ENDPOINT,
  HYDRAWISE_REVERT_DELAY, HYDRAWISE_TRANSPORT_FAULT_SENTENCES, HYDRAWISE_V2_BACKOFF_CEILING, HYDRAWISE_V2_BACKOFF_JITTER, HYDRAWISE_V2_BUDGET_CALLS,
  HYDRAWISE_V2_BUDGET_WINDOW, HYDRAWISE_V2_REFRESH_INTERVAL, HYDRAWISE_ZONE_ACCESSORY_CATEGORY, HYDRAWISE_ZONE_ACCESSORY_GRACE_POLLS, PLATFORM_NAME,
  PLUGIN_NAME } from "./settings.ts";
import type { HydrawiseGlobalFlagOption, HydrawiseGlobalValueOption, HydrawiseOptions } from "./options.ts";
import { controllerDisplayName, controllerIdentity, isControllerIdentity, isFirmwareVersion, isZoneAccessoryContext, sameControllerIdentity, sameZoneIdentity,
  zoneAccessoryId } from "./types.ts";
import { featureOptionCategories, featureOptions } from "./options.ts";
import { request, setGlobalDispatcher } from "undici";
import type { Dispatcher } from "undici";
import { HydrawiseController } from "./controller.ts";
import { HydrawiseV2Client } from "./v2.ts";
import { STATUS_CODES } from "node:http";
import { mqttTopics } from "./mqtt.ts";
import util from "node:util";

/* Why one request to the key-based API failed, the tag the platform's request log compares with the reason it remembers: every transport kind the classifier names
 * that this plugin reports, and every status arm that refuses a response. A shutdown is not among them, because a shutdown is not news. The tags are spelled out
 * here rather than derived from the library's kinds, so a kind the library learns to name becomes a reason only once this plugin says what it means, the same
 * rule the exhaustive switch in the request holds.
 */
type HydrawiseRequestFailure = "certificate" | "connect-timeout" | "destroyed" | "dns" | "invalid-key" | "rate-limit" | "refused" | "reset" | "retries-exhausted" |
  "timeout" | "transport" | "unexpected-status" | "unreachable";

/* What one request to the key-based API came to: what the caller's read made of the response it was answered with, a shutdown or a withdrawn command, neither of
 * which is a failure, or the tag of the reason it failed beside the sentence the request logged for it. The request log classifies the request from it before it
 * releases the request's lines, retrieve() answers its caller from it, and command() turns it into the outcome a command reports.
 */
type HydrawiseRequestOutcome<T> = { status: "answered"; value: T } | { status: "aborted" } | { reason: string; status: HydrawiseRequestFailure };

/* What the read of an answered body came to, the answer retrieve() gives for every request Hydrawise answered: the parsed body, or the error the read met partway
 * through - a body that is not JSON, the request's deadline, or a shutdown. The request log counts a request whose read failed as answered and says nothing for
 * it, so the caller says what an unreadable body means.
 */
export type HydrawiseBodyRead = { body: unknown; status: "parsed" } | { error: unknown; status: "unreadable" };

// Why one fetch of the account's controller list failed, the tag discovery's list log compares with the reason it remembers: a request retrieve() could not
// answer, or a body that could not be parsed.
type HydrawiseListFailure = "unanswered" | "unreadable";

/* What one fetch of the account's controller list came to: the account it listed, a shutdown abort mid-read, which is no failure, or the tag of the reason it
 * failed. An abort and an unreadable body carry the read's own error, which the retry is handed.
 */
type HydrawiseListOutcome = { account: CustomerDetailsResponse; status: "listed" } | { error: unknown; status: "aborted" | "unreadable" } | { status: "unanswered" };

// Why one zone's promotion failed, the tag a zone's setup log compares with the reason it remembers: a fault anywhere in establishing the zone's accessory.
type HydrawiseZoneSetupFailure = "failed";

// What one zone's promotion came to: the accessory it established, or the tag of the reason it failed.
type HydrawiseZoneSetupOutcome = { accessory: HydrawiseAccessory; status: "established" } | { status: HydrawiseZoneSetupFailure };

// The reason an unreadable command reply gives, one sentence whichever way the reply could not be read, so every reader of the outcome names it in the same words.
const HYDRAWISE_UNREADABLE_REPLY = "The answer from Hydrawise could not be read.";

// Read an answered body as JSON, the read retrieve() hands its request. The read catches its own failure and answers it beside the error, so a body that fails
// partway through leaves the request answered to the request log, and the caller weighs the error.
async function readJsonBody(response: Dispatcher.ResponseData<unknown>): Promise<HydrawiseBodyRead> {

  try {

    return { body: await response.body.json(), status: "parsed" };
  } catch(error) {

    return { error, status: "unreadable" };
  }
}

/**
 * How long the account-credentialed refresh loop sleeps after a tick, given the run of consecutive throttled ticks behind it.
 *
 * A lone refusal keeps the cadence with no jitter. Hydrawise's limits are shared across the account, so at this pace a refusal more likely means another client drained
 * them, and a second refusal an interval later is what reads as a lockout. From there the sleep climbs HBPU's doubling ladder from two intervals to the ceiling, spread
 * upward by the jitter, and the ladder's attempt numbering makes the run's second tick its first rung. A sleep that long outlasts the facts lifetime, so every enhanced
 * reading falls back until a tick answers.
 *
 * @param options           - What the sleep is computed from.
 * @param options.random    - The source of the jitter, answering in the range Math.random does.
 * @param options.throttles - How many consecutive ticks Hydrawise has throttled, the one just finished included.
 *
 * @returns The sleep, in milliseconds.
 */
export function v2RefreshDelay({ random = Math.random, throttles }: { random?: () => number; throttles: number }): number {

  if(throttles < 2) {

    return HYDRAWISE_V2_REFRESH_INTERVAL * 1000;
  }

  const delay = exponentialBackoff({ ceilingMs: HYDRAWISE_V2_BACKOFF_CEILING * 1000, seedMs: HYDRAWISE_V2_REFRESH_INTERVAL * 2000 })(throttles);

  return delay + Math.round(delay * HYDRAWISE_V2_BACKOFF_JITTER * random());
}

/* The platform's injectable defaults: what a suite substitutes to run the real platform on a timeline of its own and with no broker. Homebridge constructs the
 * platform with its log, configuration and API alone, so every member takes its production default and the field never sees anything else.
 *
 * @property clock       - The one time source for every wait, deadline and time read the platform schedules. Defaults to the system clock.
 * @property mqttFactory - How the MQTT client is built, handed the broker settings HBPU's resolver answered, the platform's clock and its lifetime signal, and
 *                         called only when that resolver finds MQTT on. Defaults to HBPU's guarded factory, which answers null for a broker URL the client
 *                         cannot parse.
 */
export interface HydrawisePlatformDefaults {

  clock?: Clock;
  mqttFactory?: typeof createMqttClient;
}

export class HydrawisePlatform implements DynamicPlatformPlugin {

  private readonly accessories: HydrawiseAccessory[];
  private account: CustomerDetailsResponse;
  private readonly accountBudget: RateBudget;
  public readonly api: API;

  /* The one time source for every wait, deadline and time read this plugin schedules: the budgets, the timers, every request deadline, the stamps every controller
   * puts on its account facts and its commands, and the present moment its log lines date an instant against. It is the system clock in the field and the clock a
   * suite hands the constructor, so a suite drives the platform's cadences and deadlines on a virtual timeline of its own.
   */
  public readonly clock: Clock;
  private readonly commandBudget: RateBudget;
  private dispatcher?: Dispatcher;
  public readonly featureOptions: FeatureOptions;
  public config: HydrawiseOptions;
  public readonly configuredDevices: Record<string, HydrawiseController | undefined>;
  public readonly hap: HAP;
  public readonly log: HomebridgePluginLogging;
  public readonly mqtt: Nullable<MqttClient>;

  /* The one path every change to what Homebridge's accessory cache holds for this plugin's accessories takes: each change marks its accessory where it is made,
   * and every accessory marked within one save window reaches the cache in a single write, while a removal goes through its unregister so no pending save can
   * return the accessory to the cache. Registration stays Homebridge's own call, which writes the cache itself.
   */
  public readonly persistence: AccessoryPersistence;

  /* The request log: how every request to the key-based API reports its failure. One adapter serves the platform's whole life, so a failure is reported in full
   * the first time, at debug for as long as the same reason holds, and in full again once the reason changes or a request succeeds in between. A reader at debug
   * still sees every failure.
   *
   * The attempt is the whole request, because request() is the one path every call to the key-based API takes - discovery and each controller's poll through
   * retrieve(), and each command through command() - so one adapter covers every failure class it classifies, a revoked key, a reached rate limit, a dead host and
   * a stalled request alike, with no bookkeeping at any caller. Requests that overlap share the adapter's one remembered reason, as the library states: the last
   * request to settle is what the next is weighed against, so a controller meeting the failure another controller's request has just reported reads it at debug,
   * and a request failing for a different reason is reported in full.
   */
  private readonly requestFailures: RepeatDemotedLog<HydrawiseRequestFailure>;
  private readonly shutdownController: AbortController;
  public readonly signal: AbortSignal;
  public readonly timers: TimerRegistry;
  private readonly v2Budget: RateBudget;
  private readonly v2Client?: HydrawiseV2Client;

  /* Everything shutdown has to undo, declared in one place and disposed in one call. A DisposableStack runs its registered work in reverse registration order, so
   * the ordering teardown depends on is expressed by the order things are registered rather than by a handler body that has to be read to be trusted, and the
   * order and the work stay together at each registration site.
   *
   * The SYNCHRONOUS variant, deliberately: every teardown this platform registers completes synchronously, so the stack disposes whole within one frame, and the
   * asynchronous stack would insert a microtask gap between disposers and buy nothing in return. Shutdown's wait for the MQTT client's end, which states each
   * controller's final word, comes before the stack disposes rather than inside it, so the stack itself never waits. The class is reached as a platform global,
   * which the entry point's polyfill import guarantees exists on every runtime this package supports.
   */
  private readonly teardown = new DisposableStack();

  /* The serial of every controller accessory Homebridge restored from its cache this run, the set the unconfigured availability statement is drawn from. It is a
   * record of what was restored rather than a read of the tracked array, because discovery removes a disabled or orphaned controller's accessory from that array
   * while its retained word still has to be stated on every broker session for the rest of the run.
   */
  private readonly restoredSerials = new Set<string>();

  /* Whether the recurring account-credentialed refresh loop has been started. Discovery is re-enterable - a second DID_FINISH_LAUNCHING runs it again, and the
   * supervisor can re-enter it - while the loop it starts runs for the life of the plugin, so exactly one is ever wanted. The flag is raised before the loop is
   * dispatched rather than after it, so a re-entry arriving while the first tick is still in flight cannot start a second.
   */
  private v2RefreshStarted = false;

  /* Whether the account-credentialed API has answered successfully at least once this session. It gates a single connection line, which is the account tier's
   * counterpart to the key-based one discovery logs: the constructor's line says the credentials were CONFIGURED, and this one says they actually work. Reporting
   * it on the first successful answer rather than at construction is what makes it a connection report instead of a restatement of the configuration.
   */
  private v2Connected = false;

  // The run of consecutive refresh ticks Hydrawise throttled, which paces the sleep after each tick. Any other tick ends the run, an answered one and a failed one
  // alike, because only a 429 is Hydrawise asking the plugin to slow down. It lives in memory only, so a restart begins again at the plain cadence.
  private v2Throttles = 0;

  /* The wire-absence grace state behind reconcileZoneAccessories, keyed by zone-accessory UUID and holding that accessory's count of consecutive polls whose report
   * omitted its zone. It lives in memory only and is deliberately not persisted: a restart clears it, which errs toward RETAINING a HomeKit identity the user
   * placed in a room rather than toward destroying one, and the count rebuilds from the next few polls at no cost.
   */
  private readonly zoneAccessoryGrace = new Map<string, number>();

  /* The setup log of each standalone zone accessory, keyed by zone-accessory UUID beside the grace state above: how a zone's promotion reports the fault that kept
   * it from being established. Each zone holds its own, so a failure is reported in full the first time, at debug for as long as that zone keeps failing, and in
   * full again after a successful attempt, which closes the episode, and a healthy zone established beside a failing one never resets that zone's episode. An
   * entry lives as long as its accessory: wherever a zone accessory goes away, its entry is cleared with its grace entry through clearZoneAccessoryState(), so a
   * zone removed and promoted again starts a fresh episode, while the entry of a zone that never gets an accessory stays until a restart. Like the grace state
   * it lives in memory only, so a restart begins every episode fresh. The reconcile walks its zones in sequence, so a zone's attempts never overlap on its adapter.
   */
  private readonly zoneSetupFailures = new Map<string, RepeatDemotedLog<HydrawiseZoneSetupFailure>>();

  constructor(log: Logging, config: PlatformConfig | undefined, api: API, { clock = systemClock, mqttFactory = createMqttClient }: HydrawisePlatformDefaults = {}) {

    this.accessories = [];
    this.account = {} as CustomerDetailsResponse;
    this.api = api;
    this.clock = clock;
    this.configuredDevices = {};

    /* PlatformConfig exposes user values through an any-typed index signature, so we read each value through a bracket-access cast to its declared type and keep
     * the reads type-checked rather than any. The options setting is read through HBPU's reader instead: it is the typed read an untyped setting needs before it
     * reaches the engine's string[] parameter, and the engine applies the same rule to whatever it is handed.
     */
    this.featureOptions = new FeatureOptions(featureOptionCategories, featureOptions, readOptionsSetting(config?.["options"]));
    this.hap = api.hap;

    /* Wrap the Homebridge logger in the library's config-gated composition: our debug output emits through warn - visible without Homebridge's own debug switch -
     * whenever the user's debug setting says so, read live on every call, and every other level passes straight through. Wrapping rather than mutating leaves the
     * logger Homebridge handed us untouched, and that object stays Homebridge's own.
     */
    this.log = debugGatedLog(log, (): boolean => this.config.debug === true);

    // The request log is built over the gated logger, so a repeat demoted to debug meets the user's debug setting exactly as every other debug line does.
    this.requestFailures = repeatDemotedLog<HydrawiseRequestFailure>(this.log);

    this.mqtt = null;

    // Scope an AbortController to the platform's lifetime. We assign it and its signal at the top of the constructor, before the missing-API-key early return below,
    // because strict definite-assignment checking requires every constructor path to initialize these readonly fields. Aborting the controller on Homebridge shutdown
    // tears down every signal-aware resource we own through one composed signal.
    this.shutdownController = new AbortController();
    this.signal = this.shutdownController.signal;

    /* Make the ceilings this plugin honors structural rather than advisory. Each window is stated in seconds by its own constant and converted to the milliseconds a
     * RateBudget takes right here, so the conversion sits once, immediately beside the constant it applies to. Every budget carries the platform's shutdown signal,
     * so a caller still waiting for a slot when Homebridge stops is rejected rather than left pending forever. Construction schedules nothing, so they are built
     * here alongside the signal, ahead of the missing-API-key return below that leaves the rest of the platform unbuilt.
     *
     * The account-wide and zone-command budgets make the ceilings Hydrawise publishes for its key-based API enforceable, and every command a user sends draws both,
     * a per-zone suspension included. The account-credentialed budget is an envelope instead, because that API publishes no ceiling at all and throttles hard, and
     * the scheduled reads and the token grants they carry are all it paces.
     */
    this.accountBudget = new RateBudget({ capacity: HYDRAWISE_API_BUDGET_CALLS, clock: this.clock, signal: this.signal,
      window: HYDRAWISE_API_BUDGET_WINDOW * 1000 });
    this.commandBudget = new RateBudget({ capacity: HYDRAWISE_COMMAND_BUDGET_CALLS, clock: this.clock, signal: this.signal,
      window: HYDRAWISE_COMMAND_BUDGET_WINDOW * 1000 });
    this.v2Budget = new RateBudget({ capacity: HYDRAWISE_V2_BUDGET_CALLS, clock: this.clock, signal: this.signal, window: HYDRAWISE_V2_BUDGET_WINDOW * 1000 });

    // The one home for every deferred HomeKit write this plugin arms, shared by every controller the platform builds. Construction schedules nothing, so it is
    // built here beside the budgets, ahead of the missing-API-key return below. Its lifetime IS the shutdown signal - the abort drains whatever is pending and
    // leaves every later registration inert - so it takes no teardown-stack registration of its own, on the same terms as the MQTT client below.
    this.timers = new TimerRegistry({ clock: this.clock, signal: this.signal });

    // The accessory cache's save path, built here beside the registry for the same reason: construction arms no timer, and the helper subscribes to Homebridge's
    // shutdown itself to save whatever is waiting, so it takes no teardown-stack registration of its own.
    this.persistence = new AccessoryPersistence({ api, clock: this.clock, platformName: PLATFORM_NAME, pluginIdentifier: PLUGIN_NAME });

    /* Assemble the effective configuration. This is where a raw configuration property and a configured feature option meet for every setting the platform
     * carries: each resolves through the engine's one precedence here - an explicitly configured option rules in every state it can be in, a legacy
     * configuration property otherwise outranks the catalog default, and the default closes the chain - so no reader downstream has to know that a setting can
     * live in its option or in a legacy property. The MQTT broker URL and topic prefix are carried nowhere: HBPU's resolver reads them by the same precedence at
     * the client's construction below. The legacy arm is transitional and sunsets at the plugin's next major version, at which point the option is the only home
     * a setting has.
     *
     * The engine takes any option name, so each read states its name against the catalog's global unions through `satisfies`, which keeps a misspelled or
     * wrongly scoped name a compile error. A legacy property keeps this file's bracket-access cast posture, and a non-string smuggled past that cast by a
     * hand-edited configuration degrades safely: the API key gate reads it as no key.
     */
    this.config = {

      apiKey: this.featureOptions.consolidatedValue({ fallback: config?.["apiKey"] as string | undefined,
        option: "Account.ApiKey" satisfies HydrawiseGlobalValueOption }) ?? "",
      debug: this.featureOptions.consolidatedFlag({ fallback: (typeof config?.["debug"] === "boolean") ? config["debug"] : undefined,
        option: "Log.Debug" satisfies HydrawiseGlobalFlagOption }),

      // The account credentials have no legacy configuration property of their own, so they resolve from the feature option alone and their reads carry no
      // fallback.
      password: this.featureOptions.consolidatedValue({ option: "Account.Password" satisfies HydrawiseGlobalValueOption }),
      username: this.featureOptions.consolidatedValue({ option: "Account.Username" satisfies HydrawiseGlobalValueOption })
    };

    // No Hydrawise API key, we're done.
    if(!this.config.apiKey.length) {

      this.log.error("Unable to startup: no Hunter Hydrawise API key has been configured. Please configure one and restart the plugin.");

      return;
    }

    this.initNetworking();

    /* Build the optional account-credentialed client, and only when BOTH credentials are configured. The gate is an AND rather than an OR because a grant needs the
     * pair: half a login cannot authenticate, so building a client on one of them would spend calls failing. With no client there is no second connection pool, no
     * token grant, and no enhanced-features call of any kind - the plugin runs exactly as it does for a user who has configured nothing but an API key.
     */
    if(this.config.username?.length && this.config.password?.length) {

      this.v2Client = new HydrawiseV2Client({ budget: this.v2Budget, clock: this.clock, log: this.log, password: this.config.password, signal: this.signal,
        username: this.config.username });

      this.log.info("Enhanced features are enabled using your Hydrawise account login.");
    }

    /* Initialize MQTT, if needed. HBPU's resolver and the platform's MQTT factory, HBPU's guarded factory in the field, each answer for a way MQTT can fail to
     * start, and each lands on the same degradation - MQTT stays off and the rest of the plugin loads. The resolver answers null when no broker is configured
     * anywhere, or the user turned an option off or enabled it without a value. Each legacy property reaches it as text or as unset, and it reads a blank topic
     * as unset too, so a legacy topic that is blank or not text leaves the catalog's default prefix to answer beside a configured broker. The guarded factory
     * answers null for a URL the client cannot parse, reporting that once at error level with the URL redacted so a broker password embedded in it never reaches
     * the log. The platform's shutdown signal ties the client's lifetime to ours, and the platform's clock is the one the end's grace waits on, as every other
     * wait we schedule.
     */
    const mqttSettings = mqttConnectionSettings({ config: { mqttTopic: (typeof config?.["mqttTopic"] === "string") ? config["mqttTopic"] : undefined,
      mqttUrl: (typeof config?.["mqttUrl"] === "string") ? config["mqttUrl"] : undefined }, featureOptions: this.featureOptions });

    this.mqtt = mqttSettings && mqttFactory({ ...mqttSettings, log: this.log }, { clock: this.clock, signal: this.signal });

    // On every broker session, state each restored controller this run has not built as unreachable. The client's lifetime is the platform's, so the registration
    // carries no signal of its own.
    this.mqtt?.onConnect(() => this.publishUnconfiguredAvailability());

    this.log.debug("Debug logging on. Expect a lot of data.");

    // Fire up the Hydrawise API once Homebridge has loaded all the cached accessories it knows about and called configureAccessory() on each. We supervise the
    // discovery loop so a genuine configuration fault surfaces once through the reporter, while a shutdown abort unwinds it silently.
    api.on(APIEvent.DID_FINISH_LAUNCHING, () => void superviseLoop({ loop: () => this.configureHydrawise(), onError: loopFaultReporter(this.log, "controller discovery"),
      signal: this.signal }));

    /* Tear ourselves down cleanly when Homebridge shuts down, through the method that owns platform shutdown: it ends the MQTT client first, which states each
     * controller's final word, and disposes the teardown stack after the words are written. The end precedes the stack because the stack's first act is the
     * abort, which ends the MQTT connection by destroying its socket, and a word still unwritten when that happens is lost.
     */
    api.on(APIEvent.SHUTDOWN, () => void this.shutdown());

    /* Register that teardown work last, once everything it undoes has actually been built. Disposal is reverse registration order, so the dispatcher destroys named
     * first here run LAST and the signal abort named last runs FIRST: the abort cancels every signal-aware resource we own - the MQTT client, the retry waits, the
     * polling loops, the rate-budget waits - and the destroys then close the keep-alive Pool connections so they do not outlive us.
     *
     * Each dispatcher is read live at disposal time rather than captured here, which keeps these registrations correct across the destroy-and-rearm each transport
     * performs when a request times out. The v2 client registers only its dispatcher, because that pool is the whole of what it holds: its token renewal is lazy, so
     * there is no timer to drain. The MQTT client gets no registration of its own: shutdown ends it before the stack disposes, and its lifetime is the composed
     * shutdown signal the abort ends besides, so registering it here would tear it down a second time.
     */
    this.teardown.defer(() => void this.dispatcher?.destroy());
    this.teardown.defer(() => void this.v2Client?.dispatcher.destroy());
    this.teardown.defer(() => this.shutdownController.abort("shutdown"));
  }

  /* This gets called when homebridge restores cached accessories at startup. Every restored accessory is tracked for discovery to claim, a controller accessory's
   * serial is recorded for the availability statement below, its persisted firmware version is put back on display, and the accessory's primary characteristics
   * refuse at once: nothing in this run has reached Hydrawise yet, so the values the cache restored are ones the plugin cannot vouch for. Everything else waits for
   * Hydrawise API enumeration.
   */
  public configureAccessory(accessory: HydrawiseAccessory): void {

    this.accessories.push(accessory);

    const context = accessory.context;

    if(!isZoneAccessoryContext(context) && isControllerIdentity(context.controller)) {

      this.restoredSerials.add(context.controller.serialNumber);
    }

    this.restoreFirmware(accessory);
    this.bindPrimary(accessory);
  }

  /* Write the firmware version a controller accessory's context carries in place of the placeholder Homebridge stamps on its FirmwareRevision. Homebridge writes "0"
   * there on every restored accessory and then calls configureAccessory, naming that call as the plugin's chance to override it, so the characteristic cannot
   * carry the version across a restart and the context does. The write belongs here because this is the window Homebridge provides: it runs before any controller
   * exists and before the accessory joins the bridge, so HomeKit never sees the placeholder on an accessory whose version is known.
   *
   * It writes only while the account credentials are configured, because only then is the persisted version one a refresh is on its way to confirm. Without them
   * the version is a stale fact nothing will ever update, the placeholder stands, and the controller clears the context's copy when it configures the accessory.
   * A missing or malformed version writes nothing, and a zone accessory never reaches the write, because the context predicate classifies a context carrying a
   * version as a controller's.
   */
  private restoreFirmware(accessory: HydrawiseAccessory): void {

    const firmware = accessory.context.firmware;

    if(!this.hasV2Client || !isFirmwareVersion(firmware)) {

      return;
    }

    accessory.getService(this.hap.Service.AccessoryInformation)?.updateCharacteristic(this.hap.Characteristic.FirmwareRevision, firmware);
  }

  /** The Not Responding rule for one cached accessory, as its restore-time handlers read it: the accessory refuses while the controller that owns it cannot vouch
   * for it, and while no controller has claimed it at all. The owner's UUID is derived once, here, from the accessory's cached identity - its own UUID for a
   * controller accessory, and its owner's for a zone accessory, as configuredController derives it - so a read never hashes an identity again.
   *
   * @param accessory - The cached accessory whose handlers the rule wraps.
   *
   * @returns The wrapper the accessory's handlers are bound through.
   */
  public answeringFor(accessory: HydrawiseAccessory): ReturnType<typeof notResponding> {

    const context = accessory.context;
    const owner = isZoneAccessoryContext(context) ? this.hap.uuid.generate(context.ownerController.controllerId.toString()) : accessory.UUID;

    return notResponding({ errorClass: this.hap.HapStatusError, unavailable: () => this.isUnavailable({ accessory, owner }) });
  }

  /* Whether a cached accessory refuses: whatever the controller built under its owner's UUID answers for it, and unavailable when none is built there. That covers
   * the window before discovery, a revoked key that keeps discovery from completing, and a context that names no controller this run builds, a malformed one
   * included, since its own UUID is no controller's.
   */
  private isUnavailable({ accessory, owner }: { accessory: HydrawiseAccessory; owner: string }): boolean {

    return this.configuredDevices[owner]?.unavailableFor(accessory) ?? true;
  }

  /* Bind the refusal on a cached accessory's primary characteristics, the moment Homebridge restores it. HomeKit renders a whole accessory as not responding when
   * one characteristic refuses, so a controller accessory answers through its irrigation system's Active and a zone accessory through its valve's. Every cached
   * valve and every cached suspension switch is bound for writes as well, so a run or a suspension HomeKit asks of a cached service before its controller has
   * reached Hydrawise is refused rather than accepted and lost. Each service is located by type and skipped when the cache holds none.
   *
   * The controller binds its own handlers over these as it configures each service, and HAP keeps only the latest binding, so these stand only until then. The
   * platform touches nothing else on a service: what exists on an accessory stays the controller's business.
   */
  private bindPrimary(accessory: HydrawiseAccessory): void {

    const answering = this.answeringFor(accessory);
    const valves = accessory.services.filter(service => service.UUID === this.hap.Service.Valve.UUID);
    const switches = accessory.services.filter(service => service.UUID === this.hap.Service.Switch.UUID);

    for(const zoneSwitch of switches) {

      this.bindStoredValue({ answering, characteristic: zoneSwitch.getCharacteristic(this.hap.Characteristic.On), read: false });
    }

    if(isZoneAccessoryContext(accessory.context)) {

      for(const valve of valves) {

        this.bindStoredValue({ answering, characteristic: valve.getCharacteristic(this.hap.Characteristic.Active), read: true });
      }

      return;
    }

    const irrigation = accessory.getService(this.hap.Service.IrrigationSystem);

    if(irrigation) {

      this.bindStoredValue({ answering, characteristic: irrigation.getCharacteristic(this.hap.Characteristic.Active), read: true });
    }

    for(const valve of valves) {

      this.bindStoredValue({ answering, characteristic: valve.getCharacteristic(this.hap.Characteristic.Active), read: false });
    }
  }

  /* Bind one characteristic's restore-time handlers through its accessory's rule. While the rule answers available - a claimed accessory whose controller vouches
   * for it, before the controller has bound its own handlers - a read answers the stored value, and a write is accepted and the stored value put back after a beat
   * through the platform's registry, because nothing here can carry a command to Hydrawise.
   *
   * @param options                - The binding.
   * @param options.answering      - The accessory's Not Responding rule.
   * @param options.characteristic - The characteristic to bind.
   * @param options.read           - Whether reads are bound too, which they are on the characteristic HomeKit reads the accessory's availability from.
   */
  private bindStoredValue({ answering, characteristic, read }: { answering: ReturnType<typeof notResponding>; characteristic: Characteristic;
    read: boolean; }): void {

    if(read) {

      characteristic.onGet(answering(() => characteristic.value));
    }

    characteristic.onSet(answering((): void => {

      const stored = characteristic.value;

      this.timers.schedule(() => characteristic.updateValue(stored), HYDRAWISE_REVERT_DELAY);
    }));
  }

  /* The platform's availability statement for the controllers it does not run: a retained offline for every controller restored from the cache this run that the
   * platform has not built. A controller this run has not built cannot be reached, and nothing else speaks for it...a built controller states its own availability
   * while it runs and its own offline as the plugin stops, so this statement and the controllers' own cover disjoint serials. It runs on every broker session and
   * once more when discovery has settled which controllers it builds.
   */
  private publishUnconfiguredAvailability(): void {

    const built = new Set(Object.values(this.configuredDevices).map(controller => controller?.controller.serial_number));

    for(const serial of this.restoredSerials) {

      if(!built.has(serial)) {

        this.mqtt?.publishGuarded(mqttTopic(serial, mqttTopics.availability.topic), MQTT_AVAILABILITY_OFFLINE, { retain: true });
      }
    }
  }

  /** Shut the platform down: end the MQTT client, which states each controller this run built offline on its own availability topic, and then dispose the
   * teardown stack, which aborts the lifetime signal first and closes the connection pools after it. The end comes before the abort because the abort ends the
   * MQTT connection by destroying its socket, which drops a write not yet flushed, so a word issued alongside the teardown would be lost and the broker would keep
   * each controller's last word for a plugin that has stopped. The end waits for the words within its own grace and hands them to the socket before it tears the
   * client down, and it never rejects, so a broker that never takes a write delays the teardown by that beat at most, and the teardown always runs.
   *
   * @returns A promise that resolves once the teardown stack has disposed, and never rejects.
   */
  public async shutdown(): Promise<void> {

    await this.mqtt?.end();

    this.teardown.dispose();
  }

  // Configure and connect to the Hydrawise API.
  private async configureHydrawise(): Promise<void> {

    /* Retrieve the account's controllers, retrying forever at a fixed 60-second cadence against the rate-limited API. The retried operation covers only the
     * network truth - the request and the JSON parse - and throws on any failure so retry loops; a resolved value is a successful fetch. Everything downstream
     * runs once, outside the retry, so a genuine configuration fault escapes to the supervisor's reporter rather than becoming a silent 60-second retry.
     *
     * Each fetch runs as one attempt of discovery's list log, which this pass builds and its retries share, so an unreadable list is reported in full the first
     * time and at debug for as long as it repeats. The adapter lives for this one pass, and the pass's attempts run in sequence, so none overlap. The failure
     * is thrown after the attempt rather than inside it, because a throw inside an attempt leaves it unclassified and its lines at their own levels.
     */
    const listFailures = repeatDemotedLog<HydrawiseListFailure>(this.log);

    this.account = await retry(async (): Promise<CustomerDetailsResponse> => {

      const outcome = await listFailures.attempt(async (log): Promise<HydrawiseListOutcome> => this.attemptControllerList(log),
        (result): HydrawiseListFailure | undefined => (((result.status === "aborted") || (result.status === "listed")) ? undefined : result.status));

      switch(outcome.status) {

        case "listed":

          return outcome.account;

        // A null response is either a recoverable API error retrieve() already logged, or a shutdown abort it left silent. Throw so retry waits and tries again.
        case "unanswered":

          throw new Error("Unable to retrieve the list of controllers.");

        // The read's own error, rethrown: quietly for a shutdown abort mid-read, so the retry loop unwinds through its own signal, and once reported for an
        // unreadable list, so retry waits and tries again.
        case "aborted":
        case "unreadable":

          throw outcome.error;
      }
    }, { attempts: Infinity, backoff: (): number => HYDRAWISE_API_RETRY_INTERVAL * 1000, clock: this.clock, signal: this.signal });

    this.log.info("Successfully connected to the Hydrawise API using your API key.");

    this.log.debug(util.inspect(this.account, { colors: true, depth: null, sorted: true }));

    // Trim whitespace off each controller's wire-reported name here, once, so every downstream name comparison and the persisted identity roster this feeds
    // compare cleanly against a value Hydrawise itself may pad.
    this.account.controllers = this.account.controllers.map(x => ({ ...x, name: x.name.trim() }));

    // Map the trimmed account to the persisted controller-identity shape once, so every controller we configure seeds the same denormalized roster into its accessory
    // context - each accessory then knows every sibling, enabled or not, which is what lets the webUI list the whole account from any one accessory with no cloud call.
    const roster: HydrawiseControllerIdentity[] = this.account.controllers.map(controller => controllerIdentity(controller));

    for(const controller of this.account.controllers) {

      this.log.info("Discovered irrigation controller: %s (serial: %s id: %s).", controller.name, controller.serial_number, controller.controller_id);

      this.configureController(controller, roster);
    }

    // Start the recurring account-credentialed refresh, if the user has configured the credentials that make it possible. Every controller is already built by this
    // point, so the loop's first tick has somewhere to deliver every controller's facts.
    this.startV2Refresh();

    // Find all the orphaned accessories this account does not claim and remove them, clearing whatever state the reconcile kept for a removed accessory. We walk
    // a filtered SNAPSHOT of the tracked array so the removal splice never races the walk that drives it.
    for(const accessory of this.accessories.filter(entry => this.isOrphanedAccessory(entry))) {

      this.clearZoneAccessoryState(accessory.UUID);
      this.removeAccessory(accessory);
    }

    // Discovery has settled which controllers this run builds, so state every restored controller it left unbuilt - a disabled one, and one the account has
    // dropped - as unreachable on the session already held, rather than waiting for the next one.
    this.publishUnconfiguredAvailability();
  }

  /* One fetch of the account's controller list, as discovery's list log runs it: the request, whose body retrieve() reads inside the request's deadline, and what
   * that read came to, answering what the fetch came to. Every line it writes goes through the logger the attempt hands in.
   */
  private async attemptControllerList(log: HomebridgePluginLogging): Promise<HydrawiseListOutcome> {

    const answer = await this.retrieve("customerdetails.php");

    if(!answer) {

      return { status: "unanswered" };
    }

    if(answer.status === "parsed") {

      return { account: answer.body as CustomerDetailsResponse, status: "listed" };
    }

    // A shutdown abort mid-read is orderly teardown - answer it quietly so the retry loop unwinds through its own signal without logging a spurious parse failure.
    if(this.signal.aborted) {

      return { error: answer.error, status: "aborted" };
    }

    log.error("Unable to retrieve the list of controllers: %s.", formatErrorMessage(answer.error));

    return { error: answer.error, status: "unreadable" };
  }

  /* Start the endless loop that refreshes every controller's account-credentialed facts, once, and only for an install that configured the credentials making it
   * possible. Without a client no loop starts, no call is spent, and nothing is logged - an install carrying only an API key behaves exactly as it always has.
   *
   * One query for the whole account rather than one per controller is what the v2 ceiling demands - it admits a handful of calls per half hour, so a per-controller
   * query would spend the whole allowance on a multi-controller install - and it is also the shape v1 discovery already uses: fetch the account once, then hand
   * each controller its own share.
   *
   * The loop is SEQUENTIAL - refresh, then sleep - which is what makes overlap unrepresentable rather than guarded against: the next tick cannot begin until the
   * current one has finished, however long the account takes to answer. Each sleep is the one its tick answers, the plain cadence until Hydrawise keeps throttling
   * the refresh. The loop is supervised on the same terms as every other endless loop this plugin runs, so a shutdown abort unwinds it silently through the sleep
   * while a genuine fault is reported once. The narrowed client is captured in a local before dispatch so the loop body needs no assertion about a field it cannot
   * see reassigned.
   */
  private startV2Refresh(): void {

    if(!this.v2Client || this.v2RefreshStarted) {

      return;
    }

    this.v2RefreshStarted = true;

    const client = this.v2Client;

    void superviseLoop({ loop: async (): Promise<void> => {

      for(;;) {

        // eslint-disable-next-line no-await-in-loop
        const delay = await this.refreshV2Facts(client);

        // eslint-disable-next-line no-await-in-loop
        await this.clock.delay(delay, { signal: this.signal });
      }
    }, onError: loopFaultReporter(this.log, "enhanced features refresh"), signal: this.signal });
  }

  /* Run one refresh tick: fetch the whole account's facts and hand each controller its own.
   *
   * This is its own method rather than the loop's inline body, and the boundary is what makes an early return safe. A return here ends this TICK, control falls
   * through to the loop's sleep, and the next tick retries; the same return written inline in the loop would leave the loop function entirely and end the refresh
   * for the life of the plugin on the first transient failure.
   *
   * The snapshot is stamped BEFORE the fetch dispatches, so it is "as of" the instant the request was made rather than the instant it landed. That is what keeps a
   * fetch already in flight when a user commands a suspend-all from reading as newer than the command it cannot possibly know about.
   *
   * A failed fetch leaves every current display standing and simply returns - the client has already reported it, and the next tick is the retry.
   *
   * Every tick answers how long the loop sleeps before the next one, read from the run of consecutive throttled ticks this one has just extended or ended.
   */
  private async refreshV2Facts(client: HydrawiseV2Client): Promise<number> {

    const fetchedAt = Math.floor(this.clock.now() / 1000);
    const read = await client.fetchAccountFacts();

    this.v2Throttles = (read.status === "throttled") ? (this.v2Throttles + 1) : 0;

    const delay = v2RefreshDelay({ throttles: this.v2Throttles });

    if(read.status !== "answered") {

      return delay;
    }

    const { facts } = read;

    // Report the account tier reachable, once for the life of the process. A failed tick says nothing here - the client has already reported the failure in its
    // own words - so this line means the credentials were accepted and the account answered, which is exactly what a user checking their setup wants to see.
    if(!this.v2Connected) {

      this.v2Connected = true;

      this.log.info("Successfully connected to the Hydrawise account API for enhanced features.");
    }

    /* Hand each controller its own facts, matched on the id v2 and v1 agree about. The walk is over the account's own controller list rather than over the
     * fetched map, so a controller the user disabled, or one the account reports that this plugin never built, is simply skipped rather than looked up and
     * dropped.
     */
    for(const controller of this.account.controllers) {

      const entry = facts.get(controller.controller_id);

      if(entry) {

        this.configuredController(controller)?.applyFacts({ facts: entry, fetchedAt });
      }
    }

    /* Recompose the denormalized account roster now that every controller has this tick's facts, and hand it to each of them. A configured controller answers for
     * its own name - the account's where it has one - while a controller this plugin never built can only be described by the wire, and the roster carries both
     * kinds because the webUI lists the whole account from any one accessory. Each controller writes its copy, and marks its accessory for the save window, only
     * when that copy actually moved.
     */
    const roster = this.account.controllers.map(controller => this.configuredController(controller)?.identity ?? controllerIdentity(controller));

    for(const controller of this.account.controllers) {

      this.configuredController(controller)?.applyRoster(roster);
    }

    return delay;
  }

  // The controller this plugin built for a wire controller, or undefined for one the user disabled or that discovery never reached. The UUID derivation is the
  // controller accessory's own, stated here once so every cadence that reaches from a wire controller to its runtime object agrees on how they correlate.
  private configuredController(controller: HydrawiseControllerConfig): HydrawiseController | undefined {

    return this.configuredDevices[this.hap.uuid.generate(controller.controller_id.toString())];
  }

  /* Whether discovery should sweep an accessory away, dispatched by accessory KIND. Each kind answers to a different authority, which is the whole reason this is
   * a dispatch rather than one predicate.
   *
   * A standalone zone accessory is judged on its OWNER alone - gone from the account, or turned off by the device gate - because discovery cannot know zones at
   * all: customerdetails.php carries no relays, so the only reader that ever sees a zone roster is the poll-cadence reconcile, and zone-level staleness is that
   * reconcile's job. Attempting to re-derive zone truth here would mean guessing.
   *
   * Every other accessory is a controller accessory and keeps the existing rule: it survives only while the account still claims its generated UUID. An accessory
   * whose cached context is malformed or ambiguous fails the zone-kind predicate and is therefore judged by this controller rule - a corrupt zone accessory is
   * removed here and, if its zone is still standalone, promoted again at the next poll. That is self-healing churn, which we prefer to leaving an accessory whose
   * identity we cannot read in place.
   */
  private isOrphanedAccessory(accessory: HydrawiseAccessory): boolean {

    const context = accessory.context;

    if(isZoneAccessoryContext(context)) {

      return !this.account.controllers.some(controller => controller.controller_id === context.ownerController.controllerId) ||
        !this.isControllerEnabled(context.ownerController.serialNumber);
    }

    return !this.account.controllers.some(controller => this.hap.uuid.generate(controller.controller_id.toString()) === accessory.UUID);
  }

  /* Whether the optional account-credentialed features are available. A controller asks this to decide whether the hardware facts its accessory cache carries are
   * still worth honoring: with a client they are last-known values a refresh is already on its way to confirm, and without one they are stale facts nothing will
   * ever update again, which is why removing the credentials returns the display to the placeholder rather than leaving yesterday's answer on screen.
   */
  public get hasV2Client(): boolean {

    return this.v2Client !== undefined;
  }

  // Whether the user has left a controller enabled. The controller-wide Device gate is keyed on the serial number in the canonical controller position, with the
  // device slot left undefined, matching the runtime's hasFeature convention so the whole plugin resolves controller-scope options against one identity. Discovery
  // and the orphan sweep both ask this question, so it is asked in one place.
  private isControllerEnabled(serialNumber: string): boolean {

    return this.featureOptions.test("Device", undefined, serialNumber);
  }

  // Configure a discovered irrigation controller. The account roster is threaded through to the controller so it can seed its accessory context with every sibling's
  // identity.
  private configureController(controller: HydrawiseControllerConfig, roster: HydrawiseControllerIdentity[]): Nullable<HydrawiseController> {

    const uuid = this.hap.uuid.generate(controller.controller_id.toString());
    let accessory = this.accessories.find(x => x.UUID === uuid);

    if(!this.isControllerEnabled(controller.serial_number)) {

      if(accessory) {

        this.removeAccessory(accessory);
      }

      return null;
    }

    if(this.configuredDevices[uuid]) {

      return null;
    }

    /* The name a FRESH accessory is created under, the controller composer's answer: the user's Name option where HomeKit can carry it, the name Hydrawise reports
     * where HomeKit can carry that, and the controller word otherwise, so the mint never meets HAP's refusal of an empty name and discovery goes on to every later
     * controller. The mint says nothing about a fallback, because the controller's own services decide that warning once it is built. A cached accessory keeps
     * whatever display name it came back with, because discovery leaves a cached name to the poll's rename step, where the naming rule decides: a set Name applies
     * there, with none synchronization applies the name Hydrawise reports, and with neither the user's name stands.
     *
     * The read presents the serial and nothing else, which is the single-id rule every runtime reader of this option keeps: the option resolves at the controller
     * and the zone alike, so a read carrying a second id would answer with something written for another scope.
     */
    accessory ??= this.addAccessory(sanitizeName(controllerDisplayName({ override: this.featureOptions.value("Device.Name", controller.serial_number),
      reported: controller.name }).name), uuid);

    this.log.info("Configuring irrigation controller: %s (serial: %s id: %s).", controller.name, controller.serial_number, controller.controller_id);

    /* Add it to our list of configured devices. The controller seeds its accessory context and reconciles its services as it constructs, which runs synchronously
     * inside this call, so the one mark just below carries everything construction changed into the next save.
     *
     * The cast to the controller arm is sound by construction, and it is the one place the narrowing cannot be derived from a predicate. A controller
     * accessory's UUID is seeded from the bare controller_id above, while every zone accessory's is seeded from the `.Zone.`-infixed compound, so the
     * controller UUID space and the zone UUID space cannot collide and an accessory found or created under a controller UUID can only be a controller
     * accessory. The controller writes its own context fields one at a time, which the arm's mutable interface is what allows.
     */
    this.configuredDevices[uuid] = new HydrawiseController(this, accessory as HydrawiseControllerAccessory, controller, roster);

    this.persistence.persist(accessory);

    return this.configuredDevices[uuid];
  }

  /* The one creation path for every accessory this platform registers: construct it under its display name, register it with Homebridge, and track it. Every
   * creation cadence - discovery-time controller accessories and poll-time standalone zone accessories alike - lands here, so the registration and the tracked
   * array can never disagree about what exists. The category is optional: a controller accessory takes the PlatformAccessory constructor's own default, while a
   * zone accessory declares itself a sprinkler so the Home app renders a lone valve correctly.
   */
  private addAccessory(displayName: string, uuid: string, category?: Categories): HydrawiseAccessory {

    const accessory = new this.api.platformAccessory<HydrawiseAccessoryContext>(displayName, uuid, category);

    // Register this accessory with Homebridge and add it to the accessory array so we can track it. Registration comes first so a failed registration leaves
    // nothing in the tracked array to clean up.
    this.api.registerPlatformAccessories(PLUGIN_NAME, PLATFORM_NAME, [accessory]);
    this.accessories.push(accessory);

    return accessory;
  }

  /* Remove the accessory from HomeKit. Removal is reachable from more than one cadence, so it opens with a presence guard: an accessory that is not in the tracked
   * array must be a no-op here, because an indexOf miss would otherwise splice(-1, 1) and silently delete the LAST accessory in the array. The guard precedes the
   * log line too, so a no-op never narrates a removal that did not happen.
   */
  private removeAccessory(accessory: PlatformAccessory): void {

    const index = this.accessories.indexOf(accessory);

    if(index === -1) {

      return;
    }

    this.log.info("%s: Removing device from HomeKit.", accessory.displayName);

    // Unregister the accessory, which drops any save still pending for it and has Homebridge write its cache without it, and stop tracking it.
    this.persistence.unregister([accessory]);
    this.accessories.splice(index, 1);
  }

  /** Reconcile this controller's standalone zone accessories against one poll's truth - the single chokepoint through which every zone-accessory creation, context
   * write, and removal passes, so the platform stays the sole registrar and the accessory roster the orphan sweep reads can never fork. The controller calls it
   * once per poll and hosts each zone's valve from the map it returns, so the hosting decision and the pruning decision read one source of truth.
   *
   * The inputs are deliberately different populations, and the difference is what makes configuration intent and wire absence tellable apart. `zones` is the
   * REQUEST - one entry per zone that should be standalone right now, carrying the zone's effective display name and its wire identity. `presentRelayIds` is
   * EVERY zone the poll's report carried, before any enablement filtering. A zone the wire still reports but the request omits can only be a configuration
   * change, so it is demoted at once; a zone missing from both is a wire absence, which is graced for a few polls because a transient flake must never destroy a
   * HomeKit identity the user placed in a room.
   *
   * Every arm's cache write is strictly on-change. A demotion unregisters its accessory, which has Homebridge write its cache, while a creation or a context
   * refresh marks just its accessory for the platform's save window. A poll on which a zone is renamed on the wire marks the same accessory here and, where the
   * plugin owns the zone's name, again for the controller's own accessory-name write, and the window carries the marks as one save.
   *
   * This method never touches a service: what lands on a hosted accessory is the controller's business.
   *
   * @param options - The owning controller, the id set of every zone the poll reported, and the standalone request.
   *
   * @returns The hosting map, from relay id to accessory, carrying one entry per requested zone that exists and seeded cleanly.
   */
  public reconcileZoneAccessories({ controller, presentRelayIds, zones }: { controller: HydrawiseControllerConfig; presentRelayIds: Set<number>;
    zones: { displayName: string; identity: HydrawiseZoneIdentity }[]; }): Map<number, HydrawiseAccessory> {

    const hosts = new Map<number, HydrawiseAccessory>();
    const requestedIds = new Set(zones.map(zone => zone.identity.relayId));

    /* Derive this controller's own zone accessories, projected to the fields each arm below reads. Filtering on the owning controller id is what keeps a
     * multi-controller account isolated: another controller's zone accessories are never this call's business. The projection is a SNAPSHOT, so the removals the
     * arms perform - which splice the tracked array - never race the walk that drives them.
     */
    const owned = this.accessories.flatMap(entry => (isZoneAccessoryContext(entry.context) &&
      (entry.context.ownerController.controllerId === controller.controller_id)) ? [{ accessory: entry, relayId: entry.context.zone.relayId }] : []);

    // One pass maintains both membership and the grace state, branching on where each owned accessory's zone turns up: in the request, on the wire alone, or in
    // neither.
    for(const { accessory, relayId } of owned) {

      // REQUESTED: the zone is still standalone and still reported. Clearing its grace count here - in the arm every healthy zone visits - is what makes a
      // reappearance reset the grace window, so a later absence always counts from zero.
      if(requestedIds.has(relayId)) {

        this.zoneAccessoryGrace.delete(accessory.UUID);

        continue;
      }

      // PRESENT BUT NOT REQUESTED: the wire still reports this zone, so its absence from the request is configuration intent - the Standalone or the Device
      // option resolved off - and the demotion is immediate. The user asked for this identity change, so there is nothing to grace.
      if(presentRelayIds.has(relayId)) {

        this.demoteZoneAccessory(accessory);

        continue;
      }

      // WIRE-ABSENT: the report carried no such zone. Count the absence and hold the accessory until the count says the zone is genuinely gone rather than
      // momentarily missing.
      const absences = (this.zoneAccessoryGrace.get(accessory.UUID) ?? 0) + 1;

      if(absences < HYDRAWISE_ZONE_ACCESSORY_GRACE_POLLS) {

        this.zoneAccessoryGrace.set(accessory.UUID, absences);

        continue;
      }

      this.demoteZoneAccessory(accessory);
    }

    // Promote each requested zone, establishing its accessory when it has none and keeping its persisted identity current. Each zone's promotion runs as one
    // attempt of that zone's own setup log, and a zone whose promotion failed is left out of the hosting map for this poll.
    for(const zone of zones) {

      const uuid = this.hap.uuid.generate(zoneAccessoryId(controller.controller_id, zone.identity.relayId));
      let failures = this.zoneSetupFailures.get(uuid);

      if(!failures) {

        failures = repeatDemotedLog<HydrawiseZoneSetupFailure>(this.log);
        this.zoneSetupFailures.set(uuid, failures);
      }

      const outcome = failures.attempt((log): HydrawiseZoneSetupOutcome => this.establishZoneAccessory({ controller, log, uuid, zone }),
        (result): HydrawiseZoneSetupFailure | undefined => ((result.status === "established") ? undefined : result.status));

      if(outcome.status === "established") {

        hosts.set(zone.identity.relayId, outcome.accessory);
      }
    }

    return hosts;
  }

  /* Establish one requested zone's accessory, as the zone's setup log runs it: find or register the accessory and keep its persisted identity current, answering
   * the accessory established or the failure. Every line it writes goes through the logger the attempt hands in.
   *
   * The whole per-zone sequence sits in one try. A fault establishing one zone must never end the controller's polling loop: we report it and answer the failure,
   * which leaves the zone out of the hosting map - sending the controller's hosting back to the controller accessory for this poll - and the reconcile carries on
   * with the remaining zones. A registration that throws leaves no ghost behind, because addAccessory tracks an accessory only once Homebridge has taken it, and
   * the next poll retries. The fault is answered rather than thrown, because a throw inside the setup log's attempt leaves it unclassified.
   */
  private establishZoneAccessory({ controller, log, uuid, zone }: { controller: HydrawiseControllerConfig; log: HomebridgePluginLogging; uuid: string;
    zone: { displayName: string; identity: HydrawiseZoneIdentity }; }): HydrawiseZoneSetupOutcome {

    let accessory = this.accessories.find(entry => entry.UUID === uuid);

    try {

      if(!accessory) {

        accessory = this.addAccessory(sanitizeName(zone.displayName), uuid, HYDRAWISE_ZONE_ACCESSORY_CATEGORY);

        // A fresh accessory starts with a fresh grace window even when an earlier accessory at this UUID was removed for sustained absence, so an inherited
        // count can never truncate the new one.
        this.zoneAccessoryGrace.delete(uuid);

        log.info("%s: Added a standalone HomeKit accessory for this zone so it can be assigned to a room. Automations, scenes, and room assignments " +
          "that referenced this zone on the controller accessory must be set up again in the Home app.", zone.displayName);
      }

      /* Seed or refresh the persisted identity pair. The comparison is field-wise because both halves are freshly built projections, so a reference check would
       * differ every poll and save every poll. On any difference - or on a context that fails the kind predicate, which is how an ambiguous or corrupt cache entry
       * heals - we assign a COMPLETE fresh object rather than individual fields, which re-asserts the kinds' mutual exclusivity at every write, and then mark the
       * accessory. The mark merges nothing, because a field merge onto an ambiguous context would keep the stray fields that made it ambiguous.
       */
      // The owner stamp reads the controller's own identity where this plugin built one, so a zone accessory names its owner exactly as that owner names itself -
      // the account's full name included. The wire projection is the floor for a controller no runtime object answers for.
      const ownerController = this.configuredController(controller)?.identity ?? controllerIdentity(controller);
      const context = accessory.context;

      if(!isZoneAccessoryContext(context) || !sameControllerIdentity(context.ownerController, ownerController) ||
        !sameZoneIdentity(context.zone, zone.identity)) {

        accessory.context = { ownerController, zone: zone.identity };
        this.persistence.persist(accessory);
      }

      return { accessory, status: "established" };
    } catch(error) {

      log.error("%s: Unable to establish a standalone accessory for this zone: %s.", zone.displayName, formatErrorMessage(error));

      return { status: "failed" };
    }
  }

  // Clear what the reconcile keeps for one zone accessory: its wire-absence count and its setup log. Every site where a zone accessory goes away clears its
  // entries there, through here, so no zone accessory that goes away leaves an entry behind, and a zone removed and promoted again starts a fresh grace window
  // and setup episode.
  private clearZoneAccessoryState(uuid: string): void {

    this.zoneAccessoryGrace.delete(uuid);
    this.zoneSetupFailures.delete(uuid);
  }

  // Remove one standalone zone accessory and clear the state the reconcile kept for it, so neither map holds an entry for an accessory that is gone. The removal
  // itself narrates through removeAccessory; the line here carries what the user has to act on, since a HomeKit identity is going away.
  private demoteZoneAccessory(accessory: HydrawiseAccessory): void {

    this.removeAccessory(accessory);
    this.clearZoneAccessoryState(accessory.UUID);

    this.log.info("%s: Automations, scenes, and room assignments that referenced this zone's standalone accessory must be set up again in the Home app.",
      accessory.displayName);
  }

  // Initialize our network stack.
  private initNetworking(): void {

    // Destroy any existing dispatcher before we re-arm. With a single HTTP/2 connection a wedged session carries every in-flight request, so destroy fails them fast
    // onto the fresh pool through their own retry loops, where a graceful drain would instead wait on the very wedge the re-arm is clearing.
    void this.dispatcher?.destroy();

    /* The family's vetted transport - the pool, the retry policy, and this plugin's name as the user agent - built against the origin derived from the one base URL
     * every request is assembled on. Re-arming after a wedge is another call through the same factory, so the pool the constructor built and the pool a timeout
     * rebuilds can never differ.
     *
     * The retry policy is the plugin's own on the fields named here and the library's on the rest. The retried statuses are the server errors alone, so an invalid key, a
     * reached rate limit, and a request the server refused reach retrieve() as themselves. The retry count keeps the backoff ladder inside the request timeout, so
     * a server that keeps failing, or a host that refuses the connection, reports as itself rather than as the timeout overtaking a retry.
     */
    this.dispatcher = createApiDispatcher({ origin: new URL(HYDRAWISE_API_BASE_URL).origin,
      retry: { maxRetries: HYDRAWISE_API_RETRY_ATTEMPTS, statusCodes: [...HYDRAWISE_API_RETRY_STATUS_CODES] }, userAgent: PLUGIN_NAME });

    setGlobalDispatcher(this.dispatcher);
  }

  /* Communicate HTTP requests with the Hydrawise API, answering what the read of the response's body came to, or null for a failure or a shutdown, which the
   * request log has already reported. The body is read inside the request's own deadline, so every answered body is read before the request settles and the
   * caller holds the parsed body or the error its read met, never a stream left to consume.
   */
  public async retrieve(endpoint: HydrawiseEndpoint, params?: Record<string, string>): Promise<Nullable<HydrawiseBodyRead>> {

    const outcome = await this.request({ endpoint, params, read: readJsonBody });

    return (outcome.status === "answered") ? outcome.value : null;
  }

  /** Send one command to Hydrawise and answer what became of it. The command takes the same path every request to the key-based API takes, through the request
   * log and both budgets, and the request reads its reply through readCommandReply(), inside the request's own deadline, so every body is read or drained and the
   * caller holds the outcome alone. A reply whose verdict cannot be read answers unreadable, which the request log has not logged, so the caller says what it means.
   *
   * The signal is the caller's to withdraw the command with while it still waits for a budget to admit it. A withdrawn command leaves the budget's queue and
   * answers aborted. It takes no slot, with one limit: a withdrawal that lands after the command budget has admitted the command, while the account budget still
   * holds it, spends one command slot. Once the account budget has admitted it too, the command is on its way to the wire and the signal no longer reaches it,
   * because a request abandoned in flight may have been acted on anyway, and the caller could no longer tell.
   *
   * @param options        - The command.
   * @param options.params - The setzone parameters the command carries, the API key aside, which the request adds.
   * @param options.signal - Withdraws the command while it waits for admission.
   *
   * @returns What became of the command.
   */
  public async command({ params, signal }: { params: Record<string, string>; signal?: AbortSignal }): Promise<HydrawiseCommandOutcome> {

    const outcome = await this.request({ endpoint: HYDRAWISE_COMMAND_ENDPOINT, params,
      read: async (response): Promise<HydrawiseCommandOutcome> => this.readCommandReply(response), signal });

    // Every tag the request log names reaches one outcome here with no default arm, so a tag the request learns to name is a compile error until this says what a
    // command makes of it. An invalid key and a status the platform does not accept are refusals a resend would meet again, and every other failure is a request
    // that did not complete.
    switch(outcome.status) {

      case "answered":

        return outcome.value;

      case "aborted":
      case "timeout":

        return { status: outcome.status };

      case "invalid-key":
      case "unexpected-status":

        return { reason: outcome.reason, status: "refused" };

      case "certificate":
      case "connect-timeout":
      case "destroyed":
      case "dns":
      case "rate-limit":
      case "refused":
      case "reset":
      case "retries-exhausted":
      case "transport":
      case "unreachable":

        return { reason: outcome.reason, status: "failed" };
    }
  }

  /* Read the verdict a command's reply carries. Hydrawise answers a command it accepted and one it refused alike with a success status, telling them apart by the
   * reply's message type, so the body is the only place the verdict lives. A reply that does not parse, parses into no verdict this plugin knows, or fails partway
   * through is unreadable, and the platform says nothing for it, leaving the caller to say what it means.
   *
   * The request runs this read inside its deadline, so a body that fails mid-read is classified on the request's own terms: a shutdown is orderly teardown, and a
   * deadline is a timeout the caller may resend. The read catches its own failure, so a deadline met mid-reply leaves the request answered to the request log,
   * which writes no line for it and re-arms no pool. A wedge that persists meets the resend's own timeout before the reply arrives, and that timeout writes the
   * request-log line and re-arms the pool.
   */
  private async readCommandReply(response: Dispatcher.ResponseData<unknown>): Promise<HydrawiseCommandOutcome> {

    let reply: unknown;

    try {

      reply = await response.body.json();
    } catch(error) {

      const failure = classifyTransportError(error, this.signal);

      switch(failure.kind) {

        case "aborted":
        case "timeout":

          return { status: failure.kind };

        default:

          return { reason: HYDRAWISE_UNREADABLE_REPLY, status: "unreadable" };
      }
    }

    const verdict: Partial<SetZoneResponse> = ((typeof reply === "object") && (reply !== null)) ? reply : {};

    switch(verdict.message_type) {

      case "info":

        return { status: "confirmed" };

      // Hydrawise's own message is the reason a refusal gives. A refusal carrying no message of its own still says plainly that the command did not take.
      case "error":

        return { reason: ((typeof verdict.message === "string") && verdict.message.trim().length) ? verdict.message.trim() : "Hydrawise did not accept the command.",
          status: "refused" };

      default:

        return { reason: HYDRAWISE_UNREADABLE_REPLY, status: "unreadable" };
    }
  }

  /* One request to the Hydrawise API, run as one attempt of the request log, which weighs a failure's reason against the last one's before it releases the request's
   * lines. The read turns the answered response's body into the caller's answer inside the request's deadline, and it catches its own failure, so a body that
   * fails partway through still leaves the request answered. The signal withdraws the request while it waits for admission, and the answer is what the request
   * came to.
   */
  private async request<T>({ endpoint, params, read, signal }: { endpoint: HydrawiseEndpoint; params?: Record<string, string>;
    read: (response: Dispatcher.ResponseData<unknown>) => Promise<T>; signal?: AbortSignal; }): Promise<HydrawiseRequestOutcome<T>> {

    return this.requestFailures.attempt(async (log): Promise<HydrawiseRequestOutcome<T>> => this.attemptRequest({ endpoint, log, params, read, signal }),
      (result): HydrawiseRequestFailure | undefined => (((result.status === "aborted") || (result.status === "answered")) ? undefined : result.status));
  }

  /* One request to the Hydrawise API, as the request log runs it. Every line it writes goes through the logger the attempt hands in, and it answers what the
   * request came to, which the log classifies before it releases the request's lines: an answered request carries what the caller's read made of its body. Each
   * failure arm answers the sentence it logged beside its tag, so a command can say which failure stopped it in the same words the log used.
   */
  private async attemptRequest<T>({ endpoint, log, params, read, signal: withdrawal }: { endpoint: HydrawiseEndpoint; log: HomebridgePluginLogging;
    params?: Record<string, string>; read: (response: Dispatcher.ResponseData<unknown>) => Promise<T>; signal?: AbortSignal; }): Promise<HydrawiseRequestOutcome<T>> {

    // Whether both budgets have admitted this call. The catch reads it to tell a caller's withdrawal, which can only end an admission wait, from a failure of the
    // request itself, since the request never carries the caller's signal.
    let admitted = false;

    // The request URL as the timeout branch reports it, with the API key redacted, because a debug log is what a user pastes into an issue. It is assembled inside
    // the try below once the budgets have admitted this call and declared out here because the timeout branch of the catch reports it, and a variable assigned
    // only inside a try cannot be read from its own catch. The empty starting value is never what reaches that log: the only steps preceding the assignment are
    // the budget waits, and the only ways any of them ends early are a shutdown rejection and a caller's withdrawal, which the catch answers above the timeout
    // branch.
    let loggedUrl = "";

    try {

      /* Pace this call against both ceilings Hydrawise publishes, at the one place every request to the API passes through. A zone command draws the stricter
       * command budget first and the account-wide budget second, so a command queued behind a saturated command window is not also holding an account slot while
       * it waits. Every wait sits inside this try, which is what makes an escaping budget rejection unrepresentable: a shutdown while a caller is queued rejects
       * into the classification below, whose aborted-signal branch answers a shutdown, the outcome retrieve() returns as the same quiet null every other teardown
       * path returns. A caller's signal withdraws its wait the same way, and the budget skips a withdrawn waiter rather than granting it a slot.
       *
       * Two limits on what these budgets can promise, stated plainly. They admit LOGICAL calls and sit above undici's retry interceptor, so one admitted call can
       * still put more than one request on the wire during a failure storm - the initial attempt plus whatever retries the dispatcher factory's retry policy
       * allows - accepted headroom, because retries exist to recover from exactly the trouble a ceiling is not the cause of. And they account only for this process:
       * the Homebridge config UI runs its own server process against the same account, one customerdetails call per refresh plus one statusschedule call per
       * controller it holds no cached context for, which an in-process window cannot see.
       */
      if(endpoint === HYDRAWISE_COMMAND_ENDPOINT) {

        await this.commandBudget.acquire({ signal: withdrawal });
      }

      await this.accountBudget.acquire({ signal: withdrawal });

      admitted = true;
      params ??= {};

      params["api_key"] = this.config.apiKey;

      const url = HYDRAWISE_API_BASE_URL + endpoint + "?" + new URLSearchParams(params).toString();
      const redacted = new URLSearchParams(params);

      redacted.set("api_key", "redacted");
      loggedUrl = HYDRAWISE_API_BASE_URL + endpoint + "?" + redacted.toString();

      /* Arm the per-request deadline on the platform's clock and compose it with the platform's shutdown signal, so a slow request aborts on the deadline and an
       * in-flight request aborts on shutdown, all through one signal handed to undici. The deadline is armed only now, after the budgets have admitted the call, so
       * a wait for a rate-limit slot never eats into the time the request itself is allowed.
       *
       * The deadline bounds the request and the caller's read of its body together, because the read runs inside this scope and the deadline is released only as
       * the scope exits, the read settled. A deadline met mid-read surfaces through the read, which answers it rather than throwing it here, so the request stays
       * answered and the caller says what the failed read means.
       */
      using deadline = armDeadline(HYDRAWISE_API_TIMEOUT * 1000, { clock: this.clock });

      const signal = composeSignals(deadline.signal, this.signal);
      const response = await request(url, { signal });

      /* Invalid API key. The pool does not retry this status, so it reaches this branch on the first answer.
       *
       * Every arm that refuses a response drains its body first. The pool holds a single connection, and a body nobody reads holds that connection until it is
       * consumed, so an unread error body would stall every request queued behind it.
       */
      if(response.statusCode === 404) {

        await response.body.dump();

        const reason = "Invalid API key. Please check your Hydrawise API key.";

        log.error(reason);

        return { reason, status: "invalid-key" };
      }

      // API rate limit exceeded. The pool does not retry this status, so the limit is reported the moment Hydrawise says so.
      if(response.statusCode === 429) {

        await response.body.dump();

        const reason = "Hydrawise API rate limit has been exceeded.";

        log.error(reason);

        return { reason, status: "rate-limit" };
      }

      // Any other response outside the 2xx success range is an error, reported with its status code and reason phrase. A server error never arrives here: the pool
      // retries it, and one that survives every retry is thrown as an exhausted retry, which the classification below names.
      if((response.statusCode < 200) || (response.statusCode >= 300)) {

        await response.body.dump();

        const reason = "The Hydrawise API answered a request with an unexpected status of " + response.statusCode.toString() + " " +
          (STATUS_CODES[response.statusCode] ?? "") + ".";

        log.error(reason);

        return { reason, status: "unexpected-status" };
      }

      return { status: "answered", value: await read(response) };
    } catch(error) {

      // A caller's withdrawal is no failure either, and it is ranked here, ahead of the classifier, because the classifier knows the lifetime signal and the deadline
      // alone and would read the withdrawal's abort as a deadline. A withdrawal can only end an admission wait, which is what the admission check holds it to.
      if(!admitted && (withdrawal?.aborted ?? false)) {

        return { status: "aborted" };
      }

      const failure = classifyTransportError(error, this.signal);

      /* Branch on the classified kind rather than on error shapes, with no default arm: the switch is exhaustive over the classifier's kinds, so a kind the library
       * learns to name is a compile error here until this plugin says what it means, never a silent fall-through. The classifier answers what kind of failure
       * occurred; what it means to a Hydrawise user, and what we do about it, is decided here.
       */
      switch(failure.kind) {

        // A shutdown is not news. The lifetime signal outranks every reading of the error itself, which is also what guarantees the deadline arm below can never
        // re-arm the pool after shutdown.
        case "aborted":

          return { status: "aborted" };

        // A deadline elapsed: our own per-request timeout, or a response that stalled after it began. With a single HTTP/2 connection a wedged session carries every
        // request on it, so we reset the network stack rather than wait on the wedge.
        case "timeout": {

          const reason = "The Hydrawise API is taking too long to respond to a request. This error can usually be safely ignored.";

          log.error(reason);
          log.debug("Original request was: %s", loggedUrl);
          this.initNetworking();

          return { reason, status: "timeout" };
        }

        // A concrete transport fault - a network failure, or a certificate the platform refused to trust - named by the sentence the plugin keeps for it.
        case "certificate":
        case "connect-timeout":
        case "destroyed":
        case "dns":
        case "refused":
        case "reset":
        case "retries-exhausted":
        case "unreachable":

          log.error(HYDRAWISE_TRANSPORT_FAULT_SENTENCES[failure.kind]);

          return { reason: HYDRAWISE_TRANSPORT_FAULT_SENTENCES[failure.kind], status: failure.kind };

        // A genuine failure carrying no marker anyone can read. The full dump is the only useful thing to say about it, and it carries whatever code the chain held,
        // while the reason a command names it by is a sentence of its own that ends in the error's own message.
        case "transport":

          log.error(util.inspect(error, { colors: true, depth: null, sorted: true }));

          return { reason: "The request to the Hydrawise API failed: " + formatErrorMessage(error) + ".", status: "transport" };
      }
    }
  }
}
