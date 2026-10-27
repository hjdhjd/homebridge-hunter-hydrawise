/* Copyright(C) 2017-2026, HJD (https://github.com/hjdhjd). All rights reserved.
 *
 * platform.helpers.ts: The plugin-specific test harness - the Homebridge runtime every suite runs on, the platform double for controller tests, real-platform
 * construction over HBPU's Homebridge API double, the recording MQTT client, the programmable retrieve recorder, the undici MockAgent installer, and the
 * buildController / buildPlatform construction workhorses. Every cast that bridges a double to a production constructor's parameter type is confined to a
 * workhorse, so test bodies stay cast-free.
 *
 * Every accessory a suite reads is Homebridge's own PlatformAccessory over the hap-nodejs copy Homebridge loads, made through HBPU's Homebridge test double, so
 * HAP's own defaults, UUID validation, bridge and read and write paths apply to every row. Each accessory the harness builds reaches the double's bridge the way
 * Homebridge puts it there: one that stands for what the cache carried is restored, in Homebridge's restore order, and one that stands for a fresh accessory is
 * registered. Every view of the accessory calls a suite reads is derived from the double's one record of them.
 *
 * The wire boundaries are by design. Controller tests never touch undici: the platform double's retrieve is a programmable recorder that records every call and
 * returns fixture-programmed response shapes. Platform tests construct a REAL HydrawisePlatform and drive its retrieve() through a MockAgent installed as the
 * global dispatcher after construction, so the real status-code classification and error taxonomy run unchanged.
 */
// The entry point's polyfill gesture, mirrored for the suites that construct a platform without ever loading src/index.ts. Every platform and controller test
// reaches production through this module, so installing here is what keeps the explicit-resource-management globals present for a contributor running the suite on
// a Node below the release that ships them. It is a no-op on a runtime that already has them, and the runtime-floor conformance test enumerates it among the lines
// the sunset deletes.
import "homebridge-plugin-utils/polyfills";
import type { API, PlatformAccessory } from "homebridge";
import { AccessoryPersistence, FeatureOptions, TimerRegistry, acquireService, sanitizeName, setAccessoryName, systemClock } from "homebridge-plugin-utils";
import type { Clock, HomebridgePluginLogging, Nullable, RateBudget } from "homebridge-plugin-utils";
import { HYDRAWISE_API_BASE_URL, PLATFORM_NAME, PLUGIN_NAME } from "../settings.ts";
import type { HydrawiseAccessory, HydrawiseControllerConfig, HydrawiseControllerHardware, HydrawiseControllerIdentity, HydrawiseControllerV2Facts,
  HydrawiseV2MutationResult, HydrawiseZoneConfig, HydrawiseZoneSuspensionResult, HydrawiseZoneV2Facts } from "../types.ts";
import { MockAgent, getGlobalDispatcher, setGlobalDispatcher } from "undici";
import { TestClock, TestHomebridgeApi, TestMqttClient, capturingLog, loadHomebridge, present, waitUntil } from "homebridge-plugin-utils/testing";
import type { TestHomebridgeApiCall, TestLogEntry, TestPlatformAccessory } from "homebridge-plugin-utils/testing";
import { featureOptionCategories, featureOptions } from "../options.ts";
import type { Dispatcher } from "undici";
import { HydrawiseController } from "../controller.ts";
import type { HydrawiseOptions } from "../options.ts";
import { HydrawisePlatform } from "../platform.ts";
import { syntheticController } from "../api.fixtures.ts";
import { zoneAccessoryId } from "../types.ts";

/* The Homebridge runtime every suite runs on, loaded once from this repository's tree: Homebridge's own PlatformAccessory class and the hap-nodejs copy Homebridge
 * loads, so the handlers the plugin binds meet the HAP they meet at runtime, its status error class included. Loading it as this module evaluates is what keeps
 * every workhorse below synchronous, so a suite builds a controller or a platform in one call however it is shaped.
 */
const runtime = await loadHomebridge(import.meta.url);

// The runtime's HAP Service and Characteristic namespaces, the one source every suite reads HAP's service and characteristic classes and their constants from.
export const { Characteristic, Service } = runtime.hap;

/* The library's recording MqttClient double, re-exported so every suite reaches it through this one harness module, exactly as it reaches every other double
 * here. It mirrors the real client's observable behavior - the suffix the client appends to a get or set registration, the republish a get answers with, the
 * lowercasing a set handler's first argument arrives with, and the guarded publish's own log lines - so a controller driven against it branches as it would
 * against a live broker.
 */
export { TestMqttClient };

// One recorded retrieve call: the endpoint the controller asked for and the params it passed. The recorder keeps these so a test asserts on the wire traffic
// (the statusschedule cadence, the setzone params) without any real network.
export interface RecordedRetrieveCall {

  endpoint: string;
  params: Record<string, string> | undefined;
}

/* A single programmed response for the retrieve recorder. "response" resolves body.json() to the given body; "null" returns null (the recoverable-error shape
 * the callers treat as a failed poll or command); "malformed" returns a response whose body.json() rejects (the malformed-body shape behind bug 10).
 */
export type ProgrammedResponse =
  { body: unknown; kind: "response"; statusCode?: number } |
  { kind: "malformed"; statusCode?: number } |
  { kind: "null" };

/* The programmable retrieve recorder that stands in for the platform's retrieve(). It records every call and answers with a per-endpoint FIFO queue of programmed
 * responses, falling back to a per-endpoint steady default (so a live polling loop keeps receiving the same shape once its queue drains) and finally to null.
 * body.json() returns a fresh deep clone per call, so production's reassign-and-trim of this.status never leaks back into the program.
 */
export class RetrieveRecorder {

  public readonly calls: RecordedRetrieveCall[] = [];
  private readonly defaults = new Map<string, ProgrammedResponse>();
  private readonly queues = new Map<string, ProgrammedResponse[]>();

