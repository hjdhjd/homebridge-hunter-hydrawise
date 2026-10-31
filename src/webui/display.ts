/* Copyright(C) 2017-2026, HJD (https://github.com/hjdhjd). All rights reserved.
 *
 * webui/display.ts: Pure derivations of the Hydrawise schedule display and the device panel's stat strips, and the accessory-cache readers that recover the names
 * and the hardware HomeKit last showed.
 */
import type { HydrawiseControllerHardware, HydrawiseScheduleStatus, HydrawiseZoneScheduleState, HydrawiseZoneScheduleStatus } from "../types.ts";
import type { HOMEBRIDGE_UNKNOWN_FIRMWARE } from "../settings.ts";

/* The pure display tier: every export derives presentation from what the caller hands it - the persisted schedule facts and an instant, a serialized cached
 * accessory, or a device row's identity - with no I/O, no DOM, no global reach, and no value imports. That is what lets a plain test import this module directly,
 * while ui.mjs renders every schedule surface and every stat strip from these same derivations rather than deriving anything of its own.
 */

/**
 * The display vocabulary: every persisted state, plus the imminent-run split the display alone makes. A scheduled run falling inside the projection's active
 * window reads as starting soon and one beyond it as merely scheduled, so the display carries one more word than the wire does.
 */
export type HydrawiseZoneDisplayState = HydrawiseZoneScheduleState | "starting-soon";

/**
 * The projection's own scalar facts, which a zone row carries beside its single entry: the window the runtime marks a valve active within, and the wire instant
 * the facts were last changed at.
 */
export type HydrawiseScheduleMeta = Pick<HydrawiseScheduleStatus, "activeWindowSeconds" | "asOf">;

/**
 * One rendered row, as its label and the value shown beside it.
 */
export type HydrawiseDisplayRow = [ label: string, value: string ];

/**
 * One cell of a stat strip, as its label, its value, and whether the value reads in the monospace face. The controller's strip and the zone's strip share this
 * one shape, so the renderer maps every strip to its elements the same way.
 */
export interface HydrawiseStripRow {

  label: string;
  monospace: boolean;
  value: string;
}

/**
 * A serialized cached service as the accessory cache carries it, reduced to the fields the cache readers consult.
 */
export interface HydrawiseCachedService {

  characteristics?: { constructorName?: string; value?: unknown }[];
  constructorName?: string;
  subtype?: string;
}

/**
 * A serialized cached accessory as the accessory cache carries it, reduced to its services.
 */
export interface HydrawiseCachedAccessory {

  services?: HydrawiseCachedService[];
}

/**
 * What one derivation renders: the rows to show, and whether the facts behind them are old enough that the display says so.
 */
export interface HydrawiseDisplayRendering {

  rows: HydrawiseDisplayRow[];
  stale: boolean;
}

/**
 * What a controller's fold renders: its one status word, the detail rows beneath it, and whether the facts behind them are old enough that the display says so.
 *
 * The word travels apart from the rows because the two are drawn in different places - the word in the panel's stat strip beside the controller's identity, the
 * rows in the detail below it - and composing that layout is the renderer's job. A controller with no projection, or one naming no zone at all, has no status to
 * report and answers `null`.
 */
export interface HydrawiseControllerRendering {

  detail: HydrawiseDisplayRow[];
  stale: boolean;
  status: string | null;
}

/**
 * The word each zone schedule state is shown as, shared by every surface that describes a zone. The sidebar dot's tooltip, the zone panel's Status row, and the
 * controller fold's own status all read from here, so no two of those surfaces can describe the same state with different words.
 *
 * The suspended word is shown only where the runtime actually claimed suspension, which it does only on an account-credentialed install: the key-based wire gives a
 * suspended zone and a zone merely between runs identical bodies, so the runtime never guesses at the difference.
 *
 * The unscheduled word therefore claims exactly what remains - no upcoming run - and goes on covering a suspended zone wherever nothing could tell the two apart.
 */
export const ZONE_STATE_LABELS: Record<HydrawiseZoneDisplayState, string> = { running: "Running", scheduled: "Scheduled", "sensor-stopped": "Rain delay",
  "starting-soon": "Starting soon", suspended: "Suspended", unscheduled: "Not scheduled" };

