/* Copyright(C) 2017-2026, HJD (https://github.com/hjdhjd). All rights reserved.
 *
 * v2.ts: Hydrawise v2 GraphQL API client.
 */
import { HYDRAWISE_TRANSPORT_FAULT_SENTENCES, HYDRAWISE_V2_CLIENT_ID, HYDRAWISE_V2_CLIENT_SECRET, HYDRAWISE_V2_GRAPH_ENDPOINT, HYDRAWISE_V2_REFRESH_THRESHOLD,
  HYDRAWISE_V2_TIMEOUT, HYDRAWISE_V2_TOKEN_ENDPOINT, PLUGIN_NAME } from "./settings.ts";
import type { HomebridgePluginLogging, Nullable, RateBudget } from "homebridge-plugin-utils";
import type { HydrawiseControllerV2Facts, HydrawiseV2Account, HydrawiseV2GraphResponse, HydrawiseV2TokenResponse, HydrawiseV2TokenState } from "./types.ts";
import { classifyTransportError, composeSignals, createApiDispatcher } from "homebridge-plugin-utils";
import type { Dispatcher } from "undici";
import { controllerV2Facts } from "./types.ts";
import { request } from "undici";
import util from "node:util";

/* The whole-account query, stated once. It asks for every controller on the account in ONE request, which is what lets the platform fetch a single time and hand
 * each controller its own facts: the v2 ceiling is measured in single digits per half hour, so a query per controller would spend an account's whole budget on a
 * multi-controller install before it enriched anything. It feeds the recurring refresh, with the hardware fields fetched by the same call rather than spending
 * one of their own.
 *
 * The selection is deliberately narrow, because every field asked for is a field that can fail: neighboring fields on these same types answer with a server-side
 * error, and a GraphQL error anywhere in a selection is reported against the whole response. Two omissions rest on probe evidence rather than caution - the
 * sensor model's `mode`, which answers a 500 and nullifies the sensor entry carrying it, and the zone status's `lastRun` and `nextRun`, which went unproven
 * against the live endpoint and which the key-based wire already answers.
 *
 * suspendedUntil is a DateTime object rather than a scalar, so it takes a subselection; its timestamp is the absolute instant a suspension lifts. Availability
 * is read from the controller's nested status block, leaving the flat sibling field of the same name unread.
 */
const ACCOUNT_QUERY = "query { me { controllers { id name status { online } hardware { model { description } firmware { type version } } " +
  "zones { id name status { suspendedUntil { timestamp } } } sensors { model { sensorType } status { active } zones { id } } } } }";

// The sentence every failure of the whole-account read is reported under. Both sites that can report one - the pacing wait and the transport itself - read it from
// here, so the operator sees the same words whichever of them failed.
const READ_FAILURE_SENTENCE = "Unable to retrieve enhanced controller details";

// The sentence a sign-in failure is reported under once it reaches classification as a thrown error; the response-shape failures acquireToken() checks directly
// state their own sentences without drawing on this constant.
const TOKEN_FAILURE_SENTENCE = "Unable to sign in to your Hydrawise account for enhanced features";

/* One transport failure, in the parts a caller needs in order to report it: the reason in the operator's own terms, and the punctuation that joins that reason
 * onto whatever sentence the caller states about what it was doing.
 *
 * The punctuation is not decoration. A reason that is this client's OWN sentence about what happened follows the caller's with a period; text quoted from the API,
 * or from a thrown error, follows it with a colon, which is what marks it as something being reported rather than something being said.
 */
interface HydrawiseV2Failure {

  joiner: "." | ":";
  reason: string;
}

/* What the shared transport answers with: the data a successful call carried, or the failure its caller reports in its own voice.
 *
 * It is a discriminated union rather than a nullable value because the caller reports a failure under its own sentence, which it cannot do with a bare null, and a
 * transport that logged on the caller's behalf would narrate one failure twice - once in the transport's words and once in the caller's.
 *
 * The failure is itself nullable, for the cases that leave nothing to add: one already reported in its own words, such as a sign-in that failed, and one that
 * is simply teardown.
 */
