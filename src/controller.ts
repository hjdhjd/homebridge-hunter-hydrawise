/* Copyright(C) 2017-2026, HJD (https://github.com/hjdhjd). All rights reserved.
 *
 * controller.ts: Base class for all Hydrawise irrigation controllers.
 */
import type { API, CharacteristicValue, HAP, Service } from "homebridge";
import { HAP_DEFAULT_MODEL, HAP_DURATION_CEILING, HOMEBRIDGE_UNKNOWN_FIRMWARE, HYDRAWISE_ACTIVE_ZONE_INDICATOR, HYDRAWISE_API_JITTER,
  HYDRAWISE_API_NEXTPOLL_MAX, HYDRAWISE_API_RETRY_INTERVAL, HYDRAWISE_COMMAND_ATTEMPTS, HYDRAWISE_DEFAULT_RUN_DURATION, HYDRAWISE_POLL_LOSS_THRESHOLD,
  HYDRAWISE_REVERT_DELAY, HYDRAWISE_SUSPEND_DURATION, HYDRAWISE_V2_FACTS_TTL } from "./settings.ts";
import { HYDRAWISE_UNSCHEDULED_SENTINEL, HydrawiseReservedNames, controllerDisplayName, controllerIdentity, isControllerIdentity, isFirmwareVersion,
  isRainSensorSubtype, isScheduleStatus, isSuspendZoneSubtype, isZoneIdentity, isZoneStoppedBySensor, rainSensorSubtype, sameControllerIdentity, sameScheduleStatus,
  sameZoneIdentity, scheduleStatus, suspendZoneSubtype, zoneDisplayName, zoneHasUpcomingRun, zoneIdentity, zoneScheduleStatus } from "./types.ts";
import type { HomebridgePluginLogging, MqttAvailabilityPayload, Nullable, RepeatDemotedLog } from "homebridge-plugin-utils";
import type { HydrawiseAccessory, HydrawiseCommandOutcome, HydrawiseComposedName, HydrawiseControllerAccessory, HydrawiseControllerConfig,
  HydrawiseControllerHardware, HydrawiseControllerIdentity, HydrawiseControllerV2Facts, HydrawiseScheduleStatus, HydrawiseZoneConfig, HydrawiseZoneIdentity,
  HydrawiseZoneScheduleStatus, StatusScheduleResponse } from "./types.ts";
import type { HydrawiseCommandIntent, HydrawiseCommandRecord, HydrawiseCommandTarget, HydrawiseCommandValue, HydrawisePreparedCommand,
  HydrawiseUnconfirmedCommand } from "./commands.ts";
import type { HydrawiseControllerOption, HydrawiseControllerValueOption, HydrawiseZoneOption, HydrawiseZoneValueOption } from "./options.ts";
import { MQTT_AVAILABILITY_OFFLINE, MQTT_AVAILABILITY_ONLINE, acquireService, formatErrorMessage, getServiceName, loopFaultReporter, mqttTopic, notResponding,
  ownedName, prefixedLog, presenceChanged, repeatDemotedLog, retry, sameEntries, sanitizeName, setAccessoryName, setServiceName, superviseLoop,
  validCharacteristic, validService, watchServiceName } from "homebridge-plugin-utils";
import { HydrawiseCommandQueue } from "./commands.ts";
import type { HydrawisePlatform } from "./platform.ts";
import { mqttTopics } from "./mqtt.ts";
import util from "node:util";

// Device-specific options and settings.
interface HydrawiseHints {

  rainSensors: boolean;
  suspendAll: boolean;
}

/* One completed poll, as it crosses from the wire half of the polling loop to the HomeKit half: the status body that poll fetched.
 *
 * The status field is deliberately the same object the controller holds, not a defensive copy. The projection reads instance state directly throughout, and it is
 * the only consumer in the process, so a copy would hand it one object while every other read in the same pass saw another.
 */
interface HydrawisePollUpdate {

  readonly status: StatusScheduleResponse;
}

/* Why one status fetch failed, the tag the status log compares with the reason it remembers: a request retrieve() could not answer, a body that could not be
 * parsed, or one that parsed into the wrong shape.
 */
type HydrawiseStatusFailure = "mis-shaped" | "unanswered" | "unreadable";

/* What one status fetch came to: a body adopted as the controller's status, a shutdown abort mid-read carrying the read's own error, which is no failure, or the
 * tag of the reason it failed. The status log classifies the fetch from it before it releases the fetch's lines, and getStatus() answers the retry from it.
 */
type HydrawiseStatusOutcome = { status: "adopted" } | { error: unknown; status: "aborted" } | { status: HydrawiseStatusFailure };

/* The polling loop's verdict on whether Hydrawise answers for this controller. Pending until the first poll lands, reachable once one has, and lost after a run of
 * consecutive failed polls, or when the loop itself has ended; a lost controller keeps polling, and its next good poll makes it reachable again.
 */
type HydrawiseContact = "lost" | "pending" | "reachable";

// One tile a controller names in HomeKit, as its fallback warning tracks it: the controller itself, or one of its zones by relay id.
type HydrawiseNameTile = "controller" | number;

// One zone's naming for a pass: the composer's answer, and the Name option value it was composed from, kept beside it so the ownership rule reads the very value
// the composer read.
interface HydrawiseZoneNaming {

  readonly composed: HydrawiseComposedName;
  readonly override: Nullable<string | undefined>;
}

// Per-zone state we track across polling cycles so we can detect and report start, stop, rain-sensor, and suspension transitions.
interface HydrawiseZoneHints {

  isManual: boolean;
  isOn: boolean;
  isStopped: boolean;
  isSuspended: boolean;
}

/* The one owner of the zone hints a controller keeps. The map is private to this class, and every change to it arrives as a named, single-purpose method
 * rather than as a field write somewhere out in the poll walk or a set handler.
 *
 * Single ownership is what lets the relationships between those hints be enforced here instead of resting on the order call sites happen to run in. A zone the
 * wire reports as not running is not manually activated, so the observation clears the manual flag itself, and an entry exists only for a zone the current
 * poll's enabled projection names, so a zone that vanishes and reappears starts fresh rather than resurrecting stale flags.
 *
 * The views handed back are the LIVE stored entries, never defensive copies. The poll walk holds one for the rest of its pass and has to observe the writes
 * that same pass makes through the ledger; a copy would hand it pre-write reads and quietly break the start, stop, and rain-sensor comparisons that follow.
 */
class HydrawiseZoneHintLedger {

  private readonly hints = new Map<number, HydrawiseZoneHints>();

  /* Resolve a zone's entry, seeding one on first sighting from the live rain-sensor and suspension readings alongside the falsy manual and running defaults.
   * Seeding from the live readings rather than static defaults is what keeps a zone first sighted during a rain delay, or already suspended, from reporting a
   * transition it never made. An existing entry comes back untouched, so its manual and running flags survive a valve rediscovery.
   */
  public ensure(relayId: number, isStopped: boolean, isSuspended: boolean): Readonly<HydrawiseZoneHints> {

    let hint = this.hints.get(relayId);

    if(!hint) {

      hint = { isManual: false, isOn: false, isStopped, isSuspended };
      this.hints.set(relayId, hint);
    }

    return hint;
  }

  // Mark a zone as manually activated. A zone with no entry is a silent no-op: the walk seeds an entry for every zone it projects, so a missing one means the
  // zone is outside the current poll's enabled projection and has nothing to record.
  public markManual(relayId: number): void {

    const hint = this.hints.get(relayId);

    if(hint) {

      hint.isManual = true;
    }
  }

  // Clear a zone's manual activation, on the same missing-entry terms markManual states.
  public clearManual(relayId: number): void {

    const hint = this.hints.get(relayId);

    if(hint) {

      hint.isManual = false;
    }
  }

  /* Record what the wire says about a zone running, and take the consequence of it in the same step: a zone the wire reports as not running cannot still be
   * manually activated, so the observation clears the manual flag rather than leaving a separate call site to remember to.
   */
  public observeRunning(relayId: number, isOn: boolean): void {

    const hint = this.hints.get(relayId);

    if(!hint) {

      return;
    }

    hint.isOn = isOn;

    if(!isOn) {

      hint.isManual = false;
    }
  }

  // Store a zone's rain-sensor state - the value the next transition check compares the live reading against.
  public refreshStopped(relayId: number, isStopped: boolean): void {

    const hint = this.hints.get(relayId);

    if(hint) {

      hint.isStopped = isStopped;
    }
  }

  // Store a zone's suspension state, the suspension twin of the rain-sensor store above and the value its own transition check compares against.
  public refreshSuspended(relayId: number, isSuspended: boolean): void {

    const hint = this.hints.get(relayId);

    if(hint) {

      hint.isSuspended = isSuspended;
    }
  }

  // Drop every entry the current poll's enabled projection does not name. Hosting never enters into it: a hint belongs to a zone, wherever that zone's valve
  // lives.
  public prune(liveRelayIds: Set<number>): void {

    for(const relayId of this.hints.keys()) {

      if(!liveRelayIds.has(relayId)) {

        this.hints.delete(relayId);
      }
    }
  }

  // Read a zone's entry without seeding one, the view being the live stored entry on the same terms ensure states.
  public get(relayId: number): Readonly<HydrawiseZoneHints> | undefined {

    return this.hints.get(relayId);
  }
}

/* One controller's account-credentialed facts as this class holds them: what the account API reported, plus the local instant the request that fetched them was
 * made. The timestamp's name is deliberately not `asOf`: the persisted projection's asOf carries the WIRE's own clock, this carries ours, and giving the two
 * different names keeps a reader from ever mistaking one contract for the other.
 */
interface HydrawiseControllerFactsSnapshot extends HydrawiseControllerV2Facts {

  fetchedAt: number;
}

// The account-wide suspend switch's command target, which carries nothing beyond its kind, so one value serves every reference to it.
const SUSPEND_ALL_TARGET: HydrawiseCommandTarget = { kind: "suspend-all" };

/* One Hydrawise irrigation controller as HomeKit sees it: the accessory or accessories this class projects onto, the endless polling loop that keeps their
 * characteristics current, and the commands a user's actions in the Home app turn into wire requests.
 *
 * The polling loop runs as two halves under one supervised envelope, started from the constructor: pollStatus() is the wire generator that fetches the account
 * API's status on the interval the API itself sets, and applyStatus() is the HomeKit projection that reads each completed poll and updates services,
 * characteristics, and accessory context from it. The same class also owns a standalone zone accessory's valve, when the plugin is configured to promote one,
 * so a zone's state is projected consistently regardless of which accessory hosts it.
 *
 * Every command a user issues - a zone run or stop from HomeKit or MQTT, an account-wide suspend-all, a per-zone suspension - goes through this controller's one
 * command queue, which answers the control at once and sends the user's latest choice for it when its turn comes. What Hydrawise confirms is folded back into the
 * same projection a poll would update, so a change made in the Home app and one made in the Hydrawise app converge on the same displayed state.
 */
export class HydrawiseController {

  private readonly accessory: HydrawiseControllerAccessory;

  // The one place that decides whether this controller's own accessory answers HomeKit at all, bound once over the per-host verdict below. Every handler on the
  // controller accessory but a rain sensor's read is wired through it, and the verdict is read fresh on each call, so a loss refuses the very next read or write and a
  // return answers it, with no rewiring.
  private readonly answering: ReturnType<typeof notResponding>;
  private readonly api: API;

  // This controller's availability topic tail, composed once beside the controller topic and for the same reason.
  private readonly availabilityTopic: string;

  /* Every service this process has bound its handlers to: each valve, each per-zone suspension switch, and each rain sensor. The pass that reaches a service first
   * binds it, and none binds it again, whichever way the service arrived - created this pass, kept from the accessory cache on the first pass, or a cached standalone
   * valve a later poll hosts for the first time - so each service is bound once. It holds services weakly, so one removed with its zone or its sensor leaves nothing
   * behind.
   */
  private readonly bound = new WeakSet<Service>();

  // The polling loop's reachability verdict, read by every refusal and by the availability word. It moves only through setContact(), which narrates each
  // transition and restates the word.
  private contact: HydrawiseContact = "pending";
  public readonly controller: HydrawiseControllerConfig;

  /* The one queue every command this controller sends goes through, and the one home for what those commands leave behind: each control's pending request, and
   * the suspensions Hydrawise confirmed at both grains, the account-wide one and each zone's, which no fresher truth has yet superseded. A confirmed suspension
   * carries WHICH WAY it went, because a bare timestamp would say that the user commanded something without saying what to show in place of a stale snapshot.
   *
   * It lives in memory and dies with the process by design. After a restart the projection's own carried suspensions own the display, which is the truth the
   * account confirmed rather than one this process remembered commanding.
   */
  private readonly commands: HydrawiseCommandQueue;

  // This controller's MQTT topic tail, composed once from its serial and the catalog's tail, because neither changes for the life of the controller.
  private readonly controllerTopic: string;

  private enabledZones: HydrawiseZoneConfig[];

  /* The tiles this run has warned about for being named by their kind's word, so each warning is said once while the word applies. A pass that decides a tile
   * adds it when the composer answers the word and removes it when the composer answers anything else, and the walk drops a zone the poll's enabled projection
   * leaves out, so a tile that leaves the word, or the wire, and returns to it is warned about again. It lives in memory and dies with the process, so a restart
   * warns once more for every tile its first deciding pass still names by the word.
   */
  private readonly fallbackWarned = new Set<HydrawiseNameTile>();

  private readonly hap: HAP;
  private readonly hints: HydrawiseHints;

  /* The last availability the account API actually reported, and the seed the transition line compares against. Null means nothing has reported yet: a first
   * arrival that says online seeds silently, while a first arrival that says offline is narrated, because the controller refuses on that reading and a silent
   * refusal would leave the user no cause in the log.
   *
   * It lives in memory and dies with the process by design, on the same terms as the zone ledger's own seeds: after a restart the first arrival is judged as a
   * first arrival again, so restarting never narrates a flip that did not happen.
   */
  private lastKnownOnline: Nullable<boolean> = null;

  /* The name watches the last pass registered: one on each information service, valve, suspension switch and rain sensor whose name that pass found the plugin owning,
   * each putting back the name that pass decided the moment the Home app renames the service. Each pass disposes them and registers its own, which is what keeps the
   * watches in step with the services: a removal inside a pass happens after that disposal, so the removed service is simply never watched again, a rain sensor a
   * facts arrival removes between passes keeps its watch only until the next pass, which acts on nothing because HAP's removal drops the service's listeners, and a
   * service whose owner changed is watched, or not, from the pass that reads the change. The platform signal ends them all at shutdown.
   */
  private nameWatches = new DisposableStack();

  public readonly log: HomebridgePluginLogging;
  private readonly platform: HydrawisePlatform;

  // How many polls in a row have failed since the last good one, the count the loss verdict is read from. The retry that finally succeeds resets it.
  private pollFailures = 0;

  // The Not Responding rule for this controller's rain sensors, bound once over the verdict on its whole accessory, and read on every call as the controller's own is.
  private readonly rainAnswering: ReturnType<typeof notResponding>;

  // Whether the rain sensors' reading was current when last judged, and null until a carried sensor has had one this run, which is what keeps a first reading quiet.
  private rainReading: Nullable<boolean> = null;

  // This controller's rain sensors topic tail, composed once beside the controller topic and for the same reason.
  private readonly rainSensorsTopic: string;

  private status: StatusScheduleResponse;

  /* The status log: how this controller's poll reports a body it fetched and could not adopt. The adapter lives and dies with the controller, so a failure is
   * reported in full the first time, at debug for as long as the same reason holds, and in full again once an adopted poll, a different reason, or a shutdown
   * abort ends the episode, and a restart opens a fresh one. Each controller holds its own because each polls on its own, so one controller's adopted poll never
   * resets another's episode, and the controller polls one request at a time, so its attempts never overlap on it. A request retrieve() could not answer is
   * not reported here, since retrieve() has already reported it through the platform's own request log.
   */
  private readonly statusFailures: RepeatDemotedLog<HydrawiseStatusFailure>;

  // The instant the request behind the current status was made, in whole seconds on the platform clock, the stamp a refresh gives its facts. It is taken before the
  // request and stored beside the status, so a status body already on its way when a command is confirmed can never read as newer than that command.
  private statusFetchedAt = 0;

  // The most recent account-credentialed facts this controller was handed, or null when none have ever arrived. Every reader goes through the freshness
  // chokepoint below rather than touching this directly, so "never arrived", "gone stale", and "no credentials configured" are one answer at every consumer.
  private v2Facts: Nullable<HydrawiseControllerFactsSnapshot> = null;

  private readonly zoneHints: HydrawiseZoneHintLedger;

  /* Where each zone the last walk projected has its valve, and therefore its companion suspension switch. The walk already resolves this to host the valve, so
   * recording it costs nothing and is what lets the shared projection tail reach a switch on a standalone accessory without asking the platform to reconcile
   * outside a poll - the tail never calls that method, because reconciling decides accessory existence and a refresh tick has no wire truth to decide it from.
   *
   * It is rebuilt from empty at the top of every walk, so a zone that left the projection cannot leave its entry behind. Between polls the recorded host is
   * definitionally current, since hosting changes only when a walk changes it.
   */
  private readonly zoneHosts = new Map<number, HydrawiseAccessory>();

