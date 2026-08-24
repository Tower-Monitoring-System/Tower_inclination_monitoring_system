import { SETTINGS_LIMITS, mergeSystemSettings } from "../core/settingsDefaults.js";

function setNestedValue(target, path, value) {
  const [group, field] = path.split(".");
  if (target[group] && field) {
    target[group][field] = value;
  }
}

function statusLabel(value) {
  return String(value || "unavailable")
    .replace(/-/g, " ")
    .replace(/^./, (character) => character.toUpperCase());
}

function formatTilt(value) {
  return Number.isFinite(Number(value)) ? Number(value).toFixed(2) : "—";
}

const ADDED_AT_FORMAT = new Intl.DateTimeFormat("en-GB", {
  day: "2-digit",
  month: "2-digit",
  year: "numeric",
  hour: "2-digit",
  minute: "2-digit",
  hourCycle: "h23"
});

function createActionButton(documentRef, action, towerId, label, iconId) {
  const button = documentRef.createElement("button");
  button.type = "button";
  button.dataset.towerAction = action;
  button.dataset.towerId = towerId;
  button.setAttribute("aria-label", `${label} ${towerId}`);
  button.title = label;
  const svg = documentRef.createElementNS("http://www.w3.org/2000/svg", "svg");
  svg.setAttribute("aria-hidden", "true");
  const use = documentRef.createElementNS("http://www.w3.org/2000/svg", "use");
  use.setAttribute("href", iconId);
  svg.append(use);
  button.append(svg);
  return button;
}

export class SettingsPage {
  constructor(settingsService, options = {}) {
    this.service = settingsService;
    this.document = options.documentRef || document;
    this.window = options.windowRef || window;
    this.towerRegistry = options.towerRegistryService || null;
    this.onToast = typeof options.onToast === "function" ? options.onToast : () => {};
    this.onSaved = typeof options.onSaved === "function" ? options.onSaved : async () => {};
    this.abortController = new AbortController();
    this.active = false;
    this.busyAction = null;
    this.currentTilt = null;
    this.towerRegistryState = this.towerRegistry?.getState() || { towers: [], initialized: true, error: null };
    this.towerDraft = { id: "", name: "", location: "" };
    this.towerValidationErrors = {};
    this.editingTowerId = "";
    this.pendingDeleteTowerId = "";
    this.savedSettings = mergeSystemSettings(this.service.getSettings());
    this.draft = mergeSystemSettings(this.savedSettings);
    this.validation = this.service.validate(this.draft);
    this.elements = this.collectElements();

    this.applyInputLimits();
    this.bindEvents();
    this.unsubscribe = this.service.subscribe((state) => this.handleServiceState(state), { immediate: false });
    this.unsubscribeTowerRegistry = this.towerRegistry?.subscribe(
      (state) => this.handleTowerRegistryState(state),
      { immediate: false }
    );
    this.render();
  }

  collectElements() {
    const byId = (id) => this.document.getElementById(id);
    return {
      page: byId("settingsPage"),
      form: byId("systemSettingsForm"),
      readButton: byId("settingsReadValues"),
      calibrateButton: byId("settingsCalibrate"),
      resetButton: byId("settingsReset"),
      currentValues: byId("settingsCurrentValues"),
      batteryRange: byId("settingsBatteryRange"),
      ipMode: byId("settingsIpMode"),
      staticFields: byId("settingsStaticFields"),
      autoReconnect: byId("settingsAutoReconnect"),
      apStatus: byId("settingsApStatus"),
      apSsid: byId("settingsApSsid"),
      apPassword: byId("settingsApPassword"),
      wifiStatus: byId("settingsWifiStatus"),
      connectApButton: byId("settingsConnectAp"),
      testButton: byId("settingsTestConnection"),
      cancelButton: byId("settingsCancel"),
      applyButton: byId("settingsApply"),
      resetConfirm: byId("settingsResetConfirm"),
      resetConfirmCancel: byId("settingsResetConfirmCancel"),
      resetConfirmAccept: byId("settingsResetConfirmAccept"),
      towerId: byId("towerManagementId"),
      towerName: byId("towerManagementName"),
      towerLocation: byId("towerManagementLocation"),
      towerSave: byId("towerManagementSave"),
      towerCancel: byId("towerManagementCancel"),
      towerTableBody: byId("towerManagementTableBody"),
      towerCount: byId("towerManagementCount"),
      towerServiceError: byId("towerManagementServiceError"),
      towerDeleteConfirm: byId("towerDeleteConfirm"),
      towerDeleteDescription: byId("towerDeleteConfirmDescription"),
      towerDeleteCancel: byId("towerDeleteConfirmCancel"),
      towerDeleteAccept: byId("towerDeleteConfirmAccept"),
      loadingOverlay: byId("settingsLoadingOverlay"),
      liveStatus: byId("settingsLiveStatus")
    };
  }

