import type { CancellationReason, NoveltyResidualIssue, SceneGenerationOutcome } from "@toefl-prep/shared";
import type { GenerationJobUiStatus } from "../hooks/useGenerationJob";
import { cancellationStatusLabel, formatElapsed, noveltyResidualSummary, sceneStepStates, stepState } from "../lib/progressUtils";
import { Button } from "../ui/Button";
import { Card } from "../ui/Card";
import { StatusChip } from "../ui/Chip";
import { IconCaution } from "../ui/icons";
import { GENERATION_JOB_STATUS, SECTION_LABEL } from "../ui/labels";
import { Notice } from "../ui/Notice";
import { ProgressBar, StepProgress, type Step, type StepState } from "../ui/Progress";
import { SECTION_COST } from "./generation/generationCost";

/**
 * Everything this panel draws, as one object: structurally a subset of `useGenerationJob`'s
 * `GenerationJobState`, so the Dashboard hands its hook state straight in (`job={singleJob}`)
 * instead of forwarding each field. Declared structurally rather than as a `Pick` because the other
 * caller, BatchGenerationProgress, builds this shape from a running child's `CurrentSetDisplay`
 * rather than owning a whole job.
 */
export type GenerationProgressJob = {
  kind: "writing" | "speaking" | "reading" | "listening" | null;
  status: GenerationJobUiStatus;
  stage: string | null;
  /** The job's structured-reasoning call is waiting for admission to its provider's scheduler. */
  waiting: boolean;
  provider: "claude" | "codex" | null;
  fallbackFrom: "claude" | "codex" | null;
  /** How many requests are ahead of this one in its provider's queue, as the server counts them. */
  queuePosition: number | null;
  planningAttempt: 1 | 2 | 3 | null;
  generationAttempt: 1 | 2 | 3 | null;
  maxDiversityAttempts: 3 | null;
  audioProgress: { done: number; total: number } | null;
  sceneOutcome: SceneGenerationOutcome | null;
  /** Overlaps with earlier Sets that the Plan was admitted with. Advisory: the Set is usable. */
  noveltyResidual: NoveltyResidualIssue[] | null;
  elapsedMs: number;
  error: string | null;
  cancellationRequestedAt?: string | null;
  terminalAt?: string | null;
  cancellationReason?: CancellationReason | null;
};

export type GenerationProgressProps = {
  job: GenerationProgressJob;
  /** Its own prop: a batch child's Retry retries the whole batch, not the child. */
  onRetry: () => void;
  /**
   * A standalone job's cancel. Omitted for a batch child: a batch is cancelled as a whole, and a
   * per-child button would be a second, more confusing way to do the same thing.
   */
  onCancel?: () => void;
  /** False inside another sheet (a batch's panel), where a second card border would nest a sheet. */
  framed?: boolean;
};

// The checkpoints the generator really reaches, per kind (GenerationStage in
// server/src/services/generationReasoning.ts), never a creeping percentage. Reading follows
// Writing's sequence; Listening adds audio after verifying; Speaking renders audio, then its
// optional scene image and focus regions.
const WRITING_STAGES = [
  { key: "planning", label: "Planning distinct topics" },
  { key: "generating", label: "Writing" },
  { key: "verifying", label: "Checking" },
  { key: "saving", label: "Saving" },
];
// Both scene steps are listed even though neither carries a count: a stage missing from this array
// reads as "not part of this sequence" and would blank every step back to pending once the job
// moved past audio.
const SPEAKING_STAGES = [
  { key: "planning", label: "Planning distinct topics" },
  { key: "generating", label: "Writing" },
  { key: "rendering-audio", label: "Audio" },
  { key: "rendering-image", label: "Scene" },
  { key: "locating-regions", label: "Regions" },
  { key: "saving", label: "Saving" },
];
const LISTENING_STAGES = [
  { key: "planning", label: "Planning distinct topics" },
  { key: "generating", label: "Writing" },
  { key: "verifying", label: "Checking" },
  { key: "rendering-audio", label: "Audio" },
  { key: "saving", label: "Saving" },
];

// stepState's "unavailable" (an optional scene step that failed without failing the Set) is drawn
// as skipped, with a label that says which.
function toStepState(state: ReturnType<typeof stepState>): StepState {
  return state === "unavailable" ? "skipped" : state;
}

function providerName(provider: "claude" | "codex", fallbackFrom: "claude" | "codex" | null): string {
  if (provider === "codex" && fallbackFrom === "claude") return "Codex, standing in for Claude";
  return provider === "claude" ? "Claude" : "Codex";
}

/**
 * Checkpoint progress for one durable generation job (useGenerationJob), or for one running child of
 * a batch: its steps in words, a clip count while Speaking audio records, and, when the job's AI
 * call is queued behind other work, how long the queue is. Failure shows the error with Retry.
 */
