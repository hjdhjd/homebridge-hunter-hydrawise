/* Copyright(C) 2017-2026, HJD (https://github.com/hjdhjd). All rights reserved.
 *
 * controller.ts: Base class for all Hydrawise irrigation controllers.
 */
import type { API, CharacteristicValue, HAP, Service } from "homebridge";
import { HAP_DEFAULT_MODEL, HAP_DURATION_CEILING, HOMEBRIDGE_UNKNOWN_FIRMWARE, HYDRAWISE_ACTIVE_ZONE_INDICATOR, HYDRAWISE_API_JITTER,
  HYDRAWISE_API_RETRY_INTERVAL, HYDRAWISE_COMMAND_ENDPOINT, HYDRAWISE_REVERT_DELAY, HYDRAWISE_SUSPEND_DURATION, HYDRAWISE_V2_FACTS_TTL } from "./settings.ts";
import { HYDRAWISE_UNSCHEDULED_SENTINEL, HydrawiseReservedNames, controllerIdentity, isControllerIdentity, isScheduleStatus, isSuspendZoneSubtype,
  isZoneIdentity, isZoneStoppedBySensor, sameControllerIdentity, sameScheduleStatus, sameZoneIdentity, scheduleStatus, suspendZoneSubtype,
  zoneIdentity, zoneScheduleStatus } from "./types.ts";
import type { HomebridgePluginLogging, Nullable } from "homebridge-plugin-utils";
import type { HydrawiseAccessory, HydrawiseControllerAccessory, HydrawiseControllerConfig, HydrawiseControllerHardware, HydrawiseControllerIdentity,
  HydrawiseControllerV2Facts, HydrawiseScheduleStatus, HydrawiseZoneConfig, HydrawiseZoneIdentity, HydrawiseZoneScheduleStatus, HydrawiseZoneSuspensionResult,
  SetZoneResponse, StatusScheduleResponse } from "./types.ts";
import type { HydrawiseControllerOption, HydrawiseControllerValueOption, HydrawiseZoneOption, HydrawiseZoneValueOption } from "./options.ts";
import { acquireService, getServiceName, loopFaultReporter, mqttTopic, prefixedLog, retry, sameEntries, sanitizeName, setAccessoryName, setServiceName,
  superviseLoop, validCharacteristic, validService } from "homebridge-plugin-utils";
import type { Dispatcher } from "undici";
import type { HydrawisePlatform } from "./platform.ts";
import { mqttTopics } from "./mqtt.ts";
import util from "node:util";

// Device-specific options and settings.
interface HydrawiseHints {

  suspendAll: boolean;
}

/* One completed poll, as it crosses from the wire half of the polling loop to the HomeKit half: whether this is the controller's first completed poll, and the
 * status body that poll fetched.
 *
 * isFirstRun travels here because it cannot be recovered on the far side. It is read from the pre-fetch nextpoll sentinel, before the fetch overwrites the status
 * it describes, and the zone walk reads it to decide whether to attach a valve's set handler - the warm-restart case, where the valve service comes back from the
 * accessory cache but this process has never bound a handler to it.
 *
 * The status field is deliberately the same object the controller holds, not a defensive copy. The projection reads instance state directly throughout, and it is
 * the only consumer in the process, so a copy would hand it one object while every other read in the same pass saw another.
 */
interface HydrawisePollUpdate {

  readonly isFirstRun: boolean;
  readonly status: StatusScheduleResponse;
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

/* One per-zone suspension command the account accepted, as the display needs it: the instant it was accepted, and WHICH WAY it went - the instant a suspension
 * lifts, or null for a resume.
 *
 * The direction is what a bare timestamp could not carry. A stamp alone says that the user commanded something, which is enough to know that an older snapshot is
 * uninformed, but not enough to know what to show in its place.
 */
interface HydrawiseZoneSuspendCommand {

  at: number;
  commandedUntil: Nullable<number>;
}

/* One Hydrawise irrigation controller as HomeKit sees it: the accessory or accessories this class projects onto, the endless polling loop that keeps their
 * characteristics current, and the commands a user's actions in the Home app turn into wire requests.
 *
 * The polling loop runs as two halves under one supervised envelope, started from the constructor: pollStatus() is the wire generator that fetches the account
 * API's status on the interval the API itself sets, and applyStatus() is the HomeKit projection that reads each completed poll and updates services,
 * characteristics, and accessory context from it. The same class also owns a standalone zone accessory's valve, when the plugin is configured to promote one,
 * so a zone's state is projected consistently regardless of which accessory hosts it.
 *
 * Every command HomeKit issues - a zone run or stop, an account-wide suspend-all, a per-zone suspension - is sent from here through sendCommand(), and the
 * confirmed result is folded back into the same projection a poll would update, so a change made in the Home app and one made in the Hydrawise app converge on
 * the same displayed state.
 */
export class HydrawiseController {

  private readonly accessory: HydrawiseControllerAccessory;
  private readonly api: API;
  public readonly controller: HydrawiseControllerConfig;

  // This controller's MQTT topic tail, composed once from its serial and the catalog's tail, because neither changes for the life of the controller.
  private readonly controllerTopic: string;

  private enabledZones: HydrawiseZoneConfig[];
  private readonly hap: HAP;
  private readonly hints: HydrawiseHints;

  /* The last availability the account API actually reported, and the seed the transition line compares against. It is deliberately NOT read from the
   * characteristic: that is constructed carrying no-fault, which is indistinguishable from a genuine first report of "online", so a controller that is offline
   * the very first time it is heard from would otherwise narrate a transition that never happened. Null means nothing has reported yet, so the first arrival
   * seeds silently whatever it says.
   *
   * It lives in memory and dies with the process by design, on the same terms as the zone ledger's own seeds: after a restart the first arrival re-seeds
   * silently, so restarting never manufactures a transition either.
   */
  private lastKnownOnline: Nullable<boolean> = null;

  /* The account-wide suspension command this controller last issued and no fresher truth has superseded, or undefined where none stands. It is the account-grain
   * twin of the per-zone map below, carrying the same shape for the same reason: a bare timestamp would say that the user commanded something without saying
   * WHICH WAY, which is enough to know a stale snapshot is uninformed but not enough to know what to show instead.
   *
   * Undefined rather than null for "none", so the one standing judgment both grains ask can take them on identical terms - a map read answers undefined for a
   * zone with no command, and this answers undefined for an account with none.
   */
  private suspendAllCommand: HydrawiseZoneSuspendCommand | undefined;

  public readonly log: HomebridgePluginLogging;
  private readonly platform: HydrawisePlatform;
  private status: StatusScheduleResponse;

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

  /* The per-zone suspension commands the account has accepted and no fresher truth has yet superseded, keyed by relay id. It is the zone-grain twin of the scalar
   * stamp above, and the two live side by side because they answer different questions: one guards the account-wide switch, the other guards a single zone's.
   *
   * It dies with the process by design. After a restart the projection's own carried suspensions own the display, which is the truth the account confirmed rather
   * than one this process remembered commanding.
   */
  private readonly zoneSuspendCommands = new Map<number, HydrawiseZoneSuspendCommand>();

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

    // Populated synchronously by configureDevice(), called at the end of this constructor, which runs configureHints() first among its steps and so sets
    // this.hints.suspendAll before any external reader can observe this.hints - that ordering is what makes the empty-object cast safe.
    this.hints = {} as HydrawiseHints;
    this.controller = controller;
    this.controllerTopic = mqttTopic(this.controller.serial_number, mqttTopics.controller.topic);
    this.platform = platform;
    this.zoneHints = new HydrawiseZoneHintLedger();

    // Prefix every log line with this controller's live name. The platform's logger already gates debug routing through the user's debug setting, so debug lines
    // prefixed here route intact.
    this.log = prefixedLog(platform.log, (): string => this.name);

    this.configureDevice(roster);
  }

  // Configure an irrigation system accessory for HomeKit.
  private configureDevice(roster: HydrawiseControllerIdentity[]): void {

    // Capture the prior persisted identity, zone roster, and schedule projection before we wipe the context. We restore all three below so a restart does not blank
    // the zone list or the schedule panel during the window between this configure pass and the first completed poll, when the runtime has not yet rebuilt either
    // from a fresh status body.
    const priorController = this.accessory.context.controller;
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

    // Configure ourselves.
    this.configureHints();
    this.configureInfo();
    this.configureIrrigationSystem();
    this.configureSuspendSwitches();
    this.configureMqtt();

    /* Kick off our state updates under supervision so a genuine fault in the polling loop surfaces once through the reporter, while a shutdown abort unwinds the
     * loop silently. The wire half and the HomeKit half sit inside this ONE envelope because they are one fault domain: a throw from either ends the same loop and
     * owes the operator the same single report, so the generator needs no supervision of its own - its throws land here.
     */
    void superviseLoop({ loop: async (signal): Promise<void> => {

      for await (const update of this.pollStatus(signal)) {

        this.applyStatus(update);
      }
    }, onError: loopFaultReporter(this.log, "zone status"), signal: this.platform.signal });
  }