  listen(element, eventName, callback) {
    element?.addEventListener(eventName, callback, { signal: this.abortController.signal });
  }

  applyInputLimits() {
    this.document.querySelectorAll("[data-setting-group='calibration']").forEach((input) => {
      input.min = String(SETTINGS_LIMITS.calibration.minimum);
      input.max = String(SETTINGS_LIMITS.calibration.maximum);
    });
    this.document.querySelectorAll("[data-setting-group='tiltThresholds']").forEach((input) => {
      input.min = String(SETTINGS_LIMITS.tiltThreshold.minimum);
      input.max = String(SETTINGS_LIMITS.tiltThreshold.maximum);
    });
    this.document.querySelectorAll("[data-setting-path='battery.minimumVoltage']").forEach((input) => {
      input.min = String(SETTINGS_LIMITS.battery.minimum);
      input.max = String(SETTINGS_LIMITS.battery.maximum);
      input.step = String(SETTINGS_LIMITS.battery.step);
    });
  }

  bindEvents() {
    this.listen(this.elements.form, "submit", (event) => event.preventDefault());
    this.document.querySelectorAll("[data-setting-path]").forEach((input) => {
      const eventName = input.type === "checkbox" || input.tagName === "SELECT" ? "change" : "input";
      this.listen(input, eventName, () => this.handleSettingInput(input));
    });
    this.document.querySelectorAll("[data-password-toggle]").forEach((button) => {
      this.listen(button, "click", () => this.togglePassword(button));
    });
    this.listen(this.elements.readButton, "click", () => this.readCurrentValues());
    this.listen(this.elements.calibrateButton, "click", () => this.calibrate());
    this.listen(this.elements.resetButton, "click", () => this.openResetConfirmation());
    this.listen(this.elements.resetConfirmCancel, "click", () => this.closeResetConfirmation());
    this.listen(this.elements.resetConfirmAccept, "click", () => this.confirmReset());
    this.listen(this.elements.resetConfirm, "click", (event) => {
      if (event.target === this.elements.resetConfirm) {
        this.closeResetConfirmation();
      }
    });
    this.listen(this.elements.cancelButton, "click", () => this.cancelChanges());
    this.listen(this.elements.applyButton, "click", () => this.applyChanges());
    this.listen(this.elements.testButton, "click", () => this.testConnection());
    this.listen(this.elements.connectApButton, "click", () => this.connectAccessPoint());
    [this.elements.towerId, this.elements.towerName, this.elements.towerLocation].forEach((input) => {
      this.listen(input, "input", () => this.handleTowerInput(input));
      this.listen(input, "keydown", (event) => {
        if (event.key === "Enter") {
          event.preventDefault();
          this.saveTower();
        }
      });
    });
    this.listen(this.elements.towerSave, "click", () => this.saveTower());
    this.listen(this.elements.towerCancel, "click", () => this.cancelTowerEdit());
    this.listen(this.elements.towerTableBody, "click", (event) => {
      const button = event.target.closest?.("[data-tower-action]");
      if (!button) {
        return;
      }
      if (button.dataset.towerAction === "edit") {
        this.editTower(button.dataset.towerId);
      } else if (button.dataset.towerAction === "delete") {
        this.openTowerDeleteConfirmation(button.dataset.towerId);
      }
    });
    this.listen(this.elements.towerDeleteCancel, "click", () => this.closeTowerDeleteConfirmation());
    this.listen(this.elements.towerDeleteAccept, "click", () => this.confirmTowerDelete());
    this.listen(this.elements.towerDeleteConfirm, "click", (event) => {
      if (event.target === this.elements.towerDeleteConfirm) {
        this.closeTowerDeleteConfirmation();
      }
    });
    this.listen(this.document, "keydown", (event) => {
      if (event.key === "Escape") {
        if (!this.elements.towerDeleteConfirm.hidden) {
          this.closeTowerDeleteConfirmation();
        } else if (!this.elements.resetConfirm.hidden) {
          this.closeResetConfirmation();
        }
      }
    });
  }

