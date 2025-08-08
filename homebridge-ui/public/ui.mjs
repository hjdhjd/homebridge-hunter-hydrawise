/* Copyright(C) 2017-2025, HJD (https://github.com/hjdhjd). All rights reserved.
 *
 * ui.mjs: Homebridge Hunter Hydrawise webUI.
 */

"use strict";

import { webUi } from "./lib/webUi.mjs";
import { webUiFeatureOptions } from "./lib/webUi-featureoptions.mjs";

// Execute our first run screen if we don't have a valid Hydrawise API key.
const firstRunIsRequired = () => ui.featureOptions.currentConfig[0]?.apiKey?.length !== 19;

// Initialize our first run screen with any information from our existing configuration.
const firstRunOnStart = () => {

  // Pre-populate with anything we might already have in our configuration.
  document.getElementById("apiKey").value = ui.featureOptions.currentConfig[0].apiKey ?? "";

  return true;
};

// Validate our Hydrawise API key.
const firstRunOnSubmit = async () => {

  const apiKey = document.getElementById("apiKey").value;
  const tdLoginError = document.getElementById("loginError");

  tdLoginError.innerHTML = "&nbsp;";

  const validateApiKey = await homebridge.request("/login", apiKey);

  if(validateApiKey !== "success") {

    tdLoginError.innerHTML = "<code class=\"text-danger\">" + validateApiKey + "</code>";
    homebridge.hideSpinner();
    return false;
  }

  ui.featureOptions.currentConfig[0].apiKey = apiKey;
  await homebridge.updatePluginConfig(ui.featureOptions.currentConfig);

  return true;
};

// Tailor the list of devices and associated details for this API key.
const getDevices = async () => {

  // Retrieve the list of devices from HBPU that we then customize further.
  const devices = await ui.featureOptions.getHomebridgeDevices();

  // Retrieve the full list of cached accessories.
  const accessories = await homebridge.getCachedAccessories();

  // We want to retrieve the list of zones associated with each accessory so we can include that in the UI.
  for(const accessory of accessories) {

    // Find the serial number of the accessory.
    const info = accessory.services.find(s => s.constructorName === "AccessoryInformation");
    const serialNumber = info?.characteristics.find(c => c.constructorName === "SerialNumber")?.value;

    if(serialNumber) {

      const device = devices.find(d => d.serialNumber === serialNumber);

      if(device) {

        device.zones = accessory.services.filter(service => service.constructorName === "Valve").length.toString();
      }
    }
  }

  // Return the list.
  return devices;
}

// Show the details for this device.
const showDeviceDetails = (device) => {

  const deviceStatsContainer = document.getElementById("deviceStatsContainer");

  // No device specified, we must be in a global context.
  if(!device) {

    deviceStatsContainer.innerHTML = "";
    return;
  }

  // Populate the device details.
  deviceStatsContainer.innerHTML =
    "<div class=\"device-stats-grid\">" +
      "<div class=\"stat-item\">" +
        "<span class=\"stat-label\">MAC Address</span>" +
        "<span class=\"stat-value font-monospace\">" + device.serialNumber + "</span>" +
      "</div>" +
      "<div class=\"stat-item\">" +
        "<span class=\"stat-label\">Zones</span>" +
        "<span class=\"stat-value\">" +  device.zones + "</span>" +
      "</div>" +
    "</div>";
};

// Parameters for our feature options webUI.
const featureOptionsParams = {

  getDevices: getDevices,
  infoPanel: showDeviceDetails,
  sidebar: {

    deviceLabel: "Hydrawise Devices"
  }
};

// Instantiate the webUI.
const ui = new webUi({ featureOptions: featureOptionsParams, firstRun: { isRequired: firstRunIsRequired, onStart: firstRunOnStart, onSubmit: firstRunOnSubmit },
  name: "Hydrawise" });

// Display the webUI.
ui.show();
