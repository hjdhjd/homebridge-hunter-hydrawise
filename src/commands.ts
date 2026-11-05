/* Copyright(C) 2017-2026, HJD (https://github.com/hjdhjd). All rights reserved.
 *
 * commands.ts: The per-controller queue every command a Hydrawise controller sends goes through.
 */
import { HYDRAWISE_COMMAND_ATTEMPTS, HYDRAWISE_REVERT_DELAY } from "./settings.ts";
import type { HomebridgePluginLogging, Nullable, TimerRegistry } from "homebridge-plugin-utils";
import type { HydrawiseCommandOutcome, HydrawiseZoneConfig } from "./types.ts";
import { formatErrorMessage } from "homebridge-plugin-utils";

// One control a controller commands Hydrawise through: the account-wide suspend switch, or one zone's valve or suspension switch, carrying the wire zone it names.
export type HydrawiseCommandTarget = { kind: "suspend-all" } | { kind: "valve" | "zone-suspend"; zone: HydrawiseZoneConfig };

// What a control asks for: whether it is on - a switch's On, which means suspended, or a valve's Active - and how long a valve run lasts, so that two runs of different
// lengths are two different requests.
export interface HydrawiseCommandValue {

  readonly duration?: number;
  readonly on: boolean;
}

// One request a user made of a control, and where it came from. A request made in HomeKit is judged by the accessory hosting its control, and one made over MQTT by
// the controller, which is the rule each path applies when the request first arrives.
export interface HydrawiseCommandIntent extends HydrawiseCommandValue {

  readonly origin: "homekit" | "mqtt";
}

/* A suspension Hydrawise confirmed: the instant it confirmed it, in whole seconds on the platform clock, and WHICH WAY it went - the instant the suspension lifts,
 * or null for a resume. A bare instant would say that the user commanded something, which is enough to know that an older snapshot is uninformed, but not enough
 * to know what to show in its place.
 */
export interface HydrawiseCommandRecord {

  readonly at: number;
  readonly commandedUntil: Nullable<number>;
}

// One command made ready to send: the send itself, made once per attempt with the signal that withdraws the attempt while it waits for admission, and what
// Hydrawise's confirmation sets in motion.
export interface HydrawisePreparedCommand {

  readonly confirmed: () => void;
  readonly send: (signal: AbortSignal) => Promise<HydrawiseCommandOutcome>;
}

// Why a target's latest request ended without taking: Hydrawise refused it, the request failed, or its reply could not be read, no attempt was answered, or the
// control could no longer answer for it when its turn came.
export type HydrawiseUnconfirmedCommand = Extract<HydrawiseCommandOutcome, { status: "failed" | "refused" | "unreadable" }> | { status: "exhausted" | "unavailable" };

// What the queue asks of the controller it serves. Each is called for one target at a time and answers from the controller's state at that moment.
export interface HydrawiseCommandHandlers {

  // Whether the target's control can still answer for the request when its turn comes.
  available: (target: HydrawiseCommandTarget, intent: HydrawiseCommandIntent) => boolean;

  // Make a request ready to send. Its turn has come, so any instant the command carries is taken now.
  prepare: (target: HydrawiseCommandTarget, intent: HydrawiseCommandIntent) => HydrawisePreparedCommand;

  // What the target's control reads, with nothing of its own waiting to be sent.
  read: (target: HydrawiseCommandTarget) => HydrawiseCommandValue;

  // Write what the target's control reads.
  render: (target: HydrawiseCommandTarget) => void;

  // Say why the target's latest request did not take.
  unconfirmed: (target: HydrawiseCommandTarget, intent: HydrawiseCommandIntent, outcome: HydrawiseUnconfirmedCommand) => void;
}

// One request not yet on the wire, beside what its control showed before it, which is the value a reversal returns to. Null means that value is unknown, because a
// command for the target went unanswered and may have taken, so no request is a reversal of it.
interface HydrawiseUnsentIntent {

  readonly intent: HydrawiseCommandIntent;
  readonly shown: Nullable<HydrawiseCommandValue>;
}

