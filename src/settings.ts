/* Copyright(C) 2017-2026, HJD (https://github.com/hjdhjd). All rights reserved.
 *
 * settings.ts: Settings and constants for homebridge-hunter-hydrawise.
 */
import { Categories } from "homebridge-plugin-utils";
import type { HydrawiseEndpoint } from "./types.ts";
import type { TransportFailureCodedKind } from "homebridge-plugin-utils";

// Hydrawise API response timeout, in seconds.
export const HYDRAWISE_API_TIMEOUT = 7;

// How often, in seconds, should we retry Hydrawise API calls when they fail.
export const HYDRAWISE_API_RETRY_INTERVAL = 60;

/* How many retries the connection pool makes inside one request before it gives up and the caller hears the failure. The library's backoff ladder grows with each
 * retry, so the count is sized for the ladder to settle inside the request timeout above: a failure then reports as itself - a refused connection, a server that
 * kept failing - rather than as the timeout overtaking a retry still in progress.
 */
export const HYDRAWISE_API_RETRY_ATTEMPTS = 2;

/* The statuses the connection pool retries: the server errors, which are worth a second try because they are usually transient trouble on Hydrawise's side. A 400
 * is the server's final word on the request, so a retry would only repeat it; a 404 means the API key is invalid and a 429 that the rate limit has been reached,
 * and each carries a meaning the caller reports at once rather than one a retry could change.
 */
export const HYDRAWISE_API_RETRY_STATUS_CODES = Object.freeze([ 500, 502, 503, 504 ]);

/* How many consecutive failed polls a controller survives before it reads as lost and HomeKit shows its accessories as not responding. Long enough to outlast a
 * blip at the polling cadence, and short enough that a real outage shows within a glance at the Home app. A controller that is lost keeps polling at the same
 * cadence, and the first good poll brings it back.
 */
export const HYDRAWISE_POLL_LOSS_THRESHOLD = 3;

// How much, in seconds, jitter should we inject into the API polling interval. This helps ensure we stay clear of the Hydrawise API rate limits.
export const HYDRAWISE_API_JITTER = 0.2;

/* The longest polling interval, in seconds, a status body's nextpoll hint may ask for: one day. The trade runs both ways. A hint up to it is honored, so the loop
 * sleeps that long and the projection it last adopted stands for the whole wait with no No Response, since nothing fails while the loop sleeps. A hint above it
 * takes the failed-poll path instead - the error line, the clamped retry, and a count toward the loss verdict - so a run of them reads as No Response. The
 * ceiling sits far above any pacing Hydrawise asks for, because refusing a hint it really sent fails the poll, and a run of refusals costs the user a No Response.
 */
export const HYDRAWISE_API_NEXTPOLL_MAX = 86400;

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

/* How many times a command Hydrawise did not answer in time is sent before the plugin stops waiting for it. An unanswered command may or may not have taken, and
 * sending it again is how to find out, so a command that times out is resent for as long as it is still the user's latest choice for its control, up to this
 * many sends in all. Every send draws the command ceiling above, so the count is kept small enough that one unanswered command cannot hold the ceiling for long.
 */
export const HYDRAWISE_COMMAND_ATTEMPTS = 3;

// The one Hydrawise endpoint that carries a zone command, and therefore the one that draws against the stricter command ceiling as well as the account-wide one.
// The platform's draw branch and its command path both read this constant, so the endpoint identity has a single home.
export const HYDRAWISE_COMMAND_ENDPOINT: HydrawiseEndpoint = "setzone.php";

// The base URL every key-based API request is assembled on. The platform derives its connection pool's origin from this one constant, so the host a request goes to
// and the host the pool connects to can never disagree - the same rule the account-credentialed API group below states for its own endpoints.
export const HYDRAWISE_API_BASE_URL = "https://api.hydrawise.com/api/v1/";

