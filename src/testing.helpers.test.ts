/* Copyright(C) 2026, HJD (https://github.com/hjdhjd). All rights reserved.
 *
 * testing.helpers.test.ts: Tests for the cross-cutting testing-helpers barrel. The barrel is the canonical import path for tests outside `src/testing/`,
 * and this test file is the sole mechanism that enforces that convention, since no linter rule backs it. These tests lock in the barrel's runtime export
 * surface so a forgotten re-export, a renamed submodule symbol, or an unintended addition surfaces
 * immediately at unit-tier rather than as a confusing import error in some downstream test file.
 *
 * A symmetric drift catch:
 *
 *   1. Every documented symbol IS re-exported (catches missing re-exports - a submodule export the barrel forgot to forward).
 *   2. No undocumented runtime exports exist (catches accidental additions - a submodule export that flowed through without being documented).
 *   3. Cardinality matches (catches same-size swap - one removed, one added would pass the first and second checks by accident).
 *
 * When the barrel grows or shrinks, update EXPECTED_FUNCTION_EXPORTS below to match.
 */
import * as barrel from "./testing.helpers.ts";
import { describe, test } from "node:test";
import assert from "node:assert/strict";

/* The complete list of function runtime symbols the barrel is documented to re-export. A type-only re-export is erased at runtime and therefore not part of this
 * surface.
 */
const EXPECTED_FUNCTION_EXPORTS = [

  "assertSameShape",
  "declareKeysOf"
] as const;

describe("testing.helpers barrel", () => {

  test("re-exports every documented function symbol as a function", () => {

    // Narrowing the namespace import to a record so we can index by string. Each entry's contract is "typeof === 'function'."
    const exports = barrel as unknown as Record<string, unknown>;

    for(const name of EXPECTED_FUNCTION_EXPORTS) {

      assert.equal(typeof exports[name], "function", "Expected " + name + " to be re-exported as a function from the testing.helpers barrel.");
    }
  });

  test("does not leak unexpected runtime exports beyond the documented list", () => {

    /* Drift catch in the other direction: an addition to a submodule that propagates to the barrel without being added to EXPECTED_FUNCTION_EXPORTS would survive
     * the previous test silently. Walking the actual runtime keys and asserting each one is documented closes that gap. The barrel has no `default` export, so no
     * filtering is needed.
     */
    const allowed = new Set<string>(EXPECTED_FUNCTION_EXPORTS);
    const actual = Object.keys(barrel);

    for(const name of actual) {

      assert.ok(allowed.has(name),
        "Unexpected runtime export from the testing.helpers barrel: " + name + ". Add it to EXPECTED_FUNCTION_EXPORTS, or remove it from the barrel.");
    }
  });

  test("documented and actual runtime export sets match exactly in cardinality", () => {

    // Symmetric assertion: the previous tests catch missing or extra exports individually; this one asserts the cardinality matches so a same-size swap (one
    // removed, one added) cannot pass the missing-export and extra-export tests by accident.
    const actual = new Set(Object.keys(barrel));

    assert.equal(actual.size, EXPECTED_FUNCTION_EXPORTS.length, "Runtime export count mismatch: barrel has " + String(actual.size) + " keys, " +
      "EXPECTED_FUNCTION_EXPORTS lists " + String(EXPECTED_FUNCTION_EXPORTS.length) + ".");
  });
});
