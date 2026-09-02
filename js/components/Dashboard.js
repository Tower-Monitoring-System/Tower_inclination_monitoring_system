import { APP_CONFIG } from "../core/config.js";
import { DASHBOARD_ACTION } from "../core/constants.js";
import { AlertPanel } from "./AlertPanel.js?v=20260824.1";

export class Dashboard extends EventTarget {
  constructor(options = {}) {
    super();
    this.document = options.documentRef || document;
    this.window = options.windowRef || window;
    this.abortController = new AbortController();
    this.toastTimer = null;
    this.resizeTimer = null;
    this.revealTimer = null;
    this.activeView = "Towers";
    this.registeredTowerCount = null;
    this.alertPanel = new AlertPanel(this.document);
    this.elements = this.collectElements();

    this.bindEvents();
    this.scheduleReveal();
  }

  collectElements() {
    const byId = (id) => this.document.getElementById(id);
    return {
      appShell: byId("appShell"),
      towersPage: byId("towersPage"),
      listPage: byId("listPage"),
      alertsPage: byId("alertsPage"),
      settingsPage: byId("settingsPage"),
      topbarTitle: byId("topbarTitle"),
      sidebarBackdrop: byId("sidebarBackdrop"),
      menuButton: byId("menuButton"),
      notificationButton: byId("notificationButton"),
      accountButton: byId("accountButton"),
      accountDropdown: byId("accountDropdown"),
      toast: byId("dashboardToast"),
      toastMessage: byId("dashboardToastMessage")
    };
  }

  listen(element, eventName, listener) {
    element?.addEventListener(eventName, listener, { signal: this.abortController.signal });
  }

  bindEvents() {
    this.listen(this.elements.menuButton, "click", () => this.toggleNavigation());
    this.listen(this.elements.sidebarBackdrop, "click", () => this.closeMobileNavigation());

    this.document.querySelectorAll("[data-nav-target]").forEach((item) => {
      this.listen(item, "click", () => {
        const target = item.dataset.navTarget;
        this.closeMobileNavigation();
        this.closeAccountMenu();
        if (["Towers", "List", "Alerts", "System settings"].includes(target)) {
          this.emitAction(DASHBOARD_ACTION.NAVIGATE, { target });
        } else {
          this.showToast(`${target} is prepared for the next integration phase.`, "info");
        }
      });
    });

    this.listen(this.elements.notificationButton, "click", () => {
      const summary = this.alertPanel.getNotificationSummary();
      this.showToast(summary.message, summary.type);
    });
    this.listen(this.elements.accountButton, "click", () => this.toggleAccountMenu());
    this.listen(this.document, "click", (event) => {
      if (!event.target.closest?.(".account-menu-wrap")) {
        this.closeAccountMenu();
      }
    });
    this.listen(this.document, "keydown", (event) => {
      if (event.key === "Escape") {
        this.closeAccountMenu();
        this.closeMobileNavigation();
      }
    });

    this.document.querySelectorAll("[data-action='sign-out']").forEach((button) => {
      this.listen(button, "click", () => this.emitAction(DASHBOARD_ACTION.SIGN_OUT));
    });

    this.listen(this.window, "resize", () => {
      this.window.clearTimeout(this.resizeTimer);
      this.resizeTimer = this.window.setTimeout(() => {
        if (this.window.innerWidth > 1100) {
          this.closeMobileNavigation();
        }
      }, APP_CONFIG.resizeDebounceMs);
    });
  }

  emitAction(action, detail = {}) {
    this.dispatchEvent(new CustomEvent("action", { detail: { action, ...detail } }));
  }

  scheduleReveal() {
    this.revealTimer = this.window.setTimeout(
      () => this.reveal(),
      APP_CONFIG.dashboardRevealTimeoutMs
    );
  }

  reveal() {
    if (this.revealTimer !== null) {
      this.window.clearTimeout(this.revealTimer);
      this.revealTimer = null;
    }
    this.document.body?.classList.remove("dashboard-loading");
  }

  setIdentity(username) {
    const safeUsername = typeof username === "string" && username.trim() ? username.trim() : "Operator";
    const initial = safeUsername.charAt(0).toUpperCase();
    this.document.querySelectorAll("[data-auth-username]").forEach((element) => {
      element.textContent = safeUsername;
    });
    this.document.querySelectorAll("[data-user-initial]").forEach((element) => {
      element.textContent = initial;
    });
  }

