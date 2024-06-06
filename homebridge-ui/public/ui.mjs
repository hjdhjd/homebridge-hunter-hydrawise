/* Copyright(C) 2017-2024, HJD (https://github.com/hjdhjd). All rights reserved.
 *
 * ui.mjs: Homebridge Hunter Hydrawise webUI.
 */

"use strict";

import { webUi } from "./lib/webUi.mjs";

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

// Return the list of devices and associated details for this API key.
const getDevices = async () => {

  // Retrieve the full list of cached accessories.
  let devices = await homebridge.getCachedAccessories();

  // Filter out only the components we're interested in.
  devices = devices.map(device => ({

    firmwareVersion: (device.services.find(service => service.constructorName ===
      "AccessoryInformation")?.characteristics.find(characteristic => characteristic.constructorName === "FirmwareRevision")?.value ?? ""),
    name: device.displayName,
    serial: (device.services.find(service => service.constructorName ===
      "AccessoryInformation")?.characteristics.find(characteristic => characteristic.constructorName === "SerialNumber")?.value ?? ""),
    zones: device.services.filter(service => service.constructorName === "Valve").length.toString()
  }));

  // Sort it for posterity.
  devices.sort((a, b) => {

    const aCase = (a.name ?? "").toLowerCase();
    const bCase = (b.name ?? "").toLowerCase();

    return aCase > bCase ? 1 : (bCase > aCase ? -1 : 0);
  });

  // Return the list.
  return devices;
}

// Show the details for this device.
const showDeviceDetails = (device) => {

    const deviceFirmware = document.getElementById("device_firmware") ?? {};
    const deviceSerial = document.getElementById("device_serial") ?? {};
    const deviceZones = document.getElementById("device_zones") ?? {};

    // No device specified, we must be in a global context.
    if(!device) {

      deviceFirmware.innerHTML = "N/A";
      deviceSerial.innerHTML = "N/A";
      deviceZones.innerHTML = "N/A";

      return;
    }

    // Display our device details.
    deviceFirmware.innerHTML = device.firmwareVersion;
    deviceSerial.innerHTML = device.serial;
    deviceZones.innerHTML = device.zones;
};

// Parameters for our feature options webUI.
const featureOptionsParams = {

  getDevices: getDevices,
  hasControllers: false,
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
