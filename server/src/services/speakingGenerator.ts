import {
  SpeakingGenerationInputSchema,
  type GenerationPlan,
  type SpeakingGenerationInput,
} from "@toefl-prep/shared";
import { toProviderJsonSchema } from "./reasoning/jsonSchema.js";
import {
  validateItemIds,
  type CandidateAdapter,
  type PlannedCandidate,
} from "./generationCandidateLoop.js";
import {
  conformanceAdvisoryNotes,
  conformanceRetryDetail,
  generationPrompt,
} from "./speakingWritingCandidate.js";
import { listenAndRepeatViolations, type SpeakingViolation } from "./speakingConformance.js";
import { blocksGeneration } from "./generationCheckPolicy.js";
import { speakingClipIdProblem } from "./speakingAudioRenderer.js";

// Speaking's adapter for the shared candidate loop (generationCandidateLoop.ts): the GENERATE call's
// schema and prompt, Item id validation, and the Listen and Repeat content gate.

/**
 * Splits the Listen and Repeat gate's findings by their tier in generationCheckPolicy.ts: `blocking`
 * fails the job once the regeneration budget is spent, `advisory` is recorded on the published Set.
 * Every Speaking kind is repair-then-accept ending in advisory today, so `blocking` is empty; the
 * split is here so that a tier change is made in the policy alone.
 */
function splitListenAndRepeatViolations(
  violations: readonly SpeakingViolation[],
): { blocking: SpeakingViolation[]; advisory: SpeakingViolation[] } {
  const blocking: SpeakingViolation[] = [];
  const advisory: SpeakingViolation[] = [];
  for (const violation of violations) {
    if (blocksGeneration({ family: "content-gate", section: "speaking", kind: violation.kind })) {
      blocking.push(violation);
    } else {
      advisory.push(violation);
    }
  }
  return { blocking, advisory };
}

/**
 * The two ways a Speaking candidate is rejected.
 *
 *  - `conformance` — the Listen and Repeat gate flagged it while attempts remained. The next attempt
 *    is handed the whole violation list.
 *  - `item-ids` — an Item id that is malformed, used twice, or would name the same clip file as
 *    another (speakingClipIdProblem): drift from one probabilistic call, so it costs the attempt
 *    rather than the run, as Listening's does. It carries no prompt hint.
 */
type SpeakingRejection =
  | {
      readonly rejection: "conformance";
      readonly hint: ReturnType<typeof conformanceRetryDetail>;
    }
  | {
      readonly rejection: "item-ids";
      readonly hint?: undefined;
      readonly message: string;
    };

export function speakingCandidateAdapter(
  plan: GenerationPlan,
): CandidateAdapter<SpeakingGenerationInput, SpeakingGenerationInput, SpeakingRejection> {
  return {
    task: { task: "generate", context: "speaking" },
    jsonSchema: toProviderJsonSchema(SpeakingGenerationInputSchema),
    parseResponse: (value) => SpeakingGenerationInputSchema.parse(value),
    parseCandidate: (value) =>
      SpeakingGenerationInputSchema.parse({
        ...(value as object),
        id: "pending-candidate",
        source: "generated",
        createdAt: "1970-01-01T00:00:00.000Z",
      }),
    prompt: (hints) => generationPrompt("speaking", plan, hints.conformance),
    prepare: async ({ raw, ctx }) => {
      let message: string | undefined;
      try {
        validateItemIds(raw);
        // Clip file names too, which validateItemIds does not see: a case-insensitive clash or a
        // reserved name would otherwise surface only at render.
        const clipIdProblem = speakingClipIdProblem(raw);
        if (clipIdProblem) message = `set validation failed: ${clipIdProblem}`;
      } catch (error) {
        message = error instanceof Error ? error.message : String(error);
      }
      if (message !== undefined) {
        console.error(`[generator] speaking candidate attempt ${ctx.attempt}/${ctx.attemptBudget} rejected (item-id validation): ${message}`);
        return { rejected: { rejection: "item-ids", message } };
      }
      return { candidate: raw };
    },
    decide: ({ candidate, ctx }) => {
      if (plan.kind !== "speaking") {
        throw new Error("set validation failed: generation kind mismatch");
      }
      // The Listen and Repeat word-count and clip-duration checks. While attempts remain, any
      // violation buys a regeneration: both checks are arithmetic and run before the TTS and image
      // renders, so a regeneration wastes no render. On the last attempt the policy decides: a
      // blocking kind fails the job, and the rest are recorded as advisory notes.
      const violations = listenAndRepeatViolations(candidate.listenAndRepeat.items);
      const { blocking: unusable, advisory: tolerated } = splitListenAndRepeatViolations(violations);
      if (violations.length > 0 && ctx.attempt < ctx.attemptBudget) {
        console.error(
          `[generator] speaking candidate attempt ${ctx.attempt}/${ctx.attemptBudget} rejected (listen-and-repeat conformance):`,
          JSON.stringify(conformanceRetryDetail(violations)),
        );
        return {
          rejected: {
            rejection: "conformance",
            hint: conformanceRetryDetail(violations),
          },
        };
      }
      if (unusable.length > 0) {
        throw new Error(
          [
            `set validation failed: listen and repeat items are unusable after ${ctx.attempt} attempts`,
            JSON.stringify(conformanceRetryDetail(unusable)),
          ].join("\n"),
        );
      }
      if (tolerated.length > 0) {
        console.warn(
          `[generator] speaking candidate accepted with ${tolerated.length} tolerated listen-and-repeat conformance violation(s):`,
          JSON.stringify(conformanceRetryDetail(tolerated)),
        );
      }
      const accepted: PlannedCandidate = {
        kind: "speaking",
        candidate,
        plan,
        ...(tolerated.length > 0
          ? { advisoryNotes: conformanceAdvisoryNotes("listen_repeat", tolerated) }
          : {}),
      };
      return { accepted };
    },
    // A conformance rejection is issued only while attempts remain, so the attempt that spends the
    // budget was rejected over its ids.
    describeExhaustion: ({ attempts, newest }) =>
      newest.rejection === "item-ids"
        ? `generated content failed item-id validation on every attempt: ${newest.message}`
        : `set validation failed: speaking candidate rejected on all ${attempts} attempts`,
  };
}