  handleTowerRegistryState(state) {
    this.towerRegistryState = state;
    if (this.editingTowerId && !this.towerRegistry?.find(this.editingTowerId)) {
      this.resetTowerDraft();
    }
    this.renderTowerManagement();
  }

  handleTowerInput(input) {
    const fieldById = {
      towerManagementId: "id",
      towerManagementName: "name",
      towerManagementLocation: "location"
    };
    const field = fieldById[input.id];
    if (!field) {
      return;
    }
    this.towerDraft[field] = input.value;
    delete this.towerValidationErrors[field];
    this.renderTowerValidation();
  }

  saveTower() {
    if (!this.towerRegistry || this.busyAction) {
      return;
    }
    const validation = this.towerRegistry.validate(this.towerDraft, {
      excludeId: this.editingTowerId || undefined
    });
    this.towerValidationErrors = { ...validation.errors };
    this.renderTowerValidation();
    if (!validation.valid) {
      const firstField = Object.keys(validation.errors)[0];
      ({ id: this.elements.towerId, name: this.elements.towerName, location: this.elements.towerLocation })[firstField]?.focus();
      this.onToast("Review the highlighted tower details.", "error");
      return;
    }

    try {
      const editing = Boolean(this.editingTowerId);
      const tower = editing
        ? this.towerRegistry.update(this.editingTowerId, validation.tower)
        : this.towerRegistry.add(validation.tower);
      this.resetTowerDraft();
      this.announce(`${tower.id} ${editing ? "updated" : "added"} successfully.`);
      this.onToast(`Tower ${tower.id} ${editing ? "updated" : "added"} successfully.`, "info");
      this.elements.towerId.focus();
    } catch (error) {
      if (error?.errors) {
        this.towerValidationErrors = { ...error.errors };
        this.renderTowerValidation();
      }
      this.window.console.error("Tower changes could not be saved.", error);
      this.onToast(error?.message || "Tower changes could not be saved.", "error");
    }
  }

  editTower(towerId) {
    const tower = this.towerRegistry?.find(towerId);
    if (!tower || this.busyAction) {
      return;
    }
    this.editingTowerId = tower.id;
    this.towerDraft = { id: tower.id, name: tower.name, location: tower.location };
    this.towerValidationErrors = {};
    this.renderTowerManagement();
    this.elements.towerId.focus();
  }

  cancelTowerEdit() {
    this.resetTowerDraft();
    this.elements.towerId.focus();
  }

  resetTowerDraft() {
    this.editingTowerId = "";
    this.towerDraft = { id: "", name: "", location: "" };
    this.towerValidationErrors = {};
    this.renderTowerManagement();
  }

  openTowerDeleteConfirmation(towerId) {
    const tower = this.towerRegistry?.find(towerId);
    if (!tower || this.busyAction) {
      return;
    }
    this.pendingDeleteTowerId = tower.id;
    this.elements.towerDeleteDescription.textContent = `${tower.id} will be removed from this dashboard. Its Google Sheet and sensor data will not be deleted.`;
    this.elements.towerDeleteConfirm.hidden = false;
    this.elements.towerDeleteAccept.focus();
  }

  closeTowerDeleteConfirmation() {
    this.pendingDeleteTowerId = "";
    this.elements.towerDeleteConfirm.hidden = true;
  }

  confirmTowerDelete() {
    const towerId = this.pendingDeleteTowerId;
    if (!towerId || !this.towerRegistry) {
      return;
    }
    try {
      const removed = this.towerRegistry.remove(towerId);
      this.closeTowerDeleteConfirmation();
      if (removed) {
        if (this.editingTowerId === removed.id) {
          this.resetTowerDraft();
        }
        this.announce(`${removed.id} was removed from the dashboard.`);
        this.onToast(`Tower ${removed.id} removed. Google Sheet data was not deleted.`, "warning");
      }
    } catch (error) {
      this.window.console.error("The tower could not be removed.", error);
      this.closeTowerDeleteConfirmation();
      this.onToast(error?.message || "The tower could not be removed.", "error");
    }
  }

  handleServiceState(state) {
    if (!this.isDirty() && state.settings) {
      this.savedSettings = mergeSystemSettings(state.settings);
      this.draft = mergeSystemSettings(state.settings);
      this.validation = this.service.validate(this.draft);
      this.render();
    }
  }

