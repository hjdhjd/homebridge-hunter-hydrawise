/* Copyright(C) 2020-2026, HJD (https://github.com/hjdhjd). All rights reserved.
 *
 * types.ts: Interface and type definitions for Hydrawise.
 */
import { resolveNameOverride, sameEntries, sanitizeName } from "homebridge-plugin-utils";
import type { Nullable } from "homebridge-plugin-utils";
import type { PlatformAccessory } from "homebridge";

// HBHH reserved names.
export const HydrawiseReservedNames = {

  // Manage our switch types. The account-wide switch names itself outright, while the per-zone switches share a PREFIX that the zone's own relay id completes, since
  // a controller carries one of the first and one of the second per zone.
  SWITCH_SUSPEND_ALL: "All",
  SWITCH_SUSPEND_ZONE: "Suspend."
} as const;

export type HydrawiseReservedNames = typeof HydrawiseReservedNames[keyof typeof HydrawiseReservedNames];

/* Compose the service subtype a zone's companion suspension switch carries. Every site that creates, looks up, or sweeps one of these switches composes its subtype
 * here, so the shape lives in exactly one place and a change to it reaches all of them at once.
 *
 * The prefix is what makes the sweep safe. A per-zone switch and the account-wide switch share the Switch service UUID, so a sweep matching on that UUID alone would
 * destroy the account-wide switch alongside the zone switches it was aiming at; matching the composed prefix is what tells the two apart.
 */
export function suspendZoneSubtype(relayId: number): string {

  return HydrawiseReservedNames.SWITCH_SUSPEND_ZONE + relayId.toString();
}

// Whether a service subtype names a zone's companion suspension switch. This is the recognition half of the composition above and lives beside it deliberately, so
// the two readings of the prefix cannot drift apart. A service carrying no subtype, or one carrying any other name, is not this sweep's business.
export function isSuspendZoneSubtype(subtype: string | undefined): boolean {

  return subtype?.startsWith(HydrawiseReservedNames.SWITCH_SUSPEND_ZONE) ?? false;
}

// Hydrawise API: the endpoints this plugin calls. Naming them as a union rather than a bare string keeps the platform's rate-ceiling classification total: a call
// site can only name an endpoint the platform has already decided which budgets to draw against, so a typo or a newly added endpoint is a compile error rather
// than a call that quietly slips past the stricter command ceiling.
export type HydrawiseEndpoint = "customerdetails.php" | "setzone.php" | "statusschedule.php";

// Hydrawise API: Hydrawise irrigation controller configuration.
export interface HydrawiseControllerConfig {

  controller_id: number;
  last_contact: number;
  name: string;
  serial_number: string;
  status: string;
}

// Hydrawise API: Hydrawise zone configuration.
export interface HydrawiseZoneConfig {

  master_timer?: number;
  master?: number;
  name: string;
  relay: number;
  relay_id: number;
  run: number;
  time: number;
  timestr: string;
}

/* Hydrawise API: the far-future `time` value Hydrawise reports for a zone with no upcoming run. `time` counts the seconds until a zone's next run, and this value is
 * exactly fifty years of seconds - the wire's spelling of "never". The value is fixed by the upstream API, so the runtime's classification path names it once here
 * and everything that classifies a zone's schedule state reads it from this one place.
 *
 * Live-wire evidence (2026-08-08) pins what this sentinel can and cannot claim: a zone routinely carries it on a healthy account simply because Hydrawise has not
 * yet published its next run - most visibly in the hours after a zone's run completes - and that shape is byte-identical to a zone the owner suspended. The sentinel
 * therefore supports only the claim "no run is scheduled", never "suspended". A zone carrying it that a rain-class sensor's relay list also names is stopped by that
 * sensor when the group that sensor covers is evidently stopped, and the sensor check takes precedence wherever both could apply.
 */
export const HYDRAWISE_UNSCHEDULED_SENTINEL = 1576800000;

// Hydrawise API: the `type` value Hydrawise assigns a rain or freeze sensor. A status body can carry sensors of several classes, and only one of this class can stop
// a zone's irrigation, so this is the value every sensor walk filters on.
export const HYDRAWISE_RAIN_SENSOR_TYPE = 1;

// Hydrawise API: customer details endpoint response JSON. This endpoint returns all the controllers associated with a given customer's account.
export interface CustomerDetailsResponse {

  controller_id: number;
  current_controller: string;
  customer_id: number;
  controllers: HydrawiseControllerConfig[];
}

// Hydrawise API: status schedule endpoint response JSON. This endpoint returns watering schedules for controllers.
export interface StatusScheduleResponse {

  message: string;
  nextpoll: number;
  relays: HydrawiseZoneConfig[];
  sensors: {

    input: number;
    mode: number;
    relays: {

      id: number;
    }[];

    type: number;
  }[];

  time: number;
}

// Hydrawise API: set zone endpoint request JSON. This endpoint is used to manually change the zone status (e.g. run, stop, and suspend).
export interface SetZoneRequest {

  action?: "stop" | "run" | "suspend" | "stopall" | "runall" | "suspendall";
  api_key?: string;
  controller_id?: number;
  custom?: number;
  period_id?: number;
  relay_id?: number;
}

// Hydrawise API: set zone endpoint response JSON. This endpoint is used to manually change the zone status (e.g. run, stop, and suspend).
export interface SetZoneResponse {

  message: string;
  message_type: "error" | "info";
}

/* What became of one command sent to the key-based API, as a discriminated union rather than a bare response, because each outcome asks the caller for something
 * different.
 *
 * "confirmed" means Hydrawise answered that the command took. "refused" means it did not, and a resend would meet the same answer: Hydrawise said so in its reply,
 * or the platform refused the status it came back with. "unreadable" means a reply arrived and its verdict could not be read: a body that does not parse, carries
 * no message type this plugin knows, or failed partway through for any reason but a deadline or a shutdown. The command may have taken, but nothing in the reply
 * says so, and it is not resent. "timeout" means no answer arrived inside the request deadline, so the command may or may not have taken, and a resend is how to
 * find out. "failed" means the request did not complete for a reason a resend would only run into again: the rate limit, a server error the transport already
 * retried, or a transport fault. "aborted" means the command was withdrawn before it reached the wire, or Homebridge is shutting down, and neither is news.
 *
 * A refusal's reason is Hydrawise's own message for a refusal in its reply, or the platform's sentence for a status it refused. An unreadable reply's reason is the
 * platform's one sentence for a reply it could not read. A failure's reason is the platform's sentence for what went wrong. The platform's request log has already
 * logged a refused status and every failure, each in the sentence its reason gives, apart from a failure carrying no marker, which it logs as the error's full dump,
 * and it logs nothing for a refusal in the reply or an unreadable reply, so a caller that names the reason beside the command it was sending is saying which command
 * that answer was about.
 */
export type HydrawiseCommandOutcome = { status: "aborted" | "confirmed" | "timeout" } | { reason: string; status: "failed" | "refused" | "unreadable" };

