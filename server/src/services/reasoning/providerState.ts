import type { ReasoningFailureKind } from "@toefl-prep/shared";
import {
  isReasoningFailureKind,
  opensCircuit,
  snapshotOwnProperty,
  type CliProvider,
  type ProviderResult,
  type ReasoningEvent,
} from "./contracts.js";
import { AdmissionScheduler } from "./admissionScheduler.js";
import { AdaptiveCapacity } from "./adaptiveCapacity.js";
import { ProviderCircuit } from "./providerCircuit.js";
import type { PersistedHardQuotaCircuit } from "./providerCircuit.js";
import { abortableDelay } from "../../lib/abortableDelay.js";
import { config } from "../../lib/config.js";
import type { ReasoningFamily } from "./contracts.js";

export const CIRCUIT_MS = 10 * 60 * 1_000;

export interface ProviderAvailabilitySnapshot {
  readonly provider: CliProvider;
  readonly availability: "checking" | "available" | "circuit-open";
  readonly failureKind?: ReasoningFailureKind;
  readonly retryAtMs?: number;
}

export interface ProviderOperationalSnapshot extends ProviderAvailabilitySnapshot {
  readonly active: Readonly<Record<ReasoningFamily, number>>;
  readonly queued: Readonly<Record<ReasoningFamily, number>>;
  readonly effectiveCapacity: number;
  readonly reservedScoring: number;
  readonly pressureStrikes: number;
  readonly circuitState: "closed" | "open" | "probing";
  readonly probeOwner?: string;
  readonly oldestHeldAgeMs?: number;
  readonly queueLatencyMs?: Readonly<{ count: number; total: number; max: number }>;
}

export interface ProviderCircuitPersistence {
  load(provider: CliProvider): PersistedHardQuotaCircuit | undefined;
  save(provider: CliProvider, state: PersistedHardQuotaCircuit): void;
  clear(provider: CliProvider): void;
}

export type PreflightOutcome =
  | { readonly ok: true }
  | { readonly ok: false; readonly kind: ReasoningFailureKind };

export interface ProviderActivityToken<P extends CliProvider = CliProvider> {
  readonly provider: P;
  readonly version: number;
}

export interface ProviderState {
  checkCircuit<P extends CliProvider>(
    provider: P,
    request: {
      readonly requestId: string;
      readonly queuedAtMs: number;
      readonly signal?: AbortSignal;
      readonly submittedWhileOpen: boolean;
      readonly family?: ReasoningFamily;
      /** Called once, when an open circuit first holds the request rather than admitting it. */
      readonly onHeld?: () => void;
    },
  ): Promise<ProviderResult<void, P>>;
  circuitOpen(provider: CliProvider): boolean;
  /**
   * A limit observation from a provider's own stream. `quota` (requests refused) opens the circuit,
   * honouring a trustworthy `resetAtMs`, unless `requestId` names a request admitted before the
   * circuit's current opening. `pressure` strikes capacity once per `window` and never opens
   * anything: the call that reported it was served.
   */
  recordPressure(provider: CliProvider, kind: "pressure" | "quota", resetAtMs?: number, window?: string, requestId?: string): void;
  recordExecution<P extends CliProvider>(
    provider: P,
    result: ProviderResult<unknown, P> | { readonly cancelled: true },
    requestId?: string,
  ): void;
  admit<T, P extends CliProvider>(
    provider: P,
    request: {
      readonly family: ReasoningFamily;
      readonly jobId: string;
      readonly signal?: AbortSignal;
    },
    operation: () => T | Promise<T>,
    onEvent?: (event: ReasoningEvent) => void,
  ): Promise<Awaited<T>>;
  captureActivityToken<P extends CliProvider>(
    provider: P
  ): ProviderActivityToken<P>;
  recordPreflight<P extends CliProvider>(
    provider: P,
    outcome: PreflightOutcome,
    token?: ProviderActivityToken<P>
  ): ProviderResult<void, P>;
  snapshot(): readonly ProviderAvailabilitySnapshot[];
  operationalSnapshot(): readonly ProviderOperationalSnapshot[];
  configurePersistence(persistence: ProviderCircuitPersistence): void;
}

interface QueueState {
  activityVersion: number;
  availability: "checking" | "available";
}

function newQueue(): QueueState {
  return {
    activityVersion: 0,
    availability: "checking",
  };
}

