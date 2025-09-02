/* Copyright(C) 2017-2025, HJD (https://github.com/hjdhjd). All rights reserved.
 *
 * hydrawise-options.ts: Feature option and type definitions for Hydrawise.
 */

import type { FeatureOptionEntry } from "homebridge-plugin-utils";

// Plugin configuration options.
export type HydrawiseOptions = {

  apiKey: string;
  debug?: boolean;
  mqttTopic: string;
  mqttUrl?: string;
  options?: string[];
};

// Feature option categories.
export const featureOptionCategories = [

  { description: "Device feature options.", name: "Device" },
  { description: "Logging feature options.", name: "Log" }
];

// Individual feature options, broken out by category.
export const featureOptions: { [index: string]: FeatureOptionEntry[] } = {

  // Device options.
  "Device": [

    { default: true, description: "Make this device available in HomeKit.", name: "" },
    { default: false, description: "Enable a switch accessory to control suspending all zones.", name: "Suspend" }
  ],

  // Logging options.
  "Log": [

    { default: true, description: "Log zone start and stop events in Homebridge.", name: "Zone" }
  ]
};
