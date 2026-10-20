/* Copyright(C) 2017-2026, HJD (https://github.com/hjdhjd). All rights reserved.
 *
 * platform.ts: homebridge-hunter-hydrawise platform class.
 */
import type { API, DynamicPlatformPlugin, HAP, Logging, PlatformAccessory, PlatformConfig } from "homebridge";
import { APIEvent, API_RETRY_STATUS_CODES, FeatureOptions, RateBudget, TimerRegistry, classifyTransportError, composeSignals, createApiDispatcher,
  createMqttClient, debugGatedLog, loopFaultReporter, retry, sanitizeName, superviseLoop, systemClock } from "homebridge-plugin-utils";
import type { Categories, Clock, HomebridgePluginLogging, MqttClient, Nullable } from "homebridge-plugin-utils";
import type { CustomerDetailsResponse, HydrawiseAccessory, HydrawiseAccessoryContext, HydrawiseControllerAccessory, HydrawiseControllerConfig,
  HydrawiseControllerIdentity, HydrawiseEndpoint, HydrawiseZoneIdentity, HydrawiseZoneSuspensionResult } from "./types.ts";
import { HYDRAWISE_API_BASE_URL, HYDRAWISE_API_BUDGET_CALLS, HYDRAWISE_API_BUDGET_WINDOW, HYDRAWISE_API_RETRY_INTERVAL, HYDRAWISE_API_TIMEOUT,
  HYDRAWISE_COMMAND_BUDGET_CALLS, HYDRAWISE_COMMAND_BUDGET_WINDOW, HYDRAWISE_COMMAND_ENDPOINT, HYDRAWISE_TRANSPORT_FAULT_SENTENCES,
  HYDRAWISE_V2_BUDGET_CALLS, HYDRAWISE_V2_BUDGET_WINDOW, HYDRAWISE_V2_MUTATION_BUDGET_CALLS, HYDRAWISE_V2_MUTATION_BUDGET_WINDOW,
  HYDRAWISE_V2_REFRESH_INTERVAL, HYDRAWISE_ZONE_ACCESSORY_CATEGORY, HYDRAWISE_ZONE_ACCESSORY_GRACE_POLLS, PLATFORM_NAME, PLUGIN_NAME } from "./settings.ts";
import type { HydrawiseGlobalFlagOption, HydrawiseGlobalValueOption, HydrawiseOptions } from "./options.ts";
import { controllerIdentity, isZoneAccessoryContext, sameControllerIdentity, sameZoneIdentity, zoneAccessoryId } from "./types.ts";
import { featureOptionCategories, featureOptions } from "./options.ts";
import { request, setGlobalDispatcher } from "undici";
import type { Dispatcher } from "undici";
import { HydrawiseController } from "./controller.ts";
import { HydrawiseV2Client } from "./v2.ts";
import { STATUS_CODES } from "node:http";
import util from "node:util";

/* The statuses that share the temporarily-unavailable sentence in retrieve(), derived from the list the transport itself retries so the two can never disagree: a
 * status the transport retries is, by definition, one this plugin describes as transient once the retries run out. 404 and 429 are members for that reason but never
 * reach that classification, because each returns from its own dedicated branch first.
 */
const RETRYABLE_STATUSES: ReadonlySet<number> = new Set(API_RETRY_STATUS_CODES);

export class HydrawisePlatform implements DynamicPlatformPlugin {

  private readonly accessories: HydrawiseAccessory[];
  private account: CustomerDetailsResponse;
  private readonly accountBudget: RateBudget;
  public readonly api: API;

  /* The one time source every wait this plugin schedules reads, and the clock every controller stamps its account facts and its commands against. It is the
   * production clock in the field and a controllable one under the platform double, so a suite drives a controller's cadence on a virtual timeline instead of
   * serving it out in real seconds.
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
  private readonly shutdownController: AbortController;
  public readonly signal: AbortSignal;
  public readonly timers: TimerRegistry;
  private readonly v2Budget: RateBudget;
  private readonly v2Client?: HydrawiseV2Client;
  private readonly v2MutationBudget: RateBudget;

  /* Everything shutdown has to undo, declared in one place and disposed in one call. A DisposableStack runs its registered work in reverse registration order, so
   * the ordering teardown depends on is expressed by the order things are registered rather than by a handler body that has to be read to be trusted, and the
   * order and the work stay together at each registration site.
   *
   * The SYNCHRONOUS variant, deliberately: every teardown this platform registers completes synchronously, and Homebridge's shutdown is observable within the
   * single frame that fires it, so the asynchronous stack would insert a microtask gap between disposers and buy nothing in return. The class is reached as a
   * platform global, which the entry point's polyfill import guarantees exists on every runtime this package supports.
   */
  private readonly teardown = new DisposableStack();

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

