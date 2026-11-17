let nextNavigatorId = 0;
const QUERY_LIMIT = 256;
const RESULT_LIMIT = 100;

/** Settings chrome only. The parent owns content, targets, availability and navigation. */
export function createSettingsNavigator({ document, onNavigate, onInvoke }) {
  let navigate = onNavigate;
  let invoke = onInvoke;
  let disposed = false;
  let snapshot = { category: null, categories: [], entries: [], target: null };
  const categories = new Map();
  const results = new Map();
  let prefix;
  do { prefix = `pi-settings-navigation-${++nextNavigatorId}`; }
  while (document.getElementById(`${prefix}-search`));

  function node(tag, className, text) {
    const element = document.createElement(tag);
    element.className = className;
    if (text !== undefined) element.textContent = text;
    return element;
  }

  function button(className, text) {
    const element = node('button', className, text);
    element.type = 'button';
    return element;
  }

  const element = node('section', 'settings-navigation');
  element.setAttribute('aria-label', 'Settings');
  const searchBar = node('div', 'settings-navigation-search');
  const searchLabel = node('label', 'settings-navigation-search-label', 'Search settings');
  const search = node('input', 'settings-navigation-input');
  search.type = 'search';
  search.id = `${prefix}-search`;
  search.maxLength = QUERY_LIMIT;
  search.autocomplete = 'off';
  search.placeholder = 'Find a setting…';
  searchLabel.htmlFor = search.id;
  const clear = button('settings-navigation-clear', 'Clear');
  clear.setAttribute('aria-label', 'Clear settings search');
  clear.hidden = true;
  searchBar.append(searchLabel, search, clear);
  const layout = node('div', 'settings-navigation-layout');
  const nav = node('nav', 'settings-navigation-categories');
  nav.setAttribute('aria-label', 'Settings categories');
  const main = node('div', 'settings-navigation-main');
  const heading = node('h2', 'settings-navigation-heading', 'Settings');
  heading.id = `${prefix}-heading`;
  const content = node('div', 'settings-navigation-content');
  content.setAttribute('role', 'region');
  content.setAttribute('aria-labelledby', heading.id);
  const resultArea = node('div', 'settings-navigation-results');
  resultArea.hidden = true;
  const status = node('p', 'settings-navigation-status');
  status.id = `${prefix}-status`;
  status.setAttribute('role', 'status');
  const list = node('ul', 'settings-navigation-result-list');
  list.id = `${prefix}-results`;
  list.setAttribute('aria-label', 'Settings search results');
  search.setAttribute('aria-controls', list.id);
  search.setAttribute('aria-describedby', status.id);
  resultArea.append(status, list);
  main.append(heading, content, resultArea);
  layout.append(nav, main);
  element.append(searchBar, layout);

  // Reorder only displaced nodes: appending every keyed node would blur focused buttons.
  function reconcile(container, records, items, create, paint) {
    const retained = new Set(items.map((item) => item.id));
    for (const [id, record] of records) {
      if (retained.has(id)) continue;
      retire(record);
      records.delete(id);
    }
    let cursor = container.firstChild;
    for (const item of items) {
      let record = records.get(item.id);
      if (!record) {
        record = create();
        records.set(item.id, record);
      }
      paint(record, item);
      if (record.element !== cursor) container.insertBefore(record.element, cursor);
      cursor = record.element.nextSibling;
    }
  }

  function retire(record) {
    record.binding = null;
    for (const control of record.controls) control.onclick = null;
    record.element.remove();
  }

  function bind(record, control, callback) {
    const binding = record.binding;
    control.onclick = () => {
      if (disposed || record.binding !== binding || control.disabled || !control.isConnected ||
          !element.contains(control) || control.closest('[hidden]')) return;
      callback();
    };
  }

  function createResult() {
    const row = node('li', 'settings-navigation-result');
    const open = button('settings-navigation-open');
    const label = node('span', 'settings-navigation-result-label');
    const scope = node('span', 'settings-navigation-scope');
    const description = node('span', 'settings-navigation-description');
    const reason = node('p', 'settings-navigation-reason');
    reason.id = `${prefix}-reason-${++nextNavigatorId}`;
    const setup = button('settings-navigation-setup', 'Setup');
    open.append(label, scope, description);
    row.append(open, reason, setup);
    return { element: row, open, label, scope, description, reason, setup, controls: [open, setup] };
  }

  function render() {
    const focused = document.activeElement;
    const ownedFocus = focused === clear || nav.contains(focused) || list.contains(focused);
    const target = snapshot.target;
    reconcile(nav, categories, snapshot.categories, () => {
      const control = button('settings-navigation-category');
      return { element: control, controls: [control] };
    }, (record, category) => {
      record.binding = {};
      record.element.textContent = category.label;
      if (category.id === snapshot.category) record.element.setAttribute('aria-current', 'page');
      else record.element.removeAttribute('aria-current');
      bind(record, record.element, () => navigate?.(category.id, null, target));
    });

    const query = search.value.trim().slice(0, QUERY_LIMIT).toLowerCase();
    content.hidden = !!query;
    resultArea.hidden = !query;
    clear.hidden = !search.value;
    heading.textContent = snapshot.categories.find(({ id }) => id === snapshot.category)?.label || 'Settings';
    const matches = query ? snapshot.entries.filter((entry) =>
      [entry.label, entry.description, ...entry.aliases].some((text) => text.toLowerCase().includes(query))) : [];
    status.textContent = !query ? '' : !matches.length ? 'No matching settings. Try another name or purpose.'
      : matches.length > RESULT_LIMIT ? `${matches.length} results. Showing the first ${RESULT_LIMIT}; ${matches.length - RESULT_LIMIT} more results. Refine your search.`
        : `${matches.length} ${matches.length === 1 ? 'result' : 'results'}`;
    reconcile(list, results, matches.slice(0, RESULT_LIMIT), createResult, (record, entry) => {
      record.binding = {};
      record.label.textContent = entry.label;
      record.scope.textContent = entry.scopeLabel;
      record.scope.hidden = !entry.scopeLabel;
      record.description.textContent = entry.description;
      record.description.hidden = !entry.description;
      record.open.disabled = !entry.available;
      record.reason.textContent = entry.available ? '' : entry.reason;
      record.reason.hidden = entry.available;
      if (entry.available) record.open.removeAttribute('aria-describedby');
      else record.open.setAttribute('aria-describedby', record.reason.id);
      bind(record, record.open, () => navigate?.(entry.category, entry.id, target));
      record.setup.hidden = entry.available || !entry.setupActionId;
      record.setup.setAttribute('aria-label', `Setup ${entry.label}`);
      bind(record, record.setup, () => invoke?.(entry.setupActionId, target));
    });
    if (ownedFocus && (!element.contains(focused) || focused.closest('[hidden]') || focused.disabled)) {
      search.focus({ preventScroll: true });
    } else if (focused && element.contains(focused) && !focused.closest('[hidden]') && !focused.disabled) {
      if (document.activeElement !== focused) focused.focus({ preventScroll: true });
    }
  }

  function update({ category, categories: nextCategories, entries, target }) {
    if (disposed) return;
    snapshot = {
      category, target,
      categories: nextCategories.map(({ id, label }) => ({ id, label })),
      entries: entries.map((entry) => ({ ...entry, aliases: [...entry.aliases] })),
    };
    render();
  }

  function clearSearch() {
    if (disposed) return;
    search.value = '';
    render();
  }

  function handleInput() {
    search.value = search.value.slice(0, QUERY_LIMIT);
    render();
  }

  function handleKeydown(event) {
    if (disposed || event.defaultPrevented || event.isComposing || event.altKey || event.ctrlKey ||
        event.metaKey || event.shiftKey || document.querySelector(':modal')) return;
    const inSearch = event.target === search;
    const categoryControls = [...nav.children];
    const resultControls = [...list.querySelectorAll('button')].filter((control) => !control.disabled && !control.hidden);
    const controls = categoryControls.includes(event.target) ? categoryControls : resultControls;
    if (!inSearch && !controls.includes(event.target) && event.target !== clear) return;
    if (event.key === 'Escape') {
      if (!search.value) return;
      event.preventDefault();
      event.stopPropagation();
      clearSearch();
      search.focus({ preventScroll: true });
    } else if (event.key === 'Enter' && inSearch && search.value.trim()) {
      event.preventDefault();
      resultControls.find((control) => control.classList.contains('settings-navigation-open'))?.click();
    } else if (['ArrowDown', 'ArrowUp', 'ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) {
      if (inSearch && !['ArrowDown', 'ArrowUp'].includes(event.key)) return;
      if (controls === resultControls && ['ArrowLeft', 'ArrowRight'].includes(event.key)) return;
      if (event.target === clear || !controls.length) return;
      event.preventDefault();
      const current = controls.indexOf(event.target);
      const next = event.key === 'Home' ? 0 : event.key === 'End' ? controls.length - 1
        : ['ArrowDown', 'ArrowRight'].includes(event.key) ? (current + 1) % controls.length
          : current < 0 ? controls.length - 1 : (current - 1 + controls.length) % controls.length;
      controls[next].focus();
    }
  }

  function handleClear() {
    clearSearch();
    search.focus({ preventScroll: true });
  }
  search.addEventListener('input', handleInput);
  clear.addEventListener('click', handleClear);
  element.addEventListener('keydown', handleKeydown);

  function dispose() {
    if (disposed) return;
    disposed = true;
    search.removeEventListener('input', handleInput);
    clear.removeEventListener('click', handleClear);
    element.removeEventListener('keydown', handleKeydown);
    for (const record of [...categories.values(), ...results.values()]) retire(record);
    categories.clear();
    results.clear();
    snapshot = null;
    navigate = null;
    invoke = null;
    content.hidden = false;
    content.removeAttribute('role');
    content.removeAttribute('aria-labelledby');
    // Keep the borrowed nodes in the returned slot so the caller can restore them.
    content.remove();
    element.remove();
    element.replaceChildren();
  }

  return { element, slots: { content }, update, clearSearch, dispose };
}
