export const SIDEBAR_UPDATE_ICON = '<svg viewBox="0 0 24 24" width="18" height="18" aria-hidden="true" focusable="false" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M20 7v5h-5"/><path d="M4 17v-5h5"/><path d="M6.1 7a7 7 0 0 1 11.6-1L20 9M4 15l2.3 3A7 7 0 0 0 17.9 17"/></svg>';

const CHOICES = [
  ['all', 'Pi and extensions + WebUI', 'Update Pi, configured extensions, and WebUI.'],
  ['webui', 'WebUI only', 'Update existing WebUI installations.'],
  ['pi', 'Pi only', 'Update the Pi coding agent.'],
];
let nextId = 0;

/** Present update scopes. The caller owns previews, confirmation, and execution. */
export function createSidebarUpdateMenu({ button, onSelect }) {
  const document = button.ownerDocument;
  const window = document.defaultView;
  const id = `sidebarUpdateMenu${++nextId}`;
  const originalAttributes = new Map(['aria-haspopup', 'aria-expanded', 'aria-controls', 'aria-describedby', 'aria-disabled', 'aria-busy', 'title', 'disabled']
    .map((name) => [name, button.getAttribute(name)]));
  const hadTriggerClass = button.classList.contains('sidebar-update-trigger');
  const lifetime = new window.AbortController();
  const listen = (target, type, handler, options = {}) => target.addEventListener(type, handler, { ...options, signal: lifetime.signal });
  const node = (tag, className, text) => {
    const element = document.createElement(tag);
    element.className = className;
    if (text !== undefined) element.textContent = text;
    return element;
  };

  const popup = node('div', 'sidebar-update-menu');
  popup.id = id;
  popup.hidden = true;
  const usesPopover = typeof popup.showPopover === 'function';
  if (usesPopover) popup.setAttribute('popover', 'manual');
  const title = node('h2', 'sidebar-update-menu-title', 'Updates');
  title.id = `${id}Title`;
  const availability = node('p', 'sidebar-update-menu-availability');
  availability.id = `${id}Availability`;
  const status = node('p', 'sidebar-update-menu-status');
  status.id = `${id}Status`;
  status.setAttribute('role', 'status');
  status.setAttribute('aria-live', 'polite');
  status.setAttribute('aria-atomic', 'true');
  const menu = node('div', 'sidebar-update-menu-choices');
  menu.setAttribute('role', 'menu');
  menu.setAttribute('aria-labelledby', title.id);
  const choices = CHOICES.map(([mode, label, description]) => {
    const item = node('button', 'sidebar-update-menu-choice');
    item.type = 'button';
    item.dataset.mode = mode;
    item.tabIndex = -1;
    item.setAttribute('role', 'menuitem');
    item.setAttribute('aria-label', label);
    const detail = node('span', 'sidebar-update-menu-description', description);
    detail.id = `${id}${mode}Description`;
    item.setAttribute('aria-describedby', detail.id);
    item.append(node('span', 'sidebar-update-menu-label', label), detail);
    menu.append(item);
    return item;
  });
  popup.append(title, availability, status, menu);
  document.body.append(popup);
  button.classList.add('sidebar-update-trigger');
  button.disabled = false;
  button.setAttribute('aria-haspopup', 'menu');
  button.setAttribute('aria-controls', id);
  button.setAttribute('aria-expanded', 'false');

  let opened = false;
  let disposed = false;
  let blocked = false;
  let frame = null;

  function position() {
    if (!opened || disposed) return;
    if (!button.isConnected || !button.getClientRects().length) {
      close({ restoreFocus: false });
      return;
    }
    const viewport = window.visualViewport;
    const margin = 8;
    const gap = 6;
    const leftEdge = (viewport?.offsetLeft ?? 0) + margin;
    const topEdge = (viewport?.offsetTop ?? 0) + margin;
    const width = viewport?.width ?? window.innerWidth;
    const height = viewport?.height ?? window.innerHeight;
    const rightEdge = leftEdge + width - margin * 2;
    const bottomEdge = topEdge + height - margin * 2;
    popup.style.maxWidth = `${Math.max(0, width - margin * 2)}px`;
    popup.style.maxHeight = `${Math.max(0, height - margin * 2)}px`;
    const anchor = button.getBoundingClientRect();
    const bounds = popup.getBoundingClientRect();
    let left = anchor.left;
    let top = anchor.top - gap - bounds.height;
    if (top < topEdge) {
      top = anchor.bottom + gap;
      if (top + bounds.height > bottomEdge) {
        top = anchor.top;
        if (anchor.right + gap + bounds.width <= rightEdge) left = anchor.right + gap;
      }
    }
    popup.style.left = `${Math.max(leftEdge, Math.min(left, rightEdge - bounds.width))}px`;
    popup.style.top = `${Math.max(topEdge, Math.min(top, bottomEdge - bounds.height))}px`;
  }

  function schedulePosition() {
    if (!opened || disposed || frame !== null) return;
    frame = window.requestAnimationFrame(() => {
      frame = null;
      position();
    });
  }

  function close({ restoreFocus = true } = {}) {
    if (disposed || !opened) return;
    opened = false;
    if (frame !== null) window.cancelAnimationFrame(frame);
    frame = null;
    if (usesPopover && popup.matches(':popover-open')) popup.hidePopover();
    popup.hidden = true;
    button.setAttribute('aria-expanded', 'false');
    if (restoreFocus && button.isConnected) button.focus({ preventScroll: true });
  }

  function open(index = 0) {
    if (disposed || !button.isConnected) return;
    if (!opened) {
      opened = true;
      popup.hidden = false;
      popup.scrollTop = 0;
      if (usesPopover) popup.showPopover();
      button.setAttribute('aria-expanded', 'true');
      position();
    }
    choices[index].focus({ preventScroll: true });
    choices[index].scrollIntoView({ block: 'nearest' });
  }

  function update({ busy = false, disabledReason = '', statusText = '', statusTone = '' } = {}) {
    if (disposed) return;
    blocked = Boolean(busy || disabledReason);
    availability.textContent = disabledReason || (busy ? 'An update is in progress.' : '');
    availability.hidden = !availability.textContent;
    status.textContent = statusText;
    status.hidden = !statusText;
    status.dataset.tone = ['error', 'danger', 'warning', 'success'].includes(statusTone) ? statusTone : '';
    const descriptions = [originalAttributes.get('aria-describedby'),
      availability.hidden ? '' : availability.id, status.hidden ? '' : status.id].filter(Boolean);
    if (descriptions.length) button.setAttribute('aria-describedby', descriptions.join(' '));
    else button.removeAttribute('aria-describedby');
    button.disabled = false;
    button.setAttribute('aria-disabled', 'false');
    button.setAttribute('aria-busy', String(Boolean(busy)));
    button.title = blocked ? `Updates unavailable: ${availability.textContent} Open for status.` : 'Updates';
    for (const item of choices) item.setAttribute('aria-disabled', String(blocked));
    position();
  }

  listen(button, 'click', () => {
    if (opened) close();
    else open();
  });
  listen(button, 'keydown', (event) => {
    if (event.key !== 'ArrowDown' && event.key !== 'ArrowUp') return;
    event.preventDefault();
    event.stopPropagation();
    open(event.key === 'ArrowUp' ? choices.length - 1 : 0);
  });
  listen(menu, 'click', (event) => {
    const item = event.target.closest('[role="menuitem"]');
    if (!opened || blocked || !choices.includes(item)) return;
    const mode = item.dataset.mode;
    close();
    onSelect(mode);
  });
  listen(menu, 'keydown', (event) => {
    if (event.altKey || event.ctrlKey || event.metaKey || event.isComposing) return;
    const index = choices.indexOf(document.activeElement);
    let next;
    if (event.key === 'Home') next = 0;
    else if (event.key === 'End') next = choices.length - 1;
    else if (event.key === 'ArrowDown') next = (index + 1) % choices.length;
    else if (event.key === 'ArrowUp') next = (index - 1 + choices.length) % choices.length;
    else if (event.key === 'Tab') {
      close();
      return;
    } else return;
    event.preventDefault();
    event.stopPropagation();
    choices[next].focus();
  });
  listen(document, 'keydown', (event) => {
    if (!opened || event.key !== 'Escape') return;
    event.preventDefault();
    event.stopPropagation();
    close();
  }, { capture: true });
  listen(document, 'pointerdown', (event) => {
    if (opened && !popup.contains(event.target) && !button.contains(event.target)) close({ restoreFocus: false });
  }, { capture: true });
  listen(document, 'focusin', (event) => {
    if (opened && !popup.contains(event.target) && !button.contains(event.target)) close({ restoreFocus: false });
  });
  listen(window, 'resize', schedulePosition, { passive: true });
  listen(document, 'scroll', schedulePosition, { passive: true, capture: true });
  if (window.visualViewport) {
    listen(window.visualViewport, 'resize', schedulePosition, { passive: true });
    listen(window.visualViewport, 'scroll', schedulePosition, { passive: true });
  }
  const observer = new window.ResizeObserver(schedulePosition);
  observer.observe(popup);
  observer.observe(button);

  function dispose() {
    if (disposed) return;
    close();
    disposed = true;
    lifetime.abort();
    observer.disconnect();
    popup.remove();
    if (!hadTriggerClass) button.classList.remove('sidebar-update-trigger');
    for (const [name, value] of originalAttributes) {
      if (value === null) button.removeAttribute(name);
      else button.setAttribute(name, value);
    }
  }

  update();
  return { update, close, dispose };
}
