const EDGE = 8;
const TRAY_GAP = 8;
const MAX_WIDTH = 416;
const POSITION_PROPERTIES = ['left', 'top', 'width', 'max-height'].map(name => `--focused-flyout-${name}`);
const LABEL = 'More composer actions';

/** Coordinates compact composer presentation. The caller owns visibility, focus and events. */
export function createFocusedComposerDisclosure({ document, trigger, panel, optionsTrigger, optionsPanel }) {
  const view = document.defaultView;
  let enabled = false;
  let open = false;
  let optionsOpen = false;
  let disposed = false;
  let frame = 0;
  let resizeObserver;
  let contentObserver;
  let presentation;

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
    if (visible(trigger) && visible(panel)) {
      const anchor = trigger.getBoundingClientRect();
      const send = trigger.parentElement?.querySelector('#sendButton');
      const right = send && visible(send) ? Math.min(bounds.right, send.getBoundingClientRect().left - TRAY_GAP) : bounds.right;
      const left = Math.max(bounds.left, Math.min(anchor.right + TRAY_GAP, right));
      setPosition(panel, 'left', left);
      setPosition(panel, 'width', Math.max(0, Math.min(MAX_WIDTH, right - left)));
      setPosition(panel, 'max-height', Math.max(0, Math.min(anchor.bottom, bounds.bottom) - bounds.top));
      const height = panel.getBoundingClientRect().height;
      setPosition(panel, 'top', Math.max(bounds.top, Math.min(anchor.bottom, bounds.bottom) - height));
    }
    if (optionsOpen && visible(optionsTrigger) && visible(optionsPanel)) {
      const anchor = optionsTrigger.getBoundingClientRect();
      const width = Math.min(MAX_WIDTH, bounds.right - bounds.left);
      const above = Math.max(0, anchor.top - bounds.top);
      const below = Math.max(0, bounds.bottom - anchor.bottom);
      setPosition(optionsPanel, 'width', width);
      setPosition(optionsPanel, 'max-height', Math.min(bounds.bottom - bounds.top, Math.max(above, below)));
      setPosition(optionsPanel, 'left', Math.max(bounds.left, Math.min(anchor.left, bounds.right - width)));
      const height = optionsPanel.getBoundingClientRect().height;
      // Touch the trigger edge so canonical pointerleave handlers do not close the menu in a gap.
      const top = above >= below ? anchor.top - height : anchor.bottom;
      setPosition(optionsPanel, 'top', Math.max(bounds.top, Math.min(top, bounds.bottom - height)));
    }
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
    resizeObserver.observe(optionsPanel);
    contentObserver = new view.MutationObserver(schedulePosition);
    contentObserver.observe(panel, {
      subtree: true, childList: true, characterData: true, attributes: true,
      attributeFilter: ['hidden', 'disabled', 'aria-hidden', 'aria-expanded', 'class'],
    });
    view.addEventListener('resize', schedulePosition);
    document.addEventListener('scroll', schedulePosition, true);
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
