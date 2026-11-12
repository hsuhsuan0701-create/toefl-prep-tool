/**
 * A backoff sleep that leaves nothing behind on the signal.
 *
 * Retry loops call it many times against one long-lived per-job abort signal. The obvious inline form,
 * `signal.addEventListener("abort", …)` inside the executor, would leave a listener behind on every
 * wait the timer wins (`{ once: true }` removes it only when the abort fires), holding each closure
 * alive for the whole job and tripping Node's warning past ten listeners. This removes its listener
 * when the timer fires.
 *
 * Rejects with `signal.reason` if the signal is already aborted, so cancellation behaves the same
 * whether it arrived before or during the wait.
 */
export function abortableDelay(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    if (signal?.aborted) {
      reject(signal.reason);
      return;
    }
    const onAbort = () => {
      clearTimeout(timer);
      reject(signal!.reason);
    };
    const timer = setTimeout(() => {
      signal?.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}
