// The one place a failed request becomes a general sentence a person can act on. Surfaces that show
// a failure in words (a list that would not load, a Drill or Simulation error screen, a button that
// was refused) go through `requestErrorMessage`, so none of them prints an HTTP body.
//
// A request error is recognised by shape (an Error with a numeric `status`, which is what
// lib/api.ts's HttpError is) rather than by `instanceof`: test suites replace lib/api.ts wholesale,
// and this must still read the errors their stand-ins throw.

type StatusError = Error & { status: number };

function isStatusError(err: unknown): err is StatusError {
  return err instanceof Error && typeof (err as { status?: unknown }).status === "number";
}

/** The server's own reason, from a `{ "error": "…" }` body, when it is short enough to show. */
function serverReason(err: StatusError): string | null {
  const body = err.message.startsWith(`${err.status}:`) ? err.message.slice(`${err.status}:`.length).trim() : "";
  try {
    const parsed: unknown = JSON.parse(body);
    const reason = typeof parsed === "object" && parsed !== null ? (parsed as { error?: unknown }).error : undefined;
    return typeof reason === "string" && reason.length > 0 && reason.length <= 200 ? reason : null;
  } catch {
    return null;
  }
}

/**
 * What went wrong, in words, with what to do about it where there is something to do.
 *
 * - No answer at all (fetch's own TypeError) or a 5xx with an empty body: that is what the dev
 *   proxy produces when the server is not running, so the sentence asks whether it is.
 * - Any other 5xx: the server failed; its terminal has the detail.
 * - 404: the thing the address names is not there, which for a person means a stale link.
 * - Any other 4xx: refused, with the server's own short reason when it gave one ("attempt is
 *   already completed").
 * - Anything else: the error's own message, which this app's code writes as a sentence; a fault
 *   with no sentence of its own (a TypeError from a bug) is "Something went wrong."
 */
export function requestErrorMessage(err: unknown): string {
  if (isStatusError(err)) {
    const reason = serverReason(err);
    const hasBody = err.message.trim() !== `${err.status}:`;
    if (err.status >= 500 && !hasBody) return `The server didn't answer (HTTP ${err.status}). Is it running?`;
    if (err.status >= 500) return `The server hit an error (HTTP ${err.status}). Its terminal shows what went wrong.`;
    if (err.status === 404) return "Not found. The link may be out of date, or what it points to has been removed.";
    return reason ? `The request was refused: ${reason}.` : `The request was refused (HTTP ${err.status}).`;
  }
  // fetch() rejects with a TypeError when nothing answered, worded per browser ("Failed to fetch",
  // "NetworkError when attempting to fetch resource.", "Load failed"). Any other TypeError is a fault
  // in this app's own code, which the server has nothing to do with.
  if (err instanceof TypeError) return /fetch|network|load failed/i.test(err.message) ? "Can't reach the server. Is it running?" : "Something went wrong.";
  if (err instanceof Error && err.message) return err.message;
  return "Something went wrong.";
}
