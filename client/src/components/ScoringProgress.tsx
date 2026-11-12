import type { CancellationReason } from "@toefl-prep/shared";
import type { ScoringJobUiStatus } from "../hooks/useScoringJob";
import { cancellationStatusLabel, formatElapsed, scoringInterrupted } from "../lib/progressUtils";
import { Button } from "../ui/Button";
import { Chip } from "../ui/Chip";
import { Notice } from "../ui/Notice";
import { StepProgress, type Step, type StepState } from "../ui/Progress";
import { asSentence } from "../ui/format";
import { SCORING_JOB_STATUS } from "../ui/labels";

/**
 * Everything this panel draws, as one object: structurally a subset of `useScoringJob`'s
 * `ScoringJobState`, so a caller hands its hook state straight in (`job={job}`). Declared
 * structurally so a caller holding an equivalent view (Attempt review's shared per-Task-Type job
 * view) satisfies it too. The cancellation fields are optional for callers that never cancel.
 */
export type ScoringProgressJob = {
  status: ScoringJobUiStatus;
  stage: string | null;
  judgesDone: string[];
  judgesFailed: string[];
  openaiJudgeProvider: "codex" | "openai-http" | null;
  arbiterProvider: "claude" | "codex" | null;
  fallbackFrom: "claude" | "codex" | null;
  queuePosition: number | null;
  elapsedMs: number;
  error: string | null;
  cancellationRequestedAt?: string | null;
  terminalAt?: string | null;
  cancellationReason?: CancellationReason | null;
};

export type ScoringProgressProps = {
  job: ScoringProgressJob;
  /** The caller decides what Retry means (a fresh job, a re-score, …). */
  onRetry: () => void;
};

// The three real checkpoints scoring reports (Judges, Arbiter, saving), never a creeping percent.
const STAGES = ["judging", "aggregating", "persisting"] as const;

function stepState(stage: (typeof STAGES)[number], current: string | null, allDone: boolean): StepState {
  if (allDone) return "done";
  const at = STAGES.indexOf(current as (typeof STAGES)[number]);
  const mine = STAGES.indexOf(stage);
  if (at < 0) return "pending";
  return mine < at ? "done" : mine === at ? "active" : "pending";
}

// Which service is doing the work is shown while it runs: an operational fact about a live job, not
// part of the Score Report it produces.
const ROUTE = { claude: "Claude", codex: "Codex" } as const;

function arbiterDetail(job: ScoringProgressJob): string | null {
  const { arbiterProvider, fallbackFrom, queuePosition } = job;
  if (!arbiterProvider) return null;
  const name = ROUTE[arbiterProvider];
  if (fallbackFrom && fallbackFrom !== arbiterProvider) return `Switched from ${ROUTE[fallbackFrom]} to ${name}`;
  if (queuePosition === null) return `${name} is arbitrating`;
  if (queuePosition <= 0) return `Waiting for a slot with ${name}`;
  return `${queuePosition} ${queuePosition === 1 ? "request" : "requests"} ahead in ${name}'s queue`;
}

/**
 * A scoring job while it runs: Judges → Arbiter → saving as words-first checkpoints, each Judge's
 * state as a chip, the elapsed time, and a failure with its Retry. The current checkpoint is
 * announced once when it changes (StepProgress), and the waiting states have their own announcement.
 */
export default function ScoringProgress({ job, onRetry }: ScoringProgressProps) {
  const { status, stage, judgesDone, judgesFailed, openaiJudgeProvider, elapsedMs, error, cancellationRequestedAt, terminalAt, cancellationReason } = job;

  if (status === "failed") {
    return (
      <Notice
        tone="critical"
        live="assertive"
        title="Scoring failed"
        action={
          <Button size="sm" onClick={onRetry}>
            Retry scoring
          </Button>
        }
      >
        {error ? asSentence(error) : "Something went wrong while scoring this Response."}
      </Notice>
    );
  }

  // Nothing replaces a job cancelled for any reason but supersession, so it ends as a failure does:
  // what stopped it, in the cancellation's own words, and a Retry.
  if (scoringInterrupted(status, cancellationReason)) {
    return (
      <Notice
        tone="critical"
        live="assertive"
        title="Scoring was interrupted"
        action={
          <Button size="sm" onClick={onRetry}>
            Retry scoring
          </Button>
        }
      >
        {asSentence(cancellationStatusLabel(cancellationReason))}
      </Notice>
    );
  }

  if (status === "cancelled" || (terminalAt && cancellationReason)) {
    return <Notice tone="info">{cancellationStatusLabel(cancellationReason)}</Notice>;
  }

  const allDone = status === "done";
  const waiting = status === "starting" || (status === "queued" && stage === null);
  const judges = [
    { key: "gemini", label: "Gemini" },
    { key: "openai", label: openaiJudgeProvider ? `OpenAI · ${openaiJudgeProvider === "codex" ? "Codex" : "HTTP"}` : "OpenAI" },
  ];
  const showJudges = stage === "judging" || judgesDone.length > 0 || judgesFailed.length > 0;

  const steps: Step[] = [
    {
      key: "judging",
      label: "Judges",
      state: stepState("judging", stage, allDone),
      detail: showJudges ? (
        <span className="mt-1 flex flex-wrap gap-1.5">
          {judges.map((j) =>
            judgesFailed.includes(j.key) ? (
              <Chip key={j.key} tone="critical" glyph="cross">
                {j.label} failed
              </Chip>
            ) : judgesDone.includes(j.key) ? (
              <Chip key={j.key} tone="positive" glyph="check">
                {j.label} done
              </Chip>
            ) : (
              <Chip key={j.key} glyph="pending">
                {j.label} working
              </Chip>
            ),
          )}
        </span>
      ) : undefined,
    },
    { key: "aggregating", label: "Arbiter", state: stepState("aggregating", stage, allDone), detail: stage === "aggregating" ? arbiterDetail(job) : undefined },
    { key: "persisting", label: "Saving", state: stepState("persisting", stage, allDone) },
  ];

  const heading = status === "starting" ? "Starting…" : waiting ? SCORING_JOB_STATUS.queued.label : allDone ? "Scored" : "Scoring";

  return (
    <div className="space-y-4 rounded-sheet border border-rule bg-sheet p-4" aria-busy={!allDone}>
      <p aria-live="polite" className="sr-only">
        {status === "starting" ? "Scoring is starting." : waiting ? "Scoring is waiting its turn." : ""}
      </p>
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <p className="text-ui font-medium text-ink">{heading}</p>
        <p className="text-meta text-graphite">
          <span className="figures">{formatElapsed(elapsedMs)}</span> elapsed
        </p>
      </div>
      {cancellationRequestedAt && <p className="text-ui font-medium text-caution">Cancellation requested…</p>}
      <StepProgress label="Scoring" steps={steps} />
      <p className="text-meta text-graphite">Scoring usually takes 1–2 minutes.</p>
    </div>
  );
}