/**
 * How far in seconds a schedule instant may sit in the past before the display says so. A live runtime would have transitioned a zone whose next run or whose end
 * instant has passed, so an instant still standing well after it is evidence that nothing is polling. Ten nominal poll intervals is generous enough that a
 * nextpoll excursion or a few minutes of clock skew never false-alarms, and tight enough that a dead runtime surfaces within minutes.
 *
 * This threshold is presentation policy - how patient the display chooses to be - which is why it lives here, while the active-zone window, which is runtime policy
 * the Home app enforces too, travels with the data instead.
 */
export const STALE_GRACE = 600;

/**
 * Render a span in whole minutes with its plural marker, matching the runtime's own duration wording so the Homebridge log and this panel describe the same span
 * the same way. A span that has already elapsed floors at zero rather than reading as a negative countdown.
 *
 * @param seconds - The span to render, which floors at zero when it has already elapsed.
 *
 * @returns The rendered span.
 */
export const formatMinutes = (seconds: number): string => {

  const minutes = Math.max(Math.round(seconds / 60), 0);

  return minutes.toString() + " minute" + ((minutes !== 1) ? "s" : "");
};

/**
 * Render an absolute instant for a reader in THIS BROWSER's timezone, in escalating tiers of precision: the clock time alone when it falls on the same calendar
 * day as the render, a short weekday when it falls within a week of the render in either direction, and a locale date beyond that week, where a weekday alone
 * would name a day months away - ahead or behind - as though it were this one.
 * The runtime's own log line renders the wire's controller-local start string instead, so the two surfaces can legitimately differ for a user viewing from another
 * timezone - the epoch is the truth and each surface renders it honestly for its own reader.
 *
 * The locale-date tier also serves the suspension instant, which routinely sits years out, and it is an extension of this formatter rather than a sibling beside
 * it: the same-day and within-a-week tiers are already exactly what a suspension needs, and a second formatter restating them would split the display tier's one
 * date policy in two.
 *
 * @param epochSeconds - The instant to render.
 * @param nowSeconds   - The instant the render answers to, which decides which tier applies.
 *
 * @returns The rendered instant.
 */
export const formatRunTime = (epochSeconds: number, nowSeconds: number): string => {

  const when = new Date(epochSeconds * 1000);
  const clock = when.toLocaleTimeString(undefined, { hour: "numeric", minute: "2-digit" });

  if(when.toDateString() === new Date(nowSeconds * 1000).toDateString()) {

    return clock;
  }

  if(Math.abs(epochSeconds - nowSeconds) < (7 * 24 * 60 * 60)) {

    return when.toLocaleDateString(undefined, { weekday: "short" }) + " " + clock;
  }

  return when.toLocaleDateString();
};

/* Classify one zone's persisted schedule entry into the display state it reads as - the one answer the sidebar dot, the zone panel, the zone's own rows and the
 * controller fold's imminent-run test all read, so a dot, the panel beside it and the controller above it can never disagree about what a zone is doing. Every
 * entry has a state to show, an unfamiliar one reading as unscheduled.
 *
 * The wire's scheduled state splits in two here: a run inside the window the runtime marks a valve active on reads as imminent, and one beyond it as merely
 * scheduled. That window travels with the projection rather than being hardcoded here, so this and the Home app agree on when a zone counts as imminent.
 */
const classifyZone = (entry: HydrawiseZoneScheduleStatus, meta: HydrawiseScheduleMeta | undefined, nowSeconds: number): HydrawiseZoneDisplayState => {

  switch(entry.state) {

    case "running":

      return "running";

    case "scheduled":

      return ((entry.nextRunAt - nowSeconds) <= (meta?.activeWindowSeconds ?? 0)) ? "starting-soon" : "scheduled";

    case "sensor-stopped":

      return "sensor-stopped";

    case "suspended":

      return "suspended";

    default:

      return "unscheduled";
  }
};

