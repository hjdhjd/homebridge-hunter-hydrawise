/* Copyright(C) 2017-2026, HJD (https://github.com/hjdhjd). All rights reserved.
 *
 * platform.helpers.ts: The plugin-specific test harness - the platform double for controller tests, the API double for real-platform construction, the recording
 * MQTT client, the programmable retrieve recorder, the undici MockAgent installer, and the buildController / buildPlatform construction workhorses. Every cast
 * that bridges a double to a production constructor's parameter type is confined to a workhorse, so test bodies stay cast-free.
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
import { Characteristic, Service, TestAccessory, TestHapStatusError, makeTestAccessory } from "./hap.helpers.ts";
import type { Clock, HomebridgePluginLogging, Nullable, RateBudget } from "homebridge-plugin-utils";
import { FeatureOptions, HAPStatus, TimerRegistry, sanitizeName, systemClock } from "homebridge-plugin-utils";
import type { HydrawiseAccessory, HydrawiseControllerConfig, HydrawiseControllerHardware, HydrawiseControllerIdentity, HydrawiseControllerV2Facts,
  HydrawiseV2MutationResult, HydrawiseZoneSuspensionResult, HydrawiseZoneV2Facts } from "../types.ts";
import { MockAgent, getGlobalDispatcher, setGlobalDispatcher } from "undici";
import { TestMqttClient, capturingLog, present, waitUntil } from "homebridge-plugin-utils/testing";
import { featureOptionCategories, featureOptions } from "../options.ts";
import type { Dispatcher } from "undici";
import { HYDRAWISE_API_BASE_URL } from "../settings.ts";
import { HydrawiseController } from "../controller.ts";
import type { HydrawiseOptions } from "../options.ts";
import { HydrawisePlatform } from "../platform.ts";
import type { TestLogEntry } from "homebridge-plugin-utils/testing";
import { syntheticController } from "../api.fixtures.ts";
import { zoneAccessoryId } from "../types.ts";

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

/* The HAP namespace shape every double in this file exposes: the Service / Characteristic test namespaces, the status enum and the status error class a refusal is
 * built from, and a deterministic uuid generator that echoes its input, so an accessory's UUID is simply the controller id string production hands it. The enum is
 * the library's own mirror of HAP's, so a refusal row compares against the very values production throws with.
 */
interface TestHap {

  Characteristic: typeof Characteristic;
  HAPStatus: typeof HAPStatus;
  HapStatusError: typeof TestHapStatusError;
  Service: typeof Service;
  uuid: { generate: (data: string) => string };
}

const testHap: TestHap = { Characteristic, HAPStatus, HapStatusError: TestHapStatusError, Service, uuid: { generate: (data: string): string => data } };

/**
 * Whether a thrown value is the refusal the Not Responding rule throws: the status error double carrying the communication-failure status, the one HomeKit
 * renders as No Response. A refusal row hands this to `assert.rejects`, so it asserts the class and the status together rather than only that something threw.
 *
 * @param error - The value a refused read or write rejected with.
 *
 * @returns True when the value is that refusal.
 */
export function isNotResponding(error: unknown): boolean {

  return (error instanceof TestHapStatusError) && (error.hapStatus === HAPStatus.SERVICE_COMMUNICATION_FAILURE);
}

// One recorded reconcileZoneAccessories call: the whole argument object the controller passed. Typed off the production signature, so a test reads the request the
// projection actually built - which zones it named standalone, the display name each carried, and the pre-enablement relay-id population.
export type RecordedReconcileCall = Parameters<HydrawisePlatform["reconcileZoneAccessories"]>[0];

// The platform double's read surface, as the controller and its configure chain consume it. The construction-boundary cast to HydrawisePlatform happens in
// buildController. The api carries updatePlatformAccessories because the controller flushes its persisted zone roster through it; the double records each flush.
// reconcileZoneAccessories is typed by indexed access against the real method, so a signature drift is a compile error here rather than a silent mismatch.
export interface TestPlatform {

  api: { hap: TestHap; updatePlatformAccessories: (accessories: TestAccessory[]) => void };