  // The constructor initializes key variables and calls configureDevice(). The platform passes the denormalized account roster - every account controller's identity,
  // enabled or not - so this controller can seed it into its own accessory context, giving any one accessory knowledge of all its siblings.
  constructor(platform: HydrawisePlatform, accessory: HydrawiseControllerAccessory, controller: HydrawiseControllerConfig, roster: HydrawiseControllerIdentity[]) {

    this.accessory = accessory;
    this.api = platform.api;

    // The pre-first-poll placeholder: nextpoll -1 is the isFirstRun sentinel pollStatus() reads on its first pass, and every field here is fully replaced
    // once that first fetch resolves.
    this.status = { nextpoll: -1, relays: [] as HydrawiseZoneConfig[] } as StatusScheduleResponse;
    this.enabledZones = [];
    this.hap = this.api.hap;

    // Populated synchronously by configureDevice(), called at the end of this constructor, which runs configureHints() first among its steps and so sets every hint
    // before any external reader can observe this.hints - that ordering is what makes the empty-object cast safe.
    this.hints = {} as HydrawiseHints;
    this.controller = controller;
    this.availabilityTopic = mqttTopic(this.controller.serial_number, mqttTopics.availability.topic);
    this.controllerTopic = mqttTopic(this.controller.serial_number, mqttTopics.controller.topic);
    this.rainSensorsTopic = mqttTopic(this.controller.serial_number, mqttTopics.rainSensors.topic);
    this.platform = platform;
    this.zoneHints = new HydrawiseZoneHintLedger();
    this.answering = this.answeringFor(this.accessory);
    this.rainAnswering = notResponding({ errorClass: this.hap.HapStatusError, unavailable: () => this.accessoryRefuses });

    /* Prefix every log line with the accessory's display name, read live, which construction aligns with the name the plugin composes for this controller and
     * every poll keeps there: the Name option where HomeKit can carry it and the controller's own Hydrawise name otherwise, as the settings page names it. A rename
     * made in the Home app stays in HomeKit and never reaches the log. The platform's logger already gates debug routing through the user's debug setting, so debug
     * lines prefixed here route intact.
     */
    this.log = prefixedLog(platform.log, (): string => this.accessory.displayName);

    // The status log is built over the prefixed logger, so a demoted repeat carries the controller's name and meets the user's debug setting as every debug line does.
    this.statusFailures = repeatDemotedLog<HydrawiseStatusFailure>(this.log);

    // The command queue is built over the prefixed logger too, so a fault it contains names the controller it happened on.
    this.commands = new HydrawiseCommandQueue({ handlers: { available: (target, intent): boolean => this.commandAvailable(target, intent),
      prepare: (target, intent): HydrawisePreparedCommand => this.prepareCommand(target, intent), read: (target): HydrawiseCommandValue => this.readControl(target),
      render: (target): void => this.renderControl(target), unconfirmed: (target, intent, outcome): void => this.reportUnconfirmed(target, intent, outcome) },
    log: this.log, name: this.controller.controller_id.toString(), signal: platform.signal, timers: platform.timers });

    this.configureDevice(roster);
  }

  // Configure an irrigation system accessory for HomeKit.
  private configureDevice(roster: HydrawiseControllerIdentity[]): void {

    // Capture the prior persisted identity, zone roster, schedule projection, and firmware version before we wipe the context. We restore each of them below so a
    // restart does not blank the zone list or the schedule panel during the window between this configure pass and the first completed poll, when the runtime has
    // not yet rebuilt either from a fresh status body, and so the firmware version outlives the wipe.
    const priorController = this.accessory.context.controller;
    const priorFirmware = this.accessory.context.firmware;
    const priorSchedule = this.accessory.context.schedule;
    const priorZones = this.accessory.context.zones;

    /* Clean out the context object, then reseed the identity rosters this controller owns. The controller is the single writer of accessory context: it seeds its own
     * identity (the self-identity the webUI's zone lookup keys on) and the denormalized account roster here, and rewrites the zone roster on change from each poll. We
     * restore the prior zone roster when it is a well-formed array and degrade a malformed prior value to empty, so a corrupt cache entry never crashes the reader.
     *
     * The self-identity is restored on those same terms, through the shared shape guard, and that restoration is what the controller's name carry reads from: the
     * persisted identity is the carry store, so wiping it to the wire projection here would hand the first poll a truncated name to rename everything back to. A
     * malformed or absent prior degrades to the wire projection, which is the honest floor - there is nothing to carry.
     */
    this.accessory.context = {};
    this.accessory.context.controller = isControllerIdentity(priorController) ? priorController : controllerIdentity(this.controller);
    this.accessory.context.controllers = roster;
    this.accessory.context.zones = this.isZoneRoster(priorZones) ? priorZones : [];

    /* Restore the prior schedule projection on the same terms as the roster above: a well-formed prior value carries over, and a malformed one degrades to absent so
     * the panel renders identity alone rather than a corrupt entry. A restored projection keeps the asOf it was written with, which is deliberately conservative -
     * if the first poll's facts still match it, those facts held then and hold now, and the only surface that reads asOf is the display's staleness notice.
     */
    if(isScheduleStatus(priorSchedule)) {

      this.accessory.context.schedule = priorSchedule;
    }

    /* Restore the firmware version on the same terms: a well-formed prior value carries over, and a malformed one degrades to absent. The context is the firmware's
     * only store across a restart, so a value dropped here would be missing from the next cache save, and a restart before the first refresh relearned it would show
     * Homebridge's placeholder. Without credentials the information setup below clears it, since nothing will ever refresh it.
     */
    if(isFirmwareVersion(priorFirmware)) {

      this.accessory.context.firmware = priorFirmware;
    }

    /* Align the accessory's display name with the name the plugin composes for this controller before any configure step runs, so the accessory carries that name
     * from construction on, a restored accessory included, rather than from its first successful poll. The log prefix and the names the suspend-all switch and a
     * rain sensor are created under read it, so each speaks with the composed name from the first line. The write is the display name alone: the HomeKit names
     * wait for the poll's ownership decision, which is where the naming rule reads who owns them. The platform's save after construction carries the write.
     */
    setAccessoryName(this.accessory, this.composeControllerName(this.currentFacts).name, { owned: false });

    // Configure ourselves.
    this.configureHints();
    this.configureInfo();
    this.configureIrrigationSystem();
    this.configureSuspendSwitches();
    this.reconcileRainSensors();
    this.configureMqtt();

    /* Kick off our state updates under supervision so a genuine fault in the polling loop surfaces once through the reporter, while a shutdown abort unwinds the
     * loop silently. The wire half and the HomeKit half sit inside this ONE envelope because they are one fault domain: a throw from either ends the same loop and
     * owes the operator the same single report, so the generator needs no supervision of its own - its throws land here.
     *
     * A loop that ended anywhere but at shutdown vouches for nothing from then on, so the controller reads lost the moment the envelope settles. The reporter has
     * already said why, so the verdict moves quietly rather than adding a second line about the same fault.
     */
    void superviseLoop({ loop: async (signal): Promise<void> => {

      for await (const update of this.pollStatus(signal)) {

        this.applyStatus(update);
      }
    }, onError: loopFaultReporter(this.log, "zone status"), signal: this.platform.signal }).then(() => {

      if(!this.platform.signal.aborted) {

        this.setContact("lost", { quiet: true });
      }
    });

    // State the availability this controller starts with, which is offline until its first poll lands.
    this.refreshAvailability();
  }

  // Configure controller-specific settings.
  private configureHints(): void {

    this.hints.rainSensors = this.platform.hasV2Client && this.hasFeature("Device.Sensor.Rain");
    this.hints.suspendAll = this.hasFeature("Device.Suspend.All");

    /* Surface name synchronization at startup where it departs from its default. HBPU walks the levels a call names, lowest first, and writes one line for the level
     * the setting was made at: a setting on this controller goes through this controller's logger, and a global one through the plugin's logger, once however many
     * controllers ask. Synchronization is read live on each poll rather than cached in a hint, since a zone can set it independently of its controller, so the call
     * names no zone and a zone's own setting stays unlogged.
     */
    this.platform.featureOptions.logFeature({ controller: { id: this.controller.serial_number, log: this.log }, label: "Name synchronization", log: this.platform.log,
      option: "Device.SyncName" });

    // Surface the per-zone suspension switches and the rain sensors on the same terms, and only where the account credentials each reads from are configured: without
    // them neither is ever created, so naming them would advertise a feature this install does not have.
    if(this.platform.hasV2Client) {

      this.platform.featureOptions.logFeature({ controller: { id: this.controller.serial_number, log: this.log }, label: "Per-zone suspension switches",
        log: this.platform.log, option: "Device.Suspend.Zone" });
      this.platform.featureOptions.logFeature({ controller: { id: this.controller.serial_number, log: this.log }, label: "Rain sensors", log: this.platform.log,
        option: "Device.Sensor.Rain" });
    }
  }

  /* Configure the accessory information for one of the accessories this controller projects onto. The parameters pair an accessory with the serial number and the
   * hardware facts that belong to it as one correlated value, so an accessory can never be stamped with another accessory's details, and they default to the
   * controller's own accessory and its wire serial with no hardware named. A standalone zone accessory has no wire serial of its own, so its caller synthesizes
   * one, and it names no hardware either: model and firmware describe the controller, not one valve hanging off it.
   *
   * Every call first gives the information service a ConfiguredName where it carries none, from the name the service already carries, and leaves one it carries
   * as it stands. ConfiguredName is the one name characteristic a HomeKit controller can write, so it is where a rename in the Home app lands and where the name
   * watches read one to put a name the plugin owns back, and HAP adds none to an information service of its own accord. The rule lives here because every information
   * service this controller configures passes through this setup - its own accessory's at construction and a standalone zone's at its first binding - whether the
   * accessory was minted this run or restored from a cache that never carried the characteristic. A ConfiguredName already present holds a rename the Home app
   * made or a name an earlier pass wrote, and whether to write over it is the naming rule's decision on the poll, never this setup's. The cache holds the
   * characteristic, so an add marks the accessory for the save window.
   *
   * The manufacturer and the serial always write. What happens to the model and the firmware depends on which of the following combinations holds.
   *
   * Called WITH hardware, this writes it - that is the enrichment landing, and it writes unconditionally, comparing nothing first. HAP sends HomeKit no event for
   * a write whose value matches what the characteristic holds, so a compare here would only duplicate HAP's own work and add a second place for the two answers
   * to disagree.
   *
   * Called WITHOUT hardware on the controller's OWN accessory while the account credentials are configured, it leaves BOTH alone. They hold what a previous
   * session adopted: HAP restored the model a previous session wrote, and before this controller existed the platform wrote the firmware version the
   * accessory's context carries in place of Homebridge's restore placeholder, so a warm restart shows the model and the firmware from the start. An accessory
   * whose context carries no version shows that placeholder until the first refresh lands. The fetch that will refresh them is already on its way, so writing a
   * placeholder over them would blank a correct display for the length of a network round trip. The single exception is an accessory that has never been
   * stamped at all, which still carries HAP's own default model - there is nothing to preserve there, and leaving it would show the user a library-internal
   * string, so the placeholder is written.
   *
   * Called WITHOUT hardware and with no credentials configured, both write unconditionally: the product-line placeholder, and the firmware returned to the
   * unknown-firmware marker Homebridge itself stamps on a restored accessory. The model's reset is what makes removing the credentials a clean revert - the
   * characteristic outlives the credentials that populated it, so an omitted write would strand a real model on display permanently, with nothing left in the
   * plugin that could refresh or correct it. Homebridge stamps the firmware marker on every restore itself, and the platform writes a persisted version over it
   * only while credentials are configured, so the firmware write changes only a fresh accessory, which HAP constructs with a default version of its own. The
   * version the controller's own context carries is cleared on the same terms, since nothing will ever refresh it, and the clear marks the accessory for the save
   * window only when there is a version to clear.
   */
  private configureInfo({ accessory, hardware, serialNumber }: { accessory: HydrawiseAccessory; hardware?: HydrawiseControllerHardware; serialNumber: string } =
    { accessory: this.accessory, serialNumber: this.controller.serial_number }): void {

    const informationService = accessory.getService(this.hap.Service.AccessoryInformation);

    // The ConfiguredName rule runs ahead of the hardware arms below, each of which can return early, so every call reaches it. HAP seeds the information service's
    // Name from the display name, so the display name stands in only where the service answers no name at all.
    if(informationService && !informationService.testCharacteristic(this.hap.Characteristic.ConfiguredName) &&
      setServiceName(informationService, getServiceName(informationService) ?? accessory.displayName)) {

      this.platform.persistence.persist(accessory);
    }

    // Update the manufacturer information.
    informationService?.updateCharacteristic(this.hap.Characteristic.Manufacturer, "Hunter");

    // Update the serial number.
    informationService?.updateCharacteristic(this.hap.Characteristic.SerialNumber, serialNumber);

    if(hardware) {

      informationService?.updateCharacteristic(this.hap.Characteristic.Model, hardware.model);
      informationService?.updateCharacteristic(this.hap.Characteristic.FirmwareRevision, hardware.firmware);

      return;
    }

    /* With no facts in hand and an enrichment on the way, the one read below decides between preserving and stamping. HAP's own default model is the only value
     * that can mean "nothing has ever written here", so it is the only value worth overwriting blind.
     *
     * The preserve arm belongs to the controller's OWN accessory alone, which is what the identity check asks. A standalone zone accessory is never enriched, so
     * it has no incoming values to protect, and leaving its characteristics unwritten would strand whatever the last session happened to leave on them.
     */
    if(this.platform.hasV2Client && (accessory === this.accessory)) {

      if(informationService?.getCharacteristic(this.hap.Characteristic.Model).value === HAP_DEFAULT_MODEL) {

        informationService.updateCharacteristic(this.hap.Characteristic.Model, "Hydrawise");
      }

      return;
    }

    informationService?.updateCharacteristic(this.hap.Characteristic.Model, "Hydrawise");
    informationService?.updateCharacteristic(this.hap.Characteristic.FirmwareRevision, HOMEBRIDGE_UNKNOWN_FIRMWARE);

    // The clear reads the controller's own accessory alone. A standalone zone accessory takes this arm on a credentialed install too, where the version its
    // controller's context carries is one a refresh keeps current.
    if((accessory === this.accessory) && (this.accessory.context.firmware !== undefined)) {

      this.platform.persistence.persist(this.accessory, { firmware: undefined });
    }
  }

  /* Adopt the facts the account-credentialed API reported for this controller: display them, project them, and make whatever moved durable.
   *
   * The ORDER here is part of the contract. The prior snapshot is captured in a local BEFORE the new one is stored, because the hardware comparison below reads
   * the snapshot this controller was holding on entry; a comparison written against the field after the store would read the new value on both sides and could
   * never report a change. The first arrival counts as a change whenever it carries hardware, since that arrival is the one that has to reach the disk.
   *
   * The model's characteristic is the only store it has. HAP round-trips it through Homebridge's on-disk accessory cache, so writing it here and marking the
   * accessory for the save window is the whole of its persistence. The firmware has a second home in the accessory's context, because Homebridge stamps its
   * firmware placeholder over the characteristic on every restore before the plugin sees the accessory. The mark below carries the version into the context, and
   * the platform writes it back over the placeholder at restore, so a credentialed warm restart shows the firmware this method last adopted.
   *
   * The mark is CHANGE-GATED, and on a recurring cadence that gate is the point: a tick that moved nothing would otherwise write the accessory cache to disk
   * every quarter hour for no reason at all. It is made only when the hardware genuinely differs from what this controller already held, and a projection the
   * tick moved marks its own write.
   *
   * The rain sensors are reconciled ahead of the re-derive, because the availability word it re-judges reads which sensors the accessory carries, and their topic is
   * published behind it, from the facts as they stand after the re-derive.
   *
   * @param facts     - The hardware, availability, rain sensor, and per-zone facts the account API reported for this controller.
   * @param fetchedAt - The local instant, in epoch seconds, the request that fetched them was made.
   */
  public applyFacts({ facts, fetchedAt }: { facts: HydrawiseControllerV2Facts; fetchedAt: number }): void {

    const prior = this.v2Facts;

    this.v2Facts = { ...facts, fetchedAt };

    if(facts.hardware) {

      this.configureInfo({ accessory: this.accessory, hardware: facts.hardware, serialNumber: this.controller.serial_number });

      if(!this.sameHardware(prior?.hardware ?? null, facts.hardware)) {

        this.platform.persistence.persist(this.accessory, { firmware: facts.hardware.firmware });
      }
    }

    this.reportAvailability(facts.online);

    this.reconcileRainSensors();
    this.rederiveProjection();
    this.publishRainSensors(this.currentFacts);

    this.log.debug("Enhanced details updated: model %s, firmware %s, reachable %s, zones %s.", facts.hardware?.model ?? "unknown",
      facts.hardware?.firmware ?? "unknown", facts.online ?? "unknown", facts.zones.size.toString());
  }

  /* Re-derive the projection from whatever this controller currently knows, then make what moved durable and published. Every cadence that can change a zone's
   * classification outside a poll runs this: a refresh tick, which brings fresh account facts, and a successful suspension command, whose acceptance is itself a
   * fact about the zones it named.
   *
   * Each write is CHANGE-GATED, which is what lets a recurring cadence run this freely. A tick or a command that moved no classification marks nothing for the
   * accessory cache and republishes no status payload, where an unconditional pair would write the cache to disk every quarter hour and republish an unchanged
   * payload with it. The projection marks its own write as it makes it, so the publish is the one gate left here. The poll cadence keeps its own unconditional
   * status publish, which is a contract of its own and deliberately not shared here. The availability word is re-judged at the end of every pass behind its own
   * change gate, because the facts a tick brings can move the verdict without moving any zone's classification.
   *
   * The facts are resolved ONCE and threaded through both the classification and the payload, on the same terms every other pass in this class resolves them, so
   * a lifetime boundary crossed midway cannot leave the two describing different worlds.
   *
   * Before the first completed poll the projection step returns early with nothing to classify, so it marks nothing and opens no publish, and only the
   * availability word can move.
   */
  private rederiveProjection(): void {

    const facts = this.currentFacts;
    const projectionChanged = this.applyProjection(facts);

    if(projectionChanged) {

      this.platform.mqtt?.publishGuarded(this.controllerTopic, this.statusJson(facts));
    }

    // The facts this re-derive read can move the availability verdict as well, so the word is re-judged here too. It publishes only when it changed.
    this.refreshAvailability();
  }

  /* Adopt the denormalized account roster the platform recomposed, and make it durable when it actually moved.
   *
   * The roster is every controller on the account as each of them currently answers for itself, which is why the platform composes it and hands it here rather
   * than this controller building it: only the platform can see the siblings. The comparison is field-wise because each refresh composes fresh projections, so a
   * reference check would call every tick a change and write the accessory cache every quarter hour for nothing.
   *
   * @param roster - Every account controller's current identity, in the account's own order.
   */
  public applyRoster(roster: HydrawiseControllerIdentity[]): void {

    if(sameEntries(this.accessory.context.controllers ?? [], roster, sameControllerIdentity)) {

      return;
    }

    this.platform.persistence.persist(this.accessory, { controllers: roster });
  }

