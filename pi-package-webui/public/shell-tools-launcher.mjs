import { filterActionItems } from './shell-actions.mjs';

const PIN_LIMIT = 20;

/** Present caller-owned actions; invocation validation and persistence belong to the parent. */
export function createToolsLauncher({ document, onInvoke, onPinsChange, onClose }) {
  const node = (tag, className, text) => {
    const element = document.createElement(tag);
    if (className) element.className = className;
    if (text !== undefined) element.textContent = text;
    return element;
  };
  const button = (className, text) => {
    const element = node('button', className, text);
    element.type = 'button';
    return element;
  };

  const element = node('dialog');
  element.id = 'shellToolsLauncher';
  element.setAttribute('aria-labelledby', 'shellToolsLauncherTitle');
  const header = node('header', 'tools-launcher-header');
  const heading = node('h2', '', 'All tools');
  heading.id = 'shellToolsLauncherTitle';
  const closeButton = button('tools-launcher-close', 'Close');
  closeButton.setAttribute('aria-label', 'Close All tools');
  header.append(heading, closeButton);
  const context = node('p', 'tools-launcher-context');
  const search = node('input', 'tools-launcher-search');
  search.type = 'search';
  search.placeholder = 'Search tools by name or purpose';
  search.setAttribute('aria-label', 'Search all tools');
  search.setAttribute('aria-controls', 'shellToolsLauncherResults');
  search.autofocus = true;
  const runControls = node('div', 'tools-launcher-run-controls');
  const body = node('div', 'tools-launcher-body');
  const categories = node('nav', 'tools-launcher-categories');
  categories.setAttribute('aria-label', 'Tool categories');
  const results = node('section', 'tools-launcher-results');
  results.setAttribute('aria-label', 'Tools');
  const status = node('p', 'tools-launcher-status');
  status.setAttribute('role', 'status');
  const list = node('ul', 'tools-launcher-list');
  list.id = 'shellToolsLauncherResults';
  const empty = node('p', 'tools-launcher-empty');
  results.append(status, list, empty);
  body.append(categories, results);
  const footer = node('footer', 'tools-launcher-footer', '↑ ↓ Home End to browse · Enter to open · Esc to close');
  element.append(header, context, search, runControls, body, footer);

  let actions = [];
  let pinnedIds = [];
  let selectedCategory = 'all';
  let disposed = false;
  let closePending = false;
  let rows = [];
  const categoryButtons = new Map();

  function finishClose() {
    if (!closePending) return;
    closePending = false;
    onClose?.();
  }

  function close() {
    if (disposed) return;
    if (element.open) element.close();
    finishClose();
  }

  function handleNativeClose() {
    if (!element.open) finishClose();
  }

  function render() {
    const active = document.activeElement;
    const focusedRow = rows.find((row) => row.invoke === active || row.pin === active);
    const focusedKind = focusedRow?.pin === active ? 'pin' : 'invoke';
    const choices = [['all', 'All'], ['pinned', 'Pinned'],
      ...[...new Set(actions.map((action) => action.category).filter(Boolean))]
        .map((category) => [`category:${category}`, category])];
    if (!choices.some(([key]) => key === selectedCategory)) selectedCategory = 'all';
    for (const [key, control] of categoryButtons) {
      if (!choices.some(([choice]) => choice === key)) {
        control.remove();
        categoryButtons.delete(key);
      }
    }
    for (const [index, [key, label]] of choices.entries()) {
      let control = categoryButtons.get(key);
      if (!control) {
        control = button('', label);
        control.addEventListener('click', () => {
          if (disposed) return;
          selectedCategory = key;
          search.value = '';
          render();
        });
        categoryButtons.set(key, control);
      }
      control.setAttribute('aria-pressed', String(key === selectedCategory));
      if (categories.children[index] !== control) categories.insertBefore(control, categories.children[index] ?? null);
    }

    const query = search.value.trim();
    // A search reaches the whole supplied catalog, including records past the palette's default cap.
    const candidates = query ? actions : actions.filter((action) => selectedCategory === 'all'
      || (selectedCategory === 'pinned' ? pinnedIds.includes(action.id) : `category:${action.category}` === selectedCategory));
    const matches = filterActionItems(candidates, query, { limit: actions.length });
    status.textContent = query ? `${matches.length} results across all tools`
      : `${choices.find(([key]) => key === selectedCategory)[1]} · ${matches.length} tools`;
    empty.hidden = matches.length > 0;
    empty.textContent = query ? 'No matching tools. Try another name or purpose.'
      : selectedCategory === 'pinned' ? 'No pinned tools. Pin a tool from All to keep it here.' : 'No tools available in this category.';
    rows = matches.map((action, index) => {
      const row = node('li', 'tools-launcher-row');
      const invoke = button('tools-launcher-action');
      invoke.disabled = action.available === false;
      const label = node('span', 'tools-launcher-label', action.label);
      const description = node('span', 'tools-launcher-description', action.description);
      const category = node('span', 'tools-launcher-category', action.category);
      invoke.append(label, description, category);
      invoke.setAttribute('aria-label', action.label);
      const reason = node('p', 'tools-launcher-reason', action.unavailableReason || 'This action is currently unavailable.');
      reason.id = `shellToolsLauncherReason${index}`;
      reason.hidden = !invoke.disabled;
      if (invoke.disabled) invoke.setAttribute('aria-describedby', reason.id);
      invoke.addEventListener('click', () => {
        if (!disposed && element.open && action.available !== false) onInvoke?.(action);
      });
      const pinned = pinnedIds.includes(action.id);
      const pin = button('tools-launcher-pin', pinned ? '★' : '☆');
      pin.setAttribute('aria-label', `${pinned ? 'Unpin' : 'Pin'} ${action.label}`);
      pin.setAttribute('aria-pressed', String(pinned));
      pin.disabled = !pinned && pinnedIds.length >= PIN_LIMIT;
      pin.title = pin.disabled ? 'You can pin up to 20 tools. Unpin a tool first.' : `${pinned ? 'Unpin' : 'Pin'} tool`;
      pin.addEventListener('click', () => {
        if (disposed || !element.open || pin.disabled) return;
        pinnedIds = pinned ? pinnedIds.filter((id) => id !== action.id) : [...pinnedIds, action.id];
        render();
        onPinsChange?.([...pinnedIds]);
      });
      const text = node('div', 'tools-launcher-action-content');
      text.append(invoke, reason);
      row.append(text, pin);
      return { action, row, invoke, pin };
    });
    list.replaceChildren(...rows.map((row) => row.row));
    if (focusedRow) {
      const replacement = rows.find((row) => row.action.id === focusedRow.action.id)?.[focusedKind];
      if (replacement && !replacement.disabled) replacement.focus({ preventScroll: true });
      else search.focus({ preventScroll: true });
    }
  }

  function update(snapshot = {}) {
    if (disposed) return;
    if (snapshot.actions !== undefined) actions = snapshot.actions;
    if (snapshot.pinnedIds !== undefined) {
      pinnedIds = [...new Set(snapshot.pinnedIds.filter((id) => typeof id === 'string' && id.length > 0))].slice(0, PIN_LIMIT);
    }
    if (snapshot.contextLabel !== undefined) context.textContent = snapshot.contextLabel;
    context.hidden = !context.textContent;
    render();
  }

  function open(snapshot = {}) {
    if (disposed) return;
    if (!element.open) {
      search.value = '';
      selectedCategory = 'all';
    }
    update(snapshot);
    if (!element.open) element.showModal();
    closePending = true;
    search.focus({ preventScroll: true });
  }

  function handleKeydown(event) {
    if (disposed || event.defaultPrevented || event.isComposing || event.altKey || event.ctrlKey || event.metaKey || event.shiftKey) return;
    const current = rows.findIndex((row) => row.invoke === event.target);
    if (event.target !== search && current < 0) return;
    const available = rows.filter((row) => !row.invoke.disabled).map((row) => row.invoke);
    if (event.key === 'Enter' && event.target === search) {
      event.preventDefault();
      available[0]?.click();
      return;
    }
    if (!['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(event.key)) return;
    event.preventDefault();
    if (!available.length) return;
    const index = available.indexOf(event.target);
    let next;
    if (event.key === 'Home') next = 0;
    else if (event.key === 'End') next = available.length - 1;
    else if (event.key === 'ArrowDown') next = (index + 1) % available.length;
    else next = index < 0 ? available.length - 1 : (index - 1 + available.length) % available.length;
    available[next].focus();
  }

  function dispose() {
    if (disposed) return;
    close();
    disposed = true;
    search.removeEventListener('input', render);
    closeButton.removeEventListener('click', close);
    element.removeEventListener('close', handleNativeClose);
    element.removeEventListener('keydown', handleKeydown);
    element.remove();
    actions = [];
    rows = [];
    categoryButtons.clear();
  }

  search.addEventListener('input', render);
  closeButton.addEventListener('click', close);
  element.addEventListener('close', handleNativeClose);
  element.addEventListener('keydown', handleKeydown);
  update();
  return { element, slots: { runControls }, open, update, close, dispose };
}
