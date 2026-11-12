import {
  WritingGenerationInputSchema,
  toPersistedWritingSet,
  type GenerationPlan,
  type WritingSet,
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
import {
  buildASentenceViolations,
  type BuildASentenceViolation,
} from "./buildASentenceConformance.js";
import { blocksGeneration } from "./generationCheckPolicy.js";

// Writing's adapter for the shared candidate loop (generationCandidateLoop.ts): the GENERATE call's
// schema and prompt, Item id validation, and the Build a Sentence content gate.

/**
 * Splits the Build a Sentence gate's findings by their tier in generationCheckPolicy.ts. `blocking`
 * still fails the job once the regeneration budget is spent: the kinds in
 * BUILD_A_SENTENCE_UNUSABLE_KINDS, which leave an Item unattemptable or mis-keyed. `advisory` is
 * recorded on the published Set.
 */
function splitBuildASentenceViolations(
  violations: readonly BuildASentenceViolation[],
): { blocking: BuildASentenceViolation[]; advisory: BuildASentenceViolation[] } {
  const blocking: BuildASentenceViolation[] = [];
  const advisory: BuildASentenceViolation[] = [];
  for (const violation of violations) {
    const check = {
      family: "content-gate",
      section: "writing",
      kind: violation.kind,
    } as const;
    if (blocksGeneration(check)) blocking.push(violation);
    else advisory.push(violation);
  }
  return { blocking, advisory };
}

/**
 * The one way a Writing candidate is rejected: the Build a Sentence gate flagged it while attempts
 * remained. The next attempt is handed the whole violation list.
 */
type WritingRejection = {
  readonly rejection: "conformance";
  readonly hint: ReturnType<typeof conformanceRetryDetail>;
};

export function writingCandidateAdapter(
  plan: GenerationPlan,
): CandidateAdapter<WritingSet, WritingSet, WritingRejection> {
  return {
    task: { task: "generate", context: "writing" },
    jsonSchema: toProviderJsonSchema(WritingGenerationInputSchema),
    parseResponse: (value) => WritingGenerationInputSchema.parse(value),
    parseCandidate: (value) =>
      toPersistedWritingSet(WritingGenerationInputSchema.parse({
        ...(value as object),
        id: "pending-candidate",
        source: "generated",
        createdAt: "1970-01-01T00:00:00.000Z",
      })),
    prompt: (hints) => generationPrompt("writing", plan, hints.conformance),
    prepare: async ({ raw }) => {
      validateItemIds(raw);
      return { candidate: raw };
    },
    decide: ({ candidate, ctx }) => {
      if (plan.kind !== "writing") {
        throw new Error("set validation failed: generation kind mismatch");
      }
      const violations = buildASentenceViolations(candidate);
      const { blocking: unusable, advisory: tolerated } =
        splitBuildASentenceViolations(violations);
      // While attempts remain, every violation, blocking or not, buys a regeneration that is told
      // the whole list, since a retry told about half the defects reproduces the other half. Only
      // the ending is tiered: an unrepaired advisory violation is published as a note, an
      // unrepaired blocking one fails the job (docs/adr/0006).
      if (violations.length > 0 && ctx.attempt < ctx.attemptBudget) {
        console.error(
          `[generator] writing candidate attempt ${ctx.attempt}/${ctx.attemptBudget} rejected (build-a-sentence conformance):`,
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
            `set validation failed: build a sentence items are unusable after ${ctx.attempt} attempts`,
            JSON.stringify(conformanceRetryDetail(unusable)),
          ].join("\n"),
        );
      }
      if (tolerated.length > 0) {
        console.warn(
          `[generator] writing candidate accepted with ${tolerated.length} tolerated build-a-sentence format violation(s):`,
          JSON.stringify(conformanceRetryDetail(tolerated)),
        );
      }
      const accepted: PlannedCandidate = {
        kind: "writing",
        candidate,
        plan,
        ...(tolerated.length > 0
          ? { advisoryNotes: conformanceAdvisoryNotes("build_sentence", tolerated) }
          : {}),
      };
      return { accepted };
    },
    // Unreachable: a rejection is issued only while attempts remain, so the last attempt always
    // accepts or fails on an unusable Item. The loop requires every adapter to describe exhaustion.
    describeExhaustion: ({ attempts }) =>
      `set validation failed: writing candidate rejected on all ${attempts} attempts`,
  };
}