  // Configure controller-specific settings.
  private configureHints(): void {

    this.hints.suspendAll = this.hasFeature("Device.Suspend.All");

    // Surface a name-synchronization opt-out at startup. Synchronization is read live on each poll rather than cached in a hint, since a zone can opt out
    // independently of its controller; this line reports the controller-scope answer, which is the one that governs when no zone says otherwise.
    this.platform.featureOptions.logFeature("Device.SyncName", "Name synchronization", this.log, undefined, this.controller.serial_number);

    // Surface the per-zone suspension switches on the same terms, and only where the account credentials that can command a suspension are configured: without them
    // these switches are never created, so naming them would advertise a feature this install does not have.
    if(this.platform.hasV2Client) {

      this.platform.featureOptions.logFeature("Device.Suspend.Zone", "Per-zone suspension switches", this.log, undefined, this.controller.serial_number);
    }
  }

  /* Configure the accessory information for one of the accessories this controller projects onto. The parameters pair an accessory with the serial number and the
   * hardware facts that belong to it as one correlated value, so an accessory can never be stamped with another accessory's details, and they default to the
   * controller's own accessory and its wire serial with no hardware named. A standalone zone accessory has no wire serial of its own, so its caller synthesizes
   * one, and it names no hardware either: model and firmware describe the controller, not one valve hanging off it.
   *
   * The manufacturer and the serial always write. What happens to the model and the firmware depends on which of the following combinations holds.
   *
   * Called WITH hardware, this writes it - that is the enrichment landing, and it writes unconditionally, comparing nothing first. HAP already drops a write whose
   * value matches what the characteristic holds, so a compare here would only duplicate the library's own work and add a second place for the two answers to
   * disagree.
   *
   * Called WITHOUT hardware on the controller's OWN accessory while the account credentials are configured, it leaves BOTH alone. Those characteristics are the
   * store: HAP restored real values from a previous session into them, and the fetch that will refresh those values is already on its way, so writing a
   * placeholder over them would blank a correct display for the length of a network round trip. The single exception is an accessory that has never been
   * stamped at all, which still carries HAP's own default model - there is nothing to preserve there, and leaving it would show the user a library-internal
   * string, so the placeholder is written.
   *
   * Called WITHOUT hardware and with no credentials configured, both write unconditionally: the product-line placeholder, and the firmware returned to the
   * unknown-firmware marker Homebridge itself stamps on a restored accessory. That reset is what makes removing the credentials a clean revert - the
   * characteristics outlive the credentials that populated them, so an omitted write would strand a real version on display permanently, with nothing left in the
   * plugin that could refresh or correct it.
   */
  private configureInfo({ accessory, hardware, serialNumber }: { accessory: HydrawiseAccessory; hardware?: HydrawiseControllerHardware; serialNumber: string } =
    { accessory: this.accessory, serialNumber: this.controller.serial_number }): void {

    const informationService = accessory.getService(this.hap.Service.AccessoryInformation);

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
  }

  /* Adopt the facts the account-credentialed API reported for this controller: display them, project them, and make whatever moved durable.
   *
   * The ORDER here is part of the contract. The prior snapshot is captured in a local BEFORE the new one is stored, because the hardware comparison below reads
   * the snapshot this controller was holding on entry; a comparison written against the field after the store would read the new value on both sides and could
   * never report a change. The first arrival counts as a change whenever it carries hardware, since that arrival is the one that has to reach the disk.
   *
   * The characteristics are the only store the hardware facts have. HAP round-trips them through Homebridge's on-disk accessory cache, so writing them here and
   * flushing is the whole of the persistence - no parallel copy is kept, which is what keeps a restart from having two answers to reconcile.
   *
   * The flush is CHANGE-GATED, and on a recurring cadence that gate is the point: a tick that moved nothing would otherwise write the accessory cache to disk
   * every quarter hour for no reason at all. It fires when the projection moved or when the hardware genuinely differs from what this controller already held.
   *
   * @param facts     - The hardware, availability, and per-zone facts the account API reported for this controller.
   * @param fetchedAt - The local instant, in epoch seconds, the request that fetched them was made.
   */
  public applyFacts({ facts, fetchedAt }: { facts: HydrawiseControllerV2Facts; fetchedAt: number }): void {

    const prior = this.v2Facts;

    this.v2Facts = { ...facts, fetchedAt };

    if(facts.hardware) {

      this.configureInfo({ accessory: this.accessory, hardware: facts.hardware, serialNumber: this.controller.serial_number });
    }

    this.reportAvailability(facts.online);

    this.rederiveProjection(!this.sameHardware(prior?.hardware ?? null, facts.hardware));

    this.log.debug("Enhanced details updated: model %s, firmware %s, reachable %s, zones %s.", facts.hardware?.model ?? "unknown",
      facts.hardware?.firmware ?? "unknown", facts.online ?? "unknown", facts.zones.size.toString());
  }

  /* Re-derive the projection from whatever this controller currently knows, then make what moved durable and published. Every cadence that can change a zone's
   * classification outside a poll runs this: a refresh tick, which brings fresh account facts, and a successful suspension command, whose acceptance is itself a
   * fact about the zones it named.
   *
   * Each write is CHANGE-GATED, which is what lets a recurring cadence run this freely. A tick or a command that moved no classification writes nothing to the
   * accessory cache and publishes nothing on MQTT, where an unconditional pair would write the cache to disk every quarter hour and republish an unchanged
   * payload with it. The poll cadence keeps its own unconditional publish, which is a contract of its own and deliberately not shared here.
   *
   * The facts are resolved ONCE and threaded through both the classification and the payload, on the same terms every other pass in this class resolves them, so
   * a lifetime boundary crossed midway cannot leave the two describing different worlds.
   *
   * Before the first completed poll this is structurally a no-op: the projection step returns early with nothing to classify, so neither gate opens.
   *
   * @param mustFlush - Whether something outside the projection also has to reach the accessory cache this pass, which the projection's own change gate cannot
   *                    see. The hardware facts are the case: HAP's characteristics are their only store, so a hardware change has to be flushed to survive.
   */
  private rederiveProjection(mustFlush = false): void {

    const facts = this.currentFacts;
    const projectionChanged = this.applyProjection(facts);

    if(projectionChanged || mustFlush) {

      this.api.updatePlatformAccessories([this.accessory]);
    }

    if(projectionChanged) {

      this.platform.mqtt?.publishGuarded(this.controllerTopic, this.statusJson(facts));
    }
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

    this.accessory.context.controllers = roster;
    this.api.updatePlatformAccessories([this.accessory]);
  }

  // Compare two hardware answers field-wise, treating an absent answer as a value of its own so the first arrival against a null baseline reports as a change.
  // Never by reference: each refresh composes a fresh object, so a reference check would call every tick a change and flush the accessory cache on every one.
  private sameHardware(a: Nullable<HydrawiseControllerHardware>, b: Nullable<HydrawiseControllerHardware>): boolean {

    if(!a || !b) {

      return a === b;
    }

    return (a.firmware === b.firmware) && (a.model === b.model);
  }

  /* Report a change in whether Hydrawise can reach this controller, and remember what was reported. The line fires only when a new non-null reading DIFFERS from
   * a non-null one already recorded, so the first arrival seeds silently whatever it says and a refresh that simply cannot tell changes nothing.
   */
  private reportAvailability(online: Nullable<boolean>): void {

    if(online === null) {

      return;
    }

    if((this.lastKnownOnline !== null) && (this.lastKnownOnline !== online)) {

      this.log.info(online ? "The controller is back online." : "The controller is offline.");
    }

    this.lastKnownOnline = online;
  }

