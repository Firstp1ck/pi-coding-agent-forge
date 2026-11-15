export const NAVIGATION_WIDTH_MIN = 180;
export const NAVIGATION_WIDTH_MAX = 420;
export const NAVIGATION_WIDTH_DEFAULT = 202;

/** Resize presentation immediately; persist only explicit completed changes. */
export function createNavigationResize({ element, handle, onCommit }) {
  let preferred = NAVIGATION_WIDTH_DEFAULT;
  let drag = null;
  let enabled = false;
  let disposed = false;
  const removers = [];
  const limit = () => Math.max(NAVIGATION_WIDTH_MIN,
    Math.min(NAVIGATION_WIDTH_MAX, Math.floor(element.getBoundingClientRect().width - 46 - 480)));
  const clamp = value => Math.max(NAVIGATION_WIDTH_MIN, Math.min(limit(), Math.round(value)));
  const width = () => clamp(drag?.width ?? preferred);
  function render() {
    element.style.setProperty('--focused-navigation-width', `${width()}px`);
    handle.setAttribute('aria-valuemin', String(NAVIGATION_WIDTH_MIN));
    handle.setAttribute('aria-valuemax', String(limit()));
    handle.setAttribute('aria-valuenow', String(width()));
    handle.setAttribute('aria-valuetext', `${width()} pixels`);
  }
  function listen(type, callback) {
    handle.addEventListener(type, callback);
    removers.push(() => handle.removeEventListener(type, callback));
  }
  function finish(commit) {
    if (!drag) return;
    const current = drag;
    drag = null;
    element.classList.remove('focused-navigation-resizing');
    if (handle.hasPointerCapture(current.pointerId)) handle.releasePointerCapture(current.pointerId);
    if (commit) save(clamp(current.width));
    else render();
  }
  function save(value) {
    const previous = preferred;
    preferred = value;
    if (onCommit?.(value) === false) preferred = previous;
    render();
  }
  listen('pointerdown', event => {
    if (!enabled || event.button !== 0 || drag) return;
    event.preventDefault();
    handle.focus({ preventScroll: true });
    drag = { pointerId: event.pointerId, x: event.clientX, start: width(), width: width() };
    handle.setPointerCapture(event.pointerId);
    element.classList.add('focused-navigation-resizing');
  });
  listen('pointermove', event => {
    if (!drag || drag.pointerId !== event.pointerId) return;
    drag.width = clamp(drag.start + event.clientX - drag.x);
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
    save(NAVIGATION_WIDTH_DEFAULT);
  });
  listen('keydown', event => {
    if (!enabled) return;
    if (event.key === 'Escape' && drag) {
      event.preventDefault();
      event.stopPropagation();
      finish(false);
      return;
    }
    if (drag || !['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) return;
    event.preventDefault();
    const step = event.shiftKey ? 50 : 10;
    const next = event.key === 'Home' ? NAVIGATION_WIDTH_MIN : event.key === 'End' ? limit()
      : width() + (event.key === 'ArrowLeft' ? -step : step);
    save(clamp(next));
  });
  const observer = new element.ownerDocument.defaultView.ResizeObserver(render);
  observer.observe(element);
  return {
    update({ navigationWidth, active }) {
      if (disposed) return;
      enabled = active;
      handle.hidden = !enabled;
      if (!enabled) finish(false);
      preferred = Number.isInteger(navigationWidth)
        ? Math.max(NAVIGATION_WIDTH_MIN, Math.min(NAVIGATION_WIDTH_MAX, navigationWidth))
        : NAVIGATION_WIDTH_DEFAULT;
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