  /* The wire-absence grace state behind reconcileZoneAccessories, keyed by zone-accessory UUID and holding that accessory's count of consecutive polls whose report
   * omitted its zone. It lives in memory only and is deliberately not persisted: a restart clears it, which errs toward RETAINING a HomeKit identity the user
   * placed in a room rather than toward destroying one, and the count rebuilds from the next few polls at no cost.
   */
  private readonly zoneAccessoryGrace = new Map<string, number>();

  constructor(log: Logging, config: PlatformConfig | undefined, api: API) {

    // PlatformConfig exposes user values through an any-typed index signature, so we read each value through a bracket-access cast to its declared type and keep the
    // reads type-checked rather than any. We resolve the options list once and share it between the feature-options engine and our own config snapshot.
    const options = (config?.["options"] as string[] | undefined) ?? [];

    this.accessories = [];
    this.account = {} as CustomerDetailsResponse;
    this.api = api;
    this.clock = systemClock;
    this.configuredDevices = {};
    this.featureOptions = new FeatureOptions(featureOptionCategories, featureOptions, options);
    this.hap = api.hap;

    /* Wrap the Homebridge logger in the library's config-gated composition: our debug output emits through warn - visible without Homebridge's own debug switch -
     * whenever the user's debug setting says so, read live on every call, and every other level passes straight through. Wrapping rather than mutating leaves the
     * logger Homebridge handed us untouched, and that object stays Homebridge's own.
     */
    this.log = debugGatedLog(log, (): boolean => this.config.debug === true);
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
     * The account-wide and zone-command budgets make the ceilings Hydrawise publishes for its key-based API enforceable. The account-credentialed budgets are
     * envelopes instead, because that API publishes no ceiling at all and throttles hard, and they are separate from each other because the traffic they pace is:
     * the scheduled reads and the token grants they carry draw one, while the per-zone commands a user is standing at a switch waiting for draw the other.
     */
    this.accountBudget = new RateBudget({ capacity: HYDRAWISE_API_BUDGET_CALLS, clock: this.clock, signal: this.signal,
      window: HYDRAWISE_API_BUDGET_WINDOW * 1000 });
    this.commandBudget = new RateBudget({ capacity: HYDRAWISE_COMMAND_BUDGET_CALLS, clock: this.clock, signal: this.signal,
      window: HYDRAWISE_COMMAND_BUDGET_WINDOW * 1000 });
    this.v2Budget = new RateBudget({ capacity: HYDRAWISE_V2_BUDGET_CALLS, clock: this.clock, signal: this.signal, window: HYDRAWISE_V2_BUDGET_WINDOW * 1000 });
    this.v2MutationBudget = new RateBudget({ capacity: HYDRAWISE_V2_MUTATION_BUDGET_CALLS, clock: this.clock, signal: this.signal,
      window: HYDRAWISE_V2_MUTATION_BUDGET_WINDOW * 1000 });

    // The one home for every deferred HomeKit write this plugin arms, shared by every controller the platform builds. Construction schedules nothing, so it is
    // built here beside the budgets, ahead of the missing-API-key return below. Its lifetime IS the shutdown signal - the abort drains whatever is pending and
    // leaves every later registration inert - so it takes no teardown-stack registration of its own, on the same terms as the MQTT client below.
    this.timers = new TimerRegistry({ clock: this.clock, signal: this.signal });

    /* Assemble the effective configuration. This is the one place a raw configuration property and a configured feature option meet: every consolidated setting
     * resolves through the engine's one precedence here - an explicitly configured option rules in every state it can be in, a legacy configuration property
     * otherwise outranks the catalog default, and the default closes the chain - so no reader downstream has to know that a setting has two possible homes. The
     * legacy arm is transitional and sunsets at the plugin's next major version, at which point the option is the only home a setting has.
     *
     * The engine takes any option name, so each read states its name against the catalog's global unions through `satisfies`, which keeps a misspelled or
     * wrongly scoped name a compile error. A legacy property keeps this file's bracket-access cast posture, and a non-string smuggled past that cast by a
     * hand-edited configuration degrades safely at every consumer: the API key gate reads it as no key, and the MQTT factory reads it as nothing configured.
     */
    this.config = {

      apiKey: this.featureOptions.consolidatedValue({ fallback: config?.["apiKey"] as string | undefined,
        option: "Account.ApiKey" satisfies HydrawiseGlobalValueOption }) ?? "",
      debug: this.featureOptions.consolidatedFlag({ fallback: (typeof config?.["debug"] === "boolean") ? config["debug"] : undefined,
        option: "Log.Debug" satisfies HydrawiseGlobalFlagOption }),
      mqttTopic: this.featureOptions.consolidatedValue({ fallback: config?.["mqttTopic"] as string | undefined,
        option: "Mqtt.Topic" satisfies HydrawiseGlobalValueOption }),
      mqttUrl: this.featureOptions.consolidatedValue({ fallback: config?.["mqttUrl"] as string | undefined,
        option: "Mqtt.Url" satisfies HydrawiseGlobalValueOption }),
      options,

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

      this.v2Client = new HydrawiseV2Client({ budget: this.v2Budget, log: this.log, mutationBudget: this.v2MutationBudget, password: this.config.password,
        signal: this.signal, username: this.config.username });

      this.log.info("Enhanced features are enabled using your Hydrawise account login.");
    }

    /* Initialize MQTT, if needed. The guarded factory answers null for each of the ways MQTT can fail to start - a broker URL or topic prefix that resolves to
     * nothing, and a URL the client cannot parse - so a mistyped MQTT setting degrades to MQTT being off rather than keeping the rest of the plugin from
     * loading. An unusable URL is reported once at error level, with the URL itself redacted so a broker password embedded in it never reaches the log. The
     * platform's shutdown signal ties the client's lifetime to ours.
     */
    this.mqtt = createMqttClient({ brokerUrl: this.config.mqttUrl, log: this.log, topicPrefix: this.config.mqttTopic }, { signal: this.signal });

    this.log.debug("Debug logging on. Expect a lot of data.");

    // Fire up the Hydrawise API once Homebridge has loaded all the cached accessories it knows about and called configureAccessory() on each. We supervise the
    // discovery loop so a genuine configuration fault surfaces once through the reporter, while a shutdown abort unwinds it silently.
    api.on(APIEvent.DID_FINISH_LAUNCHING, () => void superviseLoop({ loop: () => this.configureHydrawise(), onError: loopFaultReporter(this.log, "controller discovery"),
      signal: this.signal }));

    // Tear ourselves down cleanly when Homebridge shuts down. This is the single owner of platform shutdown, and it is one call: disposing the stack runs every
    // registered teardown, synchronously, inside this frame.
    api.on(APIEvent.SHUTDOWN, () => this.teardown.dispose());

    /* Register that teardown work last, once everything it undoes has actually been built. Disposal is reverse registration order, so the dispatcher destroys named
     * first here run LAST and the signal abort named last runs FIRST: the abort cancels every signal-aware resource we own - the MQTT client, the retry waits, the
     * polling loops, the rate-budget waits - and the destroys then close the keep-alive Pool connections so they do not outlive us.
     *
     * Each dispatcher is read live at disposal time rather than captured here, which keeps these registrations correct across the destroy-and-rearm each transport
     * performs when a request times out. The v2 client registers only its dispatcher, because that pool is the whole of what it holds: its token renewal is lazy, so
     * there is no timer to drain. The MQTT client gets no registration of its own: its lifetime IS the composed shutdown signal the abort already ends, so
     * registering it here would tear it down a second time.
     */
    this.teardown.defer(() => void this.dispatcher?.destroy());
    this.teardown.defer(() => void this.v2Client?.dispatcher.destroy());
    this.teardown.defer(() => this.shutdownController.abort("shutdown"));
  }

