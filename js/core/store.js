function cloneValue(value) {
  if (value instanceof Date) {
    return new Date(value.getTime());
  }

  if (Array.isArray(value)) {
    return value.map(cloneValue);
  }

  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value).map(([key, nestedValue]) => [key, cloneValue(nestedValue)])
    );
  }

  return value;
}

function deepFreeze(value) {
  if (!value || typeof value !== "object" || Object.isFrozen(value)) {
    return value;
  }

  Object.values(value).forEach(deepFreeze);
  return Object.freeze(value);
}

function createSnapshot(value) {
  return deepFreeze(cloneValue(value));
}

export function createStore(initialState) {
  let state = createSnapshot(initialState);
  const subscribers = new Set();

  function getState() {
    return state;
  }

  function setState(update) {
    const patch = typeof update === "function" ? update(state) : update;

    if (!patch || typeof patch !== "object" || Array.isArray(patch)) {
      throw new TypeError("Store updates must be plain objects or updater functions returning a plain object.");
    }

    state = createSnapshot({ ...state, ...patch });

    subscribers.forEach((subscriber) => {
      try {
        subscriber(state);
      } catch (error) {
        window.console.error("A store subscriber failed.", error);
      }
    });

    return state;
  }

  function subscribe(subscriber, options = {}) {
    if (typeof subscriber !== "function") {
      throw new TypeError("Store subscribers must be functions.");
    }

    subscribers.add(subscriber);

    if (options.immediate !== false) {
      subscriber(state);
    }

    return () => subscribers.delete(subscriber);
  }

  const readonlyStore = Object.freeze({ getState, subscribe });

  return Object.freeze({
    getState,
    setState,
    subscribe,
    asReadonly: () => readonlyStore
  });
}