  // Queue a one-shot response for an endpoint, consumed in FIFO order.
  public program(endpoint: string, response: ProgrammedResponse): void {

    const queue = this.queues.get(endpoint) ?? [];

    queue.push(response);
    this.queues.set(endpoint, queue);
  }

  // Set the steady response an endpoint answers with once its one-shot queue drains. A live loop polling faster than the test programs keeps this shape.
  public programDefault(endpoint: string, response: ProgrammedResponse): void {

    this.defaults.set(endpoint, response);
  }

  // The recorded calls to a given endpoint, in call order.
  public callsTo(endpoint: string): RecordedRetrieveCall[] {

    return this.calls.filter(call => call.endpoint === endpoint);
  }

  // The retrieve replacement handed to the platform double. Records the call, then materializes the next programmed response.
  public readonly retrieve = async (endpoint: string, params?: Record<string, string>): Promise<Nullable<Dispatcher.ResponseData<unknown>>> => {

    this.calls.push({ endpoint, params });

    const chosen = this.queues.get(endpoint)?.shift() ?? this.defaults.get(endpoint) ?? { kind: "null" };

    return this.materialize(chosen);
  };

  // Turn a programmed response into the response shape the callers consume (a body with an async json()), or null. The cast is confined here: the callers touch
  // only body.json() and the null check, so the minimal shape is a faithful stand-in for the full ResponseData.
  private materialize(response: ProgrammedResponse): Nullable<Dispatcher.ResponseData<unknown>> {

    if(response.kind === "null") {

      return null;
    }

    if(response.kind === "malformed") {

      return { body: { json: async (): Promise<unknown> => { throw new Error("Malformed response body."); } }, statusCode: response.statusCode ?? 200 } as
        unknown as Dispatcher.ResponseData<unknown>;
    }

    const body = response.body;

    return { body: { json: async (): Promise<unknown> => structuredClone(body) }, statusCode: response.statusCode ?? 200 } as unknown as
      Dispatcher.ResponseData<unknown>;
  }
}

// The accessories each of an API double's calls of one kind carried, one list per call in arrival order. Every call view a workhorse returns reads through here
// at the moment it is asked, so the double's record is the one source a view answers from, and a view reads a call made after the result holding it was copied.
function callsOf(api: TestHomebridgeApi, kind: TestHomebridgeApiCall["kind"]): (readonly PlatformAccessory[])[] {

  return api.calls.filter(call => call.kind === kind).map(call => call.accessories);
}

// One recorded reconcileZoneAccessories call: the whole argument object the controller passed. Typed off the production signature, so a test reads the request the
// projection actually built - which zones it named standalone, the display name each carried, and the pre-enablement relay-id population.
export type RecordedReconcileCall = Parameters<HydrawisePlatform["reconcileZoneAccessories"]>[0];

// The platform double's read surface, as the controller and its configure chain consume it. The construction-boundary cast to HydrawisePlatform happens in
// buildController. The api is HBPU's Homebridge API double, through which the controller reaches HAP and its persistence saves, and whose record of those saves
// is what the harness reads back. reconcileZoneAccessories is typed by indexed access against the real method, so a signature drift is a compile error here
// rather than a silent mismatch.
export interface TestPlatform {

  api: TestHomebridgeApi;

  // The time source every wait and stamp a controller takes reads, standing in for the production platform's own clock. Typed as the production Clock because that is
  // the whole of what a controller consumes; a test that drives time holds its own TestClock handle.
  clock: Clock;
  config: HydrawiseOptions;
  featureOptions: FeatureOptions;
  hasV2Client: boolean;
  log: HomebridgePluginLogging;
  mqtt: Nullable<TestMqttClient>;

  // HBPU's real AccessoryPersistence over the API double, every mark a controller makes going through it as it goes through the platform's own in production.
  persistence: AccessoryPersistence;
  reconcileZoneAccessories: HydrawisePlatform["reconcileZoneAccessories"];
  retrieve: RetrieveRecorder["retrieve"];
  setZoneSuspension: HydrawisePlatform["setZoneSuspension"];
  signal: AbortSignal;
  timers: TimerRegistry;
}

// One recorded per-zone suspension command the controller issued: the whole argument object it passed. Typed by indexed access against the real method, so a
// signature drift is a compile error here rather than a silent mismatch.
export type RecordedSuspensionCall = Parameters<HydrawisePlatform["setZoneSuspension"]>[0];

// Options for makeTestPlatform: the platform config overrides, whether the account-credentialed client is present (the gate a controller reads to decide whether
// cached hardware facts are still worth honoring), whether to attach a recording MQTT double, whether the platform signal starts pre-aborted (the default, which
// lets a controller construct fully while its polling loop exits silently), and the feature-option strings.
export interface MakeTestPlatformOptions {

  /* The clock the platform double publishes, defaulting to the system clock. The suites' polling rows run on real time through the fast cadence, so a virtual clock
   * as the default would hold every one of them at its first sleep; a row that drives time itself passes a TestClock and advances it.
   */
  clock?: Clock;
  config?: Partial<HydrawiseOptions>;
  hasV2Client?: boolean;
  mqtt?: boolean;
  signalAborted?: boolean;

  /* A REAL account-credentialed client for the suspension surface to delegate to, built by the test from the platform double's own log so every layer's lines land
   * in one capture buffer. That shared buffer is the point: an assertion about how many voices narrate one failure can only be written where all of them are recorded.
   *
   * It is a factory rather than a client because the log does not exist until this double is built, and answering the question this option exists for means the
   * client must write into that same log rather than one of its own.
   */
  suspensionClient?: (log: HomebridgePluginLogging) => Pick<TestV2Client, "setZoneSuspension">;

  // The answer the per-zone suspension surface gives when no client is supplied above, or a function of the one-based command number so a test can answer
  // differently command by command. Defaults to accepting every command, which is what a test asserting anything other than a refusal wants.
  suspensionResult?: HydrawiseZoneSuspensionResult | ((command: number) => HydrawiseZoneSuspensionResult);
  userOptions?: string[];
}

