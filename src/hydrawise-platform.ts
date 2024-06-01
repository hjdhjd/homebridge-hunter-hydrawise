/* Copyright(C) 2017-2024, HJD (https://github.com/hjdhjd). All rights reserved.
 *
 * hydrawise-platform.ts: homebridge-hydrawise platform class.
 */
import { ALPNProtocol, AbortError, FetchError, Request, RequestOptions, Response, context, timeoutSignal } from "@adobe/fetch";
import { API, APIEvent, DynamicPlatformPlugin, HAP, Logging, PlatformAccessory, PlatformConfig } from "homebridge";
import { CustomerDetailsResponse, HydrawiseControllerConfig } from "./hydrawise-types.js";
import { FeatureOptions, retry } from "homebridge-plugin-utils";
import { HYDRAWISE_API_RETRY_INTERVAL, HYDRAWISE_API_TIMEOUT, HYDRAWISE_MQTT_TOPIC, PLATFORM_NAME, PLUGIN_NAME  } from "./settings.js";
import { HydrawiseOptions, featureOptionCategories, featureOptions } from "./hydrawise-options.js";
import { HydrawiseController } from "./hydrawise-controller.js";
import { MqttClient } from "homebridge-plugin-utils";
import util from "node:util";

export class HydrawisePlatform implements DynamicPlatformPlugin {

  private readonly accessories: PlatformAccessory[];
  private account: CustomerDetailsResponse;
  public readonly api: API;
  public readonly featureOptions: FeatureOptions;
  public config!: HydrawiseOptions;
  public readonly configuredDevices: { [index: string]: HydrawiseController };
  private fetch: (url: string | Request, options?: RequestOptions) => Promise<Response>;
  public readonly hap: HAP;
  public readonly log: Logging;
  public readonly mqtt: MqttClient | null;

  constructor(log: Logging, config: PlatformConfig, api: API) {

    this.accessories = [];
    this.account = {} as CustomerDetailsResponse;
    this.api = api;
    this.configuredDevices = {};
    this.featureOptions = new FeatureOptions(featureOptionCategories, featureOptions, config?.options ?? []);
    this.fetch = context({ alpnProtocols: [ALPNProtocol.ALPN_HTTP2], rejectUnauthorized: false, userAgent: "homebridge-hunter-hydrawise" }).fetch;
    this.hap = api.hap;
    this.log = log;
    this.log.debug = this.debug.bind(this);
    this.mqtt = null;

    // We can't start without being configured.
    if(!config) {

      return;
    }

    this.config = {

      apiKey: config.apiKey as string,
      debug: config.debug === true,
      mqttTopic: (config.mqttTopic as string) ?? HYDRAWISE_MQTT_TOPIC,
      mqttUrl: config.mqttUrl as string,
      options: config.options as string[]
    };

    // No Hydrawise API key, we're done.
    if(!this.config.apiKey?.length) {

      this.log.error("Unable to startup: no Hunter Hydrawise API key has been configured. Please configure one and restart the plugin.");

      return;
    }

    // Initialize MQTT, if needed.
    if(this.config.mqttUrl) {

      this.mqtt = new MqttClient(this.config.mqttUrl, this.config.mqttTopic, this.log);
    }

    this.log.debug("Debug logging on. Expect a lot of data.");

    // Fire up the Hydrawise API once Homebridge has loaded all the cached accessories it knows about and called configureAccessory() on each.
    api.on(APIEvent.DID_FINISH_LAUNCHING, () => void this.configureHydrawise());
  }

  // This gets called when homebridge restores cached accessories at startup. We intentionally avoid doing anything significant here, and save all that logic for
  // Hydrawise API enumeration.
  public configureAccessory(accessory: PlatformAccessory): void {

    // Add this to the accessory array so we can track it.
    this.accessories.push(accessory);
  }

  // Configure and connect to the Hydrawise API.
  private async configureHydrawise(): Promise<void> {

    // Keep retrying until we're successful at regular intervals.
    await retry(async (): Promise<boolean> => {

      // Get our list of controllers.
      const response = await this.retrieve("customerdetails.php");

      // Not found, let's retry again.
      if(!response) {

        return false;
      }

      try {

        this.account = await response.json() as CustomerDetailsResponse;
      } catch(error) {

        this.log.error("Unable to retrieve the list of controllers: %s", util.inspect(error, { colors: true, sorted: true }));

        return false;
      }

      this.log.info("Successfully connected to the Hydrawise API.");

      this.log.debug(util.inspect(this.account, { colors: true, sorted: true }));

      // Trim whitespace on irrigation controller names.
      this.account.controllers = this.account.controllers.map(x => ({ ...x, name: x.name.trim() }));

      for(const controller of this.account.controllers) {

        this.log.info("Discovered irrigation controller: %s (serial: %s id: %s).", controller.name, controller.serial_number, controller.controller_id);

        this.configureController(controller);
      }

      // Find all the orphaned irrigation controller accessories that aren't in the authoritative list provided by Hydrawise for this account and remove them.
      this.accessories.filter(controller => !this.account.controllers.some(accessory => this.hap.uuid.generate(accessory.controller_id.toString()) === controller.UUID))
        .map(accessory => this.removeAccessory(accessory));

      return true;
    }, HYDRAWISE_API_RETRY_INTERVAL * 1000);
  }

