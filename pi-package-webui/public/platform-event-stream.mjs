/**
 * Own one EventSource without interpreting its events. Callbacks receive the
 * original event and captured context. Stale or disposed connects return null;
 * successful connects return the source. Factory and callback errors propagate.
 */
export function createSessionEventStream({ createSource, isCurrent, onOpen = () => {}, onMessage = () => {}, onError = () => {} } = {}) {
  if ([createSource, isCurrent, onOpen, onMessage, onError].some((callback) => typeof callback !== "function")) {
    throw new TypeError("Event stream requires a source factory and context/callback functions");
  }

  let owner = null;
  let disposed = false;

  function release(source) {
    if (!source) return;
    source.onopen = null;
    source.onmessage = null;
    source.onerror = null;
    source.close();
  }

  function close() {
    const previous = owner;
    owner = null;
    release(previous?.source);
  }

  return {
    connect(url, context) {
      if (disposed || !isCurrent(context)) return null;
      close();
      const next = { source: null, context };
      owner = next;
      try {
        next.source = createSource(url);
      } catch (error) {
        if (owner === next) owner = null;
        throw error;
      }

      // Construction may invalidate the context or close/replace this owner.
      if (disposed || owner !== next || !isCurrent(context)) {
        if (owner === next) owner = null;
        release(next.source);
        return null;
      }

      const forward = (callback) => (event) => {
        if (!disposed && owner === next && isCurrent(next.context)) callback(event, next.context);
      };
      next.source.onopen = forward(onOpen);
      next.source.onmessage = forward(onMessage);
      next.source.onerror = forward(onError);
      return next.source;
    },
    close,
    dispose() {
      if (disposed) return;
      disposed = true;
      close();
    },
    get source() { return owner?.source ?? null; },
  };
}