export default function GenerationProgress({ job, onRetry, onCancel, framed = true }: GenerationProgressProps) {
  const {
    kind, status, stage, waiting, provider, fallbackFrom, queuePosition,
    planningAttempt, generationAttempt, maxDiversityAttempts, audioProgress,
    sceneOutcome, noveltyResidual, elapsedMs, error,
    cancellationRequestedAt, terminalAt, cancellationReason,
  } = job;
  const what = kind ? `${SECTION_LABEL[kind]} Set` : "Set";

  if (status === "failed") {
    return (
      <Notice
        tone="critical"
        live="polite"
        title={`Generating a ${what} failed`}
        action={
          <Button size="sm" onClick={onRetry}>
            Retry
          </Button>
        }
      >
        {error ?? "Something went wrong while generating this Set."}
      </Notice>
    );
  }

  if (status === "cancelled" || (terminalAt && cancellationReason)) {
    return (
      <Card tone="plain" padding="sm" className="flex flex-wrap items-center gap-2">
        <StatusChip status={GENERATION_JOB_STATUS.cancelled} />
        <span className="text-ui text-ink-soft">{cancellationStatusLabel(cancellationReason)}</span>
      </Card>
    );
  }

  const allDone = status === "done";
  const sequence = kind === "speaking" ? SPEAKING_STAGES : kind === "listening" ? LISTENING_STAGES : WRITING_STAGES;
  const order = sequence.map((s) => s.key);
  const overrides = kind === "speaking" ? sceneStepStates(sceneOutcome) : {};
  const steps: Step[] = sequence.map((s) => {
    let label = s.label;
    if (s.key === "rendering-image" && sceneOutcome?.image === "failed") label = "Scene unavailable";
    if (s.key === "locating-regions" && sceneOutcome?.regions === "failed") label = "Regions unavailable";
    if (s.key === "locating-regions" && sceneOutcome?.regions === "skipped") label = "Regions skipped";
    return { key: s.key, label, state: toStepState(overrides[s.key] ?? stepState(s.key, stage, order, allDone)) };
  });

  const headline =
    status === "starting" || status === "queued"
      ? `Starting a ${what}…`
      : allDone
        ? `${what} ready`
        : `Generating a ${what}`;

  // The server's count of requests ahead of this one. Zero, or no count at all, means nothing is
  // ahead: the call is only waiting for capacity to free up.
  const queueLine = waiting
    ? queuePosition !== null && queuePosition > 0
      ? `${queuePosition} ${queuePosition === 1 ? "request" : "requests"} ahead`
      : "Waiting for a slot"
    : null;

  const body = (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center justify-between gap-x-3 gap-y-1">
        <p className="text-ui font-medium text-ink">{headline}</p>
        <span className="figures text-meta text-graphite">{formatElapsed(elapsedMs)}</span>
      </div>

      <StepProgress label={`Generating a ${what}`} steps={steps} />

      {kind === "speaking" && audioProgress && (
        <ProgressBar
          label="Recording audio"
          value={audioProgress.done}
          max={audioProgress.total}
          valueText={`${audioProgress.done} of ${audioProgress.total} clips`}
        />
      )}

      {(provider || queueLine) && (
        <p className="text-meta text-graphite">
          {[provider ? providerName(provider, fallbackFrom) : null, queueLine].filter(Boolean).join(" · ")}
        </p>
      )}

      {stage === "planning" && planningAttempt !== null && planningAttempt > 1 && maxDiversityAttempts !== null && (
        <p className="text-meta text-ink-soft">
          Planning again for variety · attempt {planningAttempt} of {maxDiversityAttempts}
        </p>
      )}
      {stage === "generating" && generationAttempt !== null && generationAttempt > 1 && maxDiversityAttempts !== null && (
        <p className="text-meta text-ink-soft">
          Writing a more distinct draft · attempt {generationAttempt} of {maxDiversityAttempts}
        </p>
      )}

      {noveltyResidual && noveltyResidual.length > 0 && (
        <p className="flex gap-1.5 text-meta text-caution">
          <span className="mt-0.5">
            <IconCaution size={14} />
          </span>
          <span>{noveltyResidualSummary(noveltyResidual)}</span>
        </p>
      )}

      {cancellationRequestedAt && <p className="text-meta font-medium text-caution">Cancellation requested…</p>}

      <div className="flex flex-wrap items-center justify-between gap-2">
        {kind && !allDone && <p className="text-meta text-graphite">Usually takes {SECTION_COST[kind].duration}.</p>}
        {/* Not while "starting": a run()'s job id isn't known until the POST resolves, and a Cancel
            pressed before then would do nothing. */}
        {onCancel && !cancellationRequestedAt && !allDone && status !== "starting" && (
          <Button variant="quiet" size="sm" onClick={onCancel} aria-label={`Cancel generating this ${what}`}>
            Cancel
          </Button>
        )}
      </div>
    </div>
  );

  return framed ? <Card>{body}</Card> : body;
}