  // Compare two hardware answers field-wise, treating an absent answer as a value of its own so the first arrival against a null baseline reports as a change.
  // Never by reference: each refresh composes a fresh object, so a reference check would call every tick a change and save the accessory on every one.
  private sameHardware(a: Nullable<HydrawiseControllerHardware>, b: Nullable<HydrawiseControllerHardware>): boolean {

    if(!a || !b) {

      return a === b;
    }

    return (a.firmware === b.firmware) && (a.model === b.model);
  }

  /* Report a change in whether Hydrawise can reach this controller, and remember what was reported. A later non-null reading is narrated only when it DIFFERS from
   * the one already recorded, and a refresh that simply cannot tell changes nothing. The first reading seeds the record, silently when it says online and with the
   * offline line when it says offline, because the controller refuses on that reading and the log is where the user finds out why.
   */
  private reportAvailability(online: Nullable<boolean>): void {

    if(online === null) {

      return;
    }

    if((this.lastKnownOnline === null) ? !online : (this.lastKnownOnline !== online)) {

      this.log.info(online ? "The controller is back online." : "The controller is offline.");
    }

    this.lastKnownOnline = online;
  }

  /** Whether this controller cannot vouch for anything it shows: the polling loop has not reached Hydrawise yet this run or has lost it, or the account API's
   * fresh word is that the controller itself is offline. The account's word counts only on an install with the credentials that fetch it, so an install with an
   * API key alone answers from the polling loop's verdict and nothing else.
   *
   * @returns True while every accessory this controller projects onto should refuse.
   */
  public get unavailable(): boolean {

    return (this.contact !== "reachable") || (this.platform.hasV2Client && (this.currentFacts?.online === false));
  }

  /** Whether one accessory this controller projects onto refuses: the controller-wide answer above, or a standalone zone accessory the last poll did not host. An
   * accessory held through its wire-absence grace is one no poll is describing, so nothing vouches for its values until a poll hosts it again. Every refusal reads
   * this, the controller's own handlers and the platform's restore-time ones alike, a rain sensor's through the wider verdict below.
   *
   * @param host - The accessory a refusal speaks for.
   *
   * @returns True while that accessory should refuse.
   */
  public unavailableFor(host: HydrawiseAccessory): boolean {

    return this.unavailable || ((host !== this.accessory) && ![...this.zoneHosts.values()].includes(host));
  }

  /* Whether this controller's own accessory refuses: the controller-wide answer above, or a rain sensor it carries with no current reading, which is no current
   * facts or an answer that cannot say which sensors exist. HomeKit shows a whole accessory as not responding when one characteristic refuses, so this is the answer
   * the Home app renders for the accessory, while its other handlers keep to the answer above. A rain sensor's read and the availability word read this one. With no
   * rain sensor carried it is the answer above, and a standalone zone accessory, which carries none, is not asked.
   */
  private get accessoryRefuses(): boolean {

    return this.unavailable || ((this.rainSensorServices.length > 0) && !this.rainReadingCurrent);
  }

  // Whether the account's facts can answer for the rain sensors right now: there are current facts, and they can say which sensors exist.
  private get rainReadingCurrent(): boolean {

    return Boolean(this.currentFacts?.rainSensors);
  }

  // The Not Responding rule for one accessory this controller projects onto, bound once per accessory over the per-host answer above. The predicate is read on
  // every call, so the wrapper never needs rebinding as the verdict or the hosting moves.
  private answeringFor(host: HydrawiseAccessory): ReturnType<typeof notResponding> {

    return notResponding({ errorClass: this.hap.HapStatusError, unavailable: () => this.unavailableFor(host) });
  }

  /* Move the polling loop's verdict, narrating the move and restating the availability word. An unchanged verdict is a no-op, so a caller states what it learned
   * without first asking what was known. Each loss is one line and each recovery another, while the first contact of the run says nothing, because discovery's
   * connection line already said it. A quiet move narrates nothing, for a loss whose cause the caller has already reported.
   */
  private setContact(next: Exclude<HydrawiseContact, "pending">, { quiet = false }: { quiet?: boolean } = {}): void {

    const prior = this.contact;

    if(prior === next) {

      return;
    }

    this.contact = next;

    if(!quiet) {

      switch(next) {

        case "lost":

          this.log.info((prior === "pending") ?
            "Hydrawise is not responding for this controller. HomeKit will show it as not responding until the connection recovers." :
            "Hydrawise has stopped responding for this controller. HomeKit will show it as not responding until the connection recovers.");

          break;

        case "reachable":

          if(prior === "lost") {

            this.log.info("Hydrawise is responding again for this controller.");
          }

          break;
      }
    }

    this.refreshAvailability();
  }

  /* Publish this controller's availability word on its own topic, retained so a subscriber attaching later reads the last statement, and change-gated so a
   * verdict re-judged with nothing moved costs nothing on the wire. The word reads the verdict on the controller's own accessory, rain sensors included, so a poll or
   * a facts arrival re-judges it and MQTT and HomeKit stay in agreement, a reading that ages out reaching the word at the next poll. Once the MQTT client's end
   * begins, HBPU's end() refuses every publish but the words its handlers state, so a poll or a reconnect landing inside the end's window restates nothing and the
   * offline the plugin stops on stays the last word on the topic.
   */
  private refreshAvailability(): void {

    this.reportRainReading();

    const word: MqttAvailabilityPayload = this.accessoryRefuses ? MQTT_AVAILABILITY_OFFLINE : MQTT_AVAILABILITY_ONLINE;

    this.platform.mqtt?.publishGuarded(this.availabilityTopic, word, { ifChanged: true, retain: true });
  }

  /* Say why the controller shows No Response when a rain sensor's reading is the cause: one line as the reading goes and one as it returns, judged where the word is.
   * A process with no reading yet says nothing, since its first refresh may simply not have landed and a failed one has already said why. With no rain sensor carried
   * there is no reading to speak for, so the record starts afresh.
   */
  private reportRainReading(): void {

    if(!this.rainSensorServices.length) {

      this.rainReading = null;

      return;
    }

    const current = this.rainReadingCurrent;

    if((this.rainReading === null) && !current) {

      return;
    }

    if((this.rainReading !== null) && (this.rainReading !== current)) {

      this.log.info(current ? "Rain sensors are responding again." :
        "Rain sensors are not responding because your Hydrawise account details could not be refreshed.");
    }

    this.rainReading = current;
  }

  /* The account-credentialed facts if and only if they can still be trusted, and null otherwise. This is the single freshness judgment in the class, and every
   * way there is nothing to trust - none ever arrived, the last ones have aged past their lifetime, or no credentials are configured at all - answers the same
   * null, so no consumer has to tell them apart.
   *
   * It hands back the WHOLE snapshot rather than the zones map alone, because every gated consumer draws the same judgment: the per-zone classifier inputs, the
   * projection's availability stamp, the MQTT payload's additive fields, the rain sensors' reading, and the availability verdict, which reads the cloud's word on
   * whether the controller is online. Returning the map alone would force a second, parallel freshness read for the facts that are not per-zone, which is exactly the
   * divergence one chokepoint exists to prevent.
   *
   * A pass resolves this ONCE and threads the answer down, so a lifetime boundary crossed midway through a poll can never split that poll's classifications
   * between two different answers.
   */
  private get currentFacts(): Nullable<HydrawiseControllerFactsSnapshot> {

    if(!this.v2Facts) {

      return null;
    }

    return ((Math.floor(this.platform.clock.now() / 1000) - this.v2Facts.fetchedAt) <= HYDRAWISE_V2_FACTS_TTL) ? this.v2Facts : null;
  }

  /* Re-derive everything that follows from the classified projection, and report whether that projection moved. Every cadence that can change a zone's
   * classification runs this - the poll, which brings fresh wire truth, a refresh tick, which brings fresh account facts, and a successful suspension command,
   * whose acceptance is a fact about the zones it named - so a suspension reaches HomeKit, the log, and the accessory cache with whatever learned of it rather
   * than waiting for the next poll.
   *
   * The schedule write marks the accessory for the save window where it is made, so every cadence that moves the projection saves it with no write policy of its
   * own. The boolean returned here gates the status publish alone: the refresh and command cadences publish on it, while the poll publishes on every pass.
   *
   * This is deliberately not a whole applyStatus re-run. That method also drives the standalone-accessory reconcile, whose wire-absence grace COUNTS POLLS, so
   * re-entering it outside a poll would double-count that grace and could demote an accessory the wire never actually dropped.
   *
   * Before the first completed poll there is nothing to classify, so the pass returns at once having moved nothing.
   */
  private applyProjection(facts: Nullable<HydrawiseControllerFactsSnapshot>): boolean {

    if(!this.status.relays.length) {

      return false;
    }

    /* Decide which commands still stand ONCE, before anything classifies. Everything downstream in this pass - the composition, the switch readers, the
     * narration - then reads the same surviving set, so a command cannot be standing for one of them and retired for another.
     */
    this.retireSupersededCommands(facts);

    const changed = this.persistScheduleStatus(facts);

    this.refreshSuspensionStates();

    // The suspend switch reads the classification this pass just persisted, so it is refreshed here rather than at any caller: one derivation, one position.
    this.accessory.getServiceById(this.hap.Service.Switch, HydrawiseReservedNames.SWITCH_SUSPEND_ALL)?.updateCharacteristic(this.hap.Characteristic.On,
      this.isAllSuspended(facts));

    // The per-zone switches answer to the same classification, on every cadence, for the same reason.
    this.refreshZoneSuspendSwitches(facts);

    return changed;
  }

  /* Drop every suspension command this pass supersedes, so that what remains is exactly the set that still speaks for what it was issued against.
   *
   * A command retires when facts postdate it, which is the freshness rule's other face, or when its zone leaves the wire report, which leaves nothing for the
   * command to speak for. A zone that leaves the wire takes every request still pending for it along too, its valve's and its switch's, since no control is left
   * for them to be sent on behalf of.
   *
   * This runs at the head of a pass rather than beside any one consumer, so the records the pass goes on to read are the ones that survived it. A command the
   * account has already answered is gone for good, where a record kept for its readers to weigh would speak again the moment the facts that answered it aged out. The
   * status check is the other kind of evidence a pass can hold, weighed here for the same reason.
   */
  private retireSupersededCommands(facts: Nullable<HydrawiseControllerFactsSnapshot>): void {

    this.commands.sweep({ reported: new Set(this.status.relays.map(zone => zone.relay_id)), stands: (record): boolean => this.commandStands(record, facts) });
    this.forgetContradictedSuspendAll();
  }

  /* Forget a remembered Suspend All that a newer status check disproves, on an install with no account login, where nothing else could ever correct it. An install
   * with a login leaves this to the next account refresh, which answers on better evidence.
   *
   * The evidence is a real upcoming run on any zone, on a status check requested in a later second than the confirmation: we read Hydrawise as never showing a stale
   * schedule on a check requested after it confirmed a suspend, so that run means watering was resumed from somewhere else. A check already on its way when the command
   * was confirmed proves nothing, and neither does a command the user has pending, which is about to say more than the wire can. Only a remembered suspension is weighed,
   * because "no upcoming run" has several meanings and so can never disprove a remembered resume.
   *
   * Forgetting the one record frees every zone with it, and from then on the switch reads the wire estimate an install reads after a restart. A wrong reading costs a
   * display alone - the line below and a "Suspension lifted." for each zone, and the switch off until that estimate reads on again - with no water, since Hydrawise
   * itself stays suspended.
   */
  private forgetContradictedSuspendAll(): void {

    const command = this.commands.record(SUSPEND_ALL_TARGET);

    if(this.platform.hasV2Client || (typeof command?.commandedUntil !== "number") || this.commands.pending(SUSPEND_ALL_TARGET) ||
      !this.postdates(this.statusFetchedAt, command) || !this.status.relays.some(zone => zoneHasUpcomingRun(zone, this.status))) {

      return;
    }

    this.commands.forget(SUSPEND_ALL_TARGET);
    this.log.info("Scheduled watering for all zones appears to have been resumed outside of HomeKit.");
  }

  /* Show every companion switch what its zone now reads as.
   *
   * Every cadence that can move a zone's suspension arrives here through applyProjection: the poll, which brings fresh wire truth, a refresh tick, which brings
   * the account facts a suspension is actually reported on, and a successful suspension command, whose acceptance is itself a fact about the zone it named - so
   * a suspension made in the Hydrawise app reaches its switch with the refresh that learned of it rather than waiting for a poll that cannot see it.
   */
  private refreshZoneSuspendSwitches(facts: Nullable<HydrawiseControllerFactsSnapshot>): void {

    const classified = new Map((this.accessory.context.schedule?.zones ?? []).map(entry => [ entry.relayId, entry ]));

    for(const zone of this.status.relays) {

      // The switch speaks its own name's language: On means SUSPENDED, matching the account-wide suspend switch's convention. A zone's active state already lives
      // on its valve, so a switch that read the other way would put two answers to one question in front of the user.
      this.zoneHosts.get(zone.relay_id)?.getServiceById(this.hap.Service.Switch, suspendZoneSubtype(zone.relay_id))
        ?.updateCharacteristic(this.hap.Characteristic.On, this.isZoneSuspended(zone, classified.get(zone.relay_id), facts));
    }
  }

  /* The last account name a persisted entry still speaks with, or nothing where it cannot. This is the single home for the name carry's judgment, asked at the
   * zone grain and the controller grain alike, so what "still speaks" means cannot be answered two ways.
   *
   * The carry exists to undo TRUNCATION. The key-based API cuts a name at roughly fifteen characters, so a zone the account calls "Backyard Planters Drip"
   * arrives on the wire as "Backyard Plante", and a pass with no account facts in hand would otherwise rewrite every label back to the cut form and heal it
   * again a refresh later. What is offered here holds the fuller name still across those gaps: the window after a restart before the account token grant
   * completes, and any refresh outage mid-session.
   *
   * The PREFIX relationship is truncation's fingerprint, and asking for it is what keeps the carry to the job it exists for. A cut name is always the head of
   * the name it was cut from, so a prior that starts with what the wire now reports is the untruncated form of that same name and is safe to hold. A genuine
   * rename on the Hydrawise side breaks the relationship, and the new name shows through immediately rather than being held behind a stale one. Equality is
   * included and carries trivially: a name short enough to survive the cut arrives whole, and holding a value identical to the wire's changes nothing.
   *
   * The relationship is capture-proven at the ZONE grain, where the recorded wire bodies show the hard character cut. A controller whose account name stands
   * outside it simply does not carry, and the name the key-based wire reports stands, which is the same answer that grain has always given.
   *
   * The offer is made only where the credentials that produced those names are configured, which is what makes removing them a clean revert to the wire's own
   * names rather than stranding an account name nothing is left to refresh.
   *
   * @param prior    - The name the persisted entry already carries, or undefined where it has none.
   * @param wireName - The name the key-based wire reports for the same thing right now.
   *
   * @returns The prior name where it still speaks for this thing, and undefined otherwise.
   */
  private carriedName(prior: string | undefined, wireName: string): string | undefined {

    return (this.platform.hasV2Client && prior?.startsWith(wireName)) ? prior : undefined;
  }

  /* The name a zone actually carries, in precedence order: the account API's own when a trustworthy snapshot has one for it, the last account name this zone's
   * persisted entry still speaks with, and the name the key-based wire reports.
   *
   * The middle rung needs no store of its own: the persisted roster IS the store, read as the prior before this pass rewrites it, so the rung can only ever
   * offer a value a previous pass composed and facts always outrank it.
   *
   * The null asymmetry is deliberate and differs from the suspension carry's. A facts entry whose name is null means no usable name arrived - the projection
   * normalizes an empty or whitespace-only answer to null - so it is an absence that HOLDS the carry, where a null suspension is a real answer that retires its
   * own. The acknowledged cost is that a name a user genuinely blanks in the Hydrawise app holds its last carried name while enhanced features stay on, because
   * the wire offers no signal that tells a blanked name from an unanswered one.
   *
   * This is the one home for that rule, and the display name is deliberately NOT part of it. A user's Name option overrides what HomeKit SHOWS while this answers
   * what the zone IS - which is why the persisted identity and the MQTT payload read here while the valve's label reads the effective name composed above it.
   */
  private zoneName(zone: HydrawiseZoneConfig, facts: Nullable<HydrawiseControllerFactsSnapshot>): string {

    return facts?.zones.get(zone.relay_id)?.name ??
      this.carriedName(this.accessory.context.zones?.find(entry => entry.relayId === zone.relay_id)?.name, zone.name) ?? zone.name;
  }

  // One zone's naming: the zone composer's answer over the user's Name option and the name resolved above, beside the Name option value it was composed from, so
  // the ownership rule reads the very value the composer read.
  private composeZoneName(zone: HydrawiseZoneConfig, facts: Nullable<HydrawiseControllerFactsSnapshot>): HydrawiseZoneNaming {

    const override = this.zoneNameOverride("Device.Name", zone.relay_id.toString());

    return { composed: zoneDisplayName({ override, relay: zone.relay, reported: this.zoneName(zone, facts) }), override };
  }

  /* The name this controller actually carries, on exactly the terms a zone's name resolves above and through the same rungs in the same order: the account API's
   * own when a trustworthy snapshot has one, the last account name the persisted self-identity still speaks with, and the name the key-based wire reports.
   *
   * The carry rung reads the identity LIVE rather than from a value captured once, which is what lets one mechanism serve both gaps it exists for: the identity
   * is restored across the context wipe at construction, so it answers the restart, and each poll resyncs it, so it answers a mid-session outage too.
   *
   * The same identity-versus-display split applies. A user's Name option overrides what HomeKit SHOWS while this answers what the controller IS, which is why the
   * persisted identity and the account roster read here while the services' labels read the effective name composed above them.
   */
  private controllerName(facts: Nullable<HydrawiseControllerFactsSnapshot>): string {

    return facts?.name ?? this.carriedName(this.accessory.context.controller?.name, this.controller.name) ?? this.controller.name;
  }

