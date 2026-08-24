const SHEET_NAME_INVALID_CHARACTERS = /[:\\/?*\[\]]/;
const TOWER_ID_MAXIMUM_LENGTH = 100;
const TOWER_TEXT_MAXIMUM_LENGTH = 120;

function normalizeText(value) {
  return typeof value === "string" ? value.trim() : "";
}

export function towerIdentity(value) {
  return normalizeText(value).toLocaleLowerCase("en-US");
}

export function normalizeTowerCandidate(candidate = {}) {
  return Object.freeze({
    id: normalizeText(candidate.id),
    name: normalizeText(candidate.name),
    location: normalizeText(candidate.location)
  });
}

export function validateTowerCandidate(candidate, existingTowers = [], options = {}) {
  const tower = normalizeTowerCandidate(candidate);
  const errors = {};
  const excludedIdentity = towerIdentity(options.excludeId);

  if (!tower.id) {
    errors.id = "Tower ID is required.";
  } else if (tower.id.length > TOWER_ID_MAXIMUM_LENGTH) {
    errors.id = `Tower ID must be ${TOWER_ID_MAXIMUM_LENGTH} characters or fewer.`;
  } else if (SHEET_NAME_INVALID_CHARACTERS.test(tower.id)) {
    errors.id = "Tower ID cannot contain : \\ / ? * [ or ].";
  } else if (tower.id.startsWith("'") || tower.id.endsWith("'")) {
    errors.id = "Tower ID cannot start or end with an apostrophe.";
  } else {
    const duplicate = existingTowers.some((existingTower) => {
      const existingIdentity = towerIdentity(existingTower?.id);
      return existingIdentity === towerIdentity(tower.id) && existingIdentity !== excludedIdentity;
    });
    if (duplicate) {
      errors.id = `Tower ${tower.id} already exists.`;
    }
  }

  if (!tower.name) {
    errors.name = "Tower name is required.";
  } else if (tower.name.length > TOWER_TEXT_MAXIMUM_LENGTH) {
    errors.name = `Tower name must be ${TOWER_TEXT_MAXIMUM_LENGTH} characters or fewer.`;
  }

  if (!tower.location) {
    errors.location = "Location is required.";
  } else if (tower.location.length > TOWER_TEXT_MAXIMUM_LENGTH) {
    errors.location = `Location must be ${TOWER_TEXT_MAXIMUM_LENGTH} characters or fewer.`;
  }

  return Object.freeze({
    valid: Object.keys(errors).length === 0,
    tower,
    errors: Object.freeze(errors)
  });
}

export function normalizeStoredTower(candidate, existingTowers = []) {
  const validation = validateTowerCandidate(candidate, existingTowers);
  if (!validation.valid) {
    return null;
  }
  const addedAt = new Date(candidate?.addedAt);
  if (!Number.isFinite(addedAt.getTime())) {
    return null;
  }
  return Object.freeze({ ...validation.tower, addedAt: addedAt.toISOString() });
}