// The handles makeTestPlatform returns: the platform double plus the doubles and capture buffers a test asserts against and the lever to abort a live signal.
export interface MakeTestPlatformResult {

  abort: (reason?: string) => void;

  // The clock the platform double publishes: the caller's own when it passed one, and the system clock otherwise.
  clock: Clock;

  // Every line the platform double logged, read live: the array grows as the code under test logs, so a read always sees everything logged so far.
  entries: readonly TestLogEntry[];

  // The accessories each cache save carried, one list per save, read from the API double's record when called, so a test asserts on the save cadence however it
  // holds this result. The read closes the save window first, so the last poll's marks, or a refresh's or a command's, are saved before they are counted.
  flushes: () => (readonly PlatformAccessory[])[];
  mqtt: Nullable<TestMqttClient>;
  platform: TestPlatform;

  // Every reconcileZoneAccessories call the controller made, in order.
  reconciles: RecordedReconcileCall[];
  retrieve: RetrieveRecorder;
  signalController: AbortController;

  // Every per-zone suspension command the controller issued, in order.
  suspensions: RecordedSuspensionCall[];

  // The zone accessories the reconcile stub owns, keyed by relay id. It is both the stub's own store and the seeding hook a warm-restart test pre-populates, so a
  // test can hand the first poll an accessory that already carries a cache-restored valve.
  zoneAccessories: Map<number, TestPlatformAccessory>;
}

/* Build a platform double around a REAL FeatureOptions engine seeded with the supplied userOptions, so the production feature-option logic (test / logFeature)
 * runs unchanged. A capturing log records every line and keeps a writable debug slot so a test can interpose on the debug channel; a recording MQTT double
 * captures subscriptions and publishes; the retrieve recorder stands in for the network. The signal starts pre-aborted by default so a constructed controller's
 * loop exits at once; pass signalAborted false for a live-loop test and abort it via the returned lever.
 */
export function makeTestPlatform(options: MakeTestPlatformOptions = {}): MakeTestPlatformResult {

  const log = capturingLog();
  const signalController = new AbortController();

  if(options.signalAborted ?? true) {

    signalController.abort("pre-aborted");
  }

  const mqtt = options.mqtt ? new TestMqttClient({ log }) : null;
  const clock = options.clock ?? systemClock;

  /* The REAL timer registry, not a double. A double stands in for an I/O surface - the recording MQTT client for a network client, the retrieve recorder for the
   * wire - while a pure in-memory, signal-scoped mechanism runs its production self here, exactly as the FeatureOptions engine and the platform's rate budgets do.
   * It takes the double's own signal, so a pre-aborted platform double carries a registry born disposed, which is the state production reaches at shutdown, and the
   * double's own clock, so a revert a row drives on a virtual timeline fires when that row advances it.
   */
  const timers = new TimerRegistry({ clock, signal: signalController.signal });

  // HBPU's Homebridge API double, one per platform double, because its accessory cache, its bridge and its record of accessory calls belong to the one platform
  // a row builds.
  const api = new TestHomebridgeApi(runtime);

  /* The REAL save path, on the same terms as the timer registry above, over the API double the controller reaches. Its window runs on a clock of its own that
   * nothing advances, so no save leaves on a timer: the window closes where production's poll interval closes it, at the next status fetch below, and where a
   * row reads the saves.
   */
  const persistence = new AccessoryPersistence({ api, clock: new TestClock(), platformName: PLATFORM_NAME, pluginIdentifier: PLUGIN_NAME });
  const retrieve = new RetrieveRecorder();

  /* The retrieve the platform double hands the controller: the recorder's, closing the save window before it answers each status fetch. Production's poll interval
   * is far longer than the window, so each poll's marks reach the cache as one save before the next poll fetches, and closing the window at that fetch holds the
   * same boundary on a clock nothing advances. A row therefore counts the saves each poll's marks produce rather than one merged across every poll between reads.
   */
  const retrieveClosingWindow: RetrieveRecorder["retrieve"] = async (endpoint, params) => {

    if(endpoint === "statusschedule.php") {

      persistence.flush();
    }

    return retrieve.retrieve(endpoint, params);
  };
  const reconciles: RecordedReconcileCall[] = [];
  const zoneAccessories = new Map<number, TestPlatformAccessory>();
  const featureOpts = new FeatureOptions(featureOptionCategories, featureOptions, options.userOptions);
  const suspensions: RecordedSuspensionCall[] = [];

  /* A recording stand-in for the platform's per-zone suspension surface. It is a DOUBLE rather than a thin executor because what it stands in for is the network:
   * the real method reaches the account-credentialed client, which no controller test may ever touch. The programmed answer is what drives the controller's own
   * success, revert, and refusal paths.
   */
  const suspensionClient = options.suspensionClient?.(log);

  const setZoneSuspension: HydrawisePlatform["setZoneSuspension"] = async (request) => {

    suspensions.push(request);

    // With a real client supplied, this stands in only for the platform's mapping - which passes the client's answer through untouched - so the command runs the
    // whole production path beneath it. The platform's own outcome mapping is asserted in its own suite.
    if(suspensionClient) {

      return suspensionClient.setZoneSuspension(request);
    }

    const programmed = options.suspensionResult ?? { status: "done" };

    return (typeof programmed === "function") ? programmed(suspensions.length) : programmed;
  };

  /* A THIN EXECUTOR standing in for the platform's zone-accessory reconcile, not a second copy of its policy. It records the call, keeps one accessory per
   * requested zone (reusing a stored one, whether the stub made it or a test seeded it), and answers a zone the request does not name as production's demotion
   * does. A zone the wire still reports is a configuration demotion: its accessory is unregistered through the platform double's save path at once, as the
   * platform unregisters it, so a later request mints the zone afresh on the bridge rather than colliding with a UUID Homebridge still holds. A zone the wire
   * leaves out is held and left unhosted, as the platform holds it through its grace, and handed back if a later request names it again. The grace's count,
   * the context writes, and the promotion-failure containment are the platform's contract and are asserted in its own suite, so nothing of them is
   * reimplemented here: a held accessory stays held for as long as the wire leaves its zone out.
   *
   * An accessory the stub mints is registered with the API double, as the platform registers a fresh zone accessory, so it sits on the bridge where every zone
   * accessory the platform holds sits.
   *
   * It NEVER marks an accessory for a save. The roster suite asserts exact save counts across multi-poll runs, so a stub that saved would break that net
   * without any production change behind it.
   */
  const reconcileZoneAccessories: HydrawisePlatform["reconcileZoneAccessories"] = (request) => {

    reconciles.push(request);

    const requestedIds = new Set(request.zones.map(zone => zone.identity.relayId));

    for(const [ relayId, accessory ] of zoneAccessories) {

      if(!requestedIds.has(relayId) && request.presentRelayIds.has(relayId)) {

        persistence.unregister([accessory]);
        zoneAccessories.delete(relayId);
      }
    }

    const hosts = new Map<number, HydrawiseAccessory>();

    for(const zone of request.zones) {

      let accessory = zoneAccessories.get(zone.identity.relayId);

      // The display name is sanitized on creation and the UUID derived from the compound identity, exactly as the production reconcile mints them, so a test
      // measuring name-synchronization writes sees the same starting state the real platform would hand the controller.
      if(!accessory) {

        accessory = new api.platformAccessory(sanitizeName(zone.displayName), api.hap.uuid.generate(zoneAccessoryId(request.controller.controller_id,
          zone.identity.relayId)));

        api.registerPlatformAccessories(PLUGIN_NAME, PLATFORM_NAME, [accessory]);
      }

      zoneAccessories.set(zone.identity.relayId, accessory);
      hosts.set(zone.identity.relayId, accessory);
    }

    return hosts;
  };
  const config: HydrawiseOptions = {

    apiKey: "test-api-key",
    debug: false,
    mqttTopic: "hydrawise",
    options: options.userOptions ?? [],
    ...options.config
  };

  const platform: TestPlatform = {

    api,
    clock,
    config,
    featureOptions: featureOpts,
    hasV2Client: options.hasV2Client ?? false,
    log,
    mqtt,
    persistence,
    reconcileZoneAccessories,
    retrieve: retrieveClosingWindow,
    setZoneSuspension,
    signal: signalController.signal,
    timers
  };

  /* The teardown lever: the platform signal first, then the MQTT double, which is the pairing production wires - the client's lifetime is bound to the platform's own
   * shutdown signal, so the two fall together. A test that reaches past this lever and aborts signalController directly leaves the double running, on the same
   * terms as every other handle this harness returns.
   */
  const abort = (reason?: string): void => {

    signalController.abort(reason ?? "test-teardown");
    mqtt?.abort();
  };

  const flushes = (): (readonly PlatformAccessory[])[] => {

    persistence.flush();

    return callsOf(api, "update");
  };

  return { abort, clock, entries: log.entries, flushes, mqtt, platform, reconciles, retrieve, signalController, suspensions, zoneAccessories };
}

