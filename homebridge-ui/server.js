/* Copyright(C) 2017-2024, HJD (https://github.com/hjdhjd). All rights reserved.
 *
 * server.js: homebridge-hunter-hydrawise webUI server API.
 */
"use strict";

import { featureOptionCategories, featureOptions } from "../dist/hydrawise-options.js";
import { HomebridgePluginUiServer } from "@homebridge/plugin-ui-utils";

class PluginUiServer extends HomebridgePluginUiServer {

  constructor() {
    super();

    // Register getOptions() with the Homebridge server API.
    this.onRequest("/getOptions", () => ({ categories: featureOptionCategories, options: featureOptions }));

    // Register getOptions() with the Homebridge server API.
    this.onRequest("/login", async (apiKey) => {

      // eslint-disable-next-line camelcase
      const params = new URLSearchParams({ api_key: apiKey });

      // Construct our API call.
      const response = await fetch("https://api.hydrawise.com/api/v1/customerdetails.php?" + params.toString());

      // Bad username and password.
      if(response.status === 404) {

        return "Invalid API key. Please check your Hydrawise API key.";
      }

      // API rate limit exceeded.
      if(response.status === 429) {

        return "Hydrawise API rate limit has been exceeded.";
      }

      // Some other unknown error occurred.
      if(!response.ok) {

        return response.status.toString() + ": " + await response.text();
      }

      return "success";
    });

    this.ready();
  }
}

(() => new PluginUiServer())();