type HydrawiseV2TransportResult<T> =
  { data: Nullable<T>; outcome: "answered" } |
  { failure: Nullable<HydrawiseV2Failure>; outcome: "failed" };

/* Construction options for the v2 client.
 *
 * The dispatcher arrives as a FACTORY rather than a dispatcher because this client re-arms its connection pool after a timeout. A factory keeps that self-heal
 * running the same code in every context: a caller that supplies one owns what a re-arm answers with, and a caller that supplies none gets the keep-alive pool the
 * constructor builds.
 *
 * The budget is likewise injected rather than built here, because pacing is an account-wide concern the platform owns. Every read and every token grant draw it.
 */
export interface HydrawiseV2ClientOptions {

  budget: RateBudget;
  dispatcherFactory?: () => Dispatcher;
  log: HomebridgePluginLogging;
  password: string;
  signal: AbortSignal;
  username: string;
}

/* The Hydrawise v2 client: an OAuth2-authenticated GraphQL endpoint, kept separate from the v1 REST transport the platform owns. It is a read-only surface: every
 * command the plugin sends goes through the v1 transport, and this client fetches the account facts the enhanced features show.
 *
 * A separate transport rather than another endpoint on the v1 path, because the two are unlike in every dimension a client cares about. They address different
 * hosts, authenticate differently (an account grant against an API key), and tolerate wildly different call rates. They also classify failure differently: this
 * transport checks a body-level errors array on every call it makes, on top of the status code, where the v1 transport classifies by status code and reads the
 * command endpoint's own message_type for itself. One shared path would mean one retry policy and one classification serving two contracts, which is how a
 * change made for one silently breaks the other.
 *
 * Everything here is optional at runtime. The platform builds this client only when the user has configured account credentials, so an install without them never
 * constructs it, never opens a connection, and never spends a call.
 */
export class HydrawiseV2Client {

  private readonly budget: RateBudget;
  private currentDispatcher: Dispatcher;
  private readonly dispatcherFactory: () => Dispatcher;
  private readonly log: HomebridgePluginLogging;
  private readonly password: string;
  private readonly signal: AbortSignal;
  private token: HydrawiseV2TokenState;
  private readonly username: string;

  // Construct a client. Construction opens no connection and spends no call; the first request does.
  constructor(options: HydrawiseV2ClientOptions) {

    this.budget = options.budget;
    this.log = options.log;
    this.password = options.password;
    this.signal = options.signal;
    this.token = { state: "none" };
    this.username = options.username;

    /* The default factory builds the family's vetted pool against the v2 origin, derived from the endpoint constant so the pool and the requests it carries can never
     * target different hosts. Transport retries are declined on purpose: every call here is paced by a deliberately small budget that a retry would spend repeating a
     * question the server already answered, and a status the retry policy would re-ask is, on this API, an answer this client reads for itself - with retries on, it
     * would arrive as an exhausted-retries failure instead.
     */
    this.dispatcherFactory = options.dispatcherFactory ??
      ((): Dispatcher => createApiDispatcher({ origin: new URL(HYDRAWISE_V2_GRAPH_ENDPOINT).origin, retry: false, userAgent: PLUGIN_NAME }));
    this.currentDispatcher = this.dispatcherFactory();
  }

  // This client's dispatcher as it stands right now. The platform's teardown reads it at disposal time rather than capturing it, which is what keeps that
  // registration correct across the timeout self-heal below.
  public get dispatcher(): Dispatcher {

    return this.currentDispatcher;
  }

