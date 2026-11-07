/* Copyright(C) 2026, HJD (https://github.com/hjdhjd). All rights reserved.
 *
 * network.helpers.ts: The HTTP-fake interceptors a suite composes onto an undici MockAgent: a reply end held back until the row releases it, and a reply body that
 * fails partway through its read. The MockAgent writes a reply's start, data and end in one pass, so these are how a row puts a deadline, a shutdown or a body
 * failure inside a body's read. The module imports no Homebridge, so a suite that builds its client directly takes them without loading the runtime.
 */
import type { Dispatcher } from "undici";

/* A handler that passes the request start, the response start, the data and the error straight through to the handler it wraps, and ends the reply through the
 * end handed in. Each interceptor below changes how a reply ends and nothing else, so the callbacks a reply passes through untouched are stated once, here.
 */
function replacingEnd(handler: Dispatcher.DispatchHandler, onResponseEnd: NonNullable<Dispatcher.DispatchHandler["onResponseEnd"]>): Dispatcher.DispatchHandler {

  return {

    onRequestStart: (controller, context: unknown): void => handler.onRequestStart?.(controller, context),
    onResponseData: (controller, chunk): void => handler.onResponseData?.(controller, chunk),
    onResponseEnd,
    onResponseError: (controller, cause): void => handler.onResponseError?.(controller, cause),
    onResponseStart: (controller, statusCode, headers, statusMessage): void => handler.onResponseStart?.(controller, statusCode, headers, statusMessage)
  };
}

/**
 * Build an interceptor that ends every reply the MockAgent serves with an error in place of its end, once the reply's start and its bytes have arrived, so the
 * reply's body fails partway through its read.
 *
 * @param error - The error each reply's body fails with.
 *
 * @returns The interceptor to compose onto the MockAgent.
 */
export function failingBodies(error: Error): Dispatcher.DispatcherComposeInterceptor {

  return (dispatch) => (options, handler): boolean => dispatch(options, replacingEnd(handler, (controller): void => handler.onResponseError?.(controller, error)));
}

/* One reply end held back until a row releases it, for the requests its match names. A reply on a matched path delivers its start and its bytes at once and its
 * end waits on the hold, so its body stays mid-read for as long as the hold stands. A reply on any other path answers whole, so a row holds one answer while the
 * requests ahead of it land. Each caller states its own match, so the hold matches a path exactly as the replies it stands beside are matched.
 */
export class HeldEnd {

  // Resolves once a reply on a matched path has delivered its start and its bytes and reached the end the hold keeps back, so a row acts while the read is pending.
  public readonly reached: Promise<void>;
  private readonly arrival: PromiseWithResolvers<void> = Promise.withResolvers();
  private readonly gate: PromiseWithResolvers<void> = Promise.withResolvers();
  private readonly matches: (path: string) => boolean;

  constructor(matches: (path: string) => boolean) {

    this.matches = matches;
    this.reached = this.arrival.promise;
  }

  // Let every held end through, so each reply on a matched path finishes. A release before any reply arrives lets that reply end at once.
  public release(): void {

    this.gate.resolve();
  }

  // The interceptor to compose onto the MockAgent: a request on an unmatched path passes through untouched, and a reply on a matched one has its end kept back
  // until the release.
  public interceptor(): Dispatcher.DispatcherComposeInterceptor {

    return (dispatch) => (options, handler): boolean => {

      if(!this.matches(options.path)) {

        return dispatch(options, handler);
      }

      return dispatch(options, replacingEnd(handler, (controller, trailers): void => {

        this.arrival.resolve();
        void this.gate.promise.then(() => handler.onResponseEnd?.(controller, trailers));
      }));
    };
  }
}
