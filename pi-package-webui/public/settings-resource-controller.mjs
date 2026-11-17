const SCOPES = new Set(["session", "global", "model"]);
const FILTERS = new Set(["all", "enabled", "disabled"]);
const NO_MODELS = "No authenticated Pi models are available for a model default.";

function selection(scope, model = null) {
  return Object.freeze({ scope, provider: model?.provider ?? null, modelId: model?.modelId ?? null });
}

// API records are JSON data. Copy before freezing so callers retain their inputs.
function readOnlyCopy(value) {
  if (Array.isArray(value)) return Object.freeze(value.map(readOnlyCopy));
  if (value && typeof value === "object") {
    return Object.freeze(Object.fromEntries(Object.entries(value).map(([key, item]) => [key, readOnlyCopy(item)])));
  }
  return value;
}

function modelCatalog(value, { sort = false } = {}) {
  const models = (Array.isArray(value) ? value : []).filter((model) =>
    typeof model?.provider === "string" && model.provider.length > 0 &&
    typeof model?.id === "string" && model.id.length > 0);
  if (sort) models.sort((left, right) => `${left.provider}/${left.id}`.localeCompare(`${right.provider}/${right.id}`));
  return readOnlyCopy(models);
}

function hasModel(models, selected) {
  return models.some((model) => model.provider === selected.provider && model.id === selected.modelId);
}

function unavailableModel(selected) {
  return `The exact model ${selected.provider}/${selected.modelId} is unavailable. Choose an available model.`;
}

const EMPTY = Object.freeze({
  kind: null, target: null, selection: selection("session"), resources: Object.freeze([]),
  models: Object.freeze([]), configured: false, filter: "all", loading: false, savingName: "", error: "",
});