/* Where one target stands, as one state rather than parallel fields that could disagree. Idle targets are not stored. A confirmed target holds the suspension
 * Hydrawise last confirmed for it. A queued target waits its turn with its request, and a sending target has one attempt of its request in flight, with any newer
 * request waiting behind it; both carry the confirmed record they stand on, so every reader and the retirement sweep see it until a confirmation replaces it. The
 * sending state's withdrawal is the attempt's own, which withdraws it while it waits for admission and tells its outcome from any later attempt's.
 */
type HydrawiseTargetState = { record: HydrawiseCommandRecord; status: "confirmed" } |
  { record?: HydrawiseCommandRecord; status: "queued"; unsent: HydrawiseUnsentIntent } |
  { attempt: number; prepared: HydrawisePreparedCommand; record?: HydrawiseCommandRecord; status: "sending"; unsent: HydrawiseUnsentIntent;
    waiting?: HydrawiseUnsentIntent; withdrawal: AbortController; };

// A target with one attempt of its command in flight.
type HydrawiseSendingState = Extract<HydrawiseTargetState, { status: "sending" }>;

// One stored target and where it stands.
interface HydrawiseTargetEntry {

  state: HydrawiseTargetState;
  target: HydrawiseCommandTarget;
}

// Whether a request asks a control for the same thing as a value it is weighed against. An unknown value matches nothing.
function sameValue(a: HydrawiseCommandValue, b: Nullable<HydrawiseCommandValue>): boolean {

  return (b !== null) && (a.on === b.on) && (a.duration === b.duration);
}

// Whether a target still holds one attempt of its command, the one state that attempt's answer, or a fault met while carrying it, may speak for.
function holdsAttempt(state: HydrawiseTargetState, withdrawal: AbortController): state is HydrawiseSendingState {

  return (state.status === "sending") && (state.withdrawal === withdrawal);
}

/* The one queue a controller sends every command through: its Suspend All switch, each zone's valve, each zone's suspension switch, and the MQTT starts and stops.
 *
 * A control answers HomeKit the moment it is written, and the queue carries the request to Hydrawise afterward, at the pace the command ceiling allows. Each target
 * holds the latest request alone. A newer request replaces one still waiting and moves its target to the back of the line, so the sends follow the order of the
 * latest taps, and a request that returns the control to what it showed before the first unsent request is a reversal that sends nothing at all. Every other
 * request is sent. A request already in flight cannot be recalled once admitted, so a newer one waits behind it, while one still waiting for admission is
 * withdrawn. A withdrawal takes no slot, with one limit: one that lands after the command budget has admitted the command, while the account budget still holds
 * it, spends one command slot.
 *
 * One command is in flight per controller, so commands reach Hydrawise in the order the user settled on. Hydrawise's answer settles each one: a confirmation runs
 * what it sets in motion, a timeout is sent again while it is still the latest request, and a refusal, a failure or a reply that could not be read puts the
 * control back to what it reads, saying why, but only while that command is still the latest request for its target, because a newer request already shows the
 * user what they chose. A request made while a command was on the wire is sent in its turn whatever that command came to. An unanswered command may have taken, so
 * from a timeout on what its control showed is unknown, no request for that target is a reversal, and the latest one is always sent. Nothing is said, stamped or
 * written once the platform shuts down.
 *
 * No error leaves the queue's own work: a fault thrown while a target is judged, prepared, sent, settled or written is said once through the controller's logger, and
 * the queue goes on to the next target, so one faulty command never holds the line and no error reaches Homebridge uncaught.
 */
export class HydrawiseCommandQueue {

  private readonly entries = new Map<string, HydrawiseTargetEntry>();
  private readonly handlers: HydrawiseCommandHandlers;

  // The controller's logger, which a contained fault is said through rather than through a handler, because the handler may be what threw.
  private readonly log: HomebridgePluginLogging;

  // Whether a command is in flight. One at a time is the controller's whole sending discipline.
  private inFlight = false;

  // The waiters for the queue to fall idle, resolved together the moment nothing is queued or in flight.
  private idleWaiters: Nullable<PromiseWithResolvers<void>> = null;

  // Whether a pass over the line is already scheduled, so a burst of requests in one turn schedules one.
  private pumpScheduled = false;

  // The queued targets' keys in the order they are sent: a Set keeps insertion order, and deleting a key before adding it again moves it to the back.
  private readonly queued = new Set<string>();
  private readonly signal: AbortSignal;

  // The prefix every timer key this queue arms carries, because the timer registry is the platform's, shared with every other controller's queue.
  private readonly timerPrefix: string;
  private readonly timers: TimerRegistry;

