import { SETTINGS_LIMITS, mergeSystemSettings } from "../core/settingsDefaults.js";

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

  return Object.freeze({
    valid: Object.keys(errors).length === 0,
    errors: Object.freeze(errors),
    settings
  });
}