  // The time source every wait and stamp a controller takes reads, standing in for the production platform's own clock. Typed as the production Clock because that is
  // the whole of what a controller consumes; a test that drives time holds its own TestClock handle.
  clock: Clock;
  config: HydrawiseOptions;
  featureOptions: FeatureOptions;
  hap: TestHap;
  hasV2Client: boolean;
  log: HomebridgePluginLogging;
  mqtt: Nullable<TestMqttClient>;
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

// The handles makeTestPlatform returns: the platform double plus the doubles and capture buffers a test asserts against and the lever to abort a live signal. The
// flushes buffer records every updatePlatformAccessories call the controller makes, so a test asserts on the zone-roster flush cadence.
export interface MakeTestPlatformResult {

  abort: (reason?: string) => void;

  // The clock the platform double publishes: the caller's own when it passed one, and the system clock otherwise.
  clock: Clock;

  // Every line the platform double logged, read live: the array grows as the code under test logs, so a read always sees everything logged so far.
  entries: readonly TestLogEntry[];
  flushes: TestAccessory[][];
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
  zoneAccessories: Map<number, TestAccessory>;
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
  const retrieve = new RetrieveRecorder();
  const flushes: TestAccessory[][] = [];
  const reconciles: RecordedReconcileCall[] = [];
  const zoneAccessories = new Map<number, TestAccessory>();
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
   * requested zone (reusing a stored one, whether the stub made it or a test seeded it), and drops the entries the request does not name. The grace window,
   * the context writes, and the promotion-failure containment are the platform's contract and are asserted in its own suite, so nothing of them is reimplemented
   * here: the stub honors exactly what each call asks for.
   *
   * It NEVER calls updatePlatformAccessories. The roster suite asserts exact flush counts across multi-poll runs, so a stub that flushed would break that net
   * without any production change behind it.
   */
  const reconcileZoneAccessories: HydrawisePlatform["reconcileZoneAccessories"] = (request) => {

    reconciles.push(request);

    const requestedIds = new Set(request.zones.map(zone => zone.identity.relayId));

    for(const relayId of zoneAccessories.keys()) {

      if(!requestedIds.has(relayId)) {

        zoneAccessories.delete(relayId);
      }
    }

    const hosts = new Map<number, HydrawiseAccessory>();

    for(const zone of request.zones) {

      // The display name is sanitized on creation exactly as the production reconcile sanitizes it, so a test measuring name-synchronization writes sees the same
      // starting state the real platform would hand the controller.
      const accessory = zoneAccessories.get(zone.identity.relayId) ??
        new TestPlatformAccessory(sanitizeName(zone.displayName), zoneAccessoryId(request.controller.controller_id, zone.identity.relayId));

      zoneAccessories.set(zone.identity.relayId, accessory);

      // The double-to-production cast is confined to this workhorse, exactly as the construction-boundary casts below are.
      hosts.set(zone.identity.relayId, accessory as unknown as HydrawiseAccessory);
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

    api: { hap: testHap, updatePlatformAccessories: (accessories: TestAccessory[]): void => { flushes.push(accessories); } },
    clock,
    config,
    featureOptions: featureOpts,
    hap: testHap,
    hasV2Client: options.hasV2Client ?? false,
    log,
    mqtt,
    reconcileZoneAccessories,
    retrieve: retrieve.retrieve,
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

  // Seed the accessory context before construction, as Homebridge does when it restores a cached accessory. Runs before the controller constructs, so a test can
  // prove configureDevice's wipe-then-seed preserves (or shape-degrades) a prior persisted zone roster.
  seedContext?: (accessory: TestAccessory) => void;
}

// The handles buildController returns: the constructed production controller plus the underlying doubles and capture buffers a test asserts against.
export interface BuildControllerResult extends MakeTestPlatformResult {

  accessory: TestAccessory;
  controller: HydrawiseController;
  controllerConfig: HydrawiseControllerConfig;
}

/* Construct a REAL HydrawiseController against the doubles - the controller-test workhorse. The construction-boundary casts (platform, accessory) bridge the
 * doubles to the production constructor's parameter types; everything the controller then does runs the real production code against the doubles. Returns
 * the constructed controller plus every handle a test asserts on: the TestAccessory (to read services and characteristics), the capture buffers, the
 * recording MQTT double, and the retrieve recorder.
 */
export function buildController(options: BuildControllerOptions = {}): BuildControllerResult {

  const platformResult = makeTestPlatform(options);
  const controllerConfig: HydrawiseControllerConfig = { ...syntheticController, ...options.controller };
  const accessory = makeTestAccessory(options.accessoryName ?? controllerConfig.name, testHap.uuid.generate(controllerConfig.controller_id.toString()));
  const roster: HydrawiseControllerIdentity[] = options.roster ?? [{ controllerId: controllerConfig.controller_id, name: controllerConfig.name,
    serialNumber: controllerConfig.serial_number }];

  // Seed the accessory context before construction, as Homebridge restores a cached accessory ahead of configure, so a test can drive the preservation path.
  options.seedContext?.(accessory);

  // Seed the recorder before construction, because the controller's polling loop issues its first retrieve synchronously as the constructor runs.
  options.program?.(platformResult.retrieve);

  // The construction-boundary casts (platform, accessory) bridge the doubles to the production constructor's parameter types.
  const controller = new HydrawiseController(platformResult.platform as unknown as ConstructorParameters<typeof HydrawiseController>[0],
    accessory as unknown as ConstructorParameters<typeof HydrawiseController>[1], controllerConfig, roster);

  return { accessory, controller, controllerConfig, ...platformResult };
}

// A double of Homebridge's PlatformAccessory constructor: `new api.platformAccessory(name, uuid, category)` yields a TestAccessory, exactly what the real
// platform's one accessory-creation path does.
class TestPlatformAccessory extends TestAccessory {}

// A recorded HAP event handler registered through api.on. The platform stores its DID_FINISH_LAUNCHING and SHUTDOWN handlers here; a test fires them explicitly.
type ApiEventHandler = () => void;

// The API double's surface and the capture buffers a platform test asserts against.
export interface TestApiResult {

  api: unknown;
  emit: (event: string) => void;

  // The UUIDs whose registration should throw, so a test can drive production's promotion-failure containment. Empty by default, which leaves every registration
  // succeeding exactly as before.
  failRegistrationUuids: Set<string>;

  // The UUIDs whose cache flush should throw, so a test can drive the arm where an accessory registers and then fails to persist - the one path that reaches
  // production's promotion undo. Empty by default, which leaves every flush recording exactly as before.
  failUpdateUuids: Set<string>;
  makeAccessory: (displayName: string, uuid: string, category?: number) => TestAccessory;
  registered: TestAccessory[];
  unregistered: TestAccessory[];
  updated: TestAccessory[][];
}

/* Build the API double for real-platform construction. hap carries the double namespaces and the deterministic uuid generator; platformAccessory is the
 * constructable accessory double; register / update / unregister record their accessories; on captures each handler by event name so a test fires
 * DID_FINISH_LAUNCHING (to run the private configureHydrawise) and SHUTDOWN (to drive teardown) explicitly. emit invokes every handler registered for an event.
 */
export function makeTestApi(): TestApiResult {

  const handlers = new Map<string, ApiEventHandler[]>();
  const failRegistrationUuids = new Set<string>();
  const failUpdateUuids = new Set<string>();
  const registered: TestAccessory[] = [];
  const unregistered: TestAccessory[] = [];
  const updated: TestAccessory[][] = [];

  /* The one check-before-record gate the recording closures answer to: any accessory the fail set names throws before a single entry lands in a buffer, so a
   * rejected call leaves the recorded state exactly as a real failure would. The knobs share this check rather than each closure carrying its own mirrored
   * loop, so they can never drift apart in what "rejected" means.
   */
  const rejectNamed = (failUuids: Set<string>, accessories: TestAccessory[], action: string): void => {

    for(const accessory of accessories) {

      if(failUuids.has(accessory.UUID)) {

        throw new Error(action + " rejected for " + accessory.UUID + ".");
      }
    }
  };

  const api = {

    hap: testHap,
    on: (event: string, handler: ApiEventHandler): unknown => {

      const list = handlers.get(event) ?? [];

      list.push(handler);
      handlers.set(event, list);

      return api;
    },
    platformAccessory: TestPlatformAccessory,
    registerPlatformAccessories: (_plugin: string, _platform: string, accessories: TestAccessory[]): void => {

      rejectNamed(failRegistrationUuids, accessories, "Registration");

      registered.push(...accessories);
    },
    unregisterPlatformAccessories: (_plugin: string, _platform: string, accessories: TestAccessory[]): void => { unregistered.push(...accessories); },
    updatePlatformAccessories: (accessories: TestAccessory[]): void => {

      rejectNamed(failUpdateUuids, accessories, "Cache flush");

      updated.push(accessories);
    }
  };

  const emit = (event: string): void => {

    for(const handler of handlers.get(event) ?? []) {

      handler();
    }
  };

  return { api, emit, failRegistrationUuids, failUpdateUuids,
    makeAccessory: (displayName: string, uuid: string, category?: number): TestAccessory => new TestPlatformAccessory(displayName, uuid, category), registered,
    unregistered, updated };
}

/**
 * Seed a cached accessory onto a real platform through its configureAccessory path, as Homebridge does when it restores accessories before DID_FINISH_LAUNCHING.
 * The construction-boundary cast to the PlatformAccessory parameter type is confined here so a configure test's body stays cast-free.
 *
 * The optional setup runs on the fresh accessory BEFORE the platform sees it, which is where Homebridge's cache restore puts the services and the context a
 * previous session left behind. That ordering is what lets a restore row reach the handlers the platform binds on the primary characteristic at restore.
 *
 * @param platform    - The real HydrawisePlatform to seed.
 * @param displayName - The cached accessory's display name.
 * @param uuid        - The cached accessory's UUID (the platform matches this against the generated controller UUID to reuse it).
 * @param setup       - Optionally, what the cache carried: the services, and a zone accessory's context, added before the platform is handed the accessory.
 *
 * @returns The seeded TestAccessory, so a test can read its services after discovery reuses it.
 */
export function seedAccessory(platform: HydrawisePlatform, displayName: string, uuid: string, setup?: (accessory: TestAccessory) => void): TestAccessory {

  const accessory = new TestPlatformAccessory(displayName, uuid);

  setup?.(accessory);

  platform.configureAccessory(accessory as unknown as Parameters<HydrawisePlatform["configureAccessory"]>[0]);

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

// The handles buildPlatform returns: the constructed production platform plus the API double's capture buffers and the log capture.
export interface BuildPlatformResult extends TestApiResult {

  // Every line the platform logged, read live, on the same terms as the controller harness reads its own.
  entries: readonly TestLogEntry[];
  platform: HydrawisePlatform;
}

/* Construct a REAL HydrawisePlatform against the API double - the platform-test workhorse. The construction-boundary casts (log, api) bridge the doubles to
 * the production constructor's parameter types: Homebridge's Logging is a callable with prefix / success / log members, so the plain-object capturing log
 * bridges by cast rather than being reshaped into a callable. The platform's constructor runs its full networking and MQTT setup; a test installs a
 * MockAgent afterward to drive retrieve().
 */
export function buildPlatform(options: BuildPlatformOptions = {}): BuildPlatformResult {

  const log = capturingLog();
  const apiResult = makeTestApi();

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

  // The construction-boundary casts (log, api) bridge the doubles to the production constructor's parameter types.
  const platform = new HydrawisePlatform(log as unknown as ConstructorParameters<typeof HydrawisePlatform>[0],
    config as unknown as ConstructorParameters<typeof HydrawisePlatform>[1], apiResult.api as ConstructorParameters<typeof HydrawisePlatform>[2]);

  return { entries: log.entries, platform, ...apiResult };
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
 * poll ran its whole projection before the caller reads a count or a flush, and its deadline grows with the count, one second per poll plus one, because every
 * poll counted costs a wire call and a projection on the suite's fast cadence and a fixed deadline would hold only for the first few.
 *
 * @param h     - The built controller whose retrieve recorder counts the polls.
 * @param count - The number of polls that must have completed.
 */
export async function pollsCompleted(h: BuildControllerResult, count: number): Promise<void> {

  await waitUntil(() => h.retrieve.callsTo("statusschedule.php").length > count,
    { description: "status poll " + String(count + 1) + " to begin", timeoutMs: (count + 1) * 1000 });
}