  /* The account-credentialed facts if and only if they can still be trusted, and null otherwise. This is the single freshness judgment in the class, and every
   * way there is nothing to trust - none ever arrived, the last ones have aged past their lifetime, or no credentials are configured at all - answers the same
   * null, so no consumer has to tell them apart.
   *
   * It hands back the WHOLE snapshot rather than the zones map alone, because every gated consumer draws the same judgment: the per-zone classifier inputs, the
   * projection's availability stamp, the MQTT payload's additive fields, and the fault characteristic. Returning the map alone would force a second, parallel
   * freshness read for the facts that are not per-zone, which is exactly the divergence one chokepoint exists to prevent.
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
   * The flush is deliberately NOT performed here. Each caller owns its own write policy - the poll folds this into the single cache write it already makes, while
   * the refresh and command cadences gate theirs on the boolean returned here - so this method persists and reports, and never decides.
   *
   * This is deliberately not a whole applyStatus re-run. That method also drives the standalone-accessory reconcile, whose wire-absence grace COUNTS POLLS, so
   * re-entering it outside a poll would double-count that grace and could demote an accessory the wire never actually dropped.
   *
   * Before the first completed poll there is nothing to classify, so only the fault characteristic - which answers to the facts alone - is refreshed.
   */
  private applyProjection(facts: Nullable<HydrawiseControllerFactsSnapshot>): boolean {

    this.refreshStatusFault(facts);

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

  /* Drop every per-zone suspension command this pass supersedes, so that what remains is exactly the set that still speaks for its zone.
   *
   * A command retires when facts postdate it, which is the freshness rule's other face, or when its zone leaves the wire report, which leaves nothing for the
   * command to speak for.
   *
   * This runs at the head of a pass rather than beside any one consumer, because the surviving set is what the classifier is handed: a stale entry reaching
   * composition would resurrect a command the account has already answered, and it would do so in the persisted projection where every surface would read it.
   */
  private retireSupersededCommands(facts: Nullable<HydrawiseControllerFactsSnapshot>): void {

    const reported = new Set(this.status.relays.map(zone => zone.relay_id));

    for(const [ relayId, command ] of this.zoneSuspendCommands) {

      if(!this.commandStands(command, facts) || !reported.has(relayId)) {

        this.zoneSuspendCommands.delete(relayId);
      }
    }
  }

  /* Show every companion switch what its zone now reads as.
   *
   * Every cadence that can move a zone's suspension arrives here through applyProjection: the poll, which brings fresh wire truth, a refresh tick, which brings
   * the account facts a suspension is actually reported on, and a successful suspension command, whose acceptance is itself a fact about the zone it named - so
   * a suspension made in the Hydrawise app reaches its switch with the refresh that learned of it rather than waiting for a poll that cannot see it.
   */
  private refreshZoneSuspendSwitches(facts: Nullable<HydrawiseControllerFactsSnapshot>): void {

    for(const entry of this.accessory.context.schedule?.zones ?? []) {

      // The switch speaks its own name's language: On means SUSPENDED, matching the account-wide suspend switch's convention. A zone's active state already lives
      // on its valve, so a switch that read the other way would put two answers to one question in front of the user.
      this.zoneHosts.get(entry.relayId)?.getServiceById(this.hap.Service.Switch, suspendZoneSubtype(entry.relayId))
        ?.updateCharacteristic(this.hap.Characteristic.On, this.isZoneSuspended(entry.relayId, entry, facts));
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

  /* Bring every name this controller shows in HomeKit into line with its effective name - the user's Name option when set, otherwise the name resolved above.
   * One cadence carries every rename this plugin performs: this runs on the poll, exactly where the zone walk applies its own, so a controller and its zones
   * adopt a Hydrawise-side rename together rather than one of them lagging a refresh behind.
   *
   * The gate is the irrigation system service's name, compared in its SANITIZED form on both sides exactly as the zone gate compares. HomeKit's naming rules
   * cannot round-trip every configured value, and an unsanitized comparison would read those as differing on every poll and rewrite the same name forever. That
   * service is this controller's primary label - the proxy the name getter itself reads - so what it carries decides what the accessory, the service label
   * enumerating its zones, and the suspend-all switch are brought into line with.
   *
   * A name with nothing left after sanitization skips every write this step performs, at every surface it touches. Those rules can empty a name outright, and a
   * service must answer to something: setServiceName writes whatever it is handed, so without this gate an unusable name would blank the very labels the user
   * navigates by. The accessory helper carries a guard of its own for the same reason, which is what a blanked pair would otherwise have cost.
   *
   * The accessory's display pair answers to the SERVICE name's gate rather than to one of its own. Creation writes both stores from the same effective name and this
   * step rewrites both together, so the two move in lockstep and a single comparison settles whether either is stale.
   *
   * @param facts - The account-credentialed facts this pass resolved, or null when there are none to trust.
   *
   * @returns Whether any name was written this pass, which is what lets a rename join the poll's single cache write - the accessory's display name lives in
   *          Homebridge's cache, so a rename that never flushed would come back under its old label at the next restart.
   */
  private applyControllerName(facts: Nullable<HydrawiseControllerFactsSnapshot>): boolean {

    const irrigationService = this.accessory.getService(this.hap.Service.IrrigationSystem);

    /* With synchronization disabled the names are established at creation and never touched again - the zone contract at the controller grain. A rename made in
     * the Home app then stands, and the Name option remains the sanctioned way to correct what Hydrawise reports.
     */
    if(!irrigationService || !this.hasFeature("Device.SyncName")) {

      return false;
    }

    const effectiveName = this.controllerNameOverride("Device.Name") ?? this.controllerName(facts);
    const sanitized = sanitizeName(effectiveName);

    if(!sanitized.length) {

      return false;
    }

    let renamed = false;

    if(getServiceName(irrigationService) !== sanitized) {

      setServiceName(irrigationService, effectiveName);

      // The service label is acquired beside the irrigation system and created carrying the same name, so a rename that skipped it would leave the two disagreeing.
      const labelService = this.accessory.getService(this.hap.Service.ServiceLabel);

      if(labelService) {

        setServiceName(labelService, effectiveName);
      }

      // The accessory's own display pair - the Home app's tile and the information service's name - is written here through the library helper that owns every
      // write in it.
      setAccessoryName(this.accessory, effectiveName);

      renamed = true;
    }

    /* The suspend-all switch composes its name from the controller's, so it answers to a comparison against that COMPOSED form rather than to the one above: a
     * switch the user renamed, or one restored from a session under a different controller name, is brought back into line on its own terms. The composed form
     * needs no emptiness check of its own - it inherits non-emptiness from the controller half the gate above already required.
     */
    const suspendService = this.accessory.getServiceById(this.hap.Service.Switch, HydrawiseReservedNames.SWITCH_SUSPEND_ALL);
    const suspendName = effectiveName + " Suspend All Zones";

    if(suspendService && (getServiceName(suspendService) !== sanitizeName(suspendName))) {

      setServiceName(suspendService, suspendName);

      renamed = true;
    }

    return renamed;
  }

  /* Whether a suspension command still speaks for what it was issued against, which it does exactly while no fresher truth has arrived to supersede it. This is
   * the one comparison home for the guard at BOTH grains - every reader of a standing command, plus the sweep that clears retired entries and, through that
   * sweep, the composition itself - so what "still standing" means cannot be answered two ways, and the switches and the projection cannot disagree about it.
   *
   * Only a STRICTLY newer snapshot retires a command, which is the account-wide guard's own rule at the zone grain. Both instants are whole seconds, so a fetch
   * stamped in the same second as the command could have been dispatched either side of it, and the tie goes to the user: holding their command costs at most one
   * refresh of staleness, while handing the second to the fetch reopens the very race of a snapshot flipping a switch back under their finger.
   *
   * A null snapshot KEEPS a standing command standing. None ever arrived, the last one aged out, or the refresh has stalled: in every case nothing newer has
   * contradicted the user, so their own command is the honest thing to display until facts that postdate it land.
   */
  private commandStands(command: HydrawiseZoneSuspendCommand | undefined, facts: Nullable<HydrawiseControllerFactsSnapshot>):
    command is HydrawiseZoneSuspendCommand {

    return (command !== undefined) && (!facts || (facts.fetchedAt <= command.at));
  }

  /* Whether a zone reads as suspended right now. A standing command answers first and the classified projection answers otherwise, so the switch and the zone
   * list are one reading rather than two derivations that can drift.
   *
   * The command arm is asked DIRECTLY rather than read off the composition, and the running window is why it cannot be collapsed into it. A zone suspended while
   * it is watering keeps its switch on - the user's command was accepted - while the projection honestly reads running until the water stops, because flowing
   * water is the one thing no command overrules. Those are two different questions, and both are answered from the one standing judgment above rather than from
   * two sources that could drift.
   */
  private isZoneSuspended(relayId: number, state: HydrawiseZoneScheduleStatus | undefined, facts: Nullable<HydrawiseControllerFactsSnapshot>): boolean {

    const command = this.zoneSuspendCommands.get(relayId);

    if(this.commandStands(command, facts)) {

      return command.commandedUntil !== null;
    }

    return state?.state === "suspended";
  }

  /* Project whether Hydrawise can currently reach this controller onto the irrigation system's fault characteristic, which exists only where the plugin can
   * actually learn the answer.
   *
   * Each reading is handled on its own terms. A live "reachable" clears the fault and a live "unreachable" raises it. A refresh that carried no reading at all
   * leaves whatever is displayed standing, because overwriting a real answer with a guess is worse than a moment of staleness. And no trustworthy snapshot -
   * never arrived, or aged out because the refresh loop has stopped - clears the fault, since an unknown state is not a fault and freezing an offline reading on
   * display forever would be a lie the user cannot clear.
   */
  private refreshStatusFault(facts: Nullable<HydrawiseControllerFactsSnapshot>): void {

    if(!this.platform.hasV2Client) {

      return;
    }

    const service = this.accessory.getService(this.hap.Service.IrrigationSystem);

    if(!service) {

      return;
    }

    if(!facts) {

      service.updateCharacteristic(this.hap.Characteristic.StatusFault, this.hap.Characteristic.StatusFault.NO_FAULT);

      return;
    }

    if(facts.online === null) {

      return;
    }

    service.updateCharacteristic(this.hap.Characteristic.StatusFault,
      facts.online ? this.hap.Characteristic.StatusFault.NO_FAULT : this.hap.Characteristic.StatusFault.GENERAL_FAULT);
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

    // Set the state of a given irrigation zone.
    this.platform.mqtt?.subscribeSet(this.controllerTopic, mqttTopics.controller.label, async (value: string): Promise<void> => {

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

            await this.sendCommand(zone, "run", zone.run);

            return;
          }

          const parsed = Number(token);

          if(!Number.isSafeInteger(parsed)) {

            throw new Error("MQTT: Invalid duration specified.");
          }

          await this.sendCommand(zone, "run", parsed);

          return;
        }

        case "stop":

          await this.sendCommand(zone, "stop");

          return;

        default:

          throw new Error("Invalid command.");
      }
    });
  }

