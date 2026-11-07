/* Copyright(C) 2017-2026, HJD (https://github.com/hjdhjd). All rights reserved.
 *
 * platform.retrieve.test.ts: The HydrawisePlatform.retrieve() HTTP path, exercised against a REAL platform whose undici traffic is driven through a
 * MockAgent installed as the global dispatcher after construction. Covers the happy 200, the invalid-key and rate-limit status branches, the bug-1 status gate,
 * the shutdown-abort short circuit, the connection-error taxonomy, the request deadline on the platform's clock with the bound it puts on a body's read and its
 * release as the read settles, and the report of a failure that repeats: once at error, each repeat at debug, and in full again after a success or a change of
 * reason.
 *
 * The Pool's TLS posture is not observable through this MockAgent swap: the swap stands in for the global dispatcher, so the real Pool's connect options never run
 * and it exposes no reflectable view of them. The connection's certificate validation therefore has no executable assertion here, in either direction.
 */

// The Hydrawise API wire shapes use snake_case keys such as relay_id and controller_id, so camelcase is disabled here to let these literals mirror the wire verbatim.
/* eslint-disable camelcase */
import { HYDRAWISE_ORIGIN, addressesEndpoint, buildPlatform, dispatcherOf, heldEndFor, installMockDispatcher, programJsonReply,
  programStatusReply } from "./testing/platform.helpers.ts";
import { describe, test } from "node:test";
import { errnoError, linesAt, logCount, loggedAt, settle, settleUntil } from "homebridge-plugin-utils/testing";
import { makeCustomerDetails, normalSchedule } from "./api.helpers.ts";
import { HYDRAWISE_API_TIMEOUT } from "./settings.ts";
import type { HydrawiseBodyRead } from "./platform.ts";
import type { Nullable } from "homebridge-plugin-utils";
import assert from "node:assert/strict";
import { errors } from "undici";

// APIEvent.DID_FINISH_LAUNCHING's and APIEvent.SHUTDOWN's string values, the events the platform binds discovery and its teardown to. Firing the second aborts the
// shutdown signal and destroys the dispatcher.
const DID_FINISH_LAUNCHING_EVENT = "didFinishLaunching";
const SHUTDOWN_EVENT = "shutdown";

// The sentence a poll writes for a status body it could not read, ahead of the reason its read met.
const STATUS_SENTENCE = "Unable to retrieve the current status of the irrigation controller";