  /* Resolve a usable access token, acquiring or renewing one as needed. This is the single chokepoint every v2 request passes through and the only place the token
   * state is read or written, so the access token, its expiry, and any grant in flight cannot desynchronize.
   *
   * Renewal is LAZY - it happens here, on the call that needs a token, never on a timer. That is what leaves this client with nothing to tear down beyond its
   * connection pool: a background refresh would need a timer, the timer would need a lifetime, and an optional enrichment does not earn that machinery.
   *
   * The single-flight guarantee is the mechanism, not a convenience. Both paths that reach the network - a first acquisition and a renewal inside the proactive
   * window - transition the state to "refreshing" SYNCHRONOUSLY, in the same frame that observed the prior state and before any await, so two concurrent callers
   * can never both observe a pre-transition state and each fire a grant of its own. A caller arriving while one is in flight joins that promise instead.
   */
  public async ensureToken(): Promise<Nullable<string>> {

    const token = this.token;

    // A grant already in flight is the one every concurrent caller waits on.
    if(token.state === "refreshing") {

      return token.pending;
    }

    // A token comfortably inside its lifetime answers directly, with no call spent.
    if((token.state === "valid") && (token.expiresAt > (this.now() + HYDRAWISE_V2_REFRESH_THRESHOLD))) {

      return token.accessToken;
    }

    /* Both remaining cases - no token at all, and a token inside the proactive-renewal window - go to the network. The promise is created and stored here with no
     * await between reading the state above and writing it, which is what makes the single-flight guarantee structural rather than a race we happen to win.
     */
    const pending = this.acquireToken((token.state === "valid") ? token.refreshToken : null);

    this.token = { pending, state: "refreshing" };

    return pending;
  }

  /* Fetch the whole account's facts in one query, keyed by the id that correlates a v2 controller to the v1 controller this plugin discovered. A controller the
   * answer names without an id cannot be correlated to anything, so it is skipped; every other controller gets an entry, with each individual fact carrying its
   * own absence rather than the whole entry being withheld for one missing field.
   *
   * A null answer is a failed query. An empty map is a successful query that found nothing to enrich, and the two are deliberately tellable apart: the caller
   * leaves every display standing either way, but only one of them is worth reporting.
   */
  public async fetchAccountFacts(): Promise<Nullable<Map<number, HydrawiseControllerV2Facts>>> {

    const account = await this.graph<HydrawiseV2Account>(ACCOUNT_QUERY);

    if(!account) {

      return null;
    }

    const facts = new Map<number, HydrawiseControllerV2Facts>();

    for(const controller of account.me?.controllers ?? []) {

      if(controller.id === undefined) {

        continue;
      }

      facts.set(controller.id, controllerV2Facts(controller));
    }

    return facts;
  }

  /* Execute one GraphQL query and answer its data, or null on any failure. The ordering here is the contract: the rate budget is drawn FIRST, ahead of the token
   * chokepoint and ahead of the request, so a call the ceiling is not ready to admit waits rather than reaching the wire - the same shape the v1 transport uses.
   *
   * The wait is deliberately unbounded, which is what a scheduled read wants: it has no deadline of its own to answer by, so waiting out whatever the shared
   * budget's window imposes costs it nothing a bounded wait would spare. The try envelopes BOTH the wait and the transport, so a shutdown reaching a caller still
   * queued for a slot resolves to the same quiet null every other teardown path answers with rather than escaping as a rejection this method promises never to
   * produce.
   */
  private async graph<T>(query: string): Promise<Nullable<T>> {

    try {

      // Pace this call against the READ ceiling before anything else happens, so a query and any token grant it triggers each cost a slot of it.
      await this.budget.acquire();

      const result = await this.execute<T>(query);

      // The read is its own reporter, which is what the transport handing back a reason rather than logging one makes possible.
      if(result.outcome === "failed") {

        this.report(READ_FAILURE_SENTENCE, result.failure);

        return null;
      }

      return result.data;
    } catch(error) {

      this.report(READ_FAILURE_SENTENCE, this.classifyFailure(error));

      return null;
    }
  }

