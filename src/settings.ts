/* Copyright(C) 2017-2026, HJD (https://github.com/hjdhjd). All rights reserved.
 *
 * settings.ts: Settings and constants for homebridge-hunter-hydrawise.
 */
import type { Categories } from "homebridge";
import type { HydrawiseEndpoint } from "./types.ts";
import type { TransportFailure } from "homebridge-plugin-utils";

// Hydrawise API response timeout, in seconds.
export const HYDRAWISE_API_TIMEOUT = 7;

// How often, in seconds, should we retry Hydrawise API calls when they fail.
export const HYDRAWISE_API_RETRY_INTERVAL = 60;

// How much, in seconds, jitter should we inject into the API polling interval. This helps ensure we stay clear of the Hydrawise API rate limits.
export const HYDRAWISE_API_JITTER = 0.2;

// The account-wide Hydrawise API ceiling, as a COUNT OF CALLS rather than a duration: Hydrawise documents at most this many API calls of any kind against an
// account inside the trailing window below.
export const HYDRAWISE_API_BUDGET_CALLS = 30;

// The trailing window, in seconds, the account-wide call ceiling above is measured over.
export const HYDRAWISE_API_BUDGET_WINDOW = 300;

// The zone-command ceiling, as a COUNT OF CALLS rather than a duration: Hydrawise documents at most this many zone commands inside the trailing window below,
// which is far stricter than the account-wide ceiling and applies on top of it.
export const HYDRAWISE_COMMAND_BUDGET_CALLS = 3;

// The trailing window, in seconds, the zone-command ceiling above is measured over.
export const HYDRAWISE_COMMAND_BUDGET_WINDOW = 30;

// The one Hydrawise endpoint that carries a zone command, and therefore the one that draws against the stricter command ceiling as well as the account-wide one.
// The platform's draw branch and the controller's command dispatch both read this constant, so the endpoint identity has a single home.
export const HYDRAWISE_COMMAND_ENDPOINT: HydrawiseEndpoint = "setzone.php";

// The base URL every key-based API request is assembled on. The platform derives its connection pool's origin from this one constant, so the host a request goes to
// and the host the pool connects to can never disagree - the same rule the account-credentialed API group below states for its own endpoints.
export const HYDRAWISE_API_BASE_URL = "https://api.hydrawise.com/api/v1/";

// The transport failures the classifier reaches only by matching a transport or errno code - each one a concrete network fault with a sentence of its own below.
export type HydrawiseTransportFault = Extract<TransportFailure, { code: string }>["kind"];

/* What each concrete network fault means to a Hydrawise user, stated once and read by both API clients. The key type is derived from the library's own union, so a
 * fault kind the library learns to name is a compile error here until this plugin gives it a sentence. The lifetime abort, the deadline, and the unmarked failure are
 * deliberately absent: an abort is silent, a deadline re-arms the catching client's own connection pool and speaks for itself there, and an unmarked failure has
 * nothing better to offer than the error itself.
 */
export const HYDRAWISE_TRANSPORT_FAULT_SENTENCES: Readonly<Record<HydrawiseTransportFault, string>> = Object.freeze({

  "connect-timeout": "Connection timed out.",
  "destroyed": "A request to the Hydrawise API was interrupted while the connection was being reset.",
  "dns": "Hostname or IP address not found. Please ensure you're connected to the Internet.",
  "refused": "Connection refused.",
  "reset": "Connection has been reset.",
  "retries-exhausted": "Unable to connect to the Hydrawise API. This is usually temporary and will retry automatically."
});

/* The Hydrawise v2 API. This group states endpoints and credentials, which is a different kind of constant from the durations and call counts the rest of this
 * file carries, so it is marked out as its own group. Everything below is optional at runtime: the v2 surface is reached only when the user has configured their
 * account credentials, and the plugin runs its whole v1 feature set without it.
 *
 * The endpoint URLs below are stated whole. The client derives the origin its connection pool is built on from the URL rather than carrying a separate constant
 * for it, so the host a request goes to and the host the pool connects to can never disagree.
 */
export const HYDRAWISE_V2_GRAPH_ENDPOINT = "https://app.hydrawise.com/api/v2/graph";

// The v2 OAuth2 token endpoint, which answers both the initial password grant and every refresh.
export const HYDRAWISE_V2_TOKEN_ENDPOINT = "https://app.hydrawise.com/api/v2/oauth/access-token";

