# Changelog

All notable changes to this project will be documented in this file.

## 2.1.0 (2026-11-07)
  * New feature: your rain sensors in HomeKit and on MQTT. Each one appears as a contact sensor that opens while the sensor is tripped. Sign in with your Hydrawise account to get them.
  * Improvement: switches and valves respond in HomeKit right away, and the plugin paces commands within Hydrawise's limits for you...change several zones at once, or change your mind partway, and Hydrawise ends up where you left things. If a command doesn't go through, the switch goes back and the log tells you why.
  * Improvement: the per-zone suspend switches are no longer limited to 10 changes an hour.
  * Improvement: the enhanced features cope better when Hydrawise is busy, and sign back in on their own.
  * Improvement: even without signing in, the log tells you when a zone looks suspended or stopped by rain.
  * Improvement: Sync Name is now off by default, so a name you give a zone or controller in the Home app stays put. Turn on Sync Name to keep names in step with Hydrawise. If you had Sync Name off before this release and renamed a controller or standalone zone in the Home app, that name may revert once after upgrading...rename it again and it will stick.
  * Improvement: a Name you set always applies...rename that zone or controller in the Home app and your Name is put back right away. The settings page and the log use your Name too.
  * Improvement: accessories show "No Response" in HomeKit while Hydrawise can't be reached, including right after a restart, and recover on their own.
  * Improvement: clearer log messages when Hydrawise can't be reached, with a problem that keeps happening logged once instead of on every poll.
  * Improvement: your MQTT broker sees each controller go offline when Homebridge stops.
  * Improvement: settings page refinements.
  * Fix: a zone you start from HomeKit now runs even when Hydrawise has nothing scheduled for it.
  * Fix: the Suspend All switch now stays in step when you resume watering outside HomeKit, like in the Hydrawise app.
  * Fix: a zone suspension now ends in HomeKit and on the settings page as soon as its end time passes.
  * Fix: a controller's firmware version shows in HomeKit right after Homebridge restarts.
  * Fix: a zone or controller named only with emoji or punctuation now appears in HomeKit, as "Controller" or "Zone 3", until you set a Name.
  * Housekeeping.

## 2.0.0 (2026-08-15)
  * Breaking change: Homebridge 2.0 or later and Node.js 22.20 or later are now required.
  * New feature: sign in with your Hydrawise account to unlock enhanced features - accurate rain and suspension state for every zone, a suspend switch for each individual zone, the full zone and controller names your account carries, whether each controller is reachable, and each controller's real model and firmware.
  * New feature: standalone zone valve accessories through scoped feature options.
  * New feature: user-defined zone names with HomeKit name synchronization.
  * New feature: zone and controller schedule status at a glance in the webUI.
  * Improvement: a modernized first-run experience and configuration webUI that follows the Homebridge theme faithfully, in light and dark.
  * Improvement: webUI refinements - the refresh control docks on the controller list heading and the Support tab reads with one consistent layout.
  * Improvement: zone and controller names adopt your account's full names once, and renames hold across restarts.
  * Improvement: suspension commands reflect immediately in HomeKit, the webUI, and MQTT.
  * Improvement: conservative built-in pacing for every Hydrawise API call, with per-zone suspension commands on their own hourly budget.
  * Improvement: feature options are now the single configuration surface - existing settings migrate automatically.
  * Housekeeping.

## 1.2.5 (2025-11-24)
  * Housekeeping.

## 1.2.4 (2025-09-02)
  * Housekeeping.

## 1.2.3 (2025-08-09)
  * Housekeeping.

## 1.2.2 (2025-08-08)
  * Improvement: webUI updates.
  * Housekeeping.

## 1.2.1 (2025-07-12)
  * Housekeeping.

## 1.2.0 (2025-07-06)
  * New feature: resume a schedule.
  * Housekeeping.

## 1.1.2 (2024-07-22)
  * Housekeeping.

## 1.1.1 (2024-06-06)
  * Housekeeping.

## 1.1.0 (2024-06-01)
  * Improved: webUI updates.
  * Housekeeping.

## 1.0.2 (2024-05-20)
  * Housekeeping.

## 1.0.1 (2024-05-20)
  * Housekeeping.

## 1.0.0 (2024-05-20)
  * Initial release.
