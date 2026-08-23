/* Copyright(C) 2017-2026, HJD (https://github.com/hjdhjd). All rights reserved.
 *
 * runtime-floor.test.ts: The engines-keyed conformance guard for this plugin's explicit-resource-management gesture. While the package's `engines.node` floor sits
 * below the Node release that ships DisposableStack, AsyncDisposableStack, and SuppressedError as platform globals, this suite asserts that the entry point
 * installs them as its FIRST import, ahead of anything that could construct a stack, and that the test harness mirrors the same install for the suites that
 * construct the platform without ever loading the entry point. The moment the floor is bumped to that release, the live assertion fails with an enumerated cleanup
 * list - the anti-forget mechanism that turns "delete the polyfill gesture" from a thing to remember into a thing the suite demands.
 *
 * What sits here is this plugin's policy alone: which major closes the gap, which specifier makes the gesture, which modules must make it, what the checklist
 * enumerates, and what the detectors look for. The mechanism those feed - reading the engines floor, deciding the regime, walking the shipped source, firing the
 * sunset - is the shared machinery on homebridge-plugin-utils's testing surface, which every plugin in the family drives with its own policy.
 *
 * One residual is accepted and stated rather than papered over. Node runs each test file in its own process, so a suite that constructed the platform without
 * transiting the harness module would run unpolyfilled on a sub-floor runtime. Every construction workhorse does transit it, and the presence and position pins
 * below are the mechanical guards that keep it that way; what no test here can do is exercise the sub-floor path itself, because the runtime running this suite is
 * above the floor and already supplies the globals.
 */
import { assertRuntimeFloorCompat, composeSunsetCleanup, parseRuntimeFloor, planRuntimeFloorCheck, readEnginesNode,
  sweepSourceFiles } from "homebridge-plugin-utils/testing";
import { describe, test } from "node:test";
import type { SweptFile } from "homebridge-plugin-utils/testing";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

// The major version of the Node release that first ships DisposableStack (and the rest of the explicit-resource-management globals) as a platform global. At or
// above this floor the polyfill is redundant and the sunset runs; below it the gesture is required.
const NODE_ERM_GLOBAL_MAJOR = 24;

// The subpath the polyfill is reached by. The entry point imports it for the shipped process; the harness mirrors it for the suites that construct production
// objects directly.
const POLYFILL_SPECIFIER = "homebridge-plugin-utils/polyfills";

// The harness module every platform and controller test loads before it constructs anything, as a URL-relative path from the directory this file sits in.
const HARNESS_MODULE = "testing/platform.helpers.ts";

// The number of shipped source files the sweep must find before its verdict means anything. This is a floor guarding against a mis-scoped walk that enumerates
// almost nothing and then passes vacuously, not a census of the tree - it sits comfortably below the real count so adding or removing a module never touches it.
const MINIMUM_SWEPT_FILES = 6;

// Every step the sunset takes. Each names a distinct path, so no entry is a substring of another and the enumeration check below cannot be satisfied by a message
// that named only one of them.
const SUNSET_ARTIFACTS = [

  "the \"" + POLYFILL_SPECIFIER + "\" import at the top of src/index.ts",
  "the mirrored polyfill import in src/testing/platform.helpers.ts",
  "this file, src/runtime-floor.test.ts"
];

// The enumerated cleanup the live assertion emits once the engines floor reaches the platform-global release. It names every step so the sunset is a mechanical
// checklist rather than an archaeology exercise, and it is composed from SUNSET_ARTIFACTS so the checklist and the fragments the synthetic sunset test looks for
// cannot drift apart. That synthetic test asserts these fragments are present, so this path runs green today.
const SUNSET_CLEANUP = composeSunsetCleanup({

  artifacts: SUNSET_ARTIFACTS,
  epilogue: ".",
  prologue: "The Node runtime floor has reached the release that ships the explicit-resource-management globals, so the platform supplies what the polyfill " +
    "installs and the gesture is redundant. Complete the sunset: delete ",
  separator: "; "
});

