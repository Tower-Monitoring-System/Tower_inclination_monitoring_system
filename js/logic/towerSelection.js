export const NO_TOWERS_MESSAGE =
  "No towers added – Add a tower in System Settings to view sensor data.";

export function resolveSelectedTowerId(towers, currentTowerId = "") {
  if (!Array.isArray(towers) || towers.length === 0) {
    return "";
  }
  return towers.some((tower) => tower.id === currentTowerId)
    ? currentTowerId
    : towers[0].id;
}

export function renderTowerSelect(documentRef, select, towers, selectedTowerId) {
  if (!select) {
    return;
  }

  const safeTowers = Array.isArray(towers) ? towers : [];
  const fragment = documentRef.createDocumentFragment();
  if (safeTowers.length === 0) {
    const option = documentRef.createElement("option");
    option.value = "";
    option.textContent = "No towers added";
    fragment.append(option);
  } else {
    safeTowers.forEach((tower) => {
      const option = documentRef.createElement("option");
      option.value = tower.id;
      option.textContent = `${tower.id} — ${tower.name}`;
      fragment.append(option);
    });
  }

  select.replaceChildren(fragment);
  select.value = selectedTowerId;
  select.disabled = safeTowers.length === 0;
}