/** Owns one tools/skills presentation. Async methods return true only for accepted completions. */
export function createSettingsResourceController({ read, write, listModels, isCurrent, onChange, onMutation }) {
  let owner = null;
  let disposed = false;

  function getSnapshot() {
    if (!owner) return EMPTY;
    const { kind, target, selection, resources, models, configured, filter, loading, savingName, error } = owner;
    // The opaque target belongs to the parent; all controller-owned projections are frozen.
    return Object.freeze({ kind, target, selection, resources, models, configured, filter, loading, savingName, error });
  }

  function current(state) {
    return !disposed && state !== null && owner === state && isCurrent(state.target);
  }

  function capture(state) {
    return { state, epoch: ++state.epoch, target: state.target, selection: state.selection };
  }

  function owns(token) {
    return current(token.state) && token.state.epoch === token.epoch && token.state.selection === token.selection;
  }

  function changed() {
    onChange?.(getSnapshot());
  }

  function acceptData(state, data) {
    state.resources = readOnlyCopy(Array.isArray(data?.[state.kind]) ? data[state.kind] : []);
    state.configured = data?.configured === true;
    state.ready = true;
    if (state.selection.scope === "model") {
      if (Array.isArray(data?.models)) state.models = modelCatalog(data.models);
      if (!hasModel(state.models, state.selection)) state.error = unavailableModel(state.selection);
    }
  }

  async function load(state) {
    if (!current(state)) return false;
    const token = capture(state);
    state.resources = EMPTY.resources;
    state.configured = false;
    state.ready = false;
    state.error = "";
    if (state.selection.scope === "model" && !hasModel(state.models, state.selection)) {
      state.loading = false;
      state.error = unavailableModel(state.selection);
      changed();
      return false;
    }
    state.loading = true;
    changed();
    if (!owns(token)) return false;
    let accepted = false;
    try {
      const data = await read(state.kind, token.selection, token.target);
      if (!owns(token)) return false;
      acceptData(state, data);
      accepted = true;
    } catch (error) {
      if (!owns(token)) return false;
      state.error = error?.message || String(error);
    } finally {
      if (owns(token)) {
        state.loading = false;
        changed();
      }
    }
    return accepted;
  }

  async function open(kind, target) {
    if (disposed || (kind !== "tools" && kind !== "skills")) return false;
    owner = {
      ...EMPTY, kind, target, epoch: 0, modelSelection: null, ready: false,
    };
    return load(owner);
  }

  async function setScope(scope) {
    const state = owner;
    if (!current(state) || state.savingName || !SCOPES.has(scope)) return false;
    if (scope === state.selection.scope && !state.loading) return false;
    if (scope === "model" && !state.models.length) {
      const token = capture(state);
      state.loading = true;
      state.error = "";
      changed();
      if (!owns(token)) return false;
      try {
        const models = await listModels(token.target);
        if (!owns(token)) return false;
        state.models = modelCatalog(models, { sort: true });
        if (!state.models.length) {
          state.error = NO_MODELS;
          return false;
        }
      } catch (error) {
        if (!owns(token)) return false;
        state.error = error?.message || String(error);
        return false;
      } finally {
        if (owns(token)) {
          state.loading = false;
          // Successful discovery is published together with the following model load.
          if (state.error) changed();
        }
      }
      if (!owns(token)) return false;
    }
    if (scope === "model" && !state.modelSelection) {
      const model = state.models[0];
      state.modelSelection = selection("model", { provider: model.provider, modelId: model.id });
    }
    state.selection = scope === "model" ? state.modelSelection : selection(scope);
    return load(state);
  }

  async function setModel(model) {
    const state = owner;
    if (!current(state) || state.savingName || state.selection.scope !== "model" || !hasModel(state.models, model ?? {})) return false;
    if (state.selection.provider === model.provider && state.selection.modelId === model.modelId && !state.loading) return false;
    state.modelSelection = selection("model", model);
    state.selection = state.modelSelection;
    return load(state);
  }

  function setFilter(filter) {
    if (!current(owner) || !FILTERS.has(filter) || owner.filter === filter) return false;
    owner.filter = filter;
    changed();
    return true;
  }

  async function mutate(name, inherited) {
    const state = owner;
    if (!current(state) || state.loading || state.savingName || !state.ready) return false;
    if (state.selection.scope === "model" && !hasModel(state.models, state.selection)) return false;
    const resource = inherited ? null : state.resources.find((item) => item.name === name);
    if (!inherited && !resource) return false;
    const enabled = inherited ? null : resource.enabled === false;
    const names = new Set(state.resources.filter((item) => item.enabled !== false).map((item) => item.name));
    if (!inherited) {
      if (enabled) names.add(name);
      else names.delete(name);
    }
    const change = inherited ? Object.freeze({ inherit: true }) : Object.freeze({ enabled: Object.freeze([...names]) });
    const token = capture(state);
    state.savingName = inherited ? "inherit" : name;
    state.error = "";
    changed();
    if (!owns(token)) return false;
    let accepted = false;
    try {
      const data = await write(state.kind, token.selection, change, token.target);
      if (!owns(token)) return false;
      acceptData(state, data);
      accepted = true;
    } catch (error) {
      if (!owns(token)) return false;
      state.error = error?.message || String(error);
    } finally {
      if (owns(token)) {
        state.savingName = "";
        changed();
      }
    }
    if (accepted && owns(token)) {
      onMutation?.(Object.freeze({
        kind: state.kind, target: token.target, selection: token.selection,
        name: inherited ? null : name, enabled, inherit: inherited,
      }));
    }
    return accepted;
  }

  function close() {
    if (disposed || !owner) return false;
    owner = null;
    changed();
    return true;
  }

  function dispose() {
    if (disposed) return;
    const hadOwner = owner !== null;
    disposed = true;
    owner = null;
    if (hadOwner) changed();
  }

  return { open, setScope, setModel, setFilter, toggle: (name) => mutate(name, false), inherit: () => mutate(null, true), close, getSnapshot, dispose };
}
