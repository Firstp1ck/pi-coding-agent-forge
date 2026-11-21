/** Bound active probes while letting each caller's deadline cover its queue wait. */
export function verificationSlots(limit) {
  const queue = [];
  let active = 0;
  function drain() {
    while (active < limit && queue.length) {
      const entry = queue.shift();
      entry.signal?.removeEventListener('abort', entry.cancel);
      if (entry.signal?.aborted) { entry.reject(entry.signal.reason); continue; }
      active++;
      Promise.resolve().then(() => {
        entry.signal?.throwIfAborted();
        return entry.probe(entry.signal);
      }).then(entry.resolve, entry.reject).finally(() => { active--; drain(); });
    }
  }
  return (probe, signal) => new Promise((resolve, reject) => {
    signal?.throwIfAborted();
    const entry = { probe, signal, resolve, reject };
    entry.cancel = () => {
      const index = queue.indexOf(entry);
      if (index >= 0) queue.splice(index, 1);
      signal.removeEventListener('abort', entry.cancel);
      reject(signal.reason);
    };
    signal?.addEventListener('abort', entry.cancel, { once: true });
    queue.push(entry);
    drain();
  });
}
