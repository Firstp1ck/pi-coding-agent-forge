let nextControlId = 0;

/** Project the caller's submission state without owning submission or run controls. */
export function composerSubmissionPresentation({ runActive = false, behavior = 'followUp' } = {}) {
  if (!runActive) return { label: 'Send', description: 'Send a message to this session.' };
  if (behavior === 'steer') {
    return { label: 'Steer run', description: 'Send guidance to Pi during this run.' };
  }
  return { label: 'Queue message', description: 'Queue this message for after the current run.' };
}

/** Display caller-owned effective settings. Picker callbacks receive their stable trigger button. */
export function createFocusedComposerControls({ document, onBehaviorChange, onModel, onEffort, onScopedModels }) {
  const id = `focusedComposerControls${++nextControlId}`;
  const node = (tag, className, text) => {
    const element = document.createElement(tag);
    element.className = className;
    if (text !== undefined) element.textContent = text;
    return element;
  };
  const element = node('div', 'focused-composer-controls');
  element.setAttribute('role', 'group');
  element.setAttribute('aria-label', 'Session composer controls');
  element.tabIndex = -1;
  const scope = node('span', 'focused-composer-scope', 'Session');

  function setting(kind, label) {
    const group = node('div', 'focused-composer-setting');
    const button = node('button', 'focused-composer-setting-button');
    button.type = 'button';
    const caption = node('span', 'focused-composer-caption', `${label}:`);
    const value = node('span', `focused-composer-${kind}-value`);
    const reason = node('p', 'focused-composer-reason');
    reason.id = `${id}-${kind}-reason`;
    button.append(caption, value);
    group.append(button, reason);
    return { group, button, value, reason };
  }

  const model = setting('model', 'Model');
  const effort = setting('effort', 'Effort');
  const scopedModels = node('button', 'focused-composer-setting-button focused-composer-scoped-models', 'Scoped models');
  scopedModels.type = 'button';
  scopedModels.hidden = typeof onScopedModels !== 'function';
  scopedModels.setAttribute('aria-haspopup', 'listbox');
  scopedModels.setAttribute('aria-expanded', 'false');
  scopedModels.title = 'Choose from your saved model scope';
  const busy = node('div', 'focused-composer-busy');
  const behaviorLabel = node('label', 'focused-composer-behavior-label', 'During this run');
  const select = node('select', 'focused-composer-behavior');
  for (const [value, text] of [['steer', 'Steer run'], ['followUp', 'Queue message']]) {
    const option = node('option', '', text);
    option.value = value;
    select.append(option);
  }
  const description = node('p', 'focused-composer-description');
  description.id = `${id}-description`;
  select.setAttribute('aria-describedby', description.id);
  behaviorLabel.append(select);
  busy.append(behaviorLabel, description);
  element.append(scope, model.group);
  if (!scopedModels.hidden) element.append(scopedModels);
  element.append(effort.group, busy);

  let disposed = false;
  let state = {
    runActive: false, behavior: 'followUp', modelLabel: 'Not selected', effortLabel: 'Not available',
    modelDisabled: false, effortDisabled: false, modelReason: '', effortReason: '',
  };

  function renderSetting(control, label, disabled, reason, fallbackReason) {
    control.value.textContent = label;
    control.button.disabled = Boolean(disabled);
    control.reason.hidden = !disabled;
    control.reason.textContent = disabled ? reason || fallbackReason : '';
    control.button.title = disabled ? control.reason.textContent : label;
    if (disabled) control.button.setAttribute('aria-describedby', control.reason.id);
    else control.button.removeAttribute('aria-describedby');
  }

  function update(snapshot = {}) {
    if (disposed) return;
    for (const key of Object.keys(state)) {
      if (snapshot[key] !== undefined) state[key] = snapshot[key];
    }
    state.behavior = state.behavior === 'steer' ? 'steer' : 'followUp';
    const focused = document.activeElement;
    renderSetting(model, state.modelLabel, state.modelDisabled, state.modelReason,
      'Model selection is unavailable for this session.');
    renderSetting(effort, state.effortLabel, state.effortDisabled, state.effortReason,
      'Effort selection is unavailable for this session.');
    scopedModels.disabled = Boolean(state.modelDisabled);
    if (scopedModels.disabled) scopedModels.setAttribute('aria-describedby', model.reason.id);
    else scopedModels.removeAttribute('aria-describedby');
    select.value = state.behavior;
    busy.hidden = !state.runActive;
    select.disabled = !state.runActive;
    description.textContent = composerSubmissionPresentation(state).description;
    // Hidden or newly disabled controls cannot retain useful keyboard focus.
    if ((focused === select && !state.runActive)
      || (focused === model.button && model.button.disabled)
      || (focused === scopedModels && scopedModels.disabled)
      || (focused === effort.button && effort.button.disabled)) {
      const target = [model.button, effort.button, select].find((control) => !control.disabled) || element;
      target.focus({ preventScroll: true });
    }
  }

  function changeBehavior() {
    if (disposed || !state.runActive || select.value === state.behavior) return;
    state.behavior = select.value;
    description.textContent = composerSubmissionPresentation(state).description;
    onBehaviorChange?.(state.behavior);
  }
  function openModel() {
    if (!disposed && !model.button.disabled) onModel?.(model.button);
  }
  function openScopedModels() {
    if (!disposed && !scopedModels.disabled) onScopedModels?.(scopedModels);
  }
  function openEffort() {
    if (!disposed && !effort.button.disabled) onEffort?.(effort.button);
  }
  function dispose() {
    if (disposed) return;
    disposed = true;
    select.removeEventListener('change', changeBehavior);
    model.button.removeEventListener('click', openModel);
    scopedModels.removeEventListener('click', openScopedModels);
    effort.button.removeEventListener('click', openEffort);
    element.remove();
  }

  select.addEventListener('change', changeBehavior);
  model.button.addEventListener('click', openModel);
  scopedModels.addEventListener('click', openScopedModels);
  effort.button.addEventListener('click', openEffort);
  update();
  return { element, update, dispose };
}
