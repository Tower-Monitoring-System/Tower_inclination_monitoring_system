import { createStore } from "../core/store.js";
import {
  normalizeStoredTower,
  towerIdentity,
  validateTowerCandidate
} from "../logic/towerRegistryValidation.js";
import { TowerRegistryRepository } from "./towerRegistryRepository.js";

export class TowerRegistryValidationError extends Error {
  constructor(errors) {
    super("Tower details contain invalid values.");
    this.name = "TowerRegistryValidationError";
    this.errors = errors;
  }
}

function sortTowers(towers) {
  return towers.slice().sort((left, right) => (
    left.addedAt.localeCompare(right.addedAt) || left.id.localeCompare(right.id)
  ));
}

export class TowerRegistryService {
  constructor(options = {}) {
    this.repository = options.repository || new TowerRegistryRepository(options.windowRef);
    this.store = createStore({ towers: [], initialized: false, error: null });
  }

  getState() {
    return this.store.getState();
  }

  getTowers() {
    return this.store.getState().towers;
  }

  subscribe(callback, options) {
    return this.store.subscribe(callback, options);
  }

  initialize() {
    const towers = [];
    this.repository.load().forEach((candidate) => {
      const tower = normalizeStoredTower(candidate, towers);
      if (tower) {
        towers.push(tower);
      }
    });
    const sortedTowers = sortTowers(towers);
    this.store.setState({ towers: sortedTowers, initialized: true, error: null });
    return sortedTowers;
  }

  validate(candidate, options = {}) {
    return validateTowerCandidate(candidate, this.getTowers(), options);
  }

  add(candidate) {
    const validation = this.validate(candidate);
    if (!validation.valid) {
      throw new TowerRegistryValidationError(validation.errors);
    }
    const tower = Object.freeze({ ...validation.tower, addedAt: new Date().toISOString() });
    return this.commit([...this.getTowers(), tower], tower);
  }

  update(originalId, candidate) {
    const currentTower = this.find(originalId);
    if (!currentTower) {
      throw new Error("The tower being edited no longer exists.");
    }
    const validation = this.validate(candidate, { excludeId: originalId });
    if (!validation.valid) {
      throw new TowerRegistryValidationError(validation.errors);
    }
    const tower = Object.freeze({ ...validation.tower, addedAt: currentTower.addedAt });
    const originalIdentity = towerIdentity(originalId);
    const towers = this.getTowers().map((existingTower) => (
      towerIdentity(existingTower.id) === originalIdentity ? tower : existingTower
    ));
    return this.commit(towers, tower);
  }

  remove(towerId) {
    const identity = towerIdentity(towerId);
    const tower = this.find(towerId);
    if (!tower) {
      return null;
    }
    const towers = this.getTowers().filter((existingTower) => towerIdentity(existingTower.id) !== identity);
    this.commit(towers, null);
    return tower;
  }

  find(towerId) {
    const identity = towerIdentity(towerId);
    return this.getTowers().find((tower) => towerIdentity(tower.id) === identity) || null;
  }

  commit(towers, result) {
    const sortedTowers = sortTowers(towers);
    try {
      this.repository.save(sortedTowers);
      this.store.setState({ towers: sortedTowers, error: null });
      return result;
    } catch (error) {
      this.store.setState({ error: error.message });
      throw error;
    }
  }
}
