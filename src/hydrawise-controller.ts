/* Copyright(C) 2017-2025, HJD (https://github.com/hjdhjd). All rights reserved.
 *
 * hydrawise-controller.ts: Base class for all Hydrawise irrigation controllers.
 */
import type { API, CharacteristicValue, HAP, PlatformAccessory, Service } from "homebridge";
import { HYDRAWISE_ACTIVE_ZONE_INDICATOR, HYDRAWISE_API_JITTER, HYDRAWISE_API_RETRY_INTERVAL } from "./settings.js";
import { type HomebridgePluginLogging, type Nullable, acquireService, getServiceName, retry, sleep, validService } from "homebridge-plugin-utils";
import type { HydrawiseControllerConfig, HydrawiseZoneConfig, SetZoneResponse, StatusScheduleResponse } from "./hydrawise-types.js";
import type { Dispatcher } from "undici";
import type { HydrawiseOptions } from "./hydrawise-options.js";
import type { HydrawisePlatform } from "./hydrawise-platform.js";
import { HydrawiseReservedNames } from "./hydrawise-types.js";
import util from "node:util";

// Device-specific options and settings.
interface HydrawiseHints {

  logZone: boolean,
  suspendAll: boolean
}

export class HydrawiseController {

  private readonly accessory: PlatformAccessory;
  private readonly api: API;
  private readonly config: HydrawiseOptions;
  public readonly controller: HydrawiseControllerConfig;
  private readonly hap: HAP;
  private readonly hints: HydrawiseHints;
  public readonly log: HomebridgePluginLogging;
  private readonly platform: HydrawisePlatform;
  private status: StatusScheduleResponse;
  private zoneHints: { [index: number]: Record<string, boolean> };

  // The constructor initializes key variables and calls configureDevice().
  constructor(platform: HydrawisePlatform, accessory: PlatformAccessory, controller: HydrawiseControllerConfig) {

    this.accessory = accessory;
    this.api = platform.api;
    this.status = {} as StatusScheduleResponse;
    this.config = platform.config;
    this.hap = this.api.hap;
    this.hints = {} as HydrawiseHints;
    this.controller = controller;
    this.platform = platform;
    this.zoneHints = {};

    this.log = {

      debug: (message: string, ...parameters: unknown[]): void => platform.debug(util.format(this.name + ": " + message, ...parameters)),
      error: (message: string, ...parameters: unknown[]): void => platform.log.error(util.format(this.name + ": " + message, ...parameters)),
      info: (message: string, ...parameters: unknown[]): void => platform.log.info(util.format(this.name + ": " + message, ...parameters)),
      warn: (message: string, ...parameters: unknown[]): void => platform.log.warn(util.format(this.name + ": " + message, ...parameters))
    };

    this.configureDevice();
  }

  // Configure an irrigation system accessory for HomeKit.
  private configureDevice(): void {

    // Clean out the context object.
    this.accessory.context = {};

    // Configure ourselves.
    this.configureHints();
    this.configureInfo();
    this.configureIrrigationSystem();
    this.configureSuspendSwitches();
    this.configureMqtt();

    // Kickoff our state updates.
    void this.updateState();
  }

  // Configure controller-specific settings.
  private configureHints(): boolean {

    this.hints.logZone = this.hasFeature("Log.Zone");
    this.hints.suspendAll = this.hasFeature("Device.Suspend");

    return true;
  }

  // Configure the controller information for HomeKit.
  private configureInfo(): boolean {

    // Update the manufacturer information for this controller.
    this.accessory.getService(this.hap.Service.AccessoryInformation)?.updateCharacteristic(this.hap.Characteristic.Manufacturer, "Hunter");

    // Update the model information for this controller.
    this.accessory.getService(this.hap.Service.AccessoryInformation)?.updateCharacteristic(this.hap.Characteristic.Model, "Hydrawise");

    // Update the serial number for this controller.
    this.accessory.getService(this.hap.Service.AccessoryInformation)?.updateCharacteristic(this.hap.Characteristic.SerialNumber, this.controller.serial_number);

    return true;
  }

