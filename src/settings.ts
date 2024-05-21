/* Copyright(C) 2017-2024, HJD (https://github.com/hjdhjd). All rights reserved.
 *
 * settings.ts: Settings and constants for homebridge-hunter-hydrawise.
 */

// Hydrawise API response timeout, in seconds.
export const HYDRAWISE_API_TIMEOUT = 7;

// How often, in seconds, should we retry Hydrawise API calls when they fail.
export const HYDRAWISE_API_RETRY_INTERVAL = 60;

// How much, in seconds, jitter should we inject into the API polling interval. This helps ensure we stay clear of the Hydrawise API rate limits.
export const HYDRAWISE_API_JITTER = 0.2;

// Time until the next zone valve runtime, in seconds, that we should use to indicate that a zone should be marked as active.
export const HYDRAWISE_ACTIVE_ZONE_INDICATOR = 3600;

// How often, in seconds, should we try to reconnect with an MQTT broker, if we have one configured.
export const MQTT_RECONNECT_INTERVAL = 60;

// Default MQTT topic to use when publishing events. This is in the form of: hydrawise/device/event
export const HYDRAWISE_MQTT_TOPIC = "hydrawise";

// The platform the plugin creates.
export const PLATFORM_NAME = "Hydrawise";

// The name of our plugin.
export const PLUGIN_NAME = "homebridge-hunter-hydrawise";