  /* The name the plugin composes for this controller: the controller composer's answer over the user's Name option and the name resolved above. The accessory's
   * display name follows it from construction on, and the rename pass hands it to the naming rule. That pass reads the Name option once and passes it here, so the
   * composer and the rule cannot answer from different values, while a caller with no rule to feed lets the option be read here.
   */
  private composeControllerName(facts: Nullable<HydrawiseControllerFactsSnapshot>,
    override: Nullable<string | undefined> = this.controllerNameOverride("Device.Name")): HydrawiseComposedName {

    return controllerDisplayName({ override, reported: this.controllerName(facts) });
  }

  /* Bring the accessory's display name into line with the name the plugin composes for this controller on every pass, and every name this controller shows in
   * HomeKit into line with the name the plugin owns for it, holding each one a rename in the Home app can reach to that name. The owner is HBPU's naming rule over
   * the controller composer's answer, which is always a name HomeKit can carry: a Name option HomeKit can carry owns the name whatever synchronization says,
   * otherwise synchronization hands it to the name resolved above, and otherwise the user owns it and this pass writes the display name alone. The display name is
   * Homebridge's own label, which HomeKit never reads for a bridged accessory, so it follows the composed name whoever owns the HomeKit names: a rename on the
   * Hydrawise side or a Name option the user cleared reaches the accessory cache, while the names the user owns stand in HomeKit. One cadence carries every rename
   * this plugin performs: this runs on the poll, exactly where the zone walk applies its own, so a controller and its zones adopt a Hydrawise-side rename together
   * rather than one of them lagging a refresh behind.
   *
   * Each surface compares itself. The irrigation system service, the service label enumerating its zones, the accessory's own display pair and information
   * service, and the suspend-all switch are each handed their name through HBPU's name helpers, which sanitize it, write only what differs, and answer whether
   * they wrote. The comparison runs in the sanitized form on both sides, so a configured value HomeKit's naming rules cannot round-trip reads as unchanged rather
   * than being rewritten on every poll, and a surface that drifted on its own - a tile the cache restored under a rename made in the Home app, a switch restored
   * from a session under another controller name - is brought back into line on its own terms. Any write marks the accessory for the save window, because the
   * accessory's display name and its services' names live in Homebridge's cache, and a rename that never reached it would come back under its old label at the
   * next restart.
   *
   * The information service and the suspend-all switch carry ConfiguredName, the one name characteristic a HomeKit controller can write, so each is held for this
   * pass and a rename made in the Home app is put back at once rather than at the next poll. The irrigation system carries Name alone and the service label no
   * name characteristic at all, so neither offers the Home app anything to rename, and both are renamed and never watched.
   *
   * A pass on which the plugin owns the name is one of the passes that decide the controller's fallback warning, so a controller this pass names by its kind's
   * word is warned about once while the word applies.
   *
   * @param facts - The account-credentialed facts this pass resolved, or null when there are none to trust.
   */
  private applyControllerName(facts: Nullable<HydrawiseControllerFactsSnapshot>): void {

    const irrigationService = this.accessory.getService(this.hap.Service.IrrigationSystem);
    const override = this.controllerNameOverride("Device.Name");
    const composed = this.composeControllerName(facts, override);
    const owned = ownedName({ fallback: composed.name, override, sync: this.hasFeature("Device.SyncName") });

    // The display pair follows the composed name on every pass, and HBPU's helper writes the information service's names beside it only while the plugin owns
    // them. Where the plugin owns the name, the name it owns is the composed name, so the helper is handed one name whoever owns it.
    if(setAccessoryName(this.accessory, composed.name, { owned: owned !== null })) {

      this.platform.persistence.persist(this.accessory);
    }

    /* The family's naming rule decides who owns the HomeKit names, the same at the zone grain: a Name option HomeKit can carry owns them on every pass, whatever
     * synchronization says, so a rename made in the Home app yields to it; with none, synchronization hands them to the name Hydrawise reports; and with neither,
     * the user owns them, each is set once when its service is created and never touched again, and a rename made in the Home app stands. The Name option is read
     * once and handed to both the composer and the rule, so the two cannot answer from different values.
     */
    if(!irrigationService || (owned === null)) {

      return;
    }

    // The service label is created beside the irrigation system carrying the same name, and the suspend-all switch composes its name from the controller's, so
    // each is handed the name it was created from.
    const informationService = this.accessory.getService(this.hap.Service.AccessoryInformation);
    const labelService = this.accessory.getService(this.hap.Service.ServiceLabel);
    const suspendService = this.accessory.getServiceById(this.hap.Service.Switch, HydrawiseReservedNames.SWITCH_SUSPEND_ALL);
    const suspendName = owned + " Suspend All Zones";
    const writes = [ setServiceName(irrigationService, owned), (labelService !== undefined) && setServiceName(labelService, owned),
      (suspendService !== undefined) && setServiceName(suspendService, suspendName) ];

    if(writes.includes(true)) {

      this.platform.persistence.persist(this.accessory);
    }

    if(informationService) {

      this.holdServiceName(informationService, owned);
    }

    if(suspendService) {

      this.holdServiceName(suspendService, suspendName);
    }

    this.decideControllerFallback(composed);
  }

  /* Bring each rain sensor's name into line with the name Hydrawise reports for it while Sync Name holds at the controller, and hold it to that name for this pass, as
   * a zone's suspension switch is held. This runs on the poll alone, so a name a facts arrival learned reaches the sensor when it reaches every other surface. A sensor
   * whose facts carry no name keeps the one it has, and with synchronization off the name is the user's. HBPU's name helper refuses a name HomeKit cannot carry, so
   * such a name writes nothing and its watch restores nothing.
   *
   * @param facts - The account-credentialed facts this pass resolved, or null when there are none to trust.
   */
  private applyRainSensorNames(facts: Nullable<HydrawiseControllerFactsSnapshot>): void {

    for(const [ id, { name } ] of facts?.rainSensors ?? []) {

      const service = this.accessory.getServiceById(this.hap.Service.ContactSensor, rainSensorSubtype(id));
      const owned = (name === null) ? null : ownedName({ fallback: name, sync: this.hasFeature("Device.SyncName") });

      if(!service || (owned === null)) {

        continue;
      }

      if(setServiceName(service, owned)) {

        this.platform.persistence.persist(this.accessory);
      }

      this.holdServiceName(service, owned);
    }
  }

  // Hold one service to the name this pass decided the plugin owns for it, until the next pass replaces this pass's watches. The watch answers the name this pass
  // wrote rather than one composed afresh at the rename, because a name composed from facts newer than the pass would be one no other surface carries.
  private holdServiceName(service: Service, owned: string): void {

    this.nameWatches.use(watchServiceName({ log: this.log, name: (): string => owned, service, signal: this.platform.signal }));
  }

  /* Decide one tile's fallback warning from the name a deciding pass composed for it, answering whether this pass is the one that warns. The answer reads the
   * composer's source rather than the name, because a tile its owner named "Controller" or "Zone 3" carries the word without the fallback having named it.
   */
  private decideFallbackWarning(tile: HydrawiseNameTile, composed: HydrawiseComposedName): boolean {

    if(composed.source !== "fallback") {

      this.fallbackWarned.delete(tile);

      return false;
    }

    if(this.fallbackWarned.has(tile)) {

      return false;
    }

    this.fallbackWarned.add(tile);

    return true;
  }

  // Decide the controller's own fallback warning, from its services' creation or from a rename pass, and say it when this pass is the one that warns. The serial
  // names the controller, since the name the log prefix carries is then the word itself.
  private decideControllerFallback(composed: HydrawiseComposedName): void {

    if(this.decideFallbackWarning("controller", composed)) {

      this.log.warn("HomeKit cannot use the name of this controller (serial: %s), so HomeKit shows it as %s. Set a Name for it in the plugin's settings, using " +
        "letters or numbers, to choose another.", this.controller.serial_number, composed.name);
    }
  }

  /* Whether a suspension command still speaks for what it was issued against, which it does exactly while no fresher truth has arrived to supersede it. This is
   * the one comparison home for the guard at BOTH grains - every reader of a standing command, the composition among them, plus the sweep that clears retired
   * entries - so what "still standing" means cannot be answered two ways, and the switches and the projection cannot disagree about it.
   *
   * Only a STRICTLY newer snapshot retires a command, which is the account-wide guard's own rule at the zone grain. Both instants are whole seconds, so a fetch
   * stamped in the same second as the command could have been dispatched either side of it, and the tie goes to the user: holding their command costs at most one
   * refresh of staleness, while handing the second to the fetch reopens the very race of a snapshot flipping a switch back under their finger.
   *
   * A null snapshot KEEPS a standing command standing. None ever arrived, the last one aged out, or the refresh has stalled: in every case nothing newer has
   * contradicted the user, so their own command is the honest thing to display until facts that postdate it land.
   */
  private commandStands(command: HydrawiseCommandRecord | undefined, facts: Nullable<HydrawiseControllerFactsSnapshot>): command is HydrawiseCommandRecord {

    return (command !== undefined) && (!facts || !this.postdates(facts.fetchedAt, command));
  }

  // Whether evidence requested at an instant postdates a command, the one comparison every kind of evidence is weighed by. Only a strictly later second does, for the
  // reason above: a request stamped in the command's own second could have been dispatched before it or after it.
  private postdates(requestedAt: number, command: HydrawiseCommandRecord): boolean {

    return requestedAt > command.at;
  }

  /* The suspension command that still speaks for a zone: its own record where it holds one, and otherwise the Suspend All's. The switches and the composition read
   * it here, so a zone cannot be covered for one of them and free for the other.
   */
  private zoneCommand(zone: HydrawiseZoneConfig, facts: Nullable<HydrawiseControllerFactsSnapshot>): HydrawiseCommandRecord | undefined {

    const command = this.commands.zoneRecord(zone);

    return this.commandStands(command, facts) ? command : undefined;
  }

  /* Whether a zone reads as suspended right now. The user's own request still waiting to be settled answers first, so the switch holds their choice whatever a
   * poll or a refresh lands meanwhile, a standing command answers next, and the classified projection answers otherwise, so the switch and the zone list are one
   * reading rather than two derivations that can drift.
   *
   * The command arm is asked DIRECTLY rather than read off the composition, and the running window is why it cannot be collapsed into it. A zone suspended while
   * it is watering keeps its switch on - the user's command was accepted - while the projection honestly reads running until the water stops, because flowing
   * water is the one thing no command overrules. Those are two different questions, and both are answered from the one standing judgment above rather than from
   * two sources that could drift.
   */
  private isZoneSuspended(zone: HydrawiseZoneConfig, state: HydrawiseZoneScheduleStatus | undefined, facts: Nullable<HydrawiseControllerFactsSnapshot>): boolean {

    const pending = this.commands.pending({ kind: "zone-suspend", zone });

    if(pending) {

      return pending.on;
    }

    const command = this.zoneCommand(zone, facts);

    return command ? (command.commandedUntil !== null) : (state?.state === "suspended");
  }

  /* Narrate each zone whose suspension state changed, and store the new state for the next comparison. The states come from the projection this pass persisted,
   * so what the log says and what the webUI shows are the same reading rather than two derivations that can drift.
   *
   * A zone with no ledger entry is skipped rather than seeded here: the poll walk seeds every zone it projects, from the live reading, which is what keeps a zone
   * first sighted while already suspended from announcing a transition it never made.
   */
  private refreshSuspensionStates(): void {

    for(const entry of this.accessory.context.schedule?.zones ?? []) {

      const hint = this.zoneHints.get(entry.relayId);
      const isSuspended = entry.state === "suspended";

      if(!hint || (hint.isSuspended === isSuspended)) {

        continue;
      }

      this.zoneHints.refreshSuspended(entry.relayId, isSuspended);

      const zone = this.status.relays.find(candidate => candidate.relay_id === entry.relayId);

      if(!zone || !this.hasZoneFeature("Log.Zone", entry.relayId.toString())) {

        continue;
      }

      this.log.info("%s: %s", this.zoneLabel(zone), (entry.state === "suspended") ? "Suspended until " + this.formatInstant(entry.until) + "." :
        "Suspension lifted.");
    }
  }

  // Configure MQTT services. Each subscription answers on the topic the constructor composed from the catalog, and logs under the catalog's label.
  private configureMqtt(): void {

    // Return our irrigation controller state.
    this.platform.mqtt?.subscribeGet(this.controllerTopic, mqttTopics.controller.label, (): string => this.statusJson(this.currentFacts));

    // Return our rain sensors, on an install that has them.
    if(this.hints.rainSensors) {

      this.platform.mqtt?.subscribeGet(this.rainSensorsTopic, mqttTopics.rainSensors.label, (): string => this.rainSensorsJson(this.currentFacts));
    }

    // Set the state of a given irrigation zone. The command goes through the controller's queue on the same terms a tap on the zone's valve does, so the handler
    // returns as soon as the command is queued, and only a set it cannot read throws.
    this.platform.mqtt?.subscribeSet(this.controllerTopic, mqttTopics.controller.label, (value: string): void => {

      // A controller that is not responding takes no command, on the same terms its HomeKit handlers refuse one. We throw so the library logs the refusal, before
      // the command is even parsed.
      if(this.unavailable) {

        throw new Error("MQTT: The controller is not responding.");
      }

      const action = value.split(" ");
      const zoneValue = parseInt(action[1] ?? "");
      const zone = this.status.relays.find(x => x.relay === zoneValue);

      // No zone found for the parsed number. We throw so HBPU's subscribeSet convention logs the error, rather than logging locally and emitting a spurious
      // success line alongside it.
      if(!zone) {

        throw new Error("MQTT: Invalid zone specified.");
      }

      switch(action[0]) {

        case "start": {

          /* The duration token is optional. Without one, the zone runs for its own run value - its next scheduled duration, or its remaining time while it is
           * already running - and a zone with no scheduled run has no duration to offer, so the command is refused. A token that does not parse to an integer is
           * refused the same way, by throwing, so the library logs the reason exactly as it logs an unknown zone or verb. A token that parses to zero or below is
           * handed on, and the command guard declines it without sending anything.
           */
          const token = action[2] ?? "";

          if(!token.length) {

            if(!(zone.run > 0)) {

              throw new Error("MQTT: No duration given and the zone has no scheduled run.");
            }

            this.commandValve({ duration: zone.run, on: true, origin: "mqtt", zone });

            return;
          }

          const parsed = Number(token);

          if(!Number.isSafeInteger(parsed)) {

            throw new Error("MQTT: Invalid duration specified.");
          }

          this.commandValve({ duration: parsed, on: true, origin: "mqtt", zone });

          return;
        }

        case "stop":

          this.commandValve({ on: false, origin: "mqtt", zone });

          return;

        default:

          throw new Error("Invalid command.");
      }
    });

    // Restate this controller's availability on every broker session. The client sends nothing it was asked to publish while disconnected, and the facts the
    // verdict reads can age out with no event to mark it, so the word a subscriber holds is restated each time a session begins.
    this.platform.mqtt?.onConnect(() => this.refreshAvailability(), { signal: this.platform.signal });

    /* State this controller's final word as the plugin stops: a retained offline on its availability topic, which nothing else speaks for once the plugin has
     * stopped, because the client's last will covers only the plugin's own availability topic. The client's end invokes this while its session still holds and
     * waits for the word within its grace before it tears down. From the moment the end begins, HBPU's end() refuses every publish but the words its handlers
     * state, so nothing restates behind the word. The word carries the end's signal, the one signal the end admits a publish under, and no change gate, since
     * the gate weighs a word against whatever the topic last carried and can suppress it, and a refusal is noted at debug alone, because the plugin is stopping
     * and the user has nothing to act on.
     */
    this.platform.mqtt?.onEnd(async (signal: AbortSignal): Promise<void> => {

      try {

        await this.platform.mqtt?.publish(this.availabilityTopic, MQTT_AVAILABILITY_OFFLINE, { retain: true, signal });
      } catch(error) {

        this.log.debug("Unable to state %s offline at shutdown: %s.", this.availabilityTopic, formatErrorMessage(error));
      }
    }, { signal: this.platform.signal });
  }

  /* Configure the irrigation system service for HomeKit.
   *
   * Creation consults the user's Name option through the controller's own composer, over the name the controller carries, so a fresh service is born under the
   * configured truth rather than renamed to it a poll later, whoever owns the name; the rename step then holds a set Name on every pass, whatever synchronization
   * says. It is the composition construction aligned the display name with, which the suspend-all switch and a rain sensor's fallback name compose from, so every
   * name the controller creates reads one composition, the full name a restored self-identity carries included. The composed name is read only where this creates
   * the service, because acquireService leaves the name of a service the cache restored untouched. Creating the service is one of the passes that decide the
   * controller's fallback warning, so a controller created under its kind's word is warned about at once, an install whose user owns the name, and whose rename
   * step therefore decides nothing, included.
   */
  private configureIrrigationSystem(): void {

    const composed = this.composeControllerName(this.currentFacts);

    // Acquire the service and if needed, add a service label service in order to be able to properly enumerate and name the individual zone valves. Both are
    // created carrying the same name, which is the pairing the rename step relies on when it brings the label along with the service it sits beside.
    const { service, transition } = acquireService({ accessory: this.accessory, name: composed.name,
      onServiceCreate: () => acquireService({ accessory: this.accessory, name: composed.name, serviceType: this.hap.Service.ServiceLabel }).service
        .updateCharacteristic(this.hap.Characteristic.ServiceLabelNamespace, this.hap.Characteristic.ServiceLabelNamespace.ARABIC_NUMERALS),
      serviceType: this.hap.Service.IrrigationSystem });

    if(transition === "attached") {

      this.decideControllerFallback(composed);
    }

    // Initialize the service.
    service.updateCharacteristic(this.hap.Characteristic.Active, this.hap.Characteristic.Active.ACTIVE);
    service.updateCharacteristic(this.hap.Characteristic.InUse, this.hap.Characteristic.InUse.NOT_IN_USE);
    service.updateCharacteristic(this.hap.Characteristic.ProgramMode, this.hap.Characteristic.ProgramMode.PROGRAM_SCHEDULED);

    /* The irrigation system's Active is this accessory's primary characteristic, so it is where HomeKit reads whether the whole accessory responds, and its
     * handlers go through the controller's Not Responding rule. A read answers Active, the plugin's standing projection. A write - from the Home app or an
     * automation - has nothing to command, since the controller is always active as far as Hydrawise is concerned, so it is accepted and Active is put back after a
     * beat through the platform's registry, the same revert every refused command takes.
     */
    service.getCharacteristic(this.hap.Characteristic.Active).onGet(this.answering(() => this.hap.Characteristic.Active.ACTIVE));

    service.getCharacteristic(this.hap.Characteristic.Active).onSet(this.answering((): void => {

      this.platform.timers.schedule(() => service.updateCharacteristic(this.hap.Characteristic.Active, this.hap.Characteristic.Active.ACTIVE),
        HYDRAWISE_REVERT_DELAY);
    }));

    /* The plugin learns no hardware fault from any API it reads, so the irrigation system carries no fault characteristic on any install, and whether Hydrawise can be
     * reached is answered through the handlers above instead. The removal runs on every pass, because HAP round-trips characteristics through the accessory cache
     * and one restored from the cache would otherwise keep displaying a reading nothing is left to update.
     */
    validCharacteristic({ characteristic: this.hap.Characteristic.StatusFault, service, validate: false });
  }

