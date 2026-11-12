import type { GenerationProgressDetail as SharedGenerationProgressDetail } from "@toefl-prep/shared";
import type { RouteResult } from "./reasoning/contracts.js";
import { withModelCallDetail } from "./modelCallLog.js";
import type {
  SkillTaskRequest,
} from "./reasoning/router.js";

export type DiversityAttempt = 1 | 2 | 3;

export type GenerationProgressDetail = SharedGenerationProgressDetail & {
  position?: number;
  setId?: string;
  planningAttempt?: DiversityAttempt;
  generationAttempt?: DiversityAttempt;
  maxDiversityAttempts?: 3;
};

/**
 * The checkpoints a generation job really reaches; progress never creeps on a timer. A generated
 * Set starts `planning` -> `generating` (an import starts at `generating`). Writing, Reading and
 * Listening then go `verifying`, during which a remediation call reports `generating` again;
 * Speaking and Listening go `rendering-audio` (Speaking with a true done/13 clip count); Speaking
 * then goes `rendering-image` -> `locating-regions`; every kind ends at `saving`. The two scene
 * checkpoints can be skipped, because a failed scene call never fails the Set: a failed image goes
 * straight to `saving`.
 *
 * `queued` is orthogonal: it fires only when a call has to wait for a CLI provider slot (ADR 0007),
 * with `queuePosition` (calls of its family queued ahead of it, not those running) and `position`
 * (the same number under its older name), so the client can show a waiting state instead of a
 * misleading `generating`.
 *
 * `setId` rides on every event from the moment the Set id is minted (after a candidate is accepted,
 * or an import parsed), so the job row learns what to clean up before anything is published.
 */
export type GenerationStage =
  | "queued"
  | "planning"
  | "generating"
  | "verifying"
  | "rendering-audio"
  | "rendering-image"
  | "locating-regions"
  | "saving";

export type GenerationProgress = {
  stage: GenerationStage;
  detail?: GenerationProgressDetail;
};

export type OnGenerationProgress = (progress: GenerationProgress) => void;

export type SkillTaskRunner = <T>(
  request: SkillTaskRequest<T>,
) => Promise<RouteResult<T, "claude" | "codex">>;

function attemptDetail(input: {
  planningAttempt?: DiversityAttempt;
  generationAttempt?: DiversityAttempt;
}): Pick<
  GenerationProgressDetail,
  "planningAttempt" | "generationAttempt" | "maxDiversityAttempts"
> {
  const hasAttempt =
    input.planningAttempt !== undefined ||
    input.generationAttempt !== undefined;
  return {
    ...(input.planningAttempt === undefined
      ? {}
      : { planningAttempt: input.planningAttempt }),
    ...(input.generationAttempt === undefined
      ? {}
      : { generationAttempt: input.generationAttempt }),
    ...(hasAttempt ? { maxDiversityAttempts: 3 } : {}),
  };
}

/**
 * A verify call, with one more try when it fails.
 *
 * Verification runs after the whole candidate has been generated and assembled, so one provider
 * failure there would discard everything already paid for. One retry is the bound: a second failure
 * is returned as is and fails the job. A cancelled call is never retried. The log names failure
 * kinds only, never the error text, which can quote a model's reply.
 */
export async function callVerifySkillTask<T>(
  input: Parameters<typeof callGenerationSkillTask<T>>[0] & { stage: "verifying"; logPrefix: string },
): Promise<RouteResult<T, "claude" | "codex">> {
  const { logPrefix, ...call } = input;
  const first = await callGenerationSkillTask(call);
  if (first.ok || "cancelled" in first) return first;
  console.warn(
    `${logPrefix} verify call failed (${first.attempts.map((a) => `${a.provider}:${a.kind}`).join(", ") || "no attempts"}); retrying once`,
  );
  return callGenerationSkillTask(call);
}

/**
 * Runs one skill-backed generation call (plan, generate or verify) and turns the router's events
 * into generation progress: `queued` while the call waits for a provider slot, otherwise the call's
 * own stage, each carrying the provider and any fallback.
 */
export function callGenerationSkillTask<T>(input: {
  run: SkillTaskRunner;
  task: SkillTaskRequest<T>["task"];
  prompt: string;
  jsonSchema: object;
  parse: (value: unknown) => T;
  stage: "planning" | "generating" | "verifying";
  onProgress?: OnGenerationProgress;
  setId?: string;
  planningAttempt?: DiversityAttempt;
  generationAttempt?: DiversityAttempt;
}): Promise<RouteResult<T, "claude" | "codex">> {
  let fallbackFrom: "claude" | undefined;
  const attempts = attemptDetail(input);
  // Stamps the stage and attempt number on the call's diagnostic rows. Without it a job's three
  // generate calls are near-identical in the log, with nothing to order or tell them apart.
  return withModelCallDetail(
    {
      stage: input.stage,
      ...attempts,
      ...(input.setId ? { setId: input.setId } : {}),
    },
    () =>
      input.run({
        task: input.task,
        prompt: input.prompt,
        jsonSchema: input.jsonSchema,
        parse: input.parse,
        onEvent: (event) => {
          if (event.state === "fallback") {
            fallbackFrom =
              event.fallbackFrom === "claude" ? "claude" : undefined;
            return;
          }
          if (event.state === "queued") {
            input.onProgress?.({
              stage: "queued",
              detail: {
                provider: event.provider,
                queuePosition: event.queuePosition,
                position: event.queuePosition,
                ...(fallbackFrom ? { fallbackFrom } : {}),
                ...(input.setId ? { setId: input.setId } : {}),
                ...attempts,
              },
            });
            return;
          }
          input.onProgress?.({
            stage: input.stage,
            detail: {
              provider: event.provider,
              ...(event.fallbackFrom
                ? { fallbackFrom: event.fallbackFrom }
                : {}),
              ...(input.setId ? { setId: input.setId } : {}),
              ...attempts,
            },
          });
        },
      }),
  );
}