  /**
   * @param options          - The queue's surroundings.
   * @param options.handlers - What the queue asks of the controller it serves.
   * @param options.log      - The controller's logger, which names the controller on every line a contained fault writes.
   * @param options.name     - A name unique among the platform's controllers, which keeps this queue's timers apart from every other controller's.
   * @param options.signal   - The platform's lifetime signal. Nothing is sent, said, stamped or written once it aborts.
   * @param options.timers   - The platform's timer registry, which carries every deferred write and drains with the platform.
   */
  constructor({ handlers, log, name, signal, timers }: { handlers: HydrawiseCommandHandlers; log: HomebridgePluginLogging; name: string; signal: AbortSignal;
    timers: TimerRegistry; }) {

    this.handlers = handlers;
    this.log = log;
    this.signal = signal;
    this.timerPrefix = "command." + name + ".";
    this.timers = timers;
  }

  /**
   * Take a user's request of a control. It returns at once, before anything reaches the wire.
   *
   * @param target - The control the request is for.
   * @param intent - The request.
   */
  public enqueue(target: HydrawiseCommandTarget, intent: HydrawiseCommandIntent): void {

    if(this.signal.aborted) {

      return;
    }

    const key = this.keyOf(target);
    const entry = this.entries.get(key);

    switch(entry?.state.status) {

      // A request on a target with nothing pending always waits its turn. Its control showed what its reader answers.
      case undefined:
      case "confirmed": {

        this.entries.set(key, { state: { record: entry?.state.record, status: "queued", unsent: { intent, shown: this.handlers.read(target) } }, target });
        this.toBack(key);

        break;
      }

      // A request on a target already waiting replaces the waiting one, unless it returns the control to what it showed before the waiting one - a reversal, which
      // sends nothing and puts the control back to what it reads.
      case "queued": {

        const state = entry.state;

        if(sameValue(intent, state.unsent.shown)) {

          this.queued.delete(key);
          this.rest(key, entry.target, state.record);
          this.render(target);

          break;
        }

        entry.state = { ...state, unsent: { intent, shown: state.unsent.shown } };
        entry.target = target;
        this.toBack(key);

        break;
      }

      /* A request on a target with a command in flight waits behind it, and withdraws that command's attempt in case it is still waiting for admission. One that
       * returns the control to what the command in flight asks for is a reversal of whatever waits behind it. An attempt already admitted is on its way to the
       * wire and cannot be recalled, so the withdrawal reaches nothing there.
       */
      case "sending": {

        const state = entry.state;

        if(sameValue(intent, state.unsent.intent)) {

          entry.state = { ...state, waiting: undefined };

          break;
        }

        entry.state = { ...state, waiting: { intent, shown: state.unsent.intent } };
        entry.target = target;
        state.withdrawal.abort();

        break;
      }
    }

    this.settleIdle();
  }

  /**
   * The latest request a target holds that Hydrawise has not settled, whether it waits its turn or is in flight. A control reads this first, so it shows the user's
   * own choice for as long as it is pending.
   *
   * @param target - The control asked about.
   *
   * @returns The pending request, or undefined when nothing is pending.
   */
  public pending(target: HydrawiseCommandTarget): HydrawiseCommandValue | undefined {

    const state = this.entries.get(this.keyOf(target))?.state;

    switch(state?.status) {

      case "queued":

        return state.unsent.intent;

      case "sending":

        return state.waiting?.intent ?? state.unsent.intent;

      default:

        return undefined;
    }
  }

  /**
   * The suspension Hydrawise last confirmed for a target, which stands whatever the target now has pending.
   *
   * @param target - The control asked about.
   *
   * @returns The record, or undefined when the target holds none.
   */
  public record(target: HydrawiseCommandTarget): HydrawiseCommandRecord | undefined {

    return this.entries.get(this.keyOf(target))?.state.record;
  }

  /**
   * Every zone's confirmed suspension record, keyed by relay id.
   *
   * @returns The records the zone suspension targets hold.
   */
  public zoneRecords(): Map<number, HydrawiseCommandRecord> {

    const records = new Map<number, HydrawiseCommandRecord>();

    for(const { state, target } of this.entries.values()) {

      if((target.kind === "zone-suspend") && state.record) {

        records.set(target.zone.relay_id, state.record);
      }
    }

    return records;
  }