/* Whether one zone's persisted schedule entry is old enough that the display says so - the one staleness rule the zone panel and the controller fold read,
 * so a zone and the controller above it can never disagree about whether the facts behind them are current. Every entry carrying an instant a live runtime
 * would have acted on by now can age - a run's end, a run's start, and a suspension's end alike - and each ages against the grace above.
 */
const isStale = (entry: HydrawiseZoneScheduleStatus, nowSeconds: number): boolean => {

  switch(entry.state) {

    case "running":

      // A running zone whose end instant has passed by more than the grace is evidence of a dead runtime: a live one would have reported the zone stopped.
      return (nowSeconds - entry.endsAt) > STALE_GRACE;

    case "scheduled":

      // A scheduled run whose start instant has passed by more than the grace is the same evidence: a live runtime would have reported the zone running.
      return (nowSeconds - entry.nextRunAt) > STALE_GRACE;

    case "suspended":

      // A standing suspension is the state itself, while one whose end instant has passed by more than the grace is evidence that nothing is polling: a live
      // runtime would have reported the suspension ended.
      return (nowSeconds - entry.until) > STALE_GRACE;

    default:

      // Rain delay and the unscheduled state carry no instant to age against, so neither is ever stale.
      return false;
  }
};

/**
 * The display state a zone reads as, or null for a zone the projection does not name, which is what a legacy cache and a zone the runtime has not yet reported
 * both look like.
 *
 * @param entry      - The zone's persisted entry, or `undefined` when the projection does not name it.
 * @param meta       - The projection's scalar facts, or `undefined` when none travel with the entry.
 * @param nowSeconds - The instant the classification answers to.
 *
 * @returns The display state, or `null` for a zone with no state to show.
 */
export const zoneScheduleState = (entry: HydrawiseZoneScheduleStatus | undefined, meta: HydrawiseScheduleMeta | undefined,
  nowSeconds: number): HydrawiseZoneDisplayState | null => (entry ? classifyZone(entry, meta, nowSeconds) : null);

/**
 * Derive one zone's schedule rows and its staleness verdict from its persisted entry, at the render pass's shared instant so every row of a pass answers to the
 * same "now". Every presentation decision lives here and nothing derived is ever persisted, which is what keeps a panel from disagreeing with its own inputs: the
 * running countdown, the next-run instant, and the staleness verdict are all computed from stored facts at the moment they are shown, and the status word and
 * the verdict themselves come from the shared classification, vocabulary and staleness rule rather than being decided again here, so the rows below branch on
 * the entry's own state for its facts alone.
 *
 * A zone with no state at all renders no schedule rows.
 *
 * @param entry      - The zone's persisted entry, or `undefined` when the projection does not name it.
 * @param meta       - The projection's scalar facts, or `undefined` when none travel with the entry.
 * @param nowSeconds - The instant every row of the pass answers to.
 *
 * @returns The zone's rendering.
 */
export const deriveZoneDisplay = (entry: HydrawiseZoneScheduleStatus | undefined, meta: HydrawiseScheduleMeta | undefined,
  nowSeconds: number): HydrawiseDisplayRendering => {

  if(!entry) {

    return { rows: [], stale: false };
  }

  const status: HydrawiseDisplayRow = [ "Status", ZONE_STATE_LABELS[classifyZone(entry, meta, nowSeconds)] ];
  const stale = isStale(entry, nowSeconds);

  switch(entry.state) {

    case "running":

      return { rows: [ status, [ "Time Remaining", formatMinutes(entry.endsAt - nowSeconds) ] ], stale };

    case "scheduled":

      // A scheduled entry reads as imminent or as merely scheduled, and the rows beneath that word describe the same upcoming run whichever it is, so one arm
      // renders every scheduled entry.
      return { rows: [ status, [ "Next Run", formatRunTime(entry.nextRunAt, nowSeconds) ], [ "Duration", formatMinutes(entry.durationSeconds) ] ], stale };

    case "suspended":

      // A suspension carries the instant it lifts, which routinely sits years out and so exercises the formatter's date tier.
      return { rows: [ status, [ "Until", formatRunTime(entry.until, nowSeconds) ] ], stale };

    default:

      // Rain delay and the unscheduled state carry no facts beyond the word itself, so the status row is the whole display.
      return { rows: [status], stale };
  }
};

