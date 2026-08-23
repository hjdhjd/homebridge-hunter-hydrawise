/* Copyright(C) 2026, HJD (https://github.com/hjdhjd). All rights reserved.
 *
 * loggers.helpers.ts: Logger doubles handed to code under test in place of the production logger. silentLog drops every call (used when production code logs
 * but the test isn't asserting on output); capturingLog records every call (used when the test does want to assert on log output). Both satisfy the TestLogger
 * interface, which mirrors the public surface of the project's production logger.
 *
 * Two project adaptations from the canonical copy are applied here. First, the debug channel is message-first (`debug(message, ...args)`) to match Homebridge's
 * Logging and homebridge-plugin-utils' HomebridgePluginLogging, whose debug signatures carry no leading category; the captured shape must mirror production's
 * calls or every captured debug line is corrupt. Second, the bound-logger method is dropped entirely, because this plugin prefixes through the prefixedLog
 * wrapper rather than a logger method, so TestLogger has no bound-logger surface to model.
 */

/**
 * The minimal logger surface that every test consumer needs. Mirrors the public methods on the project's production logger (debug/error/info/warn). The debug
 * channel is message-first to match Homebridge's Logging and homebridge-plugin-utils' HomebridgePluginLogging. Helpers in this file return an object that
 * satisfies this shape so it can stand in for the production logger.
 */
export interface TestLogger {

  debug: (message: string, ...args: unknown[]) => void;
  error: (message: string, ...args: unknown[]) => void;
  info: (message: string, ...args: unknown[]) => void;
  warn: (message: string, ...args: unknown[]) => void;
}

/**
 * A captured log line. Intentionally decoupled from the production log entry's evolution - tests match against any subset of fields without having to track
 * upstream type changes.
 */
export interface CapturedLogLine {

  args: unknown[];
  level: "debug" | "error" | "info" | "warn";
  message: string;
}

/**
 * No-op used as the implementation behind every silentLog method. The comment inside its body documents intent for readers, not to satisfy a lint rule - the
 * project's no-empty rule already permits an empty function body unconditionally, regardless of comments. The same reference is shared by every method - a
 * micro-optimization, but it also makes silentLog cheap to instantiate per test.
 */
function noop(): void {

  // Intentional no-op: silentLog drops every call.
}

/**
 * Returns a logger that drops every call. Use this when a test exercises code that logs but the test isn't asserting on log output - the production code wants
 * to call LOG.info(...) and the test just needs the call to be a no-op so it doesn't pollute test runner stdout. Returned object satisfies TestLogger so it
 * can be substituted for the production logger.
 * @returns A logger whose methods all return undefined and record nothing.
 */
export function silentLog(): TestLogger {

  return {

    debug: noop,
    error: noop,
    info: noop,
    warn: noop
  };
}

/**
 * Returns a logger that records every call into an array, plus a snapshot accessor. Use this when a test does want to assert on log output - either to verify
 * that a particular warning fired, or to verify that nothing leaked at error level. The returned object also exposes a clear() so tests can reset between
 * phases without re-instantiating.
 * @returns An object with a logger surface and lines/clear accessors.
 */
export function capturingLog(): { clear: () => void; lines: () => CapturedLogLine[]; logger: TestLogger } {

  const captured: CapturedLogLine[] = [];

  function recordTopLevel(level: CapturedLogLine["level"]): (message: string, ...args: unknown[]) => void {

    return function(message: string, ...args: unknown[]): void {

      captured.push({ args, level, message });
    };
  }

  const logger: TestLogger = {

    // Homebridge's debug channel is message-first, so debug records under the same top-level shape as the other levels.
    debug: recordTopLevel("debug"),
    error: recordTopLevel("error"),
    info: recordTopLevel("info"),
    warn: recordTopLevel("warn")
  };

  return {

    clear: (): void => {

      captured.length = 0;
    },
    lines: (): CapturedLogLine[] => captured.slice(),
    logger
  };
}
