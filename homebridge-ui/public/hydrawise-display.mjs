/* Copyright(C) 2017-2026, HJD (https://github.com/hjdhjd). All rights reserved.
 *
 * hydrawise-display.mjs: Pure derivations of the Hydrawise schedule display and the device panel's stat strips.
 */
"use strict";

/* The pure display tier: every export derives presentation from what the caller hands it - the persisted schedule facts and an instant, a serialized cached
 * accessory, or a device row's identity - with no I/O, no DOM, no global reach, and no imports. That is what lets a plain test import this module directly, while
 * ui.mjs renders every schedule surface and every stat strip from these same derivations rather than deriving anything of its own.
 */

/* The word each zone schedule state is shown as, in one place. The sidebar dot's tooltip, the zone panel's Status row, and the controller fold's own status all read
 * from here, so no two of those surfaces can describe the same state with different words.
 *
 * The suspended word is shown only where the runtime actually claimed suspension, which it does only on an account-credentialed install: the key-based wire gives a
 * suspended zone and a zone merely between runs identical bodies, so the runtime never guesses at the difference.
 *
 * The unscheduled word therefore claims exactly what remains - no upcoming run - and goes on covering a suspended zone wherever nothing could tell the two apart.
 */
export const ZONE_STATE_LABELS = { running: "Running", scheduled: "Scheduled", "sensor-stopped": "Rain delay", "starting-soon": "Starting soon",
  suspended: "Suspended", unscheduled: "Not scheduled" };

/* How far in seconds a schedule instant may sit in the past before the display says so. A live runtime would have transitioned a zone whose next run or whose end
 * instant has passed, so an instant still standing well after it is evidence that nothing is polling. Ten nominal poll intervals is generous enough that a
 * nextpoll excursion or a few minutes of clock skew never false-alarms, and tight enough that a dead runtime surfaces within minutes.
 *
 * This threshold is presentation policy - how patient the display chooses to be - which is why it lives here, while the active-zone window, which is runtime policy
 * the Home app enforces too, travels with the data instead.
 */
export const STALE_GRACE = 600;

// Render a span in whole minutes with its plural marker, matching the runtime's own duration wording so the Homebridge log and this panel describe the same span
// the same way. A span that has already elapsed floors at zero rather than reading as a negative countdown.
export const formatMinutes = (seconds) => {

  const minutes = Math.max(Math.round(seconds / 60), 0);

  return minutes.toString() + " minute" + ((minutes !== 1) ? "s" : "");
};

/* Render an absolute instant for a reader in THIS BROWSER's timezone, in escalating tiers of precision: the clock time alone when it falls on the same calendar
 * day as the render, a short weekday when it falls within a week of the render in either direction, and a locale date beyond that week, where a weekday alone
 * would name a day months away - ahead or behind - as though it were this one.
 * The runtime's own log line renders the wire's controller-local start string instead, so the two surfaces can legitimately differ for a user viewing from another
 * timezone - the epoch is the truth and each surface renders it honestly for its own reader.
 *
 * The locale-date tier also serves the suspension instant, which routinely sits years out, and it is an extension of this formatter rather than a sibling beside
 * it: the same-day and within-a-week tiers are already exactly what a suspension needs, and a second formatter restating them would split the display tier's one
 * date policy in two.
 */
