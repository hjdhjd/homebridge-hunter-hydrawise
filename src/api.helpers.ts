/* Copyright(C) 2017-2026, HJD (https://github.com/hjdhjd). All rights reserved.
 *
 * api.helpers.ts: Factories that compose the synthetic fixture data in api.fixtures.ts into whole Hydrawise API response objects. Every
 * factory returns a fresh deep clone so a test that mutates a result - or production code that reassigns and trims a response's relays - never leaks state into
 * another test or back into the shared fixture constants.
 */

// The Hydrawise API wire shapes use snake_case keys such as relay_id and controller_id, so camelcase is disabled here to let these literals mirror the wire verbatim.
/* eslint-disable camelcase */
import type { CustomerDetailsResponse, HydrawiseZoneConfig, StatusScheduleResponse } from "./types.ts";
import { bareSensors, normalZoneMatrix, rainSensors, sentinelZoneMatrix, syntheticController, syntheticCustomerDetails } from "./api.fixtures.ts";

/**
 * Build a single zone in the statusschedule wire shape. The defaults describe a zone running now (`time` of 1 with a positive remaining `run`); pass overrides
 * to model a scheduled or active-soon zone. A suspended zone is not reachable through this factory's fields alone - that state is classified from a
 * commanded suspend-all timestamp, a v2 `facts.suspendedUntil`, or a carried-forward `priorSuspendedUntil`, none of which HydrawiseZoneConfig carries.
 *
 * @param overrides - Partial zone fields to override the running-now defaults.
 *
 * @returns A fresh HydrawiseZoneConfig.
 */
export function makeZone(overrides: Partial<HydrawiseZoneConfig> = {}): HydrawiseZoneConfig {

  return {

    name: "Test Zone",
    relay: 1,
    relay_id: 700001,
    run: 600,
    time: 1,
    timestr: "",
    ...overrides
  };
}

/**
 * Build a customerdetails.php response around the synthetic controller. Pass overrides to vary the account fields or supply a different controller list.
 *
 * @param overrides - Partial customer-details fields to override the synthetic defaults.
 *
 * @returns A fresh CustomerDetailsResponse.
 */
export function makeCustomerDetails(overrides: Partial<CustomerDetailsResponse> = {}): CustomerDetailsResponse {

  return {

    controller_id: syntheticCustomerDetails.controller_id,
    controllers: [{ ...syntheticController }],
    current_controller: syntheticCustomerDetails.current_controller,
    customer_id: syntheticCustomerDetails.customer_id,
    ...overrides
  };
}

/**
 * Build a statusschedule.php response. The defaults carry the steady-state 19-zone matrix and a rain sensor referencing every zone, at the wire-realistic
 * 60-second poll cadence. Pass overrides to swap the relay matrix, the sensor block, or the poll cadence.
 *
 * @param overrides - Partial status-schedule fields to override the steady-state defaults.
 *
 * @returns A fresh StatusScheduleResponse.
 */
export function makeStatusSchedule(overrides: Partial<StatusScheduleResponse> = {}): StatusScheduleResponse {

  return {

    message: "",
    nextpoll: 60,
    relays: structuredClone(normalZoneMatrix) as HydrawiseZoneConfig[],
    sensors: structuredClone(rainSensors),
    time: 1715480009,
    ...overrides
  };
}

/**
 * The steady-state schedule: the full 19-zone matrix, no zone suspended.
 *
 * @returns A fresh StatusScheduleResponse describing normal operation.
 */
export function normalSchedule(): StatusScheduleResponse {

  return makeStatusSchedule();
}

/**
 * The rain-stopped schedule: every zone carries the unscheduled sentinel and the rain sensor references every relay, so isStoppedBySensor resolves true across the
 * matrix.
 *
 * @returns A fresh StatusScheduleResponse describing a rain-sensor stop.
 */
export function rainStopped(): StatusScheduleResponse {

  return makeStatusSchedule({ relays: structuredClone(sentinelZoneMatrix) as HydrawiseZoneConfig[],
    sensors: structuredClone(rainSensors) });
}

/**
 * The all-suspended schedule: every zone carries the unscheduled sentinel but the sensor references no relay, so the controller reads as all-zones-suspended rather
 * than rain-stopped.
 *
 * @returns A fresh StatusScheduleResponse describing an all-zones-suspended controller.
 */
export function allSuspended(): StatusScheduleResponse {

  return makeStatusSchedule({ relays: structuredClone(sentinelZoneMatrix) as HydrawiseZoneConfig[],
    sensors: structuredClone(bareSensors) });
}