  // Configure MQTT services.
  private configureMqtt(): boolean {

    // Return our irrigation controller state.
    this.platform.mqtt?.subscribeGet(this.controller.serial_number, "controller", "Irrigation controller", () => {

      return this.statusJson;
    }, this.log);

    // Set the state of a given irrigation zone.
    this.platform.mqtt?.subscribeSet(this.controller.serial_number, "controller", "Irrigiation controller", async (value: string) => {

      // Parse the command.
      const action = value.split(" ");

      // Parse the zone number.
      const zoneValue = parseInt(action[1]);

      // Let's find the zone, if it exists.
      const zone = this.status.relays.find(x => x.relay === zoneValue);

      // No zone, we're done.
      if(!zone) {

        this.log.error("MQTT: Invalid zone specified.");

        return;
      }

      switch(action[0]) {

        case "start":

          await this.sendCommand(zone, "run", parseInt(action[2]));

          return;

        case "stop":

          await this.sendCommand(zone, "stop");

          return;

        default:

          this.log.error("Invalid command.");

          return;
      }
    }, this.log);

    return true;
  }

  // Configure the irrigation system service for HomeKit.
  private configureIrrigationSystem(): boolean {

    // Acquire the service and if needed, add a service label service in order to be able to properly enumerate and name the individual zone valves.
    const service = acquireService(this.accessory, this.hap.Service.IrrigationSystem, this.name, undefined,
      () => acquireService(this.accessory, this.hap.Service.ServiceLabel, this.name)
        ?.updateCharacteristic(this.hap.Characteristic.ServiceLabelNamespace, this.hap.Characteristic.ServiceLabelNamespace.ARABIC_NUMERALS));

    if(!service) {

      this.log.error("Unable to add the irrigation controller.");

      return false;
    }

    // Initialize the service.
    service.updateCharacteristic(this.hap.Characteristic.Active, this.hap.Characteristic.Active.ACTIVE);
    service.updateCharacteristic(this.hap.Characteristic.InUse, this.hap.Characteristic.InUse.NOT_IN_USE);
    service.updateCharacteristic(this.hap.Characteristic.ProgramMode, this.hap.Characteristic.ProgramMode.PROGRAM_SCHEDULED);

    return true;
  }

  // Configure suspend switch services for HomeKit.
  private configureSuspendSwitches(): boolean {

    // Validate whether we should have this service enabled.
    if(!validService(this.accessory, this.hap.Service.Switch, this.hints.suspendAll, HydrawiseReservedNames.SWITCH_SUSPEND_ALL)) {

      return false;
    }

    // Acquire the service.
    const service = acquireService(this.accessory, this.hap.Service.Switch,
      getServiceName(this.accessory.getServiceById(this.hap.Service.Switch, HydrawiseReservedNames.SWITCH_SUSPEND_ALL)) ?? this.accessoryName + " Suspend All Zones",
      HydrawiseReservedNames.SWITCH_SUSPEND_ALL);

    // Fail gracefully.
    if(!service) {

      this.log.error("Unable to add suspend all zones switch.");

      return false;
    }

    // Suspend or resume the irrigation schedule.
    service.getCharacteristic(this.hap.Characteristic.On)?.onGet(() => this.isAllSuspended);

    service.getCharacteristic(this.hap.Characteristic.On)?.onSet(async (value: CharacteristicValue) => {

      // We either set the timestamp to the current time, to resume irrigation, or to a year from now to suspend irrigation.
      const timestamp = (Date.now() / 1000) + (value ? 31556926 : 0);

      const response = await this.sendCommand("suspendall", timestamp);

      let status;

      try {

        status = await response?.body.json() as SetZoneResponse;
      } catch(error) {

        this.log.error("Unable to retrieve the result of the %s request.", value ? "suspend" : "resume");
      }

      if(status?.message_type === "error") {

        this.log.error("Unable to complete the %s request.", value ? "suspend" : "resume");
      }

      if(!status || (status.message_type === "error")) {

        setTimeout(() => service.updateCharacteristic(this.hap.Characteristic.On, !value), 50);

        return;
      }

      this.log.info("%s scheduled watering for all zones.", value ? "Suspending" : "Resuming");
    });

    service.updateCharacteristic(this.hap.Characteristic.On, this.isAllSuspended);

    this.log.info("Enabling suspend all zones switch.");

    return true;
  }

