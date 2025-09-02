/* Copyright(C) 2020-2025, HJD (https://github.com/hjdhjd). All rights reserved.
 *
 * hydrawise-types.ts: Interface and type definitions for Hydrawise.
 */
// HBHH reserved names.
export enum HydrawiseReservedNames {

  // Manage our switch types.
  SWITCH_SUSPEND_ALL = "All"
}

// Hydrawise API: Hydrawise irrigation controller configuration.
export interface HydrawiseControllerConfig {

  controller_id: number;
  last_contact: string;
  name: string;
  serial_number: string;
  status: string;
}

// Hydrawise API: Hydrawise zone configuration.
export interface HydrawiseZoneConfig {

  master_timer?: number;
  master?: number;
  name: string;
  relay: number;
  relay_id: number;
  run: string;
  time: number;
  timestr: string;
}

// Hydrawise API: customer details endpoint response JSON. This endpoint returns all the controllers associated with a given customer's account.
export interface CustomerDetailsResponse {

  controller_id: number;
  current_controller: string;
  customer_id: number;
  controllers: HydrawiseControllerConfig[];
}

// Hydrawise API: status schedule endpoint response JSON. This endpoint returns watering schedules for controllers.
export interface StatusScheduleResponse {

  message: string;
  nextpoll: number;
  relays: HydrawiseZoneConfig[];
  sensors: {

    input: number;
    mode: number;
    relays: {

      id: number;
    }[];

    type: number;
  }[];

  time: number;
}

// Hydrawise API: set zone endpoint request JSON. This endpoint is used to manually change the zone status (e.g. run, stop, and suspend).
export interface SetZoneRequest {

  action?: "stop" | "run" | "suspend" | "stopall" | "runall" | "suspendall";
  api_key?: string;
  controller_id?: number;
  custom?: number;
  period_id?: number;
  relay_id?: number;
}

// Hydrawise API: set zone endpoint response JSON. This endpoint is used to manually change the zone status (e.g. run, stop, and suspend).
export interface SetZoneResponse {

  message: string;
  message_type: "error" | "info";
}