  /* Configure the irrigation system service for HomeKit.
   *
   * Creation consults the user's Name option, which is what makes a synchronization opt-out mean the same thing at both grains: the name is established from the
   * configured truth and never touched again. Without the consult a fresh accessory on an opted-out install would be born under the wire's name and stay there,
   * with the option the user set to correct it unreachable for the life of that accessory.
   */
  private configureIrrigationSystem(): void {

    const creationName = this.controllerNameOverride("Device.Name") ?? this.name;

    // Acquire the service and if needed, add a service label service in order to be able to properly enumerate and name the individual zone valves. Both are
    // created carrying the same name, which is the pairing the rename step relies on when it brings the label along with the service it sits beside.
    const { service } = acquireService({ accessory: this.accessory, name: creationName,
      onServiceCreate: () => acquireService({ accessory: this.accessory, name: creationName, serviceType: this.hap.Service.ServiceLabel }).service
        .updateCharacteristic(this.hap.Characteristic.ServiceLabelNamespace, this.hap.Characteristic.ServiceLabelNamespace.ARABIC_NUMERALS),
      serviceType: this.hap.Service.IrrigationSystem });

    // Initialize the service.
    service.updateCharacteristic(this.hap.Characteristic.Active, this.hap.Characteristic.Active.ACTIVE);
    service.updateCharacteristic(this.hap.Characteristic.InUse, this.hap.Characteristic.InUse.NOT_IN_USE);
    service.updateCharacteristic(this.hap.Characteristic.ProgramMode, this.hap.Characteristic.ProgramMode.PROGRAM_SCHEDULED);

    /* Whether Hydrawise can reach this controller is a fact only the account-credentialed API reports, so the characteristic that shows it exists only on an
     * install that configured those credentials. It is one of the optional characteristics the specification permits on this service, and wherever it is present
     * after the presence gate - attached this pass or kept from the accessory cache - it is stamped with an explicit no-fault starting state, because construction
     * runs synchronously, long before any refresh can have answered.
     *
     * The gate's removal arm is the same clean revert the firmware reset above performs, and it matters for the same reason: HAP round-trips characteristics
     * through the accessory cache, so an accessory restored from a session that HAD credentials would otherwise keep displaying a reachability nothing is left
     * to update.
     */
    const faultPresence = validCharacteristic({ characteristic: this.hap.Characteristic.StatusFault, service, validate: this.platform.hasV2Client });

    if((faultPresence === "attached") || (faultPresence === "kept")) {

      service.updateCharacteristic(this.hap.Characteristic.StatusFault, this.hap.Characteristic.StatusFault.NO_FAULT);
    }
  }

  // Configure suspend switch services for HomeKit.
  private configureSuspendSwitches(): void {

    /* Reconcile the switch's presence with the user's setting in one call, which creates it when the setting wants it and removes it when the setting does not. A
     * fresh switch composes its name from the controller's effective name - the user's Name option when set, otherwise whatever the accessory currently answers to
     * - on exactly the terms the irrigation system service above is created, and a restored switch keeps the name it came back with, because the library leaves
     * a kept service's name untouched.
     */
    const { service } = validService({ accessory: this.accessory, name: (this.controllerNameOverride("Device.Name") ?? this.accessoryName) + " Suspend All Zones",
      serviceType: this.hap.Service.Switch, subtype: HydrawiseReservedNames.SWITCH_SUSPEND_ALL, validate: this.hints.suspendAll });

    // A switch the setting removed, or never wanted, leaves nothing to configure.
    if(!service) {

      return;
    }

    // Suspend or resume the irrigation schedule.
    service.getCharacteristic(this.hap.Characteristic.On).onGet(() => this.isAllSuspended(this.currentFacts));

    service.getCharacteristic(this.hap.Characteristic.On).onSet(async (value: CharacteristicValue): Promise<void> => {

      // We either set the timestamp to the current time, to resume irrigation, or to a year from now to suspend irrigation. Both floor to a whole second so the
      // command carries the integer seconds the API expects rather than a fractional millisecond remainder. The instant is sent to Hydrawise, which reads it as
      // wall-clock time, so it comes from the host's own clock rather than the platform's.
      const timestamp = Math.floor(Date.now() / 1000) + (value ? HYDRAWISE_SUSPEND_DURATION : 0);

      const response = await this.sendCommand("suspendall", timestamp);

      let status;

      try {

        status = await response?.body.json() as SetZoneResponse;
      } catch {

        // A shutdown abort mid-read is orderly teardown, not a failure - exit the whole handler quietly, skipping both the error log and the revert timer.
        if(this.platform.signal.aborted) {

          return;
        }

        this.log.error("Unable to retrieve the result of the %s request.", value ? "suspend" : "resume");
      }

      if(status?.message_type === "error") {

        this.log.error("Unable to complete the %s request.", value ? "suspend" : "resume");
      }

      if(!status || (status.message_type === "error")) {

        // Put the switch back where it was after a brief beat. The write is scheduled through the platform's registry, which ties it to the plugin's lifetime: a
        // revert still pending when Homebridge shuts down drains with the registry, and one scheduled after shutdown never fires.
        this.platform.timers.schedule(() => service.updateCharacteristic(this.hap.Characteristic.On, !value), HYDRAWISE_REVERT_DELAY);

        return;
      }

      /* Record this command with the instant it succeeded and the direction it went. A facts snapshot fetched before it cannot know about it, so every reader
       * ignores such a snapshot in this command's favor until a refresh that postdates it lands - which is what stops a fetch already in flight when the user
       * pressed the switch from flipping it straight back. A resume records too, for the same reason in the other direction.
       */
      const at = Math.floor(this.platform.clock.now() / 1000);

      this.suspendAllCommand = { at, commandedUntil: value ? timestamp : null };

      /* An account-wide command is also a fact about every zone beneath it, so it stamps each one's own guard with the direction it went. The population is every
       * zone the WIRE has reported rather than the enabled projection, which is empty until the first poll completes and which silently omits any zone a feature
       * option has turned off; without this, the next refresh's pre-command facts would fight the account-wide switch's optimistic state zone by zone. A command
       * issued before any poll at all stamps nothing, and the scalar above carries the account-wide answer alone until the first poll seeds the walk.
       */
      for(const zone of this.status.relays) {

        this.zoneSuspendCommands.set(zone.relay_id, { at, commandedUntil: value ? timestamp : null });
      }

      this.log.info("%s scheduled watering for all zones.", value ? "Suspending" : "Resuming");

      // Re-derive on the account-wide command's own terms, exactly as a per-zone command does. It runs after the sentence above so the account-wide statement
      // reads ahead of the per-zone transitions the re-derive narrates beneath it.
      this.rederiveProjection();
    });

    service.updateCharacteristic(this.hap.Characteristic.On, this.isAllSuspended(this.currentFacts));

    this.platform.featureOptions.logFeature("Device.Suspend.All", "Suspend all zones switch", this.log, undefined, this.controller.serial_number);
  }

  // Poll the Hydrawise API forever, yielding one update per completed poll. This is the wire half of the loop: it owns the fetch, the retry policy that recovers
  // from a failed poll, and the pacing the API asks for, and it touches no HomeKit service. A shutdown abort unwinds it through the signal, which superviseLoop
  // treats as the expected exit; a throw that outlives the retry policy propagates out of the generator into the same envelope, ending the loop as a terminal
  // fault.
  private async *pollStatus(signal: AbortSignal): AsyncGenerator<HydrawisePollUpdate, void, undefined> {

    for(;;) {

      const isFirstRun = this.status.nextpoll === -1;

      // Update our status, retrying forever on a network failure or a malformed or mis-shaped body at the polling cadence. On the first run we use the fixed retry
      // interval; afterwards we honor the API's nextpoll hint, clamped so a failure never waits longer than twice the retry interval. A shutdown abort ends the
      // retry through the signal.
      // eslint-disable-next-line no-await-in-loop
      await retry(() => this.getStatus(), { attempts: Infinity,
        backoff: (): number => (isFirstRun ? HYDRAWISE_API_RETRY_INTERVAL : Math.min(this.status.nextpoll + HYDRAWISE_API_JITTER, HYDRAWISE_API_RETRY_INTERVAL * 2)) *
          1000, clock: this.platform.clock, signal });

      // Trim whitespace on zone names.
      this.status.relays = this.status.relays.map(x => ({ ...x, name: x.name.trim() }));

      // Hand the completed poll to whoever is consuming this generator. isFirstRun travels with the status because it was read from the pre-fetch sentinel above,
      // and the status the fetch just adopted cannot answer it.
      yield { isFirstRun, status: this.status };

      // Sleep until our next polling interval due to the Hydrawise API being rate-limited. A shutdown abort interrupts the wait and unwinds the loop.
      // eslint-disable-next-line no-await-in-loop
      await this.platform.clock.delay((this.status.nextpoll + HYDRAWISE_API_JITTER) * 1000, { signal });
    }
  }

