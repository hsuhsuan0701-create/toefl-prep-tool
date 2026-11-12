import { CAPTURE_RETRY_BUDGET_MS, CAPTURE_RETRY_MAX_DELAY_MS, captureRetryDelayMs, type RetryClock } from "../lib/captureRetry";

/**
 * What the Speaking Simulation records for an Item once its upload has settled.
 *
 * - `done`             — accepted and transcribed; scoreable now.
 * - `recovery-pending` — accepted (HTTP 202); the server's own transcription recovery owns it.
 * - `rejected`         — the server inspected the bytes and refused them (HTTP 400).
 * - `unsent`           — never reached the server, however long it was kept and retried.
 * - `not-captured`     — never recorded, because the app could not play its prompt or open the
 *                        microphone and the User skipped it from there.
 */
export type SimUploadOutcome = "done" | "recovery-pending" | "rejected" | "unsent" | "not-captured";

/**
 * The Items this browser could not land on the server for the app's own reasons: a recording it
 * could not send, or an Item it could not capture at all.
 *
 * Reported to POST /:id/capture-finished, where it is the only thing separating an app failure from
 * a deliberate skip: both leave the server with no row for the Item, and only the browser knows
 * which it was. An Item named here is recorded as failed, so the Attempt gets no Band Estimate
 * rather than a 0 for the app's failure; every other missing Item is a skip, scored 0, as an
 * unanswered Item is on the real exam.
 *
 * "recovery-pending" is left out: a durably accepted recording already has a server row and its own
 * transcription job, and naming it here would say something false about an Item that is fine.
 */
export function lostUploadItemIds(results: Record<string, SimUploadOutcome>): string[] {
  return Object.entries(results)
    .filter(([, outcome]) => outcome === "rejected" || outcome === "unsent" || outcome === "not-captured")
    .map(([itemId]) => itemId);
}

type UploadResult =
  | { ok: true; data: unknown }
  | { ok: false; kind: "needs-rerecord" | "retryable" | "recovery-pending"; message: string };

/**
 * Uploads one recording, retrying transient failures within one wall-clock budget.
 *
 * Only `retryable` is retried. `needs-rerecord` means the server inspected the bytes and rejected
 * them (HTTP 400), so resending identical audio cannot help; `recovery-pending` means it is already
 * durably saved and a retry would upload it twice.
 */
export async function uploadWithRetry(
  upload: () => Promise<UploadResult>,
  clock: RetryClock,
  budgetMs: number = CAPTURE_RETRY_BUDGET_MS,
): Promise<SimUploadOutcome> {
  const deadline = clock.now() + budgetMs;
  for (let attemptNumber = 1; ; attemptNumber += 1) {
    try {
      const result = await upload();
      if (result.ok) return "done";
      if (result.kind === "recovery-pending") return "recovery-pending";
      if (result.kind === "needs-rerecord") return "rejected";
    } catch {
      // A thrown fetch is a network failure, which is exactly what a retry is for.
    }
    const now = clock.now();
    if (now >= deadline) return "unsent";
    await clock.sleep(Math.min(captureRetryDelayMs(attemptNumber), deadline - now));
  }
}

/**
 * Uploads one Speaking Simulation recording and keeps it until the server has it or the section is
 * over.
 *
 * A Simulation cannot stop for a Retry button: the exam clock runs and the User is already on the
 * next Item. So a recording whose first budget runs out is not dropped — it is kept and tried again
 * every CAPTURE_RETRY_MAX_DELAY_MS for the rest of the section, and once `sectionEnded` resolves it
 * gets one more full budget, started after the section ended. Only what still cannot be sent then is
 * `unsent`.
 */
export async function uploadUntilSectionEnds(
  upload: () => Promise<UploadResult>,
  clock: RetryClock,
  sectionEnded: Promise<void>,
): Promise<SimUploadOutcome> {
  let ended = false;
  void sectionEnded.then(() => {
    ended = true;
  });
  for (;;) {
    const startedAfterEnd = ended;
    const outcome = await uploadWithRetry(upload, clock);
    if (outcome !== "unsent" || startedAfterEnd) return outcome;
    if (!ended) await Promise.race([sectionEnded, clock.sleep(CAPTURE_RETRY_MAX_DELAY_MS)]);
  }
}