function normalizePreflightOutcome(raw: unknown): PreflightOutcome {
  try {
    if (
      typeof raw !== "object" ||
      raw === null ||
      Array.isArray(raw)
    ) {
      return { ok: false, kind: "application" };
    }
    const okSnapshot = snapshotOwnProperty(raw, "ok");
    if (!okSnapshot.present) {
      return { ok: false, kind: "application" };
    }
    const ok = okSnapshot.value;
    if (ok === true) return { ok: true };
    if (ok === false) {
      const kindSnapshot = snapshotOwnProperty(raw, "kind");
      if (
        kindSnapshot.present &&
        isReasoningFailureKind(kindSnapshot.value)
      ) {
        const kind = kindSnapshot.value;
        return { ok: false, kind };
      }
    }
  } catch {
    return { ok: false, kind: "application" };
  }
  return { ok: false, kind: "application" };
}

function report(
  onEvent: ((event: ReasoningEvent) => void) | undefined,
  event: ReasoningEvent
): void {
  try {
    const reported = (
      onEvent as ((event: ReasoningEvent) => unknown) | undefined
    )?.(event);
    if (
      reported !== undefined &&
      typeof (reported as PromiseLike<void>).then === "function"
    ) {
      void Promise.resolve(reported).catch(() => undefined);
    }
  } catch {
    // Progress reporting is observational and must not alter provider execution.
  }
}