/* What became of one read of the whole account's facts, as a discriminated union rather than a nullable map, because the refresh loop paces itself by more than
 * whether facts arrived. "answered" carries the facts, which an empty map still is when a read that went well found nothing to enrich. "failed" means the read
 * left nothing to enrich from, and the client has already said why wherever there was anything to say. "throttled" means Hydrawise answered the read or its token
 * grant with a 429, the one failure a run of which slows the refresh.
 */
export type HydrawiseV2Read = { facts: Map<number, HydrawiseControllerV2Facts>; status: "answered" } | { status: "failed" | "throttled" };

/* Hydrawise v2 API: the OAuth2 token endpoint's response, typed to the fields the client consumes. The lifetime arrives as a duration in seconds rather than
 * an instant, so the client turns it into an absolute expiry against its own clock at the moment it reads the response.
 *
 * Every field is optional, because this describes untrusted JSON rather than a promise the wire keeps. Each absence has its own honest handling: a grant carrying
 * no access token is a failed grant, a grant stating no lifetime is treated as expiring at once, and a grant answering with no refresh token is still perfectly
 * usable - the client simply re-authenticates with the account credentials when that access token runs out.
 */
export interface HydrawiseV2TokenResponse {

  access_token?: string;
  expires_in?: number;
  refresh_token?: string;
}

/* Hydrawise v2 API: the path to the value one error cost, field names and list indexes in order, read from the root of the response's data or from an entry within
 * it. It is what says which answers cannot be believed, because the server answers a failed field with a null that reads the same as a real absence.
 */
export type HydrawiseV2ErrorPath = readonly (number | string)[];

// Hydrawise v2 API: one entry of a response's errors array, typed to the fields the client consumes.
export interface HydrawiseV2GraphError {

  message?: string;
  path?: HydrawiseV2ErrorPath;
}

/* Hydrawise v2 API: the envelope every GraphQL response arrives in, parameterized by the selection's own data shape. Each field is optional because each absence
 * is real: a request that failed carries errors and no data, a query that partly failed carries both, and a malformed answer can carry neither.
 *
 * The errors array is what makes GraphQL failure classification different from REST. The v2 endpoint answers a failed query with HTTP 200 and reports the failure in
 * the body, so a status-code check alone would read a failure as a success. A field that errors beside others that did not costs only its own entry: the server nulls
 * the nearest entry that may be null, a list element above all, and answers everything else, which is why the lists below type their entries nullable.
 */
export interface HydrawiseV2GraphResponse<T> {

  data?: T;
  errors?: HydrawiseV2GraphError[];
}

/* Hydrawise v2 API: one entry of a controller's firmware list. A controller reports firmware as a LIST of typed components rather than a single version string -
 * the capture from a live HCC controller carries an entry of type "controller" - so reading a version means selecting the entry whose type names it, never taking
 * the first entry. Every field is optional because a partial hardware block is a shape the wire can produce for an offline or unlinked controller.
 */
export interface HydrawiseV2FirmwareEntry {

  type?: string;
  version?: string;
}

// Hydrawise v2 API: the model block of a controller's hardware. The description is the full marketing name a user recognizes ("HCC 38 Zones"), where the sibling
// name field carries the shorter capacity fragment alone ("38 Zones"); the description is what this plugin projects into HomeKit.
export interface HydrawiseV2ModelBlock {

  description?: string;
}

// Hydrawise v2 API: the hardware block of a controller, typed to the fields this plugin reads. Every field is optional for the same reason the firmware entry's
// are: a controller that is offline or not linked to the account can answer with a partial block, and typing off the one healthy capture would make that a crash.
export interface HydrawiseV2HardwareBlock {

  firmware?: Nullable<HydrawiseV2FirmwareEntry>[];
  model?: HydrawiseV2ModelBlock;
}

/* Hydrawise v2 API: one zone as the account query returns it. The id is the correlation key that matches a v2 zone to the v1 zone this plugin polls - the live
 * captures show the two carrying the same numbers one for one, the same agreement the controller id enjoys.
 *
 * suspendedUntil is a nullable DateTime OBJECT rather than a scalar, which is why the selection asks for its timestamp: a zone under no suspension answers null
 * here, and a suspended zone answers the absolute instant its suspension lifts.
 */
export interface HydrawiseV2Zone {

  id?: number;
  name?: string;
  status?: { suspendedUntil?: Nullable<{ timestamp?: number }> };
}

/* Hydrawise v2 API: one sensor as the account query returns it, typed to the facts a rain-class stop is read from - what kind of sensor it is, whether it
 * is tripped right now, and which zones it covers.
 *
 * The activity flag is what v1 cannot report at all. A v1 status body carries a sensor block naming the zones a sensor covers but nothing about whether that
 * sensor is currently stopping them, which is the whole reason the v1 path has to infer a stop from the shape of the group it covers.
 */
export interface HydrawiseV2Sensor {

  model?: { sensorType?: string };
  status?: { active?: boolean };
  zones?: Nullable<{ id?: number }>[];
}

/* Hydrawise v2 API: one controller as the account query returns it. The id is the correlation key that matches a v2 controller to the v1 controller this plugin
 * discovered - the live capture shows it carrying the same number as v1's controller_id, while the sibling deviceId is a different number entirely, so keying on
 * deviceId would silently match nothing.
 *
 * The availability flag is read from the nested status block rather than the flat sibling field of the same name: both read true in every capture, and the
 * nested one is the field the selection asks for.
 */
export interface HydrawiseV2Controller {

  hardware?: HydrawiseV2HardwareBlock;
  id?: number;
  name?: Nullable<string>;
  sensors?: Nullable<HydrawiseV2Sensor>[];
  status?: { online?: boolean };
  zones?: Nullable<HydrawiseV2Zone>[];
}

// Hydrawise v2 API: the data half of the whole-account query. One query answers for every controller on the account, which is what lets the platform fetch once
// and distribute rather than spending a call per controller against a budget measured in single digits.
export interface HydrawiseV2Account {

  me?: { controllers?: Nullable<HydrawiseV2Controller>[] };
}

/* Hydrawise v2 API: the prefix marking the sensor kinds that report a level - the family a rain or freeze sensor belongs to, and the only family whose activity
 * can stop a zone's irrigation. The live capture records the owner's rain and freeze sensor answering LEVEL_CLOSED, and the schema declares the field as an
 * enumeration whose values it does not publish, so matching the family by its prefix is what keeps a sibling spelling from reading as an unknown kind.
 *
 * A sensor of any other kind, or one naming no kind at all, contributes no answer rather than a negative one. That is the deliberate degradation: an unknown
 * sensor routes every zone it covers back to the v1 group inference, which is exactly the behavior an install without account credentials gets.
 */
export const HYDRAWISE_V2_LEVEL_SENSOR_PREFIX = "LEVEL_";

// Hydrawise v2 API: the firmware list's `type` value naming the controller's own firmware, as opposed to the per-module versions the same hardware block reports
// separately. The selection rule reads this constant, so the entry that counts as the controller's firmware is named in exactly one place.
export const HYDRAWISE_V2_CONTROLLER_FIRMWARE = "controller";