// Options for buildController: the controller-config overrides, an optional program hook, and everything makeTestPlatform accepts.
export interface BuildControllerOptions extends MakeTestPlatformOptions {

  /* The display name the accessory is created under. The platform's discovery path composes this from the user's Name option where one is configured, so a
   * scenario about creation states it here rather than letting the harness diverge from the shape production actually mints. It defaults to the controller's
   * wire name, which is what discovery composes when no override is set.
   */
  accessoryName?: string;

  controller?: Partial<HydrawiseControllerConfig>;

  // Program the retrieve recorder before the controller is constructed. The controller's polling loop issues its first retrieve synchronously during
  // construction, so a live-loop test must seed the recorder here rather than after buildController returns, or that first poll consumes the empty program.
  program?: (recorder: RetrieveRecorder) => void;

  // The denormalized account roster the platform would pass into the controller constructor. Defaults to a single-entry roster derived from the controller config,
  // so a test that does not care about siblings gets a sensible self-only roster; a multi-controller test supplies its own.
  roster?: HydrawiseControllerIdentity[];

  // Seed the accessory with what the cache carried - its context, and any services and values a previous session left - as Homebridge restores a cached
  // accessory. Runs before the controller constructs, so a test can prove configureDevice's wipe-then-seed preserves (or shape-degrades) a prior persisted zone
  // roster. A seeded accessory is restored and an unseeded one registered, so a row without a seed starts from the fresh accessory discovery registers.
  seedContext?: (accessory: TestPlatformAccessory) => void;
}

// The handles buildController returns: the constructed production controller plus the underlying doubles and capture buffers a test asserts against.
export interface BuildControllerResult extends MakeTestPlatformResult {

  accessory: TestPlatformAccessory;
  controller: HydrawiseController;
  controllerConfig: HydrawiseControllerConfig;
}

/* Construct a REAL HydrawiseController against the doubles - the controller-test workhorse. The construction-boundary casts (platform, accessory) bridge the
 * doubles to the production constructor's parameter types; everything the controller then does runs the real production code against the doubles. Returns
 * the constructed controller plus every handle a test asserts on: the accessory (to read services, characteristics and the changes HAP raised on them), the
 * capture buffers, the recording MQTT double, and the retrieve recorder.
 */