export const formatRunTime = (epochSeconds, nowSeconds) => {

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

/* Classify one zone's persisted schedule entry into the display state it reads as - the one answer the sidebar dot and the zone panel both branch on, so a dot and
 * the panel beside it can never disagree about what a zone is doing. A zone the projection does not name has no state to show, which is what a legacy cache and a
 * zone the runtime has not yet reported both look like, so those answer null.
 *
 * The wire's scheduled state splits in two here: a run inside the window the runtime marks a valve active on reads as imminent, and one beyond it as merely
 * scheduled. That window travels with the projection rather than being hardcoded here, so this and the Home app agree on when a zone counts as imminent.
 */
export const zoneScheduleState = (entry, meta, nowSeconds) => {

  if(!entry) {

    return null;
  }

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

/* Derive one zone's schedule rows and its staleness verdict from its persisted entry, at the render pass's shared instant so every row of a pass answers to the
 * same "now". Every presentation decision lives here and nothing derived is ever persisted, which is what keeps a panel from disagreeing with its own inputs: the
 * running countdown, the next-run instant, and the staleness verdict are all computed from stored facts at the moment they are shown, and the status word itself
 * comes from the shared vocabulary rather than being spelled out again here.
 *
 * A zone with no state at all renders no schedule rows.
 */
export const deriveZoneDisplay = (entry, meta, nowSeconds) => {

  const state = zoneScheduleState(entry, meta, nowSeconds);

  if(state === null) {

    return { rows: [], stale: false };
  }

  const status = [ "Status", ZONE_STATE_LABELS[state] ];

  switch(state) {

    case "running":

      // A running zone whose end instant has passed by more than the grace is evidence of a dead runtime: a live one would have reported the zone stopped.
      return { rows: [ status, [ "Time Remaining", formatMinutes(entry.endsAt - nowSeconds) ] ], stale: (nowSeconds - entry.endsAt) > STALE_GRACE };

    case "scheduled":
    case "starting-soon":

      // The two scheduled states describe the same upcoming run and differ only in the word above it, so one arm renders both.
      return { rows: [ status, [ "Next Run", formatRunTime(entry.nextRunAt, nowSeconds) ], [ "Duration", formatMinutes(entry.durationSeconds) ] ],
        stale: (nowSeconds - entry.nextRunAt) > STALE_GRACE };

    case "suspended":

      // A suspension carries the instant it lifts, which routinely sits years out and so exercises the formatter's date tier. There is no staleness verdict here,
      // mirroring the rain-delay arm: a suspension still standing is the state itself, not evidence that nothing is polling.
      return { rows: [ status, [ "Until", formatRunTime(entry.until, nowSeconds) ] ], stale: false };

    default:

      // Rain delay and the unscheduled state carry no facts beyond the word itself, so the status row is the whole display and there is no instant to age against.
      return { rows: [status], stale: false };
  }
};

/* Fold a controller's whole projection into two separate facts: ONE WORD for what the controller is doing, and the detail rows beneath it - the zones actually
 * watering, and the next zone due. This is a pure read of the same persisted entries the zone panels read, at the same shared instant, so the controller panel and
 * its zones can never tell different stories.
 *
 * The status word is handed back apart from the rows rather than as the first of them, because the two are presented differently: the word belongs in the panel's
 * stat strip alongside the controller's identity, and the rows belong in the detail beneath it. Composing that layout is the renderer's job, so this tier answers
 * with the facts and takes no view on where either one is drawn.
 *
 * A projection that is absent OR names no zone at all has no status to report and no rows to draw, deliberately: an account with no zones is not an account with
 * nothing scheduled, and folding an empty set to "Not scheduled" would say exactly that.
 */
export const deriveControllerDisplay = (schedule, zoneNames, nowSeconds) => {

  if(!schedule?.zones.length) {

    return { detail: [], stale: false, status: null };
  }

  const running = schedule.zones.filter((zone) => zone.state === "running").toSorted((a, b) => a.relayId - b.relayId);
  const scheduled = schedule.zones.filter((zone) => zone.state === "scheduled");
  const soon = scheduled.filter((zone) => (zone.nextRunAt - nowSeconds) <= schedule.activeWindowSeconds);
  const nextUp = scheduled.reduce((earliest, zone) => (!earliest || (zone.nextRunAt < earliest.nextRunAt)) ? zone : earliest, null);
  const nameOf = (zone) => zoneNames?.[zone.relayId.toString()] ?? zone.relayId.toString();
  const detail = [];

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
  let status;

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

  return { detail, stale: schedule.zones.some((zone) => ((zone.state === "running") && ((nowSeconds - zone.endsAt) > STALE_GRACE)) ||
    ((zone.state === "scheduled") && ((nowSeconds - zone.nextRunAt) > STALE_GRACE))), status };
};

/* One non-empty string characteristic value off a serialized cached service, located by the constructor name Homebridge serializes alongside it. Every reader of
 * the accessory cache goes through here, so what counts as a usable value - present, a string, and not empty - is decided once rather than at each site.
 */
export const cachedCharacteristic = (service, constructorName) => {

  if(!Array.isArray(service?.characteristics)) {

    return undefined;
  }

  const value = service.characteristics.find((characteristic) => characteristic?.constructorName === constructorName)?.value;

  return ((typeof value === "string") && value.length) ? value : undefined;
};

/* The firmware value Homebridge stamps on an accessory whose real version nothing has ever written. The runtime writes this same marker back whenever the account
 * credentials are absent, which is what makes it the honest signal that no hardware facts have landed - mirrored here as a literal because this browser module
 * cannot import the runtime's constants.
 */
const UNKNOWN_FIRMWARE = "0";

/* The controller hardware HomeKit last showed, read from the cached AccessoryInformation service, or undefined when no real facts have landed.
 *
 * The pair is all-or-nothing on purpose. An unenriched controller still carries a model - the runtime stamps a product-line placeholder so the Home app never
 * shows a library-internal string - so the model alone cannot say whether anything was learned. The firmware can: it holds the unknown marker until a real
 * account answer replaces it. So the firmware decides, and the two render together or not at all, which is what keeps the strip from pairing a real model with an
 * empty firmware cell.
 */
export const cachedControllerHardware = (accessory) => {

  const service = accessory?.services?.find((entry) => entry?.constructorName === "AccessoryInformation");
  const firmware = cachedCharacteristic(service, "FirmwareRevision");
  const model = cachedCharacteristic(service, "Model");

  if(!firmware || (firmware === UNKNOWN_FIRMWARE) || !model) {

    return undefined;
  }

  return { firmware, model };
};

/* The cells of a controller's stat strip, in the order the panel shows them, each as its label, its value, and whether the value reads in the monospace face. The
 * hardware cells lead when real facts have landed and are absent otherwise, so an install running on the API key alone shows a shorter strip rather than
 * placeholder cells that would claim knowledge the plugin does not have. The zone count is shown only when it is known, because a zero would read as a controller
 * with no zones, and the status word only when the fold has one to report. The identifiers - the serial and the firmware - read in the monospace face.
 */
export const deriveControllerStrip = ({ hardware, serialNumber, status, zoneCount }) => {

  const rows = [];

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

// The cells of a zone's stat strip, in the same row shape as the controller's: its display relay number, then its relay id, an identifier read in the monospace
// face. A value the row does not carry renders as an empty cell rather than as the word "undefined".
export const deriveZoneStrip = ({ relay, relayId }) => [ { label: "Zone", monospace: false, value: (relay ?? "").toString() },
  { label: "Relay ID", monospace: true, value: (relayId ?? "").toString() } ];