  // Configure suspend switch services for HomeKit.
  private configureSuspendSwitches(): void {

    /* Reconcile the switch's presence with the user's setting in one call, which creates it when the setting wants it and removes it when the setting does not. A
     * fresh switch composes its name from the accessory's display name, which construction aligned with the controller composer's answer, so it is created under
     * the name the plugin composes for the controller, and a restored switch keeps the name it came back with, because HBPU leaves a kept service's name untouched.
     * The irrigation system's creation and the rename pass decide the fallback warning for that name, so this decides none.
     */
    const switchName = this.accessory.displayName + " Suspend All Zones";
    const { service } = validService({ accessory: this.accessory, name: switchName, serviceType: this.hap.Service.Switch,
      subtype: HydrawiseReservedNames.SWITCH_SUSPEND_ALL, validate: this.hints.suspendAll });

    // A switch the setting removed, or never wanted, leaves nothing to configure.
    if(!service) {

      return;
    }

    /* Suspend or resume the irrigation schedule. Its handlers go through the controller's Not Responding rule, so a suspend-all is never queued, and never read
     * back, while the controller cannot be reached. A write queues the user's choice and returns at once, and the switch reads that choice back for as long as it
     * waits to be settled.
     */
    service.getCharacteristic(this.hap.Characteristic.On).onGet(this.answering(() => this.isAllSuspended(this.currentFacts)));

    service.getCharacteristic(this.hap.Characteristic.On).onSet(this.answering((value: CharacteristicValue): void => {

      this.commands.enqueue(SUSPEND_ALL_TARGET, { on: Boolean(value), origin: "homekit" });
    }));

    service.updateCharacteristic(this.hap.Characteristic.On, this.isAllSuspended(this.currentFacts));

    this.platform.featureOptions.logFeature({ controller: { id: this.controller.serial_number, log: this.log }, label: "Suspend all zones switch",
      log: this.platform.log, option: "Device.Suspend.All" });

    // Without the account's word the switch reads the key-based wire's estimate, which cannot tell a suspension from an account with nothing scheduled, so the user is
    // told once what the switch can and cannot vouch for.
    if(!this.platform.hasV2Client) {

      this.log.info("Without your Hydrawise account login, the Suspend All switch shows an estimate, because the API key alone cannot confirm whether watering is " +
        "suspended.");
    }
  }

  // The rain sensors this controller's accessory carries, the cached ones included, matched on the service type and the composed subtype as the zone sweep matches.
  private get rainSensorServices(): Service[] {

    return this.accessory.services.filter(x => (x.UUID === this.hap.Service.ContactSensor.UUID) && isRainSensorSubtype(x.subtype));
  }

  /* Bring the rain sensors this controller's accessory carries into line with what this controller knows, at configuration and on each facts arrival. Only the account
   * can say which sensors exist, so what exists is decided from its answer rather than at construction alone.
   *
   * With the feature off, or no account login, every rain sensor the cache restored is removed. Otherwise every sensor carried is bound first, ahead of reading the
   * facts, so the pass from configuration binds what the cache restored and a cached sensor refuses until a reading lands. Current facts carrying a list then decide
   * which sensors exist and what each reads. With no current facts, or an answer that cannot say which sensors exist, nothing is added or removed, so one bad answer
   * cannot cost a sensor's service and the automations built on it. A sensor the list has stopped naming leaves at once, as a valve does.
   *
   * The contact state follows the family's moisture sensor: a tripped sensor reads open, not detected. Each add or removal marks the accessory for the save window,
   * since the cache holds the services an accessory carries. A throw here would end the refresh until a restart, which is why the facts reach this only with
   * their ids held to being numbers.
   */
  private reconcileRainSensors(): void {

    const services = this.rainSensorServices;

    if(!this.hints.rainSensors) {

      this.removeRainSensors(services);

      return;
    }

    for(const service of services) {

      this.bindRainSensor(service);
    }

    const listed = this.currentFacts?.rainSensors;

    if(!listed) {

      return;
    }

    const kept = new Set<Service>();

    for(const [ id, { name, tripped } ] of listed) {

      const { service, transition } = acquireService({ accessory: this.accessory, name: this.rainSensorName(name), serviceType: this.hap.Service.ContactSensor,
        subtype: rainSensorSubtype(id) });

      if(presenceChanged(transition)) {

        this.platform.persistence.persist(this.accessory);
      }

      this.bindRainSensor(service);
      service.updateCharacteristic(this.hap.Characteristic.ContactSensorState, tripped ? this.hap.Characteristic.ContactSensorState.CONTACT_NOT_DETECTED :
        this.hap.Characteristic.ContactSensorState.CONTACT_DETECTED);
      kept.add(service);
    }

    this.removeRainSensors(services.filter(service => !kept.has(service)));
  }

  // Remove rain sensors from this controller's accessory, each removal marking it for the save window.
  private removeRainSensors(services: Service[]): void {

    for(const service of services) {

      this.accessory.removeService(service);
      this.platform.persistence.persist(this.accessory);
    }
  }

  /* Bind one rain sensor's read, once, under the establishment gate the valve uses. The read answers what facts last wrote, through the verdict on the whole accessory
   * rather than the controller's own rule, because a reading only the account can vouch for refuses as soon as the account's facts go stale, whatever the poll says.
   */
  private bindRainSensor(service: Service): void {

    if(this.bound.has(service)) {

      return;
    }

    const state = service.getCharacteristic(this.hap.Characteristic.ContactSensorState);

    state.onGet(this.rainAnswering(() => state.value));
    this.bound.add(service);
  }

  // The name a new rain sensor takes: the one Hydrawise reports where HomeKit can carry it, and otherwise one composed from the accessory's display name, as the
  // suspend-all switch composes its own, so a sensor is always created under a name.
  private rainSensorName(name: Nullable<string>): string {

    return ((name !== null) && sanitizeName(name).length) ? name : this.accessory.displayName + " Rain Sensor";
  }

  /* Poll the Hydrawise API forever, yielding one update per completed poll. This is the wire half of the loop: it owns the fetch, the retry policy that recovers
   * from a failed poll, the count of failed polls the loss verdict is read from, and the pacing the API asks for, and it touches no HomeKit service - a verdict it
   * moves reaches HomeKit through the handlers, which read it on each call. A shutdown abort unwinds it through the signal, which superviseLoop treats as the
   * expected exit; a throw that outlives the retry policy propagates out of the generator into the same envelope, ending the loop as a terminal fault.
   */
  private async *pollStatus(signal: AbortSignal): AsyncGenerator<HydrawisePollUpdate, void, undefined> {

    for(;;) {

      const isFirstRun = this.status.nextpoll === -1;

      // Update our status, retrying forever on a network failure or a malformed or mis-shaped body at the polling cadence. On the first run we use the fixed retry
      // interval; afterwards we honor the API's nextpoll hint, clamped so a failure never waits longer than twice the retry interval. A shutdown abort ends the
      // retry through the signal.
      // eslint-disable-next-line no-await-in-loop
      await retry(() => this.pollOnce(), { attempts: Infinity,
        backoff: (): number => (isFirstRun ? HYDRAWISE_API_RETRY_INTERVAL : Math.min(this.status.nextpoll + HYDRAWISE_API_JITTER, HYDRAWISE_API_RETRY_INTERVAL * 2)) *
          1000, clock: this.platform.clock, signal });

      // A poll has landed, so the run of failures behind the loss verdict starts again from nothing.
      this.pollFailures = 0;

      // Trim whitespace on zone names.
      this.status.relays = this.status.relays.map(x => ({ ...x, name: x.name.trim() }));

      // Hand the completed poll to whoever is consuming this generator.
      yield { status: this.status };

      // Sleep until our next polling interval due to the Hydrawise API being rate-limited. A shutdown abort interrupts the wait and unwinds the loop.
      // eslint-disable-next-line no-await-in-loop
      await this.platform.clock.delay((this.status.nextpoll + HYDRAWISE_API_JITTER) * 1000, { signal });
    }
  }

  /* One poll attempt, as the retry above runs it: fetch the status, and count the attempt when it fails. The count is what the loss verdict reads, so a run of
   * failed polls long enough to outlast a blip reads lost, while a single failure between good polls never does. A failure caused by shutdown is not counted,
   * because the plugin stopping says nothing about whether Hydrawise answers. Every failure is rethrown, so the retry's own policy decides what happens next.
   */
  private async pollOnce(): Promise<void> {

    try {

      await this.getStatus();
    } catch(error) {

      if(this.platform.signal.aborted) {

        throw error;
      }

      this.pollFailures++;

      if(this.pollFailures >= HYDRAWISE_POLL_LOSS_THRESHOLD) {

        this.setContact("lost");
      }

      throw error;
    }
  }