/* The OAuth2 client identity the token grant presents. These are the Hydrawise application's own embedded client credentials, not a secret belonging to any user:
 * Hydrawise issues no per-integration client registration, so presenting the app's client is the only way to reach v2 at all. They identify the CLIENT; the user's
 * own username and password are what authenticate the account, and those are configuration the user supplies.
 */
export const HYDRAWISE_V2_CLIENT_ID = "hydrawise_app";

// The secret half of the client identity above, embedded on the same terms.
export const HYDRAWISE_V2_CLIENT_SECRET = "zn3CrjglwNV1";

/* The v2 ceiling, as a COUNT OF CALLS inside the trailing window below. Hydrawise publishes no v2 rate limit, so this is not a documented ceiling being made
 * structural the way the v1 budgets are - it is the envelope the Home Assistant integration settled on after repeatedly tripping v2 throttling, and staying well
 * inside it is what keeps an optional enrichment from costing the account the API access its irrigation actually depends on.
 */
export const HYDRAWISE_V2_BUDGET_CALLS = 5;

// The trailing window, in seconds, the v2 call ceiling above is measured over.
export const HYDRAWISE_V2_BUDGET_WINDOW = 1800;

/* The v2 COMMAND ceiling, as a COUNT OF CALLS inside the trailing window below. It paces the per-zone suspension commands, where the ceiling above paces the
 * scheduled reads and the token grants they carry. Each kind of traffic draws its own because they are unlike: a command is an event-shaped user action, someone
 * standing at a switch waiting for it to take, while the reads are a recurring cadence that runs whether anybody is watching or not. Separately, a burst of switch
 * flips neither starves the scheduled reads nor is starved by them.
 *
 * The value is deliberately observational, on the same terms the read ceiling is: generous enough that ordinary use never meets it, small enough that a runaway
 * automation cannot hammer a throttle Hydrawise does not publish. It is also the whole of the policy - what a burst of commands may spend is this constant and
 * nothing else.
 *
 * The arithmetic is worth stating plainly, because independent ceilings do add up: an hour in which commands and reads both run to their limits admits more v2
 * calls than the read ceiling alone ever could. That is the deliberate price of giving a user action headroom of its own, and the read ceiling's own conservatism
 * is untouched by it.
 */
export const HYDRAWISE_V2_MUTATION_BUDGET_CALLS = 10;

// The trailing window, in seconds, the v2 command ceiling above is measured over.
export const HYDRAWISE_V2_MUTATION_BUDGET_WINDOW = 3600;

/* How long, in seconds, a per-zone suspension command waits for the command ceiling to admit it before it gives up.
 *
 * A command is a person standing at their phone watching a switch, so it is bounded by a beat rather than by the budget's own window: that window is an hour wide,
 * and a command that queued for it would take effect long after the user had walked away. Giving up inside a second turns contention into a switch that flicks back
 * carrying a reason, which is the answer the user can act on. An abandoned wait consumes no slot and leaves every other waiter in place, so bounding a command this
 * tightly costs the scheduled reads nothing.
 */
export const HYDRAWISE_V2_MUTATION_ADMISSION_TIMEOUT = 1;

/* The v2 response timeout, in seconds. It is deliberately more generous than the v1 timeout: a v2 call can carry an OAuth round trip ahead of the query itself, and
 * the graph endpoint answers a whole account in one response where a v1 call answers one controller, so the same budget would cut off requests that were simply
 * doing more work.
 */
export const HYDRAWISE_V2_TIMEOUT = 15;

/* How long, in seconds, before an access token expires that the client treats it as due for renewal. The renewal is lazy - it happens on the next call that needs
 * a token, never on a timer - so this window only has to be wider than the gap between noticing and finishing, and a token used inside it is refreshed rather than
 * spent on a request that could expire mid-flight.
 */
export const HYDRAWISE_V2_REFRESH_THRESHOLD = 300;

/* How often, in seconds, the whole-account read that feeds the enhanced features runs. The arithmetic against the envelope above is what fixes the value: the
 * number of reads that fit inside one budget window stays under the read ceiling, leaving slots for the token grants those reads carry. A brisker cadence would
 * buy fresher facts at the cost of the headroom that keeps this optional enrichment from ever crowding out the irrigation the account actually depends on.
 */