/* The hardware facts of a single irrigation controller: the model name and the firmware version, as HomeKit's AccessoryInformation service shows them.
 *
 * This shape is IN MEMORY only, and deliberately so. It is composed from one wire answer, carried as far as the characteristic writes, and then dropped. HAP
 * retains characteristic values across restarts through Homebridge's accessory cache, so the model's characteristic is its only store, and a second copy would
 * be two stores of one fact that eventually disagree. The firmware is the one exception: Homebridge overwrites its characteristic with a placeholder on every
 * restore, so the controller accessory's context carries the version as well, as the context's own comment below explains.
 *
 * Both fields are required strings, which is the whole point of the compose helper below returning null on a partial answer: a half-populated shape would put a
 * real model beside an empty firmware and leave HomeKit showing a fact this plugin never learned.
 */
export interface HydrawiseControllerHardware {

  firmware: string;
  model: string;
}

/* Project a wire hardware block onto the displayed shape, or answer null when the wire did not carry enough to populate it. This is the one home for both selection
 * rules, so what "the model" and "the firmware" mean is decided once rather than at each read site.
 *
 * The model is the wire's own description, the full name a user recognizes. The firmware is the version of the list entry whose type names the controller itself,
 * which is why the walk searches by type instead of taking the first entry - a controller reports its modules' firmware in the same list, in no guaranteed order.
 *
 * Answering null rather than a partial shape is deliberate. A controller whose hardware block is incomplete is simply not enriched, and the placeholder stands,
 * which is a truthful display; populating one field and leaving the other empty would not be.
 */
export function controllerHardware(hardware: HydrawiseV2HardwareBlock | undefined): Nullable<HydrawiseControllerHardware> {

  const model = hardware?.model?.description;
  const firmware = hardware?.firmware?.find(entry => entry?.type === HYDRAWISE_V2_CONTROLLER_FIRMWARE)?.version;

  if(!model?.length || !firmware?.length) {

    return null;
  }

  return { firmware, model };
}

// Validate a firmware version read back from a controller accessory's context: a non-empty string, which is the only value the facts adoption ever writes there,
// since the compose helper above refuses an empty one. A malformed value counts as absent, so a corrupt cache entry is never displayed.
export function isFirmwareVersion(value: unknown): value is string {

  return (typeof value === "string") && (value.length > 0);
}

/* What the account-credentialed API knows about a single zone that the key-based API cannot express: the zone's full name, whether a rain-class sensor is stopping
 * it right now, and the instant any suspension on it lifts.
 *
 * Each field distinguishes three answers rather than two, and the null arm is the one that carries the weight. A null sensorStopped means the account read
 * carried no usable sensor answer for this zone, which routes the zone back to the v1 group inference; a false means the sensors are live and quiet, which
 * retires that inference outright. Reading either as a plain boolean would turn "we do not know" into "it is not stopped" and silently suppress a real rain
 * delay. suspendedUntil is an absolute epoch instant so it holds still between polls, and null simply means no suspension stands.
 *
 * The name is the one field that is not about state at all. The key-based API truncates a zone name at roughly fifteen characters - "Backyard Plante" for a zone
 * the account calls "Backyard Planters Drip" - and the account API carries it whole, so a null here means only that no usable name arrived and the wire's own
 * truncated form still stands.
 */
export interface HydrawiseZoneV2Facts {

  name: Nullable<string>;
  sensorStopped: Nullable<boolean>;
  suspendedUntil: Nullable<number>;
}

/* What the account-credentialed API knows about a whole controller: its hardware, its own full name, whether Hydrawise can currently reach it, and the per-zone
 * facts above keyed by the zone id v1 and v2 agree about.
 *
 * The name follows the zone name's rule at the controller grain, and the null arm means the same thing: no usable name arrived, so whatever the key-based wire
 * reported still stands. Reading it as an empty string instead would blank a controller's label on an answer that simply said nothing.
 *
 * This shape is IN MEMORY only, on the same terms and for the same reason as the hardware shape above. What gets persisted is the CLASSIFIED projection these
 * facts feed, never the facts themselves - one store for a zone's state rather than two that eventually disagree about it.
 */
export interface HydrawiseControllerV2Facts {

  hardware: Nullable<HydrawiseControllerHardware>;
  name: Nullable<string>;
  online: Nullable<boolean>;
  zones: Map<number, HydrawiseZoneV2Facts>;
}

// A name from the account API as a display can use it: trimmed, and required to be non-empty, because an empty or whitespace-only answer is not a name. It composes
// null, which leaves the key-based wire's own name standing rather than blanking a label.
function usableName(name: Nullable<string> | undefined): Nullable<string> {

  const trimmed = name?.trim();

  return trimmed?.length ? trimmed : null;
}

// Whether a sensor entry is one a rain-class stop is read from: a level-class sensor actually reporting its activity as a boolean.
function countsAsRainSensor(sensor: Nullable<HydrawiseV2Sensor>): sensor is HydrawiseV2Sensor {

  return (sensor?.model?.sensorType?.startsWith(HYDRAWISE_V2_LEVEL_SENSOR_PREFIX) ?? false) && (typeof sensor?.status?.active === "boolean");
}

/* Project one controller's wire answer onto the facts shape above. This is the one home for every selection rule the account query's richer body needs, so what
 * "suspended", "sensor-stopped", and "reachable" mean is decided once rather than at each read site.
 *
 * The sensor derivation is the substantial half. Only level-class sensors are weighed, and only those actually reporting their activity as a boolean: a sensor
 * of an unrecognized kind, or one whose activity the response did not carry, contributes nothing at all. With no such sensor in the answer every zone's
 * sensorStopped is null, which hands the whole question back to the v1 group inference. With at least one, a zone reads true when SOME sensor covering it is
 * tripped and false otherwise - some rather than every, because one tripped sensor stops the zones it covers whatever its siblings report, and an uncovered
 * zone is honestly not stopped rather than unknown.
 *
 * A bad field is never believed, and the errors' paths decide what that costs, each path arriving relative to this controller's entry. The sensor list is incomplete
 * when an error names it, when it holds a null entry, or when a counted sensor's covered zones are absent or hold a null entry. Any of those makes every zone's
 * sensorStopped null, because a zone only the unread sensor covers would otherwise read as clear, retiring the inference that would have caught a real rain stop. A
 * zone an error names is omitted, the rule for any entry that cannot be completed, so a suspension nulled by an error keeps its carry rather than reading as lifted.
 */