  // Project one completed poll onto HomeKit. This is the HomeKit half of the loop and the only half that touches a service: the persisted zone roster, the
  // enabled-zone projection and the prunes it drives, the per-zone valve state, the irrigation-system aggregates, the MQTT publish, and the suspend-all switch.
  // It is synchronous by design - the MQTT publish is dispatched fire-and-forget through the client's guarded publish - so one poll's projection lands in a single
  // frame with nothing awaited partway through it.
  private applyStatus(update: HydrawisePollUpdate): void {

    /* Let go of the last pass's name watches before anything else, so this pass registers its own on exactly the services it finds the plugin owning. Every
     * service a pass removes is removed after this point, the platform's demotions and grace expiries in the reconcile below included, so no removal can leave a
     * watch behind. The pass is synchronous, so no rename in the Home app lands between this disposal and the registrations, and a restore still waiting from the
     * last pass ends here, leaving the name to this pass's own rename, which writes the same name while the plugin still owns it.
     */
    this.nameWatches.dispose();
    this.nameWatches = new DisposableStack();

    const { status } = update;

    // Resolve the account-credentialed facts ONCE for this whole pass and thread the answer through everything below, so a lifetime boundary crossed partway
    // through cannot split one poll's classifications between two different answers.
    const facts = this.currentFacts;

    // Bring this controller's own names into line before anything reads them, so the log prefix and every label this pass writes speak with one voice. What it
    // wrote marks the accessory for the save window, because Homebridge's cache holds the accessory's names, which the next restore reads.
    this.applyControllerName(facts);
    this.applyRainSensorNames(facts);

    /* Persist the identity roster, the schedule projection, and this controller's own identity, each on change. Each write marks the accessory where it is made,
     * and the platform's save window carries every mark this pass makes into one cache write, so a poll costs at most one write no matter how many projections it
     * advanced. Every one of these runs before the enablement projection below, so what is persisted covers every reported zone, feature-disabled or not - the
     * complete listing and schedule the webUI reads back from cache with no cloud call.
     *
     * The self-identity carries the controller's TRUE name rather than the label HomeKit shows, which is the same line the zone roster draws: a user's private
     * override is display, and what the webUI lists and the account roster denormalizes is what the controller actually is.
     */
    this.persistZoneRoster(facts);
    this.applyProjection(facts);

    const identity = this.identity;

    if(!this.accessory.context.controller || !sameControllerIdentity(this.accessory.context.controller, identity)) {

      this.platform.persistence.persist(this.accessory, { controller: identity });
    }

    // The classification this pass just persisted, keyed by relay. Every consumer below - the zone walk's seeds, its rain and status sentences - reads a zone's
    // state from here rather than classifying again, so the log, HomeKit, and the accessory cache cannot tell different stories about the same zone.
    const classified = new Map((this.accessory.context.schedule?.zones ?? []).map(entry => [ entry.relayId, entry ]));

    // Project the reported zones onto the set the user has enabled. Every HomeKit surface in this pass - valves, aggregates, logging - works from this
    // projection, and long-lived handlers read it through the instance field so they always act on the current poll's truth.
    this.enabledZones = status.relays.filter(zone => this.hasZoneFeature("Device", zone.relay_id.toString()));

    /* Resolve each enabled zone's effective name once, ahead of everything that reads it, through the zone composer. The rungs, in precedence order: the user's
     * Name option where HomeKit can carry it, else the account API's own name for the zone, else the name the key-based wire reports, and the zone's word with its
     * relay number where HomeKit can carry nothing of the name those rungs settle on.
     *
     * The account rung is what makes an enriched install show whole names. The key-based API truncates at roughly fifteen characters, so a zone the account calls
     * "Backyard Planters Drip" arrives here as "Backyard Plante"; the account read already fetches that zone, so carrying its name costs no call at all. It reads
     * through the same freshness chokepoint every other account fact does, which is what keeps the promise to an install without credentials: with no trustworthy
     * snapshot the rung contributes nothing and the wire name stands, exactly as it always has.
     *
     * This is the ONE place a zone's displayed name is decided. Everything this pass names the zone with in HomeKit - the valve, a standalone accessory's own
     * display name, the companion suspension switch - reads the map this builds, so a name arriving from the account is simply a rename, travelling the same path a
     * rename made in the Hydrawise app already travels, and every line this pass logs about the zone is labeled from it. What the zone IS - the persisted roster
     * and the MQTT payload - reads zoneName above rather than this map. The Name option is read here once per zone and kept beside the composed name, because the
     * walk below hands that same value to the naming rule that decides who owns the zone's name, so the composer and the rule cannot answer from different values.
     */
    const zoneNames = new Map(this.enabledZones.map((zone): [ number, HydrawiseZoneNaming ] => [ zone.relay_id, this.composeZoneName(zone, facts) ]));

    // The enabled zones the user has asked to expose as HomeKit accessories of their own.
    const standaloneZones = this.enabledZones.filter(zone => this.hasZoneFeature("Device.Standalone", zone.relay_id.toString()));

    /* Hand the platform this poll's standalone request and take back the hosting map, which every hosting decision below reads so the prune and the walk cannot
     * disagree. The present-relay set carries EVERY zone the report named, before the enablement filter above, because that pre-filter population is what lets
     * the platform tell a configuration change from a zone that fell off the wire. The wire name goes into the identity while the effective name goes into the
     * display name: the accessory's label and its persisted identity are different jobs. The display name travels as composed, unsanitized as every composed
     * name travels, and the platform sanitizes it once where it mints the accessory, so its lines about the zone's accessory name the zone as its own log label
     * does. Composing where the map holds no entry keeps the read total.
     */
    const zoneAccessories = this.platform.reconcileZoneAccessories({ controller: this.controller,
      presentRelayIds: new Set(status.relays.map(zone => zone.relay_id)),
      zones: standaloneZones.map(zone => ({ displayName: (zoneNames.get(zone.relay_id) ?? this.composeZoneName(zone, facts)).composed.name,
        identity: zoneIdentity(zone) })) });

    /* Project one live-id set from the enabled zones - reported by the API and enabled by feature option - and drive each prune from it: the hint prune, so a
     * zone that vanishes and later reappears starts fresh instead of resurrecting its old manual and rain-stopped flags, and the fallback warning's, so such a zone
     * is warned about again if it returns under its kind's word.
     */
    const liveRelayIds = new Set(this.enabledZones.map(zone => zone.relay_id));

    this.zoneHints.prune(liveRelayIds);

    for(const tile of this.fallbackWarned) {

      if((tile !== "controller") && !liveRelayIds.has(tile)) {

        this.fallbackWarned.delete(tile);
      }
    }

    /* Remove the controller accessory's valves for zones that no longer exist, that the user has disabled, or that live on a standalone accessory of their own.
     * The keep-set is derived from the hosting map rather than from the enablement projection, so pruning and hosting read one source of truth: a promoted zone's
     * controller-side valve is pruned by exactly this line, while a zone whose promotion failed keeps its valve here - which is where the walk below will host
     * it. The map's number keys are bridged to the string subtypes each valve service carries. Each removal marks the controller accessory for the save window,
     * since the cache holds the services an accessory carries.
     */
    const hostedZoneIds = new Set(this.enabledZones.filter(zone => !zoneAccessories.has(zone.relay_id)).map(zone => zone.relay_id.toString()));

    for(const valve of this.accessory.services.filter(x => (x.UUID === this.hap.Service.Valve.UUID) && !hostedZoneIds.has(x.subtype ?? ""))) {

      this.accessory.removeService(valve);
      this.platform.persistence.persist(this.accessory);
    }

    let irrigationRemaining = 0;

    // Find the irrigation system service.
    const irrigationSystemService = this.accessory.getService(this.hap.Service.IrrigationSystem);

    /* Where each zone's companion suspension switch belongs this poll, keyed by its composed subtype. It is the sweep's keep-set and its hosting check in one: a
     * switch survives only on the accessory this map names for it, so one left behind on a former host is swept even though its zone still has a switch elsewhere.
     */
    const suspendHosts = new Map<string, HydrawiseAccessory>();

    // Rebuild the hosting record from empty, so a zone that has left the projection cannot leave its entry standing for the refresh cadence to read.
    this.zoneHosts.clear();

    // Discover any new zones and update our zone state.
    for(const zone of this.enabledZones) {

      /* The name this zone's valve carries, read from the pre-pass above, and composing where the map holds no entry keeps the read total. The composer answers
       * the zone's word where HomeKit can carry nothing of the chosen name, so the name is always one HomeKit can carry, and the valve, the accessory hosting it and
       * its companion switch all take it.
       */
      const naming = zoneNames.get(zone.relay_id) ?? this.composeZoneName(zone, facts);
      const { composed, override } = naming;
      const effectiveName = composed.name;

      // Where this zone's valve lives: the standalone accessory the reconcile established for it, or the controller accessory. One derived answer, read by every
      // decision below that depends on which it is.
      const host = zoneAccessories.get(zone.relay_id) ?? this.accessory;
      const isStandaloneHost = host !== this.accessory;

      this.zoneHosts.set(zone.relay_id, host);

      // The name the plugin owns for this zone this pass, under the naming rule the controller's own pass reads: a Name option HomeKit can carry, else the
      // effective name wherever synchronization holds, and otherwise null, the user owning it. Resolved once per zone, because the HomeKit names of the valve, its
      // companion switch and a standalone host answer to the same owner at the same cadence.
      const owned = ownedName({ fallback: effectiveName, override, sync: this.hasZoneFeature("Device.SyncName", zone.relay_id.toString()) });

      // Acquire the valve service. The transition the library answers says whether this pass created it, which is what the rename gate below reads.
      const { service: valveService, transition } = acquireService({ accessory: host, name: effectiveName, onServiceCreate: (newService: Service): void => {

        // Enumerate the valve service to align with the irrigation controller's zone numbering. A standalone accessory hosts no ServiceLabel service for the
        // index to enumerate against, so the characteristic has no referent there and is left unwritten.
        if(!isStandaloneHost) {

          newService.updateCharacteristic(this.hap.Characteristic.ServiceLabelIndex, zone.relay);
        }

        // This allows users to enable or disable the zone from within HomeKit. We could exclude it, but the extra optionality for end users can be useful.
        newService.updateCharacteristic(this.hap.Characteristic.IsConfigured, this.hap.Characteristic.IsConfigured.CONFIGURED);

        // All valves attached to an irrigation system must have their type set accordingly.
        newService.updateCharacteristic(this.hap.Characteristic.ValveType, this.hap.Characteristic.ValveType.IRRIGATION);
      }, serviceType: this.hap.Service.Valve, subtype: zone.relay_id.toString() });

      // A valve this pass attached changes the services the host carries, which the cache holds, so the host is marked for the save window.
      if(presenceChanged(transition)) {

        this.platform.persistence.persist(host);
      }

      // Whether this process has yet to bind this valve, which is the establishment gate every first-binding step below reads: true for a valve this pass created,
      // for every valve on the first poll, and for a cached standalone valve a later poll hosts for the first time.
      const unbound = !this.bound.has(valveService);

      /* While the plugin owns this zone's name, that name - the user's Name option when set, otherwise the name Hydrawise reports - is authoritative: it is applied
       * whenever the service's name differs, so a Hydrawise rename lands on the next poll and a changed Name option at the first poll after restart, and the valve
       * is held to it for this pass, its creating pass included, so a rename made in the Home app is put back at once. A set Name option always owns the name.
       * Without one, synchronization decides, and with it off the name is the user's, set once when its service is created, so a rename made in the Home app
       * stands. The name helper compares before it writes and answers whether it wrote, and a write marks the host for the save window.
       */
      if((transition !== "attached") && (owned !== null) && setServiceName(valveService, owned)) {

        this.platform.persistence.persist(host);
      }

      if(owned !== null) {

        this.holdServiceName(valveService, owned);
      }

      // The passes that decide this zone's fallback warning: the one that created its valve, and each one on which the plugin owns its name. The label reads the
      // naming this pass composed for the zone, so the line opens with the name every other line about the zone carries.
      if(((transition === "attached") || (owned !== null)) && this.decideFallbackWarning(zone.relay_id, composed)) {

        this.log.warn("%s: HomeKit cannot use this zone's name, so HomeKit shows it as %s. Set a Name for it in the plugin's settings, using letters or numbers, to " +
          "choose another.", this.zoneLabel(zone, naming), effectiveName);
      }

      // A standalone zone accessory carries its own information service, established the first time this process binds the zone's valve on it. The zone carries no
      // wire serial, so we synthesize one from the controller's serial and the relay id: stable, unique, and purely presentational. The cache holds those
      // characteristics, so the host is marked for the save window.
      if(isStandaloneHost && unbound) {

        this.configureInfo({ accessory: host, serialNumber: this.controller.serial_number + "-" + zone.relay_id.toString() });
        this.platform.persistence.persist(host);
      }

      /* Keep the standalone accessory's display name tracking the zone's effective name on every poll, whoever owns the zone's HomeKit names, and its information
       * service's names tracking the name the plugin owns under the same owner the valve service answers to, so a Hydrawise rename or a changed Name option lands on
       * the accessory exactly when it lands on the valve. While the plugin owns the name, the information service is held to it for this pass as the valve is
       * held. This sits outside the establishment gate above deliberately: a rename arriving on a later poll must still land. The name helper compares every name
       * it reaches before it writes, and a write marks the host for the save window, which is what persists the new name to Homebridge's cache.
       */
      if(isStandaloneHost) {

        if(setAccessoryName(host, effectiveName, { owned: owned !== null })) {

          this.platform.persistence.persist(host);
        }

        const hostInformation = host.getService(this.hap.Service.AccessoryInformation);

        if(hostInformation && (owned !== null)) {

          this.holdServiceName(hostInformation, owned);
        }
      }

      /* This zone's classified state, which decides what the user is SHOWN, and the sensor reading the rain transition and the program-mode aggregate answer to.
       * They are deliberately different questions, and conflating them is what produces a false log line.
       *
       * The classification gives suspension precedence over a sensor claim, which is right for display: a suspended zone should read as suspended. The rain hint
       * has to speak for the SENSOR itself, because a zone that is suspended AND sitting under a tripped sensor is still sensor-blocked. Deriving this hint from
       * the classification instead would let a suspension landing on a covered zone read as the sensor clearing, and narrate a rain transition that never
       * happened while the sensor was still tripping.
       *
       * The reading prefers the account API's own live answer and falls back to the group inference drawn from the wire, which is the order the classifier
       * applies to the same question. A reading from that inference is an estimate, and the one value below decides the wording of this zone's rain line and of its
       * status sentence, so each says so in the same words.
       *
       * Both are resolved before the hint entry so a first-sighted zone seeds its stored state from the live readings rather than from static defaults, which
       * would otherwise fire a spurious transition the first time a zone appears during a rain delay or under a suspension.
       */
      const state = classified.get(zone.relay_id);
      const sensorStopped = facts?.zones.get(zone.relay_id)?.sensorStopped ?? null;
      const isInferred = sensorStopped === null;
      const isStopped = sensorStopped ?? this.isStoppedBySensor(zone);

      // Resolve this zone's hint entry, seeded on first sighting with the live state. The view is the ledger's own entry, so the reads below see every write the
      // rest of this pass makes to it.
      const hints = this.zoneHints.ensure(zone.relay_id, isStopped, state?.state === "suspended");

      // Establish this zone's companion suspension switch where the user asked for one, and record where it landed for the sweep below to judge against.
      const suspendSubtype = this.configureZoneSuspendSwitch({ effectiveName, facts, host, owned, state, zone });

      if(suspendSubtype) {

        suspendHosts.set(suspendSubtype, host);
      }

      // Inform the user, and bind the valve's handlers, the first time this process reaches this valve.
      if(unbound) {

        // Refresh our stopped state unconditionally on a first sighting or valve rediscovery, seeding the stored value with the live sensor reading so the
        // transition check below does not fire on the zone's first appearance.
        this.zoneHints.refreshStopped(zone.relay_id, isStopped);

        this.log.info("%s: %s", this.zoneLabel(zone, naming), this.zoneStatus(zone, isInferred, state));

        /* The valve's handlers go through the Not Responding rule of the accessory hosting it, so a run is never sent while the controller cannot be reached, nor
         * while the host is a standalone accessory the last poll did not host. A standalone valve is its accessory's primary characteristic, so it answers reads
         * too, with the value the poll projected; a valve on the controller accessory leaves reads to the irrigation system, which answers for that accessory.
         */
        const answering = this.answeringFor(host);

        if(isStandaloneHost) {

          valveService.getCharacteristic(this.hap.Characteristic.Active).onGet(answering(() => valveService.getCharacteristic(this.hap.Characteristic.Active).value));
        }

        // Manually control the zone valve. A write queues the run or the stop and returns at once, and the run carries the valve's manual run time.
        valveService.getCharacteristic(this.hap.Characteristic.Active).onSet(answering((value: CharacteristicValue): void => {

          if(value !== this.hap.Characteristic.Active.ACTIVE) {

            this.commandValve({ on: false, origin: "homekit", zone });

            return;
          }

          this.commandValve({ duration: this.manualRunDuration(valveService), on: true, origin: "homekit", zone });
        }));

        this.bound.add(valveService);
      }

      // Record what the Hydrawise API says about this zone running. The ledger takes the not-running consequence with it: a zone the wire reports as stopped
      // cannot still be manually activated.
      this.zoneHints.observeRunning(zone.relay_id, zone.time === 1);

      // Retrieve whether the valve service is in use from HomeKit's perspective.
      const isValveInUse = valveService.getCharacteristic(this.hap.Characteristic.InUse).value === this.hap.Characteristic.InUse.IN_USE;

      // Get the duration of the next run time (if we aren't running currently) or the time remaining in this run if we're running.
      const duration = zone.run;

      // If a zone is on, then our irrigation system is in use and we update the remaining runtime duration.
      if(hints.isOn) {

        irrigationRemaining += duration;

        // Update the duration of the remaining runtime of this valve, in seconds, capped at HomeKit's own RemainingDuration maximum, so a longer run reports as
        // the ceiling rather than its true remaining time.
        valveService.updateCharacteristic(this.hap.Characteristic.RemainingDuration, Math.min(duration, HAP_DURATION_CEILING));
      } else {

        /* Mirror the Hydrawise scheduled runtime into the valve's run time, capped at HomeKit's own SetDuration maximum, so HomeKit shows Hydrawise's real run
         * time and a tap runs the zone for its normal length. Hydrawise reports zero for a zone with no upcoming run, which is no run time at all, so a zero never
         * overwrites the one the valve holds: the zone keeps its last real run time, or takes the default when it has never had one.
         */
        valveService.updateCharacteristic(this.hap.Characteristic.SetDuration, (duration > 0) ? Math.min(duration, HAP_DURATION_CEILING) :
          this.manualRunDuration(valveService));
      }

      // Active represents whether the zone is ready to be activated - meaning it's queued to turn on imminently or is currently on - unless the user's own run or
      // stop for it is still waiting to be settled, which the valve shows instead.
      if(this.isValveActive(zone)) {

        valveService.updateCharacteristic(this.hap.Characteristic.Active, this.hap.Characteristic.Active.ACTIVE);
        this.log.debug("Setting %s as active.", this.zoneLabel(zone, naming));
      } else {

        valveService.updateCharacteristic(this.hap.Characteristic.Active, this.hap.Characteristic.Active.INACTIVE);
      }

      // InUse represents whether there is water flowing through the valve currently.
      valveService.updateCharacteristic(this.hap.Characteristic.InUse, hints.isOn ?
        this.hap.Characteristic.InUse.IN_USE : this.hap.Characteristic.InUse.NOT_IN_USE);

      // Log our activity, if configured to do so.
      if(this.hasZoneFeature("Log.Zone", zone.relay_id.toString())) {

        // Inform the user if the zone has been started or stopped.
        if(isValveInUse !== hints.isOn) {

          this.log.info("%s: %s %s", this.zoneLabel(zone, naming), hints.isOn ? "Started" : "Stopped.",
            hints.isOn ? "(duration: " + this.getMinutes(zone.run) + ")." : this.zoneStatus(zone, isInferred, state));
        }

        // Inform the user if the zone has been stopped due to a rain sensor.
        if(isStopped !== hints.isStopped) {

          this.log.info(isInferred ? "%s: Rain sensor appears to be %s irrigation." : "%s: Rain sensor is %s irrigation.", this.zoneLabel(zone, naming),
            isStopped ? "stopping" : "allowing");
        }
      }

      // Save the new setting.
      this.zoneHints.refreshStopped(zone.relay_id, isStopped);
    }

    /* Sweep away every companion suspension switch this poll no longer wants: a zone whose option went off, a zone that lost its credentials or left the projection,
     * and a switch left behind on an accessory that no longer hosts its zone. Both host kinds are swept, because the controller owns every service-level removal
     * wherever a zone's services landed - the platform's reconcile decides which accessories exist and never touches a service.
     *
     * The match is on the COMPOSED SUBTYPE, never on the Switch service type alone: the account-wide suspend switch shares that type, and an unscoped sweep would
     * destroy it. Each removal marks the accessory it came off for the save window.
     */
    for(const suspendHost of new Set<HydrawiseAccessory>([ this.accessory, ...this.zoneHosts.values() ])) {

      for(const service of suspendHost.services.filter(x => (x.UUID === this.hap.Service.Switch.UUID) && isSuspendZoneSubtype(x.subtype))) {

        if(suspendHosts.get(service.subtype ?? "") !== suspendHost) {

          suspendHost.removeService(service);
          this.platform.persistence.persist(suspendHost);
        }
      }
    }

    // Update the irrigation system state. The RemainingDuration cap is the same HomeKit-declared maximum as each valve's own RemainingDuration above.
    irrigationSystemService?.updateCharacteristic(this.hap.Characteristic.InUse,
      (irrigationRemaining > 0) ? this.hap.Characteristic.InUse.IN_USE : this.hap.Characteristic.InUse.NOT_IN_USE);
    irrigationSystemService?.updateCharacteristic(this.hap.Characteristic.RemainingDuration, Math.min(irrigationRemaining, HAP_DURATION_CEILING));

    // Update the irrigation system's program mode when no enabled zone is manually running: if every enabled zone is currently stopped by a rain sensor,
    // no program is scheduled; otherwise we're on our normal scheduled program.
    const enabledHints = this.enabledZones.map(zone => this.zoneHints.get(zone.relay_id)).filter(hints => hints !== undefined);

    if(!enabledHints.some(x => x.isManual)) {

      irrigationSystemService?.updateCharacteristic(this.hap.Characteristic.ProgramMode,
        (enabledHints.filter(x => x.isStopped).length === this.enabledZones.length) ?
          this.hap.Characteristic.ProgramMode.NO_PROGRAM_SCHEDULED : this.hap.Characteristic.ProgramMode.PROGRAM_SCHEDULED);
    }

    // Publish our status to MQTT if configured to do so, through the client's guarded publish so a rejected write - the broker vanishing mid-write, a teardown race -
    // lands in the client's log instead of floating as an unhandled rejection.
    this.platform.mqtt?.publishGuarded(this.controllerTopic, this.statusJson(facts));
    this.publishRainSensors(facts);

    /* This poll landed, so Hydrawise answers for this controller. The verdict moves only here, after the walk has bound every handler and written every value, so the
     * first read a recovered accessory answers is this poll's own. The word is then re-judged whether or not the verdict moved, because the cloud's word on the
     * controller can have aged out since the last poll with no event to mark it.
     */
    this.setContact("reachable");
    this.refreshAvailability();
  }

  /* Establish, name, and bind one zone's companion suspension switch on whichever accessory now hosts that zone.
   *
   * The switch exists only where the account credentials do, because only the account API can say what it shows. Its command goes through the key-based API like
   * every other, but on that wire a suspended zone is byte for byte a zone with nothing scheduled, so without the account's facts a switch could suspend its zone
   * and never show it suspended, nor ever learn that the suspension ended.
   *
   * @param options               - This zone's pass.
   * @param options.effectiveName - The zone's effective display name, always one HomeKit can carry, which a new switch's name is composed from.
   * @param options.facts         - The account-credentialed facts this pass resolved, or null when there are none to trust.
   * @param options.host          - The accessory hosting this zone's valve, and therefore its switch.
   * @param options.owned         - The name the plugin owns for the zone this pass, which an existing switch's name is composed from and held to, or null when the
   *                                user owns it.
   * @param options.state         - The zone's classified schedule state, which the starting characteristic is written from.
   * @param options.zone          - The wire zone.
   *
   * @returns The composed subtype of the switch this established, or null when the zone is to have none.
   */
  private configureZoneSuspendSwitch({ effectiveName, facts, host, owned, state, zone }: { effectiveName: string;
    facts: Nullable<HydrawiseControllerFactsSnapshot>; host: HydrawiseAccessory; owned: Nullable<string>; state: HydrawiseZoneScheduleStatus | undefined;
    zone: HydrawiseZoneConfig; }): Nullable<string> {

    if(!this.platform.hasV2Client || !this.hasZoneFeature("Device.Suspend.Zone", zone.relay_id.toString())) {

      return null;
    }

    const name = effectiveName + " Suspend";
    const subtype = suspendZoneSubtype(zone.relay_id);
    const { service, transition } = acquireService({ accessory: host, name, serviceType: this.hap.Service.Switch, subtype });

    // A switch this pass attached changes the services the host carries, which the cache holds, so the host is marked for the save window.
    if(presenceChanged(transition)) {

      this.platform.persistence.persist(host);
    }

    /* The switch's name tracks its zone's on every poll while the plugin owns the zone's name, under the owner the valve answers to, so a Hydrawise rename reaches
     * the companion rather than stranding it under a name the zone no longer carries, and the switch is held to that name for this pass as the valve is held. The
     * zone half is the composer's answer, which HomeKit can always carry, so the composed name always names the zone, the zone's word with its relay number where
     * the composer answers it. The name helper compares before it writes, and a write marks the host for the save window.
     */
    if(owned !== null) {

      const ownedSwitchName = owned + " Suspend";

      if((transition !== "attached") && setServiceName(service, ownedSwitchName)) {

        this.platform.persistence.persist(host);
      }

      this.holdServiceName(service, ownedSwitchName);
    }

    /* Bind the handler under the establishment gate the valve uses - a switch this process has not yet bound - so a warm restart, where the service returns from
     * the accessory cache and this process has never bound to it, binds once. The handler goes through the hosting accessory's Not Responding rule, so a
     * suspension is never commanded while the controller cannot be reached.
     *
     * The starting state is written on that same gate rather than left to the projection tail, because the tail runs BEFORE this walk and so cannot have shown a
     * switch that did not yet exist. Every refresh after this one is the tail's, and it writes the same polarity: On means suspended.
     */
    if(!this.bound.has(service)) {

      service.updateCharacteristic(this.hap.Characteristic.On, this.isZoneSuspended(zone, state, facts));

      service.getCharacteristic(this.hap.Characteristic.On).onSet(this.answeringFor(host)((value: CharacteristicValue): void => {

        this.commands.enqueue({ kind: "zone-suspend", zone }, { on: Boolean(value), origin: "homekit" });
      }));

      this.bound.add(service);
    }

    return subtype;
  }

