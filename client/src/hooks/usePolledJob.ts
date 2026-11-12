import { useCallback, useEffect, useRef, useState } from "react";
import { requestErrorMessage } from "../lib/requestError";
import { pollUntilTerminal, type PollPolicy } from "../lib/pollJob";

/**
 * The one polled-job engine behind useScoringJob / useGenerationJob / useGenerationBatch. It solves,
 * once, the three hazards every polled job has: React StrictMode's synthetic double-mount firing a
 * real POST twice, an elapsed-time interval left running when a component unmounts mid-job, and a
 * stale retry's promise resolving after a newer one and clobbering fresher state.
 *
 * The engine owns: the projected state (a single `useState<TProjection>` fed by a pure `project`
 * function), the lifecycle `phase`, the mounted guard, the monotonic generation counter, the
 * elapsed-time ticker, timer cleanup on unmount and on terminal, and terminal detection. Each
 * consumer keeps only what is genuinely its own: which endpoints to call, how to fold a snapshot
 * into its own view state, and how to name its fields.
 */

/**
 * Where the job is in its lifecycle, independent of any one caller's status vocabulary:
 * - "idle": nothing has been begun yet (the projection is whatever `initial()` produced).
 * - "starting": a starter is in flight — the POST that creates the job has not resolved, so no id
 *   is known yet. Skipped entirely when a starter returns its handle synchronously (re-attaching
 *   to an already-known job id does no POST at all).
 * - "polling": an id is known and the poll loop is live. The first projection at this phase carries
 *   a null snapshot (nothing has come back yet).
 * - "terminal": the job reported a terminal snapshot, or the starter failed. All timers are stopped.
 *
 * Each consumer maps this back into its own public status union inside `project` — those unions are
 * part of the components' contracts and must not change shape.
 */
export type PolledJobPhase = "idle" | "starting" | "polling" | "terminal";

/** What `project` is told about the world. Everything else it needs comes from `prev`. */
export type PolledJobProjectionInput<TSnapshot> = {
  phase: PolledJobPhase;
  /** The snapshot this update came from, or null for a lifecycle-only transition. */
  snapshot: TSnapshot | null;
  /** Non-null only when the starter failed (never for a failed poll — those are invisible). */
  startError: string | null;
};

/**
 * Fold one lifecycle update into the projected state. Must be pure: it is called from a React
 * state updater (so StrictMode may invoke it twice) and it is the piece each hook's tests exercise
 * directly, with no React involved.
 */
export type PolledJobProjector<TSnapshot, TProjection> = (
  prev: TProjection,
  input: PolledJobProjectionInput<TSnapshot>,
) => TProjection;

/** What a starter hands back: how to poll the job it just established. */
export type PolledJobHandle<TSnapshot> = { fetch: () => Promise<TSnapshot> };

/**
 * Establishes the job to poll. Returning a handle synchronously skips the "starting" phase (used
 * when re-attaching to a job id the caller already has); returning a promise means "starting" until
 * it settles. Throwing synchronously — or rejecting — lands the engine in "terminal" with a
 * `startError`, which is how a caller surfaces "this could not be started at all".
 *
 * Each consumer's starter closes over its own arguments (a kind, a batch's items, an attempt id),
 * which is why the engine is not generic over an argument type: `retry()` simply re-invokes the
 * last starter it was handed, and that starter already remembers everything it needs.
 *
 * `isCurrent()` is the engine's own stale guard, handed to the starter so a starter that writes
 * something durable back into its hook (useGenerationBatch stores the batch id its cancel() needs)
 * can skip that write when a newer begin() has already superseded this one. The engine applies the
 * same guard to the handle itself; this exists purely for the starter's own side effects.
 */
export type PolledJobStarter<TSnapshot> = (
  isCurrent: () => boolean,
) => PolledJobHandle<TSnapshot> | Promise<PolledJobHandle<TSnapshot>>;

export type UsePolledJobArgs<TSnapshot, TProjection> = {
  /**
   * The projection a fresh job starts from. A factory rather than a value because two consumers
   * seed it from arguments the engine knows nothing about (the batch's requested total, the
   * generation job's kind), and because it is re-evaluated on every `begin()`, which is the reset.
   */
  initial: () => TProjection;
  project: PolledJobProjector<TSnapshot, TProjection>;
  isTerminal: (snapshot: TSnapshot) => boolean;
  /** Defaults to DEFAULT_POLL_POLICY (every 1.5 s, backing off to at most 15 s after failed polls). */
  policy?: Partial<PollPolicy>;
  /**
   * Fire this starter once on mount. Guarded so React StrictMode's synthetic mount→cleanup→mount
   * cycle cannot fire it twice, which for a scoring job would mean a second real Judge and Arbiter
   * run per start. Only useScoringJob auto-starts; the generation hooks are started by an
   * explicit User action.
   */
  autoStart?: PolledJobStarter<TSnapshot>;
};