  // Update the irrigation system state from the Hydrawise API to HomeKit.
  private async updateState(): Promise<void> {

    // We loop forever, updating our irrigation system state at regular intervals.
    for(;;) {

      const isFirstRun = this.status?.nextpoll === undefined;

      // Update our status. If it's our first run through, we use our internal defaults.
      // eslint-disable-next-line no-await-in-loop
      await retry(async () => this.getStatus(), (isFirstRun ? HYDRAWISE_API_RETRY_INTERVAL : (this.status.nextpoll + HYDRAWISE_API_JITTER)) * 1000);

      // Let's get the list of current valves on this irrigation controller.
      const currentValves = this.status.relays.map(x => x.relay_id.toString());

      // Remove valves that no longer exist.
      this.accessory.services.filter(x => (x.UUID === this.hap.Service.Valve.UUID) && !currentValves.includes(x.subtype ?? "")).map(x => this.accessory.removeService(x));

      // Trim whitespace on zone names.
      this.status.relays = this.status.relays.map(x => ({ ...x, name: x.name.trim() }));

      let irrigationRemaining = 0;

      // Find the irrigation system service.
      const irrigationSystemService = this.accessory.getService(this.hap.Service.IrrigationSystem);

      // Discover any new zones and update our zone state.
      for(const zone of this.status.relays) {

        // Acquire the valve service.
        let isNewValve = false;
        const valveService = acquireService(this.accessory, this.hap.Service.Valve,
          (this.accessory.getServiceById(this.hap.Service.Valve, zone.relay_id.toString())?.getCharacteristic(this.hap.Characteristic.ConfiguredName).value as string) ??
            zone.name, zone.relay_id.toString(), (newService: Service) => {

            // Enumerate the valve service to align with the irrigation controller's zone numbering.
            newService.updateCharacteristic(this.hap.Characteristic.ServiceLabelIndex, zone.relay);

            // This allows users to enable or disable the zone from within HomeKit. We could exclude it, but the extra optionality for end users can be useful.
            newService.updateCharacteristic(this.hap.Characteristic.IsConfigured, this.hap.Characteristic.IsConfigured.CONFIGURED);

            // All valves attached to an irrigation system must have their type set accordingly.
            newService.updateCharacteristic(this.hap.Characteristic.ValveType, this.hap.Characteristic.ValveType.IRRIGATION);

            // Ensure that we inform the user of the new valve.
            isNewValve = true;
          });

        if(!valveService) {

          this.log.error("Unable to create a valve service for zone: %s (%s).", zone.name, zone.relay_id);

          continue;
        }

        // See if the zone has been stopped due to a rain sensor event.
        const isStopped = this.isStoppedBySensor(zone);

        // Inform the user.
        if(isFirstRun || isNewValve) {

          // Create our zone hints, if needed.
          if(!this.zoneHints[zone.relay_id]) {

            this.zoneHints[zone.relay_id] = {};
          }

          // Initialize our stopped state.
          this.zoneHints[zone.relay_id].isStopped = isStopped;

          this.log.info("%s: %s", this.getValveName(valveService, zone), this.zoneStatus(zone));

          // Manually control the zone valve.
          valveService.getCharacteristic(this.hap.Characteristic.Active).onSet(async (value: CharacteristicValue) => {

            const setOn = value === this.hap.Characteristic.Active.ACTIVE;
            const duration = valveService.getCharacteristic(this.hap.Characteristic.SetDuration).value?.toString() ?? "0";
            let response;

            // Request the change in zone state.
            if(setOn) {

              response = await this.sendCommand(zone, "run", parseInt(duration));
            } else {

              response = await this.sendCommand(zone, "stop");
            }

            // Something went wrong in communicating with the Hydrawise API.
            if(!response) {

              // Revert our state for this zone.
              setTimeout(() => valveService.updateCharacteristic(this.hap.Characteristic.Active,
                setOn ? this.hap.Characteristic.Active.INACTIVE : this.hap.Characteristic.Active.ACTIVE), 50);

              return;
            }

            // Update our valve state accordingly.
            if(setOn) {

              valveService.updateCharacteristic(this.hap.Characteristic.InUse, this.hap.Characteristic.InUse.IN_USE);
              valveService.updateCharacteristic(this.hap.Characteristic.RemainingDuration, duration);
              irrigationSystemService?.updateCharacteristic(this.hap.Characteristic.ProgramMode,
                ("PROGRAM_SCHEDULED_MANUAL_MODE" in this.hap.Characteristic.ProgramMode) ? this.hap.Characteristic.ProgramMode.PROGRAM_SCHEDULED_MANUAL_MODE as number :
                  (("PROGRAM_SCHEDULED_MANUAL_MODE_" in this.hap.Characteristic.ProgramMode) ?
                    this.hap.Characteristic.ProgramMode.PROGRAM_SCHEDULED_MANUAL_MODE_ as number : 2));
              irrigationSystemService?.updateCharacteristic(this.hap.Characteristic.InUse, this.hap.Characteristic.InUse.IN_USE);

              // Mark this zone as manually activated.
              this.zoneHints[zone.relay_id].isManual = true;
            } else {

              valveService.updateCharacteristic(this.hap.Characteristic.RemainingDuration, 0);
              valveService.updateCharacteristic(this.hap.Characteristic.InUse, this.hap.Characteristic.InUse.NOT_IN_USE);

              // Clear out the manual activation tracker for this zone.
              this.zoneHints[zone.relay_id].isManual = false;

              // No more manually activated zones, we can resume our schedule.
              if(!Object.values(this.zoneHints).some(x => x.isManual)) {

                irrigationSystemService?.updateCharacteristic(this.hap.Characteristic.ProgramMode, this.hap.Characteristic.ProgramMode.PROGRAM_SCHEDULED);
              }

              // If this was the only zone currently running on the irrigation controller, let's set the system to state to no longer in use.
              if(!this.status.relays.some(x => (x.time === 1) && (x.relay_id !== zone.relay_id))) {

                irrigationSystemService?.updateCharacteristic(this.hap.Characteristic.InUse, this.hap.Characteristic.InUse.NOT_IN_USE);
              }
            }

            this.log.info("%s: Manually %s%s.", this.getValveName(valveService, zone), setOn ? "started" : "stopped",
              setOn ? " (duration: " + this.getMinutes(duration) + ")" : "");
          });
        }

        // Determine whether the zone is currently running from the Hydrawise API.
        this.zoneHints[zone.relay_id].isOn = zone.time === 1;

        // Retrieve whether the valve service is in use from HomeKit's perspective.
        const isValveInUse = valveService.getCharacteristic(this.hap.Characteristic.InUse).value === this.hap.Characteristic.InUse.IN_USE;

        // Get the duration of the next run time (if we aren't running currently) or the time remaining in this run if we're running.
        const duration = parseInt(zone.run);

        // If a zone is on, then our irrigation system is in use and we update the remaining runtime duration.
        if(this.zoneHints[zone.relay_id].isOn) {

          irrigationRemaining += duration;

          // Update the duration of the remaining runtime of this valve, in seconds.
          valveService.updateCharacteristic(this.hap.Characteristic.RemainingDuration, Math.min(duration, 3600));
        } else {

          // Clear out the manual activation tracker for this zone.
          this.zoneHints[zone.relay_id].isManual = false;

          // Set the duration of the next run of this valve, in seconds, in HomeKit based on the Hydrawise scheduled runtime.
          valveService.updateCharacteristic(this.hap.Characteristic.SetDuration, Math.min(duration, 3600));
        }

        // Active represents whether the zone is ready to be activated - meaning it's queued to turn on imminently or is currently on.
        if((zone.time > 0) && (zone.time <= HYDRAWISE_ACTIVE_ZONE_INDICATOR)) {

          valveService.updateCharacteristic(this.hap.Characteristic.Active, this.hap.Characteristic.Active.ACTIVE);
          this.log.debug("Setting %s as active.", this.getValveName(valveService, zone));
        } else {

          valveService.updateCharacteristic(this.hap.Characteristic.Active, this.hap.Characteristic.Active.INACTIVE);
        }

        // InUse represents whether there is water flowing through the valve currently.
        valveService.updateCharacteristic(this.hap.Characteristic.InUse, this.zoneHints[zone.relay_id].isOn ?
          this.hap.Characteristic.InUse.IN_USE : this.hap.Characteristic.InUse.NOT_IN_USE);

        // Log our activity, if configured to do so.
        if(this.hints.logZone) {

          // Inform the user if the zone has been started or stopped.
          if(isValveInUse !== this.zoneHints[zone.relay_id].isOn) {

            this.log.info("%s: %s %s", this.getValveName(valveService, zone), this.zoneHints[zone.relay_id].isOn ? "Started" : "Stopped.",
              this.zoneHints[zone.relay_id].isOn ? "(duration: " + this.getMinutes(zone.run) + ")." : this.zoneStatus(zone));
          }

          // Inform the user if the zone has been stopped due to a rain sensor.
          if(isStopped !== this.zoneHints[zone.relay_id].isStopped) {

            this.log.info("%s: Rain sensor is %s irrigation.", this.getValveName(valveService, zone), isStopped ? "stopping" : "allowing");
          }
        }

        // Save the new setting.
        this.zoneHints[zone.relay_id].isStopped = isStopped;
      }

      // Update the irrigation system state.
      irrigationSystemService?.updateCharacteristic(this.hap.Characteristic.InUse,
        (irrigationRemaining > 0) ? this.hap.Characteristic.InUse.IN_USE : this.hap.Characteristic.InUse.NOT_IN_USE);
      irrigationSystemService?.updateCharacteristic(this.hap.Characteristic.RemainingDuration, Math.min(irrigationRemaining, 3600));

      // No more manually activated zones, we can resume our schedule.
      if(!Object.values(this.zoneHints).some(x => x.isManual)) {

        if(Object.values(this.zoneHints).filter(x => x.isStopped).length === this.status.relays.length) {

          irrigationSystemService?.updateCharacteristic(this.hap.Characteristic.ProgramMode, this.hap.Characteristic.ProgramMode.NO_PROGRAM_SCHEDULED);
        } else {

          irrigationSystemService?.updateCharacteristic(this.hap.Characteristic.ProgramMode, this.hap.Characteristic.ProgramMode.PROGRAM_SCHEDULED);
        }
      }

      // Update the irrigation system's program mode if we're not manually running on any zones.
      if(!Object.values(this.zoneHints).some(x => x.isManual)) {

        // If all our zones have been stopped by a rain sensor, we indicate that no program is currently scheduled, otherwise, we're on our normal scheduled program.
        irrigationSystemService?.updateCharacteristic(this.hap.Characteristic.ProgramMode,
          (Object.values(this.zoneHints).filter(x => x.isStopped).length === this.status.relays.length) ?
            this.hap.Characteristic.ProgramMode.NO_PROGRAM_SCHEDULED : this.hap.Characteristic.ProgramMode.PROGRAM_SCHEDULED);
      }

      // Publish our status to MQTT if configured to do so.
      this.platform.mqtt?.publish(this.controller.serial_number, "controller", this.statusJson);

      // Update our suspend status.
      this.accessory.getServiceById(this.hap.Service.Switch, HydrawiseReservedNames.SWITCH_SUSPEND_ALL)?.updateCharacteristic(this.hap.Characteristic.On,
        this.isAllSuspended);

      // Sleep until our next polling interval due to the Hydrawise API being rate-limited.
      // eslint-disable-next-line no-await-in-loop
      await sleep((this.status.nextpoll + HYDRAWISE_API_JITTER) * 1000);
    }
  }

