export class AlertPanel {
  constructor(documentRef = document) {
    this.elements = {
      sidebarAlertCount: documentRef.getElementById("sidebarAlertCount"),
      notificationCount: documentRef.getElementById("notificationCount"),
      notificationButton: documentRef.getElementById("notificationButton"),
      normalTowerCount: documentRef.getElementById("normalTowerCount"),
      warningTowerCount: documentRef.getElementById("warningTowerCount"),
      criticalTowerCount: documentRef.getElementById("criticalTowerCount"),
      offlineRankingCount: documentRef.getElementById("offlineRankingCount")
    };
    this.alerts = [];
    this.statusCounts = { normal: 0, warning: 0, alert: 0, offline: 0 };
  }

  setText(element, value) {
    if (element) {
      element.textContent = String(value);
    }
  }

  render(alerts = [], summary = {}) {
    const safeSummary = summary || {};
    this.alerts = alerts;
    this.statusCounts = safeSummary.statusCounts || this.statusCounts;
    const notificationCount = safeSummary.notificationCount ?? alerts.length;

    this.setText(this.elements.sidebarAlertCount, notificationCount);
    this.setText(this.elements.notificationCount, notificationCount);
    this.setText(this.elements.normalTowerCount, this.statusCounts.normal);
    this.setText(this.elements.warningTowerCount, this.statusCounts.warning);
    this.setText(this.elements.criticalTowerCount, this.statusCounts.alert);
    this.setText(this.elements.offlineRankingCount, this.statusCounts.offline);

    if (this.elements.notificationButton) {
      this.elements.notificationButton.setAttribute(
        "aria-label",
        `View ${notificationCount} active notifications`
      );
    }
  }

  getNotificationSummary() {
    const { alert = 0, warning = 0, offline = 0 } = this.statusCounts;
    const offlineText = offline ? ` ${offline} tower is offline.` : "";
    return {
      message: `${alert} alert and ${warning} warning towers need review.${offlineText}`,
      type: alert || offline ? "warning" : "info"
    };
  }
}