  // Project one completed poll onto HomeKit. This is the HomeKit half of the loop and the only half that touches a service: the persisted zone roster, the
  // enabled-zone projection and the prunes it drives, the per-zone valve state, the irrigation-system aggregates, the MQTT publish, and the suspend-all switch.
  // It is synchronous by design - the MQTT publish is dispatched fire-and-forget through the client's guarded publish - so one poll's projection lands in a single
  // frame with nothing awaited partway through it.
  private applyStatus(update: HydrawisePollUpdate): void {

    const { isFirstRun, status } = update;

    // Resolve the account-credentialed facts ONCE for this whole pass and thread the answer through everything below, so a lifetime boundary crossed partway
    // through cannot split one poll's classifications between two different answers.
    const facts = this.currentFacts;

    // Bring this controller's own names into line before anything reads them, so the log prefix and every label this pass writes speak with one voice. What it
    // wrote joins the flush below, because the accessory's display name is persisted in Homebridge's cache rather than derived on each start.
    const nameChanged = this.applyControllerName(facts);

    /* Persist the identity roster, the schedule projection, and this controller's own identity, each on change, through one flush: whichever moved this poll lands in
     * a single updatePlatformAccessories call, so a poll costs at most one cache write no matter how many projections it advanced. Every one of these runs before
     * the enablement projection below, so what is persisted covers every reported zone, feature-disabled or not - the complete listing and schedule the webUI
     * reads back from cache with no cloud call.
     *
     * The self-identity carries the controller's TRUE name rather than the label HomeKit shows, which is the same line the zone roster draws: a user's private
     * override is display, and what the webUI lists and the account roster denormalizes is what the controller actually is.
     */
    const rosterChanged = this.persistZoneRoster(facts);
    const scheduleChanged = this.applyProjection(facts);
    const identity = this.identity;
    const identityChanged = !this.accessory.context.controller || !sameControllerIdentity(this.accessory.context.controller, identity);

    if(identityChanged) {

      this.accessory.context.controller = identity;
    }

    if(rosterChanged || scheduleChanged || identityChanged || nameChanged) {

      this.api.updatePlatformAccessories([this.accessory]);
    }

    // The classification this pass just persisted, keyed by relay. Every consumer below - the zone walk's seeds, its rain and status sentences - reads a zone's
    // state from here rather than classifying again, so the log, HomeKit, and the accessory cache cannot tell different stories about the same zone.
    const classified = new Map((this.accessory.context.schedule?.zones ?? []).map(entry => [ entry.relayId, entry ]));

    // Project the reported zones onto the set the user has enabled. Every HomeKit surface in this pass - valves, aggregates, logging - works from this
    // projection, and long-lived handlers read it through the instance field so they always act on the current poll's truth.
    this.enabledZones = status.relays.filter(zone => this.hasZoneFeature("Device", zone.relay_id.toString()));

    /* Resolve each enabled zone's effective name once, ahead of everything that reads it. The rungs, in precedence order: the user's Name option when set, else
     * the account API's own name for the zone, else the name the key-based wire reports.
     *
     * The middle rung is what makes an enriched install show whole names. The key-based API truncates at roughly fifteen characters, so a zone the account calls
     * "Backyard Planters Drip" arrives here as "Backyard Plante"; the account read already fetches that zone, so carrying its name costs no call at all. It reads
     * through the same freshness chokepoint every other account fact does, which is what keeps the promise to an install without credentials: with no trustworthy
     * snapshot the rung contributes nothing and the wire name stands, exactly as it always has.
     *
     * This is the ONE place a zone's displayed name is decided. Every consumer downstream - the valve's name, a standalone accessory's own display name, the
     * persisted roster, the MQTT payload, the log labels - reads the map this builds, so a name arriving from the account is simply a rename, travelling the same
     * path a rename made in the Hydrawise app already travels.
     */
    const effectiveNames = new Map(this.enabledZones.map(zone => [ zone.relay_id,
      this.zoneNameOverride("Device.Name", zone.relay_id.toString()) ?? this.zoneName(zone, facts) ]));

    // The enabled zones the user has asked to expose as HomeKit accessories of their own.
    const standaloneZones = this.enabledZones.filter(zone => this.hasZoneFeature("Device.Standalone", zone.relay_id.toString()));

    /* Hand the platform this poll's standalone request and take back the hosting map, which every hosting decision below reads so the prune and the walk cannot
     * disagree. The present-relay set carries EVERY zone the report named, before the enablement filter above, because that pre-filter population is what lets
     * the platform tell a configuration change from a zone that fell off the wire. The wire name goes into the identity while the effective name goes into the
     * display name: the accessory's label and its persisted identity are different jobs.
     */
    const zoneAccessories = this.platform.reconcileZoneAccessories({ controller: this.controller,
      presentRelayIds: new Set(status.relays.map(zone => zone.relay_id)),
      zones: standaloneZones.map(zone => ({ displayName: effectiveNames.get(zone.relay_id) ?? zone.name, identity: zoneIdentity(zone) })) });

    // Project one live-id set from the enabled zones - reported by the API and enabled by feature option - and drive the hint prune from it, so a zone that
    // vanishes and later reappears starts fresh instead of resurrecting its old manual and rain-stopped flags.
    this.zoneHints.prune(new Set(this.enabledZones.map(zone => zone.relay_id)));

    /* Remove the controller accessory's valves for zones that no longer exist, that the user has disabled, or that live on a standalone accessory of their own.
     * The keep-set is derived from the hosting map rather than from the enablement projection, so pruning and hosting read one source of truth: a promoted zone's
     * controller-side valve is pruned by exactly this line, while a zone whose promotion failed keeps its valve here - which is where the walk below will host
     * it. The map's number keys are bridged to the string subtypes each valve service carries.
     */
    const hostedZoneIds = new Set(this.enabledZones.filter(zone => !zoneAccessories.has(zone.relay_id)).map(zone => zone.relay_id.toString()));

    this.accessory.services.filter(x => (x.UUID === this.hap.Service.Valve.UUID) && !hostedZoneIds.has(x.subtype ?? ""))
      .map(x => this.accessory.removeService(x));

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

      /* The name this zone's valve carries, read from the pre-pass above. The fallback is the same wire name that pre-pass would itself have stored, which keeps
       * the read total.
       *
       * The sanitized form is resolved once beside it and is what every rename gate below compares against, because HomeKit's naming rules can empty a name
       * outright and setServiceName writes whatever it is handed. A zone whose effective name sanitizes to nothing therefore renames nothing at all - not its
       * valve, not the accessory hosting it, not its companion switch - and keeps the labels it already carries.
       */
      const effectiveName = effectiveNames.get(zone.relay_id) ?? zone.name;
      const sanitizedName = sanitizeName(effectiveName);

      // Where this zone's valve lives: the standalone accessory the reconcile established for it, or the controller accessory. One derived answer, read by every
      // decision below that depends on which it is.
      const host = zoneAccessories.get(zone.relay_id) ?? this.accessory;
      const isStandaloneHost = host !== this.accessory;

      this.zoneHosts.set(zone.relay_id, host);

      // Whether this zone's names track the configured truth. Resolved once per zone, because the valve service and the standalone accessory answer to the same
      // gate at the same cadence.
      const syncName = this.hasZoneFeature("Device.SyncName", zone.relay_id.toString());

      // Acquire the valve service. The transition the library answers says whether this pass created it, which is what the establishment gates below read.
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

      // While name synchronization holds for this zone, the effective name - the user's Name option when set, otherwise the name Hydrawise reports - is
      // authoritative: it is applied whenever the service's name differs, so a Hydrawise rename lands on the next poll, a changed Name option lands at the
      // first poll after restart, and a rename made in the Home app yields to the configured truth. Synchronization is deliberately enabled by default,
      // because the names Hydrawise reports are the source of truth this integration projects into HomeKit and the Name option exists to correct them where
      // Hydrawise truncates. With synchronization disabled, names are established at creation and never touched again, and a Home app rename persists.
      if((transition !== "attached") && syncName && sanitizedName.length && (getServiceName(valveService) !== sanitizedName)) {

        setServiceName(valveService, effectiveName);
      }

      // A standalone zone accessory carries its own information service, established the first time this process binds the zone's valve on it - the controller's
      // first poll, or a valve this pass created. The zone carries no wire serial, so we synthesize one from the controller's serial and the relay id: stable,
      // unique, and purely presentational.
      if(isStandaloneHost && (isFirstRun || (transition === "attached"))) {

        this.configureInfo({ accessory: host, serialNumber: this.controller.serial_number + "-" + zone.relay_id.toString() });
      }

      /* Keep the standalone accessory's own top-level name tracking the effective name, on every poll and under the same gate the valve service answers to, so a
       * Hydrawise rename or a changed Name option lands on the accessory exactly when it lands on the valve. This sits outside the establishment gate above
       * deliberately: a rename arriving on a later poll must still land. The flush is what persists the new name to Homebridge's cache, and it only runs when the
       * name actually moved.
       */
      if(isStandaloneHost && syncName && sanitizedName.length && (host.displayName !== sanitizedName)) {

        setAccessoryName(host, effectiveName);
        this.api.updatePlatformAccessories([host]);
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
       * applies to the same question.
       *
       * Both are resolved before the hint entry so a first-sighted zone seeds its stored state from the live readings rather than from static defaults, which
       * would otherwise fire a spurious transition the first time a zone appears during a rain delay or under a suspension.
       */
      const state = classified.get(zone.relay_id);
      const isStopped = facts?.zones.get(zone.relay_id)?.sensorStopped ?? this.isStoppedBySensor(zone);

      // Resolve this zone's hint entry, seeded on first sighting with the live state. The view is the ledger's own entry, so the reads below see every write the
      // rest of this pass makes to it.
      const hints = this.zoneHints.ensure(zone.relay_id, isStopped, state?.state === "suspended");

      // Establish this zone's companion suspension switch where the user asked for one, and record where it landed for the sweep below to judge against.
      const suspendSubtype = this.configureZoneSuspendSwitch({ effectiveName, facts, host, isFirstRun, sanitizedName, state, syncName, zone });

      if(suspendSubtype) {

        suspendHosts.set(suspendSubtype, host);
      }

      // Inform the user.
      if(isFirstRun || (transition === "attached")) {

        // Refresh our stopped state unconditionally on a first sighting or valve rediscovery, seeding the stored value with the live sensor reading so the
        // transition check below does not fire on the zone's first appearance.
        this.zoneHints.refreshStopped(zone.relay_id, isStopped);

        this.log.info("%s: %s", this.zoneLabel(zone, valveService), this.zoneStatus(zone, state));

        // Manually control the zone valve.
        valveService.getCharacteristic(this.hap.Characteristic.Active).onSet(async (value: CharacteristicValue): Promise<void> => {

          const setOn = value === this.hap.Characteristic.Active.ACTIVE;
          const duration = Number(valveService.getCharacteristic(this.hap.Characteristic.SetDuration).value ?? 0);
          let response;

          // Request the change in zone state.
          if(setOn) {

            response = await this.sendCommand(zone, "run", duration);
          } else {

            response = await this.sendCommand(zone, "stop");
          }

          // Something went wrong in communicating with the Hydrawise API.
          if(!response) {

            // Revert our state for this zone. The write is scheduled through the platform's registry, which ties it to the plugin's lifetime: a revert still
            // pending when Homebridge shuts down drains with the registry, and one scheduled after shutdown never fires.
            this.platform.timers.schedule(() => valveService.updateCharacteristic(this.hap.Characteristic.Active,
              setOn ? this.hap.Characteristic.Active.INACTIVE : this.hap.Characteristic.Active.ACTIVE), HYDRAWISE_REVERT_DELAY);

            return;
          }

          // Update our valve state accordingly.
          if(setOn) {

            valveService.updateCharacteristic(this.hap.Characteristic.InUse, this.hap.Characteristic.InUse.IN_USE);
            valveService.updateCharacteristic(this.hap.Characteristic.RemainingDuration, duration);
            irrigationSystemService?.updateCharacteristic(this.hap.Characteristic.ProgramMode, this.hap.Characteristic.ProgramMode.PROGRAM_SCHEDULED_MANUAL_MODE);
            irrigationSystemService?.updateCharacteristic(this.hap.Characteristic.InUse, this.hap.Characteristic.InUse.IN_USE);

            // Mark this zone as manually activated. The ledger is addressed by relay id at invocation time rather than through an entry captured when this
            // handler was registered, so it always acts on the current entry, and a zone with no entry is the no-op the ledger states.
            this.zoneHints.markManual(zone.relay_id);
          } else {

            valveService.updateCharacteristic(this.hap.Characteristic.RemainingDuration, 0);
            valveService.updateCharacteristic(this.hap.Characteristic.InUse, this.hap.Characteristic.InUse.NOT_IN_USE);

            // Clear out the manual activation for this zone, addressed by relay id at invocation time for the same reason the mark above is.
            this.zoneHints.clearManual(zone.relay_id);

            // No more manually activated zones among the enabled set, we can resume our schedule. We consult the instance state at invocation time so this
            // handler always acts on the current poll's enabled zones.
            if(!this.enabledZones.some(x => this.zoneHints.get(x.relay_id)?.isManual)) {

              irrigationSystemService?.updateCharacteristic(this.hap.Characteristic.ProgramMode, this.hap.Characteristic.ProgramMode.PROGRAM_SCHEDULED);
            }

            // If this was the only enabled zone currently running on the irrigation controller, let's set the system state to no longer in use.
            if(!this.enabledZones.some(x => (x.time === 1) && (x.relay_id !== zone.relay_id))) {

              irrigationSystemService?.updateCharacteristic(this.hap.Characteristic.InUse, this.hap.Characteristic.InUse.NOT_IN_USE);
            }
          }

          this.log.info("%s: Manually %s%s.", this.zoneLabel(zone, valveService), setOn ? "started" : "stopped",
            setOn ? " (duration: " + this.getMinutes(duration) + ")" : "");
        });
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

        // Set the duration of the next run of this valve, in seconds, in HomeKit based on the Hydrawise scheduled runtime, capped at HomeKit's own SetDuration
        // maximum.
        valveService.updateCharacteristic(this.hap.Characteristic.SetDuration, Math.min(duration, HAP_DURATION_CEILING));
      }

      // Active represents whether the zone is ready to be activated - meaning it's queued to turn on imminently or is currently on.
      if((zone.time > 0) && (zone.time <= HYDRAWISE_ACTIVE_ZONE_INDICATOR)) {

        valveService.updateCharacteristic(this.hap.Characteristic.Active, this.hap.Characteristic.Active.ACTIVE);
        this.log.debug("Setting %s as active.", this.zoneLabel(zone, valveService));
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

          this.log.info("%s: %s %s", this.zoneLabel(zone, valveService), hints.isOn ? "Started" : "Stopped.",
            hints.isOn ? "(duration: " + this.getMinutes(zone.run) + ")." : this.zoneStatus(zone, state));
        }

        // Inform the user if the zone has been stopped due to a rain sensor.
        if(isStopped !== hints.isStopped) {

          this.log.info("%s: Rain sensor is %s irrigation.", this.zoneLabel(zone, valveService), isStopped ? "stopping" : "allowing");
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
     * destroy it.
     */
    for(const suspendHost of new Set<HydrawiseAccessory>([ this.accessory, ...this.zoneHosts.values() ])) {

      for(const service of suspendHost.services.filter(x => (x.UUID === this.hap.Service.Switch.UUID) && isSuspendZoneSubtype(x.subtype))) {

        if(suspendHosts.get(service.subtype ?? "") !== suspendHost) {

          suspendHost.removeService(service);
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
  }

  /* Establish, name, and bind one zone's companion suspension switch on whichever accessory now hosts that zone.
   *
   * The switch exists only where the account credentials do, because the key-based API has no per-zone suspend to offer: its one suspend command carries no zone
   * parameter at all and acts on the whole controller, so a switch built on it would render and resolve while doing something else entirely.
   *
   * @param options               - This zone's pass.
   * @param options.effectiveName - The zone's effective display name, which the switch's own name is composed from.
   * @param options.facts         - The account-credentialed facts this pass resolved, or null when there are none to trust.
   * @param options.host          - The accessory hosting this zone's valve, and therefore its switch.
   * @param options.isFirstRun    - Whether this is the controller's first completed poll, which is half the establishment gate.
   * @param options.sanitizedName - The zone's effective name in its sanitized form, which the rename gate compares and requires to be non-empty.
   * @param options.state         - The zone's classified schedule state, which the starting characteristic is written from.
   * @param options.syncName      - Whether this zone's names track the configured truth.
   * @param options.zone          - The wire zone.
   *
   * @returns The composed subtype of the switch this established, or null when the zone is to have none.
   */
  private configureZoneSuspendSwitch({ effectiveName, facts, host, isFirstRun, sanitizedName, state, syncName, zone }: { effectiveName: string;
    facts: Nullable<HydrawiseControllerFactsSnapshot>; host: HydrawiseAccessory; isFirstRun: boolean; sanitizedName: string;
    state: HydrawiseZoneScheduleStatus | undefined; syncName: boolean; zone: HydrawiseZoneConfig; }): Nullable<string> {

    if(!this.platform.hasV2Client || !this.hasZoneFeature("Device.Suspend.Zone", zone.relay_id.toString())) {

      return null;
    }

    const name = effectiveName + " Suspend";
    const subtype = suspendZoneSubtype(zone.relay_id);
    const { service, transition } = acquireService({ accessory: host, name, serviceType: this.hap.Service.Switch, subtype });

    /* The switch's name tracks its zone's on every poll, under the gate the valve answers to, so a Hydrawise rename reaches the companion rather than stranding it
     * under a name the zone no longer carries. The emptiness half of that gate is asked of the ZONE's own sanitized name rather than of the composed one: the
     * composed name inherits its non-emptiness from the zone half, so a zone whose name sanitizes to nothing would otherwise rename its switch to the bare
     * suffix - a label naming no zone at all.
     */
    if((transition !== "attached") && syncName && sanitizedName.length && (getServiceName(service) !== sanitizeName(name))) {

      setServiceName(service, name);
    }

    /* Bind the handler under the establishment gate the valve uses - a first poll, or a service this pass created - so a warm restart, where the service returns
     * from the accessory cache and this process has never bound to it, binds exactly once.
     *
     * The starting state is written on that same gate rather than left to the projection tail, because the tail runs BEFORE this walk and so cannot have shown a
     * switch that did not yet exist. Every refresh after this one is the tail's, and it writes the same polarity: On means suspended.
     */
    if(isFirstRun || (transition === "attached")) {

      service.updateCharacteristic(this.hap.Characteristic.On, this.isZoneSuspended(zone.relay_id, state, facts));

      service.getCharacteristic(this.hap.Characteristic.On).onSet(async (value: CharacteristicValue): Promise<void> => {

        await this.commandZoneSuspension(zone, service, value);
      });
    }

    return subtype;
  }

  /* Command one zone's suspension from its companion switch and answer for it: the optimistic state the user is already looking at stands when the account accepts
   * the command, and goes back after a beat when it does not.
   *
   * The switch speaks its own name's language: turning it ON is what SUSPENDS the zone, which is the account-wide suspend switch's convention at the zone grain. A
   * zone's active state already lives on its valve, so a switch that commanded the other way would leave the user two controls disagreeing about one thing.
   *
   * A suspension runs to the same one-year horizon the account-wide suspend uses, through the same constant, because an open-ended suspension is what both commands
   * mean and Hydrawise expresses that as a distant instant.
   *
   * Nothing is read back afterward. The recurring refresh reconciles the optimistic state on its own cadence, and spending a call to confirm what the account has
   * just acknowledged would cost a slot the next command may need.
   */
  private async commandZoneSuspension(zone: HydrawiseZoneConfig, service: Service, value: CharacteristicValue): Promise<void> {

    // The instant the suspension lifts is sent to the account API, which reads it as wall-clock time, so it comes from the host's own clock rather than the
    // platform's.
    const until = value ? (Math.floor(Date.now() / 1000) + HYDRAWISE_SUSPEND_DURATION) : null;
    const result = await this.platform.setZoneSuspension({ until, zoneId: zone.relay_id });

    if(result.status === "done") {

      /* Stamp the command so a snapshot fetched before it cannot answer for this zone, on exactly the terms the account-wide stamp above works on. The direction
       * is stored with the instant, because while the command stands it is the command itself that says what to show.
       */
      this.zoneSuspendCommands.set(zone.relay_id, { at: Math.floor(this.platform.clock.now() / 1000), commandedUntil: until });

      /* Re-derive right here, so the projection every other surface reads carries this command at once rather than waiting on the next account refresh. The
       * webUI, the MQTT payload, and the log sentence all answer to that projection, and a quarter of an hour of them contradicting the switch the user just
       * pressed is the whole reason this call is here rather than at the next tick.
       */
      this.rederiveProjection();

      return;
    }

    // A shutdown reaching us mid-command is orderly teardown rather than a refusal, so the handler exits here, skipping both the sentence and the revert.
    if(this.platform.signal.aborted) {

      return;
    }

    this.log.error("%s: Unable to %s this zone. %s", this.zoneLabel(zone), until ? "suspend" : "resume", this.suspensionRefusal(result));

    // Put the switch back where it was after a brief beat, scheduled through the platform's registry exactly as every other revert on this controller is.
    this.platform.timers.schedule(() => service.updateCharacteristic(this.hap.Characteristic.On, !value), HYDRAWISE_REVERT_DELAY);
  }

  /* The sentence a refused per-zone suspension gives the operator, one per answer the platform can give, because they ask the user for different things: a paced
   * ceiling asks for a moment's patience, a refusal from Hydrawise asks them to look at the account, and a missing client says the enhanced features this switch
   * runs on are not configured at all.
   *
   * The failed arm serves BOTH ways a command can fail, because the reason it reads carries either - the account's own words when it refused in band, and the
   * transport's when the request did not land. Telling them apart here would be this layer knowing something it has no use for: what the user wants is the reason,
   * and the fallback covers only a failure already reported in its own words elsewhere.
   *
   * Every answer is named with no default arm, so an answer added to the union surfaces as a compile error rather than as a command silently reporting someone
   * else's reason.
   */
  private suspensionRefusal(result: Exclude<HydrawiseZoneSuspensionResult, { status: "done" }>): string {

    switch(result.status) {

      case "failed":

        return result.reason ?? "Hydrawise did not accept the command.";

      case "rejected":

        return "The Hydrawise account API is pacing requests right now, so the command was not sent. Please try again in a moment.";

      case "unavailable":

        return "Enhanced features are not configured.";
    }
  }

  // Send a command to the Hydrawise API.
  private async sendCommand(zone: HydrawiseZoneConfig, command: "run", duration: number): Promise<Nullable<Dispatcher.ResponseData<unknown>>>;
  private async sendCommand(zone: HydrawiseZoneConfig, command: "stop"): Promise<Nullable<Dispatcher.ResponseData<unknown>>>;
  private async sendCommand(command: "suspendall", duration: number): Promise<Nullable<Dispatcher.ResponseData<unknown>>>;
  private async sendCommand(zoneOrCmd: HydrawiseZoneConfig | "suspendall", cmdOrDur: (number | "run" | "stop"), duration?: number):
  Promise<Nullable<Dispatcher.ResponseData<unknown>>> {

    let command, zone;

    // We've been called as sendCommand("suspendall", duration).
    if(typeof zoneOrCmd === "string") {

      command = zoneOrCmd;
      duration = cmdOrDur as number;
    } else {

      // We've been called as sendCommand(zone, "run" | "stop", [duration]).
      zone = zoneOrCmd;
      command = cmdOrDur as "run" | "stop";
    }

    // User has queued us up...send the command to Hydrawise.
    const params: Record<string, string> = {};

    params["controller_id"] = this.controller.controller_id.toString();

    // If we've specified the zone, add it to our parameters.
    if(zone?.relay_id) {

      params["relay_id"] = zone.relay_id.toString();
    }

    switch(command) {

      case "run":

        params["action"] = "run";

        // A duration that is absent, not a finite number, or not positive is no command at all, whichever caller handed it over.
        if((typeof duration !== "number") || !Number.isFinite(duration) || (duration <= 0)) {

          return null;
        }

        params["custom"] = duration.toString();
        params["period_id"] = "999";

        break;

      case "stop":

        params["action"] = "stop";

        break;

      case "suspendall":

        params["action"] = "suspendall";

        if((typeof duration !== "number") || !Number.isFinite(duration) || (duration <= 0)) {

          return null;
        }

        params["custom"] = duration.toString();
        params["period_id"] = "999";

        // The current overload set never reaches this branch with a zone in hand - a suspendall call is always the zoneOrCmd-is-a-string branch above, so
        // params["relay_id"] was never set - but the delete stays as a safety net should a future signature change ever let one through.
        delete params["relay_id"];

        break;

      default:

        return null;
    }

    // Request the change in zone state.
    return this.platform.retrieve(HYDRAWISE_COMMAND_ENDPOINT, params);
  }

  /* Utility to return the status of a zone to a user. The sentence comes from the schedule classifier's own reading of this poll, which is the same reading the
   * persisted projection and the webUI display are built from, so a zone's log line and its displayed status can never tell different stories. Each arm then
   * composes its sentence from the wire fields the classifier already weighed.
   *
   * Every state the union declares is named here with no default arm, so a state added to the union surfaces as a compile error - a return path the analysis can
   * see falling off the end - rather than as a zone silently rendering someone else's sentence.
   */
  private zoneStatus(zone: HydrawiseZoneConfig, state: HydrawiseZoneScheduleStatus | undefined = zoneScheduleStatus(zone, this.status)): string {

    switch(state.state) {

      case "running":

        return "Currently running with " + this.getMinutes(zone.run) + " remaining.";

      case "scheduled":

        return "Next run will be " + (zone.timestr.includes(":") ? "at " + this.formatStartTime(zone.timestr) : "on " + zone.timestr) + " for " +
          this.getMinutes(zone.run) + ".";

      case "sensor-stopped":

        return "Rain sensor is preventing irrigation.";

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
    const now = new Date();
    const clock = when.toLocaleTimeString(undefined, { hour: "numeric", minute: "2-digit" });

    if(when.toDateString() === now.toDateString()) {

      return clock;
    }

    if(Math.abs(epochSeconds - Math.floor(now.getTime() / 1000)) < (7 * 24 * 60 * 60)) {

      return when.toLocaleDateString(undefined, { weekday: "short" }) + " " + clock;
    }

    return when.toLocaleDateString();
  }

  // Retrieve the current status from the Hydrawise API.
  private async getStatus(): Promise<void> {

    // Get our schedule for this controller.
    const params: Record<string, string> = {};

    params["controller_id"] = this.controller.controller_id.toString();

    const response = await this.platform.retrieve("statusschedule.php", params);

    // A null response is a recoverable API error (or a shutdown abort) that retrieve() already classified and logged. Throw so the retry loop waits and tries again;
    // on shutdown the loop unwinds through its own signal.
    if(!response) {

      throw new Error("Unable to retrieve the current status of the irrigation controller.");
    }

    try {

      // Parse the body into a local and validate its shape before adopting it as our status. A valid-JSON body with the wrong shape would otherwise pass the cast
      // and crash applyStatus outside every try/catch, tripping superviseLoop's terminal fault and stopping this controller's polling until a restart.
      const parsed = await response.body.json();

      if(!this.isStatusSchedule(parsed)) {

        throw new Error("The Hydrawise API returned a status body with an unexpected shape.");
      }

      this.status = parsed;

      this.log.debug("Status updated.");
      this.log.debug(util.inspect(this.status, { colors: true, depth: null, sorted: true }));
    } catch(error) {

      // A shutdown abort mid-read is orderly teardown - rethrow quietly so the retry loop unwinds without manufacturing a parse-failure error. A genuine parse or
      // shape failure throws so the retry loop waits and re-polls; the stale status is never republished as fresh.
      if(this.platform.signal.aborted) {

        throw error;
      }

      this.log.error("Unable to retrieve the current status of the irrigation controller: --%s--", util.inspect(error, { colors: true, depth: null, sorted: true }));

      throw new Error("Unable to retrieve the current status of the irrigation controller.");
    }
  }

  // Guard that a parsed status body carries the shape applyStatus relies on: relays and sensors arrays and a numeric nextpoll. A body that fails this check is
  // treated as a failed poll rather than being adopted as our status.
  private isStatusSchedule(value: unknown): value is StatusScheduleResponse {

    if((typeof value !== "object") || (value === null)) {

      return false;
    }

    const candidate = value as Partial<StatusScheduleResponse>;

    return Array.isArray(candidate.relays) && Array.isArray(candidate.sensors) && (typeof candidate.nextpoll === "number");
  }

  /* Write the reported zone roster to the accessory context when it changed since the last poll, and report whether it wrote. We project every reported zone to the
   * identity-only shape, naming each field explicitly rather than spreading the wire zone, ordered by relay for a stable comparison. The comparison is field-wise
   * because the projection is a fresh array every poll, so a reference check would differ every time and write on every poll. A rare single-poll flap that flips a
   * field and back across two polls costs two writes, which we accept - roster changes are rare and a write is cheap.
   *
   * The return value is the change signal the applyStatus chokepoint reads: this method persists to the context but never flushes, because the chokepoint is the one
   * consumer that turns any projection's change into the poll's single cache write. A future caller that discards the signal forfeits that write, and the fresh-seed
   * cadence assertion fails when it does, since the seed's flush would never land.
   */
  private persistZoneRoster(facts: Nullable<HydrawiseControllerFactsSnapshot>): boolean {

    const zones = this.status.relays.map(zone => ({ ...zoneIdentity(zone), name: this.zoneName(zone, facts) })).sort((a, b) => a.relay - b.relay);

    // After configureDevice's seed the context always carries a zones array, so the nullish fallback is a defensive floor for a context that predates the seed rather
    // than an expected path.
    if(sameEntries(this.accessory.context.zones ?? [], zones, sameZoneIdentity)) {

      return false;
    }

    this.accessory.context.zones = zones;

    return true;
  }

  /* Write the schedule projection to the accessory context when it changed since the last poll, and report whether it wrote - the roster's discipline above applied
   * to the volatile half of what this accessory persists. The projection stores absolute instants, so an unchanged schedule projects byte-identically poll after
   * poll and the comparison takes the no-change return; a projection compared before any has been persisted is a change by definition and seeds the context.
   *
   * This is where the witnesses meet. The commands map is composed from the per-zone records this pass has already swept, so every entry in it is standing
   * by construction and the classifier is handed direction alone - one place decides what still stands, and one classification weighs it against the wire and the
   * account's own facts. Composing here rather than overlaying at each consumer is what keeps the webUI, MQTT, the log, and the switches reading one answer.
   *
   * Like the roster it never flushes, and the applyStatus chokepoint is the single consumer of the signal it returns.
   */
  private persistScheduleStatus(facts: Nullable<HydrawiseControllerFactsSnapshot>): boolean {

    const previous = this.accessory.context.schedule;
    const commands = new Map<number, Nullable<number>>([...this.zoneSuspendCommands].map(([ relayId, command ]) => [ relayId, command.commandedUntil ]));
    const schedule = scheduleStatus(this.status, HYDRAWISE_ACTIVE_ZONE_INDICATOR, { commands, facts: facts ?? undefined,
      priorSuspended: this.priorSuspended(previous) });

    if(previous && sameScheduleStatus(previous, schedule)) {

      return false;
    }

    this.accessory.context.schedule = schedule;

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

  /* Utility for reading a zone-scoped value option. The zone id goes in the device position ALONE, and an unset, empty, or whitespace-only value normalizes to
   * undefined so callers can default with ??.
   *
   * Presenting exactly one id is the rule every value reader keeps, and here it is what makes a controller-level entry unreachable from a zone's read: the Name
   * option resolves at the controller as well as the zone, so a read that also presented the serial would answer a zone with its controller's name whenever the
   * zone had no entry of its own. A probe against the real engine records both polarities - the serial-bearing read resolves the controller's entry, the
   * serial-free read does not - and the pair is why the argument is absent rather than merely unused.
   */
  private zoneNameOverride(option: HydrawiseZoneValueOption, zoneId: string): string | undefined {

    const name = this.platform.featureOptions.value(option, zoneId)?.trim();

    return name?.length ? name : undefined;
  }

  // Utility for reading a controller-scoped value option, on the same single-id terms and with the same normalization. The serial goes in the device position,
  // because the controller row writes its own entry there and the engine's storage keys are flat, so this is the read that resolves the row's own value.
  private controllerNameOverride(option: HydrawiseControllerValueOption): string | undefined {

    const name = this.platform.featureOptions.value(option, this.controller.serial_number)?.trim();

    return name?.length ? name : undefined;
  }

  /* The label a zone's log lines carry: the configured name of its valve where one exists, the name Hydrawise reports otherwise, and the zone number the operator
   * sees on the controller itself.
   *
   * Every cadence that narrates a zone composes through here, which is what makes their lines read identically. The poll walk already holds the valve service and
   * hands it over; the refresh tail holds only the wire zone, so it lets this look the service up on the controller's own accessory - a zone promoted onto a
   * standalone accessory is not found there and falls back to its wire name, which is a truthful label rather than a wrong one.
   */
  private zoneLabel(zone: HydrawiseZoneConfig, service?: Service): string {

    const valve = service ?? this.accessory.getServiceById(this.hap.Service.Valve, zone.relay_id.toString());

    return ((valve?.getCharacteristic(this.hap.Characteristic.ConfiguredName).value as string | undefined) ?? zone.name) + " [Zone " + zone.relay.toString() + "]";
  }

  /* Whether the account reads as fully suspended, which is what drives the suspend-all switch's state. Answers in precedence, the account-grain twin of the
   * per-zone reader above and deliberately the same shape: one reader pattern at both grains, both consulting the one standing judgment.
   *
   * A STANDING COMMAND answers first, and its direction is the answer. This is the arm that cannot be replaced by reading composed state, for the same reason the
   * zone reader's cannot: the projection is re-derived inside the command's own handler, from a poll snapshot taken before the account accepted anything, so a
   * reader that consulted only that composition would flip the switch straight back off under the user's finger.
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

    const command = this.suspendAllCommand;

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

  // Utility function to return the name of this controller.
  private get name(): string {

    // We use the irrigation system service as the natural proxy for the name, read through the library's name reader, which prefers a name the user configured
    // in the Home app over the service's own.
    const name = getServiceName(this.accessory.getService(this.hap.Service.IrrigationSystem));

    // If we don't have a name for the irrigation system service, return the controller name from Hydrawise.
    return name?.length ? name : this.controller.name;
  }

  // Utility function to return the current accessory name of this device, read through the same name reader from the accessory information service.
  private get accessoryName(): string {

    return getServiceName(this.accessory.getService(this.hap.Service.AccessoryInformation)) ?? this.controller.name;
  }
}