export function controllerV2Facts(controller: HydrawiseV2Controller, errorPaths: readonly HydrawiseV2ErrorPath[] = []): HydrawiseControllerV2Facts {

  const entries = controller.sensors ?? [];
  const sensors = entries.filter(countsAsRainSensor);
  const incomplete = errorPaths.some(path => path[0] === "sensors") || entries.includes(null) || sensors.some(sensor => !sensor.zones || sensor.zones.includes(null));
  const erredZones = new Set(errorPaths.filter(path => path[0] === "zones").map(path => path[1]));
  const zones = new Map<number, HydrawiseZoneV2Facts>();

  for(const [ index, zone ] of (controller.zones ?? []).entries()) {

    // A zone whose entry cannot be completed is deliberately omitted rather than entered as a blank: an absent entry reads as "unknown" everywhere downstream,
    // where a present one is a real answer that clears or reasserts a zone's state. An id is held to being a number because a null can sit under a non-null marker.
    if((typeof zone?.id !== "number") || erredZones.has(index)) {

      continue;
    }

    const covering = sensors.filter(sensor => (sensor.zones ?? []).some(covered => covered?.id === zone.id));

    zones.set(zone.id, { name: usableName(zone.name), sensorStopped: (sensors.length && !incomplete) ? covering.some(sensor => sensor.status?.active === true) : null,
      suspendedUntil: zone.status?.suspendedUntil?.timestamp ?? null });
  }

  return { hardware: controllerHardware(controller.hardware), name: usableName(controller.name), online: controller.status?.online ?? null, zones };
}

/* What one call for an access token came to, as a discriminated union so a caller can carry a 429 up the chain rather than reading every refusal as the same absence.
 * "granted" carries the token. "failed" means no token came, which the grant has already reported in its own words unless it was teardown, and "throttled" means
 * Hydrawise answered the grant with a 429, reported on the same terms.
 */
export type HydrawiseV2Grant = { accessToken: string; status: "granted" } | { status: "failed" | "throttled" };

/* The v2 client's OAuth token state, as a discriminated union so the access token, its expiry, and any refresh in flight can never disagree with one another. One
 * shape and one mutation point is what makes that structural rather than a convention each write site has to honor.
 *
 * The states are the whole lifecycle. "none" is no usable token, which is both the starting state and where a failed acquisition returns to, a renewal Hydrawise
 * answered with trouble of its own excepted, which returns to the "valid" it renewed from. "valid" carries a token and the instant it expires. "refreshing" carries
 * the in-flight acquisition, and it is the single-flight mechanism itself: both paths that reach the network - a first acquisition and a renewal - transition here
 * synchronously before their first await, so concurrent callers join the one promise rather than each firing a grant of their own. There is deliberately no separate
 * "acquiring" state; an acquisition and a renewal are the same wait to every caller.
 */
export type HydrawiseV2TokenState =
  { state: "none" } |
  { accessToken: string; expiresAt: number; refreshToken: Nullable<string>; state: "valid" } |
  { pending: Promise<HydrawiseV2Grant>; state: "refreshing" };

// The persisted identity of a single irrigation controller. This is the denormalized, wire-independent shape the runtime writes into the accessory context and the
// webUI reads back from the accessory cache and the /refreshControllers response, so a stopped plugin's controller list stays answerable without any cloud call. It
// carries only the identity fields the webUI needs to list, scope, and refresh a controller - never any volatile status.
export interface HydrawiseControllerIdentity {

  controllerId: number;
  name: string;
  serialNumber: string;
}

// The persisted identity of a single irrigation zone, written into the accessory context on change and read back by the webUI's zone list. Like the controller
// identity above it carries only the stable fields a zone listing needs - the relay display index, the relay id the runtime scopes zone options against, and the
// display name - and never the volatile schedule state the wire zone also carries.
export interface HydrawiseZoneIdentity {

  name: string;
  relay: number;
  relayId: number;
}

// The protocol and persistence infix joining a controller id to a relay id to form a standalone zone accessory's unique device id. This value is persistence-critical
// identity: it seeds the cached HomeKit UUID of every standalone zone accessory, so any drift here orphans every cached zone accessory on every install in the field.
// Treat it as immutable.
export const HYDRAWISE_ZONE_ACCESSORY_ID_INFIX = ".Zone.";

// Compose the unique device identifier of a zone's standalone accessory from its owning controller's id and its own relay id. Every consumer that mints or matches a
// zone accessory's UUID derives it here, so the seed has exactly one home. The compound controller-plus-relay seed is also what makes relay-id uniqueness ACROSS
// controllers irrelevant: two controllers reporting the same relay id still compose to different device ids.
export function zoneAccessoryId(controllerId: number, relayId: number): string {

  return controllerId.toString() + HYDRAWISE_ZONE_ACCESSORY_ID_INFIX + relayId.toString();
}

// Project a wire controller onto its persisted identity shape. This is the single derivation every writer of a controller identity - the platform's account roster,
// the controller's own context seed, the zone accessory's owner stamp - goes through, so the persisted shape cannot drift between the sites that write it.
export function controllerIdentity(controller: HydrawiseControllerConfig): HydrawiseControllerIdentity {

  return { controllerId: controller.controller_id, name: controller.name, serialNumber: controller.serial_number };
}

// Project a wire zone onto its persisted identity shape, naming each field explicitly rather than spreading the wire zone so the identity carries identity alone.
// The zone's volatile schedule facts have a persisted home of their own below, under their own type and their own flush discipline; keeping the two derivations
// apart is what lets each carry the cadence it deserves. Like the controller projection above, this is the one home for the derivation.
export function zoneIdentity(zone: HydrawiseZoneConfig): HydrawiseZoneIdentity {

  return { name: zone.name, relay: zone.relay, relayId: zone.relay_id };
}

// Validate a persisted controller identity read back from the accessory cache: an object carrying every identity field with the right type. A malformed value counts
// as absent, so a corrupt cache entry is classified rather than trusted.
export function isControllerIdentity(value: unknown): value is HydrawiseControllerIdentity {

  return (typeof value === "object") && (value !== null) && (typeof (value as HydrawiseControllerIdentity).controllerId === "number") &&
    (typeof (value as HydrawiseControllerIdentity).name === "string") && (typeof (value as HydrawiseControllerIdentity).serialNumber === "string");
}

// Validate a persisted zone identity, with the same rigor and for the same reason as the controller guard above.
export function isZoneIdentity(value: unknown): value is HydrawiseZoneIdentity {

  return (typeof value === "object") && (value !== null) && (typeof (value as HydrawiseZoneIdentity).name === "string") &&
    (typeof (value as HydrawiseZoneIdentity).relay === "number") && (typeof (value as HydrawiseZoneIdentity).relayId === "number");
}

// Compare two controller identities field-wise. Never by reference: every writer builds a fresh projection through controllerIdentity above, so a reference check
// would report every comparison as differing and drive a write the values do not justify.
export function sameControllerIdentity(a: HydrawiseControllerIdentity, b: HydrawiseControllerIdentity): boolean {

  return (a.controllerId === b.controllerId) && (a.name === b.name) && (a.serialNumber === b.serialNumber);
}

// Compare two zone identities field-wise, for the same reason as the controller comparison above.
export function sameZoneIdentity(a: HydrawiseZoneIdentity, b: HydrawiseZoneIdentity): boolean {

  return (a.relayId === b.relayId) && (a.relay === b.relay) && (a.name === b.name);
}

