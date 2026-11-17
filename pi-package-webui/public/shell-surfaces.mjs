const FOCUSABLE_SELECTOR = 'a[href], button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])';
const OWNED_ATTRIBUTES = ['role', 'tabindex', 'aria-modal'];

/** Coordinates drawer focus only; native modal dialogs retain browser ownership. */
export function createSurfaceCoordinator({ document, getFocusableElements, onEscape }) {
  let active = null;
  let disposed = false;
  let focusGeneration = 0;

  function canFocus(element) {
    if (!element?.isConnected || element.closest('[hidden], [inert]') || element.disabled) return false;
    const style = document.defaultView.getComputedStyle(element);
    return style.visibility !== 'hidden' && style.visibility !== 'collapse' && element.getClientRects().length > 0;
  }

  function handleKeydown(event) {
    if (!active || event.defaultPrevented || document.querySelector('dialog:modal') || !canFocus(active.surface)) return;
    if (event.key === 'Escape') {
      const record = active;
      event.preventDefault();
      if (onEscape?.(record.surface, event) === true) {
        event.stopPropagation();
        return;
      }
      record.close?.();
      return;
    }
    if (event.key !== 'Tab') return;
    const { surface } = active;
    const focusable = [...(getFocusableElements ? getFocusableElements(surface) : surface.querySelectorAll(FOCUSABLE_SELECTOR))]
      .filter(element => canFocus(element) && element.tabIndex >= 0);
    if (!focusable.length) {
      event.preventDefault();
      surface.focus({ preventScroll: true });
      return;
    }
    const first = focusable[0];
    const last = focusable[focusable.length - 1];
    const focused = document.activeElement;
    if (!focusable.includes(focused)) {
      event.preventDefault();
      (event.shiftKey ? last : first).focus({ preventScroll: true });
    } else if (event.shiftKey && focused === first) {
      event.preventDefault();
      last.focus({ preventScroll: true });
    } else if (!event.shiftKey && focused === last) {
      event.preventDefault();
      first.focus({ preventScroll: true });
    }
  }

  function release() {
    const record = active;
    active = null;
    for (const [name, value] of record.attributes) {
      if (value === null) record.surface.removeAttribute(name);
      else record.surface.setAttribute(name, value);
    }
    document.removeEventListener('keydown', handleKeydown, true);
    return record.trigger;
  }

  function activate(surface, trigger, { close } = {}) {
    if (disposed) return;
    focusGeneration += 1;
    if (active?.surface === surface) {
      active.trigger = trigger;
      active.close = close;
      return;
    }
    if (active) release();
    active = { surface, trigger, close, attributes: OWNED_ATTRIBUTES.map((name) => [name, surface.getAttribute(name)]) };
    surface.setAttribute('role', 'dialog');
    surface.setAttribute('aria-modal', 'true');
    surface.setAttribute('tabindex', '-1');
    document.addEventListener('keydown', handleKeydown, true);
  }

  function deactivate(surface, { restoreFocus = true } = {}) {
    if (active?.surface !== surface) return;
    const trigger = release();
    const generation = ++focusGeneration;
    if (restoreFocus) {
      queueMicrotask(() => {
        if (generation !== focusGeneration || !canFocus(trigger)) return;
        const modal = document.querySelector('dialog:modal');
        if (!modal || modal.contains(trigger)) trigger.focus({ preventScroll: true });
      });
    }
  }

  function dispose() {
    focusGeneration += 1;
    if (active) release();
    disposed = true;
  }

  return { activate, deactivate, dispose };
}