export function buildController(options: BuildControllerOptions = {}): BuildControllerResult {

  const platformResult = makeTestPlatform(options);
  const { api } = platformResult.platform;
  const controllerConfig: HydrawiseControllerConfig = { ...syntheticController, ...options.controller };

  // The accessory takes the UUID the platform's discovery derives from the controller id, the one HAP's constructor accepts.
  const accessory = new api.platformAccessory(options.accessoryName ?? controllerConfig.name, api.hap.uuid.generate(controllerConfig.controller_id.toString()));
  const roster: HydrawiseControllerIdentity[] = options.roster ?? [{ controllerId: controllerConfig.controller_id, name: controllerConfig.name,
    serialNumber: controllerConfig.serial_number }];

  /* Seed the accessory with what the cache carried, then restore it onto the API double's bridge, as Homebridge restores a cached accessory ahead of configure,
   * so a test can drive the preservation path. An accessory with nothing seeded stands for a fresh one, which discovery registers rather than restores. Neither
   * call is a cache save, so every save a row counts is the controller's own.
   */
  if(options.seedContext) {

    options.seedContext(accessory);
    restoreCached(api, accessory);
  } else {

    api.registerPlatformAccessories(PLUGIN_NAME, PLATFORM_NAME, [accessory]);
  }

  // Seed the recorder before construction, because the controller's polling loop issues its first retrieve synchronously as the constructor runs.
  options.program?.(platformResult.retrieve);

  // The construction-boundary cast bridges the platform double to the production constructor's parameter type. The accessory needs none, since it is
  // Homebridge's own.
  const controller = new HydrawiseController(platformResult.platform as unknown as ConstructorParameters<typeof HydrawiseController>[0], accessory,
    controllerConfig, roster);

  return { accessory, controller, controllerConfig, ...platformResult };
}

/**
 * Restore a cached accessory onto a controller harness's API double, as Homebridge restores one ahead of discovery: Homebridge's FirmwareRevision placeholder, then
 * the platform's configureAccessory, then the bridge. The controller harness builds no platform, and the controller binds every handler a row reads as it
 * configures each service, so the stand-in configureAccessory binds nothing.
 *
 * @param api       - The controller harness's API double, the one the accessory was made through.
 * @param accessory - The accessory standing for what the cache carried, its services and context already in place.
 */
export function restoreCached(api: TestHomebridgeApi, accessory: PlatformAccessory): void {

  api.restorePlatformAccessories({ accessories: [accessory], platform: { configureAccessory: (): void => undefined }, platformName: PLATFORM_NAME,
    pluginIdentifier: PLUGIN_NAME });
}

/**
 * Seed what a previous session's polls established on any accessory the walk hosts valves on, beside the context a row seeds: the accessory's own name as the
 * rename step writes it, and each zone's valve under the name the wire reports, the one the walk gives it with no Name set, each through the HBPU helper
 * production writes it with. A first poll that finds these, beside a context matching what it reports, has no name and no valve left to write, which is the
 * warm restart a row counting saves describes.
 *
 * @param options           - What the earlier session established.
 * @param options.accessory - The accessory the walk hosts the valves on: the controller accessory a seedContext hook is handed, or a standalone zone's own.
 * @param options.name      - The accessory's own name. Defaults to the synthetic controller's wire name, the one the rename step writes with no override set.
 * @param options.zones     - The zones whose valves the walk created, each under the name the wire reports for it.
 */
export function seedEstablished({ accessory, name = syntheticController.name, zones }: { accessory: PlatformAccessory; name?: string;
  zones: readonly HydrawiseZoneConfig[]; }): void {

  setAccessoryName(accessory, name);

  for(const zone of zones) {

    acquireService({ accessory, name: zone.name, serviceType: Service.Valve, subtype: zone.relay_id.toString() });
  }
}

/**
 * Seed a cached accessory onto a real platform the way Homebridge restores one before DID_FINISH_LAUNCHING: the accessory is made through the platform's API
 * double and restored through it, which stamps Homebridge's FirmwareRevision placeholder, hands the accessory to the platform's configureAccessory, and bridges
 * it, so a later unregister of it is one HAP's bridge accepts. The cast that reads the platform's API as that double is confined here so a configure test's body
 * stays cast-free.
 *
 * The optional setup runs on the fresh accessory BEFORE the platform sees it, which is where Homebridge's cache restore puts the services and the context a
 * previous session left behind. That ordering is what lets a restore row reach the handlers the platform binds on the primary characteristic at restore.
 *
 * @param platform    - The real HydrawisePlatform to seed, built by buildPlatform.
 * @param displayName - The cached accessory's display name.
 * @param uuid        - The cached accessory's UUID, generated by the caller from the identity it stands for, as the platform generates the controller UUID it
 *                      matches this against to reuse it.
 * @param setup       - Optionally, what the cache carried: the services, built from the runtime's Service namespace, and the accessory's context, added before
 *                      the platform is handed the accessory.
 *
 * @returns The seeded accessory, so a test can read its services after discovery reuses it.
 */
export function seedAccessory(platform: HydrawisePlatform, displayName: string, uuid: string,
  setup?: (accessory: TestPlatformAccessory) => void): TestPlatformAccessory {

  // Every platform buildPlatform builds runs over a TestHomebridgeApi, which is what this cast states.
  const api = platform.api as unknown as TestHomebridgeApi;
  const accessory = new api.platformAccessory(displayName, uuid);

  setup?.(accessory);

  api.restorePlatformAccessories({ accessories: [accessory], platform, platformName: PLATFORM_NAME, pluginIdentifier: PLUGIN_NAME });

  return accessory;
}

/**
 * Read the platform's undici dispatcher through its private field, exposing just the destroyed flag a teardown test asserts on. undici's composed dispatcher
 * carries a public destroyed boolean that flips synchronously when destroy() is called, so a SHUTDOWN test can confirm the handler tore the pool down. The cast
 * is confined here so the test body stays cast-free.
 *
 * @param platform - The constructed HydrawisePlatform.
 *
 * @returns The dispatcher's destroyed view, or undefined when the platform never armed one (the no-API-key path).
 */
export function dispatcherOf(platform: HydrawisePlatform): { destroyed: boolean } | undefined {

  return (platform as unknown as { dispatcher?: { destroyed: boolean } }).dispatcher;
}

/**
 * Read the platform's key-based rate budgets through their private fields, so a wiring test can assert on the capacities they were constructed with and on the slots a
 * sequence of retrieve() calls consumed. The privacy this reaches past is compile-time only, which is this codebase's posture for every private member, so the
 * cast is confined here exactly as dispatcherOf confines its own: no production code outside the platform can name these budgets without deliberately repeating
 * the same cast.
 *
 * @param platform - The constructed HydrawisePlatform.
 *
 * @returns The account-wide budget and the zone-command budget.
 */