/* The words a controller and a zone are named by where HomeKit can carry nothing of any name they could take. HomeKit refuses an accessory minted under a name
 * its naming rules empty, so a controller or zone Hydrawise names in emoji or punctuation alone would fail its mint, and its kind is the one thing the plugin can
 * always call it. A zone's word is followed by its relay number, so the zones of one controller that take it stay told apart.
 */
export const HYDRAWISE_CONTROLLER_FALLBACK_NAME = "Controller";
export const HYDRAWISE_ZONE_FALLBACK_NAME = "Zone";

// Where a composed name came from: the kind's word, the user's Name option, or the name Hydrawise reports. A reader asking whether the kind's word applies reads
// this tag rather than comparing the name with the word, because a controller or zone its owner named "Controller" or "Zone 3" carries the word on its own.
export type HydrawiseNameSource = "fallback" | "override" | "reported";

// A composed name and the source it came from.
export interface HydrawiseComposedName {

  readonly name: string;
  readonly source: HydrawiseNameSource;
}

/* The rule every composer below shares, short of the kind's word: the user's Name option where HomeKit can carry it, through HBPU's override resolution, then the
 * reported name where HomeKit can carry that, and null where it can carry neither, which is the caller's cue to answer its kind's word. The name answered is the
 * chosen text as it stands, unsanitized, because every HomeKit write sanitizes the name it applies.
 */
function chooseName(override: Nullable<string> | undefined, reported: string): Nullable<HydrawiseComposedName> {

  const resolved = resolveNameOverride(override);

  if(resolved !== null) {

    return { name: resolved, source: "override" };
  }

  return sanitizeName(reported).length ? { name: reported, source: "reported" } : null;
}

/**
 * The name a controller carries in HomeKit: the user's Name option where HomeKit can carry it, the name reported for the controller where HomeKit can carry that,
 * and the controller word otherwise, so every name it answers is one HomeKit accepts. Every site that names a controller, the mint, its services' creation and the
 * rename pass, composes through here, and the settings page mirrors it in its own naming module.
 *
 * @param options          - The controller's names.
 * @param options.override - The raw value of the controller's Name option, as the option engine answers it.
 * @param options.reported - The name the controller is known by: Hydrawise's own, or the name HomeKit already carries for it.
 *
 * @returns The composed name and the source it came from.
 */
export function controllerDisplayName({ override, reported }: { override?: Nullable<string>; reported: string }): HydrawiseComposedName {

  return chooseName(override, reported) ?? { name: HYDRAWISE_CONTROLLER_FALLBACK_NAME, source: "fallback" };
}

/**
 * The name a zone carries in HomeKit, on the terms {@link controllerDisplayName} states, the zone word followed by its relay number answering where HomeKit can
 * carry nothing of the Name option or the reported name. Every site that names a zone, its standalone accessory, its valve and its companion switch, composes
 * through here.
 *
 * @param options          - The zone's names.
 * @param options.override - The raw value of the zone's Name option, as the option engine answers it.
 * @param options.relay    - The zone's relay number, the one the controller itself displays.
 * @param options.reported - The name the zone is known by.
 *
 * @returns The composed name and the source it came from.
 */
export function zoneDisplayName({ override, relay, reported }: { override?: Nullable<string>; relay: number; reported: string }): HydrawiseComposedName {

  return chooseName(override, reported) ?? { name: HYDRAWISE_ZONE_FALLBACK_NAME + " " + relay.toString(), source: "fallback" };
}

/* The persisted schedule state of a single irrigation zone, as a discriminated union on `state`: each arm carries exactly the facts that exist in that state, so a
 * combination the wire cannot produce - a running zone with a next run time, an unscheduled zone with a duration - cannot be written at all rather than merely being
 * left unwritten by convention.
 *
 * The running arm deliberately carries no duration. The wire's `run` field counts the remaining seconds down while a zone runs, so persisting it would move the
 * projection on every poll and defeat the change gate the flush discipline rests on. The stable fact is the instant the run ends; the remaining time is derived
 * from it at render.
 *
 * The suspended arm is claimed only on account-credentialed evidence. The key-based wire gives a suspended zone, a zone between schedule computations, and a
 * rain-stopped zone whose sensor evidence falls short one identical body, so nothing in it can support the claim; the account API answers per-zone suspension
 * first-class, and this arm carries the instant that suspension lifts as an ABSOLUTE epoch second so it holds still poll after poll.
 *
 * The unscheduled arm therefore claims exactly what remains: Hydrawise reports no upcoming run, and no stronger reading of that silence is available. Without
 * account credentials it goes on covering a suspended zone too, which is the honest answer when nothing can tell the two apart.
 */
export type HydrawiseZoneScheduleStatus =
  { endsAt: number; relayId: number; state: "running" } |
  { durationSeconds: number; nextRunAt: number; relayId: number; state: "scheduled" } |
  { relayId: number; state: "sensor-stopped" } |
  { relayId: number; state: "suspended"; until: number } |
  { relayId: number; state: "unscheduled" };

// The schedule-state vocabulary, derived from the union's own arms rather than written out a second time, so the two can never disagree about which states exist.
export type HydrawiseZoneScheduleState = HydrawiseZoneScheduleStatus["state"];

/* The persisted schedule projection of a whole controller: every reported zone's schedule state ordered by relay, alongside the facts a consumer needs to read
 * them honestly. It is self-describing - activeWindowSeconds travels with the data, so no consumer has to hardcode the threshold the runtime classifies against -
 * and it is wire truth only: asOf is the WIRE's own root time from the poll that last CHANGED these facts, never a local clock read, so a consumer can tell how old
 * the facts are rather than how recently they were re-confirmed.
 */
export interface HydrawiseScheduleStatus {

  activeWindowSeconds: number;
  asOf: number;
  online?: boolean;
  zones: HydrawiseZoneScheduleStatus[];
}

// The wire shape a zone with no upcoming run carries: no run time, no schedule string, and the unscheduled sentinel on `time`. A rain-sensor stop, an owner's
// suspension, and a zone simply between schedule computations all present exactly this shape, which is why the sensor test below reads a whole group of zones
// rather than reading this shape alone.
function carriesUnscheduledSentinel(zone: HydrawiseZoneConfig): boolean {

  return !zone.run && !zone.timestr && (zone.time === HYDRAWISE_UNSCHEDULED_SENTINEL);
}

