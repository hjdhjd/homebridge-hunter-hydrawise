/* Copyright(C) 2017-2026, HJD (https://github.com/hjdhjd). All rights reserved.
 *
 * commands.test.ts: The command queue on its own, driven through handlers a row makes throw on demand, so a fault is met at each place the queue works a target -
 * a confirmation's effects, the preparing of a command, a send that rejects or throws as it is made, and the write that puts a control back. Covers the
 * containment the queue promises: a fault is said once through the logger the queue is handed, the next target in line is still sent, the queue falls idle, no
 * rejection goes unhandled, and a fault met after the platform shuts down says nothing. Covers too the one slot in flight across a timeout's answer, with another
 * target tapped in the same turn, and what forgetting, sweeping or retiring a record leaves behind.
 */

// The Hydrawise API wire shapes use snake_case keys such as relay_id, so camelcase is disabled here to let the zone fixtures mirror the wire verbatim.
/* eslint-disable camelcase */
import type { HydrawiseCommandHandlers, HydrawiseCommandTarget, HydrawiseCommandValue, HydrawisePreparedCommand } from "./commands.ts";
import { assertNoUnhandledRejections, capturingLog, linesAt, present, waitUntil } from "homebridge-plugin-utils/testing";
import { describe, test } from "node:test";
import type { CapturingLog } from "homebridge-plugin-utils/testing";
import { HYDRAWISE_REVERT_DELAY } from "./settings.ts";
import type { HydrawiseCommandOutcome } from "./types.ts";
import { HydrawiseCommandQueue } from "./commands.ts";
import { TimerRegistry } from "homebridge-plugin-utils";
import assert from "node:assert/strict";
import { setTimeout as delay } from "node:timers/promises";
import { makeZone } from "./api.helpers.ts";

// The fault every row throws, and the line the queue says it in.
const FAULT = new Error("The handler failed.");
const FAULT_LINE = "Unable to finish a command to Hydrawise: The handler failed.";

// How long, in milliseconds, a row waits for the queue to fall idle before it calls the queue wedged. A queue that contains its faults falls idle within a few
// turns, so the span separates the two however the machine is loaded.
const IDLE_MS = 1000;

// The targets every row queues, in the order it queues them: the account-wide switch, whose handlers a row makes throw, then a zone's valve, waiting its turn.
const SUSPEND_ALL: HydrawiseCommandTarget = { kind: "suspend-all" };
const VALVE: HydrawiseCommandTarget = { kind: "valve", zone: makeZone() };

// The confirmed suspension a row forgets or sweeps. The harness's one fault in those rows is in writing the switch's control, which none of them reaches.
const RECORD = { at: 100, commandedUntil: 200 };

// Where a row makes the account-wide switch's handlers throw: in its confirmation's effects, as its command is prepared, in a send that rejects, when its
// control is written, or in a send that throws as it is made.
type HydrawiseQueueFault = "confirm" | "prepare" | "reject" | "render" | "throw";

// The queue under test and what a row reads of it: the targets sent, the controls written and the requests reported as not taking, in order, and the logger the
// queue was handed.
interface QueueHarness {

  lifetime: AbortController;
  log: CapturingLog;
  queue: HydrawiseCommandQueue;
  release: () => void;
  rendered: HydrawiseCommandTarget["kind"][];
  sent: HydrawiseCommandTarget["kind"][];
  unconfirmed: HydrawiseCommandTarget["kind"][];
}

/* Build a queue over handlers that answer every command with the given outcome and throw the given fault for the account-wide switch alone. A held queue answers
 * no send until the row releases it, which is how a row puts a fault after the platform has shut down.
 */