export function budgetsOf(platform: HydrawisePlatform): { account: RateBudget; command: RateBudget } {

  const budgets = platform as unknown as { accountBudget: RateBudget; commandBudget: RateBudget };

  return { account: budgets.accountBudget, command: budgets.commandBudget };
}

/**
 * Read the platform's account-credentialed READ budget through its private field, on exactly the terms budgetsOf reads the key-based two. This is the ceiling the
 * scheduled whole-account read and every token grant draw.
 *
 * @param platform - The constructed HydrawisePlatform.
 *
 * @returns The v2 read budget.
 */
export function v2BudgetOf(platform: HydrawisePlatform): RateBudget {

  return (platform as unknown as { v2Budget: RateBudget }).v2Budget;
}

/**
 * Read the platform's account-credentialed COMMAND budget through its private field, the twin of v2BudgetOf and confined here on the same terms. This is the
 * ceiling a per-zone suspension's admission draws, and the one the platform's zero-cost pre-check reads.
 *
 * @param platform - The constructed HydrawisePlatform.
 *
 * @returns The v2 mutation budget.
 */
export function v2MutationBudgetOf(platform: HydrawisePlatform): RateBudget {

  return (platform as unknown as { v2MutationBudget: RateBudget }).v2MutationBudget;
}

/**
 * Read the account-credentialed client's dispatcher through the platform's private field, exposing the destroyed flag a teardown test asserts on - the v2 twin of
 * dispatcherOf, and confined here for the same reason. The read goes through the client's public getter rather than a captured reference, which is exactly how the
 * platform's own teardown reads it, so this observes what that registration observes.
 *
 * @param platform - The constructed HydrawisePlatform.
 *
 * @returns The v2 dispatcher's destroyed view, or undefined when no credentials were configured and no client was built.
 */
export function v2DispatcherOf(platform: HydrawisePlatform): { destroyed: boolean } | undefined {

  return (platform as unknown as { v2Client?: { dispatcher: { destroyed: boolean } } }).v2Client?.dispatcher;
}

/* The account-credentialed client surface the platform actually consumes: the dispatcher its teardown destroys, the whole-account facts fetch its refresh loop
 * drives, and the per-zone suspension its write surface delegates to. A distribution test supplies this shape rather than a real client, so no test ever reaches
 * the live account API.
 *
 * A REAL client satisfies this shape too, which is deliberate: a test that wants the client's own admission phase in the picture installs one built over a
 * MockAgent, and the whole path from the platform's pre-check down runs production code with nothing on the wire.
 */
export interface TestV2Client {

  dispatcher: { destroy: () => Promise<void> };
  fetchAccountFacts: () => Promise<Nullable<Map<number, HydrawiseControllerV2Facts>>>;
  setZoneSuspension: (options: { until: Nullable<number>; zoneId: number }) => Promise<HydrawiseV2MutationResult>;
}

/**
 * Substitute a double for the platform's account-credentialed client, destroying the real one it constructed so no connection pool is left behind. The platform
 * must have been built WITH credentials, so the production gate that decides whether a client exists at all has genuinely run; this only replaces what that gate
 * produced, leaving the distribution logic under test unchanged. The cast is confined here exactly as dispatcherOf and budgetsOf confine their own.
 *
 * @param platform - The constructed HydrawisePlatform.
 * @param client   - The double to install.
 */
export function installV2Client(platform: HydrawisePlatform, client: TestV2Client): void {

  const slot = platform as unknown as { v2Client?: TestV2Client };

  void slot.v2Client?.dispatcher.destroy();
  slot.v2Client = client;
}

/**
 * Run ONE refresh tick against the platform's installed client, exactly as the recurring loop's body runs it.
 *
 * This exists because the loop sleeps a quarter hour between ticks, and the real platform runs on the system clock and takes no other, so nothing a suite holds can
 * advance that sleep. Driving the tick directly is what lets a test observe the SECOND tick's behavior, above all that a failed fetch ends only its own tick and
 * leaves the loop able to distribute on the next one. It is the production method, not a reimplementation of it: what the loop adds around this call is the sleep,
 * which is what these tests deliberately do not wait on.
 *
 * The cast is confined here for the same reason every other private reach in this module is.
 *
 * @param platform - The constructed HydrawisePlatform, whose client the tick will ask.
 *
 * @returns A promise resolving when the tick has fetched and distributed.
 */
export async function refreshV2FactsOnce(platform: HydrawisePlatform): Promise<void> {

  const slot = platform as unknown as { refreshV2Facts: (client: TestV2Client) => Promise<void>; v2Client?: TestV2Client };

  if(!slot.v2Client) {

    throw new Error("refreshV2FactsOnce: the platform has no account-credentialed client installed.");
  }

  await slot.refreshV2Facts(slot.v2Client);
}

/**
 * Build a recording double of the account-credentialed client, answering a programmed facts result and counting how many times it was asked. The count is what the
 * single-start and cadence assertions read: a second refresh loop, or a discovery re-entry that started one, shows up here as extra calls.
 *
 * The programmed result may be a FUNCTION of the call number, which is what lets a test answer differently tick by tick - a failed first fetch followed by a
 * successful retry, say - without reaching for a mutable variable in the test body.
 *
 * @param facts - The result fetchAccountFacts resolves to, or null for a failed fetch; a function is called with the one-based fetch number.
 *
 * @returns The double, plus a reader for the number of fetches it served.
 */