/* Whether a zone is stopped by a rain sensor: the zone carries the unscheduled shape, and a rain-class sensor whose relay list names it is evidently stopping the
 * zones it covers. Those conditions together are what tell a sensor stop from the shape's other producers, since the wire gives them all the identical zone body.
 *
 * The group rule is physical. A rain sensor stops every zone it covers, so a covered zone still carrying a live schedule proves that sensor is not tripping, and
 * any covered zone beside it carrying the unscheduled shape is merely without a run rather than sensor-stopped. A sensor is evidently stopping when every zone of
 * its group carries that shape.
 *
 * A running zone sits outside the group deliberately. Forcing a manual run during a genuine rain delay is plausible, so a running zone is evidence either way and
 * settles nothing; leaving it out keeps sensor precedence - the standing tiebreak wherever this wire is ambiguous - rather than letting one manual run reclassify
 * every covered sibling. The group filter recognizes a running zone by the wire's own spelling of it, time === 1, the same literal zoneScheduleStatus reads first
 * below for the identical reason.
 *
 * Callers pass a zone drawn from the same response's relay list. A zone carrying the unscheduled shape is never running, so it always belongs to any covering
 * sensor's group and the group walk is never empty. This is the one home for the rule: the controller's own check and the schedule projection below both resolve
 * here, so the log the operator reads and the projection the webUI reads cannot disagree. One limit is worth naming - an account whose every covered zone carries
 * the shape reads the same whether a sensor stopped it, the owner suspended all of it, or every zone merely sits between runs, and sensor precedence decides it.
 */
export function isZoneStoppedBySensor(zone: HydrawiseZoneConfig, status: StatusScheduleResponse): boolean {

  if(!carriesUnscheduledSentinel(zone)) {

    return false;
  }

  return status.sensors.some(sensor => (sensor.type === HYDRAWISE_RAIN_SENSOR_TYPE) && sensor.relays.some(relay => relay.id === zone.relay_id) &&
    status.relays.filter(member => (member.time !== 1) && sensor.relays.some(relay => relay.id === member.relay_id))
      .every(member => carriesUnscheduledSentinel(member)));
}

/* Project a wire zone onto its persisted schedule state, through ordered exits that weigh the wire, the account's facts, and a suspension command the account
 * has accepted against one another.
 *
 * RUNNING is asked first, and it is the only reading no other witness can overturn. Water demonstrably flowing is the strongest fact anyone here holds, and a
 * running zone never presents the unscheduled shape - it always carries a run - so asking it first moves no classification that the shapes below would have
 * claimed.
 *
 * A STANDING SUSPEND COMMAND answers next, for ANY wire shape rather than only the ambiguous one. The account has just accepted the command, and the poll
 * snapshot in hand was taken before it: a zone still reporting a live schedule is exactly the case this arm exists for, because the wire cannot yet know what
 * the account has agreed to. Every command reaching here is already known to be STANDING - the caller decides that, which is what keeps this module clock-free.
 *
 * The SENTINEL branch then owns the ambiguous shape, the one body the key-based wire cannot read further, where a suspension, a rain stop, and a plain absence
 * of scheduling look identical. A suspension the facts report wins first and one carried forward from the prior projection next, each only while its end
 * instant is still ahead of the wire clock, then a sensor stop - the facts' own live reading where they carry one, the group inference where they do not - and
 * an unscheduled zone is what remains. A positive "the sensors are quiet" answer is deliberately NOT followed by the group inference: the account API has looked
 * at the sensor itself, which is better evidence than reading the shape of a group. Suspension outranks the sensor claim because it is the longer-lived,
 * user-created fact; the sensor's claim returns on its own the moment the suspension clears.
 *
 * A standing RESUME travels the other direction and acts as SUPPRESSION rather than as a claim of its own: it silences both suspension arms inside that branch
 * and lets the zone fall through to the sensor test, because resuming a zone does not call off a rain delay. On any other shape a resume is naturally silent,
 * since no suspension arm would have fired there anyway.
 *
 * The remaining exits are the wire's own unambiguous readings: the sentinel reached HERE still carries a run or a schedule string, so it is simply unscheduled;
 * and everything else is scheduled, its next run being the root time plus the seconds the wire reports until it.
 *
 * Every time-bearing arm stores ABSOLUTE epoch seconds, and that is what makes the projection stable across polls: the wire's countdowns fall as the poll clock
 * rises, so each sum holds still until the schedule genuinely moves. Storing the countdowns themselves would move every field on every poll and turn each poll into
 * a cache write.
 *
 * With no facts, no carried suspension, and no command the whole path collapses to the key-based classification, which is what keeps an install without account
 * credentials reading exactly as it always has.
 */
export function zoneScheduleStatus(zone: HydrawiseZoneConfig, status: StatusScheduleResponse, facts?: HydrawiseZoneV2Facts, priorSuspendedUntil?: number,
  commanded?: Nullable<number>): HydrawiseZoneScheduleStatus {

  // The wire spells "currently running" as time === 1, the one classification this function reads directly from the literal rather than through the unscheduled
  // sentinel that governs every branch below it.
  if(zone.time === 1) {

    return { endsAt: status.time + zone.run, relayId: zone.relay_id, state: "running" };
  }

  /* The absences are excluded explicitly rather than by truthiness, exactly as the facts arm below excludes its own: an undefined means no command speaks for
   * this zone, a null means one does and it commanded a RESUME. Only a real instant claims this arm, so a zone suspended until epoch zero still classifies as
   * suspended.
   */
  if((commanded !== undefined) && (commanded !== null)) {

    return { relayId: zone.relay_id, state: "suspended", until: commanded };
  }

  if(carriesUnscheduledSentinel(zone)) {

    const suspendedUntil = facts?.suspendedUntil;

    // A standing resume silences the two suspension arms below. Reaching here at all means the command was not a suspend, so this is true exactly when one stands.
    const resumed = commanded === null;

    /* Both absences are excluded explicitly: an undefined means no facts entry reached this zone at all, and a null means the entry reached it and reported no
     * suspension. A reported instant claims the arm only while it is still ahead of the wire clock, the same comparison the carry below makes: facts stay current
     * for their whole lifetime, which can outlast the instant they report, so a suspension ends on the first poll that reaches its end rather than standing until
     * the next refresh says so.
     */
    if(!resumed && (suspendedUntil !== undefined) && (suspendedUntil !== null) && (suspendedUntil > status.time)) {

      return { relayId: zone.relay_id, state: "suspended", until: suspendedUntil };
    }

    /* A suspension the caller carried forward stands while nothing contradicts it. The comparison is against the WIRE clock rather than a local read, which keeps
     * this classification pure and lets an elapsed suspension expire out of the carry on its own. The carried instant is passed through verbatim, never
     * recomputed, so a carried arm stays byte-identical poll after poll and never provokes a cache write.
     */
    if(!resumed && (priorSuspendedUntil !== undefined) && (priorSuspendedUntil > status.time)) {

      return { relayId: zone.relay_id, state: "suspended", until: priorSuspendedUntil };
    }

    /* The sensor question, asked of the better witness first. A live reading that the sensors are TRIPPED settles it; a live reading that they are QUIET retires
     * the group inference outright, because looking at the sensor itself beats reading the shape of the group it covers; and only the absence of any reading -
     * no facts entry, or an entry whose sensors could not be interpreted - falls back to that inference.
     */
    const sensorStopped = facts?.sensorStopped;
    const sensorUnknown = (sensorStopped === undefined) || (sensorStopped === null);

    if((sensorStopped === true) || (sensorUnknown && isZoneStoppedBySensor(zone, status))) {

      return { relayId: zone.relay_id, state: "sensor-stopped" };
    }

    return { relayId: zone.relay_id, state: "unscheduled" };
  }

  if(zone.time === HYDRAWISE_UNSCHEDULED_SENTINEL) {

    return { relayId: zone.relay_id, state: "unscheduled" };
  }

  return { durationSeconds: zone.run, nextRunAt: status.time + zone.time, relayId: zone.relay_id, state: "scheduled" };
}