  // Send a command to the Hydrawise API.
  private async sendCommand(zone: HydrawiseZoneConfig, command: "run", duration: number): Promise<Nullable<Dispatcher.ResponseData<unknown>>>;
  private async sendCommand(zone: HydrawiseZoneConfig, command: "stop"): Promise<Nullable<Dispatcher.ResponseData<unknown>>>;
  private async sendCommand(command: "suspendall", duration: number): Promise<Nullable<Dispatcher.ResponseData<unknown>>>;
  private async sendCommand(zoneOrCmd: HydrawiseZoneConfig | "suspendall", cmdOrDur: (number | "run" | "stop"), duration?: number):
  Promise<Nullable<Dispatcher.ResponseData<unknown>>> {

    let command, zone;

    // We've been called as sendCommand("suspendall", duration)
    if(typeof zoneOrCmd === "string") {

      command = zoneOrCmd;
      duration = cmdOrDur as number;
    } else {

      // We've been called as sendCommand(zone, "run" | "stop", [duration])
      zone = zoneOrCmd;
      command = cmdOrDur as "run" | "stop";
    }

    // User has queued us up...send the command to Hydrawise.
    // eslint-disable-next-line camelcase
    const params: Record<string, string> = { controller_id: this.controller.controller_id.toString() };

    // If we've specified the zone, add it to our parameters.
    if(zone?.relay_id) {

      // eslint-disable-next-line camelcase
      params.relay_id = zone.relay_id.toString();
    }

    switch(command) {

      case "run":

        params.action = "run";

        if((duration === undefined) || (duration <= 0)) {

          return null;
        }

        params.custom = duration.toString();

        // eslint-disable-next-line camelcase
        params.period_id = "999";

        break;

      case "stop":

        params.action = "stop";

        break;

      case "suspendall":

        params.action = "suspendall";

        if((duration === undefined) || (duration <= 0)) {

          return null;
        }

        params.custom = duration.toString();

        // eslint-disable-next-line camelcase
        params.period_id = "999";

        delete params.relay_id;

        break;

      default:

        return null;
    }

    // Request the change in zone state.
    return this.platform.retrieve("setzone.php", params);
  }

