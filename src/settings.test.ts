/* Copyright(C) 2017-2026, HJD (https://github.com/hjdhjd). All rights reserved.
 *
 * settings.test.ts: The plugin constants. Small honest assertions so a change to a rate-limit-sensitive timing value or a platform identity is a deliberate,
 * visible edit.
 */
import { HYDRAWISE_ACTIVE_ZONE_INDICATOR, HYDRAWISE_API_BUDGET_CALLS, HYDRAWISE_API_BUDGET_WINDOW, HYDRAWISE_API_JITTER, HYDRAWISE_API_NEXTPOLL_MAX,
  HYDRAWISE_API_RETRY_ATTEMPTS, HYDRAWISE_API_RETRY_INTERVAL, HYDRAWISE_API_RETRY_STATUS_CODES, HYDRAWISE_API_TIMEOUT, HYDRAWISE_COMMAND_BUDGET_CALLS,
  HYDRAWISE_COMMAND_BUDGET_WINDOW, HYDRAWISE_COMMAND_ENDPOINT, HYDRAWISE_MQTT_TOPIC, HYDRAWISE_SUSPEND_DURATION,
  HYDRAWISE_V2_BUDGET_CALLS, HYDRAWISE_V2_BUDGET_WINDOW, HYDRAWISE_V2_FACTS_TTL, HYDRAWISE_V2_MUTATION_BUDGET_CALLS, HYDRAWISE_V2_MUTATION_BUDGET_WINDOW,
  HYDRAWISE_V2_REFRESH_INTERVAL, PLATFORM_NAME, PLUGIN_NAME } from "./settings.ts";
import { describe, test } from "node:test";
import { apiRetryOptions } from "homebridge-plugin-utils";
import assert from "node:assert/strict";
import { present } from "homebridge-plugin-utils/testing";