export function makeTestV2Client(facts: Nullable<Map<number, HydrawiseControllerV2Facts>> |
  ((fetch: number) => Nullable<Map<number, HydrawiseControllerV2Facts>>)): { client: TestV2Client; fetches: () => number } {

  let fetches = 0;

  return { client: { dispatcher: { destroy: async (): Promise<void> => undefined },
    fetchAccountFacts: async (): Promise<Nullable<Map<number, HydrawiseControllerV2Facts>>> => {

      fetches++;

      return (typeof facts === "function") ? facts(fetches) : facts;
    },

    // The facts double answers every command, because a test that programs facts is asserting distribution rather than commands; a test asserting commands installs a
    // real client over a MockAgent instead.
    setZoneSuspension: async (): Promise<HydrawiseV2MutationResult> => ({ status: "done" }) }, fetches: (): number => fetches };
}

/**
 * Compose one controller's account-credentialed facts, defaulting every field to the "nothing to say" answer so a test states only what it is actually asserting.
 *
 * @param overrides - The facts to state: the hardware, the name, the availability, and the per-zone entries keyed by relay id.
 *
 * @returns A fresh facts value.
 */
export function makeV2Facts(overrides: { hardware?: Nullable<HydrawiseControllerHardware>; name?: Nullable<string>; online?: Nullable<boolean>;
  zones?: Iterable<readonly [ number, HydrawiseZoneV2Facts ]>; } = {}): HydrawiseControllerV2Facts {

  return { hardware: overrides.hardware ?? null, name: overrides.name ?? null, online: overrides.online ?? null, zones: new Map(overrides.zones ?? []) };
}

/**
 * Compose one zone's account-credentialed facts, defaulting every field to the answer that says nothing: no name, no sensor reading, and no suspension.
 *
 * @param overrides - The facts to state.
 *
 * @returns A fresh per-zone facts value.
 */
export function makeZoneV2Facts(overrides: Partial<HydrawiseZoneV2Facts> = {}): HydrawiseZoneV2Facts {

  return { name: overrides.name ?? null, sensorStopped: overrides.sensorStopped ?? null, suspendedUntil: overrides.suspendedUntil ?? null };
}

// Options for buildPlatform: the platform config the real HydrawisePlatform reads through its bracket-access parameter. The account credentials travel as feature
// options rather than properties, because that is their only home, so a test that wants them supplies the entries the engine reads.
export interface BuildPlatformOptions {

  apiKey?: string;
  debug?: boolean;
  mqttTopic?: string;
  mqttUrl?: string;
  options?: string[];
}

// The handles buildPlatform returns: the constructed production platform, the API double with the knobs and views a test drives and reads it through, and the
// log capture. Each view is a function that reads the double's record when called, so it stays current however the result is destructured or copied.
export interface BuildPlatformResult {

  api: TestHomebridgeApi;

  // Emit a Homebridge lifecycle event on the API double, which is how a test fires DID_FINISH_LAUNCHING (to run the private configureHydrawise) and SHUTDOWN (to
  // drive teardown) explicitly.
  emit: (event: string) => void;

  // Every line the platform logged, read live, on the same terms as the controller harness reads its own.
  entries: readonly TestLogEntry[];

  // The UUIDs whose registration should throw, so a test can drive production's promotion-failure containment. Empty by default, which leaves every registration
  // reaching the API double.
  failRegistrationUuids: Set<string>;
  platform: HydrawisePlatform;

  // Every accessory a registration the API double accepted carried, in call order.
  registered: () => PlatformAccessory[];

  // Every accessory an unregistration the API double accepted carried, in call order.
  unregistered: () => PlatformAccessory[];

  // The accessories each cache save the API double accepted carried, one list per save. The read closes the platform's save window first, so a mark made on the
  // platform's real clock is saved before it is counted rather than a second after.
  updated: () => (readonly PlatformAccessory[])[];
}

/* The check-before-delegate gate the registration fail set answers to: any accessory the set names throws before the API double is called at all, so a rejected
 * registration leaves the double's record exactly as one Homebridge refused would.
 */
function rejectNamed(failUuids: ReadonlySet<string>, accessories: readonly PlatformAccessory[]): void {

  for(const accessory of accessories) {

    if(failUuids.has(accessory.UUID)) {

      throw new Error("Registration rejected for " + accessory.UUID + ".");
    }
  }
}

/* Construct a REAL HydrawisePlatform against HBPU's Homebridge API double - the platform-test workhorse. The construction-boundary casts (log, config, api)
 * bridge the doubles and the config literal to the production constructor's parameter types: Homebridge's Logging is a callable with prefix / success / log
 * members, so the plain-object capturing log bridges by cast rather than being reshaped into a callable, and the API double answers only the part of Homebridge's
 * API a plugin reaches. The platform's constructor runs its full networking and MQTT setup; a test installs a MockAgent afterward to drive retrieve().
 */
export function buildPlatform(options: BuildPlatformOptions = {}): BuildPlatformResult {

  const log = capturingLog();
  const api = new TestHomebridgeApi(runtime);
  const failRegistrationUuids = new Set<string>();
  const register = api.registerPlatformAccessories.bind(api);

  // The fail set wraps the API double's own registration on this instance, consulting the set before delegating, because the workhorse holds no test context to
  // mock through.
  api.registerPlatformAccessories = (pluginIdentifier, platformName, accessories): void => {

    rejectNamed(failRegistrationUuids, accessories);
    register(pluginIdentifier, platformName, accessories);
  };

  // The topic and the debug flag pass through exactly as the caller supplied them, with no default of their own, because a synthesized legacy value would
  // satisfy the platform's resolver on every build and put the catalog-default arm out of reach of any test. A setting left unnamed still resolves to the same
  // effective value, by way of the catalog registration.
  const config = {

    apiKey: options.apiKey ?? "test-api-key",
    debug: options.debug,
    mqttTopic: options.mqttTopic,
    mqttUrl: options.mqttUrl,
    options: options.options ?? []
  };

  // The construction-boundary casts (log, config, api) bridge the doubles and the config literal to the production constructor's parameter types.
  const platform = new HydrawisePlatform(log as unknown as ConstructorParameters<typeof HydrawisePlatform>[0],
    config as unknown as ConstructorParameters<typeof HydrawisePlatform>[1], api as unknown as API);

  const updated = (): (readonly PlatformAccessory[])[] => {

    platform.persistence.flush();

    return callsOf(api, "update");
  };

  return { api, emit: (event: string): void => void api.emit(event), entries: log.entries, failRegistrationUuids, platform,
    registered: () => callsOf(api, "register").flat(), unregistered: () => callsOf(api, "unregister").flat(), updated };
}

