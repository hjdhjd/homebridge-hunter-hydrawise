/* Copyright(C) 2026, HJD (https://github.com/hjdhjd). All rights reserved.
 *
 * testing.helpers.ts: Barrel re-export for the cross-cutting testing helper modules under src/testing/. Test files import from this single entry to keep
 * import paths stable as the implementation modules evolve. The thematic submodules under src/testing/ each own one concern:
 *
 *   - fs.helpers.ts           TMPDIR_PREFIX, withTempDir
 *   - parity.helpers.ts       assertSameShape, declareKeysOf
 *
 * The testing surface the plugin family shares - the logger doubles and the finders that read them, indexed access with a named failure, the
 * unhandled-rejection guard, the polling wait, and the errno-shaped error - comes from homebridge-plugin-utils/testing, which the suites import directly, so
 * this barrel carries only what is particular to this plugin.
 *
 * Tests can import from this barrel for the common case, or from a specific submodule when they want to advertise the narrower dependency, and the barrel
 * re-exports verbatim, so the import paths are interchangeable. The optional exec.helpers.ts submodule is omitted here: this plugin has no execFile-shaped
 * adapter port.
 *
 * Add additional thematic submodules as the project grows (e.g., a `network.helpers.ts` for HTTP-fake utilities), keeping the one-concern-per-file discipline.
 * The Homebridge runtime the suites run on, the platform double, the recording MQTT client, and the retrieve recorder live together in
 * src/testing/platform.helpers.ts, which is imported directly rather than through this canonical barrel.
 */
export { assertSameShape, declareKeysOf } from "./testing/parity.helpers.ts";
export { TMPDIR_PREFIX, withTempDir } from "./testing/fs.helpers.ts";