describe("HydrawisePlatform retrieve", () => {

  test("answers the parsed body on a 200", async (t) => {

    const { emit, platform } = buildPlatform();

    t.after(() => emit(SHUTDOWN_EVENT));
    await using dispatcher = installMockDispatcher();
    programJsonReply(dispatcher.agent, "customerdetails.php", { controller_id: 500001 });

    assert.deepEqual(await platform.retrieve("customerdetails.php"), { body: { controller_id: 500001 }, status: "parsed" },
      "a 200 answers the body it carried, read and parsed inside the request");
  });

  test("returns null and logs an invalid-key error on a 404", async (t) => {

    const { emit, entries, platform } = buildPlatform();

    t.after(() => emit(SHUTDOWN_EVENT));
    await using dispatcher = installMockDispatcher();
    programStatusReply(dispatcher.agent, "customerdetails.php", 404);

    const response = await platform.retrieve("customerdetails.php");

    assert.equal(response, null, "a 404 should classify as an error and return null");
    assert.ok(loggedAt(entries, "error", "Invalid API key"), "a 404 should log the invalid-key message");
  });

  test("returns null and logs a rate-limit error on a 429", async (t) => {

    const { emit, entries, platform } = buildPlatform();

    t.after(() => emit(SHUTDOWN_EVENT));
    await using dispatcher = installMockDispatcher();
    programStatusReply(dispatcher.agent, "customerdetails.php", 429);

    const response = await platform.retrieve("customerdetails.php");

    assert.equal(response, null, "a 429 should classify as an error and return null");
    assert.ok(loggedAt(entries, "error", "rate limit"), "a 429 should log the rate-limit message");
  });

  test("a 403 outside the 2xx range classifies as an error and returns null (the bug 1 fix)", async (t) => {

    const { emit, entries, platform } = buildPlatform();

    t.after(() => emit(SHUTDOWN_EVENT));
    await using dispatcher = installMockDispatcher();
    programStatusReply(dispatcher.agent, "customerdetails.php", 403);

    // The status gate classifies any status outside the 2xx range as an error, so a 403 - not 404, not 429, and not a server error the pool retries - returns null
    // and logs its status code and reason phrase.
    const response = await platform.retrieve("customerdetails.php");

    assert.equal(response, null, "a 403 outside the 2xx range classifies as an error and returns null");
    assert.ok(loggedAt(entries, "error", "403"), "a 403 logs its raw status code at error level");
  });

  test("returns null quietly when the platform signal is already aborted", async () => {

    const { entries, platform } = buildPlatform();

    await using dispatcher = installMockDispatcher();
    programJsonReply(dispatcher.agent, "customerdetails.php", { controller_id: 500001 });

    // Shutdown aborts the platform signal once its offline words settle, which supersedes every other classification: retrieve returns null and logs nothing.
    await platform.shutdown();

    const response = await platform.retrieve("customerdetails.php");

    assert.equal(response, null, "an aborted platform signal short-circuits retrieve to null");
    assert.ok(!loggedAt(entries, "error", "Invalid API key"), "the abort path logs no error");
  });

  test("returns null on a connection timeout", async (t) => {

    const { emit, entries, platform } = buildPlatform();

    t.after(() => emit(SHUTDOWN_EVENT));
    await using dispatcher = installMockDispatcher();
    dispatcher.agent.get(HYDRAWISE_ORIGIN).intercept({ method: "GET", path: addressesEndpoint("customerdetails.php") })
      .replyWithError(new errors.ConnectTimeoutError());

    const response = await platform.retrieve("customerdetails.php");

    assert.equal(response, null, "a connection timeout should return null");
    assert.ok(loggedAt(entries, "error", "Connection timed out"), "a connection timeout should be logged");
  });

  test("returns null on a request retry error", async (t) => {

    const { emit, entries, platform } = buildPlatform();

    t.after(() => emit(SHUTDOWN_EVENT));
    await using dispatcher = installMockDispatcher();

    // RequestRetryError requires its third constructor argument; omitting it throws in setup as its constructor destructures that headers object.
    dispatcher.agent.get(HYDRAWISE_ORIGIN).intercept({ method: "GET", path: addressesEndpoint("customerdetails.php") })
      .replyWithError(new errors.RequestRetryError("retry exhausted", 500, {}));

    const response = await platform.retrieve("customerdetails.php");

    assert.equal(response, null, "a request retry error should return null");
    assert.ok(loggedAt(entries, "error", "Unable to connect to the Hydrawise API"), "a request retry error should be logged");
  });

  test("classifies a wrapped refused connection by the errno in its cause", async (t) => {

    const { emit, entries, platform } = buildPlatform();

    t.after(() => emit(SHUTDOWN_EVENT));
    await using dispatcher = installMockDispatcher();
    const refused = new TypeError("fetch failed");

    refused.cause = { code: "ECONNREFUSED" };
    dispatcher.agent.get(HYDRAWISE_ORIGIN).intercept({ method: "GET", path: addressesEndpoint("customerdetails.php") })
      .replyWithError(refused);

    const response = await platform.retrieve("customerdetails.php");

    assert.equal(response, null, "a refused connection should return null");
    assert.ok(loggedAt(entries, "error", "Connection refused"), "ECONNREFUSED should log the refused message");
  });

  test("classifies a wrapped reset connection by the errno in its cause", async (t) => {

    const { emit, entries, platform } = buildPlatform();

    t.after(() => emit(SHUTDOWN_EVENT));
    await using dispatcher = installMockDispatcher();
    const reset = new TypeError("fetch failed");

    reset.cause = { code: "ECONNRESET" };
    dispatcher.agent.get(HYDRAWISE_ORIGIN).intercept({ method: "GET", path: addressesEndpoint("customerdetails.php") })
      .replyWithError(reset);

    const response = await platform.retrieve("customerdetails.php");

    assert.equal(response, null, "a reset connection should return null");
    assert.ok(loggedAt(entries, "error", "Connection has been reset"), "ECONNRESET should log the reset message");
  });

  test("classifies a wrapped unresolved hostname by the errno in its cause", async (t) => {

    const { emit, entries, platform } = buildPlatform();

    t.after(() => emit(SHUTDOWN_EVENT));
    await using dispatcher = installMockDispatcher();
    const notFound = new TypeError("fetch failed");

    notFound.cause = { code: "ENOTFOUND" };
    dispatcher.agent.get(HYDRAWISE_ORIGIN).intercept({ method: "GET", path: addressesEndpoint("customerdetails.php") })
      .replyWithError(notFound);

    const response = await platform.retrieve("customerdetails.php");

    assert.equal(response, null, "an unresolved hostname should return null");
    assert.ok(loggedAt(entries, "error", "Hostname or IP address not found"), "ENOTFOUND should log the not-found message");
  });

  test("logs the raw error for a cause code no sentence covers", async (t) => {

    const { emit, entries, platform } = buildPlatform();

    t.after(() => emit(SHUTDOWN_EVENT));
    await using dispatcher = installMockDispatcher();
    const other = new TypeError("fetch failed");

    other.cause = { code: "EPIPE", message: "broken pipe" };
    dispatcher.agent.get(HYDRAWISE_ORIGIN).intercept({ method: "GET", path: addressesEndpoint("customerdetails.php") })
      .replyWithError(other);

    const response = await platform.retrieve("customerdetails.php");

    assert.equal(response, null, "an unrecognized cause should still return null");
    assert.ok(loggedAt(entries, "error", "EPIPE"), "an unrecognized cause code should be logged verbatim");
  });

  test("classifies a refused connection in the bare shape undici's request() throws", async (t) => {

    const { emit, entries, platform } = buildPlatform();

    t.after(() => emit(SHUTDOWN_EVENT));
    await using dispatcher = installMockDispatcher();

    /* The shape a real socket failure arrives in on this path: a plain Error carrying the errno at the top level, with no cause beneath it. The wrapped rows above
     * assert the shape a fetch() rejection carries instead, so between them the classification is asserted against both of the shapes a caller can be handed rather
     * than against one of them.
     */
    dispatcher.agent.get(HYDRAWISE_ORIGIN).intercept({ method: "GET", path: addressesEndpoint("customerdetails.php") })
      .replyWithError(errnoError("connect ECONNREFUSED", "ECONNREFUSED"));

    const response = await platform.retrieve("customerdetails.php");

    assert.equal(response, null, "a refused connection should return null");
    assert.ok(loggedAt(entries, "error", "Connection refused"), "a bare ECONNREFUSED should log the refused message");
  });

  test("classifies a reset connection in the bare shape undici's request() throws", async (t) => {

    const { emit, entries, platform } = buildPlatform();

    t.after(() => emit(SHUTDOWN_EVENT));
    await using dispatcher = installMockDispatcher();
    dispatcher.agent.get(HYDRAWISE_ORIGIN).intercept({ method: "GET", path: addressesEndpoint("customerdetails.php") })
      .replyWithError(errnoError("socket hang up", "ECONNRESET"));

    const response = await platform.retrieve("customerdetails.php");

    assert.equal(response, null, "a reset connection should return null");
    assert.ok(loggedAt(entries, "error", "Connection has been reset"), "a bare ECONNRESET should log the reset message");
  });

  test("classifies a temporary resolver failure as a hostname that did not resolve", async (t) => {

    const { emit, entries, platform } = buildPlatform();

    t.after(() => emit(SHUTDOWN_EVENT));
    await using dispatcher = installMockDispatcher();

    // EAI_AGAIN is what a struggling resolver answers with in place of ENOTFOUND. Both mean the name did not resolve, so both read as the one sentence that says so.
    dispatcher.agent.get(HYDRAWISE_ORIGIN).intercept({ method: "GET", path: addressesEndpoint("customerdetails.php") })
      .replyWithError(errnoError("getaddrinfo EAI_AGAIN", "EAI_AGAIN"));

    const response = await platform.retrieve("customerdetails.php");

    assert.equal(response, null, "a temporary resolver failure should return null");
    assert.ok(loggedAt(entries, "error", "Hostname or IP address not found"), "EAI_AGAIN should log the not-found message");
  });

  test("classifies a host no route reaches as an API that could not be reached", async (t) => {

    const { emit, entries, platform } = buildPlatform();

    t.after(() => emit(SHUTDOWN_EVENT));
    await using dispatcher = installMockDispatcher();

    // EHOSTUNREACH is the platform saying no route leads to the host, which is a peer out of reach rather than one that refused, so it reads as its own sentence
    // rather than as the raw dump or the refused one.
    dispatcher.agent.get(HYDRAWISE_ORIGIN).intercept({ method: "GET", path: addressesEndpoint("customerdetails.php") })
      .replyWithError(errnoError("connect EHOSTUNREACH", "EHOSTUNREACH"));

    const response = await platform.retrieve("customerdetails.php");

    assert.equal(response, null, "an unreachable host should return null");
    assert.ok(loggedAt(entries, "error", "The Hydrawise API could not be reached"), "EHOSTUNREACH should log the unreachable message");
  });

  test("reports a request dispatched against a destroyed connection pool", async (t) => {

    const { emit, entries, platform } = buildPlatform();

    t.after(() => emit(SHUTDOWN_EVENT));
    await using dispatcher = installMockDispatcher();

    // The one fault the pool re-arm itself produces: a request already in flight when its dispatcher is destroyed settles this way, which is why it has a sentence
    // rather than reaching the raw dump.
    dispatcher.agent.get(HYDRAWISE_ORIGIN).intercept({ method: "GET", path: addressesEndpoint("customerdetails.php") })
      .replyWithError(new errors.ClientDestroyedError());

    const response = await platform.retrieve("customerdetails.php");

    assert.equal(response, null, "a request against a destroyed pool should return null");
    assert.ok(loggedAt(entries, "error", "interrupted while the connection was being reset"), "a destroyed pool should log the interrupted-request message");
  });

  test("classifies an expired certificate as a certificate verification failure", async (t) => {

    const { emit, entries, platform } = buildPlatform();

    t.after(() => emit(SHUTDOWN_EVENT));
    await using dispatcher = installMockDispatcher();

    // An expired certificate arrives carrying the platform's own verification verdict as its code, and a host clock set wrong is its usual cause, which is why
    // the sentence asks the user to check the host's date and time.
    dispatcher.agent.get(HYDRAWISE_ORIGIN).intercept({ method: "GET", path: addressesEndpoint("customerdetails.php") })
      .replyWithError(errnoError("certificate has expired", "CERT_HAS_EXPIRED"));

    const response = await platform.retrieve("customerdetails.php");

    assert.equal(response, null, "a certificate failure should return null");
    assert.ok(loggedAt(entries, "error", "Certificate verification failed for the Hydrawise API"), "CERT_HAS_EXPIRED should log the certificate message");
  });

  test("returns null and re-arms networking when the request deadline passes on the platform's clock", async (t) => {

    // Debug is on so the request line the timeout branch writes reaches the capture, through the warn channel the platform's debug gate emits on.
    const { clock, emit, entries, platform } = buildPlatform({ debug: true });
    const gate: PromiseWithResolvers<void> = Promise.withResolvers();

    t.after(() => {

      gate.resolve();
      emit(SHUTDOWN_EVENT);
    });

    await using dispatcher = installMockDispatcher();

    /* A reply whose body waits on a gate that opens only after the row, so no answer reaches the request before its deadline does. The reply callback runs as the
     * request reaches the MockAgent, which is the witness that the request is on the wire, its deadline armed, before the row steps the clock.
     */
    let dispatched = false;

    dispatcher.agent.get(HYDRAWISE_ORIGIN).intercept({ method: "GET", path: addressesEndpoint("customerdetails.php") })
      .reply(200, async (): Promise<object> => {

        dispatched = true;
        await gate.promise;

        return { controller_id: 500001 };
      });

    const armed = dispatcherOf(platform);
    const answers: Nullable<HydrawiseBodyRead>[] = [];
    const retrieving = platform.retrieve("customerdetails.php");

    void retrieving.then((answer): void => {

      answers.push(answer);
    });

    await settleUntil(() => dispatched, { description: "the request to reach the wire" });

    // The answer is read through the turns that follow each step rather than awaited, so a deadline left off the platform's clock cannot answer in real time
    // inside the row's own timeout.
    clock.advance((HYDRAWISE_API_TIMEOUT * 1000) - 1);

    assert.equal(await Promise.race([ retrieving.then(() => "answered"), settle().then(() => "pending") ]), "pending",
      "a millisecond short of the deadline the request is still waiting on its reply");

    clock.advance(1);
    await settleUntil(() => answers.length === 1, { description: "the request to answer once its deadline passed" });

    assert.deepEqual(answers, [null], "a request the deadline cut off answers null");
    assert.ok(loggedAt(entries, "error", "taking too long"), "the timeout branch should log the slow-response message");
    assert.ok(loggedAt(entries, "warn", "Original request was"), "the timeout branch names the request at debug");
    assert.ok(loggedAt(entries, "warn", "api_key=redacted"), "with the API key redacted from the query it reports");
    assert.ok(!loggedAt(entries, "warn", "test-api-key"), "so the key itself never reaches the log");
    assert.notEqual(dispatcherOf(platform), armed, "the deadline re-arms the stack, so the platform holds a different dispatcher");
    assert.equal(armed?.destroyed, true, "and the pool it replaced was destroyed rather than left open");
  });

  test("a deadline met while a poll's status body is read writes the poll's sentence alone and re-arms no pool", async (t) => {

    // The held end is the status endpoint's alone, so discovery's controller list arrives whole and the first poll's body is the one left mid-read.
    const { clock, emit, entries, platform } = buildPlatform();
    const heldEnd = heldEndFor("statusschedule.php");

    t.after(() => emit(SHUTDOWN_EVENT));
    await using dispatcher = installMockDispatcher({ heldEnd });
    programJsonReply(dispatcher.agent, "customerdetails.php", makeCustomerDetails());
    programJsonReply(dispatcher.agent, "statusschedule.php", normalSchedule());

    emit(DID_FINISH_LAUNCHING_EVENT);
    await heldEnd.reached;

    const armed = dispatcherOf(platform);
    const refused = (): boolean => loggedAt(entries, "error", STATUS_SENTENCE);

    clock.advance((HYDRAWISE_API_TIMEOUT * 1000) - 1);
    await settle();

    assert.equal(refused(), false, "a millisecond short of the deadline the status body is still being read");

    clock.advance(1);
    await settleUntil(refused, { description: "the poll to refuse the status body its deadline cut off" });

    assert.deepEqual(linesAt(entries, "error"), ["Test Controller: " + STATUS_SENTENCE + ": The operation was aborted due to timeout."],
      "the poll names the deadline its read met, and the request log, which counted the request as answered, says nothing");
    assert.equal(dispatcherOf(platform), armed, "a deadline met mid-read re-arms no pool, since the request itself was answered");
  });

  test("the request deadline leaves the platform's clock as the body's read settles", async (t) => {

    const { clock, emit, platform } = buildPlatform();
    const heldEnd = heldEndFor("customerdetails.php");

    t.after(() => emit(SHUTDOWN_EVENT));
    await using dispatcher = installMockDispatcher({ heldEnd });
    programJsonReply(dispatcher.agent, "customerdetails.php", { controller_id: 500001 });

    const retrieving = platform.retrieve("customerdetails.php");

    // A turn after the held end is reached, the request's own continuations have run while its body's end is still held, so a deadline released ahead of the read
    // is already gone and one released with it still stands.
    await heldEnd.reached;
    await settle();

    assert.equal(clock.pending, 1, "while the body is still being read, the request's deadline stands on the platform's clock");
    assert.equal(clock.nextDeadline, HYDRAWISE_API_TIMEOUT * 1000, "one request timeout from the request's admission");

    heldEnd.release();

    assert.deepEqual(await retrieving, { body: { controller_id: 500001 }, status: "parsed" }, "the released body reads whole");
    assert.equal(clock.pending, 0, "and the deadline left the clock as the read settled, so nothing the request armed outlives it");
  });

  test("returns null and re-arms networking on a response deadline", async (t) => {

    const { emit, entries, platform } = buildPlatform();

    t.after(() => emit(SHUTDOWN_EVENT));
    await using dispatcher = installMockDispatcher();

    // The transport's own header deadline is a deadline elapsing exactly as the composed per-request timeout is, so it takes the same arm: the same sentence, and
    // the same replacement of a pool whose single connection every in-flight request was using.
    dispatcher.agent.get(HYDRAWISE_ORIGIN).intercept({ method: "GET", path: addressesEndpoint("customerdetails.php") })
      .replyWithError(new errors.HeadersTimeoutError());

    const armed = dispatcherOf(platform);

    const response = await platform.retrieve("customerdetails.php");

    assert.equal(response, null, "a response deadline should return null");
    assert.ok(loggedAt(entries, "error", "taking too long"), "a response deadline should log the slow-response message");
    assert.notEqual(dispatcherOf(platform), armed, "the deadline re-arms the stack, so the platform holds a different dispatcher");
    assert.equal(armed?.destroyed, true, "and the pool it replaced was destroyed rather than left open");
  });

  test("reports a repeated failure once at error and replays the repeat at debug", async (t) => {

    // Debug is on so the demoted replay reaches the capture, through the warn channel the platform's debug gate emits on.
    const { emit, entries, platform } = buildPlatform({ debug: true });

    t.after(() => emit(SHUTDOWN_EVENT));
    await using dispatcher = installMockDispatcher();

    // Each status reply answers one request, in the order it was programmed.
    programStatusReply(dispatcher.agent, "customerdetails.php", 404);
    programStatusReply(dispatcher.agent, "customerdetails.php", 404);

    assert.equal(await platform.retrieve("customerdetails.php"), null, "the first 404 returns null");
    assert.equal(await platform.retrieve("customerdetails.php"), null, "and so does the repeat, so no caller sees the demotion");
    assert.equal(logCount(entries, "error", "Invalid API key"), 1, "the invalid key is reported at error once");
    assert.equal(logCount(entries, "warn", "Invalid API key"), 1, "and its repeat is replayed at debug");
  });

  test("reports a failure in full again once a request succeeds in between", async (t) => {

    // Debug is on so a replay, were one wrongly made, would reach the capture rather than be dropped by the gate.
    const { emit, entries, platform } = buildPlatform({ debug: true });

    t.after(() => emit(SHUTDOWN_EVENT));
    await using dispatcher = installMockDispatcher();

    // A status reply rather than a JSON one for the success, because the JSON form persists and would answer the last request too.
    programStatusReply(dispatcher.agent, "customerdetails.php", 404);
    programStatusReply(dispatcher.agent, "customerdetails.php", 200, { controller_id: 500001 });
    programStatusReply(dispatcher.agent, "customerdetails.php", 404);

    assert.equal(await platform.retrieve("customerdetails.php"), null, "the first 404 returns null");

    assert.equal((await platform.retrieve("customerdetails.php"))?.status, "parsed", "the 200 between the failures answers its body");
    assert.equal(await platform.retrieve("customerdetails.php"), null, "the second 404 returns null");
    assert.equal(logCount(entries, "error", "Invalid API key"), 2, "the success between them restores the full report, so each 404 reads at error");
    assert.equal(logCount(entries, "warn", "Invalid API key"), 0, "and neither is replayed at debug");
  });

  test("reports a changed failure reason in full", async (t) => {

    // Debug is on so a replay, were one wrongly made, would reach the capture rather than be dropped by the gate.
    const { emit, entries, platform } = buildPlatform({ debug: true });

    t.after(() => emit(SHUTDOWN_EVENT));
    await using dispatcher = installMockDispatcher();
    programStatusReply(dispatcher.agent, "customerdetails.php", 404);
    programStatusReply(dispatcher.agent, "customerdetails.php", 429);

    assert.equal(await platform.retrieve("customerdetails.php"), null, "the 404 returns null");
    assert.equal(await platform.retrieve("customerdetails.php"), null, "and so does the 429");
    assert.equal(logCount(entries, "error", "Invalid API key"), 1, "the invalid key is reported at error");
    assert.equal(logCount(entries, "error", "rate limit"), 1, "and the rate limit after it, a different reason, is reported at error too");
    assert.equal(logCount(entries, "warn", "rate limit"), 0, "rather than replayed at debug");
  });

  test("reports a repeated transport failure once at error and replays the repeat at debug", async (t) => {

    // Debug is on so the demoted replay reaches the capture, through the warn channel the platform's debug gate emits on.
    const { emit, entries, platform } = buildPlatform({ debug: true });

    t.after(() => emit(SHUTDOWN_EVENT));
    await using dispatcher = installMockDispatcher();

    // A failure the catch arms classify rather than a status arm, so the demotion is proven on the transport side of the request too. Each intercept answers one
    // request.
    for(let attempt = 0; attempt < 2; attempt++) {

      dispatcher.agent.get(HYDRAWISE_ORIGIN).intercept({ method: "GET", path: addressesEndpoint("customerdetails.php") })
        .replyWithError(errnoError("connect ECONNREFUSED", "ECONNREFUSED"));
    }

    assert.equal(await platform.retrieve("customerdetails.php"), null, "the first refused connection returns null");
    assert.equal(await platform.retrieve("customerdetails.php"), null, "and so does the repeat");
    assert.equal(logCount(entries, "error", "Connection refused"), 1, "the refused connection is reported at error once");
    assert.equal(logCount(entries, "warn", "Connection refused"), 1, "and its repeat is replayed at debug");
  });
});
