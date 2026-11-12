import type { ReasoningFailureKind } from "@toefl-prep/shared";
import type { ReasoningFamily } from "./contracts.js";

export type CircuitAdmission =
  | { readonly kind: "admit" }
  | { readonly kind: "hold" }
  | { readonly kind: "probe" }
  | { readonly kind: "reject"; readonly failureKind: ReasoningFailureKind; readonly retryAtMs: number };

export interface CircuitSnapshot {
  readonly state: "closed" | "open" | "probing";
  readonly failureKind?: ReasoningFailureKind;
  readonly openedAtMs?: number;
  readonly retryAtMs?: number;
  readonly probeOwner?: string;
}

export interface PersistedHardQuotaCircuit {
  readonly failureKind: "quota";
  readonly resetAtMs: number;
}

/**
 * How long a held request sleeps between re-checks while ANOTHER request owns the recovery probe.
 *
 * While probing, `retryAtMs` is deliberately left in the past — it is the moment the probe was
 * claimed, not a future transition — and the two things a holder is waiting for (the probe closing
 * the circuit, or a cancelled probe relinquishing ownership) are events with no clock behind them.
 * A wait keyed to `retryAtMs` would spin at its 1 ms floor for the whole probe, up to 750 s for a
 * generation probe. One second keeps a relinquished probe from stalling recovery for long while
 * costing at most ~600 no-op `admit()` calls per held request over the 10-minute hold ceiling.
 */
export const PROBE_RECHECK_MS = 1_000;

/** Provider-wide availability policy, independent of queueing and invocation. */
export class ProviderCircuit {
  private state: "closed" | "open" | "probing" = "closed";
  private failureKind?: ReasoningFailureKind;
  private openedAtMs?: number;
  private retryAtMs?: number;
  private probeOwner?: string;
  private hardQuotaResetAtMs?: number;
  private cooldownIndex = 0;
  private openings = 0;
  private readonly held = new Map<string, { family: ReasoningFamily; queuedAtMs: number }>();
  private readonly now: () => number;
  private readonly cooldownsMs: readonly number[];
  private readonly holdMaxMs: number;

  constructor(options?: {
    readonly now?: () => number;
    readonly cooldownsMs?: readonly number[];
    readonly holdMaxMs?: number;
  }) {
    this.now = options?.now ?? Date.now;
    this.cooldownsMs = options?.cooldownsMs ?? [60_000, 120_000, 300_000, 600_000];
    this.holdMaxMs = options?.holdMaxMs ?? 600_000;
    if (
      this.cooldownsMs.length === 0 ||
      this.cooldownsMs.some((value) => !Number.isInteger(value) || value <= 0 || value > 600_000)
    ) {
      throw new RangeError("cooldownsMs must contain positive integers capped at 600000");
    }
  }

  open(kind: ReasoningFailureKind, resetAtMs?: number): void {
    const now = this.now();
    const preservedQuotaReset = kind === "quota" && resetAtMs === undefined && this.hardQuotaResetAtMs !== undefined && this.hardQuotaResetAtMs + 5_000 > now
      ? this.hardQuotaResetAtMs
      : undefined;
    const effectiveResetAtMs = resetAtMs ?? preservedQuotaReset;
    this.state = "open";
    this.failureKind = kind;
    this.openedAtMs = now;
    const fallback = this.cooldownsMs[Math.min(this.cooldownIndex, this.cooldownsMs.length - 1)]!;
    this.retryAtMs = effectiveResetAtMs !== undefined && effectiveResetAtMs + 5_000 > now ? effectiveResetAtMs + 5_000 : now + fallback;
    this.hardQuotaResetAtMs = kind === "quota" && effectiveResetAtMs !== undefined && effectiveResetAtMs + 5_000 > now
      ? effectiveResetAtMs
      : undefined;
    this.probeOwner = undefined;
    this.openings += 1;
  }

  /**
   * How many times this circuit has opened, a failed probe's reopening included. A request admitted
   * under an earlier count was admitted before the current opening, so what it reports is older than
   * the evidence that opened the circuit, and older than any probe since.
   */
  opening(): number {
    return this.openings;
  }

  close(): void {
    this.state = "closed";
    this.failureKind = undefined;
    this.openedAtMs = undefined;
    this.retryAtMs = undefined;
    this.probeOwner = undefined;
    this.hardQuotaResetAtMs = undefined;
    this.cooldownIndex = 0;
    this.held.clear();
  }