  /**
   * Record a confirmed suspension for a target, over whatever record it held, leaving anything it has pending in place.
   *
   * @param target - The control the suspension was confirmed for.
   * @param record - The confirmation.
   */
  public stamp(target: HydrawiseCommandTarget, record: HydrawiseCommandRecord): void {

    const key = this.keyOf(target);
    const entry = this.entries.get(key);

    if(!entry || (entry.state.status === "confirmed")) {

      this.entries.set(key, { state: { record, status: "confirmed" }, target });

      return;
    }

    entry.state = { ...entry.state, record };
  }

  /**
   * Drop what a pass of the projection supersedes. A zone the wire no longer reports takes its record and every request pending for it along, since nothing is left
   * for them to speak for, and a command still in flight for it settles with nothing to show for it. A zone's record that no longer stands retires. The account-wide
   * record is left to its readers, which weigh it on every read.
   *
   * @param options          - The pass.
   * @param options.reported - The relay id of every zone the wire reports.
   * @param options.stands   - Whether a record still speaks for its zone.
   */
  public sweep({ reported, stands }: { reported: ReadonlySet<number>; stands: (record: HydrawiseCommandRecord) => boolean }): void {

    for(const [ key, entry ] of this.entries) {

      if(entry.target.kind === "suspend-all") {

        continue;
      }

      if(!reported.has(entry.target.zone.relay_id)) {

        this.entries.delete(key);
        this.queued.delete(key);

        continue;
      }

      if(entry.state.record && !stands(entry.state.record)) {

        if(entry.state.status === "confirmed") {

          this.entries.delete(key);

          continue;
        }

        entry.state = { ...entry.state, record: undefined };
      }
    }

    this.settleIdle();
  }

  /**
   * Put back what a control reads, after the beat HAP needs to store the write it answers, so a write the control still owes is never overwritten by the very
   * value it was answering. Each target has its own timer, so the newest write for a control wins. A write that throws is said once and not written again, because
   * writing the control again would only meet the same fault.
   *
   * @param target - The control to write.
   */
  public render(target: HydrawiseCommandTarget): void {

    this.timers.setTimeout(this.timerPrefix + this.keyOf(target), (): void => {

      try {

        this.handlers.render(target);
      } catch(error) {

        this.report(error);
      }
    }, HYDRAWISE_REVERT_DELAY);
  }

  /**
   * A promise that resolves once nothing is queued or in flight. A confirmed record standing is not work, so it never holds the queue busy.
   *
   * @returns The promise.
   */
  public get idle(): Promise<void> {

    if(!this.busy) {

      return Promise.resolve();
    }

    this.idleWaiters ??= Promise.withResolvers();

    return this.idleWaiters.promise;
  }

  // Whether anything is queued or in flight.
  private get busy(): boolean {

    return this.inFlight || (this.queued.size > 0);
  }

  // The key a target is stored, and its control's timer armed, under.
  private keyOf(target: HydrawiseCommandTarget): string {

    return (target.kind === "suspend-all") ? target.kind : target.kind + "." + target.zone.relay_id.toString();
  }

  // Move a queued target to the back of the line, and make sure a pass over the line is coming.
  private toBack(key: string): void {

    this.queued.delete(key);
    this.queued.add(key);

    // The pass runs on a later turn rather than inside the request that scheduled it, so a write HomeKit is awaiting returns before anything reaches the wire.
    if(!this.pumpScheduled) {

      this.pumpScheduled = true;
      queueMicrotask(() => this.pump());
    }
  }

  // Leave a target resting on its record, the state it holds with nothing pending, or forget it when it holds none.
  private rest(key: string, target: HydrawiseCommandTarget, record: HydrawiseCommandRecord | undefined): void {

    if(record) {

      this.entries.set(key, { state: { record, status: "confirmed" }, target });

      return;
    }

    this.entries.delete(key);
  }

  // End a target's latest request without it taking: rest the target on its record, say why, and put back what its control reads.
  private unconfirm(key: string, entry: HydrawiseTargetEntry, record: HydrawiseCommandRecord | undefined, intent: HydrawiseCommandIntent,
    outcome: HydrawiseUnconfirmedCommand): void {

    this.rest(key, entry.target, record);
    this.handlers.unconfirmed(entry.target, intent, outcome);
    this.render(entry.target);
  }