export const HYDRAWISE_V2_REFRESH_INTERVAL = 900;

/* How long, in seconds, a snapshot of the account-credentialed facts stays trustworthy. It is derived from the cadence rather than restated as a literal of its
 * own, so the two can never drift apart. Twice the cadence is the deliberate ratio: a single missed refresh never flips a consumer to its fallback, while a
 * refresh loop that has genuinely stopped does, and every consumer returns to the answers an install without account credentials gives.
 */
export const HYDRAWISE_V2_FACTS_TTL = HYDRAWISE_V2_REFRESH_INTERVAL * 2;

// Time until the next zone valve runtime, in seconds, that we should use to indicate that a zone should be marked as active.
export const HYDRAWISE_ACTIVE_ZONE_INDICATOR = 3600;

/* The beat, in MILLISECONDS - unlike this file's other durations, which are stated in seconds - between a command the Hydrawise API refused and the HomeKit
 * characteristic write that puts the optimistic state back. Every revert site schedules against this one constant, so the pause a user sees when a command fails
 * is the same wherever it failed.
 */
export const HYDRAWISE_REVERT_DELAY = 50;

// The suspend-all duration, in seconds. Hydrawise's suspend-all convention pushes the resume boundary one year into the future; a resume sends the current time.
export const HYDRAWISE_SUSPEND_DURATION = 31556926;

/* The value an unenriched controller's FirmwareRevision characteristic carries. This is Homebridge's own unknown-firmware marker - the value it stamps onto every
 * accessory it restores from its cache, before a plugin is handed that accessory - so writing it is how this plugin says "no firmware version is known" in the
 * platform's own vocabulary rather than inventing a second spelling of the same idea.
 *
 * It is a real write rather than an omitted one on purpose. HAP round-trips characteristic values through Homebridge's accessory cache, so an accessory whose
 * firmware was once populated keeps showing that version until something writes over it; without this write, removing the account credentials would strand a real
 * version on display permanently. On a restored accessory the write matches what Homebridge already stamped, which HAP drops as a same-value write, so the
 * unenriched display is exactly what it has always been.
 */
export const HOMEBRIDGE_UNKNOWN_FIRMWARE = "0";

/* The model string HAP constructs a Model characteristic with, mirrored here because this plugin READS it and HAP exposes its own accessor as protected. It is the
 * one signal that tells a brand-new accessory from one restored out of the cache: only an accessory nothing has ever stamped still carries it. That read is what
 * lets the enrichment path leave a restored real model alone while still stamping a fresh accessory with something a user can recognize.
 */
export const HAP_DEFAULT_MODEL = "Default-Model";

/* The ceiling HomeKit itself pins on the RemainingDuration and SetDuration characteristics - hap-nodejs declares 3600 seconds as each characteristic's maximum
 * value - so every duration written to them is capped to this first, and a longer runtime reports as the ceiling rather than tripping HAP's own value clamping.
 */
export const HAP_DURATION_CEILING = 3600;

/* The HAP accessory category a standalone zone accessory declares - Apple's sprinkler category, so the Home app renders a lone irrigation valve as sprinkler rather
 * than as a generic accessory. The value is the Apple-defined protocol number, carried here as a typed numeric constant rather than read off the `Categories` enum:
 * HAP declares that enum as an AMBIENT const enum, and this repo compiles under `verbatimModuleSyntax`, where any value access to an ambient const enum's members
 * is a compile error. The cast keeps the number type-checked against the constructor parameter it feeds while never touching the enum as a value.
 */
export const HYDRAWISE_ZONE_ACCESSORY_CATEGORY = 28 as Categories;

/* How many consecutive polls a standalone zone accessory survives its zone's absence from the wire report before it is treated as genuinely gone. The rule this
 * encodes: a transient wire flake must never destroy a HomeKit identity the user placed in a room, so only SUSTAINED absence - or explicit configuration, which the
 * reconcile tells apart and acts on at once - may remove one.
 */
export const HYDRAWISE_ZONE_ACCESSORY_GRACE_POLLS = 3;

// Default MQTT topic to use when publishing events. This is in the form of: hydrawise/device/event
export const HYDRAWISE_MQTT_TOPIC = "hydrawise";

// The platform the plugin creates.
export const PLATFORM_NAME = "Hydrawise";

// The name of our plugin.
export const PLUGIN_NAME = "homebridge-hunter-hydrawise";
