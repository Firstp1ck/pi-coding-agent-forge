import { setTimeout as delay } from 'node:timers/promises';
import { performance } from 'node:perf_hooks';
import { failureCode } from './auth.mjs';
import { missing } from './process.mjs';

const transient = error => error.timedOut || missing(error)
  || /^(ECONN|ETIMEDOUT$|EAI_AGAIN$|ENOTFOUND$|EHOSTUNREACH$|EPIPE$|E408$|E429$|E5\d\d$)/.test(failureCode(error) ?? '');

/** Poll visibility and artifact checks within one cancellable verification window. */
export async function monitorPublication(check, {
  timeout, signal, onWait = () => {}, now = () => performance.now(), wait = delay,
}) {
  const deadline = AbortSignal.timeout(Math.ceil(timeout));
  const combined = signal ? AbortSignal.any([signal, deadline]) : deadline;
  const started = now();
  let interval = Math.min(10_000, Math.max(1, timeout / 10));
  try {
    for (;;) {
      combined.throwIfAborted();
      try { if (await check(combined)) return true; }
      catch (error) {
        if (combined.aborted || !transient(error)) throw error;
      }
      const elapsed = now() - started, remaining = timeout - elapsed;
      if (remaining <= 0) return false;
      const pause = Math.min(interval, remaining);
      onWait({ elapsed, pause });
      await wait(pause, undefined, { signal: combined });
      interval = Math.min(30_000, interval * 1.5);
    }
  } catch (error) {
    if (signal?.aborted) throw Object.assign(new Error('Release cancelled while awaiting registry confirmation; upload receipt retained'), { cancelled: true });
    if (deadline.aborted) return false;
    throw error;
  }
}