  open() {
    this.active = true;
    if (!this.isDirty()) {
      this.savedSettings = mergeSystemSettings(this.service.getSettings());
      this.draft = mergeSystemSettings(this.savedSettings);
    }
    this.validation = this.service.validate(this.draft);
    this.render();
  }

  close() {
    this.active = false;
    this.closeResetConfirmation();
    this.closeTowerDeleteConfirmation();
  }

  handleSettingInput(input) {
    const path = input.dataset.settingPath;
    let value;
    if (input.type === "checkbox") {
      value = input.checked;
    } else if (input.type === "number" || input.type === "range") {
      value = input.value === "" ? Number.NaN : Number(input.value);
    } else {
      value = input.value;
    }
    setNestedValue(this.draft, path, value);
    this.validation = this.service.validate(this.draft);
    this.syncLinkedControls(path, input);
    this.renderValidation();
    this.renderNetworkState();
    this.renderActionState();
  }

  renderTowerManagement() {
    if (!this.elements.towerTableBody) {
      return;
    }
    this.elements.towerId.value = this.towerDraft.id;
    this.elements.towerName.value = this.towerDraft.name;
    this.elements.towerLocation.value = this.towerDraft.location;
    this.elements.towerCancel.hidden = !this.editingTowerId;
    const saveLabel = this.elements.towerSave.querySelector("span");
    if (saveLabel) {
      saveLabel.textContent = this.editingTowerId ? "Save Tower" : "Add Tower";
    }
    const towers = this.towerRegistryState.towers || [];
    this.elements.towerCount.textContent = `${towers.length} ${towers.length === 1 ? "tower" : "towers"}`;
    const fragment = this.document.createDocumentFragment();
    if (towers.length === 0) {
      const row = this.document.createElement("tr");
      row.className = "tower-management-empty-row";
      const cell = this.document.createElement("td");
      cell.colSpan = 5;
      cell.textContent = "No towers have been added yet.";
      row.append(cell);
      fragment.append(row);
    } else {
      towers.forEach((tower) => {
        const row = this.document.createElement("tr");
        [tower.id, tower.name, tower.location, ADDED_AT_FORMAT.format(new Date(tower.addedAt))].forEach((value) => {
          const cell = this.document.createElement("td");
          cell.textContent = value;
          row.append(cell);
        });
        const actionsCell = this.document.createElement("td");
        const actions = this.document.createElement("div");
        actions.className = "tower-management-actions";
        actions.append(
          createActionButton(this.document, "edit", tower.id, "Edit", "#icon-edit"),
          createActionButton(this.document, "delete", tower.id, "Delete", "#icon-trash")
        );
        actionsCell.append(actions);
        row.append(actionsCell);
        fragment.append(row);
      });
    }
    this.elements.towerTableBody.replaceChildren(fragment);
    const serviceError = this.towerRegistryState.error || "";
    this.elements.towerServiceError.textContent = serviceError;
    this.elements.towerServiceError.hidden = !serviceError;
    this.renderTowerValidation();
    this.renderTowerActionState();
  }

  renderTowerValidation() {
    const inputs = {
      id: this.elements.towerId,
      name: this.elements.towerName,
      location: this.elements.towerLocation
    };
    Object.entries(inputs).forEach(([field, input]) => {
      const message = this.towerValidationErrors[field] || "";
      input?.setAttribute("aria-invalid", message ? "true" : "false");
      const errorElement = this.document.querySelector(`[data-tower-error='${field}']`);
      if (errorElement) {
        errorElement.textContent = message;
        errorElement.hidden = !message;
      }
    });
  }

  renderTowerActionState() {
    const disabled = Boolean(this.busyAction || !this.towerRegistryState.initialized);
    [this.elements.towerId, this.elements.towerName, this.elements.towerLocation, this.elements.towerSave, this.elements.towerCancel]
      .forEach((control) => {
        if (control) {
          control.disabled = disabled;
        }
      });
    this.elements.towerTableBody?.querySelectorAll("button").forEach((button) => {
      button.disabled = disabled;
    });
  }

  syncLinkedControls(path, sourceInput) {
    if (path !== "battery.minimumVoltage") {
      return;
    }
    this.document.querySelectorAll("[data-setting-path='battery.minimumVoltage']").forEach((input) => {
      if (input !== sourceInput) {
        input.value = sourceInput.value;
      }
    });
  }

