export const INSPECTOR_WIDTH_MIN = 240;
export const INSPECTOR_WIDTH_MAX = 640;
export const INSPECTOR_WIDTH_DEFAULT = 320;

/** Keep layout clamping separate from the user's explicitly committed width. */
export function createInspectorResize({ element, body, handle, onCommit }) {
  let preferred = INSPECTOR_WIDTH_DEFAULT;
  let drag = null;
  let enabled = false;
  let disposed = false;
  const removers = [];
  function bounds() {
    const available = body.getBoundingClientRect().width;
    // Match the CSS cap, including when a wide sidebar constrains the body.
    const max = Math.max(0, Math.min(INSPECTOR_WIDTH_MAX, Math.floor(available * 0.45), Math.floor(available - 320)));
    return { min: Math.min(INSPECTOR_WIDTH_MIN, max), max };
  }
  function clamp(value) {
    const { min, max } = bounds();
    return Math.max(min, Math.min(max, Math.round(value)));
  }
  const width = () => clamp(drag?.width ?? preferred);
  function render() {
    const { min, max } = bounds();
    const current = width();
    element.style.setProperty('--focused-inspector-width', `${current}px`);
    handle.setAttribute('aria-valuemin', String(min));
    handle.setAttribute('aria-valuemax', String(max));
    handle.setAttribute('aria-valuenow', String(current));
    handle.setAttribute('aria-valuetext', `${current} pixels`);
  }
  function save(value) {
    if (value === preferred) return;
    const previous = preferred;
    preferred = value;
    try {
      if (onCommit?.(value) === false) preferred = previous;
    } catch (error) {
      preferred = previous;
      throw error;
    } finally {
      render();
    }
  }
  function finish(commit) {
    if (!drag) return;
    const current = drag;
    drag = null;
    element.ownerDocument.removeEventListener('keydown', cancelOnEscape, true);
    element.classList.remove('focused-inspector-resizing');
    if (handle.hasPointerCapture(current.pointerId)) handle.releasePointerCapture(current.pointerId);
    if (commit && current.width !== current.start) save(clamp(current.width));
    else render();
  }
  function cancelOnEscape(event) {
    if (!drag || event.key !== 'Escape') return;
    event.preventDefault();
    event.stopPropagation();
    finish(false);
  }
  function listen(type, callback) {
    handle.addEventListener(type, callback);
    removers.push(() => handle.removeEventListener(type, callback));
  }
  listen('pointerdown', event => {
    if (!enabled || event.button !== 0 || drag) return;
    event.preventDefault();
    handle.focus({ preventScroll: true });
    drag = { pointerId: event.pointerId, x: event.clientX, start: width(), width: width() };
    handle.setPointerCapture(event.pointerId);
    element.ownerDocument.addEventListener('keydown', cancelOnEscape, true);
    element.classList.add('focused-inspector-resizing');
  });
  listen('pointermove', event => {
    if (!drag || drag.pointerId !== event.pointerId) return;
    drag.width = clamp(drag.start + drag.x - event.clientX);
    render();
  });
  listen('pointerup', event => {
    if (drag?.pointerId === event.pointerId) finish(true);
  });
  listen('pointercancel', event => {
    if (drag?.pointerId === event.pointerId) finish(false);
  });
  listen('lostpointercapture', () => finish(false));
  listen('dblclick', event => {
    if (!enabled) return;
    event.preventDefault();
    finish(false);
    save(INSPECTOR_WIDTH_DEFAULT);
  });
  listen('keydown', event => {
    if (!enabled || drag || !['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) return;
    event.preventDefault();
    const { min, max } = bounds();
    const step = event.shiftKey ? 50 : 10;
    const current = width();
    const next = clamp(event.key === 'Home' ? min : event.key === 'End' ? max
      : current + (event.key === 'ArrowLeft' ? step : -step));
    if (next !== current) save(next);
  });
  const observer = new element.ownerDocument.defaultView.ResizeObserver(render);
  observer.observe(body);
  return {
    update({ inspectorWidth, active }) {
      if (disposed) return;
      enabled = active;
      handle.hidden = !enabled;
      if (!enabled) finish(false);
      preferred = Number.isFinite(inspectorWidth)
        ? Math.max(INSPECTOR_WIDTH_MIN, Math.min(INSPECTOR_WIDTH_MAX, Math.round(inspectorWidth)))
        : INSPECTOR_WIDTH_DEFAULT;
      render();
    },
    dispose() {
      if (disposed) return;
      disposed = true;
      enabled = false;
      finish(false);
      observer.disconnect();
      for (const remove of removers) remove();
    },
  };
}