/* The account-credentialed inputs a whole-controller projection can be composed with: the suspension commands the account has accepted, the facts one refresh
 * reported, and the suspension instants carried forward from the prior projection for the zones this refresh has nothing to say about.
 *
 * They travel as one options argument because they are one decision - how much the account API contributes to this pass - and because a caller that has none of
 * them omits the argument entirely, which is precisely the shape an install without credentials takes.
 *
 * The commands map is keyed by relay id and carries DIRECTION alone: an instant for a suspension, null for a resume. Every entry in it is PRE-FILTERED to the
 * commands that still stand, which the caller alone can judge, since deciding it means comparing a command's age against the facts in hand. Keeping that
 * judgment out of here is what leaves this module clock-free and its classification reproducible from its arguments.
 */
export interface HydrawiseScheduleStatusOptions {

  commands?: Map<number, Nullable<number>>;
  facts?: HydrawiseControllerV2Facts;
  priorSuspended?: Map<number, number>;
}

/* Project a whole status body onto the persisted schedule shape, ordering the zones by relay exactly as the identity roster orders its own, so a field-wise
 * comparison never reports a difference that the wire's own ordering alone produced. The active window is passed in rather than read here, keeping this module free
 * of any dependency inside the repo, and it rides along in the result so every consumer classifies against the same threshold the runtime used.
 *
 * The carry is decided PER ZONE, and the rule is that only a PRESENT facts entry speaks for a zone. An entry that reached this zone reasserts or clears its
 * suspension - a null suspendedUntil being a real answer, not an absence - while a zone the facts simply do not name keeps whatever the prior projection said.
 * Judging the carry account-wide instead would let one zone's fresh answer silently clear a sibling the same answer never covered.
 *
 * A zone's command is resolved from the map exactly as its facts entry is, and travels alongside rather than in place of either: the classifier weighs every
 * witness in one precedence, which is what keeps every consumer of this projection reading one answer instead of overlaying a command on top of it themselves.
 *
 * The controller's availability is stamped only when fresh facts actually carried one, so the persisted shape of an install without account credentials is
 * byte-identical to what it has always been.
 */
export function scheduleStatus(status: StatusScheduleResponse, activeWindowSeconds: number, options: HydrawiseScheduleStatusOptions = {}):
HydrawiseScheduleStatus {

  const { commands, facts, priorSuspended } = options;

  const projection: HydrawiseScheduleStatus = { activeWindowSeconds, asOf: status.time,

    zones: status.relays.toSorted((a, b) => a.relay - b.relay).map(zone => {

      const zoneFacts = facts?.zones.get(zone.relay_id);

      return zoneScheduleStatus(zone, status, zoneFacts, zoneFacts ? undefined : priorSuspended?.get(zone.relay_id), commands?.get(zone.relay_id));
    }) };

  if(facts && (facts.online !== null)) {

    projection.online = facts.online;
  }

  return projection;
}

// Validate a persisted zone schedule status read back from the accessory cache, with the identity guards' rigor: the state must be one of the states the union
// declares, and the arm that state names must carry its own numeric fields. Checking the arm fields rather than the state alone is what keeps a truncated cache
// entry - a "running" entry that lost its endsAt - from passing as well-formed and rendering as a blank countdown.
export function isZoneScheduleStatus(value: unknown): value is HydrawiseZoneScheduleStatus {

  if((typeof value !== "object") || (value === null) || (typeof (value as HydrawiseZoneScheduleStatus).relayId !== "number")) {

    return false;
  }

  const candidate = value as { durationSeconds?: unknown; endsAt?: unknown; nextRunAt?: unknown; state?: unknown; until?: unknown };

  switch(candidate.state) {

    case "running":

      return typeof candidate.endsAt === "number";

    case "scheduled":

      return (typeof candidate.durationSeconds === "number") && (typeof candidate.nextRunAt === "number");

    case "suspended":

      return typeof candidate.until === "number";

    case "sensor-stopped":
    case "unscheduled":

      // These states carry no facts beyond the state itself, so a well-formed relay id and a known state are the whole shape.
      return true;

    default:

      return false;
  }
}

// Validate a persisted controller schedule projection, for the same reason and with the same rigor as the identity guards: a malformed value counts as absent, so a
// corrupt cache entry is classified rather than trusted. Every zone entry is checked, because one bad entry is enough to make a rendered panel lie. Availability is
// optional, so absent and boolean both pass and anything else fails - a projection written without account credentials simply never carries it.
export function isScheduleStatus(value: unknown): value is HydrawiseScheduleStatus {

  const online = (value as HydrawiseScheduleStatus | null)?.online;

  return (typeof value === "object") && (value !== null) && (typeof (value as HydrawiseScheduleStatus).activeWindowSeconds === "number") &&
    (typeof (value as HydrawiseScheduleStatus).asOf === "number") && ((online === undefined) || (typeof online === "boolean")) &&
    Array.isArray((value as HydrawiseScheduleStatus).zones) && (value as HydrawiseScheduleStatus).zones.every(entry => isZoneScheduleStatus(entry));
}

// The schedule fields a change comparison reads. Naming the excluded field at the type level is what makes reintroducing it a deliberate edit rather than an
// accident: asOf is the facts' own timestamp and moves whenever the wire's clock does, so including it would report every poll as a change and flush the accessory
// cache on every poll - the exact cost this projection's absolute-time shape exists to avoid.
type ComparedScheduleFields = Omit<HydrawiseScheduleStatus, "asOf">;

/* Compare two zone schedule statuses: the state first, since two entries in different states never match, and then the facts that state's arm carries. The switch
 * narrows each arm, so each comparison names exactly the fields that exist in it.
 *
 * Every state is named and there is no default arm, deliberately. A state added to the union then surfaces here as a compile error rather than falling into a
 * state-only comparison that would silently ignore whatever facts the new arm carries - and an ignored fact is a change the flush gate never sees.
 */
export function sameZoneScheduleStatus(a: HydrawiseZoneScheduleStatus, b: HydrawiseZoneScheduleStatus): boolean {

  if(a.relayId !== b.relayId) {

    return false;
  }

  switch(a.state) {

    case "running":

      return (b.state === "running") && (a.endsAt === b.endsAt);

    case "scheduled":

      return (b.state === "scheduled") && (a.durationSeconds === b.durationSeconds) && (a.nextRunAt === b.nextRunAt);

    case "suspended":

      return (b.state === "suspended") && (a.until === b.until);

    case "sensor-stopped":
    case "unscheduled":

      // These states carry no facts of their own, so agreeing on the state is the whole comparison.
      return a.state === b.state;
  }
}