function buildQueue({ fault, held = false, outcome = { status: "confirmed" } }: { fault: HydrawiseQueueFault; held?: boolean;
  outcome?: HydrawiseCommandOutcome; }): QueueHarness {

  const lifetime = new AbortController();
  const log = capturingLog();
  const gate: PromiseWithResolvers<void> = Promise.withResolvers();
  const rendered: HydrawiseCommandTarget["kind"][] = [];
  const sent: HydrawiseCommandTarget["kind"][] = [];
  const unconfirmed: HydrawiseCommandTarget["kind"][] = [];
  const faults = (target: HydrawiseCommandTarget, where: HydrawiseQueueFault): boolean => (target.kind === "suspend-all") && (fault === where);

  if(!held) {

    gate.resolve();
  }

  const handlers: HydrawiseCommandHandlers = {

    available: (): boolean => true,
    prepare: (target): HydrawisePreparedCommand => {

      if(faults(target, "prepare")) {

        throw FAULT;
      }

      return {

        confirmed: (): void => {

          if(faults(target, "confirm")) {

            throw FAULT;
          }
        },

        // The send is a plain function rather than an async one, so the throw below happens as the send is made rather than as a rejection.
        send: (): Promise<HydrawiseCommandOutcome> => {

          sent.push(target.kind);

          if(faults(target, "throw")) {

            throw FAULT;
          }

          return gate.promise.then((): HydrawiseCommandOutcome => {

            if(faults(target, "reject")) {

              throw FAULT;
            }

            return outcome;
          });
        }
      };
    },
    read: (): HydrawiseCommandValue => ({ on: false }),
    render: (target): void => {

      rendered.push(target.kind);

      if(faults(target, "render")) {

        throw FAULT;
      }
    },
    unconfirmed: (target): void => {

      unconfirmed.push(target.kind);
    }
  };

  const queue = new HydrawiseCommandQueue({ handlers, log, name: "500001", signal: lifetime.signal, timers: new TimerRegistry({ signal: lifetime.signal }) });

  return { lifetime, log, queue, release: (): void => gate.resolve(), rendered, sent, unconfirmed };
}

// Queue the account-wide switch's command and then the valve's, in one turn, so the valve waits its turn behind the switch.
function enqueueBoth(queue: HydrawiseCommandQueue): void {

  queue.enqueue(SUSPEND_ALL, { on: true, origin: "homekit" });
  queue.enqueue(VALVE, { duration: 300, on: true, origin: "homekit" });
}

// Wait for the queue to fall idle, failing the row rather than hanging it when the queue is wedged. The deadline is cancelled once the race settles, so a row
// that fell idle leaves no timer behind it.
async function idleWithin(queue: HydrawiseCommandQueue): Promise<void> {

  const deadline = new AbortController();

  try {

    await Promise.race([ queue.idle, delay(IDLE_MS, undefined, { signal: deadline.signal }).then((): never => {

      throw new Error("The queue did not fall idle within " + IDLE_MS.toString() + " ms.");
    }) ]);
  } finally {

    deadline.abort();
  }
}