  // Configure a discovered irrigation controller.
  private configureController(controller: HydrawiseControllerConfig): HydrawiseController | null {

    // Generate this controller's unique identifier.
    const uuid = this.hap.uuid.generate(controller.controller_id.toString());

    // See if we already know about this accessory or if it's truly new.
    let accessory = this.accessories.find(x => x.UUID === uuid);

    // Check to see if the user has disabled the device.
    if(!this.featureOptions.test("Device", controller.controller_id.toString())) {

      // If the accessory already exists, let's remove it.
      if(accessory) {

        this.removeAccessory(accessory);
      }

      // We're done.
      return null;
    }

    // If we've already configured this device before, we're done.
    if(this.configuredDevices[uuid]) {

      return null;
    }

    // It's a new device - let's add it to HomeKit.
    if(!accessory) {

      accessory = new this.api.platformAccessory(controller.name, uuid);

      // Register this accessory with Homebridge and add it to the accessory array so we can track it.
      this.api.registerPlatformAccessories(PLUGIN_NAME, PLATFORM_NAME, [accessory]);
      this.accessories.push(accessory);
    }

    // Inform the user.
    this.log.info("Configuring irrigation controller: %s (serial: %s id: %s).", controller.name, controller.serial_number, controller.controller_id);

    // Add it to our list of configured devices.
    this.configuredDevices[uuid] = new HydrawiseController(this, accessory, controller);

    // Refresh the accessory cache.
    this.api.updatePlatformAccessories([accessory]);

    return this.configuredDevices[uuid];
  }

  // Remove the accessory from HomeKit.
  private removeAccessory(accessory: PlatformAccessory): void {

    // Inform the user.
    this.log.info("%s: Removing device from HomeKit.", accessory.displayName);

    // Unregister the accessory and delete it's remnants from HomeKit.
    this.api.unregisterPlatformAccessories(PLUGIN_NAME, PLATFORM_NAME, [ accessory ]);
    this.accessories.splice(this.accessories.indexOf(accessory), 1);
    this.api.updatePlatformAccessories(this.accessories);
  }

  // Communicate HTTP requests with the Hydrawise API.
  // Internal interface to communicating HTTP requests with a Protect controller, with error handling.
  public async retrieve(endpoint: string, params?: Record<string, string>, isRetry = false): Promise<Response | null> {

    // Catch Protect controller server-side issues:
    //
    // 400: Bad request.
    // 404: Not found.
    // 429: Too many requests.
    // 500: Internal server error.
    // 502: Bad gateway.
    // 503: Service temporarily unavailable.
    // const isServerSideIssue = (code: number): boolean => [400, 404, 429, 500, 502, 503].some(x => x === code);

    let response: Response;

    // Create a signal handler to deliver the abort operation.
    const signal = timeoutSignal(HYDRAWISE_API_TIMEOUT * 1000);

    if(!params) {

      params = {};
    }

    // Set our API key.
    // eslint-disable-next-line camelcase
    params.api_key = this.config.apiKey;

    const queryParams = new URLSearchParams(params);

    // Construct our API call.
    const url = "https://api.hydrawise.com/api/v1/" + endpoint + "?" + queryParams.toString();

    try {

      // Execute the API call.
      response = await this.fetch(url, { signal: signal });

      // Bad username and password.
      if(response.status === 404) {

        this.log.error("Invalid API key. Please check your Hydrawise API key.");

        return null;
      }

      // API rate limit exceeded.
      if(response.status === 429) {

        this.log.error("Hydrawise API rate limit has been exceeded.");

        return null;
      }

      // Some other unknown error occurred.
      if(!response.ok) {

        this.log.error("%s: %s", response.status, await response.text());

        return null;
      }

      return response;
    } catch(error) {

      if(error instanceof AbortError) {

        this.log.error("The Hydrawise API is taking too long to respond to a request. This error can usually be safely ignored.");
        this.log.debug("Original request was: %s", url);

        return null;
      }

      if(error instanceof FetchError) {

        switch(error.code) {

          case "ECONNREFUSED":
          case "ERR_HTTP2_STREAM_CANCEL":

            this.log.error("Connection refused.");

            break;

          case "ECONNRESET":
          case "ERR_HTTP2_STREAM_ERROR":

            // Retry on connection reset, but no more than once.
            if(!isRetry) {

              return this.retrieve(endpoint, params, true);
            }

            this.log.error("Network connection to the Hydrawise API has been reset.");

            break;

          default:

            this.log.error("Error: %s - %s.", error.code, error.message);

            break;
        }
      }

      return null;
    } finally {

      // Clear out our response timeout if needed.
      signal.clear();
    }
  }

  // Utility for debug logging.
  public debug(message: string, ...parameters: unknown[]): void {

    if(this.config.debug) {

      this.log.error(util.format(message, ...parameters));
    }
  }
}
