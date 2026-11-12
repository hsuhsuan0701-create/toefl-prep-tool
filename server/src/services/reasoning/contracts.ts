import type {
  CancellationReason,
  ReasoningFailureKind,
  ReasoningProvider,
} from "@toefl-prep/shared";
export type { CancellationReason } from "@toefl-prep/shared";

const CANCELLATION_REASONS = new Set<string>([
  "user", "superseded", "parent_cancelled", "shutdown",
]);

function asCancellationReason(value: unknown): CancellationReason | undefined {
  return typeof value === "string" && CANCELLATION_REASONS.has(value)
    ? value as CancellationReason
    : undefined;
}

/**
 * Why a cancelled call stopped: the explicit reason, else the abort reason — a reason string, or a
 * `JobCancelledError` carrying one in `.reason` — else parent_cancelled.
 */
export function inferCancellationReason(
  signal?: AbortSignal,
  explicit?: CancellationReason,
): CancellationReason {
  if (explicit) return explicit;
  const reason: unknown = signal?.reason;
  const carried = typeof reason === "object" && reason !== null
    ? (reason as { reason?: unknown }).reason
    : undefined;
  return asCancellationReason(reason) ?? asCancellationReason(carried) ?? "parent_cancelled";
}

export type CliProvider = Extract<ReasoningProvider, "claude" | "codex">;

export type ReasoningFamily = "scoring" | "generation";

export interface ReasoningAttempt {
  provider: ReasoningProvider;
  kind: ReasoningFailureKind;
}

export interface ReasoningFailure<
  P extends ReasoningProvider = ReasoningProvider,
> extends ReasoningAttempt {
  provider: P;
  source: "call" | "circuit" | "preflight";
}

export type ProviderResult<
  T,
  P extends ReasoningProvider = ReasoningProvider,
> =
  | { ok: true; value: T; provider: P }
  | { ok: false; failure: ReasoningFailure<P> };

export type RouteResult<
  T,
  P extends ReasoningProvider = ReasoningProvider,
> =
  | {
      ok: true;
      value: T;
      provider: P;
      attempts: readonly ReasoningAttempt[];
    }
  | {
      ok: false;
      error: string;
      attempts: readonly ReasoningAttempt[];
    }
  | {
      ok: false;
      cancelled: true;
      reason: CancellationReason;
      error: string;
      attempts: readonly ReasoningAttempt[];
    };

export type ReasoningEvent =
  | {
      state: "queued";
      provider: CliProvider;
      queuePosition: number;
    }
  | {
      state: "running";
      provider: ReasoningProvider;
      fallbackFrom?: ReasoningProvider;
    }
  | {
      state: "fallback";
      provider: ReasoningProvider;
      fallbackFrom: ReasoningProvider;
      failureKind: ReasoningFailureKind;
    };

export const PROVIDER_LABELS: Readonly<Record<ReasoningProvider, string>> = {
  claude: "Claude",
  codex: "Codex",
  "openai-http": "OpenAI HTTP",
};

export const REASONING_FAILURE_KINDS = [
  "missing-cli",
  "authentication",
  "quota",
  "rate-limit",
  "provider",
  "timeout",
  "invalid-output",
  "configuration",
  "application",
] as const satisfies readonly ReasoningFailureKind[];

export function isReasoningFailureKind(
  value: unknown
): value is ReasoningFailureKind {
  return (
    typeof value === "string" &&
    (REASONING_FAILURE_KINDS as readonly string[]).includes(value)
  );
}

export type OwnPropertySnapshot =
  | { readonly present: false }
  | {
      readonly present: true;
      readonly value: unknown;
      readonly enumerable: boolean;
    };

export function snapshotOwnProperty(
  object: object,
  key: PropertyKey
): OwnPropertySnapshot {
  const descriptor = Object.getOwnPropertyDescriptor(object, key);
  if (descriptor === undefined) {
    return { present: false };
  }

  if (Object.hasOwn(descriptor, "value")) {
    return {
      present: true,
      value: descriptor.value,
      enumerable: descriptor.enumerable ?? false,
    };
  }

  return {
    present: true,
    enumerable: descriptor.enumerable ?? false,
    value:
      descriptor.get === undefined
        ? undefined
        : Reflect.apply(descriptor.get, object, []),
  };
}

export class ReasoningRouteError extends Error {
  readonly attempts: readonly ReasoningAttempt[];

  constructor(attempts: readonly ReasoningAttempt[]) {
    const normalizedAttempts = attempts.map(({ provider, kind }) =>
      Object.freeze({ provider, kind })
    );
    const detail = normalizedAttempts
      .map(({ provider, kind }) => `${PROVIDER_LABELS[provider]} (${kind})`)
      .join(" → ");
    super(
      detail.length > 0
        ? `Structured reasoning unavailable: ${detail}.`
        : "Structured reasoning unavailable."
    );
    this.name = "ReasoningRouteError";
    this.attempts = Object.freeze(normalizedAttempts);
  }
}

export function fallbackEligible(kind: ReasoningFailureKind): boolean {
  return kind !== "configuration" && kind !== "application";
}

export function opensCircuit(kind: ReasoningFailureKind): boolean {
  return (
    kind !== "configuration" &&
    kind !== "application" &&
    kind !== "invalid-output"
  );
}
