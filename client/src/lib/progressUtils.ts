// Pure helpers for the durable-job progress UI (ScoringProgress, GenerationProgress,
// BatchGenerationProgress and the generation hooks). Kept out of the component files so each .tsx
// exports only components (oxlint's react/only-export-components rule), and React-free so the
// server suite can import it too.
import type { CancellationReason, GenerationProgressDetail, NoveltyResidualIssue, SceneGenerationOutcome } from "@toefl-prep/shared";

export function cancellationStatusLabel(reason: CancellationReason | null | undefined): string {
  if (reason === "user") return "Cancelled by you";
  if (reason === "superseded") return "Cancelled by a newer Response";
  if (reason === "parent_cancelled") return "Cancelled with its parent job";
  if (reason === "shutdown") return "Cancelled during server shutdown";
  return "Cancelled";
}

/**
 * Whether a scoring job was cancelled with nothing to carry its work on: any reason but
 * `superseded`, whose replacement job scores the same Items. The server marks such a job's Items
 * failed, so for the User it ends as a failed job does: interrupted, with a Retry.
 */
export function scoringInterrupted(status: string, reason: CancellationReason | null | undefined): boolean {
  return status === "cancelled" && reason !== "superseded";
}

export type StepState = "done" | "active" | "pending" | "unavailable" | "skipped";

/** Where `stageKey` sits relative to `currentStage` in `order`: "pending" (not reached, or the
 * current stage is not one of these steps, such as "queued"), "active" (the current step), or
 * "done" (already passed, or `allDone`). `order` is the caller's own sequence (GenerationProgress
 * has one per Set kind). A stage outside the sequence leaves every step pending, which is why the
 * generation hooks keep the last concrete stage while a job is queued (deriveJobDisplay's
 * `concreteStage` is null then) instead of passing "queued" here. */
export function stepState(stageKey: string, currentStage: string | null, order: readonly string[], allDone: boolean): StepState {
  if (allDone) return "done";
  if (!currentStage) return "pending"; // nothing checkpointed yet
  const currentIdx = order.indexOf(currentStage);
  const stepIdx = order.indexOf(stageKey);
  if (stepIdx === -1) return "pending";
  if (currentIdx === -1) return "pending"; // current stage isn't part of this sequence (e.g. "queued")
  if (stepIdx < currentIdx) return "done";
  if (stepIdx === currentIdx) return "active";
  return "pending";
}

export function formatElapsed(ms: number): string {
  const totalSec = Math.max(0, Math.floor(ms / 1000));
  const m = Math.floor(totalSec / 60);
  const s = totalSec % 60;
  return `${m}:${s.toString().padStart(2, "0")}`;
}

export type DerivedJobDisplay = {
  waiting: boolean;
  provider: "claude" | "codex" | null;
  fallbackFrom: "claude" | "codex" | null;
  queuePosition: number | null;
  // The concrete stage to show, or null when this poll carries nothing new to show (the caller keeps
  // whatever it already had, the same "sticky" convention as audioProgress below).
  concreteStage: string | null;
  // Non-null when this poll carries a {done,total} clip tally, which the server keeps in progress
  // after the stage has moved past rendering-audio, so a client that skipped polls still recovers
  // the last real tally instead of inventing or losing it.
  audioProgress: { done: number; total: number } | null;
  // Final optional speaking-scene outcome, present on saving/done. Parsed defensively because HTTP
  // JSON is untrusted at runtime; callers keep the last non-null value just like audioProgress.
  sceneOutcome: SceneGenerationOutcome | null;
  // Parsed defensively from durable progress. Callers retain the latest non-null values across
  // later audio/scene/saving checkpoints just as they do the audio tally.
  planningAttempt: 1 | 2 | 3 | null;
  generationAttempt: 1 | 2 | 3 | null;
  maxDiversityAttempts: 3 | null;
  // The cross-Set collisions the Plan was admitted with (NoveltyResidualIssue): non-fatal, like
  // `sceneOutcome` above, and retained by callers the same sticky way so it is still there to render
  // once the job is `done`. Parsed defensively, because this array is rendered: a malformed entry
  // degrades to "no residual" rather than throwing inside a progress component.
  noveltyResidual: NoveltyResidualIssue[] | null;
};

/** Translates one generation job's raw `{stage, progress}` (a GenerationStage from
 * server/src/services/generationReasoning.ts, and GenerationProgressDetail) into what a progress UI
 * shows. Stage "queued" means the job's model call is waiting for admission to its provider's
 * scheduler (docs/adr/0007): that becomes `waiting` and `queuePosition`, the server's count of
 * requests of the same family queued ahead, which is never an ETA. Any other stage is the concrete
 * stage, with the 13-clip `audioProgress` tally whenever present. Shared by useGenerationJob and
 * useGenerationBatch, which derives the same display for each running child. */
