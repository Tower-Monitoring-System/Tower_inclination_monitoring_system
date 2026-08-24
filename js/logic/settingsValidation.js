import { SETTINGS_LIMITS, mergeSystemSettings } from "../core/settingsDefaults.js";

const IPV4_PATTERN = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/;

export function isValidIpv4(value) {
  const match = String(value || "").trim().match(IPV4_PATTERN);
  return Boolean(match && match.slice(1).every((segment) => Number(segment) <= 255));
}

function validateNumber(errors, path, value, limits, label) {
  const number = Number(value);
  if (!Number.isFinite(number)) {
    errors[path] = `${label} must be a valid number.`;
  } else if (number < limits.minimum || number > limits.maximum) {
    errors[path] = `${label} must be between ${limits.minimum} and ${limits.maximum}.`;
  }
}

export function validateSystemSettings(candidate) {
  const settings = mergeSystemSettings(candidate);
  const errors = {};

  ["x", "y", "z"].forEach((axis) => {
    validateNumber(
      errors,
      `calibration.${axis}`,
      settings.calibration[axis],
      SETTINGS_LIMITS.calibration,
      `Initial ${axis.toUpperCase()} tilt`
    );
    validateNumber(
      errors,
      `tiltThresholds.${axis}`,
      settings.tiltThresholds[axis],
      SETTINGS_LIMITS.tiltThreshold,
      `${axis.toUpperCase()} tilt threshold`
    );
  });
  validateNumber(
    errors,
    "battery.minimumVoltage",
    settings.battery.minimumVoltage,
    SETTINGS_LIMITS.battery,
    "Battery threshold"
  );

  const ssid = String(settings.wifi.ssid || "").trim();
  if (!ssid) {
    errors["wifi.ssid"] = "Wi-Fi SSID is required.";
  } else if (ssid.length > SETTINGS_LIMITS.wifi.ssidMaximumLength) {
    errors["wifi.ssid"] = `Wi-Fi SSID cannot exceed ${SETTINGS_LIMITS.wifi.ssidMaximumLength} characters.`;
  }

  const password = String(settings.wifi.password || "");
  if (
    password.length < SETTINGS_LIMITS.wifi.passwordMinimumLength ||
    password.length > SETTINGS_LIMITS.wifi.passwordMaximumLength
  ) {
    errors["wifi.password"] =
      `Wi-Fi password must contain ${SETTINGS_LIMITS.wifi.passwordMinimumLength}–${SETTINGS_LIMITS.wifi.passwordMaximumLength} characters.`;
  }

  if (!["dhcp", "static"].includes(settings.wifi.ipMode)) {
    errors["wifi.ipMode"] = "Select DHCP or Static IP mode.";
  }
  if (settings.wifi.ipMode === "static") {
    [
      ["wifi.staticIp", settings.wifi.staticIp, "Static IP"],
      ["wifi.gateway", settings.wifi.gateway, "Gateway"],
      ["wifi.subnetMask", settings.wifi.subnetMask, "Subnet mask"]
    ].forEach(([path, value, label]) => {
      if (!isValidIpv4(value)) {
        errors[path] = `${label} must be a valid IPv4 address.`;
      }
    });
  }

  return Object.freeze({
    valid: Object.keys(errors).length === 0,
    errors: Object.freeze(errors),
    settings
  });
}