  // Utility to return the status of a zone to a user.
  private zoneStatus(zone: HydrawiseZoneConfig): string {

    if(this.isStoppedBySensor(zone)) {

      return "Rain sensor is preventing irrigation.";
    }

    // If we're currently running, inform the user of the remaining duration. Otherwise, inform the user of the next runtime.
    if(zone.time === 1) {

      return "Currently running with " + this.getMinutes(zone.run) + " remaining.";
    } else {

      return "Next run will be " + (zone.timestr.includes(":") ? "at " + this.formatStartTime(zone.timestr) : "on " + zone.timestr) + " for " +
        this.getMinutes(zone.run) + ".";
    }
  }

  // Retrieve the current status from the Hydrawise API.
  private async getStatus(): Promise<boolean> {

    // Get our schedule for this controller.
    // eslint-disable-next-line camelcase
    const response = await this.platform.retrieve("statusschedule.php", { controller_id: this.controller.controller_id.toString() });

    // Not found, let's retry again.
    if(!response) {

      return false;
    }

    try {

      this.status = await response.body.json() as StatusScheduleResponse;

      this.log.debug("Status updated.");
      this.log.debug(util.inspect(this.status, { colors: true, depth: null, sorted: true }));
    } catch(error) {

      this.log.error("Unable to retrieve the current status of the irrigation controller: --%s--", util.inspect(error, { colors: true, depth: null, sorted: true }));
    }

    return true;
  }