// Detect a bare `new DisposableStack()` construction. The polyfill gesture exists precisely so this reads against the platform global rather than an imported
// class, which is why the rule the sweep enforces is about the gesture rather than about an import in the constructing file. `using` / `await using` declarations
// are intentionally not swept: the ES2024 compile target downlevels that syntax, so only bare global references survive to the runtime and could break below the
// floor.
const NEW_DISPOSABLE_STACK = /new\s+DisposableStack\s*\(/;

// Detect a bare `new AsyncDisposableStack()` construction, held to the same gesture rule as its synchronous sibling.
const NEW_ASYNC_DISPOSABLE_STACK = /new\s+AsyncDisposableStack\s*\(/;

// The specifiers a module imports, in source order. We read the specifier out of each import STATEMENT rather than searching the file text, so "the first import"
// means the first import statement and a mention of the same specifier in a comment, a string, or a later line cannot stand in for it. The specifier character
// class excludes quotes and semicolons but admits newlines, which is what keeps a multi-line import - the house style wraps them - matched as the one statement it
// is.
function importSpecifiers(source: string): string[] {

  return [...source.matchAll(/^import\s+(?:[^"';]*?\s+from\s+)?["']([^"']+)["']\s*;/gm)].map(match => match[1] ?? "");
}

// Whether a module makes the polyfill gesture as its very first import statement. Position is the guarantee at the entry point: the install has to run before any
// module that could construct a stack while it is being evaluated, and an import placed second could already be too late.
function gestureIsFirstImport(source: string): boolean {

  return importSpecifiers(source)[0] === POLYFILL_SPECIFIER;
}

// Whether a module makes the polyfill gesture anywhere in its import block. The harness mirror is held to presence rather than position: it is loaded by test
// modules whose own import order it does not control, and nothing it imports constructs a stack during module evaluation.
function gestureIsPresent(source: string): boolean {

  return importSpecifiers(source).includes(POLYFILL_SPECIFIER);
}

// Decide whether the shipped source is covered for one construction pattern: a tree that constructs the class anywhere needs the entry gesture, and a tree that
// constructs it nowhere satisfies the rule trivially. This decision is a helper rather than an inline sweep body so the tests can drive it BOTH ways - across the
// real shipped source, and against fabricated inputs whose verdicts are known - which matters most for the async arm, where no real construction site exists today
// and an inline sweep body would therefore never run its rejecting branch. It stays here rather than in the shared machinery because pairing a construction with an
// entry-point gesture is this plugin's own remedy; a sibling in the family guards the same gap with an entirely different rule.
function gestureCovers(files: SweptFile[], construction: RegExp, entryHasGesture: boolean): boolean {

  if(!files.some(file => construction.test(file.text))) {

    return true;
  }

  return entryHasGesture;
}

// Read one module's text by its URL-relative path from this file's own directory.
async function readSourceModule(relativePath: string): Promise<string> {

  return readFile(new URL(relativePath, import.meta.url), "utf8");
}

describe("HBHH runtime floor - regime helper", () => {

  test("parses the compat floor and selects the compat regime", () => {

    const result = parseRuntimeFloor({ enginesNode: ">=22.20", sunsetMajor: NODE_ERM_GLOBAL_MAJOR });

    assert.equal(result.major, 22, "the first integer run is the major version");
    assert.equal(result.regime, "compat", "a floor below the platform-global release keeps the gesture");
  });

  test("parses a >=24 floor and selects the sunset regime", () => {

    const result = parseRuntimeFloor({ enginesNode: ">=24", sunsetMajor: NODE_ERM_GLOBAL_MAJOR });

    assert.equal(result.major, 24, "the first integer run is the major version");
    assert.equal(result.regime, "sunset", "a floor at the platform-global release retires the gesture");
  });

  test("parses a caret range and selects the sunset regime", () => {

    assert.equal(parseRuntimeFloor({ enginesNode: "^24", sunsetMajor: NODE_ERM_GLOBAL_MAJOR }).regime, "sunset", "a caret range parses to the same major");
  });

  test("the sunset regime produces the enumerated cleanup plan", () => {

    const plan = planRuntimeFloorCheck({ enginesNode: ">=24", sunsetMajor: NODE_ERM_GLOBAL_MAJOR, sunsetMessage: SUNSET_CLEANUP });

    assert.equal(plan.kind, "sunset", "a sunset floor selects the failing plan");

    // The assert.equal above narrows plan to the sunset variant, so plan.message is in scope here.
    for(const artifact of SUNSET_ARTIFACTS) {

      assert.ok(plan.message.includes(artifact), "the sunset cleanup enumerates " + artifact);
    }

    /* Membership alone reads each artifact on its own, which a message that joined them with the wrong separator or lost its closing punctuation would still
     * satisfy. Pinning the composed joins - the separator between two real artifacts, and the epilogue after the last one - is what covers the assembly itself,
     * while an equality against SUNSET_CLEANUP would only compare the composition to itself.
     */
    assert.ok(plan.message.includes("; the mirrored"), "the artifacts are joined by the separator this checklist composes with");
    assert.ok(plan.message.endsWith("src/runtime-floor.test.ts."), "and the epilogue closes the message after the last artifact");
  });

  test("no sunset artifact is a substring of another", () => {

    // The enumeration check above is only as strong as its fragments are distinct: a fragment contained inside another would be satisfied by a message that named
    // the longer artifact alone. Naming a distinct path in every entry is what prevents that, and this is where it is enforced rather than assumed.
    for(const artifact of SUNSET_ARTIFACTS) {

      const others = SUNSET_ARTIFACTS.filter(candidate => candidate !== artifact);

      assert.ok(!others.some(candidate => candidate.includes(artifact)), artifact + " must not be a substring of another sunset artifact");
    }
  });

  test("the compat regime selects the source sweep plan", () => {

    assert.equal(planRuntimeFloorCheck({ enginesNode: ">=22.20", sunsetMajor: NODE_ERM_GLOBAL_MAJOR, sunsetMessage: SUNSET_CLEANUP }).kind, "sweep",
      "a compat floor selects the sweep");
  });
});

describe("HBHH runtime floor - gesture detectors", () => {

  test("the construction detectors match what they are meant to match, and nothing else", () => {

    assert.match("const stack = new DisposableStack();", NEW_DISPOSABLE_STACK, "the synchronous detector must match a synthetic positive");
    assert.doesNotMatch("const stack = new Stack();", NEW_DISPOSABLE_STACK, "the synchronous detector must not match an unrelated construction");
    assert.doesNotMatch("const stack = new AsyncDisposableStack();", NEW_DISPOSABLE_STACK, "the synchronous detector must not match the asynchronous construction");
    assert.match("await using stack = new AsyncDisposableStack();", NEW_ASYNC_DISPOSABLE_STACK, "the asynchronous detector must match a synthetic positive");
    assert.doesNotMatch("const stack = new DisposableStack();", NEW_ASYNC_DISPOSABLE_STACK, "the asynchronous detector must not match the synchronous construction");
  });

  test("the position check accepts a first-position gesture and rejects every other placement", () => {

    // Driving the detector against fabricated entry modules is what keeps its rejecting branch out of vacuity: the live entry point is expected to pass, so only
    // synthetic negatives can prove the check would notice if it stopped passing.
    const first = "import \"" + POLYFILL_SPECIFIER + "\";\nimport { HydrawisePlatform } from \"./platform.ts\";\n";
    const second = "import { HydrawisePlatform } from \"./platform.ts\";\nimport \"" + POLYFILL_SPECIFIER + "\";\n";
    const absent = "import { HydrawisePlatform } from \"./platform.ts\";\n";
    const mentionedOnly = "// We import \"" + POLYFILL_SPECIFIER + "\" somewhere else.\nimport { HydrawisePlatform } from \"./platform.ts\";\n";

    assert.equal(gestureIsFirstImport(first), true, "the gesture in first position is accepted");
    assert.equal(gestureIsFirstImport(second), false, "the gesture in second position is rejected");
    assert.equal(gestureIsFirstImport(absent), false, "an entry with no gesture at all is rejected");
    assert.equal(gestureIsFirstImport(mentionedOnly), false, "naming the specifier in a comment does not make the gesture");
    assert.equal(gestureIsPresent(second), true, "the presence check accepts a gesture in any position");
    assert.equal(gestureIsPresent(mentionedOnly), false, "the presence check reads import statements, not text mentions");
  });

  test("the specifier parser reads multi-line import statements as one statement", () => {

    // The house style wraps long import lists across lines, so a parser that stopped at the newline would read a wrapped statement's specifier as missing and mis-
    // order everything after it.
    const wrapped = "import \"" + POLYFILL_SPECIFIER + "\";\nimport type { Alpha, Bravo, Charlie,\n  Delta } from \"./wide.ts\";\nimport util from \"node:util\";\n";

    assert.deepEqual(importSpecifiers(wrapped), [ POLYFILL_SPECIFIER, "./wide.ts", "node:util" ], "each statement contributes exactly one specifier, in source order");
  });

  test("the coverage rule rejects a construction without the gesture and accepts one with it", () => {

    // No shipped file constructs an AsyncDisposableStack today, so the live sweep never exercises the asynchronous arm's rejecting branch. Feeding the helper
    // fabricated files with known verdicts is what keeps that branch from shipping as a vacuous all-clear.
    const constructing = [{ path: "synthetic-construction.ts", text: "const stack = new AsyncDisposableStack();" }];
    const inert = [{ path: "synthetic-inert.ts", text: "const registry = new Map();" }];

    assert.equal(gestureCovers(constructing, NEW_ASYNC_DISPOSABLE_STACK, false), false, "constructing a stack with no entry gesture must be rejected");
    assert.equal(gestureCovers(constructing, NEW_ASYNC_DISPOSABLE_STACK, true), true, "constructing a stack behind the entry gesture must be accepted");
    assert.equal(gestureCovers(inert, NEW_ASYNC_DISPOSABLE_STACK, false), true, "a tree that constructs no stack satisfies the rule trivially");
  });
});

describe("HBHH runtime floor - live conformance", () => {

  test("the engines floor keeps the polyfill regime, and the gesture covers every construction site", async () => {

    const plan = planRuntimeFloorCheck({ enginesNode: await readEnginesNode(new URL("../", import.meta.url)), sunsetMajor: NODE_ERM_GLOBAL_MAJOR,
      sunsetMessage: SUNSET_CLEANUP });

    // The floor reached the platform-global release: fail with the enumerated cleanup so the gesture cannot silently outlive the runtime it works around.
    assertRuntimeFloorCompat(plan);

    const files = await sweepSourceFiles({ roots: [new URL(".", import.meta.url)] });

    assert.ok(files.length >= MINIMUM_SWEPT_FILES, "the source walk enumerated " + files.length.toString() + " files, expected at least " +
      MINIMUM_SWEPT_FILES.toString());

    const entrySource = await readSourceModule("index.ts");
    const harnessSource = await readSourceModule(HARNESS_MODULE);
    const constructionSites = files.filter(file => NEW_DISPOSABLE_STACK.test(file.text));

    // The known occurrence in the platform proves the synchronous detector detects. There is deliberately no matching minimum for the asynchronous arm: zero
    // construction sites is the correct state today, and the synthetic drive above covers that branch instead.
    assert.ok(constructionSites.length >= 1, "at least one shipped file constructs a DisposableStack");
    assert.ok(constructionSites.some(file => file.path.endsWith("platform.ts")), "src/platform.ts is among the DisposableStack construction " +
      "sites");

    assert.ok(gestureIsFirstImport(entrySource), "src/index.ts must make the polyfill gesture as its first import statement");
    assert.ok(gestureIsPresent(harnessSource), "src/" + HARNESS_MODULE + " must mirror the polyfill gesture for the suites that skip the entry point");
    assert.ok(gestureCovers(files, NEW_DISPOSABLE_STACK, gestureIsFirstImport(entrySource)), "a shipped file constructs a DisposableStack without the entry gesture");
    assert.ok(gestureCovers(files, NEW_ASYNC_DISPOSABLE_STACK, gestureIsFirstImport(entrySource)), "a shipped file constructs an AsyncDisposableStack without the " +
      "entry gesture");
  });
});
