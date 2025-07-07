/* Copyright(C) 2017-2025, HJD (https://github.com/hjdhjd). All rights reserved.
 *
 * index.ts: homebridge-hydrawise plugin registration.
 */
import { PLATFORM_NAME, PLUGIN_NAME } from "./settings.js";
import type { API } from "homebridge";
import { HydrawisePlatform } from "./hydrawise-platform.js";

// Register our platform with homebridge.
export default (api: API): void => {

  api.registerPlatform(PLUGIN_NAME, PLATFORM_NAME, HydrawisePlatform);
};
