import type { BuildupDiffOp, FocusRegion, ServedSpeakingSet, TranscriptionJobVM } from "@toefl-prep/shared";
import type { RunnableItem } from "../../components/ItemRecorder";
import type { JudgeSummary, ScoreReportItem } from "../../components/ScoreCard";

// The Speaking Drill's data: what a Task's scoring job returns, what a result slot carries, and the
// state of each recording on its way to the server. Pure — the screens in this directory and
// SpeakingDrill.tsx render it.
//
// The served Set carries no `sentence`/`question` text: stripAnswers removes both before a Drill
// ever sees the Set, because they are what the Drill exists to elicit unseen. Results render the
// target sentence and the question from the scoring job's per-Item meta instead.

export type SpeakingTaskKind = "listen_repeat" | "interview";

type SpeakingJudgeItemScore = {
  itemId: string;
  score: number;
  dimensions: { name: string; score: number; evidence: string }[];
  deductions: ScoreReportItem["deductions"];
};
type SpeakingJudgeBatch = { judge: "gemini" | "openai"; mode: "audio" | "text-fallback"; items: SpeakingJudgeItemScore[] };
type SpeakingScoreItemMeta = { itemId: string; target?: string; diff?: BuildupDiffOp[]; question?: string };

/**
 * The terminal `result` of a listen_repeat/interview scoring job: the return shape of scoreSpeaking
 * in server/src/services/scoreItems.ts.
 */
export type SpeakingScoreResult = {
  taskType: SpeakingTaskKind;
  report: { taskType: string; items: ScoreReportItem[] };
  judges: SpeakingJudgeBatch[];
  judgesFailed: string[];
  items: SpeakingScoreItemMeta[];
};

/** The scene a Listen and Repeat result is drawn against, frozen at the moment its slot was made. */
export type SceneSnapshot = Readonly<{
  file: string;
  focusRegionsByItemId: Readonly<Record<string, Readonly<FocusRegion> | undefined>>;
}>;

/**
 * One Task's result slot, appended the moment every Item of the Task has settled (landed a
 * transcript, or been durably taken for background recovery), not once scored. Its scoring job runs
 * while the Drill moves on, so in a Drill of both Task Types the Listen and Repeat job runs during
 * the Interview.
 *
 * `items` is the scoreable subset (Items taken for recovery are left out), so its index is not the
 * Item's position in the Task. `numberByItemId` carries each Item's original 1-based position, so
 * leaving Item 3 out does not renumber Items 4–7 in the results.
 */
export type SpeakingSlotSpec = {
  kind: SpeakingTaskKind;
  items: RunnableItem[];
  transcripts: Record<string, string>;
  numberByItemId: Record<string, number>;
  scene?: SceneSnapshot;
};

/**
 * A recording's way to the server.
 *
 * - `uploading`             — on its way.
 * - `done`                  — accepted and transcribed; scoreable.
 * - `recovery-pending`      — accepted and stored (HTTP 202), transcription still to come; the
 *                             server's own recovery owns it, so nothing is offered here. `job` tells
 *                             a job still retrying apart from one whose automatic retries are spent.
 * - `retryable-failed`      — never reached the server; the same recording is worth resending.
 * - `needs-rerecord-failed` — the server inspected it and refused it; only a fresh take helps.
 */
export type UploadStatus = "uploading" | "done" | "recovery-pending" | "retryable-failed" | "needs-rerecord-failed";
export type UploadEntry = { status: UploadStatus; blob: Blob; job?: TranscriptionJobVM };

/** Every Item of a Task has settled: it can be handed to scoring and the Drill can move on. */
export function allSettled(items: RunnableItem[], uploads: Record<string, UploadEntry>): boolean {
  return items.every((it) => {
    const status = uploads[it.id]?.status;
    return status === "done" || status === "recovery-pending";
  });
}

/** How many of a Task's recordings have settled, for the uploads screen's bar. */
export function settledCount(items: RunnableItem[], uploads: Record<string, UploadEntry>): number {
  return items.filter((it) => {
    const status = uploads[it.id]?.status;
    return status === "done" || status === "recovery-pending";
  }).length;
}

export function judgesForItem(result: SpeakingScoreResult, itemId: string): JudgeSummary[] {
  return result.judges.flatMap((j) => {
    const item = j.items.find((i) => i.itemId === itemId);
    return item ? [{ judge: j.judge, mode: j.mode, score: item.score, dimensions: item.dimensions, deductions: item.deductions }] : [];
  });
}

export function snapshotScene(set: ServedSpeakingSet): SceneSnapshot | undefined {
  const image = set.listenAndRepeat.image;
  if (!image) return undefined;
  const focusRegionsByItemId = Object.fromEntries(
    set.listenAndRepeat.items.map((item) => [item.id, item.focusRegion ? Object.freeze({ ...item.focusRegion }) : undefined]),
  );
  return Object.freeze({ file: image.file, focusRegionsByItemId: Object.freeze(focusRegionsByItemId) });
}