  /* Present a token, post one GraphQL document, and classify what comes back - the transport every v2 call shares, and the whole of what a call does once it has
   * been admitted. It draws NO budget of its own: pacing belongs to the caller, which has already drawn its slot, and a draw here would count that call twice.
   *
   * Failure classification reads BOTH halves of the answer. A non-2xx status is a failure, and so is an HTTP 200 whose body carries a GraphQL errors array: this
   * endpoint reports a failed query in the body under a success status, so trusting the status alone would hand a caller an absent data field as though it were an
   * answer.
   *
   * It LOGS nothing at all, and that absence is the contract. What comes back is the reason, never a line, because who speaks about a failure is the caller's
   * business: the read says it under its own sentence. A transport that reported on its behalf would leave one failure narrated twice, in two voices, for one
   * thing that went wrong.
   */
  private async execute<T>(query: string): Promise<HydrawiseV2TransportResult<T>> {

    try {

      const token = await this.ensureToken();

      // A grant that failed has already said so in its own words, so there is nothing left for this failure to carry.
      if(!token) {

        return { failure: null, outcome: "failed" };
      }

      const response = await request(HYDRAWISE_V2_GRAPH_ENDPOINT, { body: JSON.stringify({ query }), dispatcher: this.currentDispatcher,
        headers: { "authorization": "Bearer " + token, "content-type": "application/json" }, method: "POST", signal: this.requestSignal() });

      if((response.statusCode < 200) || (response.statusCode >= 300)) {

        return { failure: { joiner: ".", reason: "The Hydrawise API answered with status " + response.statusCode.toString() + "." }, outcome: "failed" };
      }

      // Every field on this shape is optional by design, so the cast cannot manufacture a field this method or a caller would wrongly trust as present.
      const body = await response.body.json() as HydrawiseV2GraphResponse<T>;

      if(body.errors?.length) {

        return { failure: { joiner: ":", reason: body.errors.map(entry => entry.message ?? "an unspecified error").join("; ") + "." }, outcome: "failed" };
      }

      return { data: body.data ?? null, outcome: "answered" };
    } catch(error) {

      return { failure: this.classifyFailure(error), outcome: "failed" };
    }
  }

  // Join one transport failure onto the caller's own sentence, saying nothing when the failure carries nothing to add. This is the one place that pairs a sentence
  // with a reason drawn from classifyFailure() or the transport's own result, so every failure reported that way reads in the same voice.
  private report(sentence: string, failure: Nullable<HydrawiseV2Failure>): void {

    if(!failure) {

      return;
    }

    this.log.error(sentence + failure.joiner + " " + failure.reason);
  }

  /* Acquire an access token, by renewal when a refresh token is in hand and by the account password grant otherwise. This is the only method that writes the token
   * state to anything but "refreshing", and it always writes exactly one terminal state: "valid" on success, "none" on failure.
   *
   * Returning to "none" on failure is what keeps a broken renewal from wedging the client. The next caller finds no token, runs the password grant, and recovers on
   * its own, where leaving a stale "valid" behind would spend every later call on a token the server has already rejected.
   */
  private async acquireToken(refreshToken: Nullable<string>): Promise<Nullable<string>> {

    try {

      // A token grant draws the read ceiling, the one ceiling this client paces on, so a grant and the read that needed it each cost a slot of it.
      await this.budget.acquire();

      const params = new URLSearchParams();

      params.set("client_id", HYDRAWISE_V2_CLIENT_ID);
      params.set("client_secret", HYDRAWISE_V2_CLIENT_SECRET);
      params.set("scope", "all");

      // The grant types differ only in what they present as proof. A renewal spends the refresh token the last grant returned; the password grant presents the
      // account credentials the user configured.
      if(refreshToken) {

        params.set("grant_type", "refresh_token");
        params.set("refresh_token", refreshToken);
      } else {

        params.set("grant_type", "password");
        params.set("password", this.password);
        params.set("username", this.username);
      }

      const response = await request(HYDRAWISE_V2_TOKEN_ENDPOINT, { body: params.toString(), dispatcher: this.currentDispatcher,
        headers: { "content-type": "application/x-www-form-urlencoded" }, method: "POST", signal: this.requestSignal() });

      if((response.statusCode < 200) || (response.statusCode >= 300)) {

        this.log.error("Unable to sign in to your Hydrawise account for enhanced features. Please check the username and password you have configured.");

        return this.resetToken();
      }

      // Every field on this shape is optional, for the same reason the GraphQL envelope's are: an untrusted OAuth response cannot promise the wire keeps its shape.
      const grant = await response.body.json() as HydrawiseV2TokenResponse;

      if(!grant.access_token?.length) {

        this.log.error("The Hydrawise account sign-in for enhanced features returned no access token.");

        return this.resetToken();
      }

      /* The wire states a lifetime in seconds; we store the absolute instant it expires, so a later readiness check is a comparison against the clock rather than
       * arithmetic that has to remember when the grant landed. A grant that states no lifetime is stored as expiring right now, which needs no special case
       * anywhere else: it serves the call that fetched it, and the next call renews.
       */
      this.token = { accessToken: grant.access_token, expiresAt: this.now() + (grant.expires_in ?? 0), refreshToken: grant.refresh_token ?? null, state: "valid" };

      return grant.access_token;
    } catch(error) {

      this.report(TOKEN_FAILURE_SENTENCE, this.classifyFailure(error));

      return this.resetToken();
    }
  }