  // This gets called when homebridge restores cached accessories at startup. We intentionally avoid doing anything significant here, and save all that logic for
  // Hydrawise API enumeration.
  public configureAccessory(accessory: HydrawiseAccessory): void {

    this.accessories.push(accessory);
  }

  // Configure and connect to the Hydrawise API.
  private async configureHydrawise(): Promise<void> {

    // Retrieve the account's controllers, retrying forever at a fixed 60-second cadence against the rate-limited API. The retried operation covers only the network
    // truth - the request and the JSON parse - and throws on any failure so retry loops; a resolved value is a successful fetch. Everything downstream runs once,
    // outside the retry, so a genuine configuration fault escapes to the supervisor's reporter rather than becoming a silent 60-second retry.
    this.account = await retry(async (): Promise<CustomerDetailsResponse> => {

      const response = await this.retrieve("customerdetails.php");

      // A null response is either a recoverable API error retrieve() already logged, or a shutdown abort it left silent. Throw so retry waits and tries again.
      if(!response) {

        throw new Error("Unable to retrieve the list of controllers.");
      }

      try {

        return await response.body.json() as CustomerDetailsResponse;
      } catch(error) {

        // A shutdown abort mid-read is orderly teardown - rethrow quietly so the retry loop unwinds through its own signal without logging a spurious parse failure.
        if(this.signal.aborted) {

          throw error;
        }

        this.log.error("Unable to retrieve the list of controllers: %s", util.inspect(error, { colors: true, depth: null, sorted: true }));

        throw error;
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

    // Find all the orphaned accessories this account does not claim and remove them, clearing any grace state a removed accessory carried. We walk a filtered
    // SNAPSHOT of the tracked array so the removal splice never races the walk that drives it.
    for(const accessory of this.accessories.filter(entry => this.isOrphanedAccessory(entry))) {

      this.zoneAccessoryGrace.delete(accessory.UUID);
      this.removeAccessory(accessory);
    }
  }

  /* Start the endless loop that refreshes every controller's account-credentialed facts, once, and only for an install that configured the credentials making it
   * possible. Without a client no loop starts, no call is spent, and nothing is logged - an install carrying only an API key behaves exactly as it always has.
   *
   * One query for the whole account rather than one per controller is what the v2 ceiling demands - it admits a handful of calls per half hour, so a per-controller
   * query would spend the whole allowance on a multi-controller install - and it is also the shape v1 discovery already uses: fetch the account once, then hand
   * each controller its own share.
   *
   * The loop is SEQUENTIAL - refresh, then sleep - which is what makes overlap unrepresentable rather than guarded against: the next tick cannot begin until the
   * current one has finished, however long the account takes to answer. It is supervised on the same terms as every other endless loop this plugin runs, so a
   * shutdown abort unwinds it silently through the sleep while a genuine fault is reported once. The narrowed client is captured in a local before dispatch so the
   * loop body needs no assertion about a field it cannot see reassigned.
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
        await this.refreshV2Facts(client);

        // eslint-disable-next-line no-await-in-loop
        await this.clock.delay(HYDRAWISE_V2_REFRESH_INTERVAL * 1000, { signal: this.signal });
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
   */
  private async refreshV2Facts(client: HydrawiseV2Client): Promise<void> {

    const fetchedAt = Math.floor(this.clock.now() / 1000);
    const facts = await client.fetchAccountFacts();

    if(!facts) {

      return;
    }

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
     * kinds because the webUI lists the whole account from any one accessory. Each controller writes and flushes only when its own copy actually moved.
     */
    const roster = this.account.controllers.map(controller => this.configuredController(controller)?.identity ?? controllerIdentity(controller));

    for(const controller of this.account.controllers) {

      this.configuredController(controller)?.applyRoster(roster);
    }
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

  /** Suspend one zone until an instant, or resume it - the single per-zone write surface every controller commands through, exactly as retrieve() is the single
   * key-based one. The account-credentialed client stays private to this class, so what a controller ever sees is the outcome alone.
   *
   * The pre-check reads the COMMAND ceiling, which is the one a command draws, and it answers the common saturated case for FREE: a ceiling with nothing to give
   * refuses here having touched no connection and spent no call, which is what keeps a burst of taps from costing the account anything. On its own it carries a
   * check-then-act race - two near-simultaneous callers can both read the last free slot - and the client's admission phase is what closes it, bounding the loser
   * to a beat rather than to the budget's own hour-wide window.
   *
   * The unavailable answer is honest rather than reachable from a live switch: those switches exist only where a client does, and that is fixed at construction. It
   * is what any other caller gets.
   *
   * @param options        - The command.
   * @param options.until  - The absolute instant, in epoch seconds, the suspension lifts, or null to resume the zone.
   * @param options.zoneId - The zone to command, named by the id the key-based and account APIs agree about.
   *
   * @returns What became of the command: accepted, attempted and refused, never admitted, or impossible for want of a client.
   */
  public async setZoneSuspension(options: { until: Nullable<number>; zoneId: number }): Promise<HydrawiseZoneSuspensionResult> {

    if(!this.v2Client) {

      return { status: "unavailable" };
    }

    if(this.v2MutationBudget.available === 0) {

      return { status: "rejected" };
    }

    return this.v2Client.setZoneSuspension(options);
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

    /* The name a FRESH accessory is created under: the user's Name option when they set one, and the name Hydrawise reports otherwise. A cached accessory keeps
     * whatever display name it came back with, which is what keeps discovery from renaming a controller behind the synchronization opt-out's back.
     *
     * The read presents the serial and nothing else, which is the single-id rule every runtime reader of this option keeps: the option resolves at the controller
     * and the zone alike, so a read carrying a second id would answer with something written for another scope.
     */
    const nameOverride = this.featureOptions.value("Device.Name", controller.serial_number)?.trim();

    accessory ??= this.addAccessory(sanitizeName(nameOverride?.length ? nameOverride : controller.name), uuid);

    this.log.info("Configuring irrigation controller: %s (serial: %s id: %s).", controller.name, controller.serial_number, controller.controller_id);

    /* Add it to our list of configured devices. The controller seeds its accessory context during construction; the flush just below persists that seed.
     *
     * The cast to the controller arm is sound by construction, and it is the one place the narrowing cannot be derived from a predicate. A controller
     * accessory's UUID is seeded from the bare controller_id above, while every zone accessory's is seeded from the `.Zone.`-infixed compound, so the
     * controller UUID space and the zone UUID space cannot collide and an accessory found or created under a controller UUID can only be a controller
     * accessory. The controller writes its own context fields one at a time, which the arm's mutable interface is what allows.
     */
    this.configuredDevices[uuid] = new HydrawiseController(this, accessory as HydrawiseControllerAccessory, controller, roster);

    this.api.updatePlatformAccessories([accessory]);

    return this.configuredDevices[uuid];
  }

  /* The one creation path for every accessory this platform registers: construct it, register it with Homebridge, and track it. Every creation cadence -
   * discovery-time controller accessories and poll-time standalone zone accessories alike - lands here, so the registration and the tracked array can never
   * disagree about what exists. The category is optional: a controller accessory takes the PlatformAccessory constructor's own default, while a zone accessory
   * declares itself a sprinkler so the Home app renders a lone valve correctly.
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

    // Unregister the accessory and delete its remnants from HomeKit.
    this.api.unregisterPlatformAccessories(PLUGIN_NAME, PLATFORM_NAME, [accessory]);
    this.accessories.splice(index, 1);
    this.api.updatePlatformAccessories(this.accessories);
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
   * The flush shape differs by arm, and every one of them is strictly on-change. A demotion flushes the whole array through removeAccessory's own tail, while a
   * creation or a context refresh flushes just its accessory. A poll on which a zone is renamed on the wire can therefore produce this context flush and the
   * controller's own accessory-name flush for the same accessory - two flushes on one rename poll, self-limiting and accepted.
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

      // REQUESTED: the zone is still standalone and still reported. Clearing its counter here - in the arm every healthy zone visits - is what makes a
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

    // Promote each requested zone, establishing its accessory when it has none and keeping its persisted identity current.
    for(const zone of zones) {

      const uuid = this.hap.uuid.generate(zoneAccessoryId(controller.controller_id, zone.identity.relayId));
      let accessory = this.accessories.find(entry => entry.UUID === uuid);

      // The accessory this call itself registered, if any. It is the only thing a fault below may undo: an accessory that already existed is not this call's to
      // remove, and one whose registration threw was never tracked in the first place.
      let created: Nullable<HydrawiseAccessory> = null;

      /* The whole per-zone sequence sits in one try. A fault establishing one zone must never end the controller's polling loop, and must leave no ghost behind:
       * we undo a registration this call performed, omit the zone from the returned map - which sends the controller's hosting back to the controller accessory
       * for this poll - and carry on with the remaining zones. The next poll retries.
       */
      try {

        if(!accessory) {

          accessory = this.addAccessory(sanitizeName(zone.displayName), uuid, HYDRAWISE_ZONE_ACCESSORY_CATEGORY);
          created = accessory;

          // A fresh accessory starts with a fresh grace window even when an earlier accessory at this UUID was removed for sustained absence, so an inherited
          // count can never truncate the new one.
          this.zoneAccessoryGrace.delete(uuid);

          this.log.info("%s: Added a standalone HomeKit accessory for this zone so it can be assigned to a room. Automations, scenes, and room assignments " +
            "that referenced this zone on the controller accessory must be set up again in the Home app.", zone.displayName);
        }

        /* Seed or refresh the persisted identity pair. The comparison is field-wise because both halves are freshly built projections, so a reference check would
         * differ every poll and flush every poll. On any difference - or on a context that fails the kind predicate, which is how an ambiguous or corrupt cache
         * entry heals - we assign a COMPLETE fresh object rather than individual fields, which re-asserts the kinds' mutual exclusivity at every write.
         */
        // The owner stamp reads the controller's own identity where this plugin built one, so a zone accessory names its owner exactly as that owner names itself
        // - the account's full name included. The wire projection is the floor for a controller no runtime object answers for.
        const ownerController = this.configuredController(controller)?.identity ?? controllerIdentity(controller);
        const context = accessory.context;

        if(!isZoneAccessoryContext(context) || !sameControllerIdentity(context.ownerController, ownerController) ||
          !sameZoneIdentity(context.zone, zone.identity)) {

          accessory.context = { ownerController, zone: zone.identity };
          this.api.updatePlatformAccessories([accessory]);
        }

        hosts.set(zone.identity.relayId, accessory);
      } catch(error) {

        this.log.error("%s: Unable to establish a standalone accessory for this zone: %s", zone.displayName,
          util.inspect(error, { colors: true, depth: null, sorted: true }));

        if(created) {

          this.removeAccessory(created);
        }
      }
    }

    return hosts;
  }

  // Remove one standalone zone accessory and clear the grace state it carried, so the counter map never holds an entry for an accessory that is gone. The removal
  // itself narrates through removeAccessory; the line here carries what the user has to act on, since a HomeKit identity is going away.
  private demoteZoneAccessory(accessory: HydrawiseAccessory): void {

    this.removeAccessory(accessory);
    this.zoneAccessoryGrace.delete(accessory.UUID);

    this.log.info("%s: Automations, scenes, and room assignments that referenced this zone's standalone accessory must be set up again in the Home app.",
      accessory.displayName);
  }

  // Initialize our network stack.
  private initNetworking(): void {

    // Destroy any existing dispatcher before we re-arm. With a single HTTP/2 connection a wedged session carries every in-flight request, so destroy fails them fast
    // onto the fresh pool through their own retry loops, where a graceful drain would instead wait on the very wedge the re-arm is clearing.
    void this.dispatcher?.destroy();

    /* The family's vetted transport - the pool, the retry policy over the statuses RETRYABLE_STATUSES reads, and this plugin's name as the user agent - built against
     * the origin derived from the one base URL every request is assembled on. Re-arming after a wedge is another call through the same factory, so the pool the
     * constructor built and the pool a timeout rebuilds can never differ.
     */
    this.dispatcher = createApiDispatcher({ origin: new URL(HYDRAWISE_API_BASE_URL).origin, userAgent: PLUGIN_NAME });

    setGlobalDispatcher(this.dispatcher);
  }

  // Communicate HTTP requests with the Hydrawise API.
  public async retrieve(endpoint: HydrawiseEndpoint, params?: Record<string, string>): Promise<Nullable<Dispatcher.ResponseData<unknown>>> {

    let response: Dispatcher.ResponseData<unknown>;

    // The request URL, assembled inside the try below once the budgets have admitted this call. It is declared out here because the timeout branch of the catch
    // reports it, and a variable assigned only inside a try cannot be read from its own catch. The empty starting value is never what reaches that log: the only
    // steps preceding the assignment are the budget waits, and the sole way any of them ends early is a shutdown rejection, which the catch answers above the
    // timeout branch.
    let url = "";

    try {

      /* Pace this call against both ceilings Hydrawise publishes, at the one place every request to the API passes through. A zone command draws the stricter
       * command budget first and the account-wide budget second, so a command queued behind a saturated command window is not also holding an account slot while
       * it waits. Every wait sits inside this try, which is what makes an escaping budget rejection unrepresentable: a shutdown while a caller is queued rejects
       * into the classification below, whose aborted-signal branch returns the same quiet null every other teardown path returns.
       *
       * Two limits on what these budgets can promise, stated plainly. They admit LOGICAL calls and sit above undici's retry interceptor, so one admitted call can
       * still put more than one request on the wire during a failure storm - the initial attempt plus whatever retries the dispatcher factory's retry policy
       * allows - accepted headroom, because retries exist to recover from exactly the trouble a ceiling is not the cause of. And they account only for this process:
       * the Homebridge config UI runs its own server process against the same account, one customerdetails call per refresh plus one statusschedule call per
       * controller it holds no cached context for, which an in-process window cannot see.
       */
      if(endpoint === HYDRAWISE_COMMAND_ENDPOINT) {

        await this.commandBudget.acquire();
      }

      await this.accountBudget.acquire();

      params ??= {};

      params["api_key"] = this.config.apiKey;

      const queryParams = new URLSearchParams(params);

      url = HYDRAWISE_API_BASE_URL + endpoint + "?" + queryParams.toString();

      /* Compose a per-request timeout with the platform's shutdown signal, so a slow request aborts on the timeout and an in-flight request aborts on shutdown, all
       * through one signal handed to undici. The timeout is armed only now, after the budgets have admitted the call, so a wait for a rate-limit slot never eats
       * into the time the request itself is allowed.
       *
       * The deadline is the platform's own timeout signal rather than one armed on the plugin's clock, because it bounds the request and the caller's read of the
       * response body - time spent on the network, not a wait this plugin schedules.
       */
      const signal = composeSignals(AbortSignal.timeout(HYDRAWISE_API_TIMEOUT * 1000), this.signal);

      response = await request(url, { signal });

      // Invalid API key.
      if(response.statusCode === 404) {

        this.log.error("Invalid API key. Please check your Hydrawise API key.");

        return null;
      }

      // API rate limit exceeded.
      if(response.statusCode === 429) {

        this.log.error("Hydrawise API rate limit has been exceeded.");

        return null;
      }

      // Any response outside the 2xx success range is an error. A status the retry interceptor treats as a server-side failure shares the temporarily-unavailable
      // message once it has survived retries; every other non-2xx status reports its raw code and reason phrase.
      if((response.statusCode < 200) || (response.statusCode >= 300)) {

        this.log.error(RETRYABLE_STATUSES.has(response.statusCode) ? "Hydrawise API is temporarily unavailable." : response.statusCode.toString() + ": " +
          (STATUS_CODES[response.statusCode] ?? ""));

        return null;
      }

      return response;
    } catch(error) {

      const failure = classifyTransportError(error, this.signal);

      /* Branch on the classified kind rather than on error shapes, with no default arm: the switch is exhaustive over the classifier's kinds, so a kind the library
       * learns to name is a compile error here until this plugin says what it means, never a silent fall-through. The classifier answers what kind of failure
       * occurred; what it means to a Hydrawise user, and what we do about it, is decided here.
       */
      switch(failure.kind) {

        // A shutdown is not news. The lifetime signal outranks every reading of the error itself, which is also what guarantees the deadline arm below can never
        // re-arm the pool after shutdown.
        case "aborted":

          return null;

        // A deadline elapsed: our own per-request timeout, or a response that stalled after it began. With a single HTTP/2 connection a wedged session carries every
        // request on it, so we reset the network stack rather than wait on the wedge.
        case "timeout":

          this.log.error("The Hydrawise API is taking too long to respond to a request. This error can usually be safely ignored.");
          this.log.debug("Original request was: %s", url);
          this.initNetworking();

          return null;

        // A concrete transport fault - a network failure, or a certificate the platform refused to trust - named by the sentence the plugin keeps for it.
        case "certificate":
        case "connect-timeout":
        case "destroyed":
        case "dns":
        case "refused":
        case "reset":
        case "retries-exhausted":

          this.log.error(HYDRAWISE_TRANSPORT_FAULT_SENTENCES[failure.kind]);

          return null;

        // A genuine failure carrying no marker anyone can read. The full dump is the only useful thing to say about it, and it carries whatever code the chain held.
        case "transport":

          this.log.error(util.inspect(error, { colors: true, depth: null, sorted: true }));

          return null;
      }
    }
  }
}