// The transport failures the classifier names from a code the error carries - an errno, a transport code, or a certificate verdict - each one a concrete fault
// with a sentence of its own below. The library names this union, so the plugin reads its name rather than deriving it a second time.
export type HydrawiseTransportFault = TransportFailureCodedKind;

/* What each concrete transport fault means to a Hydrawise user, stated once and read by each API client. The key type is the library's own coded-kind union, so
 * a fault kind the library learns to name is a compile error here until this plugin gives it a sentence. The lifetime abort, the deadline, and the unmarked failure are
 * deliberately absent: an abort is silent, a deadline re-arms the catching client's own connection pool and speaks for itself there, and an unmarked failure has
 * nothing better to offer than the error itself.
 */
export const HYDRAWISE_TRANSPORT_FAULT_SENTENCES = Object.freeze({

  "certificate": "Certificate verification failed for the Hydrawise API. Please check the date and time on your Homebridge host.",
  "connect-timeout": "Connection timed out.",
  "destroyed": "A request to the Hydrawise API was interrupted while the connection was being reset.",
  "dns": "Hostname or IP address not found. Please ensure you're connected to the Internet.",
  "refused": "Connection refused.",
  "reset": "Connection has been reset.",
  "retries-exhausted": "Unable to connect to the Hydrawise API. This is usually temporary and will retry automatically.",
  "unreachable": "The Hydrawise API could not be reached. Please ensure you're connected to the Internet."
} satisfies Record<HydrawiseTransportFault, string>);

// What a 429 from the account-credentialed API means to a Hydrawise user, a complete sentence that follows each caller's own sentence with a period.
export const HYDRAWISE_V2_RATE_LIMIT_REASON = "The Hydrawise API rate limit has been exceeded.";

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

/* The v2 per-request timeout, in seconds. Each request carries its own, the token grant and the query alike, and it bounds that request and its body's read. It is
 * deliberately more generous than the v1 timeout: the graph endpoint answers a whole account in one response where a v1 call answers one controller, so the same
 * budget would cut off requests that were simply doing more work.
 */
export const HYDRAWISE_V2_TIMEOUT = 15;

/* How long, in seconds, before an access token expires that the client treats it as due for renewal. The renewal is lazy - it happens on the next call that needs
 * a token, never on a timer - so this window only has to be wider than the gap between noticing and finishing, and a token used inside it is refreshed rather than
 * spent on a request that could expire mid-flight.
 */
export const HYDRAWISE_V2_REFRESH_THRESHOLD = 300;

/* How often, in seconds, the whole-account read that feeds the enhanced features runs. The arithmetic against the envelope above is what fixes the value: the
 * number of reads that fit inside one budget window stays under the read ceiling, leaving slots for the token grants those reads carry. The costliest tick is a
 * refused renewal, where a refresh grant, the password grant it falls back to, and the read they authenticate each draw the read ceiling, and the settings suite
 * holds that tick beside the window's other reads inside the ceiling. A brisker cadence would buy fresher facts at the cost of the headroom that keeps this optional
 * enrichment from ever crowding out the irrigation the account actually depends on.
 */
export const HYDRAWISE_V2_REFRESH_INTERVAL = 900;

// The longest the ladder climbs, in seconds, before jitter, while Hydrawise keeps throttling the refresh. The field reports' lockouts ran up to an hour, so a sleep this
// long outlasts one.
export const HYDRAWISE_V2_BACKOFF_CEILING = 3600;

/* How far past its computed delay a backed-off sleep may run, as a fraction of that delay. The spread is upward only, so a sleep never ends sooner than the ladder
 * asks, while installs and clients throttled together stop returning in step.
 */
export const HYDRAWISE_V2_BACKOFF_JITTER = 0.25;

// The time, in seconds, the facts lifetime below allows beyond two intervals for the requests a refresh makes.
export const HYDRAWISE_V2_FACTS_GRACE = 60;