describe("HydrawiseCommandQueue fault containment", () => {

  test("an error thrown by a confirmation's effects is said once, and the next target is still sent", async (t) => {

    const h = buildQueue({ fault: "confirm" });

    t.after(() => h.lifetime.abort());

    await assertNoUnhandledRejections(async () => {

      enqueueBoth(h.queue);
      await idleWithin(h.queue);
    });

    assert.deepEqual(h.sent, [ "suspend-all", "valve" ], "the valve's turn still comes once the confirmation faults");
    assert.deepEqual(linesAt(h.log.entries, "error"), [FAULT_LINE], "and the fault is said once");
    assert.equal(h.queue.pending(SUSPEND_ALL), undefined, "the switch's confirmed command holds nothing pending");

    await waitUntil(() => h.rendered.includes("suspend-all"), { description: "the suspend-all switch to be written" });
  });

  test("a confirmation that faults with a newer request waiting behind it leaves that request to be sent", async (t) => {

    const h = buildQueue({ fault: "confirm", held: true });

    t.after(() => h.lifetime.abort());

    await assertNoUnhandledRejections(async () => {

      h.queue.enqueue(SUSPEND_ALL, { on: true, origin: "homekit" });
      await waitUntil(() => h.sent.length === 1, { description: "the switch's command to be sent" });
      h.queue.enqueue(SUSPEND_ALL, { on: false, origin: "homekit" });
      h.release();
      await idleWithin(h.queue);
    });

    assert.deepEqual(h.sent, [ "suspend-all", "suspend-all" ], "the request the confirmation had already moved on to is still sent");
    assert.deepEqual(linesAt(h.log.entries, "error"), [ FAULT_LINE, FAULT_LINE ], "and each confirmation's fault is said once");
  });

  test("an error thrown while a command is prepared drops that target alone, and the next target is still sent", async (t) => {

    const h = buildQueue({ fault: "prepare" });

    t.after(() => h.lifetime.abort());

    await assertNoUnhandledRejections(async () => {

      enqueueBoth(h.queue);
      await idleWithin(h.queue);
    });

    assert.deepEqual(h.sent, ["valve"], "the switch's command never reaches the wire, and the valve's does");
    assert.deepEqual(linesAt(h.log.entries, "error"), [FAULT_LINE], "the fault is said once");
    assert.equal(h.queue.pending(SUSPEND_ALL), undefined, "and the switch's request is dropped");

    await waitUntil(() => h.rendered.includes("suspend-all"), { description: "the suspend-all switch to be written back" });
  });

  for(const fault of [ "reject", "throw" ] as const) {

    test("a send that " + ((fault === "reject") ? "rejects" : "throws as it is made") + " settles its attempt, and the next target is still sent", async (t) => {

      const h = buildQueue({ fault });

      t.after(() => h.lifetime.abort());

      await assertNoUnhandledRejections(async () => {

        enqueueBoth(h.queue);
        await idleWithin(h.queue);
      });

      assert.deepEqual(h.sent, [ "suspend-all", "valve" ], "the faulty send gives up the one slot in flight, and the valve's turn comes");
      assert.deepEqual(linesAt(h.log.entries, "error"), [FAULT_LINE], "the fault is said once");
      assert.equal(h.queue.pending(SUSPEND_ALL), undefined, "and the switch's request rests rather than waiting on an answer that never comes");

      await waitUntil(() => h.rendered.includes("suspend-all"), { description: "the suspend-all switch to be written back" });
    });
  }

  test("a write that throws is said once and not written again", async (t) => {

    const h = buildQueue({ fault: "render", outcome: { reason: "Zone is disabled.", status: "refused" } });

    t.after(() => h.lifetime.abort());

    await assertNoUnhandledRejections(async () => {

      enqueueBoth(h.queue);
      await idleWithin(h.queue);
      await waitUntil(() => h.rendered.includes("suspend-all"), { description: "the refused switch to be written back" });

      // Several write delays pass, any of which a rewrite of the faulty control would have landed in.
      await delay(HYDRAWISE_REVERT_DELAY * 4);
    });

    assert.deepEqual(h.unconfirmed, [ "suspend-all", "valve" ], "each refusal is reported as the controller's own to say");
    assert.deepEqual(h.rendered.filter(kind => kind === "suspend-all"), ["suspend-all"], "the faulty control is written once");
    assert.deepEqual(linesAt(h.log.entries, "error"), [FAULT_LINE], "and the fault is said once");
  });

  test("a fault met after the platform shuts down says nothing", async (t) => {

    const h = buildQueue({ fault: "reject", held: true });

    t.after(() => h.lifetime.abort());

    await assertNoUnhandledRejections(async () => {

      enqueueBoth(h.queue);
      await waitUntil(() => h.sent.length === 1, { description: "the switch's command to be sent" });
      h.lifetime.abort();
      h.release();
      await idleWithin(h.queue);
    });

    assert.deepEqual(h.sent, ["suspend-all"], "nothing more is sent after shutdown");
    assert.equal(h.log.entries.length, 0, "and the fault is not said");
  });
});

