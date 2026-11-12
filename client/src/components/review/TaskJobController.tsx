import { useCallback, useEffect, useState } from "react";
import type { ItemVM } from "@toefl-prep/shared";
import { scoreTask } from "../../lib/api";
import { scoringInterrupted } from "../../lib/progressUtils";
import { useScoringJob, type ScoringJobState } from "../../hooks/useScoringJob";
import { buildRescoreRequest } from "./reviewItems";

// Identity for one mounted controller. The page stores each Task Type's live view tagged with the
// instance that produced it, so an instance's unmount cleanup can clear its own entry and never a
// successor's: a progress panel must not disappear from under a live job because of effect order.
let controllerInstanceSeq = 0;

export type TaskJobControllerProps = {
  attemptId: string;
  taskType: string;
  /** The job to re-attach to, or null when this controller was armed by a Re-score and must start one. */
  jobId: string | null;
  /** What a (re)start sends — the Task Type's current re-score candidates. */
  rescoreItems: ItemVM[];
  onView: (taskType: string, instanceId: number, view: ScoringJobState) => void;
  onUnmounted: (taskType: string, instanceId: number) => void;
  onLanded: (taskType: string) => void;
  onFailed: (taskType: string) => void;
};

/**
 * Headless: owns one scoring job's lifecycle for one (Attempt, Task Type) and reports its live state
 * up through `onView`, so every Item card the job covers can draw the same progress (one job may
 * cover several Items, or only the one a Re-score or a transcription recovery sent).
 *
 * - `onLanded` releases the Task Type and refreshes the Attempt, so persisted results replace the
 *   progress. It fires when the job is done, and when a newer scoring of the same Task Type
 *   replaced it (cancelled with reason `superseded`): the refreshed Attempt lists the job that
 *   replaced it, and the page follows that one.
 * - `onFailed` refreshes too, so a retry recomputes its Items from the now-true failed status, but
 *   the controller stays mounted so the failure and its Retry stay on screen. It fires when the job
 *   failed, and when it was cancelled for any other reason than supersession (the server stopping
 *   mid-scoring, a cancel request): nothing replaces such a job, and the server marks its Items
 *   failed.
 * - `onUnmounted` is the backstop for every other way it goes away; without it, a controller that
 *   left before a terminal status would leave a frozen progress panel over scores that had landed.
 *
 * useScoringJob is always given both the jobId (when re-attaching) and a `start`, so a re-attached job
 * that ends up failed still has a Retry that does something.
 */
export default function TaskJobController({
  attemptId,
  taskType,
  jobId,
  rescoreItems,
  onView,
  onUnmounted,
  onLanded,
  onFailed,
}: TaskJobControllerProps) {
  const [instanceId] = useState(() => {
    controllerInstanceSeq += 1;
    return controllerInstanceSeq;
  });

  const start = useCallback(async (): Promise<{ jobId: string }> => {
    const req = buildRescoreRequest(taskType, rescoreItems);
    if (!req) throw new Error(`nothing to re-score for task type ${taskType}`);
    const res = await scoreTask(attemptId, req);
    if (!("jobId" in res)) throw new Error("unexpected synchronous response re-scoring this task type");
    return res;
  }, [attemptId, taskType, rescoreItems]);

  const job = useScoringJob(attemptId, { jobId: jobId ?? undefined, start });

  useEffect(() => {
    onView(taskType, instanceId, job);
    // `job` is a fresh object every render by design; onView fires on every tick (including the
    // elapsed-time ticker) and the parent bails out when nothing it renders has changed.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [taskType, instanceId, job]);

  useEffect(() => {
    return () => onUnmounted(taskType, instanceId);
    // onUnmounted is stable, and taskType/instanceId are fixed for one instance: mount/unmount only.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    const replaced = job.status === "cancelled" && job.cancellationReason === "superseded";
    if (job.status === "done" || replaced) onLanded(taskType);
    else if (job.status === "failed" || scoringInterrupted(job.status, job.cancellationReason)) onFailed(taskType);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [job.status, job.cancellationReason, taskType]);

  return null;
}
