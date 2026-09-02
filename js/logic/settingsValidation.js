import { SETTINGS_LIMITS, mergeSystemSettings } from "../core/settingsDefaults.js?v=20260902.1";

function validateNumber(errors, path, value, limits, label) {
  const number = Number(value);
  if (!Number.isFinite(number)) {
    errors[path] = `${label} must be a valid number.`;
  } else if (number < limits.minimum || number > limits.maximum) {
    errors[path] = `${label} must be between ${limits.minimum} and ${limits.maximum}.`;
  } else if (Number.isFinite(limits.step)) {
    const stepOffset = (number - limits.minimum) / limits.step;
    if (Math.abs(stepOffset - Math.round(stepOffset)) > 1e-8) {
      errors[path] = `${label} must use increments of ${limits.step}.`;
    }
  }
}

export function validateSystemSettings(candidate) {
  const settings = mergeSystemSettings(candidate);
  const errors = {};
  const candidateBattery = candidate?.battery;
  const minimumVoltage = candidateBattery &&
    typeof candidateBattery === "object" &&
    Object.prototype.hasOwnProperty.call(candidateBattery, "minimumVoltage")
    ? candidateBattery.minimumVoltage
    : settings.battery.minimumVoltage;

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
    minimumVoltage,
    SETTINGS_LIMITS.battery,
    "Battery threshold"
  );

  return Object.freeze({
    valid: Object.keys(errors).length === 0,
    errors: Object.freeze(errors),
    settings
  });
}
