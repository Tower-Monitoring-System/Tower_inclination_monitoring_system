import { STATION_STATUS } from "../core/constants.js";

const SAFE_STATUSES = new Set(Object.values(STATION_STATUS));

function createElement(documentRef, tagName, className, textContent) {
  const element = documentRef.createElement(tagName);
  if (className) {
    element.className = className;
  }
  if (textContent !== undefined) {
    element.textContent = textContent;
  }
  return element;
}

export class StationCard {
  constructor(documentRef = document) {
    this.document = documentRef;
    this.rankingBody = documentRef.getElementById("rankingBody");
    this.rankingCount = documentRef.getElementById("rankingCount");
  }

  render(ranking = []) {
    if (this.rankingCount) {
      this.rankingCount.textContent = `${ranking.length} ${ranking.length === 1 ? "tower" : "towers"}`;
    }

    if (!this.rankingBody) {
      return;
    }

    const fragment = this.document.createDocumentFragment();

    ranking.forEach((station, index) => {
      const status = SAFE_STATUSES.has(station.status) ? station.status : STATION_STATUS.NORMAL;
      const row = this.document.createElement("tr");
      const rankCell = this.document.createElement("td");
      const rankClass = status === STATION_STATUS.ALERT
        ? "rank-number rank-alert"
        : status === STATION_STATUS.WARNING
          ? "rank-number rank-warning"
          : "rank-number";
      rankCell.append(createElement(this.document, "span", rankClass, String(index + 1)));

      const towerCellElement = this.document.createElement("td");
      const towerCell = createElement(this.document, "span", "tower-cell");
      towerCell.append(
        createElement(this.document, "strong", "", station.id),
        createElement(
          this.document,
          "span",
          "",
          `${station.location}${station.online ? "" : " · Offline"}`
        )
      );
      towerCellElement.append(towerCell);

      const tiltCellElement = this.document.createElement("td");
      tiltCellElement.append(
        createElement(this.document, "span", "tilt-cell", `${station.maxTilt.toFixed(2)}°`)
      );

      const statusCellElement = this.document.createElement("td");
      statusCellElement.append(
        createElement(this.document, "span", `status-badge ${status}`, status)
      );

      row.append(rankCell, towerCellElement, tiltCellElement, statusCellElement);
      fragment.append(row);
    });

    this.rankingBody.replaceChildren(fragment);
  }
}