/**
 * `startedAtMs` backdates the elapsed clock to a moment before this begin() — the re-attach case,
 * where the job really started on the server some minutes ago and "0:00" would misreport a
 * ten-minute generation as just begun. Remembered alongside the starter, so retry() on a re-attached
 * job (which re-polls the same job, POSTing nothing) keeps reporting the job's true age.
 */
export type PolledJobBeginOptions = { startedAtMs?: number };

export type PolledJob<TSnapshot, TProjection> = {
  phase: PolledJobPhase;
  projection: TProjection;
  /** Milliseconds since the current `begin()` (or its backdated `startedAtMs`), re-published once a
   * second while the job runs. */
  elapsedMs: number;
  begin: (starter: PolledJobStarter<TSnapshot>, opts?: PolledJobBeginOptions) => void;
  /** Re-invokes the last starter `begin()` was handed. A no-op if nothing was ever begun. */
  retry: () => void;
  /**
   * Escape hatch for state changes that are not polling outcomes: the generation hooks' optimistic
   * `cancel()`, which flips its flag the instant the button is clicked and lets the next poll
   * confirm it. Mounted-guarded like everything else here.
   */
  patch: (update: (prev: TProjection) => TProjection) => void;
};

export function usePolledJob<TSnapshot, TProjection>(
  args: UsePolledJobArgs<TSnapshot, TProjection>,
): PolledJob<TSnapshot, TProjection> {
  // Latest-value refs: every consumer passes fresh closures each render, and none of the callbacks
  // below should change identity because of that (consumers list `retry` in their own callbacks'
  // dependencies and pass it to progress panels as a prop).
  const initialRef = useRef(args.initial);
  initialRef.current = args.initial;
  const projectRef = useRef(args.project);
  projectRef.current = args.project;
  const isTerminalRef = useRef(args.isTerminal);
  isTerminalRef.current = args.isTerminal;
  const policyRef = useRef(args.policy);
  policyRef.current = args.policy;
  const autoStartRef = useRef(args.autoStart);
  autoStartRef.current = args.autoStart;

  const [projection, setProjection] = useState<TProjection>(() => args.initial());
  const [elapsedMs, setElapsedMs] = useState(0);

  // `phase` needs no useState of its own: every phase change is published together with a
  // projection change, so the render it needs is already guaranteed.
  const phaseRef = useRef<PolledJobPhase>("idle");
  const mountedRef = useRef(true);
  const tickIntervalRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const startedAtRef = useRef(Date.now());
  const lastStarterRef = useRef<PolledJobStarter<TSnapshot> | null>(null);
  const lastBeginOptsRef = useRef<PolledJobBeginOptions | undefined>(undefined);
  // Bumped on every begin() (auto-start and each retry) so a poll or starter promise that resolves
  // after a newer begin has superseded it is a silent no-op instead of clobbering fresher state
  // with stale data.
  const generationRef = useRef(0);

  const stopTicker = useCallback(() => {
    if (tickIntervalRef.current) clearInterval(tickIntervalRef.current);
    tickIntervalRef.current = null;
  }, []);

  const startTicker = useCallback(() => {
    if (tickIntervalRef.current) return; // idempotent
    tickIntervalRef.current = setInterval(() => {
      if (!mountedRef.current) return;
      // Clamped like begin()'s initial publish: startedAtMs can be a server-origin instant, and a
      // client clock running behind it must never publish a negative elapsed to consumers.
      setElapsedMs(Math.max(0, Date.now() - startedAtRef.current));
    }, 1000);
  }, []);

  const begin = useCallback((starter: PolledJobStarter<TSnapshot>, opts?: PolledJobBeginOptions) => {
    lastStarterRef.current = starter;
    lastBeginOptsRef.current = opts;
    generationRef.current += 1;
    const generation = generationRef.current;
    // Whether this begin is still the current one and the component is still mounted. Re-checked at
    // every asynchronous boundary. mountedRef flips back to true on a StrictMode remount, which is
    // exactly what keeps an in-flight job attached across that synthetic cycle.
    const live = () => mountedRef.current && generation === generationRef.current;

    stopTicker();
    startedAtRef.current = opts?.startedAtMs ?? Date.now();
    // Published immediately, not left to the first 1s tick: a re-attached job's clock must read its
    // real age from the first frame, never flash 0:00 first. Clamped so a skewed client clock can't
    // render a negative elapsed.
    setElapsedMs(Math.max(0, Date.now() - startedAtRef.current));
    startTicker();

    const base = initialRef.current();
    const publish = (phase: PolledJobPhase, snapshot: TSnapshot | null, startError: string | null) => {
      phaseRef.current = phase;
      if (phase === "terminal") stopTicker();
      setProjection((prev) => projectRef.current(prev, { phase, snapshot, startError }));
    };
    const fail = (err: unknown) => {
      phaseRef.current = "terminal";
      stopTicker();
      setProjection(projectRef.current(base, {
        phase: "terminal",
        snapshot: null,
        startError: requestErrorMessage(err),
      }));
    };
    const runLoop = (handle: PolledJobHandle<TSnapshot>) => {
      void pollUntilTerminal<TSnapshot>({
        fetch: handle.fetch,
        isTerminal: (snapshot) => isTerminalRef.current(snapshot),
        shouldContinue: live,
        policy: policyRef.current,
        onSnapshot: (snapshot, terminal) => {
          if (!live()) return;
          publish(terminal ? "terminal" : "polling", snapshot, null);
        },
      });
    };

    let started: PolledJobHandle<TSnapshot> | Promise<PolledJobHandle<TSnapshot>>;
    try {
      started = starter(live);
    } catch (err) {
      // A starter that cannot even be attempted (e.g. no restart handler was ever wired up).
      // Surfaced synchronously so a Retry button reports a clear failure instead of hanging.
      fail(err);
      return;
    }

    if (isThenable(started)) {
      phaseRef.current = "starting";
      setProjection(projectRef.current(base, { phase: "starting", snapshot: null, startError: null }));
      started.then(
        (handle) => {
          if (!live()) return;
          publish("polling", null, null);
          runLoop(handle);
        },
        (err) => {
          if (!live()) return;
          fail(err);
        },
      );
      return;
    }

    // Synchronous handle — no POST happened, so the job is already identified and there is nothing
    // for a "starting" phase to describe.
    phaseRef.current = "polling";
    setProjection(projectRef.current(base, { phase: "polling", snapshot: null, startError: null }));
    runLoop(started);
  }, [startTicker, stopTicker]);

  // hasBegunRef (as opposed to mountedRef) survives the mount→cleanup→mount cycle React's
  // StrictMode runs once in dev: refs are not reinitialized across that synthetic double-invoke,
  // only the effect body re-runs. Without this guard, an auto-start (a real POST /score, so a real
  // Judge and Arbiter run) would fire twice per start in dev. retry() bypasses this guard
  // entirely; it only suppresses the effect's own auto-fire on mount.
  const hasBegunRef = useRef(false);

  useEffect(() => {
    mountedRef.current = true;
    // Re-arm the elapsed ticker that the synthetic StrictMode cleanup below just killed, for a job
    // that is still running. Idempotent, and independent of the hasBegunRef-guarded auto-start.
    if (phaseRef.current === "starting" || phaseRef.current === "polling") startTicker();
    const auto = autoStartRef.current;
    if (auto && !hasBegunRef.current) {
      hasBegunRef.current = true;
      begin(auto);
    }
    return () => {
      // The ticker must stop here, not merely mountedRef flip: the poll loop's own guards bail out
      // on `!mountedRef.current` before ever reaching a terminal snapshot, so without this,
      // navigating away mid-job would leave the 1s interval running for the rest of the tab's
      // lifetime — one zombie interval per abandoned job.
      mountedRef.current = false;
      stopTicker();
    };
    // Deliberately fires once on mount only — one hook instance owns one job lifecycle at a time;
    // re-firing is explicit, via begin()/retry(), never implicit on a prop identity change.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const retry = useCallback(() => {
    const starter = lastStarterRef.current;
    if (!starter) return; // nothing was ever begun — retry() before the first begin() is a no-op
    begin(starter, lastBeginOptsRef.current);
  }, [begin]);

  const patch = useCallback((update: (prev: TProjection) => TProjection) => {
    if (!mountedRef.current) return;
    setProjection(update);
  }, []);

  return { phase: phaseRef.current, projection, elapsedMs, begin, retry, patch };
}

function isThenable<T>(value: T | Promise<T>): value is Promise<T> {
  return typeof (value as { then?: unknown } | null)?.then === "function";
}
