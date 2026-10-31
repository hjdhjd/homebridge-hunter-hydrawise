/* Copyright(C) 2017-2026, HJD (https://github.com/hjdhjd). All rights reserved.
 *
 * webui/display.test.ts: The webUI's pure schedule-display derivations, exercised against the very module ui.mjs renders from. Covers the zone classification
 * and the imminent-run window it splits on, the zone and controller row folds with their staleness verdicts and the status precedence, the formatters, the
 * device panel's stat strips with the cached-hardware gate that decides whether the hardware cells appear, and the cached names the page labels a controller and
 * a zone with.
 *
 * This suite holds to disciplines that keep it deterministic: every instant is derived from one fixed anchor rather than a live clock, so a run of this suite
 * means the same thing at any hour, and every expected string a formatter produces is computed through the identical Intl call the formatter itself makes, so a
 * host whose locale or timezone differs moves both sides together rather than reddening a correct implementation.
 */
import type { HydrawiseCachedAccessory, HydrawiseCachedService, HydrawiseScheduleMeta } from "./display.ts";
import type { HydrawiseScheduleStatus, HydrawiseZoneScheduleStatus } from "../types.ts";
import { STALE_GRACE, ZONE_STATE_LABELS, cachedAccessoryName, cachedControllerHardware, cachedValveName, deriveControllerDisplay, deriveControllerStrip,
  deriveZoneDisplay, deriveZoneStrip, formatMinutes, formatRunTime, zoneScheduleState } from "./display.ts";
import { describe, test } from "node:test";
import assert from "node:assert/strict";

/* The instant every scenario answers to: noon on a fixed calendar day, composed from LOCAL date components. The composition is what carries the day
 * relationships below onto every host - an epoch constant fixes an instant, not a calendar day, and noon UTC is already late evening in a UTC+11 host, where an
 * hour later is tomorrow. Nothing here reads a live clock.
 */
const NOW = Math.floor(new Date(2026, 0, 15, 12, 0, 0, 0).getTime() / 1000);

// An hour past the anchor, which is 13:00 on the anchor's own calendar day. The relationship is derived by hand here rather than recomputed by the test.
const SAME_DAY = NOW + 3600;

// Twenty-six hours past the anchor, which is 14:00 the following calendar day. No daylight-saving shift is large enough to pull it back onto the anchor's day.
const NEXT_DAY = NOW + (26 * 3600);

// The active window a projection declares, half an hour wide so a run inside it and a run beyond it are both easy to place.
const WINDOW = 1800;

// The projection's scalar facts. No derivation under test reads asOf, so it simply carries the anchor.
function meta(activeWindowSeconds: number = WINDOW): HydrawiseScheduleMeta {

  return { activeWindowSeconds, asOf: NOW };
}

function runningEntry(relayId: number, endsAt: number): HydrawiseZoneScheduleStatus {

  return { endsAt, relayId, state: "running" };
}

function scheduledEntry(relayId: number, nextRunAt: number, durationSeconds = 480): HydrawiseZoneScheduleStatus {

  return { durationSeconds, nextRunAt, relayId, state: "scheduled" };
}

function projection(zones: HydrawiseZoneScheduleStatus[], activeWindowSeconds: number = WINDOW): HydrawiseScheduleStatus {

  return { activeWindowSeconds, asOf: NOW, zones };
}

// The status word a projection folds to, returned apart from the detail rows rather than as one of them.
function statusOf(zones: HydrawiseZoneScheduleStatus[]): string | undefined {

  return deriveControllerDisplay(projection(zones), {}, NOW).status ?? undefined;
}

// The clock form of an instant, computed through the same Intl call formatRunTime makes.
function clockOf(epochSeconds: number): string {

  return new Date(epochSeconds * 1000).toLocaleTimeString(undefined, { hour: "numeric", minute: "2-digit" });
}