  /** A promise that resolves once none of this controller's commands is queued or in flight. A confirmed suspension standing is no work, so it never holds the
   * promise open.
   *
   * @returns The promise.
   */
  public get commandsIdle(): Promise<void> {

    return this.commands.idle;
  }

  /* Queue a run or a stop for one zone's valve, from a tap on it in HomeKit or from MQTT, which take one path so a command means the same thing whichever way it
   * arrived. A run with no positive duration is no command at all, whichever caller handed it over: nothing is queued, and the valve is put back to what it reads
   * on the same terms a command that did not take is.
   *
   * A command from MQTT moves the valve at once, as a tap does. HomeKit stores a tap's value itself, while a command that arrived over MQTT reaches the valve only
   * through a write, which shows the request the valve now reads first.
   *
   * @param options          - The command.
   * @param options.duration - How long a run lasts, in seconds. A stop carries none.
   * @param options.on       - Whether to run the zone, or stop it.
   * @param options.origin   - Where the command came from.
   * @param options.zone     - The wire zone the command is for.
   */
  private commandValve({ duration, on, origin, zone }: { duration?: number; on: boolean; origin: HydrawiseCommandIntent["origin"];
    zone: HydrawiseZoneConfig; }): void {

    const target: HydrawiseCommandTarget = { kind: "valve", zone };

    if(on && ((duration === undefined) || !Number.isFinite(duration) || (duration <= 0))) {

      this.commands.render(target);

      return;
    }

    this.commands.enqueue(target, on ? { duration, on, origin } : { on, origin });

    if(origin === "mqtt") {

      this.renderControl(target);
    }
  }

  /* Whether a command's control can still answer for it as its turn comes, judged on the terms its request met when it arrived: a request made in HomeKit by the
   * accessory hosting its control, and one made over MQTT by the controller. A zone that no poll now hosts has no accessory left to answer for its control.
   */
  private commandAvailable(target: HydrawiseCommandTarget, intent: HydrawiseCommandIntent): boolean {

    if(intent.origin === "mqtt") {

      return !this.unavailable;
    }

    const host = (target.kind === "suspend-all") ? this.accessory : this.zoneHosts.get(target.zone.relay_id);

    return (host !== undefined) && !this.unavailableFor(host);
  }

  /* Make one command ready to send as its turn comes: the setzone parameters it carries, and what Hydrawise's confirmation of it sets in motion. Every command
   * names its controller, and a zone's command names its relay.
   *
   * The instants a suspension carries are sent to Hydrawise, which reads them as wall-clock time. They come from the platform's clock, the system clock in the
   * field, so the wire carries wall-clock seconds while the command record and a suite's clock read the same timeline, and they are taken as the command's turn
   * comes rather than at the tap, so a command that waited behind others still runs to the whole horizon it asked for. Each floors to a whole second, the integer
   * seconds the API expects rather than a fractional millisecond remainder. A suspension runs to a one-year horizon at both grains, through the same constant,
   * because an open-ended suspension is what both commands mean and Hydrawise expresses that as a distant instant. The key-based API has no resume of its own, so a
   * resume at either grain is a suspension until the current second, which has already passed.
   */
  private prepareCommand(target: HydrawiseCommandTarget, intent: HydrawiseCommandIntent): HydrawisePreparedCommand {

    const now = Math.floor(this.platform.clock.now() / 1000);
    const params: Record<string, string> = {};
    const send = async (signal: AbortSignal): Promise<HydrawiseCommandOutcome> => this.platform.command({ params, signal });

    params["controller_id"] = this.controller.controller_id.toString();

    switch(target.kind) {

      case "suspend-all": {

        const until = now + (intent.on ? HYDRAWISE_SUSPEND_DURATION : 0);

        params["action"] = "suspendall";
        params["custom"] = until.toString();
        params["period_id"] = "999";

        return { confirmed: (): void => this.suspendAllConfirmed(intent.on ? until : null), send };
      }

      case "valve": {

        params["relay_id"] = target.zone.relay_id.toString();
        params["action"] = intent.on ? "run" : "stop";

        if(intent.on) {

          params["custom"] = (intent.duration ?? 0).toString();
          params["period_id"] = "999";
        }

        return { confirmed: (): void => this.valveConfirmed(target.zone, intent), send };
      }

      case "zone-suspend": {

        const until = now + (intent.on ? HYDRAWISE_SUSPEND_DURATION : 0);

        params["relay_id"] = target.zone.relay_id.toString();
        params["action"] = "suspend";
        params["custom"] = until.toString();
        params["period_id"] = "999";

        return { confirmed: (): void => this.zoneSuspensionConfirmed(target.zone, intent.on ? until : null), send };
      }
    }
  }

  /* Take Hydrawise's confirmation of an account-wide suspend or resume.
   *
   * The confirmation is recorded with the instant it arrived and the direction it went. A facts snapshot fetched before it cannot know about it, so every reader
   * ignores such a snapshot in this command's favor until a refresh that postdates it lands - which is what stops a fetch already in flight when the user pressed
   * the switch from flipping it straight back. A resume records too, for the same reason in the other direction.
   *
   * An account-wide command is also a fact about every zone beneath it, which each zone without its own record reads, so facts older than the command cannot fight
   * the switch zone by zone. It replaces what each zone held before it, so every zone's own record retires first, and every zone's request keeps going and shows the
   * user's choice, whatever the wire last reported. Any record a zone holds from here on is newer than this one.
   */
  private suspendAllConfirmed(commandedUntil: Nullable<number>): void {

    this.commands.retireZoneRecords();
    this.commands.stamp(SUSPEND_ALL_TARGET, { at: Math.floor(this.platform.clock.now() / 1000), commandedUntil });

    this.log.info("%s scheduled watering for all zones.", (commandedUntil !== null) ? "Suspending" : "Resuming");

    // Re-derive on the account-wide command's own terms, exactly as a per-zone command does. It runs after the sentence above so the account-wide statement
    // reads ahead of the per-zone transitions the re-derive narrates beneath it.
    this.rederiveProjection();
  }

  /* Take Hydrawise's confirmation of one zone's suspension or resume, commanded from its companion switch.
   *
   * The switch speaks its own name's language: turning it ON is what SUSPENDS the zone, which is the account-wide suspend switch's convention at the zone grain. A
   * zone's active state already lives on its valve, so a switch that commanded the other way would leave the user two controls disagreeing about one thing.
   *
   * The confirmation is recorded so a snapshot fetched before it cannot answer for this zone, on exactly the terms the account-wide record works on, and the
   * direction is stored with the instant, because while the record stands it is the record itself that says what to show. The projection is re-derived right
   * here, so the webUI, the MQTT payload and the log sentence, which all answer to it, carry the command at once rather than contradicting the switch the user
   * just pressed until the next refresh.
   *
   * Nothing is read back afterward. The recurring refresh of the account's facts reconciles the record on its own cadence, and spending a call to confirm what
   * Hydrawise has just acknowledged would cost a slot the next command may need.
   */
  private zoneSuspensionConfirmed(zone: HydrawiseZoneConfig, commandedUntil: Nullable<number>): void {

    this.commands.stamp({ kind: "zone-suspend", zone }, { at: Math.floor(this.platform.clock.now() / 1000), commandedUntil });
    this.rederiveProjection();
  }

  /* Take Hydrawise's confirmation of a zone's run or stop, from HomeKit or MQTT alike: show the water the command set flowing or stopped, and say so. The valve
   * and the irrigation system are looked up as the confirmation arrives rather than captured when the command was made, because a poll in between can move the
   * zone onto another accessory. A zone with no valve - one a feature option keeps out of HomeKit, which MQTT can still command - has nothing to show.
   *
   * The valve's own Active is left as it stands. It already shows the command the user made, and the next poll's walk writes it from the wire.
   */
  private valveConfirmed(zone: HydrawiseZoneConfig, intent: HydrawiseCommandIntent): void {

    const valveService = this.valveOf(zone.relay_id);

    if(!valveService) {

      return;
    }

    const irrigationSystemService = this.accessory.getService(this.hap.Service.IrrigationSystem);
    const duration = intent.duration ?? 0;

    if(intent.on) {

      valveService.updateCharacteristic(this.hap.Characteristic.InUse, this.hap.Characteristic.InUse.IN_USE);
      valveService.updateCharacteristic(this.hap.Characteristic.RemainingDuration, duration);
      irrigationSystemService?.updateCharacteristic(this.hap.Characteristic.ProgramMode, this.hap.Characteristic.ProgramMode.PROGRAM_SCHEDULED_MANUAL_MODE);
      irrigationSystemService?.updateCharacteristic(this.hap.Characteristic.InUse, this.hap.Characteristic.InUse.IN_USE);

      // Mark this zone as manually activated. The ledger is addressed by relay id as the confirmation arrives, so it always acts on the current entry, and a zone
      // with no entry is the no-op the ledger states.
      this.zoneHints.markManual(zone.relay_id);
    } else {

      valveService.updateCharacteristic(this.hap.Characteristic.RemainingDuration, 0);
      valveService.updateCharacteristic(this.hap.Characteristic.InUse, this.hap.Characteristic.InUse.NOT_IN_USE);

      // Clear out the manual activation for this zone, addressed by relay id as the confirmation arrives for the same reason the mark above is.
      this.zoneHints.clearManual(zone.relay_id);

      // No more manually activated zones among the enabled set, we can resume our schedule. We consult the instance state as the confirmation arrives so this
      // always acts on the current poll's enabled zones.
      if(!this.enabledZones.some(x => this.zoneHints.get(x.relay_id)?.isManual)) {

        irrigationSystemService?.updateCharacteristic(this.hap.Characteristic.ProgramMode, this.hap.Characteristic.ProgramMode.PROGRAM_SCHEDULED);
      }

      // If this was the only enabled zone currently running on the irrigation controller, let's set the system state to no longer in use.
      if(!this.enabledZones.some(x => (x.time === 1) && (x.relay_id !== zone.relay_id))) {

        irrigationSystemService?.updateCharacteristic(this.hap.Characteristic.InUse, this.hap.Characteristic.InUse.NOT_IN_USE);
      }
    }

    this.log.info("%s: Manually %s%s.", this.zoneLabel(zone), intent.on ? "started" : "stopped",
      intent.on ? " (duration: " + this.getMinutes(duration) + ")" : "");
  }

  /* What a control reads, the one reader each control answers HomeKit with: the user's own request while it waits to be settled, and otherwise the account-wide
   * switch's reading, the zone's suspension, or the valve's walk. A zone's reading is taken from the zone as the wire reports it now, since a control's command
   * carries the zone as it was when the request arrived.
   */
  private readControl(target: HydrawiseCommandTarget): HydrawiseCommandValue {

    if(target.kind === "suspend-all") {

      return { on: this.isAllSuspended(this.currentFacts) };
    }

    const zone = this.status.relays.find(candidate => candidate.relay_id === target.zone.relay_id) ?? target.zone;

    if(target.kind === "valve") {

      return { on: this.isValveActive(zone) };
    }

    return { on: this.isZoneSuspended(zone, this.accessory.context.schedule?.zones.find(entry => entry.relayId === zone.relay_id), this.currentFacts) };
  }

  // Write what a control reads onto it, wherever it is hosted now. A zone that no poll now hosts has nowhere for its controls to be written.
  private renderControl(target: HydrawiseCommandTarget): void {

    const { on } = this.readControl(target);

    switch(target.kind) {

      case "suspend-all":

        this.accessory.getServiceById(this.hap.Service.Switch, HydrawiseReservedNames.SWITCH_SUSPEND_ALL)?.updateCharacteristic(this.hap.Characteristic.On, on);

        return;

      case "valve":

        this.valveOf(target.zone.relay_id)?.updateCharacteristic(this.hap.Characteristic.Active,
          on ? this.hap.Characteristic.Active.ACTIVE : this.hap.Characteristic.Active.INACTIVE);

        return;

      case "zone-suspend":

        this.zoneHosts.get(target.zone.relay_id)?.getServiceById(this.hap.Service.Switch, suspendZoneSubtype(target.zone.relay_id))
          ?.updateCharacteristic(this.hap.Characteristic.On, on);
    }
  }

  /* Say why a control's latest request did not take. The account-wide switch names no zone and says a request that did not complete and a reply that could not be
   * read each in a sentence of its own, while a zone's valve or switch names the zone, what it was asked to do, and the reason the outcome gives. A command no
   * attempt of which was answered, and one whose control could no longer answer when its turn came, are each a warning rather than an error, because neither is a
   * failure the user has to act on.
   */
  private reportUnconfirmed(target: HydrawiseCommandTarget, intent: HydrawiseCommandIntent, outcome: HydrawiseUnconfirmedCommand): void {

    const verb = (target.kind === "valve") ? (intent.on ? "start" : "stop") : (intent.on ? "suspend" : "resume");
    let label = "All zones";

    if(target.kind !== "suspend-all") {

      label = this.zoneLabel(target.zone);
    }

    switch(outcome.status) {

      case "exhausted":

        this.log.warn("%s: Hydrawise did not answer the %s command after %s attempts, so it shows its last confirmed state.", label, verb, HYDRAWISE_COMMAND_ATTEMPTS);

        return;

      case "unavailable":

        this.log.warn("%s: The %s command was not sent because the controller is not responding.", label, verb);

        return;

      case "failed":
      case "refused":
      case "unreadable":

        if(target.kind === "suspend-all") {

          this.log.error((outcome.status === "unreadable") ? "Unable to retrieve the result of the %s request." : "Unable to complete the %s request.", verb);

          return;
        }

        this.log.error("%s: Unable to %s this zone. %s", label, verb, outcome.reason);
    }
  }

  // Whether a zone's valve reads active: the user's own run or stop while it waits to be settled, and otherwise whether the zone is queued to turn on imminently
  // or is currently on.
  private isValveActive(zone: HydrawiseZoneConfig): boolean {

    return this.commands.pending({ kind: "valve", zone })?.on ?? ((zone.time > 0) && (zone.time <= HYDRAWISE_ACTIVE_ZONE_INDICATOR));
  }

  // The valve a zone has on whichever accessory now hosts it, or undefined where no poll hosts the zone.
  private valveOf(relayId: number): Service | undefined {

    return this.zoneHosts.get(relayId)?.getServiceById(this.hap.Service.Valve, relayId.toString());
  }

  /* Utility to return the status of a zone to a user. The sentence comes from the schedule classifier's own reading of this poll, which is the same reading the
   * persisted projection and the webUI display are built from, so a zone's log line and its displayed status can never tell different stories. Each arm then
   * composes its sentence from the wire fields the classifier already weighed, and a rain stop read from the wire's inference rather than from current account
   * facts says only that it appears to be one, on the caller's word.
   *
   * Every state the union declares is named here with no default arm, so a state added to the union surfaces as a compile error - a return path the analysis can
   * see falling off the end - rather than as a zone silently rendering someone else's sentence.
   */
  private zoneStatus(zone: HydrawiseZoneConfig, isInferred: boolean, state: HydrawiseZoneScheduleStatus | undefined = zoneScheduleStatus(zone, this.status)): string {

    switch(state.state) {

      case "running":

        return "Currently running with " + this.getMinutes(zone.run) + " remaining.";

      case "scheduled":

        return "Next run will be " + (zone.timestr.includes(":") ? "at " + this.formatStartTime(zone.timestr) : "on " + zone.timestr) + " for " +
          this.getMinutes(zone.run) + ".";

      case "sensor-stopped":

        return isInferred ? "Rain sensor appears to be preventing irrigation." : "Rain sensor is preventing irrigation.";

      case "suspended":

        return "Watering is suspended until " + this.formatInstant(state.until) + ".";

      case "unscheduled":

        // The wire reports no upcoming run, and that is the whole claim: without account credentials a zone between schedule computations and a zone the owner
        // suspended read identically, so the sentence states the absence rather than guessing at its cause.
        return "No runs are currently scheduled.";
    }
  }

  /* Render an absolute instant for the operator reading the Homebridge log, in the host's own timezone: the clock alone when it falls today, a short weekday
   * ahead of it within the coming week, and a locale date beyond that, where a weekday alone would be ambiguous.
   *
   * The display tier keeps a formatter of its own for the browser's reader, deliberately - each tier renders for its own audience - so this is one formatter per
   * tier rather than one per sentence: the suspension status line and the ledger's suspension transition both render their instant through here.
   */
  private formatInstant(epochSeconds: number): string {

    const when = new Date(epochSeconds * 1000);
    const now = new Date(this.platform.clock.now());
    const timeOfDay = when.toLocaleTimeString(undefined, { hour: "numeric", minute: "2-digit" });

    if(when.toDateString() === now.toDateString()) {

      return timeOfDay;
    }

    if(Math.abs(epochSeconds - Math.floor(now.getTime() / 1000)) < (7 * 24 * 60 * 60)) {

      return when.toLocaleDateString(undefined, { weekday: "short" }) + " " + timeOfDay;
    }

    return when.toLocaleDateString();
  }