  /* Send the next target in line, when nothing is in flight. Each target's control is judged again as its turn comes, because the request may have waited behind
   * others while the controller stopped responding or the control's accessory went away, and a request whose control cannot answer is dropped rather than sent.
   * Once the platform shuts down, every queued request is dropped without a word. A fault met while a target is judged or prepared drops that target as a fault
   * met in settling does, and the pass goes on to the next.
   */
  private pump(): void {

    this.pumpScheduled = false;

    if(this.inFlight) {

      return;
    }

    for(const key of this.queued) {

      this.queued.delete(key);

      const entry = this.entries.get(key);

      if(entry?.state.status !== "queued") {

        continue;
      }

      const state = entry.state;
      const { record, unsent } = state;

      if(this.signal.aborted) {

        this.rest(key, entry.target, record);

        continue;
      }

      try {

        if(!this.handlers.available(entry.target, unsent.intent)) {

          this.unconfirm(key, entry, record, unsent.intent, { status: "unavailable" });

          continue;
        }

        this.send(key, entry, { attempt: 1, prepared: this.handlers.prepare(entry.target, unsent.intent), record, status: "sending", unsent,
          withdrawal: new AbortController() });

        return;
      } catch(error) {

        this.contain({ error, holds: (current): boolean => current === state, key, target: entry.target });
      }
    }

    this.settleIdle();
  }

  // Put one attempt of a target's command in flight. The attempt holds the one slot in flight until its send answers.
  private send(key: string, entry: HydrawiseTargetEntry, state: HydrawiseSendingState): void {

    entry.state = state;
    this.inFlight = true;

    void this.attempt(key, entry, state);
  }

  /* Carry one attempt to its settlement, then send the next target in line. The send is awaited inside the try, so a send that rejects, or throws as it is made,
   * meets the containment a fault in settling meets, and no error leaves the queue. A fault rests the target only while it still holds this attempt, the guard
   * settling applies to an answer.
   */
  private async attempt(key: string, entry: HydrawiseTargetEntry, state: HydrawiseSendingState): Promise<void> {

    try {

      let outcome: HydrawiseCommandOutcome;

      try {

        outcome = await this.answer(state);
      } finally {

        // The slot in flight is given up the moment the send answers or fails, and before anything is settled, because settling a timeout sends again and takes the
        // slot back. Releasing and settling share this one turn, so a pass queued in the turn of the answer finds the slot taken and sends nothing beside the resend.
        this.inFlight = false;
      }

      this.settle(key, state.withdrawal, outcome);
    } catch(error) {

      this.contain({ error, holds: (current): boolean => holdsAttempt(current, state.withdrawal), key, target: entry.target });
    }

    this.pump();
  }

  // What one attempt's send answers, always as a promise. A send that throws as it is made becomes a rejection here, so its containment runs on a later turn rather
  // than inside the pass that made the send.
  private async answer(state: HydrawiseSendingState): Promise<HydrawiseCommandOutcome> {

    return state.prepared.send(state.withdrawal.signal);
  }