// The short weekday of an instant, computed through the same Intl call formatRunTime makes.
function weekdayOf(epochSeconds: number): string {

  return new Date(epochSeconds * 1000).toLocaleDateString(undefined, { weekday: "short" });
}

describe("hydrawise webUI schedule display derivations", () => {

  test("zoneScheduleState answers null for a zone the projection does not name", () => {

    assert.equal(zoneScheduleState(undefined, meta(), NOW), null, "a zone with no entry has no state to show");
  });

  test("zoneScheduleState reads each persisted state as its own display state", () => {

    assert.equal(zoneScheduleState(runningEntry(1, NOW + 600), meta(), NOW), "running", "a running zone reads as running");
    assert.equal(zoneScheduleState(scheduledEntry(1, NOW + WINDOW + 1), meta(), NOW), "scheduled", "a run beyond the window reads as scheduled");
    assert.equal(zoneScheduleState({ relayId: 1, state: "sensor-stopped" }, meta(), NOW), "sensor-stopped", "a rain-stopped zone reads as sensor-stopped");
    assert.equal(zoneScheduleState({ relayId: 1, state: "unscheduled" }, meta(), NOW), "unscheduled", "a zone with no upcoming run reads as unscheduled");
  });

  test("zoneScheduleState splits the scheduled state at the window the projection declares", () => {

    assert.equal(zoneScheduleState(scheduledEntry(1, NOW + WINDOW), meta(), NOW), "starting-soon", "a run exactly at the window is imminent");
    assert.equal(zoneScheduleState(scheduledEntry(1, NOW + WINDOW + 1), meta(), NOW), "scheduled", "a run one second beyond the window is merely scheduled");

    // The same entry against a wider window, which is what proves the threshold is read from the projection rather than fixed in the derivation.
    assert.equal(zoneScheduleState(scheduledEntry(1, NOW + WINDOW + 1), meta(WINDOW * 2), NOW), "starting-soon", "a wider declared window makes the same run imminent");
  });

  test("zoneScheduleState treats a missing projection as a zero-width window", () => {

    assert.equal(zoneScheduleState(scheduledEntry(1, NOW), undefined, NOW), "starting-soon", "a run due this very second is imminent under the zero default");
    assert.equal(zoneScheduleState(scheduledEntry(1, NOW + 1), undefined, NOW), "scheduled", "any run still ahead is merely scheduled under the zero default");
  });

  test("deriveZoneDisplay renders no rows for a zone with no state", () => {

    assert.deepEqual(deriveZoneDisplay(undefined, meta(), NOW), { rows: [], stale: false }, "a zone the projection does not name renders nothing at all");
  });

  test("deriveZoneDisplay renders a running zone as its word and what is left of the run", () => {

    const derived = deriveZoneDisplay(runningEntry(1, NOW + 600), meta(), NOW);

    assert.deepEqual(derived.rows, [ [ "Status", ZONE_STATE_LABELS.running ], [ "Time Remaining", "10 minutes" ] ], "a running zone shows its status and countdown");
    assert.equal(derived.stale, false, "a run whose end instant is still ahead is not stale");
  });

  test("deriveZoneDisplay calls a running zone stale only once its end instant passes the grace", () => {

    assert.equal(deriveZoneDisplay(runningEntry(1, NOW - STALE_GRACE), meta(), NOW).stale, false, "an end instant exactly at the grace is not yet stale");
    assert.equal(deriveZoneDisplay(runningEntry(1, (NOW - STALE_GRACE) - 1), meta(), NOW).stale, true, "an end instant one second past the grace is stale");
  });

  test("deriveZoneDisplay renders a scheduled zone's next run and duration under either scheduled word", () => {

    const derived = deriveZoneDisplay(scheduledEntry(1, SAME_DAY), meta(), NOW);

    assert.deepEqual(derived.rows, [ [ "Status", ZONE_STATE_LABELS.scheduled ], [ "Next Run", clockOf(SAME_DAY) ], [ "Duration", "8 minutes" ] ],
      "a scheduled zone shows its status, its next run, and how long that run lasts");
    assert.equal(derived.stale, false, "a next run still ahead of the render is not stale");

    // The imminent arm renders the same rows and differs only in the word above them.
    const soon = deriveZoneDisplay(scheduledEntry(1, NOW + WINDOW), meta(), NOW);

    assert.deepEqual(soon.rows, [ [ "Status", ZONE_STATE_LABELS["starting-soon"] ], [ "Next Run", clockOf(NOW + WINDOW) ], [ "Duration", "8 minutes" ] ],
      "an imminent run renders the same rows under the imminent word");
  });

  test("deriveZoneDisplay calls a scheduled zone stale only once its next run passes the grace", () => {

    assert.equal(deriveZoneDisplay(scheduledEntry(1, NOW - STALE_GRACE), meta(), NOW).stale, false, "a next run exactly at the grace is not yet stale");
    assert.equal(deriveZoneDisplay(scheduledEntry(1, (NOW - STALE_GRACE) - 1), meta(), NOW).stale, true, "a next run one second past the grace is stale");
  });

  test("deriveZoneDisplay renders the fact-free states as their status row alone", () => {

    assert.deepEqual(deriveZoneDisplay({ relayId: 1, state: "sensor-stopped" }, meta(), NOW), { rows: [[ "Status", ZONE_STATE_LABELS["sensor-stopped"] ]],
      stale: false }, "a rain-stopped zone carries no instant to age against");
    assert.deepEqual(deriveZoneDisplay({ relayId: 1, state: "unscheduled" }, meta(), NOW), { rows: [[ "Status", ZONE_STATE_LABELS.unscheduled ]], stale: false },
      "an unscheduled zone carries no instant to age against");
  });

  test("deriveControllerDisplay renders no rows without a projection or without zones", () => {

    assert.deepEqual(deriveControllerDisplay(undefined, {}, NOW), { detail: [], stale: false, status: null }, "a controller with no projection renders nothing");
    assert.deepEqual(deriveControllerDisplay(projection([]), {}, NOW), { detail: [], stale: false, status: null },
      "an account naming no zone is not an account with nothing scheduled");
  });

  test("deriveControllerDisplay walks the status precedence from water flowing down to nothing scheduled", () => {

    const running = runningEntry(1, NOW + 600);
    const soon = scheduledEntry(2, NOW + WINDOW);
    const later = scheduledEntry(3, NOW + WINDOW + 1);
    const stopped: HydrawiseZoneScheduleStatus = { relayId: 4, state: "sensor-stopped" };
    const idle: HydrawiseZoneScheduleStatus = { relayId: 5, state: "unscheduled" };

    assert.equal(statusOf([ running, soon, later, stopped, idle ]), "Watering", "water actually flowing outranks every other state");
    assert.equal(statusOf([ soon, later, stopped, idle ]), ZONE_STATE_LABELS["starting-soon"], "an imminent run outranks a later one");
    assert.equal(statusOf([ later, stopped, idle ]), ZONE_STATE_LABELS.scheduled, "a scheduled run outranks a rain stop");
    assert.equal(statusOf([ stopped, idle ]), ZONE_STATE_LABELS["sensor-stopped"], "a rain stop outranks a zone with nothing coming");
    assert.equal(statusOf([idle]), ZONE_STATE_LABELS.unscheduled, "an account with nothing coming reads as not scheduled");
  });

  test("deriveControllerDisplay names every running zone in relay order with its own countdown", () => {

    const zones = [ runningEntry(3, NOW + 300), runningEntry(1, NOW + 600) ];
    const derived = deriveControllerDisplay(projection(zones), { "1": "Front Lawn", "3": "Back Beds" }, NOW);

    assert.equal(derived.status, "Watering", "the status word travels apart from the detail rows");
    assert.deepEqual(derived.detail, [[ "Now Running", "Front Lawn (10 minutes), Back Beds (5 minutes)" ]],
      "both running zones are named in relay order, each with its own countdown");
  });

  test("deriveControllerDisplay names the earliest scheduled zone as the next zone", () => {

    const zones = [ scheduledEntry(1, NEXT_DAY), scheduledEntry(2, SAME_DAY) ];
    const derived = deriveControllerDisplay(projection(zones), { "1": "Front Lawn", "2": "Side Strip" }, NOW);

    assert.deepEqual(derived.detail[0], [ "Next Zone", "Side Strip at " + clockOf(SAME_DAY) ], "the earliest next run wins, whatever order the zones arrive in");
  });

  test("deriveControllerDisplay falls back to the relay id for a zone the names do not carry", () => {

    assert.deepEqual(deriveControllerDisplay(projection([runningEntry(7, NOW + 60)]), {}, NOW).detail[0], [ "Now Running", "7 (1 minute)" ],
      "a zone the names object has no entry for renders as its relay id");
    assert.deepEqual(deriveControllerDisplay(projection([runningEntry(7, NOW + 60)]), undefined, NOW).detail[0], [ "Now Running", "7 (1 minute)" ],
      "a controller carrying no names at all renders the same way");
  });

  test("deriveControllerDisplay calls a controller stale only once a zone's own instant passes the grace", () => {

    assert.equal(deriveControllerDisplay(projection([runningEntry(1, NOW - STALE_GRACE)]), {}, NOW).stale, false,
      "an end instant exactly at the grace is not yet stale");
    assert.equal(deriveControllerDisplay(projection([runningEntry(1, (NOW - STALE_GRACE) - 1)]), {}, NOW).stale, true,
      "a run that should have ended well before now is stale");
    assert.equal(deriveControllerDisplay(projection([scheduledEntry(1, (NOW - STALE_GRACE) - 1)]), {}, NOW).stale, true,
      "a run that should have started well before now is stale");
    assert.equal(deriveControllerDisplay(projection([ runningEntry(1, NOW + 600), scheduledEntry(2, SAME_DAY) ]), {}, NOW).stale, false,
      "instants that are all still ahead leave the controller fresh");
  });

  test("formatMinutes rounds to whole minutes and floors an elapsed span at zero", () => {

    assert.equal(formatMinutes(90), "2 minutes", "ninety seconds rounds up to two minutes");
    assert.equal(formatMinutes(89), "1 minute", "eighty-nine seconds rounds down to one minute");
    assert.equal(formatMinutes(29), "0 minutes", "a span under half a minute rounds down to zero");
    assert.equal(formatMinutes(-300), "0 minutes", "a span that has already elapsed floors at zero rather than counting backwards");
  });

  test("formatMinutes marks the plural everywhere but exactly one minute", () => {

    assert.equal(formatMinutes(60), "1 minute", "exactly one minute is singular");
    assert.equal(formatMinutes(120), "2 minutes", "more than one minute is plural");
    assert.equal(formatMinutes(0), "0 minutes", "zero minutes is plural");
  });

  test("formatRunTime renders a same-day instant as the clock time alone", () => {

    assert.equal(formatRunTime(SAME_DAY, NOW), clockOf(SAME_DAY), "an instant on the render's own calendar day needs no date");
    assert.notEqual(formatRunTime(SAME_DAY, NOW), weekdayOf(SAME_DAY) + " " + clockOf(SAME_DAY), "the same-day form carries no weekday");
  });

  test("formatRunTime prefixes a cross-day instant with its short weekday", () => {

    assert.equal(formatRunTime(NEXT_DAY, NOW), weekdayOf(NEXT_DAY) + " " + clockOf(NEXT_DAY), "an instant on another calendar day names its day");
    assert.notEqual(formatRunTime(NEXT_DAY, NOW), clockOf(NEXT_DAY), "the cross-day form is never the bare clock time");
  });
});