// Compare two schedule projections over the compared surface named above: the self-describing window, the controller's availability, and the zone entries through
// the shared walk. Never by reference, for the same reason the identity comparisons are field-wise - the projection is rebuilt fresh every poll, so a reference
// check would report every poll as a change. Availability is compared rather than excluded because a controller falling off the network and coming back is a real
// transition the persisted facts should record, not incidental churn.
export function sameScheduleStatus(a: ComparedScheduleFields, b: ComparedScheduleFields): boolean {

  return (a.activeWindowSeconds === b.activeWindowSeconds) && (a.online === b.online) && sameEntries(a.zones, b.zones, sameZoneScheduleStatus);
}

/* The typed HomeKit accessory context this plugin persists on every accessory it owns. Homebridge round-trips this object verbatim through its on-disk cache, so it
 * holds only plain, JSON-serializable data the webUI can read back with zero cloud calls.
 *
 * The context carries distinct persisted kinds side by side, each with its own types, its own guards, and its own flush discipline. Stable identity - the
 * self-identity, the denormalized account roster, the zone roster, and the zone-accessory pair - answers who a thing is, and its types never carry volatile fields.
 * The schedule projection answers what a controller's zones are doing; it is volatile by subject but change-shaped by construction, storing absolute instants that
 * hold still between polls, so it is written on the same compare-then-write terms identity is. Both are read straight off the accessory cache, which is what keeps
 * the webUI's listing and its schedule display free of any cloud call.
 *
 * The firmware version is the one hardware fact the context carries, written when the account reports hardware that differs from what the controller held. The
 * model needs no copy here, because HAP round-trips its characteristic through the same cache and it survives a restart there. The firmware's characteristic does
 * not: Homebridge overwrites it with a placeholder on every restore, before the plugin is handed the accessory, so the context is what carries the version across
 * a restart, and the platform writes it back over that placeholder as the accessory is restored while the account credentials are configured.
 *
 * The accessory KINDS are mutually exclusive, and the arms below state that in the types rather than leaving it to convention. A controller accessory carries
 * its own identity (the self-identity the webUI's zone lookup keys on), the denormalized account roster (every account controller, enabled or not, so any one
 * accessory knows all its siblings), its own zone roster, its schedule projection, and its firmware version; it never carries the zone-accessory pair. A
 * standalone zone accessory carries exactly that pair - the owning controller's identity and the zone's own - and never any controller-accessory field. Each arm
 * types the other kind's fields as `never`, so an object carrying both shapes at once inhabits neither. That split is what the webUI's controller match rests on:
 * it finds a controller by reading `controller`, so a zone accessory carrying that field would shadow the real controller accessory and blank the zone listing.
 *
 * The arms are deliberately asymmetric in what they require. Every controller-arm field is optional, so a freshly constructed `{}` and a cache entry carrying only
 * some of the fields both inhabit that arm, and an ambiguous or empty context classifies as controller-side - the self-healing direction, and the same answer the
 * runtime predicate gives. The zone arm requires its pair, because that pair is only ever written as one whole object.
 *
 * The write discipline follows from the aliases rather than from a rule each writer has to remember. HydrawiseAccessoryContext composes READONLY views of the arms,
 * so a reference typed as the union admits a whole-object assignment and rejects a field write outright, while every field write lives on an arm-typed reference,
 * which carries the mutable interface. isZoneAccessoryContext below is the runtime half of the same rule and the vocabulary every consumer branches on: it asserts
 * the split against cache JSON that no static type governs, and it narrows both of its branches.
 */
export interface HydrawiseControllerAccessoryContext {

  controller?: HydrawiseControllerIdentity;
  controllers?: HydrawiseControllerIdentity[];
  firmware?: string;
  ownerController?: never;
  schedule?: HydrawiseScheduleStatus;
  zone?: never;
  zones?: HydrawiseZoneIdentity[];
}

// The persisted context of a standalone zone accessory: the owning controller's identity and the zone's own. The pair is required because it is only ever written
// whole - the reconcile assigns a complete fresh object - and the controller-accessory fields are closed off as `never`.
export interface HydrawiseZoneAccessoryContext {

  controller?: never;
  controllers?: never;
  firmware?: never;
  ownerController: HydrawiseControllerIdentity;
  schedule?: never;
  zone: HydrawiseZoneIdentity;
  zones?: never;
}

// A persisted accessory context of either kind - the union every surface that genuinely sees both kinds speaks. The arms compose as readonly views, which is what
// makes a field write through a union-typed reference a compile error and keeps field writes on the arm-typed references that carry the mutable interfaces.
export type HydrawiseAccessoryContext = Readonly<HydrawiseControllerAccessoryContext> | Readonly<HydrawiseZoneAccessoryContext>;

/* Whether a persisted accessory context belongs to a standalone zone accessory. Exclusivity is checked in BOTH directions - the zone-accessory pair present and
 * well-formed, and every controller-accessory field absent - so an ambiguous context carrying both shapes at once classifies as NOT a zone accessory and takes the
 * non-zone arm wherever it is read, which is the self-healing direction. This predicate is the single vocabulary every consumer branches on, so the exclusivity rule
 * is asserted in exactly one place instead of being re-derived at each read site.
 *
 * The check runs in full against the values themselves, whatever the static types promise, because what it reads is cache JSON Homebridge round-trips from disk,
 * where a hand-edited or half-written entry can carry any shape at all. What the narrowing adds is the compiler carrying the same rule forward: this is also the
 * union's narrowing vocabulary, so the true branch types as the zone arm and the else branch as the controller arm. That is protection the write-site convention
 * alone could never give, because a convention is only as good as the next writer.
 */
export function isZoneAccessoryContext(context: HydrawiseAccessoryContext): context is Readonly<HydrawiseZoneAccessoryContext> {

  return isControllerIdentity(context.ownerController) && isZoneIdentity(context.zone) && (context.controller === undefined) &&
    (context.controllers === undefined) && (context.firmware === undefined) && (context.schedule === undefined) && (context.zones === undefined);
}

// A Hydrawise accessory of either kind: a Homebridge PlatformAccessory whose context is our typed union. This is the alias for every surface that genuinely sees
// both kinds - the tracked accessory array, the creation and removal paths, the orphan sweep, the hosting map - so the context contract lives in exactly one place.
// A reference typed this way admits a whole-object context assignment and no field write at all, because the union's arms are readonly views.
export type HydrawiseAccessory = PlatformAccessory<HydrawiseAccessoryContext>;

// A controller accessory specifically: the same PlatformAccessory over the controller arm alone. The controller's own accessory takes this alias because that is
// where the field writes live - seeding one roster field at a time is legal on the arm's mutable interface and nowhere else.
export type HydrawiseControllerAccessory = PlatformAccessory<HydrawiseControllerAccessoryContext>;