/**
 * Fold a controller's whole projection into separate facts: ONE WORD for what the controller is doing, and the detail rows beneath it - the zones actually
 * watering, and the next zone due. This is a pure read of the same persisted entries the zone panels read, through the same classification and staleness rule
 * and at the same shared instant, so the controller panel and its zones can never tell different stories.
 *
 * The status word is handed back apart from the rows rather than as the first of them, because the two are presented differently: the word belongs in the panel's
 * stat strip alongside the controller's identity, and the rows belong in the detail beneath it. Composing that layout is the renderer's job, so this tier answers
 * with the facts and takes no view on where either one is drawn.
 *
 * A projection that is absent OR names no zone at all has no status to report and no rows to draw, deliberately: an account with no zones is not an account with
 * nothing scheduled, and folding an empty set to "Not scheduled" would say exactly that.
 *
 * @param schedule   - The controller's persisted projection, or `undefined` when it has none.
 * @param zoneNames  - The display name of each zone, keyed by relay id, for the zones that have one.
 * @param nowSeconds - The instant every row of the pass answers to.
 *
 * @returns The controller's rendering.
 */
export const deriveControllerDisplay = (schedule: HydrawiseScheduleStatus | undefined, zoneNames: Record<string, string> | undefined,
  nowSeconds: number): HydrawiseControllerRendering => {

  if(!schedule?.zones.length) {

    return { detail: [], stale: false, status: null };
  }

  const running = schedule.zones.filter((zone) => zone.state === "running").toSorted((a, b) => a.relayId - b.relayId);
  const scheduled = schedule.zones.filter((zone) => zone.state === "scheduled");
  const soon = scheduled.filter((zone) => classifyZone(zone, schedule, nowSeconds) === "starting-soon");
  const nextUp = scheduled.reduce<Extract<HydrawiseZoneScheduleStatus, { state: "scheduled" }> | null>(
    (earliest, zone) => (!earliest || (zone.nextRunAt < earliest.nextRunAt)) ? zone : earliest, null);
  const nameOf = (zone: HydrawiseZoneScheduleStatus): string => zoneNames?.[zone.relayId.toString()] ?? zone.relayId.toString();
  const detail: HydrawiseDisplayRow[] = [];

  /* The fold's own status word. Every arm that names a zone state reads its word from the shared vocabulary, so a controller and the zones beneath it always use
   * the same words; "Offline" and "Watering" are the fold's own summaries - one of a controller Hydrawise cannot currently reach, the other of an account with
   * water flowing - and neither is any single zone's state, so both stay words of their own.
   *
   * Reachability leads because it reframes everything under it: a schedule read off a controller that is not answering describes what WOULD happen, and saying so
   * first is more honest than leading with a plan nothing is currently carrying out. It appears only where the projection carries the fact at all, which is only
   * on an account-credentialed install.
   *
   * The suspended arm sits below the rain delay deliberately. Both are reasons irrigation is being held back, and an account with any zone rain-stopped has the
   * more immediate one to report; an account that is simply suspended has no sensor-stopped zone at all, so it reaches its own word.
   */
  let status: string;

  if(schedule.online === false) {

    status = "Offline";
  } else if(running.length) {

    status = "Watering";
  } else if(soon.length) {

    status = ZONE_STATE_LABELS["starting-soon"];
  } else if(scheduled.length) {

    status = ZONE_STATE_LABELS.scheduled;
  } else if(schedule.zones.some((zone) => zone.state === "sensor-stopped")) {

    status = ZONE_STATE_LABELS["sensor-stopped"];
  } else if(schedule.zones.some((zone) => zone.state === "suspended")) {

    status = ZONE_STATE_LABELS.suspended;
  } else {

    status = ZONE_STATE_LABELS.unscheduled;
  }

  // Every running zone is named, not just the first: the runtime genuinely runs zones concurrently, so a single-zone row would hide water that is flowing.
  if(running.length) {

    detail.push([ "Now Running", running.map((zone) => nameOf(zone) + " (" + formatMinutes(zone.endsAt - nowSeconds) + ")").join(", ") ]);
  }

  if(nextUp) {

    detail.push([ "Next Zone", nameOf(nextUp) + " at " + formatRunTime(nextUp.nextRunAt, nowSeconds) ]);
  }

  return { detail, stale: schedule.zones.some((zone) => isStale(zone, nowSeconds)), status };
};