describe("HydrawiseCommandQueue one command in flight", () => {

  test("a timeout answered first and another target tapped after it in one synchronous turn keeps one command in flight", async (t) => {

    const lifetime = new AbortController();

    t.after(() => lifetime.abort());

    const sends: { answer: PromiseWithResolvers<HydrawiseCommandOutcome>; kind: HydrawiseCommandTarget["kind"] }[] = [];

    /* Each send has its own resolver, and the send is a plain function returning that resolver's promise. An async wrapper or a further .then would add a turn between
     * the answer and the queue reading it, and that turn hides what this row holds: the pass the tap queues runs before the settling, so the slot has to be taken
     * until the settling has run.
     */
    const handlers: HydrawiseCommandHandlers = {

      available: (): boolean => true,
      prepare: (target): HydrawisePreparedCommand => ({

        confirmed: (): void => undefined,
        send: (): Promise<HydrawiseCommandOutcome> => {

          const answer = Promise.withResolvers<HydrawiseCommandOutcome>();

          sends.push({ answer, kind: target.kind });

          return answer.promise;
        }
      }),
      read: (): HydrawiseCommandValue => ({ on: false }),
      render: (): void => undefined,
      unconfirmed: (): void => undefined
    };

    const queue = new HydrawiseCommandQueue({ handlers, log: capturingLog(), name: "500001", signal: lifetime.signal,
      timers: new TimerRegistry({ signal: lifetime.signal }) });
    const kinds = (): HydrawiseCommandTarget["kind"][] => sends.map(send => send.kind);

    queue.enqueue(SUSPEND_ALL, { on: true, origin: "homekit" });
    await waitUntil(() => sends.length === 1, { description: "the switch's command to be sent" });

    // The one synchronous turn, in this order: the answer lands, and then the valve is tapped.
    present(sends[0], "the switch's send").answer.resolve({ status: "timeout" });
    queue.enqueue(VALVE, { duration: 300, on: true, origin: "homekit" });

    await waitUntil(() => sends.length > 1, { description: "the next command to be sent" });
    await delay(HYDRAWISE_REVERT_DELAY);

    assert.deepEqual(kinds(), [ "suspend-all", "suspend-all" ], "the resend is the one command in flight, with the valve waiting behind it");

    present(sends[1], "the switch's resend").answer.resolve({ status: "confirmed" });
    await waitUntil(() => sends.length > 2, { description: "the valve's command to be sent" });

    assert.deepEqual(kinds(), [ "suspend-all", "suspend-all", "valve" ], "and the valve's turn comes once the resend is answered");

    present(sends[2], "the valve's send").answer.resolve({ status: "confirmed" });
    await idleWithin(queue);
  });
});

describe("HydrawiseCommandQueue forgetting a record", () => {

  test("a target resting on its record is forgotten, and a target holding nothing stays that way", async (t) => {

    const h = buildQueue({ fault: "render" });

    t.after(() => h.lifetime.abort());

    h.queue.stamp(SUSPEND_ALL, RECORD);
    h.queue.forget(SUSPEND_ALL);

    assert.equal(h.queue.record(SUSPEND_ALL), undefined, "the record is gone");

    h.queue.forget(SUSPEND_ALL);

    assert.equal(h.queue.record(SUSPEND_ALL), undefined, "and forgetting it again changes nothing");

    await idleWithin(h.queue);
  });

  test("a target with a request pending keeps the request and rests on nothing once it settles", async (t) => {

    const h = buildQueue({ fault: "render", held: true });

    t.after(() => h.lifetime.abort());

    h.queue.stamp(SUSPEND_ALL, RECORD);
    h.queue.enqueue(SUSPEND_ALL, { on: true, origin: "homekit" });
    h.queue.forget(SUSPEND_ALL);

    assert.equal(h.queue.record(SUSPEND_ALL), undefined, "the record is gone");
    assert.deepEqual(h.queue.pending(SUSPEND_ALL), { on: true, origin: "homekit" }, "and the request is still pending");

    h.release();
    await idleWithin(h.queue);

    assert.deepEqual(h.sent, ["suspend-all"], "the request is still sent");
    assert.equal(h.queue.record(SUSPEND_ALL), undefined, "and the target has no record to rest on");
  });
});