  // Return the token state to holding nothing and answer the null every failed acquisition resolves to. Both halves live here, so a failure path cannot perform one
  // without the other.
  private resetToken(): null {

    this.token = { state: "none" };

    return null;
  }

  /* Classify a thrown request failure into the reason a caller reports, taking whatever recovery the kind of failure calls for along the way.
   *
   * The switch is exhaustive over the classifier's kinds with no default arm, so a kind the library learns to name is a compile error here until this client says
   * what it means. A shutdown answers nothing to report: the lifetime signal outranks every reading of the error, which also guarantees the self-heal below can never
   * re-arm a pool after shutdown.
   */
  private classifyFailure(error: unknown): Nullable<HydrawiseV2Failure> {

    const failure = classifyTransportError(error, this.signal);

    switch(failure.kind) {

      case "aborted":

        return null;

      // A timed-out request re-arms the connection pool. With a single connection a wedged session carries every request on it, so destroying and replacing the pool
      // fails those fast onto a fresh one, where a graceful drain would instead wait on the very wedge the re-arm is clearing.
      case "timeout":

        this.rearmDispatcher();

        return { joiner: ".", reason: "The Hydrawise API took too long to respond, which can usually be safely ignored." };

      // A concrete transport fault - a network failure, or a certificate the platform refused to trust - reads as the sentence the plugin keeps for it, a complete
      // sentence in its own right, so it follows the report's sentence as one.
      case "certificate":
      case "connect-timeout":
      case "destroyed":
      case "dns":
      case "refused":
      case "reset":
      case "retries-exhausted":
      case "unreachable":

        return { joiner: ".", reason: HYDRAWISE_TRANSPORT_FAULT_SENTENCES[failure.kind] };

      // A genuine failure carrying no marker anyone can read: the dump is the reason, and a colon is what marks it as text being quoted rather than a sentence
      // being said.
      case "transport":

        return { joiner: ":", reason: util.inspect(error, { colors: true, depth: null, sorted: true }) };
    }
  }

  // Destroy the current dispatcher and build its replacement through the same factory the constructor used, so a re-arm runs the identical code path whether this
  // client owns a real pool or a caller supplied the factory.
  private rearmDispatcher(): void {

    void this.currentDispatcher.destroy();
    this.currentDispatcher = this.dispatcherFactory();
  }

  // The signal one request runs under: its own timeout composed with the plugin's lifetime, so a slow request aborts on the timeout and an in-flight request aborts
  // on shutdown, both through one signal handed to undici. The timeout is armed here, after the budget has admitted the call, so waiting for a slot never eats into
  // the time the request itself is allowed.
  private requestSignal(): AbortSignal {

    return composeSignals(AbortSignal.timeout(HYDRAWISE_V2_TIMEOUT * 1000), this.signal);
  }

  // The current time in epoch seconds, the unit the token's stated lifetime and its stored expiry both speak.
  private now(): number {

    return Math.floor(Date.now() / 1000);
  }
}