  /**
   * While the cooldown runs, work that was already queued when the circuit opened waits (up to the
   * hold ceiling) and anything submitted after it opened is rejected at once so it can fall back.
   * Once the cooldown ends, the next request becomes the recovery probe, whether or not anything was
   * queued — for a single user nothing usually is. A live held request still goes first: scoring
   * before generation, then the oldest. A held request that wins the probe takes it even if its hold
   * has run out, because the longest cooldown ends exactly where the hold ceiling does.
   */
  admit(request: {
    readonly requestId?: string;
    readonly queuedAtMs: number;
    readonly wasQueuedWhenOpened: boolean;
    readonly family?: ReasoningFamily;
  }): CircuitAdmission {
    if (this.state === "closed") return { kind: "admit" };
    const now = this.now();
    if (this.state === "open" && now >= this.retryAtMs!) this.state = "probing";
    const failureKind = this.failureKind!;
    const retryAtMs = this.retryAtMs!;
    const mayHold = request.wasQueuedWhenOpened && !this.holdExpired(now);
    const holdOrReject = (): CircuitAdmission => {
      if (!mayHold) {
        if (request.requestId) this.held.delete(request.requestId);
        return { kind: "reject", failureKind, retryAtMs };
      }
      if (request.requestId) {
        this.held.set(request.requestId, { family: request.family ?? "generation", queuedAtMs: request.queuedAtMs });
      }
      return { kind: "hold" };
    };

    if (this.state === "open") return holdOrReject();
    if (this.probeOwner !== undefined) {
      return this.probeOwner === request.requestId ? { kind: "probe" } : holdOrReject();
    }
    if (request.requestId === undefined || this.preferredProbe(request) !== request.requestId) {
      return holdOrReject();
    }
    this.probeOwner = request.requestId;
    this.held.delete(request.requestId);
    return { kind: "probe" };
  }

  /** Forgets a held request that will never come back for its verdict (it was cancelled). */
  release(requestId: string): void {
    this.held.delete(requestId);
  }

  private holdExpired(now: number): boolean {
    return this.openedAtMs !== undefined && now - this.openedAtMs > this.holdMaxMs;
  }

  private preferredProbe(request: {
    readonly requestId?: string;
    readonly queuedAtMs: number;
    readonly family?: ReasoningFamily;
  }): string | undefined {
    const candidates = [...this.held.entries()].filter(([id]) => id !== request.requestId);
    if (request.requestId !== undefined) {
      candidates.push([request.requestId, { family: request.family ?? "generation", queuedAtMs: request.queuedAtMs }]);
    }
    candidates.sort(([, a], [, b]) =>
      a.family === b.family ? a.queuedAtMs - b.queuedAtMs : a.family === "scoring" ? -1 : 1);
    return candidates[0]?.[0];
  }

  recordProbe(requestId: string, outcome: "success" | "failure" | "cancelled"):
    { readonly resumed: boolean; readonly capacity?: number } {
    if (this.state !== "probing" || this.probeOwner !== requestId) return { resumed: false };
    this.held.delete(requestId);
    if (outcome === "success") {
      this.close();
      return { resumed: true, capacity: 2 };
    }
    this.probeOwner = undefined;
    if (outcome === "cancelled") return { resumed: false };
    this.cooldownIndex = Math.min(this.cooldownIndex + 1, this.cooldownsMs.length - 1);
    this.open(this.failureKind ?? "provider");
    return { resumed: false };
  }

  /**
   * The earliest moment at which a held request's `admit()` verdict can differ from `hold`.
   *
   * Callers must not derive this from `retryAtMs`: that field answers "when did/does the cooldown
   * end", which is only a future transition while the circuit is OPEN. The hold ceiling is folded in
   * because expiring into a rejection is itself a verdict change, so a holder never sleeps past it.
   */
  nextEligibleAtMs(): number {
    const now = this.now();
    if (this.state === "closed") return now;
    const holdExpiryAtMs = this.openedAtMs === undefined
      ? Number.POSITIVE_INFINITY
      : this.openedAtMs + this.holdMaxMs + 1;
    const nextTransitionAtMs = this.state === "open"
      ? this.retryAtMs ?? now
      : now + PROBE_RECHECK_MS;
    return Math.max(now, Math.min(nextTransitionAtMs, holdExpiryAtMs));
  }

  snapshot(): CircuitSnapshot {
    return Object.freeze({
      state: this.state,
      ...(this.failureKind === undefined ? {} : { failureKind: this.failureKind }),
      ...(this.openedAtMs === undefined ? {} : { openedAtMs: this.openedAtMs }),
      ...(this.retryAtMs === undefined ? {} : { retryAtMs: this.retryAtMs }),
      ...(this.probeOwner === undefined ? {} : { probeOwner: this.probeOwner }),
    });
  }

  persistentState(): PersistedHardQuotaCircuit | undefined {
    return this.hardQuotaResetAtMs === undefined
      ? undefined
      : Object.freeze({ failureKind: "quota", resetAtMs: this.hardQuotaResetAtMs });
  }
}
