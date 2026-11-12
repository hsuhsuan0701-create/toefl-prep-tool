import {
  SpeakingGenerationInputSchema,
  WritingGenerationInputSchema,
  type GenerationPlan,
  type SetAdvisoryNote,
} from "@toefl-prep/shared";
import {
  BUILD_A_SENTENCE_TILE_MAX,
  BUILD_A_SENTENCE_TILE_RAMP_FLOOR,
} from "./buildASentenceConformance.js";

// What Speaking's and Writing's candidate adapters share. Both sections run the same
// GENERATE-then-check shape (no assembly step, no repair call, one deterministic content gate) and
// send the same GENERATE prompt apart from a per-section retry preamble, kept here so the two
// cannot drift apart. Which gate runs and what an unrepaired violation costs live in
// speakingGenerator.ts and writingGenerator.ts.

export function candidateSchema(kind: "speaking" | "writing") {
  return kind === "speaking"
    ? SpeakingGenerationInputSchema
    : WritingGenerationInputSchema;
}

/**
 * The shape both content gates report in: a position, a kind, and a counts-only detail.
 * BuildASentenceViolation and SpeakingViolation each satisfy it structurally.
 */
export type ConformanceViolationLike = {
  readonly label: string;
  readonly kind: string;
  readonly detail: string;
};

/**
 * What the next attempt is told, as JSON: every violation at once, so one regeneration can fix the
 * whole Set rather than trading one defect for another across attempts. Safe to embed in a prompt
 * verbatim: neither gate puts Item content in `label` or `detail`, only positions and counts.
 */
export function conformanceRetryDetail(
  violations: readonly ConformanceViolationLike[],
): { violations: { label: string; kind: string; detail: string }[] } {
  return {
    violations: violations.map(({ label, kind, detail }) => ({ label, kind, detail })),
  };
}

/** The durable record an advisory violation leaves on the published Set. Positions, never content. */
export function conformanceAdvisoryNotes(
  taskType: "build_sentence" | "listen_repeat",
  violations: readonly ConformanceViolationLike[],
): SetAdvisoryNote[] {
  return violations.map((violation) => ({
    // The same `content-gate` note the Reading and Listening gates write: the kind, nothing else.
    check: "content-gate" as const,
    detail: violation.kind,
    taskType,
    // `label` ends in the Item's index ("buildASentence/items[3]"); the note carries it as a
    // number, as every other check's note does.
    ...(itemPositionOf(violation.label) !== undefined
      ? { itemPosition: itemPositionOf(violation.label) }
      : {}),
  }));
}

function itemPositionOf(label: string): number | undefined {
  const match = /\[(\d+)\]$/u.exec(label);
  return match ? Number(match[1]) : undefined;
}

/**
 * The GENERATE prompt Speaking and Writing share. `conformanceRetry` is set only on an attempt that
 * follows a content-gate rejection, and carries that rejection's whole violation list.
 */
export function generationPrompt(
  kind: "speaking" | "writing",
  plan: GenerationPlan,
  conformanceRetry?: ReturnType<typeof conformanceRetryDetail>,
): string {
  return [
    `/toefl-${kind}`,
    `GENERATE ${kind}`,
    "",
    "Produce one complete set as JSON matching the supplied generation-input schema.",
    "Follow this accepted server plan exactly. Do not emit generationPlan.",
    "",
    "```accepted-plan-json",
    JSON.stringify(plan),
    "```",
    // The retry preamble is per section because the gates are: Writing's counts tiles and blanks,
    // Speaking's counts Listen and Repeat words and estimated clip length.
    ...(conformanceRetry
      ? [
          "",
          ...(kind === "speaking"
            ? [
                "The previous attempt's Listen and Repeat sentences listed below ran past their",
                "items' word ceilings. Rewrite every listed sentence within its ceiling in this",
                "attempt. Length should trend upward across the seven items without rising at every",
                "step — ties and local dips are fine — and difficulty should come from structure,",
                "not from extra words.",
                "",
                "```listen-and-repeat-conformance-retry",
              ]
            : [
                "The previous attempt's Build a Sentence Items broke the format below. Fix every one of",
                "them in this attempt; a frame's blanks are runs of three or more underscores, and a",
                // Interpolated from the gate's constants so the range cannot fall behind the gate.
                // The floor is the generation guide's ramp floor, not `BUILD_A_SENTENCE_TILE_MIN`:
                // that is a gate-only tolerance, and a model told "4-10" writes four-tile Items a
                // step below the ramp (see optionQuality.ts's header). The ceiling is the gate's.
                `conforming Item has ${BUILD_A_SENTENCE_TILE_RAMP_FLOOR}-${BUILD_A_SENTENCE_TILE_MAX} tiles with exactly one left over as a distractor.`,
                "",
                "```build-a-sentence-conformance-retry",
              ]),
          JSON.stringify(conformanceRetry),
          "```",
        ]
      : []),
  ].join("\n");
}