/**
 * One non-empty string characteristic value off a serialized cached service, located by the constructor name Homebridge serializes alongside it. Every reader of
 * the accessory cache goes through here, so what counts as a usable value - present, a string, and not empty - is decided once rather than at each site.
 *
 * @param service         - The cached service, or `undefined` when the accessory carries none of the kind asked for.
 * @param constructorName - The characteristic's constructor name.
 *
 * @returns The value, or `undefined` when it is absent, not a string, or empty.
 */
export const cachedCharacteristic = (service: HydrawiseCachedService | undefined, constructorName: string): string | undefined => {

  if(!Array.isArray(service?.characteristics)) {

    return undefined;
  }

  const value = service.characteristics.find((characteristic) => characteristic.constructorName === constructorName)?.value;

  return ((typeof value === "string") && value.length) ? value : undefined;
};

// The cached AccessoryInformation service, located by the constructor name Homebridge serializes alongside it. Every reader of a tile's cached facts, its name and
// a controller's hardware among them, reads the service through here, so the lookup lives once.
const cachedInformationService = (accessory: HydrawiseCachedAccessory | undefined): HydrawiseCachedService | undefined => {

  return accessory?.services?.find((entry) => entry.constructorName === "AccessoryInformation");
};

// The name a cached service shows the user. ConfiguredName is the name a rename in the Home app writes and the one HomeKit shows, so it takes precedence over
// Name, matching how the plugin's own service helpers read a service's name.
const cachedServiceName = (service: HydrawiseCachedService | undefined): string | undefined => {

  return cachedCharacteristic(service, "ConfiguredName") ?? cachedCharacteristic(service, "Name");
};

/* The firmware value Homebridge stamps on an accessory whose real version nothing has ever written. The runtime writes this same marker back whenever the account
 * credentials are absent, which is what makes it the honest signal that no hardware facts have landed - mirrored here as a literal because this browser module
 * imports no values, and tied to the runtime's own constant at compile time by its type.
 */
const UNKNOWN_FIRMWARE: typeof HOMEBRIDGE_UNKNOWN_FIRMWARE = "0";

/**
 * The controller hardware HomeKit last showed, read from the cached AccessoryInformation service, or undefined when no real facts have landed.
 *
 * The pair is all-or-nothing on purpose. An unenriched controller still carries a model - the runtime stamps a product-line placeholder so the Home app never
 * shows a library-internal string - so the model alone cannot say whether anything was learned. The firmware can: it holds the unknown marker until a real
 * account answer replaces it. So the firmware decides, and the two render together or not at all, which is what keeps the strip from pairing a real model with an
 * empty firmware cell.
 *
 * @param accessory - The cached controller accessory, or `undefined` when none is cached.
 *
 * @returns The hardware, or `undefined` when no real facts have landed.
 */
export const cachedControllerHardware = (accessory: HydrawiseCachedAccessory | undefined): HydrawiseControllerHardware | undefined => {

  const service = cachedInformationService(accessory);
  const firmware = cachedCharacteristic(service, "FirmwareRevision");
  const model = cachedCharacteristic(service, "Model");

  if(!firmware || (firmware === UNKNOWN_FIRMWARE) || !model) {

    return undefined;
  }

  return { firmware, model };
};