/* How long, in seconds, a snapshot of the account-credentialed facts stays trustworthy. It is derived from the cadence rather than restated as a literal of its
 * own, so the two can never drift apart. Two intervals are the deliberate ratio: a single missed refresh never flips a consumer to its fallback, while a refresh
 * loop that has genuinely stopped does, and every consumer returns to the answers an install without account credentials gives.
 *
 * The grace is what keeps that promise on the wire. A snapshot is stamped before its request and each sleep starts after one, so the next answer lands past two
 * intervals by the time those requests took, and one missed refresh leaves the facts current while they take under a minute in all.
 */
export const HYDRAWISE_V2_FACTS_TTL = (HYDRAWISE_V2_REFRESH_INTERVAL * 2) + HYDRAWISE_V2_FACTS_GRACE;

// Time until the next zone valve runtime, in seconds, that we should use to indicate that a zone should be marked as active.
export const HYDRAWISE_ACTIVE_ZONE_INDICATOR = 3600;

/* The beat, in MILLISECONDS - unlike this file's other durations, which are stated in seconds - between a HomeKit write the plugin does not keep, a command that
 * did not take among them, and the characteristic write that puts back what the control reads. HAP stores a write only once its set handler has returned, so a
 * write made before then would be overwritten by the very value it was answering. Every revert site schedules against this one constant, so the pause a user sees
 * when a command fails is the same wherever it failed.
 */
export const HYDRAWISE_REVERT_DELAY = 50;

// The suspend-all duration, in seconds. Hydrawise's suspend-all convention pushes the resume boundary one year into the future; a resume sends the current time.
export const HYDRAWISE_SUSPEND_DURATION = 31556926;

/* The value an unenriched controller's FirmwareRevision characteristic carries. This is Homebridge's own unknown-firmware marker - the value it stamps onto every
 * accessory it restores from its cache, before a plugin is handed that accessory - so writing it is how this plugin says "no firmware version is known" in the
 * platform's own vocabulary rather than inventing a second spelling of the same idea.
 *
 * It is a real write rather than an omitted one on purpose. Homebridge stamps it on every accessory it restores, while a fresh accessory carries HAP's own default
 * version instead, so the write is what gives an unenriched controller one spelling of an unknown version whichever way its accessory arrived. On a restored
 * accessory the write matches what Homebridge already stamped, because the platform writes a persisted version over that stamp only on a controller accessory
 * while the account credentials are configured, which is never where this write runs. HAP therefore sends HomeKit no event for it, and an unenriched display
 * reads Homebridge's own marker.
 */
export const HOMEBRIDGE_UNKNOWN_FIRMWARE = "0";

/* The model string HAP constructs a Model characteristic with, mirrored here because this plugin READS it and HAP exposes its own accessor as protected. It is the
 * one signal that tells a brand-new accessory from one restored out of the cache: only an accessory nothing has ever stamped still carries it. That read is what
 * lets the enrichment path leave a restored real model alone while still stamping a fresh accessory with something a user can recognize.
 */
export const HAP_DEFAULT_MODEL = "Default-Model";

/* The ceiling HomeKit itself places on the RemainingDuration and SetDuration characteristics - hap-nodejs declares 3600 seconds as each characteristic's maximum
 * value - so every duration written to them is capped to this first, and a longer runtime reports as the ceiling rather than tripping HAP's own value clamping.
 */
export const HAP_DURATION_CEILING = 3600;

/* The run time, in seconds, a zone starts for from HomeKit when Hydrawise has never given it a scheduled run time to mirror. Hydrawise requires a length for every
 * run it starts, so a zone needs some answer here, and a short one is the conservative choice: a run nobody meant to start wastes the least water.
 */
export const HYDRAWISE_DEFAULT_RUN_DURATION = 300;

// The HAP accessory category a standalone zone accessory declares - Apple's sprinkler category, so the Home app renders a lone irrigation valve as a sprinkler
// rather than as a generic accessory. The mirror is compiler-locked against hap-nodejs's own declaration, so the value can never drift from what HAP defines.
export const HYDRAWISE_ZONE_ACCESSORY_CATEGORY = Categories.SPRINKLER;

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