describe("hydrawise webUI suspension and availability display", () => {

  // Well beyond a week from the anchor, which is what a real suspension instant looks like and what the formatter's date tier serves.
  const FAR_FUTURE = NOW + (400 * 24 * 3600);

  function suspendedEntry(relayId: number, until: number): HydrawiseZoneScheduleStatus {

    return { relayId, state: "suspended", until };
  }

  // The locale date form of an instant, computed through the same Intl call formatRunTime makes for its third tier.
  function dateOf(epochSeconds: number): string {

    return new Date(epochSeconds * 1000).toLocaleDateString();
  }

  test("a suspended entry classifies as suspended and reads through the shared vocabulary", () => {

    assert.equal(zoneScheduleState(suspendedEntry(1, FAR_FUTURE), meta(), NOW), "suspended", "the suspended arm has a display state of its own");
    assert.equal(ZONE_STATE_LABELS.suspended, "Suspended", "and a word of its own in the shared vocabulary");
  });

  test("a suspended zone renders its status word and the instant its suspension lifts", () => {

    const rendering = deriveZoneDisplay(suspendedEntry(1, FAR_FUTURE), meta(), NOW);

    /* The status word is read from the shared vocabulary rather than compared against a literal, so a change to the wording moves this assertion with it rather than
     * reddening it - which is the whole reason the vocabulary is shared in the first place.
     */
    assert.deepEqual(rendering.rows, [ [ "Status", ZONE_STATE_LABELS.suspended ], [ "Until", dateOf(FAR_FUTURE) ] ],
      "a suspended zone shows its state and when it ends");

    // A suspension still standing is the state itself, not evidence that nothing is polling, so it reads as current.
    assert.equal(rendering.stale, false, "a standing suspension is never reported as stale facts");
  });

  test("a suspended zone reads stale only once its end instant passes the grace", () => {

    // A live runtime ends a suspension on the first poll past its end, so one still standing well after it is the same evidence a long-passed run is.
    assert.equal(deriveZoneDisplay(suspendedEntry(1, NOW - STALE_GRACE), meta(), NOW).stale, false, "an end instant exactly at the grace is not yet stale");
    assert.equal(deriveZoneDisplay(suspendedEntry(1, (NOW - STALE_GRACE) - 1), meta(), NOW).stale, true, "an end instant one second past the grace is stale");
  });

  test("a controller reads stale once any suspended zone's end instant passes the grace", () => {

    // The fold holds suspended zones alone, one still standing beside one whose end moves across the grace, so the verdict can come from no other arm.
    assert.equal(deriveControllerDisplay(projection([ suspendedEntry(1, NOW - STALE_GRACE), suspendedEntry(2, FAR_FUTURE) ]), {}, NOW).stale, false,
      "an end instant exactly at the grace is not yet stale");
    assert.equal(deriveControllerDisplay(projection([ suspendedEntry(1, (NOW - STALE_GRACE) - 1), suspendedEntry(2, FAR_FUTURE) ]), {}, NOW).stale, true,
      "one zone's end instant one second past the grace makes the controller stale");
  });

  test("the formatter's third tier renders an instant beyond a week as a locale date", () => {

    /* The far-future fixture is the only one that reaches the date tier; a near-term fixture leaves it unexecuted and a weekday alone would misname a day four
     * hundred days out as though it were this week. The same-day and within-week tiers are exercised below.
     */
    assert.equal(formatRunTime(FAR_FUTURE, NOW), dateOf(FAR_FUTURE), "a far-future instant renders as a date");

    // Confirmed against the same-day and within-week fixtures used throughout this suite.
    assert.equal(formatRunTime(SAME_DAY, NOW), clockOf(SAME_DAY), "an instant today still renders as the clock alone");
    assert.equal(formatRunTime(NEXT_DAY, NOW), weekdayOf(NEXT_DAY) + " " + clockOf(NEXT_DAY), "and one within the week still carries its weekday");
  });

  test("a controller whose zones are all suspended folds to the suspended word", () => {

    assert.equal(statusOf([ suspendedEntry(1, FAR_FUTURE), suspendedEntry(2, FAR_FUTURE) ]), ZONE_STATE_LABELS.suspended,
      "an account with nothing but suspended zones says so rather than reading as merely unscheduled");
  });

  test("a rain delay outranks a suspension in the controller fold", () => {

    // Both are reasons irrigation is held back, and an account with any zone rain-stopped has the more immediate one to report.
    assert.equal(statusOf([ suspendedEntry(1, FAR_FUTURE), { relayId: 2, state: "sensor-stopped" } ]), ZONE_STATE_LABELS["sensor-stopped"],
      "the rain delay is the word a mixed account leads with");
  });

  test("an unreachable controller leads with Offline, whatever its zones are scheduled to do", () => {

    /* Reachability reframes everything under it: a schedule read off a controller that is not answering describes what WOULD happen, so saying so first is more
     * honest than leading with a plan nothing is currently carrying out.
     */
    const offline: HydrawiseScheduleStatus = { activeWindowSeconds: WINDOW, asOf: NOW, online: false,
      zones: [ runningEntry(1, SAME_DAY), scheduledEntry(2, NEXT_DAY) ] };

    assert.equal(deriveControllerDisplay(offline, {}, NOW).status, "Offline", "an unreachable controller says so first");
  });

  test("a reachable controller, and one whose availability is unknown, both fold exactly as they always have", () => {

    // The parity half: the availability arm must not disturb the fold for an install that reports itself reachable or one that carries no availability at all.
    const reachable: HydrawiseScheduleStatus = { activeWindowSeconds: WINDOW, asOf: NOW, online: true, zones: [runningEntry(1, SAME_DAY)] };

    assert.equal(deriveControllerDisplay(reachable, {}, NOW).status, "Watering", "a reachable controller folds on its zones alone");
    assert.equal(statusOf([runningEntry(1, SAME_DAY)]), "Watering", "and so does one that carries no availability at all");
  });
});