  setText(id, value) {
    const element = this.document.getElementById(id);
    if (element) {
      element.textContent = String(value);
    }
  }

  renderSafely(componentName, renderComponent) {
    try {
      renderComponent();
    } catch (error) {
      this.window.console.error(`${componentName} failed to render.`, error);
      this.showToast(
        "Some monitoring details could not be rendered. Other dashboard sections remain available.",
        "error"
      );
    }
  }

  updateTowerRegistry(towers) {
    this.registeredTowerCount = Array.isArray(towers) ? towers.length : 0;
    this.setText("sidebarTowerCount", this.registeredTowerCount);
  }

  updateAlertSummary(summary) {
    this.renderSafely("Alert indicators", () => this.alertPanel.render(summary));
  }

  toggleNavigation() {
    if (!this.elements.appShell || !this.elements.menuButton) {
      return;
    }
    if (this.window.innerWidth <= 1100) {
      const open = this.elements.appShell.classList.toggle("sidebar-open");
      this.elements.menuButton.setAttribute("aria-expanded", open ? "true" : "false");
      this.document.body?.classList.toggle("sidebar-lock", open);
      return;
    }

    const collapsed = this.elements.appShell.classList.toggle("sidebar-collapsed");
    this.elements.menuButton.setAttribute("aria-expanded", collapsed ? "false" : "true");
  }

  setActiveView(view) {
    if (!["Towers", "List", "Alerts", "System settings"].includes(view)) {
      return false;
    }

    this.activeView = view;
    if (this.elements.towersPage) {
      this.elements.towersPage.hidden = view !== "Towers";
    }
    if (this.elements.listPage) {
      this.elements.listPage.hidden = view !== "List";
    }
    if (this.elements.alertsPage) {
      this.elements.alertsPage.hidden = view !== "Alerts";
    }
    if (this.elements.settingsPage) {
      this.elements.settingsPage.hidden = view !== "System settings";
    }
    this.document.querySelectorAll(".sidebar-nav [data-nav-target]").forEach((item) => {
      const active = item.dataset.navTarget === view;
      item.classList.toggle("is-active", active);
      if (active) {
        item.setAttribute("aria-current", "page");
      } else {
        item.removeAttribute("aria-current");
      }
    });

    const pageTitles = {
      Towers: "Tower Monitoring",
      List: "Sensor Data List",
      Alerts: "Alerts Center",
      "System settings": "System Settings"
    };
    const pageTitle = pageTitles[view];
    if (this.elements.topbarTitle) {
      this.elements.topbarTitle.textContent = pageTitle;
    }
    this.document.title = `${pageTitle} | Tower Inclination Monitoring System`;
    this.document.body?.setAttribute("data-active-view", view.toLowerCase());
    return true;
  }

  closeMobileNavigation() {
    this.elements.appShell?.classList.remove("sidebar-open");
    this.elements.menuButton?.setAttribute("aria-expanded", "false");
    this.document.body?.classList.remove("sidebar-lock");
  }

  toggleAccountMenu() {
    if (!this.elements.accountDropdown || !this.elements.accountButton) {
      return;
    }
    const willOpen = this.elements.accountDropdown.hidden;
    this.elements.accountDropdown.hidden = !willOpen;
    this.elements.accountButton.setAttribute("aria-expanded", willOpen ? "true" : "false");
  }

  closeAccountMenu() {
    if (this.elements.accountDropdown) {
      this.elements.accountDropdown.hidden = true;
    }
    this.elements.accountButton?.setAttribute("aria-expanded", "false");
  }

  showToast(message, type = "info") {
    if (!this.elements.toast || !this.elements.toastMessage) {
      return;
    }

    const normalizedType = ["success", "warning", "error"].includes(type) ? type : "info";
    this.window.clearTimeout(this.toastTimer);
    this.elements.toastMessage.textContent = message;
    this.elements.toast.classList.remove("is-success", "is-warning", "is-error");
    if (normalizedType !== "info") {
      this.elements.toast.classList.add(`is-${normalizedType}`);
    }
    this.elements.toast.classList.add("is-visible");
    this.toastTimer = this.window.setTimeout(() => {
      this.elements.toast?.classList.remove("is-visible");
      this.toastTimer = null;
    }, APP_CONFIG.toastDurationMs);
  }

  destroy() {
    this.abortController.abort();
    this.window.clearTimeout(this.toastTimer);
    this.window.clearTimeout(this.resizeTimer);
    this.window.clearTimeout(this.revealTimer);
  }
}