describe("settings", () => {

  test("locks in the API timing constants", () => {

    assert.equal(HYDRAWISE_API_TIMEOUT, 7, "the per-request timeout is 7 seconds");
    assert.equal(HYDRAWISE_API_RETRY_INTERVAL, 60, "the retry interval is 60 seconds");
    assert.equal(HYDRAWISE_API_JITTER, 0.2, "the poll jitter is 0.2 seconds");
    assert.equal(HYDRAWISE_API_NEXTPOLL_MAX, 86400, "the longest nextpoll hint honored is one day in seconds");
    assert.equal(HYDRAWISE_ACTIVE_ZONE_INDICATOR, 3600, "a zone within 3600 seconds of running is marked active");
    assert.equal(HYDRAWISE_SUSPEND_DURATION, 31556926, "the suspend-all offset is one year in seconds");
  });

  test("the connection pool's retries settle inside the request timeout", () => {

    /* The relation is the receipt, not the literals. The ladder's waits come from the library's own merge of the plugin's policy over its defaults, each retry
     * waiting the seed grown by the factor for every retry before it and capped at the ceiling, so a change to the retry count or to the library's ladder that
     * pushes the waits past the timeout fails here rather than turning every server error into a report that the API was taking too long.
     */
    const ladder = present(apiRetryOptions({ maxRetries: HYDRAWISE_API_RETRY_ATTEMPTS }), "the merged retry policy");
    const minTimeout = present(ladder.minTimeout, "the ladder's first wait");
    const timeoutFactor = present(ladder.timeoutFactor, "the ladder's growth factor");
    const maxTimeout = present(ladder.maxTimeout, "the ladder's ceiling");
    const waits = Array.from({ length: HYDRAWISE_API_RETRY_ATTEMPTS }, (_, retry) => Math.min(minTimeout * (timeoutFactor ** retry), maxTimeout));

    assert.equal(ladder.maxRetries, HYDRAWISE_API_RETRY_ATTEMPTS, "the merged policy carries the plugin's own retry count");
    assert.ok(waits.reduce((total, wait) => total + wait, 0) < (HYDRAWISE_API_TIMEOUT * 1000), "the ladder's waits together fit inside the request timeout");
  });

  test("the retried statuses leave out the ones that carry their own meaning", () => {

    // An invalid key and a reached rate limit are answers the caller reports at once, so neither may be retried into a different sentence.
    assert.ok(!HYDRAWISE_API_RETRY_STATUS_CODES.includes(404), "an invalid API key is not retried");
    assert.ok(!HYDRAWISE_API_RETRY_STATUS_CODES.includes(429), "a reached rate limit is not retried");
  });

  test("locks in the documented Hydrawise rate ceilings and the command endpoint", () => {

    // Each assertion below says whether it asserts a call count or a window duration in seconds, so a swapped pair would otherwise read as a plausible ceiling.
    assert.equal(HYDRAWISE_API_BUDGET_CALLS, 30, "the account-wide ceiling admits 30 calls");
    assert.equal(HYDRAWISE_API_BUDGET_WINDOW, 300, "the account-wide ceiling is measured over 300 seconds");
    assert.equal(HYDRAWISE_COMMAND_BUDGET_CALLS, 3, "the zone-command ceiling admits 3 calls");
    assert.equal(HYDRAWISE_COMMAND_BUDGET_WINDOW, 30, "the zone-command ceiling is measured over 30 seconds");
    assert.equal(HYDRAWISE_COMMAND_ENDPOINT, "setzone.php", "setzone.php is the endpoint under the stricter command ceiling");
  });

  test("the enhanced-features cadence fits inside the ceiling it is paced against", () => {

    /* The arithmetic is the receipt, not the literal. The refresh spends one read per tick, so the reads a whole budget window admits has to leave room for the
     * token grants those reads carry - each of which draws the same ceiling. Asserting the RELATIONSHIP rather than the number is what makes a future change to
     * either constant fail here if it breaks the pacing, instead of silently spending an account into throttling.
     */
    assert.equal(HYDRAWISE_V2_REFRESH_INTERVAL, 900, "the refresh runs every 15 minutes");
    assert.equal(HYDRAWISE_V2_BUDGET_WINDOW / HYDRAWISE_V2_REFRESH_INTERVAL, 2, "which is two reads per budget window");
    assert.ok((HYDRAWISE_V2_BUDGET_WINDOW / HYDRAWISE_V2_REFRESH_INTERVAL) < HYDRAWISE_V2_BUDGET_CALLS,
      "leaving headroom inside the ceiling for the token grants those reads carry");
  });

  test("the command ceiling is stated as its own count and window, independent of the read ceiling", () => {

    /* The command ceiling is asserted apart from the read ceiling because their separation IS the policy: commands are event-shaped user actions where the reads are
     * a recurring cadence, so neither number is derivable from the other and a change to either is a deliberate edit. The relationship worth asserting alongside
     * them is the one the split was made for - a command ceiling narrower than the read ceiling would put a user's own action on a tighter leash than the
     * background traffic it was separated from.
     */
    assert.equal(HYDRAWISE_V2_MUTATION_BUDGET_CALLS, 10, "the command ceiling admits 10 commands");
    assert.equal(HYDRAWISE_V2_MUTATION_BUDGET_WINDOW, 3600, "the command ceiling is measured over 3600 seconds");
    assert.ok((HYDRAWISE_V2_MUTATION_BUDGET_CALLS - HYDRAWISE_V2_BUDGET_CALLS) > 0,
      "and it is the more generous, which is what gives a burst of commands its headroom");
  });

  test("the facts lifetime is derived from the cadence rather than restated beside it", () => {

    // Twice the cadence is the deliberate ratio: one missed refresh never flips a consumer to its fallback, while a refresh loop that has stopped does.
    assert.equal(HYDRAWISE_V2_FACTS_TTL, HYDRAWISE_V2_REFRESH_INTERVAL * 2, "a facts snapshot outlives exactly one missed refresh");
  });

  test("locks in the MQTT and platform identity constants", () => {

    assert.equal(HYDRAWISE_MQTT_TOPIC, "hydrawise", "the default MQTT topic prefix is hydrawise");
    assert.equal(PLATFORM_NAME, "Hydrawise", "the platform name is Hydrawise");
    assert.equal(PLUGIN_NAME, "homebridge-hunter-hydrawise", "the plugin name is homebridge-hunter-hydrawise");
  });
});