describe("hydrawise webUI controller strip composition", () => {

  test("the fold hands back the status word and the detail rows as separate facts", () => {

    /* The shape the panel's two-line strip rests on. The word belongs in the stat strip beside the controller's identity and the rows belong in the detail below
     * it, so a renderer must be able to place each without unpacking the other - which is exactly what returning them as one rows array prevented.
     */
    const derived = deriveControllerDisplay(projection([ runningEntry(1, NOW + 600), scheduledEntry(2, SAME_DAY) ]), { "1": "Front Lawn", "2": "Side Strip" }, NOW);

    assert.equal(derived.status, "Watering", "the status word is its own fact");
    assert.deepEqual(derived.detail.map(([label]) => label), [ "Now Running", "Next Zone" ], "and the detail carries only the rows beneath it");

    // The word never leaks back into the rows, which is what a renderer drawing both would otherwise duplicate.
    assert.ok(!derived.detail.some(([label]) => label === "Status"), "no Status row remains among the detail");
  });

  test("a controller whose zones are all idle reports its status word with no detail beneath it", () => {

    // An account whose zones are all idle has a word to show and nothing to detail, so the strip renders and the second line does not.
    const derived = deriveControllerDisplay(projection([{ relayId: 1, state: "unscheduled" }]), {}, NOW);

    assert.equal(derived.status, ZONE_STATE_LABELS.unscheduled, "the word still reports");
    assert.deepEqual(derived.detail, [], "and there is nothing to draw beneath it");
  });

  test("the staleness verdict travels with the fold, unchanged by the split", () => {

    // The verdict is the third fact and answers to the zones' own instants, so separating the word from the rows must not have moved it.
    assert.equal(deriveControllerDisplay(projection([runningEntry(1, (NOW - STALE_GRACE) - 1)]), {}, NOW).stale, true, "a long-passed instant still reads stale");
    assert.equal(deriveControllerDisplay(projection([runningEntry(1, NOW + 600)]), {}, NOW).stale, false, "and a live one still does not");
  });
});