  /* Settle one attempt by what Hydrawise answered. The attempt speaks only for the target it was sent for and only while it is still that target's attempt: a
   * target the wire dropped while it was in flight takes nothing from it, and nothing at all is taken once the platform has shut down.
   *
   * A request waiting behind a command that did not take - refused, failed, unreadable or unanswered - was made while that command was on the wire, so it is no
   * reversal before sending and always takes its turn at the back of the line. From then on it is weighed against what the control showed before that command, so a
   * later tap back to the command's own value is a request of its own rather than a reversal, and after an unanswered command it is weighed against nothing at all,
   * since that command may have taken and what the control showed is unknown. Nothing is said for the command it superseded.
   */
  private settle(key: string, withdrawal: AbortController, outcome: HydrawiseCommandOutcome): void {

    const entry = this.entries.get(key);

    if(this.signal.aborted || !entry || !holdsAttempt(entry.state, withdrawal)) {

      return;
    }

    const state = entry.state;

    switch(outcome.status) {

      case "confirmed":

        this.advance(key, entry, state);
        state.prepared.confirmed();

        return;

      /* Only a withdrawal answers aborted while the platform runs, and a withdrawn attempt never reached the wire, so the target's latest request is weighed as if
       * that attempt had never been made: against what the control showed before it. A request that returns there is a reversal, and anything else takes its
       * turn at the back of the line. A withdrawn resend follows an attempt that went unanswered and may have taken, so what the control showed is unknown there, and
       * the latest request always takes its turn.
       */
      case "aborted": {

        const latest = state.waiting?.intent ?? state.unsent.intent;

        if(sameValue(latest, state.unsent.shown)) {

          this.rest(key, entry.target, state.record);
          this.render(entry.target);

          return;
        }

        this.requeue(key, entry, state, latest);

        return;
      }

      // An unanswered command may have taken, so what its control showed is unknown from here on. It is sent again while it is still the latest request and its
      // control can still answer, and given up on once no attempt has been answered.
      case "timeout":

        if(state.waiting) {

          this.requeue(key, entry, state, state.waiting.intent, null);

          return;
        }

        if(state.attempt >= HYDRAWISE_COMMAND_ATTEMPTS) {

          this.unconfirm(key, entry, state.record, state.unsent.intent, { status: "exhausted" });

          return;
        }

        if(!this.handlers.available(entry.target, state.unsent.intent)) {

          this.unconfirm(key, entry, state.record, state.unsent.intent, { status: "unavailable" });

          return;
        }

        this.send(key, entry, { ...state, attempt: state.attempt + 1, unsent: { intent: state.unsent.intent, shown: null }, withdrawal: new AbortController() });

        return;

      case "failed":
      case "refused":
      case "unreadable":

        if(state.waiting) {

          this.requeue(key, entry, state, state.waiting.intent);

          return;
        }

        this.unconfirm(key, entry, state.record, state.unsent.intent, outcome);

        return;
    }
  }

  // Move past a confirmed command: the request waiting behind it takes its turn at the back of the line, and with none waiting the target rests on its record.
  private advance(key: string, entry: HydrawiseTargetEntry, state: HydrawiseSendingState): void {

    if(state.waiting) {

      entry.state = { record: state.record, status: "queued", unsent: state.waiting };
      this.toBack(key);

      return;
    }

    this.rest(key, entry.target, state.record);
  }

  /* Put a target's latest request back in line after an attempt that did not take, weighed against what its control showed before that attempt's command, or against
   * nothing when an unanswered command left that unknown. One limit remains: an unreadable reply or a reset may have taken too, and those arms keep what the control
   * showed, so a tap back while the requeued request still waits can read as a reversal of a command that took.
   */
  private requeue(key: string, entry: HydrawiseTargetEntry, state: HydrawiseSendingState, intent: HydrawiseCommandIntent,
    shown: Nullable<HydrawiseCommandValue> = state.unsent.shown): void {

    entry.state = { record: state.record, status: "queued", unsent: { intent, shown } };
    this.toBack(key);
  }

  /* Contain a fault met while the queue worked a target, so no error leaves the queue. The target rests on its record only while it still holds the work that
   * faulted. A target the queue had already moved on keeps where it stands - already resting, holding a newer request of the user's, or gone with its zone in the
   * sweep - because resting it again could drop that request or bring the zone back. Its control is written again in every case, so it shows what it reads.
   * After the lifetime signal aborts, a fault is silent, like everything else the queue does.
   */
  private contain({ error, holds, key, target }: { error: unknown; holds: (state: HydrawiseTargetState) => boolean; key: string;
    target: HydrawiseCommandTarget; }): void {

    if(this.signal.aborted) {

      return;
    }

    const entry = this.entries.get(key);

    if(entry && holds(entry.state)) {

      this.rest(key, entry.target, entry.state.record);
    }

    this.report(error);
    this.render(target);
  }

  // Say a contained fault once, through the controller's logger. No fault reaches here after shutdown: containment says nothing once the lifetime signal aborts,
  // and the timer registry a control's write is armed on drains with that same signal.
  private report(error: unknown): void {

    this.log.error("Unable to finish a command to Hydrawise: %s.", formatErrorMessage(error));
  }

  // Resolve everyone waiting for the queue to fall idle, once it has.
  private settleIdle(): void {

    if(this.busy || !this.idleWaiters) {

      return;
    }

    this.idleWaiters.resolve();
    this.idleWaiters = null;
  }
}