  // Utility to test for whether a zone has been stopped due to a rain sensor.
  private isStoppedBySensor(zone: HydrawiseZoneConfig): boolean {

    return !zone.run && !zone.timestr && (zone.time === 1576800000) &&
      this.status.sensors.filter(sensor => sensor.type === 1).some(sensor => sensor.relays.some(relay => relay.id === zone.relay_id));
  }

  // Utility to conver the duration from seconds to minutes, with the correct plural marker.
  private getMinutes(duration: string): string {

    const minutes = Math.round(parseInt(duration) / 60);

    return minutes.toString() + " minute" + (minutes !== 1 ? "s" : "");
  }

  // Utility to format the time strings returned by Hydrawise.
  private formatStartTime(time: string): string {

    // Split it into hours and minutes and ensure we convert it in the process.
    const [hours, minutes] = time.split(":").map(Number);

    // Return our user-friendly time string.
    return ((hours % 12) || 12).toString() + ":" + minutes.toString().padStart(2, "0") + " " + (hours >= 12 ? "PM" : "AM");
  }

  // Utility for checking feature options on a device.
  private hasFeature(option: string): boolean {

    return this.platform.featureOptions.test(option, this.controller.serial_number);
  }

  // Utility function to get the configured name of a valve, if set.
  private getValveName(service: Service, zone: HydrawiseZoneConfig): string {

    return ((service.getCharacteristic(this.hap.Characteristic.ConfiguredName).value as string) ?? zone.name) + " [Zone " + zone.relay + "]";
  }

  // Utility to return whether all zones are suspended or not.
  private get isAllSuspended(): boolean {

    return !this.status.relays?.some(zone => zone.run || zone.timestr || (zone.time !== 1576800000) || this.isStoppedBySensor(zone));
  }

  // Utility to return our status as a JSON for MQTT.
  private get statusJson(): string {

    return JSON.stringify(this.status.relays.map(x => ({ name: x.name, relay: x.relay, run: x.run, time: x.time, timestr: x.timestr })));
  }

  // Utility function to return the name of this controller.
  private get name(): string {

    // We use the irrigation system service as the natural proxy for the name.
    const name = this.accessory.getService(this.hap.Service.IrrigationSystem)?.getCharacteristic(this.hap.Characteristic.Name).value as string;

    // If we don't have a name for the irrigation system service, return the controller name from Hydrawise.
    return name?.length ? name : this.controller.name;
  }

  // Utility function to return the current accessory name of this device.
  private get accessoryName(): string {

    return ((this.accessory.getService(this.hap.Service.AccessoryInformation)?.getCharacteristic(this.hap.Characteristic.Name).value as string) ??
      this.controller.name);
  }

  // Utility function to set the current accessory name of this device.
  private set accessoryName(name: string) {

    // Set all the internally managed names within Homebridge to the new accessory name.
    this.accessory.displayName = name;
    this.accessory._associatedHAPAccessory.displayName = name;

    // Set all the HomeKit-visible names.
    this.accessory.getService(this.hap.Service.AccessoryInformation)?.updateCharacteristic(this.hap.Characteristic.Name, name);
  }
}