  togglePassword(button) {
    const input = this.document.getElementById(button.dataset.passwordToggle);
    if (!input) {
      return;
    }
    const reveal = input.type === "password";
    input.type = reveal ? "text" : "password";
    button.setAttribute("aria-pressed", reveal ? "true" : "false");
    button.setAttribute("aria-label", reveal ? "Hide password" : "Show password");
  }

  async runAction(action, callback) {
    if (this.busyAction) {
      return null;
    }
    this.busyAction = action;
    this.renderActionState();
    try {
      return await callback();
    } finally {
      this.busyAction = null;
      this.renderActionState();
    }
  }

  async readCurrentValues() {
    await this.runAction("read", async () => {
      try {
        this.currentTilt = await this.service.readCurrentTilt();
        this.renderCurrentValues();
        this.announce("Current MPU6050 values were read successfully.");
        this.onToast("Current MPU6050 values loaded.", "info");
      } catch (error) {
        this.window.console.error("Current MPU6050 values could not be read.", error);
        this.onToast("Current MPU6050 values could not be read.", "error");
      }
    });
  }

  async calibrate() {
    await this.runAction("calibrate", async () => {
      try {
        this.currentTilt = await this.service.readCurrentTilt();
        this.draft.calibration = { ...this.currentTilt };
        this.validation = this.service.validate(this.draft);
        this.render();
        this.announce("Current MPU6050 values are ready to be applied as calibration references.");
        this.onToast("Calibration references updated. Select Apply to save them.", "info");
      } catch (error) {
        this.window.console.error("MPU6050 calibration failed.", error);
        this.onToast("MPU6050 calibration values could not be prepared.", "error");
      }
    });
  }

  openResetConfirmation() {
    this.elements.resetConfirm.hidden = false;
    this.elements.resetConfirmAccept.focus();
  }

  closeResetConfirmation() {
    this.elements.resetConfirm.hidden = true;
  }

  confirmReset() {
    this.draft.calibration = this.service.resetCalibration();
    this.validation = this.service.validate(this.draft);
    this.closeResetConfirmation();
    this.render();
    this.onToast("Calibration references reset. Select Apply to save them.", "warning");
  }

  cancelChanges() {
    if (this.busyAction || !this.isDirty()) {
      return;
    }
    this.draft = mergeSystemSettings(this.savedSettings);
    this.validation = this.service.validate(this.draft);
    this.currentTilt = null;
    this.render();
    this.onToast("Unsaved system settings were discarded.", "info");
  }

  async applyChanges() {
    this.validation = this.service.validate(this.draft);
    this.renderValidation();
    if (!this.validation.valid) {
      this.focusFirstError();
      this.onToast("Review the highlighted settings before applying changes.", "error");
      return;
    }

    await this.runAction("apply", async () => {
      try {
        const saved = await this.service.save(this.draft);
        this.savedSettings = mergeSystemSettings(saved);
        this.draft = mergeSystemSettings(saved);
        this.validation = this.service.validate(this.draft);
        await this.onSaved(saved);
        this.render();
        this.announce("System settings applied successfully.");
        this.onToast("System settings applied successfully.", "info");
      } catch (error) {
        if (error?.errors) {
          this.validation = { valid: false, errors: error.errors, settings: this.draft };
          this.renderValidation();
          this.focusFirstError();
        }
        this.window.console.error("System settings could not be applied.", error);
        this.onToast("System settings could not be applied.", "error");
      }
    });
  }

  async testConnection() {
    this.validation = this.service.validate(this.draft);
    this.renderValidation();
    const wifiError = Object.keys(this.validation.errors).some((path) => path.startsWith("wifi."));
    if (wifiError) {
      this.focusFirstError("wifi.");
      this.onToast("Review the Wi-Fi settings before testing the connection.", "error");
      return;
    }

    await this.runAction("test", async () => {
      try {
        const result = await this.service.testConnection(this.draft.wifi);
        this.draft.wifi.connectionStatus = result.connected ? "connected" : "disconnected";
        this.renderNetworkState();
        this.onToast(result.message, result.connected ? "info" : "error");
      } catch (error) {
        this.window.console.error("Wi-Fi connection test failed.", error);
        this.onToast("Wi-Fi connection test failed.", "error");
      }
    });
  }

