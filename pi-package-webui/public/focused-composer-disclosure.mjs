const EDGE = 8;
const TRAY_GAP = 8;
const OPTIONS_WIDTH = 416;
const POSITION_PROPERTIES = ['left', 'top', 'width', 'max-height'].map(name => `--focused-flyout-${name}`);
const LABEL = 'More composer actions';

/** Positions canonical composer controls. The caller owns menu visibility and action dispatch. */
export function createFocusedComposerDisclosure({ document, trigger, panel, optionsPanel }) {
  const view = document.defaultView;
  let enabled = false;
  let open = false;
  let optionsOpen = false;
  let disposed = false;
  let frame = 0;
  let resizeObserver;
  let contentObserver;
  let presentation;
  let pendingMenuFocus;
  const positionedMenus = new Set();

  function clearPosition(element) {
    for (const property of POSITION_PROPERTIES) element.style.removeProperty(property);
  }

  function setPosition(element, name, value) {
    const property = `--focused-flyout-${name}`;
    const pixels = `${Math.round(value * 100) / 100}px`;
    if (element.style.getPropertyValue(property) !== pixels) element.style.setProperty(property, pixels);
  }

  function visible(element) {
    return element.isConnected && element.getClientRects().length > 0 && view.getComputedStyle(element).visibility !== 'hidden';
  }

  function viewport() {
    const visual = view.visualViewport;
    const left = (visual?.offsetLeft || 0) + EDGE;
    const top = (visual?.offsetTop || 0) + EDGE;
    return {
      left, top,
      right: left + (visual?.width || view.innerWidth) - EDGE * 2,
      bottom: top + (visual?.height || view.innerHeight) - EDGE * 2,
    };
  }

  function position() {
    if (!enabled || !open) return;
    const bounds = viewport();
    for (const menuPanel of positionedMenus) {
      if (panel.contains(menuPanel)) continue;
      clearPosition(menuPanel);
      positionedMenus.delete(menuPanel);
    }
    if (visible(trigger) && visible(panel)) {
      const anchor = trigger.getBoundingClientRect();
      const send = trigger.parentElement?.querySelector('#sendButton');
      const right = send && visible(send) ? Math.min(bounds.right, send.getBoundingClientRect().left - TRAY_GAP) : bounds.right;
      const left = Math.max(bounds.left, Math.min(anchor.right + TRAY_GAP, right));
      setPosition(panel, 'left', left);
      setPosition(panel, 'width', Math.max(0, right - left));
      setPosition(panel, 'max-height', Math.max(0, Math.min(anchor.bottom, bounds.bottom) - bounds.top));
      const height = panel.getBoundingClientRect().height;
      setPosition(panel, 'top', Math.max(bounds.top, Math.min(anchor.bottom, bounds.bottom) - height));
    }
    for (const menu of panel.querySelectorAll(':scope > .composer-publish-menu')) {
      const menuTrigger = menu.querySelector(':scope > button[aria-haspopup="menu"]');
      const menuPanel = menu.querySelector(':scope > .composer-publish-menu-panel');
      if (!menuTrigger || !menuPanel) continue;
      if (!visible(menuTrigger) || !visible(menuPanel)) {
        clearPosition(menuPanel);
        continue;
      }
      positionedMenus.add(menuPanel);
      const anchor = menuTrigger.getBoundingClientRect();
      const preferredWidth = menuPanel === optionsPanel ? OPTIONS_WIDTH
        : menu.classList.contains('composer-app-runner-menu') ? 352 : 224;
      const width = Math.min(preferredWidth, bounds.right - bounds.left);
      const above = Math.max(0, anchor.top - bounds.top);
      const below = Math.max(0, bounds.bottom - anchor.bottom);
      setPosition(menuPanel, 'width', width);
      setPosition(menuPanel, 'max-height', Math.max(above, below));
      setPosition(menuPanel, 'left', Math.max(bounds.left, Math.min(anchor.left, bounds.right - width)));
      const height = menuPanel.getBoundingClientRect().height;
      // Share an edge with the trigger so native pointerleave does not close the menu in transit.
      const top = above >= below ? anchor.top - height : anchor.bottom;
      setPosition(menuPanel, 'top', Math.max(bounds.top, Math.min(top, bounds.bottom - height)));
      if (pendingMenuFocus?.trigger === menuTrigger && menuTrigger.getAttribute('aria-expanded') === 'true') {
        const items = menuItems(menuPanel);
        const target = pendingMenuFocus.last ? items.at(-1) : items[0];
        pendingMenuFocus = null;
        target?.focus({ preventScroll: true });
      }
    }
  }

  function menuItems(menuPanel) {
    return [...menuPanel.querySelectorAll('button:not(:disabled), [role="menuitem"]:not([aria-disabled="true"])')]
      .filter(item => !item.disabled && item.getAttribute('aria-disabled') !== 'true' && visible(item) && !item.closest('[hidden]'));
  }

  function handleMenuKeydown(event) {
    if (!enabled || !open || event.defaultPrevented) return;
    const menu = event.target.closest('.composer-publish-menu');
    if (!menu || menu.parentElement !== panel) return;
    const menuTrigger = menu.querySelector(':scope > button[aria-haspopup="menu"]');
    const controlledId = menuTrigger?.getAttribute('aria-controls');
    const menuPanel = (controlledId && document.getElementById(controlledId))
      || menu.querySelector(':scope > .composer-publish-menu-panel');
    if (!menuTrigger || !menuPanel || !['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(event.key)) return;
    if (event.target === menuTrigger) {
      // An explicit keyboard opening ends the native Escape hover/focus suppression.
      menu.classList.remove('menu-dismissed');
      if (menuPanel === optionsPanel) return;
      if (menuTrigger.getAttribute('aria-expanded') !== 'true') {
        event.preventDefault();
        pendingMenuFocus = { trigger: menuTrigger, last: ['ArrowUp', 'End'].includes(event.key) };
        menuTrigger.click();
        schedulePosition();
        return;
      }
    }
    if (menuPanel === optionsPanel || (event.target !== menuTrigger && !menuPanel.contains(event.target))) return;
    const items = menuItems(menuPanel);
    if (!items.length) return;
    event.preventDefault();
    const index = items.indexOf(document.activeElement);
    const next = event.key === 'Home' ? 0 : event.key === 'End' ? items.length - 1
      : (index + (event.key === 'ArrowUp' ? -1 : 1) + items.length) % items.length;
    items[index < 0 && event.key === 'ArrowUp' ? items.length - 1 : next].focus({ preventScroll: true });
    position();
  }

  function schedulePosition() {
    if (!frame) frame = view.requestAnimationFrame(() => {
      frame = 0;
      position();
    });
  }

  function stopWatching() {
    resizeObserver?.disconnect();
    contentObserver?.disconnect();
    resizeObserver = null;
    contentObserver = null;
    view.removeEventListener('resize', schedulePosition);
    document.removeEventListener('scroll', schedulePosition, true);
    panel.removeEventListener('keydown', handleMenuKeydown, true);
    pendingMenuFocus = null;
    view.visualViewport?.removeEventListener('resize', schedulePosition);
    view.visualViewport?.removeEventListener('scroll', schedulePosition);
    if (frame) view.cancelAnimationFrame(frame);
    frame = 0;
  }

  function startWatching() {
    if (resizeObserver) return;
    resizeObserver = new view.ResizeObserver(schedulePosition);
    for (let node = trigger; node; node = node.parentElement) resizeObserver.observe(node);
    resizeObserver.observe(panel);
    for (const menuPanel of panel.querySelectorAll(':scope > .composer-publish-menu > .composer-publish-menu-panel')) {
      resizeObserver.observe(menuPanel);
    }
    contentObserver = new view.MutationObserver(schedulePosition);
    contentObserver.observe(panel, {
      subtree: true, childList: true, characterData: true, attributes: true,
      attributeFilter: ['hidden', 'disabled', 'aria-hidden', 'aria-expanded', 'class'],
    });
    view.addEventListener('resize', schedulePosition);
    document.addEventListener('scroll', schedulePosition, true);
    panel.addEventListener('keydown', handleMenuKeydown, true);
    view.visualViewport?.addEventListener('resize', schedulePosition);
    view.visualViewport?.addEventListener('scroll', schedulePosition);
  }

  function restorePresentation() {
    if (!presentation) return;
    if (trigger.textContent === 'More') trigger.textContent = presentation.text;
    for (const name of ['aria-label', 'title', 'data-focused-disclosure']) {
      if (name !== 'data-focused-disclosure' && trigger.getAttribute(name) !== LABEL) continue;
      const value = presentation[name];
      if (value === null) trigger.removeAttribute(name);
      else trigger.setAttribute(name, value);
    }
    presentation = null;
  }

  function update(state) {
    if (disposed) return;
    enabled = state.enabled;
    open = state.open;
    optionsOpen = state.optionsOpen;
    if (enabled) {
      presentation ||= {
        text: trigger.textContent,
        'aria-label': trigger.getAttribute('aria-label'),
        title: trigger.getAttribute('title'),
        'data-focused-disclosure': trigger.getAttribute('data-focused-disclosure'),
      };
      trigger.textContent = 'More';
      trigger.setAttribute('aria-label', LABEL);
      trigger.title = LABEL;
      trigger.setAttribute('data-focused-disclosure', open ? 'open' : 'closed');
    } else restorePresentation();
    if (enabled && open) {
      startWatching();
      position();
    } else {
      stopWatching();
      clearPosition(panel);
      for (const menuPanel of positionedMenus) clearPosition(menuPanel);
      positionedMenus.clear();
    }
    if (!enabled || !open || !optionsOpen) clearPosition(optionsPanel);
  }

  function dispose() {
    if (disposed) return;
    update({ enabled: false, open: false, optionsOpen: false });
    disposed = true;
  }

  return { update, dispose };
}
