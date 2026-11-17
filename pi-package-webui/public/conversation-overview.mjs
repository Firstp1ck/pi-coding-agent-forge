/** Creates a nonmodal summary. The caller supplies snapshots and authorizes actions. */
export function createConversationOverview({ document, onClose, onAction }) {
  let disposed = false;
  let open = false;
  let target;
  const sections = new Map();
  const actions = new WeakMap();

  function node(tag, className, text) {
    const result = document.createElement(tag);
    result.className = className;
    if (text !== undefined) result.textContent = text;
    return result;
  }

  const element = node('section', 'conversation-overview');
  element.setAttribute('role', 'region');
  element.setAttribute('aria-label', 'Conversation overview');
  element.hidden = true;
  element.inert = true;
  const header = node('header', 'conversation-overview-header');
  const heading = node('div', 'conversation-overview-heading');
  const title = node('strong', 'conversation-overview-title');
  const context = node('span', 'conversation-overview-context');
  heading.append(title, context);
  const close = node('button', 'conversation-overview-close', '×');
  close.type = 'button';
  close.setAttribute('aria-label', 'Close conversation overview');
  header.append(heading, close);
  const content = node('div', 'conversation-overview-content');
  element.append(header, content);

  function interactive() {
    return !disposed && open && element.isConnected && !element.closest('[hidden], [inert]');
  }

  function hide() {
    open = false;
    element.hidden = true;
    element.inert = true;
  }

  function requestClose() {
    if (!interactive()) return;
    hide();
    onClose?.();
  }

  function handleClick(event) {
    if (!interactive()) return;
    const button = event.target.closest('button');
    if (!button || button.disabled || button.closest('[hidden], [inert]')) return;
    if (button === close) return requestClose();
    const item = actions.get(button);
    if (item?.actionId) onAction?.(item.actionId, target);
  }

  function handleKeydown(event) {
    if (event.key !== 'Escape' || event.defaultPrevented || !interactive()) return;
    if (!element.contains(document.activeElement)) return;
    event.preventDefault();
    event.stopPropagation();
    requestClose();
  }

  element.addEventListener('click', handleClick);
  element.addEventListener('keydown', handleKeydown);

  function createItem() {
    const row = node('div', 'conversation-overview-item');
    const summary = node('div', 'conversation-overview-summary');
    const label = node('span', 'conversation-overview-label');
    const value = node('span', 'conversation-overview-value');
    summary.append(label, value);
    const action = node('button', 'conversation-overview-action', '↗');
    action.type = 'button';
    const detail = node('span', 'conversation-overview-detail');
    const reason = node('span', 'conversation-overview-reason');
    const progress = node('div', 'conversation-overview-progress');
    progress.setAttribute('role', 'progressbar');
    progress.setAttribute('aria-valuemin', '0');
    progress.setAttribute('aria-valuemax', '100');
    const fill = node('span', 'conversation-overview-progress-fill');
    progress.append(fill);
    row.append(summary, action, detail, reason, progress);
    const item = { row, label, value, action, detail, reason, progress, fill, actionId: null };
    actions.set(action, item);
    return item;
  }

  function setOptionalText(element, text) {
    element.textContent = text ?? '';
    element.hidden = !element.textContent;
  }

  function updateItem(item, snapshot) {
    item.label.textContent = snapshot.label || 'Unknown';
    item.value.textContent = snapshot.value === '' || snapshot.value == null ? 'Unknown' : snapshot.value;
    setOptionalText(item.detail, snapshot.detail);
    setOptionalText(item.reason, snapshot.reason);
    item.actionId = snapshot.actionId;
    item.action.hidden = !snapshot.actionId;
    item.action.disabled = !!snapshot.disabled;
    item.action.setAttribute('aria-label', `Open ${item.label.textContent}`);
    if (snapshot.disabled && snapshot.reason) item.action.setAttribute('aria-description', snapshot.reason);
    else item.action.removeAttribute('aria-description');
    const hasProgress = Number.isFinite(snapshot.progress);
    item.progress.hidden = !hasProgress;
    if (hasProgress) {
      const percent = Math.min(100, Math.max(0, snapshot.progress));
      item.progress.setAttribute('aria-label', item.label.textContent);
      item.progress.setAttribute('aria-valuenow', String(percent));
      item.fill.style.width = `${percent}%`;
    } else {
      item.progress.removeAttribute('aria-valuenow');
      item.fill.style.width = '';
    }
  }

  function place(parent, child, index) {
    const next = parent.children[index] ?? null;
    if (next === child) return;
    // Native moves retain focus without needing a focus call on modern browsers.
    if (parent.moveBefore && child.parentNode === parent) parent.moveBefore(child, next);
    else parent.insertBefore(child, next);
  }

  function update(snapshot = {}) {
    if (disposed) return;
    const focused = element.contains(document.activeElement) ? document.activeElement : null;
    target = snapshot.target;
    title.textContent = snapshot.title || 'Overview';
    setOptionalText(context, snapshot.context);
    const activeSections = new Set();
    for (const [sectionIndex, data] of (snapshot.sections ?? []).entries()) {
      activeSections.add(data.id);
      let section = sections.get(data.id);
      if (!section) {
        const root = node('section', 'conversation-overview-section');
        const label = node('h3', 'conversation-overview-section-title');
        const items = node('div', 'conversation-overview-items');
        root.append(label, items);
        section = { root, label, items, entries: new Map() };
        sections.set(data.id, section);
      }
      setOptionalText(section.label, data.label);
      const activeItems = new Set();
      for (const [itemIndex, dataItem] of (data.items ?? []).entries()) {
        activeItems.add(dataItem.id);
        let item = section.entries.get(dataItem.id);
        if (!item) {
          item = createItem();
          section.entries.set(dataItem.id, item);
        }
        updateItem(item, dataItem);
        place(section.items, item.row, itemIndex);
      }
      for (const [id, item] of section.entries) {
        if (activeItems.has(id)) continue;
        actions.delete(item.action);
        item.row.remove();
        section.entries.delete(id);
      }
      place(content, section.root, sectionIndex);
    }
    for (const [id, section] of sections) {
      if (activeSections.has(id)) continue;
      for (const item of section.entries.values()) actions.delete(item.action);
      section.root.remove();
      sections.delete(id);
    }
    open = !!snapshot.open;
    element.hidden = !open;
    element.inert = !open;
    // Only repair focus lost by a DOM move, never focus a newly opened card.
    if (open && focused?.isConnected && document.activeElement === document.body && !focused.disabled && !focused.hidden) {
      focused.focus({ preventScroll: true });
    }
  }

  function dispose() {
    if (disposed) return;
    disposed = true;
    hide();
    target = undefined;
    element.removeEventListener('click', handleClick);
    element.removeEventListener('keydown', handleKeydown);
    sections.clear();
    element.remove();
  }

  return { element, update, dispose };
}