  async connectAccessPoint() {
    await this.runAction("connect-ap", async () => {
      try {
        const result = await this.service.connectAccessPoint();
        this.draft.accessPoint.connectionStatus = result.connected ? "connected" : "disconnected";
        this.renderNetworkState();
        this.onToast(result.message, result.connected ? "info" : "error");
      } catch (error) {
        this.window.console.error("ESP32 access point connection failed.", error);
        this.onToast("ESP32 access point connection failed.", "error");
      }
    });
  }

  focusFirstError(prefix = "") {
    const firstPath = Object.keys(this.validation.errors).find((path) => path.startsWith(prefix));
    this.document.querySelector(`[data-setting-path='${firstPath}']`)?.focus();
  }

  isDirty() {
    return JSON.stringify(this.draft) !== JSON.stringify(this.savedSettings);
  }

  render() {
    this.document.querySelectorAll("[data-setting-path]").forEach((input) => {
      const [group, field] = input.dataset.settingPath.split(".");
      const value = this.draft[group]?.[field];
      if (input.type === "checkbox") {
        input.checked = Boolean(value);
      } else if (input.type === "number" || input.type === "range") {
        input.value = Number.isFinite(Number(value)) ? String(value) : "";
      } else {
        input.value = value ?? "";
      }
    });
    this.renderCurrentValues();
    this.renderValidation();
    this.renderNetworkState();
    this.renderActionState();
    this.renderTowerManagement();
  }

  renderCurrentValues() {
    if (!this.elements.currentValues) {
      return;
    }
    this.elements.currentValues.textContent = this.currentTilt
      ? `Current sensor · X ${formatTilt(this.currentTilt.x)}° · Y ${formatTilt(this.currentTilt.y)}° · Z ${formatTilt(this.currentTilt.z)}°`
      : "Read the live sensor before applying a new calibration reference.";
  }

  renderValidation() {
    this.document.querySelectorAll("[data-setting-path]").forEach((input) => {
      const message = this.validation.errors[input.dataset.settingPath] || "";
      input.setAttribute("aria-invalid", message ? "true" : "false");
    });
    this.document.querySelectorAll("[data-settings-error]").forEach((element) => {
      const message = this.validation.errors[element.dataset.settingsError] || "";
      element.textContent = message;
      element.hidden = !message;
    });
  }

  renderNetworkState() {
    const staticMode = this.draft.wifi.ipMode === "static";
    this.elements.staticFields.classList.toggle("is-disabled", !staticMode);
    this.elements.staticFields.querySelectorAll("input").forEach((input) => {
      input.disabled = Boolean(this.busyAction) || !staticMode;
    });
    this.elements.apStatus.textContent = statusLabel(this.draft.accessPoint.status);
    this.elements.apStatus.dataset.status = this.draft.accessPoint.status;
    this.elements.apSsid.value = this.draft.accessPoint.ssid || "Unavailable";
    this.elements.apPassword.value = this.draft.accessPoint.password || "";
    this.elements.wifiStatus.textContent = statusLabel(this.draft.wifi.connectionStatus);
    this.elements.wifiStatus.dataset.status = this.draft.wifi.connectionStatus;
    this.elements.connectApButton.textContent = this.draft.accessPoint.connectionStatus === "connected"
      ? "AP connected"
      : "Connect AP";
  }

  renderActionState() {
    const busy = Boolean(this.busyAction);
    this.elements.page?.classList.toggle("is-busy", busy);
    this.elements.loadingOverlay.hidden = !busy;
    this.elements.form.querySelectorAll("button, input, select").forEach((control) => {
      if (control.closest(".settings-confirm-dialog") || control.closest("[data-tower-management]")) {
        return;
      }
      const staticField = control.closest("#settingsStaticFields");
      control.disabled = busy || Boolean(staticField && this.draft.wifi.ipMode !== "static");
    });
    this.renderNetworkState();
    this.elements.cancelButton.disabled = busy || !this.isDirty();
    this.elements.applyButton.disabled = busy || !this.isDirty() || !this.validation.valid;
    const applyLabel = this.elements.applyButton.querySelector("span");
    if (applyLabel) {
      applyLabel.textContent = this.busyAction === "apply" ? "Applying…" : "Apply";
    }
    this.renderTowerActionState();
  }

  announce(message) {
    this.elements.liveStatus.textContent = "";
    this.window.setTimeout(() => {
      if (this.elements.liveStatus) {
        this.elements.liveStatus.textContent = message;
      }
    }, 0);
  }

  destroy() {
    this.close();
    this.abortController.abort();
    this.unsubscribe?.();
    this.unsubscribeTowerRegistry?.();
  }
}
