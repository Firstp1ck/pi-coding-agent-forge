/** Render caller-owned activity; dispatch, target validation and seen state belong to the parent. */
export function createAttentionInbox({ document, onSelect, onClose }) {
  const node = (tag, className, text) => {
    const element = document.createElement(tag);
    if (className) element.className = className;
    if (text !== undefined) element.textContent = text;
    return element;
  };
  const element = node('dialog');
  element.id = 'shellAttentionInbox';
  element.setAttribute('aria-labelledby', 'shellAttentionInboxTitle');
  const header = node('header', 'attention-inbox-header');
  const heading = node('h2', '', 'Attention');
  heading.id = 'shellAttentionInboxTitle';
  const closeButton = node('button', 'attention-inbox-close', 'Close');
  closeButton.type = 'button';
  closeButton.autofocus = true;
  closeButton.setAttribute('aria-label', 'Close attention inbox');
  header.append(heading, closeButton);
  const summary = node('p', 'attention-inbox-summary');
  summary.setAttribute('role', 'status');
  summary.setAttribute('aria-atomic', 'true');
  const runControls = node('div', 'attention-inbox-run-controls');
  runControls.setAttribute('role', 'group');
  runControls.setAttribute('aria-label', 'Run controls');
  const body = node('div', 'attention-inbox-body');
  const empty = node('p', 'attention-inbox-empty', 'No activity to show. Decisions, running work and finished work will appear here.');
  body.append(empty);
  const sections = new Map();
  for (const [state, label, emptyText] of [
    ['blocked', 'Needs your decision', 'No decisions waiting.'],
    ['working', 'Running', 'Nothing running.'],
    ['done', 'Finished', 'No finished work.'],
  ]) {
    const section = node('section', `attention-inbox-section attention-inbox-${state}`);
    const title = node('h3', 'attention-inbox-section-title', label);
    title.id = `shellAttentionInbox-${state}`;
    section.setAttribute('aria-labelledby', title.id);
    const count = node('p', 'attention-inbox-count');
    const list = node('ul', 'attention-inbox-list');
    const placeholder = node('p', 'attention-inbox-placeholder', emptyText);
    section.append(title, count, list, placeholder);
    sections.set(state, { section, count, list, placeholder });
    body.append(section);
  }
  const footer = node('footer', 'attention-inbox-footer', 'Select an item to open it. Esc to close.');
  element.append(header, summary, runControls, body, footer);

  let disposed = false;
  let closePending = false;
  let opener = null;
  const rows = new Map();
  const plural = (count, word) => `${count} ${word}${count === 1 ? '' : 's'}`;
  const decisionCount = (item) => Number.isSafeInteger(item.decisionCount) && item.decisionCount > 0 ? item.decisionCount : 0;
  const unavailable = (item) => item.disabled === true || item.available === false;

  function restoreFocus(trigger) {
    if (!trigger?.isConnected || typeof trigger.focus !== 'function' || trigger.matches(':disabled')
      || trigger.closest('[hidden], [inert]')
      || !trigger.checkVisibility({ checkOpacity: true, checkVisibilityCSS: true })) return;
    // A still-open nested modal owns focus, even when this inbox is closed underneath it.
    if (document.querySelector('dialog:modal')) {
      const activeModal = document.activeElement?.closest('dialog:modal');
      if (!activeModal?.contains(trigger)) return;
    }
    trigger.focus({ preventScroll: true });
  }

  function finishClose() {
    if (!closePending) return;
    closePending = false;
    const trigger = opener;
    opener = null;
    restoreFocus(trigger);
    onClose?.();
  }

  function close() {
    if (disposed) return;
    if (element.open) element.close();
    finishClose();
  }

  function handleNativeClose(event) {
    if (event.target === element && !element.open) finishClose();
  }

  function handleCancel(event) {
    if (event.target !== element) return;
    event.preventDefault();
    close();
  }

  function handleSelect(event) {
    const control = event.target.closest?.('.attention-inbox-item');
    if (disposed || !element.open || !control || control.disabled) return;
    const row = rows.get(control.dataset.itemKey);
    if (!row || row.control !== control || !element.contains(control) || unavailable(row.item)) return;
    onSelect?.(row.item);
  }

  function createRow(key) {
    const row = node('li', 'attention-inbox-row');
    const control = node('button', 'attention-inbox-item');
    control.type = 'button';
    control.dataset.itemKey = key;
    const title = node('span', 'attention-inbox-item-title');
    const detail = node('span', 'attention-inbox-item-detail');
    const status = node('span', 'attention-inbox-item-status');
    control.append(title, detail, status);
    row.append(control);
    return { row, control, title, detail, status, item: null };
  }

  function update({ items } = {}) {
    if (disposed || items === undefined) return;
    const active = document.activeElement;
    const oldRows = [...rows.values()];
    const focusedRow = oldRows.find((row) => row.control === active);
    const nextRows = new Map();
    const groups = new Map([...sections.keys()].map((state) => [state, []]));
    for (const item of items) {
      if (!groups.has(item.state)) continue;
      // IDs are scoped to their originating tab, not the currently selected tab.
      const key = JSON.stringify([item.tabId, item.id]);
      if (nextRows.has(key)) continue;
      const row = rows.get(key) ?? createRow(key);
      row.item = item;
      row.title.textContent = item.title;
      row.detail.textContent = item.detail ?? '';
      row.detail.hidden = !row.detail.textContent;
      row.status.textContent = item.state === 'blocked' ? plural(decisionCount(item), 'decision')
        : item.state === 'working' ? 'Running' : 'Finished';
      row.control.disabled = unavailable(item);
      nextRows.set(key, row);
      groups.get(item.state).push(row);
    }
    for (const [key, row] of rows) {
      if (!nextRows.has(key)) row.row.remove();
    }
    rows.clear();
    for (const [key, row] of nextRows) rows.set(key, row);
    const decisions = groups.get('blocked').reduce((total, row) => total + decisionCount(row.item), 0);
    summary.textContent = `${plural(decisions, 'decision')} · ${groups.get('working').length} running · ${groups.get('done').length} finished`;
    empty.hidden = rows.size > 0;
    for (const [state, section] of sections) {
      const group = groups.get(state);
      section.count.textContent = state === 'blocked'
        ? `${plural(decisions, 'decision')} · ${plural(group.length, 'item')}` : plural(group.length, 'item');
      section.placeholder.hidden = group.length > 0;
      for (const [index, row] of group.entries()) {
        if (section.list.children[index] !== row.row) section.list.insertBefore(row.row, section.list.children[index] ?? null);
      }
    }
    if (focusedRow && element.open) {
      const ordered = [...groups.values()].flat();
      const retained = ordered.includes(focusedRow) && !focusedRow.control.disabled ? focusedRow : null;
      const fallback = ordered.slice(oldRows.indexOf(focusedRow)).find((row) => !row.control.disabled)
        ?? ordered.findLast((row) => !row.control.disabled);
      (retained?.control ?? fallback?.control ?? closeButton).focus({ preventScroll: true });
    }
  }

  function open(snapshot = {}, trigger = document.activeElement) {
    if (disposed) return;
    if (element.open) {
      update(snapshot);
      return;
    }
    // Native close events are queued; finish the previous lifetime before reopening.
    finishClose();
    if (disposed || element.open) return;
    update(snapshot);
    opener = trigger;
    element.showModal();
    closePending = true;
  }

  function dispose() {
    if (disposed) return;
    disposed = true;
    if (element.open) element.close();
    finishClose();
    closeButton.removeEventListener('click', close);
    element.removeEventListener('close', handleNativeClose);
    element.removeEventListener('cancel', handleCancel);
    element.removeEventListener('click', handleSelect);
    element.remove();
    rows.clear();
  }

  closeButton.addEventListener('click', close);
  element.addEventListener('close', handleNativeClose);
  element.addEventListener('cancel', handleCancel);
  element.addEventListener('click', handleSelect);
  update({ items: [] });
  return { element, slots: { runControls }, open, update, close, dispose };
}