export function deriveJobDisplay(stage: string | null, progress: GenerationProgressDetail | null | undefined): DerivedJobDisplay {
  const sceneOutcome = parseSceneOutcome(progress?.scene);
  const noveltyResidual = parseNoveltyResidual(progress?.noveltyResidual);
  const planningAttempt = parseAttempt(progress?.planningAttempt);
  const generationAttempt = parseAttempt(progress?.generationAttempt);
  const maxDiversityAttempts =
    progress?.maxDiversityAttempts === 3 ? 3 as const : null;
  const provider =
    progress?.provider === "claude" || progress?.provider === "codex"
      ? progress.provider
      : null;
  const rawFallbackFrom =
    progress?.fallbackFrom === "claude" ||
    progress?.fallbackFrom === "codex"
      ? progress.fallbackFrom
      : null;
  const fallbackFrom =
    provider !== null && rawFallbackFrom !== provider
      ? rawFallbackFrom
      : null;
  const queuePosition =
    stage === "queued"
      ? typeof progress?.queuePosition === "number"
        ? progress.queuePosition
        : typeof progress?.position === "number"
          ? progress.position
          : null
      : null;
  if (stage === "queued") {
    return {
      waiting: true,
      provider,
      fallbackFrom,
      queuePosition,
      concreteStage: null,
      audioProgress: null,
      sceneOutcome,
      noveltyResidual,
      planningAttempt,
      generationAttempt,
      maxDiversityAttempts,
    };
  }
  let audioProgress: { done: number; total: number } | null = null;
  if (progress) {
    const done = progress.done;
    const total = progress.total;
    if (typeof done === "number" && typeof total === "number" && Number.isFinite(done) && Number.isInteger(done) && Number.isFinite(total) && total === 13 && Number.isInteger(total) && done >= 0 && done <= total) audioProgress = { done, total };
  }
  return {
    waiting: false,
    provider,
    fallbackFrom,
    queuePosition,
    concreteStage: stage,
    audioProgress,
    sceneOutcome,
    noveltyResidual,
    planningAttempt,
    generationAttempt,
    maxDiversityAttempts,
  };
}

/** Keeps only entries carrying the two fields every rendering reads, and returns null rather than an
 * empty array when nothing survives, so callers' sticky `?? retained` treats "this poll said
 * nothing" and "this poll said garbage" the same. */
function parseNoveltyResidual(value: unknown): NoveltyResidualIssue[] | null {
  if (!Array.isArray(value)) return null;
  const entries = value.filter((entry): entry is NoveltyResidualIssue =>
    typeof entry === "object" && entry !== null &&
    typeof (entry as { taskType?: unknown }).taskType === "string" &&
    typeof (entry as { kind?: unknown }).kind === "string");
  return entries.length > 0 ? entries : null;
}

function parseAttempt(value: unknown): 1 | 2 | 3 | null {
  return value === 1 || value === 2 || value === 3 ? value : null;
}

function parseSceneOutcome(value: unknown): SceneGenerationOutcome | null {
  if (typeof value !== "object" || value === null) return null;
  const image = "image" in value ? value.image : undefined;
  const regions = "regions" in value ? value.regions : undefined;
  if (image === "failed" && regions === "skipped") return { image, regions };
  if (image === "succeeded" && (regions === "succeeded" || regions === "failed")) {
    return { image, regions };
  }
  return null;
}

/** Explicit overrides for the two optional speaking steps. Mandatory steps keep using ordinal
 * `stepState`; these override `allDone` so a non-fatal fallback never turns into a checkmark. */
export function sceneStepStates(outcome: SceneGenerationOutcome | null): Partial<Record<string, StepState>> {
  if (!outcome) return {};
  return {
    "rendering-image": outcome.image === "succeeded" ? "done" : "unavailable",
    "locating-regions":
      outcome.regions === "succeeded"
        ? "done"
        : outcome.regions === "skipped"
          ? "skipped"
          : "unavailable",
  };
}

/**
 * One line describing the tolerated overlaps: how many, with which Sets, and of what kinds. Counts,
 * ids and kind names only, because the residual payload carries nothing else
 * (scrubDiversityIssues in server/src/services/diversityIssues.ts).
 */
export function noveltyResidualSummary(residual: readonly NoveltyResidualIssue[]): string {
  const setIds = [...new Set(residual.flatMap((entry) => entry.conflictingSetIds ?? []))].sort();
  const kinds = [...new Set(residual.map((entry) => entry.kind))].sort();
  const overlaps = `${residual.length} tolerated overlap${residual.length === 1 ? "" : "s"}`;
  const against = setIds.length > 0 ? ` with ${setIds.join(", ")}` : "";
  return `Novelty: ${overlaps}${against} (${kinds.join(", ")}). The set is usable; it repeats content already in your bank.`;
}

export function sceneOutcomeSummary(outcome: SceneGenerationOutcome): string {
  if (outcome.image === "failed") return "Audio only — scene unavailable; regions skipped.";
  if (outcome.regions === "failed") return "Scene ready; focus regions unavailable.";
  return "Scene and focus regions ready.";
}