describe("hydrawise webUI stat strips", () => {

  // The hardware a real account answer stamps on the information service, kept distinct from every placeholder so a strip reading it cannot pass by coincidence.
  const HARDWARE = { firmware: "4.76", model: "HCC 38 Zones" };

  // A cached controller accessory as the accessory cache serializes it, carrying whichever information characteristics a scenario names.
  function cachedAccessory(characteristics: Record<string, string>): HydrawiseCachedAccessory {

    return { services: [{ characteristics: Object.entries(characteristics).map(([ constructorName, value ]) => ({ constructorName, value })),
      constructorName: "AccessoryInformation" }] };
  }

  test("the hardware gate refuses every reading that has not learned real facts", () => {

    assert.equal(cachedControllerHardware(cachedAccessory({ FirmwareRevision: "0", Model: HARDWARE.model })), undefined,
      "the unknown-firmware marker means nothing was learned, whatever the model says");
    assert.equal(cachedControllerHardware(cachedAccessory({ Model: HARDWARE.model })), undefined, "an absent firmware refuses");
    assert.equal(cachedControllerHardware(cachedAccessory({ FirmwareRevision: HARDWARE.firmware })), undefined, "an absent model refuses");
    assert.equal(cachedControllerHardware({ services: [] }), undefined, "an accessory with no information service refuses");
  });

  test("the hardware gate answers the model and the firmware once real facts have landed", () => {

    assert.deepEqual(cachedControllerHardware(cachedAccessory({ FirmwareRevision: HARDWARE.firmware, Model: HARDWARE.model })), HARDWARE,
      "a real firmware beside a model answers the model and the firmware together");
  });

  test("the controller strip leads with the hardware when it is known, and shows the identity and state whatever the hardware", () => {

    const enriched = deriveControllerStrip({ hardware: HARDWARE, serialNumber: "SN0A1B2C3D4", status: "Watering", zoneCount: 19 });
    const keyOnly = deriveControllerStrip({ hardware: undefined, serialNumber: "SN0A1B2C3D4", status: "Watering", zoneCount: 19 });

    assert.deepEqual(enriched.map((row) => [ row.label, row.value ]), [ [ "Model", HARDWARE.model ], [ "Serial Number", "SN0A1B2C3D4" ],
      [ "Firmware", HARDWARE.firmware ], [ "Zones", "19" ], [ "Status", "Watering" ] ], "an enriched controller shows every cell in the panel's order");
    assert.deepEqual(keyOnly.map((row) => row.label), [ "Serial Number", "Zones", "Status" ], "an install on the API key alone shows a shorter strip");
    assert.deepEqual(deriveControllerStrip({ hardware: undefined, serialNumber: "SN0A1B2C3D4", status: null, zoneCount: undefined }).map((row) => row.label),
      ["Serial Number"], "an unknown zone count and a missing status word leave their cells out");
  });

  test("the identifiers, and only the identifiers, read in the monospace face", () => {

    const rows = [ ...deriveControllerStrip({ hardware: HARDWARE, serialNumber: "SN0A1B2C3D4", status: "Watering", zoneCount: 19 }),
      ...deriveZoneStrip({ relay: 1, relayId: 700001 }) ];

    assert.deepEqual(rows.filter((row) => row.monospace).map((row) => row.label), [ "Serial Number", "Firmware", "Relay ID" ],
      "the serial, the firmware, and the relay id are the monospace cells");
  });

  test("the zone strip shows the display relay number, then the relay id, in the controller strip's row shape", () => {

    assert.deepEqual(deriveZoneStrip({ relay: 1, relayId: 700001 }), [ { label: "Zone", monospace: false, value: "1" },
      { label: "Relay ID", monospace: true, value: "700001" } ], "the zone's identity, as the panel shows it");
    assert.deepEqual(deriveZoneStrip({ relay: undefined, relayId: undefined }).map((row) => row.value), [ "", "" ],
      "a row carrying no identity renders empty cells rather than a word");
  });
});