  /* Retrieve the current status from the Hydrawise API. The fetch, whose body the platform reads inside the request's deadline, and the shape check run as one
   * attempt of the status log, which classifies what the fetch came to before it releases the fetch's lines, and the failure is thrown after the attempt rather
   * than inside it, because a throw inside an attempt leaves it unclassified and its lines at their own levels on every repeat. What is thrown is the error every
   * failed poll throws, so pollOnce counts it and the retry waits and re-polls on the same terms; the stale status is never republished as fresh.
   */
  private async getStatus(): Promise<void> {

    const outcome = await this.statusFailures.attempt(async (log): Promise<HydrawiseStatusOutcome> => this.attemptStatus(log),
      (result): HydrawiseStatusFailure | undefined => (((result.status === "adopted") || (result.status === "aborted")) ? undefined : result.status));

    switch(outcome.status) {

      case "adopted":

        return;

      // A shutdown abort mid-read is orderly teardown, so the read's own error is rethrown quietly and the retry loop unwinds through its own signal.
      case "aborted":

        throw outcome.error;

      case "mis-shaped":
      case "unanswered":
      case "unreadable":

        throw new Error("Unable to retrieve the current status of the irrigation controller.");

      // Compile-time exhaustiveness: a status the fetch's outcome learns fails to type-check here until the poll says what it does with it.
      default:

        outcome satisfies never;
    }
  }

  /* One status fetch, as the status log runs it: the request, whose body the platform reads inside the request's deadline, and the shape check of what that read
   * came to, answering what the fetch came to. Every line it writes goes through the logger the attempt hands in, and the body becomes the controller's status
   * here only once it has passed the check.
   */
  private async attemptStatus(log: HomebridgePluginLogging): Promise<HydrawiseStatusOutcome> {

    // Get our schedule for this controller.
    const params: Record<string, string> = {};

    params["controller_id"] = this.controller.controller_id.toString();

    const fetchedAt = Math.floor(this.platform.clock.now() / 1000);
    const answer = await this.platform.retrieve("statusschedule.php", params);

    // A null answer is a recoverable API error, or a shutdown abort, that retrieve() already classified and reported through its own request log, so nothing is
    // said about it here.
    if(!answer) {

      return { status: "unanswered" };
    }

    // A body the platform could not read is refused with the error its read met, the request's own deadline among them, which the request log left unsaid.
    if(answer.status === "unreadable") {

      return this.refuseStatus({ error: answer.error, log, status: "unreadable" });
    }

    // Validate the parsed body's shape before adopting it as our status. A valid-JSON body with the wrong shape would otherwise pass the cast and crash applyStatus
    // outside every try/catch, tripping superviseLoop's terminal fault and stopping this controller's polling until a restart.
    const parsed = answer.body;

    if(!this.isStatusSchedule(parsed)) {

      return this.refuseStatus({ error: new Error("The Hydrawise API returned a status body with an unexpected shape."), log, status: "mis-shaped" });
    }

    this.status = parsed;
    this.statusFetchedAt = fetchedAt;

    log.debug("Status updated.");
    log.debug(util.inspect(this.status, { colors: true, depth: null, sorted: true }));

    return { status: "adopted" };
  }

  /* Answer a status body the poll cannot adopt. A shutdown abort mid-read is orderly teardown, so it answers the abort without a word rather than manufacturing a
   * failure report; anything else is reported as one sentence carrying the failure's own detail, and answers its tag.
   */
  private refuseStatus({ error, log, status }: { error: unknown; log: HomebridgePluginLogging; status: "mis-shaped" | "unreadable" }): HydrawiseStatusOutcome {

    if(this.platform.signal.aborted) {

      return { error, status: "aborted" };
    }

    log.error("Unable to retrieve the current status of the irrigation controller: %s.", formatErrorMessage(error));

    return { status };
  }

  /* Guard that a parsed status body carries the shape applyStatus relies on: relays and sensors arrays, and a nextpoll from zero to the ceiling the plugin
   * honors. A body that fails this check is treated as a failed poll rather than being adopted as our status.
   *
   * The lower bound keeps the wire from passing as the first-run placeholder, whose nextpoll of -1 is what the loop reads as a first run. The range comparison
   * refuses NaN and both infinities, which pass a type check - the infinities being what an overflowing JSON literal parses to - and the type check ahead of it
   * refuses null, which a range comparison alone would read as zero.
   */
  private isStatusSchedule(value: unknown): value is StatusScheduleResponse {

    if((typeof value !== "object") || (value === null)) {

      return false;
    }

    const candidate = value as Partial<StatusScheduleResponse>;

    return Array.isArray(candidate.relays) && Array.isArray(candidate.sensors) && (typeof candidate.nextpoll === "number") && (candidate.nextpoll >= 0) &&
      (candidate.nextpoll <= HYDRAWISE_API_NEXTPOLL_MAX);
  }

  /* Write the reported zone roster to the accessory context when it changed since the last poll, marking the accessory for the save window as it writes. We project
   * every reported zone to the identity-only shape, naming each field explicitly rather than spreading the wire zone, ordered by relay for a stable comparison. The
   * comparison is field-wise because the projection is a fresh array every poll, so a reference check would differ every time and write on every poll. A rare
   * single-poll flap that flips a field and back across two polls costs two writes, which we accept - roster changes are rare and a write is cheap.
   */
  private persistZoneRoster(facts: Nullable<HydrawiseControllerFactsSnapshot>): void {

    const zones = this.status.relays.map(zone => ({ ...zoneIdentity(zone), name: this.zoneName(zone, facts) })).sort((a, b) => a.relay - b.relay);

    // After configureDevice's seed the context always carries a zones array, so the nullish fallback is a defensive floor for a context that predates the seed rather
    // than an expected path.
    if(sameEntries(this.accessory.context.zones ?? [], zones, sameZoneIdentity)) {

      return;
    }

    this.platform.persistence.persist(this.accessory, { zones });
  }

  /* Write the schedule projection to the accessory context when it changed since the last poll, marking the accessory for the save window as it writes, and report
   * whether it wrote - the roster's discipline above applied to the volatile half of what this accessory persists. The projection stores absolute instants, so an
   * unchanged schedule projects byte-identically poll after poll and the comparison takes the no-change return; a projection compared before any has been persisted
   * is a change by definition and seeds the context.
   *
   * This is where the witnesses meet. The commands map is composed over the zones the wire reports, each from the one command that still speaks for it, so every
   * entry in it is standing and the classifier is handed direction alone - one place decides what still stands, and one classification weighs it against the wire
   * and the account's own facts. Composing here rather than overlaying at each consumer is what keeps the webUI, MQTT, the log, and the switches reading one answer.
   *
   * The signal it returns gates the status publish a refresh or a command makes, and nothing else: the mark here is the save.
   */
  private persistScheduleStatus(facts: Nullable<HydrawiseControllerFactsSnapshot>): boolean {

    const previous = this.accessory.context.schedule;
    const commands = new Map<number, Nullable<number>>();

    for(const zone of this.status.relays) {

      const command = this.zoneCommand(zone, facts);

      if(command) {

        commands.set(zone.relay_id, command.commandedUntil);
      }
    }

    const schedule = scheduleStatus(this.status, HYDRAWISE_ACTIVE_ZONE_INDICATOR, { commands, facts: facts ?? undefined,
      priorSuspended: this.priorSuspended(previous) });

    if(previous && sameScheduleStatus(previous, schedule)) {

      return false;
    }

    this.platform.persistence.persist(this.accessory, { schedule });

    return true;
  }

  /* The suspension instants the prior projection recorded, which the classifier carries forward for any zone this pass has no fresh answer about.
   *
   * The carry exists to stop a suspended zone flapping to "not scheduled" and back across a restart or a gap between refreshes, and it is offered only on an
   * install that HAS the credentials: without them nothing could ever confirm or clear a carried suspension, so a cache restored from a credentialed past
   * re-classifies cleanly instead of stranding a claim forever. The classifier applies the remaining limits - the zone must still carry the unscheduled shape,
   * and the instant must still be ahead of the wire clock - and passes the recorded value through untouched, which is what keeps a carried arm byte-stable.
   */
  private priorSuspended(previous: HydrawiseScheduleStatus | undefined): Map<number, number> | undefined {

    if(!this.platform.hasV2Client) {

      return undefined;
    }

    return new Map((previous?.zones ?? []).flatMap(entry => (entry.state === "suspended") ? [[ entry.relayId, entry.until ] as [ number, number ]] : []));
  }

  // Guard that a persisted context value is a well-formed zone roster: an array whose every entry passes the shared zone-identity shape check. A malformed prior
  // value - a non-array, or an entry missing a field - fails this check and degrades to an empty roster, so a corrupt cache entry never crashes the webUI reader.
  private isZoneRoster(value: unknown): value is HydrawiseZoneIdentity[] {

    return Array.isArray(value) && value.every(entry => isZoneIdentity(entry));
  }

  // Utility to test for whether a zone has been stopped due to a rain sensor, delegating to the shared predicate in the types module against this poll's whole
  // status body - the sensor block and the zones those sensors cover alike - so the operator's log and the persisted schedule projection answer from one rule.
  private isStoppedBySensor(zone: HydrawiseZoneConfig): boolean {

    return isZoneStoppedBySensor(zone, this.status);
  }

  // The run time, in seconds, a HomeKit start gives a zone: the valve's own run time while it holds a positive one, and the default otherwise, which covers a valve
  // Hydrawise has never given a run time and a zero written from HomeKit itself before the next poll.
  private manualRunDuration(valveService: Service): number {

    const duration = Number(valveService.getCharacteristic(this.hap.Characteristic.SetDuration).value ?? 0);

    return (duration > 0) ? duration : HYDRAWISE_DEFAULT_RUN_DURATION;
  }

  // Utility to convert the duration from seconds to minutes, with the correct plural marker.
  private getMinutes(duration: number): string {

    const minutes = Math.round(duration / 60);

    return minutes.toString() + " minute" + (minutes !== 1 ? "s" : "");
  }

  // Utility to format the time strings returned by Hydrawise.
  private formatStartTime(time: string): string {

    // Split it into hours and minutes and ensure we convert it in the process. The defaults keep the arithmetic below total when the input is malformed.
    const [ hours = 0, minutes = 0 ] = time.split(":").map(Number);

    // Return our user-friendly time string.
    return ((hours % 12) || 12).toString() + ":" + minutes.toString().padStart(2, "0") + " " + (hours >= 12 ? "PM" : "AM");
  }

  // Utility for checking a controller-scoped feature option. The narrowed option-name union makes a scope-violating call a compile error: only controller-scopable
  // options can be named here. The serial goes in the canonical controller position with the device slot left undefined; the resolved storage key is the flat
  // option-and-serial string regardless of which slot carries the serial, so controller-scope resolution is stable across that positioning.
  private hasFeature(option: HydrawiseControllerOption): boolean {

    return this.platform.featureOptions.test(option, undefined, this.controller.serial_number);
  }

  // Utility for checking a zone-scoped feature option. The zone id goes in the device position and the serial in the controller position, so resolution walks the zone
  // override, then the controller, then global, then the catalog default. Only zone-scopable options can be named here.
  private hasZoneFeature(option: HydrawiseZoneOption, zoneId: string): boolean {

    return this.platform.featureOptions.test(option, zoneId, this.controller.serial_number);
  }

  /* Utility for reading a zone-scoped value option. The zone id goes in the device position ALONE, and the raw value is handed on as the engine answers it: the
   * zone composer alone decides whether it counts, through HBPU's override resolution, which trims it and refuses one that is empty or that HomeKit cannot carry.
   *
   * Presenting exactly one id is the rule every value reader keeps, and here it is what makes a controller-level entry unreachable from a zone's read: the Name
   * option resolves at the controller as well as the zone, so a read that also presented the serial would answer a zone with its controller's name whenever the
   * zone had no entry of its own. A probe against the real engine records both polarities - the serial-bearing read resolves the controller's entry, the
   * serial-free read does not - and the pair is why the argument is absent rather than merely unused.
   */
  private zoneNameOverride(option: HydrawiseZoneValueOption, zoneId: string): Nullable<string | undefined> {

    return this.platform.featureOptions.value(option, zoneId);
  }

  // Utility for reading a controller-scoped value option, on the same single-id terms, handing the raw value on to the controller composer. The serial goes in
  // the device position, because the controller row writes its own entry there and the engine's storage keys are flat, so this is the read that resolves the
  // row's own value.
  private controllerNameOverride(option: HydrawiseControllerValueOption): Nullable<string | undefined> {

    return this.platform.featureOptions.value(option, this.controller.serial_number);
  }

  /* The label a zone's log lines carry: the name the plugin composes for the zone, the Name option where HomeKit can carry it and the zone's own Hydrawise name
   * otherwise, sanitized as HomeKit carries it, and the zone number the operator sees on the controller itself. A rename made in the Home app stays in HomeKit,
   * so the log and the settings page name a zone alike whoever owns its HomeKit names.
   *
   * Every cadence that narrates a zone composes through here, which is what makes their lines read identically. The poll walk already holds the naming its pass
   * composed and hands it over, so its lines read the facts the pass resolved; every other caller holds only the zone, so the naming is composed from the
   * current facts and the zone's Name option, which reach a zone on its own accessory as they reach one on the controller's.
   */
  private zoneLabel(zone: HydrawiseZoneConfig, naming: HydrawiseZoneNaming = this.composeZoneName(zone, this.currentFacts)): string {

    return sanitizeName(naming.composed.name) + " [Zone " + zone.relay.toString() + "]";
  }

  /* Whether the account reads as fully suspended, which is what drives the suspend-all switch's state. Answers in precedence, the account-grain twin of the
   * per-zone reader above and deliberately the same shape: one reader pattern at both grains, both consulting the one standing judgment.
   *
   * The user's own suspend or resume answers first while it waits to be settled, so the switch holds their choice whatever a poll or a refresh lands meanwhile.
   *
   * A STANDING COMMAND answers next, and its direction is the answer. This is the arm that cannot be replaced by reading composed state, for the same reason the
   * zone reader's cannot: the projection is re-derived the moment Hydrawise confirms the command, from a poll snapshot taken before the account accepted anything,
   * so a reader that consulted only that composition would flip the switch straight back off under the user's finger.
   *
   * With trustworthy facts and no command standing, the answer comes from the classified states: the account is suspended when every reported zone classifies
   * suspended. Reading the classification rather than the raw suspension facts keeps this the projection's single truth, and it is also the behaviorally right
   * answer where a raw read would be wrong - a zone the user forced into a manual run classifies as running, so the switch reads off while water flows, exactly
   * as the wire heuristic reads. Nothing about the command's age is asked here, because the one standing judgment above has already asked it.
   *
   * Otherwise the wire heuristic stands. Every zone carrying the unscheduled sentinel with no sensor stop is the strongest evidence the key-based wire offers for
   * a suspend-all, and it is what the API itself normalizes a suspend-all command to. It carries documented ambiguities of its own: it cannot tell a suspend-all from an
   * account whose every zone merely sits between runs, so the switch can read on with nothing commanded; and on a controller whose rain sensor covers every zone
   * it reads OFF during a genuine suspend-all, because the sensor classification claims those zones first - a 2026-08-04 live capture recorded exactly that. The
   * facts path above is what resolves the second; the heuristic remains the honest fallback for an install that cannot reach it.
   */
  private isAllSuspended(facts: Nullable<HydrawiseControllerFactsSnapshot>): boolean {

    const pending = this.commands.pending(SUSPEND_ALL_TARGET);

    if(pending) {

      return pending.on;
    }

    const command = this.commands.record(SUSPEND_ALL_TARGET);

    if(this.commandStands(command, facts)) {

      return command.commandedUntil !== null;
    }

    if(facts) {

      const zones = this.accessory.context.schedule?.zones ?? [];

      return (zones.length > 0) && zones.every(entry => entry.state === "suspended");
    }

    return !this.status.relays.some(zone => zone.run || zone.timestr || (zone.time !== HYDRAWISE_UNSCHEDULED_SENTINEL) || this.isStoppedBySensor(zone));
  }

  /* Our status as JSON for MQTT: one entry per reported zone, carrying the wire fields this payload has always published.
   *
   * The account-credentialed facts add to that rather than reshaping it. With a trustworthy snapshot in hand each entry also carries its classified state, and a
   * suspended zone the instant its suspension lifts; with nothing trustworthy - no credentials, no refresh yet, or a snapshot aged out - the payload is byte for
   * byte what an install with only an API key publishes. The gate is what makes that promise good, since the projection itself exists in both cases.
   */
  private statusJson(facts: Nullable<HydrawiseControllerFactsSnapshot>): string {

    const classified = facts ? new Map((this.accessory.context.schedule?.zones ?? []).map(entry => [ entry.relayId, entry ])) : undefined;

    return JSON.stringify(this.status.relays.map(x => {

      const base = { name: this.zoneName(x, facts), relay: x.relay, run: x.run, time: x.time, timestr: x.timestr };
      const state = classified?.get(x.relay_id);

      if(!state) {

        return base;
      }

      return (state.state === "suspended") ? { ...base, state: state.state, suspendedUntil: state.until } : { ...base, state: state.state };
    }));
  }

  // Our rain sensors as JSON for MQTT: one entry per sensor the current facts list, and an empty array with none current or an answer that cannot say which exist.
  private rainSensorsJson(facts: Nullable<HydrawiseControllerFactsSnapshot>): string {

    return JSON.stringify([...(facts?.rainSensors ?? [])].map(([ id, { name, tripped } ]) => ({ id, name, tripped })));
  }

  // Publish our rain sensors on an install that has them. Every refresh tick and poll pass asks and the change gate answers, so an unchanged reading costs nothing on
  // the wire and one that ages out, which no event marks, reaches the topic at the next poll.
  private publishRainSensors(facts: Nullable<HydrawiseControllerFactsSnapshot>): void {

    if(this.hints.rainSensors) {

      this.platform.mqtt?.publishGuarded(this.rainSensorsTopic, this.rainSensorsJson(facts), { ifChanged: true });
    }
  }

  /* This controller's persisted identity, composed from the wire identity with the effective name overlaid - the account's own name where a trustworthy snapshot
   * carries one, and the wire's otherwise.
   *
   * A user's Name option is deliberately absent from it. Identity answers what this controller IS, which the webUI's listing, the denormalized account roster,
   * and every zone accessory's owner stamp all read; the override answers what HomeKit SHOWS, and it belongs to the display alone. The zone identity and the MQTT
   * payload already draw that line, and this is the same line at the controller grain.
   */
  public get identity(): HydrawiseControllerIdentity {

    return { ...controllerIdentity(this.controller), name: this.controllerName(this.currentFacts) };
  }
}
