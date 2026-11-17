/** Present caller-owned context actions; the parent owns validation and nested transitions. */
export function createContextActions({ document, onInvoke, onMore, onClose }) {
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
  element.id = 'shellContextActions';
  element.setAttribute('aria-labelledby', 'shellContextActionsTitle');
  const header = node('header', 'context-actions-header');
  const heading = node('h2', '', 'Context actions');
  heading.id = 'shellContextActionsTitle';
  const closeButton = button('context-actions-close', 'Close');
  closeButton.setAttribute('aria-label', 'Close context actions');
  const context = node('p', 'context-actions-context');
  const runControls = node('div', 'context-actions-run-controls');
  runControls.setAttribute('role', 'group');
  const body = node('section', 'context-actions-body');
  body.setAttribute('aria-label', 'Context actions');
  const list = node('ul', 'context-actions-list');
  const empty = node('p', 'context-actions-empty', 'No actions available here. Browse all tools for more actions.');
  const footer = node('footer', 'context-actions-footer');
  const moreButton = button('context-actions-more', 'More actions');
  header.append(heading, closeButton);
  body.append(list, empty);
  footer.append(moreButton);
  element.append(header, context, runControls, body, footer);

  let actions = [];
  let category;
  let rows = [];
  let trigger;
  let closePending = false;
  let disposed = false;

  function finishClose() {
    if (!closePending) return;
    closePending = false;
    const opener = trigger;
    trigger = undefined;
    // Restore before notifying the parent, which may immediately open another modal.
    if (opener?.isConnected && !opener.disabled && opener.getClientRects().length
      && !opener.closest('[hidden], [inert]')
      && document.defaultView.getComputedStyle(opener).visibility === 'visible') {
      opener.focus({ preventScroll: true });
    }
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

  function handleCancel(event) {
    event.preventDefault();
    close();
  }

  function update(snapshot = {}) {
    if (disposed) return;
    if (snapshot.actions !== undefined) actions = snapshot.actions;
    if (snapshot.category !== undefined) category = snapshot.category;
    if (snapshot.title !== undefined) heading.textContent = snapshot.title;
    if (snapshot.contextLabel !== undefined) context.textContent = snapshot.contextLabel;
    context.hidden = !context.textContent;
    const active = document.activeElement;
    const focusedRow = rows.find((row) => row.invoke === active);
    rows = actions.map((action, index) => {
      const row = node('li', 'context-actions-row');
      const invoke = button('context-actions-action');
      invoke.disabled = action.available === false;
      invoke.setAttribute('aria-label', action.label);
      const label = node('span', 'context-actions-label', action.label);
      const description = node('span', 'context-actions-description', action.description);
      description.hidden = !action.description;
      invoke.append(label, description);
      const reason = node('p', 'context-actions-reason', action.unavailableReason || 'This action is currently unavailable.');
      reason.id = `shellContextActionsReason${index}`;
      reason.hidden = !invoke.disabled;
      if (invoke.disabled) invoke.setAttribute('aria-describedby', reason.id);
      const entry = { action, row, invoke };
      invoke.addEventListener('click', () => {
        // Detached buttons from an earlier snapshot must never dispatch stale records.
        if (!disposed && element.open && rows.includes(entry) && action.available !== false) onInvoke?.(action);
      });
      row.append(invoke, reason);
      return entry;
    });
    list.replaceChildren(...rows.map((row) => row.row));
    empty.hidden = rows.length > 0;
    if (focusedRow) {
      const replacement = rows.find((row) => row.action.id === focusedRow.action.id)?.invoke;
      (replacement && !replacement.disabled ? replacement : moreButton).focus({ preventScroll: true });
    }
  }

  function open(snapshot = {}, opener = document.activeElement) {
    if (disposed) return;
    if (!element.open) {
      trigger = opener;
      category = undefined;
      heading.textContent = 'Context actions';
      context.textContent = '';
      actions = [];
    }
    update(snapshot);
    if (!element.open) element.showModal();
    closePending = true;
    (rows.find((row) => !row.invoke.disabled)?.invoke ?? moreButton).focus({ preventScroll: true });
  }

  function handleMore() {
    if (!disposed && element.open) onMore?.(category);
  }

  function handleKeydown(event) {
    if (event.defaultPrevented || event.isComposing || event.altKey || event.ctrlKey || event.metaKey || event.shiftKey) return;
    if (!rows.some((row) => row.invoke === event.target)) return;
    if (!['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(event.key)) return;
    event.preventDefault();
    const available = rows.filter((row) => !row.invoke.disabled).map((row) => row.invoke);
    if (!available.length) return;
    const index = available.indexOf(event.target);
    let next;
    if (event.key === 'Home') next = 0;
    else if (event.key === 'End') next = available.length - 1;
    else if (event.key === 'ArrowDown') next = (index + 1) % available.length;
    else next = (index - 1 + available.length) % available.length;
    available[next].focus();
  }

  function dispose() {
    if (disposed) return;
    disposed = true;
    if (element.open) element.close();
    finishClose();
    closeButton.removeEventListener('click', close);
    moreButton.removeEventListener('click', handleMore);
    element.removeEventListener('close', handleNativeClose);
    element.removeEventListener('cancel', handleCancel);
    element.removeEventListener('keydown', handleKeydown);
    element.remove();
    actions = [];
    rows = [];
  }

  closeButton.addEventListener('click', close);
  moreButton.addEventListener('click', handleMore);
  element.addEventListener('close', handleNativeClose);
  element.addEventListener('cancel', handleCancel);
  element.addEventListener('keydown', handleKeydown);
  update();
  return { element, slots: { runControls }, open, update, close, dispose };
}