// The Hydrawise API origin every retrieve() request targets. The MockAgent intercepts against this origin, derived from the same base URL production assembles its
// requests on so an intercept and the request it stands in for can never target different hosts.
export const HYDRAWISE_ORIGIN = new URL(HYDRAWISE_API_BASE_URL).origin;

// The AsyncDisposable handle installMockDispatcher returns: the MockAgent to program replies on, disposed with `await using` to restore the prior global
// dispatcher and close the agent.
export interface MockDispatcherHandle extends AsyncDisposable {

  agent: MockAgent;
}

/* Install a MockAgent as undici's global dispatcher, snapshotting the dispatcher in place so dispose restores it exactly. undici's request() reads the global
 * dispatcher fresh per call, so a MockAgent installed after the platform's constructor already armed a real Pool intercepts every retrieve() from that point.
 * The returned handle is an AsyncDisposable bound with `await using`, so the prior dispatcher is restored and the agent closed at scope exit regardless of throw.
 */
export function installMockDispatcher(): MockDispatcherHandle {

  const prior = getGlobalDispatcher();
  const agent = new MockAgent();

  // Disable net connect so any unintercepted request fails loudly rather than reaching the real Hydrawise API.
  agent.disableNetConnect();
  setGlobalDispatcher(agent);

  return {

    agent,
    async [Symbol.asyncDispose](): Promise<void> {

      setGlobalDispatcher(prior);

      await agent.close();
    }
  };
}

/**
 * Program a JSON reply for a Hydrawise endpoint on the MockAgent, matched by endpoint substring so the api_key query string is ignored. Persists so a controller's
 * repeated polling loop keeps receiving the reply.
 *
 * @param agent    - The MockAgent returned by installMockDispatcher.
 * @param endpoint - The endpoint filename to match (for example "statusschedule.php").
 * @param body     - The JSON body to answer with.
 * @param statusCode - The HTTP status to answer with. Defaults to 200.
 */
export function programJsonReply(agent: MockAgent, endpoint: string, body: object | string, statusCode = 200): void {

  agent.get(HYDRAWISE_ORIGIN).intercept({ method: "GET", path: (path: string): boolean => path.includes(endpoint) }).reply(statusCode, body).persist();
}

/**
 * Program a persisted JSON reply for a Hydrawise endpoint that also counts the requests it serves. undici invokes the body callback once per matched request, so
 * the returned reader measures WIRE calls rather than logical retrieve() calls. That is the distinction a rate-budget assertion rests on: a draw that was dispatched
 * instead of awaited lets its caller fall straight through to the request, which shows up here as a request the ceiling should have withheld.
 *
 * @param agent    - The MockAgent returned by installMockDispatcher.
 * @param endpoint - The endpoint filename to match (for example "setzone.php").
 * @param body     - The JSON body to answer with.
 *
 * @returns A reader for the number of requests served so far.
 */
export function programCountedReply(agent: MockAgent, endpoint: string, body: object): () => number {

  let served = 0;

  agent.get(HYDRAWISE_ORIGIN).intercept({ method: "GET", path: (path: string): boolean => path.includes(endpoint) })
    .reply(200, (): object => {

      served++;

      return body;
    }).persist();

  return (): number => served;
}

/**
 * Program a reply that carries a body but a non-JSON status code path, which drives retrieve()'s status classification. Matched by endpoint substring, one-shot
 * unless persisted by the caller's scenario.
 *
 * @param agent      - The MockAgent returned by installMockDispatcher.
 * @param endpoint   - The endpoint filename to match.
 * @param statusCode - The HTTP status to answer with.
 * @param body       - The reply body. Defaults to an empty string.
 */
export function programStatusReply(agent: MockAgent, endpoint: string, statusCode: number, body: string | object = ""): void {

  agent.get(HYDRAWISE_ORIGIN).intercept({ method: "GET", path: (path: string): boolean => path.includes(endpoint) }).reply(statusCode, body);
}

/**
 * Wait for a read to answer a value, and hand that value back. This is the value-consuming form of the library's waitUntil, on its cadence and its deadline: a
 * wait whose result is not used calls waitUntil directly, and a wait that goes on to use what it waited for calls this.
 *
 * @param read    - Answers the awaited value, or undefined while it is not yet available.
 * @param options - waitUntil's own options: what the wait is for, and optionally its poll interval and deadline.
 *
 * @returns The value the read answered when the wait was satisfied.
 *
 * @throws If the read answers nothing but undefined within the deadline.
 */
export async function waitFor<T extends object>(read: () => T | undefined, options: Parameters<typeof waitUntil>[1]): Promise<T> {

  let value: T | undefined;

  // The predicate keeps the value it read, so the value handed back is the one that satisfied the wait rather than a second read taken a turn later.
  await waitUntil(() => (value = read()) !== undefined, options);

  return present(value, options.description);
}

/* Wait until the controller has completed the given number of status polls. The wait bounds on the call AFTER the counted ones, which guarantees the last counted
 * poll ran its whole projection before the caller reads a count or a save, and its deadline grows with the count, one second per poll plus one, because every
 * poll counted costs a wire call and a projection on the suite's fast cadence and a fixed deadline would hold only for the first few.
 *
 * @param h     - The built controller whose retrieve recorder counts the polls.
 * @param count - The number of polls that must have completed.
 */
export async function pollsCompleted(h: BuildControllerResult, count: number): Promise<void> {

  await waitUntil(() => h.retrieve.callsTo("statusschedule.php").length > count,
    { description: "status poll " + String(count + 1) + " to begin", timeoutMs: (count + 1) * 1000 });
}