describe("hydrawise webUI cached names", () => {

  // The names a cached service can carry, each distinct, so a reader that took the wrong characteristic or the wrong service cannot pass by coincidence.
  const HOME_APP_NAME = "Patio Sprinklers";
  const HOMEKIT_NAME = "Front Lawn";
  const OTHER_NAME = "Back Beds";

  // A serialized cached service of the named kind and subtype, carrying whichever name characteristics a scenario names.
  function cachedService(constructorName: string, names: Record<string, string>, subtype?: string): HydrawiseCachedService {

    return { characteristics: Object.entries(names).map(([ characteristic, value ]) => ({ constructorName: characteristic, value })), constructorName, subtype };
  }

  test("an accessory's tile reads its information service's ConfiguredName first and its Name second", () => {

    assert.equal(cachedAccessoryName({ services: [cachedService("AccessoryInformation", { ConfiguredName: HOME_APP_NAME, Name: HOMEKIT_NAME })] }), HOME_APP_NAME,
      "the ConfiguredName a rename in the Home app writes is the name HomeKit shows");
    assert.equal(cachedAccessoryName({ services: [cachedService("AccessoryInformation", { Name: HOMEKIT_NAME })] }), HOMEKIT_NAME,
      "an information service carrying Name alone reads that");
    assert.equal(cachedAccessoryName({ services: [cachedService("AccessoryInformation", { ConfiguredName: "", Name: HOMEKIT_NAME })] }), HOMEKIT_NAME,
      "and so does one whose ConfiguredName is empty");
  });

  test("an accessory's tile reads nothing where no information service, or no accessory, is cached", () => {

    assert.equal(cachedAccessoryName({ services: [cachedService("Valve", { ConfiguredName: HOME_APP_NAME }, "700001")] }), undefined,
      "a name on another kind of service is no tile's name");
    assert.equal(cachedAccessoryName({}), undefined, "an accessory carrying no services reads nothing");
    assert.equal(cachedAccessoryName(undefined), undefined, "and so does no accessory at all");
  });

  test("a zone's valve reads its ConfiguredName first and its Name second", () => {

    assert.equal(cachedValveName({ services: [cachedService("Valve", { ConfiguredName: HOME_APP_NAME, Name: HOMEKIT_NAME }, "700001")] }, 700001), HOME_APP_NAME,
      "the ConfiguredName a rename in the Home app writes is the name HomeKit shows");
    assert.equal(cachedValveName({ services: [cachedService("Valve", { Name: HOMEKIT_NAME }, "700001")] }, 700001), HOMEKIT_NAME,
      "a valve carrying Name alone reads that");
  });

  test("a zone's valve is found by its kind and its relay, past a service of another kind and a valve of another relay", () => {

    const accessory = { services: [ cachedService("Switch", { ConfiguredName: OTHER_NAME }, "700001"), cachedService("Valve", { ConfiguredName: OTHER_NAME }, "700002"),
      cachedService("Valve", { ConfiguredName: HOMEKIT_NAME }, "700001") ] };

    assert.equal(cachedValveName(accessory, 700001), HOMEKIT_NAME, "the zone's own valve answers, not the switch sharing its subtype or another zone's valve");
    assert.equal(cachedValveName(accessory, 700003), undefined, "a zone with no cached valve reads nothing");
    assert.equal(cachedValveName({}, 700001), undefined, "an accessory carrying no services reads nothing");
    assert.equal(cachedValveName(undefined, 700001), undefined, "and so does no accessory at all");
  });
});