export function createProviderState(options?: {
  now?: () => number;
  capacity?: number;
  reservedScoring?: number;
  admission?: Readonly<Record<CliProvider, {
    readonly initial: number;
    readonly floor: number;
    readonly ceiling: number;
    readonly scoringReserve: number;
    readonly cooldownsMs: readonly number[];
  }>>;
  persistence?: ProviderCircuitPersistence;
}): ProviderState {
  let persistence = options?.persistence;
  const now = options?.now ?? (() => Date.now());
  const initialCapacity = options?.capacity ?? 1;
  const reservedScoring = options?.reservedScoring ?? (initialCapacity === 1 ? 0 : 1);
  const policy = (provider: CliProvider) => options?.admission?.[provider] ?? {
    initial: initialCapacity,
    floor: initialCapacity === 1 ? 1 : 2,
    ceiling: initialCapacity === 1 ? 1 : 8,
    scoringReserve: reservedScoring,
    cooldownsMs: [CIRCUIT_MS],
  };
  const queues: Record<CliProvider, QueueState> = {
    claude: newQueue(),
    codex: newQueue(),
  };
  const schedulers: Record<CliProvider, AdmissionScheduler> = {
    claude: new AdmissionScheduler({ capacity: policy("claude").initial, reservedScoring: policy("claude").scoringReserve, now }),
    codex: new AdmissionScheduler({ capacity: policy("codex").initial, reservedScoring: policy("codex").scoringReserve, now }),
  };
  const capacities: Record<CliProvider, AdaptiveCapacity> = {
    claude: new AdaptiveCapacity({
      floor: policy("claude").floor,
      initial: policy("claude").initial,
      ceiling: policy("claude").ceiling,
      now,
    }),
    codex: new AdaptiveCapacity({
      floor: policy("codex").floor,
      initial: policy("codex").initial,
      ceiling: policy("codex").ceiling,
      now,
    }),
  };
  const circuits: Record<CliProvider, ProviderCircuit> = {
    claude: new ProviderCircuit({ now, cooldownsMs: policy("claude").cooldownsMs }),
    codex: new ProviderCircuit({ now, cooldownsMs: policy("codex").cooldownsMs }),
  };
  const probes = new Set<string>();
  const heldAt = new Map<string, { provider: CliProvider; atMs: number }>();
  const pressureEpoch: Record<CliProvider, number> = { claude: 0, codex: 0 };
  const executionPressureEpoch = new Map<string, number>();
  // The circuit's opening count when each request was admitted (ProviderCircuit.opening).
  const executionOpening = new Map<string, number>();

  /**
   * Whether a request was admitted before its circuit's current opening. Its failure is older
   * evidence than whatever opened the circuit, so it must not reopen the circuit, push the retry
   * deadline out, or clear a probe in flight: the probe's own outcome decides. A request this state
   * never admitted counts as current.
   */
  function admittedBeforeCurrentOpening(provider: CliProvider, requestId: string | undefined): boolean {
    if (requestId === undefined) return false;
    const opening = executionOpening.get(requestId);
    return opening !== undefined && opening < circuits[provider].opening();
  }

  function resetCleanWave(provider: CliProvider): void {
    const current = capacities[provider].snapshot().capacity;
    const reset = capacities[provider].resetAfterCircuit(current);
    schedulers[provider].setCapacity(reset.capacity);
  }

  function syncPersistence(provider: CliProvider): void {
    const persistent = circuits[provider].persistentState();
    try {
      if (persistent) persistence?.save(provider, persistent);
      else persistence?.clear(provider);
    } catch {
      // Persistence is operational durability, never an execution dependency.
    }
  }

  function circuitOpen(provider: CliProvider): boolean {
    return circuits[provider].snapshot().state !== "closed";
  }

  async function checkCircuit<P extends CliProvider>(
    provider: P,
    request: {
      readonly requestId: string;
      readonly queuedAtMs: number;
      readonly signal?: AbortSignal;
      readonly submittedWhileOpen: boolean;
      readonly family?: ReasoningFamily;
      readonly onHeld?: () => void;
    },
  ): Promise<ProviderResult<void, P>> {
    for (;;) {
      const decision = circuits[provider].admit({
        requestId: request.requestId,
        queuedAtMs: request.queuedAtMs,
        wasQueuedWhenOpened: !request.submittedWhileOpen,
        family: request.family,
      });
      if (decision.kind === "admit") {
        executionPressureEpoch.set(request.requestId, pressureEpoch[provider]);
        executionOpening.set(request.requestId, circuits[provider].opening());
        heldAt.delete(request.requestId);
        return { ok: true, provider, value: undefined };
      }
      if (decision.kind === "probe") {
        executionPressureEpoch.set(request.requestId, pressureEpoch[provider]);
        executionOpening.set(request.requestId, circuits[provider].opening());
        heldAt.delete(request.requestId);
        probes.add(request.requestId);
        return { ok: true, provider, value: undefined };
      }
      if (decision.kind === "reject") {
        heldAt.delete(request.requestId);
        return {
          ok: false,
          failure: {
            provider,
            kind: decision.failureKind,
            source: "circuit",
          },
        };
      }
      if (request.signal?.aborted) {
        heldAt.delete(request.requestId);
        circuits[provider].release(request.requestId);
        return {
          ok: false,
          failure: { provider, kind: "application", source: "circuit" },
        };
      }
      if (!heldAt.has(request.requestId)) {
        heldAt.set(request.requestId, { provider, atMs: now() });
        try { request.onHeld?.(); } catch { /* reporting never affects admission */ }
      }
      // The circuit, not this loop, owns when a held request can next make progress: a probing
      // circuit leaves `retryAtMs` in the past, so a wait keyed to it would spin for the whole probe.
      const wakeAtMs = circuits[provider].nextEligibleAtMs();
      try {
        // abortableDelay removes its abort listener when the timer wins, so none accumulate on the
        // job-lifetime signal across iterations.
        await abortableDelay(Math.max(1, wakeAtMs - now()), request.signal);
      } catch {
        // abortableDelay rejects only with the signal's own abort reason. Settle here rather than
        // looping, and drop the request from the circuit's held set: a held entry is a probe
        // candidate, and a cancelled request must never be named the probe owner.
        heldAt.delete(request.requestId);
        circuits[provider].release(request.requestId);
        return {
          ok: false,
          failure: { provider, kind: "application", source: "circuit" },
        };
      }
    }
  }

  /**
   * Settles the recovery probe if `requestId` owns it. A provider that answered, even with output
   * that failed validation, is reachable, so the circuit closes. A probe that ended without telling
   * us anything about the provider (cancelled, rejected locally, or a local configuration or
   * application fault) hands ownership to the next request without escalating the cooldown. Any
   * other failure reopens the circuit at the next cooldown level.
   */
  function settleProbe(
    provider: CliProvider,
    requestId: string | undefined,
    outcome: "answered" | "relinquished" | "failed",
  ): boolean {
    if (requestId === undefined || !probes.delete(requestId)) return false;
    if (outcome === "answered") {
      const recovered = circuits[provider].recordProbe(requestId, "success");
      if (recovered.capacity !== undefined) {
        const resumed = capacities[provider].resetAfterCircuit(recovered.capacity);
        schedulers[provider].setCapacity(resumed.capacity);
      }
    } else {
      circuits[provider].recordProbe(requestId, outcome === "failed" ? "failure" : "cancelled");
    }
    return true;
  }

  function forget(requestId: string | undefined): void {
    if (requestId === undefined) return;
    heldAt.delete(requestId);
    executionPressureEpoch.delete(requestId);
    executionOpening.delete(requestId);
  }

  function recordExecution<P extends CliProvider>(
    provider: P,
    result: ProviderResult<unknown, P> | { readonly cancelled: true },
    requestId?: string,
  ): void {
    const queue = queues[provider];
    if ("cancelled" in result) {
      settleProbe(provider, requestId, "relinquished");
      capacities[provider].recordTerminal("cancelled");
      forget(requestId);
      syncPersistence(provider);
      return;
    }
    // A `circuit`-sourced failure is this process's own admission verdict: nothing reached the
    // provider. It must not reopen the circuit (that would push the retry deadline out for as long
    // as traffic kept arriving and clear an in-flight probe's ownership), spend a capacity strike,
    // or count as newer evidence than a startup preflight.
    if (!result.ok && result.failure.source === "circuit") {
      settleProbe(provider, requestId, "relinquished");
      forget(requestId);
      return;
    }
    // A live outcome is newer provider evidence than any startup preflight still in flight, so it
    // advances the activity version that makes such a preflight's late verdict stale.
    queue.activityVersion += 1;
    if (result.ok) {
      settleProbe(provider, requestId, "answered");
      queue.availability = "available";
      const admittedPressureEpoch = requestId === undefined
        ? undefined
        : executionPressureEpoch.get(requestId);
      const pressureBearing = admittedPressureEpoch !== undefined
        && admittedPressureEpoch !== pressureEpoch[provider];
      const decision = capacities[provider].recordTerminal(pressureBearing ? "timeout" : "success");
      schedulers[provider].setCapacity(decision.capacity);
      forget(requestId);
      syncPersistence(provider);
      return;
    }
    const kind = result.failure.kind;
    if (kind === "invalid-output") {
      settleProbe(provider, requestId, "answered");
      queue.availability = "available";
      capacities[provider].recordTerminal("invalid-output");
    } else if (kind === "application" || kind === "configuration") {
      settleProbe(provider, requestId, "relinquished");
    } else {
      const stale = admittedBeforeCurrentOpening(provider, requestId);
      const failedProbe = settleProbe(provider, requestId, "failed");
      if (kind === "timeout") {
        capacities[provider].recordTerminal("timeout");
      } else if (kind === "rate-limit" || kind === "provider") {
        const decision = capacities[provider].recordTerminal("pressure");
        schedulers[provider].setCapacity(decision.capacity);
        if (decision.openCircuit && !failedProbe && !stale) {
          resetCleanWave(provider);
          circuits[provider].open(kind);
        }
      } else if (opensCircuit(kind) && !failedProbe && !stale) {
        resetCleanWave(provider);
        circuits[provider].open(kind);
      }
    }
    forget(requestId);
    syncPersistence(provider);
  }

  function recordPressure(
    provider: CliProvider,
    kind: "pressure" | "quota",
    resetAtMs?: number,
    window?: string,
    requestId?: string,
  ): void {
    // Calls in flight now finish under pressure and must not count toward capacity growth.
    pressureEpoch[provider] += 1;
    if (kind === "quota") {
      // A refusal seen by a request admitted before the current opening is older than the evidence
      // that opened the circuit, and reopening for it would clear a probe in flight.
      if (admittedBeforeCurrentOpening(provider, requestId)) return;
      resetCleanWave(provider);
      circuits[provider].open("quota", resetAtMs);
      syncPersistence(provider);
      return;
    }
    const decision = capacities[provider].recordWindowPressure(window);
    schedulers[provider].setCapacity(decision.capacity);
  }

  function admit<T, P extends CliProvider>(
    provider: P,
    request: {
      readonly family: ReasoningFamily;
      readonly jobId: string;
      readonly signal?: AbortSignal;
    },
    operation: () => T | Promise<T>,
    onEvent?: (event: ReasoningEvent) => void,
  ): Promise<Awaited<T>> {
    // Reports only the scheduler's wait. `running` is the caller's to report, when the provider call
    // actually starts: a dequeued request can still be held by an open circuit (checkCircuit), and
    // no call is being made while it is.
    return schedulers[provider].admit(
      {
        ...request,
        onQueued(queuePosition) {
          report(onEvent, { state: "queued", provider, queuePosition });
        },
      },
      async () => operation(),
    );
  }

  function captureActivityToken<P extends CliProvider>(
    provider: P
  ): ProviderActivityToken<P> {
    return Object.freeze({
      provider,
      version: queues[provider].activityVersion,
    });
  }

  function recordPreflight<P extends CliProvider>(
    provider: P,
    outcome: PreflightOutcome,
    token?: ProviderActivityToken<P>
  ): ProviderResult<void, P> {
    const queue = queues[provider];
    const normalized = normalizePreflightOutcome(outcome);
    const result: ProviderResult<void, P> = normalized.ok
      ? {
          ok: true,
          value: undefined,
          provider,
        }
      : {
          ok: false,
          failure: {
            provider,
            kind: normalized.kind,
            source: "preflight",
          },
        };

    // Conditional startup observations are stale once newer activity for this provider has been
    // submitted or applied. Return the normalized result, but leave the shared circuit untouched.
    if (
      token &&
      (token.provider !== provider ||
        token.version !== queue.activityVersion)
    ) {
      return result;
    }
    // A capability check that did not answer in time (a slow cold start of `claude auth status`,
    // say) says nothing about whether the provider is up. It is no observation: it opens no circuit
    // and does not make an overlapping check's answer stale; the next real call decides.
    if (!normalized.ok && normalized.kind === "timeout") return result;

    // An applied preflight is itself activity, so overlapping probes captured at the same version
    // cannot later overwrite whichever observation settled first.
    queue.activityVersion += 1;
    if (normalized.ok) {
      // A successful capability check never closes an open circuit: recovery is a real request's
      // probe, which proves the provider answers rather than only that the CLI is logged in.
      queue.availability = "available";
    } else if (opensCircuit(normalized.kind)) {
      resetCleanWave(provider);
      circuits[provider].open(normalized.kind);
      queue.availability = "checking";
    }
    syncPersistence(provider);
    return result;
  }

  function snapshot(): readonly ProviderAvailabilitySnapshot[] {
    return (["claude", "codex"] as const).map((provider) => {
      const circuit = circuits[provider].snapshot();
      if (circuit.state !== "closed") {
        return {
          provider,
          availability: "circuit-open" as const,
          failureKind: circuit.failureKind,
          retryAtMs: circuit.retryAtMs,
        };
      }
      return {
        provider,
        availability: queues[provider].availability,
      };
    });
  }

  function operationalSnapshot(): readonly ProviderOperationalSnapshot[] {
    return (["claude", "codex"] as const).map((provider) => {
      const scheduler = schedulers[provider].snapshot();
      const adaptive = capacities[provider].snapshot();
      const circuit = circuits[provider].snapshot();
      const held = [...heldAt.values()].filter((entry) => entry.provider === provider);
      return {
        provider,
        availability: circuit.state === "closed"
          ? queues[provider].availability
          : "circuit-open" as const,
        ...(circuit.failureKind === undefined ? {} : { failureKind: circuit.failureKind }),
        ...(circuit.retryAtMs === undefined ? {} : { retryAtMs: circuit.retryAtMs }),
        active: scheduler.active,
        queued: scheduler.queued,
        effectiveCapacity: scheduler.capacity,
        reservedScoring: scheduler.reservedScoring,
        pressureStrikes: adaptive.pressureStrikes,
        queueLatencyMs: scheduler.queueLatencyMs,
        circuitState: circuit.state,
        ...(circuit.probeOwner === undefined ? {} : { probeOwner: circuit.probeOwner }),
        ...(held.length === 0 ? {} : { oldestHeldAgeMs: Math.max(0, now() - Math.min(...held.map((entry) => entry.atMs))) }),
      };
    });
  }

  /** Reopens a hard-quota circuit whose reset (plus its five-second margin) is still ahead. */
  function configurePersistence(next: ProviderCircuitPersistence): void {
    persistence = next;
    for (const provider of ["claude", "codex"] as const) {
      const restored = next.load(provider);
      if (restored && restored.resetAtMs + 5_000 > now()) {
        resetCleanWave(provider);
        circuits[provider].open("quota", restored.resetAtMs);
      } else if (restored) {
        next.clear(provider);
      }
    }
  }

  if (persistence) configurePersistence(persistence);

  return {
    admit,
    checkCircuit,
    circuitOpen,
    recordPressure,
    recordExecution,
    captureActivityToken,
    recordPreflight,
    snapshot,
    operationalSnapshot,
    configurePersistence,
  };
}

export const providerState = createProviderState({
  admission: config.admission,
});
