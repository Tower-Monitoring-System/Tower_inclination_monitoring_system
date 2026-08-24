export class AlertPanel {
  constructor(documentRef = document) {
    this.elements = {
      sidebarAlertCount: documentRef.getElementById("sidebarAlertCount"),
      notificationCount: documentRef.getElementById("notificationCount"),
      notificationButton: documentRef.getElementById("notificationButton")
    };
    this.activeCounts = { battery: 0, inclination: 0, total: 0 };
    this.render();
  }

  normalizeCount(value) {
    const count = Number(value);
    return Number.isFinite(count) && count > 0 ? Math.floor(count) : 0;
  }

  updateBadge(element, count) {
    if (!element) {
      return;
    }
    element.textContent = String(count);
    element.hidden = count === 0;
  }

  render(summary = {}) {
    const battery = this.normalizeCount(summary?.battery);
    const inclination = this.normalizeCount(summary?.inclination);
    const total = battery + inclination;
    this.activeCounts = { battery, inclination, total };

    this.updateBadge(this.elements.sidebarAlertCount, total);
    this.updateBadge(this.elements.notificationCount, total);

    if (this.elements.notificationButton) {
      this.elements.notificationButton.setAttribute(
        "aria-label",
        total === 0
          ? "No active notifications"
          : `View ${total} active notification${total === 1 ? "" : "s"}`
      );
    }
  }

  getNotificationSummary() {
    const { battery, inclination, total } = this.activeCounts;
    const categories = [];
    if (battery > 0) {
      categories.push(`${battery} battery`);
    }
    if (inclination > 0) {
      categories.push(`${inclination} inclination`);
    }
    return {
      message: total === 0
        ? "No active battery or inclination alerts."
        : `${categories.join(" and ")} active alert${total === 1 ? "" : "s"} need review.`,
      type: total > 0 ? "warning" : "info"
    };
  }
}