/**
 * The name HomeKit last showed for a zone's valve, read from the cached accessory hosting it. The valve is located the way the framework's own cache reader
 * locates a service - by the constructor name Homebridge serializes alongside it - narrowed by the subtype the runtime keys each valve on, which is the zone's
 * relay id.
 *
 * This is the LAST-FLUSHED name, not a live mirror: Homebridge rewrites the accessory cache when an accessory is registered, updated, or unregistered, never on a
 * bare characteristic write. Where a Name option is set, or name synchronization is enabled, the plugin keeps each valve at its effective name, saving each
 * rename a poll makes and putting a rename made in the Home app back before any write of the cache could carry it, a restore being a rename the plugin does not
 * save, so this tracks that name closely. Where neither holds, a rename made in the Home app can sit here unsaved until the next write of the cache.
 *
 * @param accessory - The cached accessory hosting the valve, or `undefined` when none is cached.
 * @param relayId   - The zone's relay id.
 *
 * @returns The name, or `undefined` when no valve for the zone, or neither of its name characteristics, is cached.
 */
export const cachedValveName = (accessory: HydrawiseCachedAccessory | undefined, relayId: number): string | undefined => {

  return cachedServiceName(accessory?.services?.find((entry) => (entry.constructorName === "Valve") && (entry.subtype === relayId.toString())));
};

/**
 * The name HomeKit last showed for an accessory's tile, read from its cached AccessoryInformation service on the same last-flushed terms a valve's name is read.
 * The controller's setup gives every information service it configures the ConfiguredName a rename in the Home app writes, so where the user owns the name,
 * their rename reaches here with the next write of the cache; an accessory whose information service carries Name alone reads that.
 *
 * @param accessory - The cached accessory, or `undefined` when none is cached.
 *
 * @returns The name, or `undefined` when no information service, or neither of its name characteristics, is cached.
 */
export const cachedAccessoryName = (accessory: HydrawiseCachedAccessory | undefined): string | undefined => {

  return cachedServiceName(cachedInformationService(accessory));
};

/**
 * The cells of a controller's stat strip, in the order the panel shows them, each as its label, its value, and whether the value reads in the monospace face. The
 * hardware cells lead when real facts have landed and are absent otherwise, so an install running on the API key alone shows a shorter strip rather than
 * placeholder cells that would claim knowledge the plugin does not have. The zone count is shown only when it is known, because a zero would read as a controller
 * with no zones, and the status word only when the fold has one to report. The identifiers - the serial and the firmware - read in the monospace face.
 *
 * @param options              - The controller row's identity and state.
 * @param options.hardware     - The hardware HomeKit last showed, or `undefined` when no real facts have landed.
 * @param options.serialNumber - The controller's serial number.
 * @param options.status       - The fold's status word, or `null` when it has none to report.
 * @param options.zoneCount    - The number of zones, or `undefined` when it is not known.
 *
 * @returns The strip's rows.
 */
export const deriveControllerStrip = ({ hardware, serialNumber, status, zoneCount }: { hardware: HydrawiseControllerHardware | undefined; serialNumber: string;
  status: string | null; zoneCount: number | undefined; }): HydrawiseStripRow[] => {

  const rows: HydrawiseStripRow[] = [];

  if(hardware) {

    rows.push({ label: "Model", monospace: false, value: hardware.model });
  }

  rows.push({ label: "Serial Number", monospace: true, value: serialNumber });

  if(hardware) {

    rows.push({ label: "Firmware", monospace: true, value: hardware.firmware });
  }

  if(zoneCount !== undefined) {

    rows.push({ label: "Zones", monospace: false, value: zoneCount.toString() });
  }

  if(status !== null) {

    rows.push({ label: "Status", monospace: false, value: status });
  }

  return rows;
};

/**
 * The cells of a zone's stat strip, in the same row shape as the controller's: its display relay number, then its relay id, an identifier read in the monospace
 * face. A value the row does not carry renders as an empty cell rather than as the word "undefined".
 *
 * @param options         - The zone row's identity.
 * @param options.relay   - The zone's display relay number, or `undefined` when the row carries none.
 * @param options.relayId - The zone's relay id, or `undefined` when the row carries none.
 *
 * @returns The strip's rows.
 */
export const deriveZoneStrip = ({ relay, relayId }: { relay: number | undefined; relayId: number | undefined }): HydrawiseStripRow[] => [
  { label: "Zone", monospace: false, value: (relay ?? "").toString() }, { label: "Relay ID", monospace: true, value: (relayId ?? "").toString() } ];