describe("HydrawiseCommandQueue sweeping records", () => {

  test("the account-wide record answers to the judgment alone, while a zone's also leaves with its zone", async (t) => {

    const h = buildQueue({ fault: "render" });
    const zone: HydrawiseCommandTarget = { kind: "zone-suspend", zone: makeZone() };

    t.after(() => h.lifetime.abort());

    h.queue.stamp(SUSPEND_ALL, RECORD);
    h.queue.stamp(zone, RECORD);
    h.queue.sweep({ reported: new Set(), stands: (): boolean => true });

    assert.equal(h.queue.record(zone), undefined, "a zone the wire no longer reports takes its record along");
    assert.deepEqual(h.queue.record(SUSPEND_ALL), RECORD, "and no zone report can speak for the account-wide record, which still stands");

    h.queue.sweep({ reported: new Set(), stands: (): boolean => false });

    assert.equal(h.queue.record(SUSPEND_ALL), undefined, "a record that no longer stands retires");

    await idleWithin(h.queue);
  });

  test("a request pending on the account-wide target survives its record's retirement and rests on nothing once it settles", async (t) => {

    const h = buildQueue({ fault: "render", held: true });

    t.after(() => h.lifetime.abort());

    h.queue.stamp(SUSPEND_ALL, RECORD);
    h.queue.enqueue(SUSPEND_ALL, { on: true, origin: "homekit" });
    h.queue.sweep({ reported: new Set(), stands: (): boolean => false });

    assert.equal(h.queue.record(SUSPEND_ALL), undefined, "the record is gone");
    assert.deepEqual(h.queue.pending(SUSPEND_ALL), { on: true, origin: "homekit" }, "and the request is still pending");

    h.release();
    await idleWithin(h.queue);

    assert.deepEqual(h.sent, ["suspend-all"], "the request is still sent");
    assert.equal(h.queue.record(SUSPEND_ALL), undefined, "and the target has no record to rest on");
  });
});

describe("HydrawiseCommandQueue retiring zone records", () => {

  test("every zone's record retires, the account-wide record stands, and a request pending on a zone keeps its turn", async (t) => {

    const h = buildQueue({ fault: "render", held: true });
    const resting: HydrawiseCommandTarget = { kind: "zone-suspend", zone: makeZone({ relay_id: 700001 }) };
    const pending: HydrawiseCommandTarget = { kind: "zone-suspend", zone: makeZone({ relay_id: 700002 }) };

    t.after(() => h.lifetime.abort());

    h.queue.stamp(SUSPEND_ALL, RECORD);
    h.queue.stamp(resting, RECORD);
    h.queue.stamp(pending, RECORD);
    h.queue.enqueue(pending, { on: true, origin: "homekit" });
    h.queue.retireZoneRecords();

    assert.equal(h.queue.record(resting), undefined, "a zone resting on its record is left with none");
    assert.equal(h.queue.record(pending), undefined, "and so is a zone with a request pending");
    assert.deepEqual(h.queue.pending(pending), { on: true, origin: "homekit" }, "whose request is still pending");
    assert.deepEqual(h.queue.record(SUSPEND_ALL), RECORD, "while the account-wide record is the confirmation's own to replace");

    h.release();
    await idleWithin(h.queue);

    assert.deepEqual(h.sent, ["zone-suspend"], "the request is still sent");
    assert.equal(h.queue.record(pending), undefined, "and the target has no record to rest on");
  });
});
