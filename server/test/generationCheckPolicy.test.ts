import { describe, expect, it } from "vitest";

import {
  blocksGeneration,
  classifyGenerationCheck,
  GENERATION_SECTIONS,
  LISTENING_REMEDIABLE_KINDS,
  READING_REMEDIABLE_KINDS,
  type GenerationCheck,
} from "../src/services/generationCheckPolicy.js";
import type { DiversityIssueKind, NoveltyTaskType } from "../src/services/diversityIssues.js";
import type { PaceVerdict } from "../src/services/audioPace.js";
import type { ListeningViolationKind as GeneratorListeningViolationKind } from "../src/services/listeningGenerator.js";
import type { ReadingViolationKind as GeneratorReadingViolationKind } from "../src/services/readingGenerator.js";
import type { BuildASentenceViolationKind as GateBuildASentenceViolationKind } from "../src/services/buildASentenceConformance.js";
import type { SpeakingViolationKind as GateSpeakingViolationKind } from "../src/services/speakingConformance.js";
import type {
  BuildASentenceViolationKind as PolicyBuildASentenceViolationKind,
  ListeningViolationKind as PolicyListeningViolationKind,
  ReadingViolationKind as PolicyReadingViolationKind,
  SpeakingViolationKind as PolicySpeakingViolationKind,
} from "../src/services/generationCheckPolicy.js";

// The policy restates the content-gate kind unions instead of importing them, so that it imports
// from no generator or gate (see its own doc comment). These four assignments keep the restatement
// honest: each union must be assignable to the other in both directions, so a kind added to or
// removed from either side fails to compile here until the policy classifies it. A one-directional
// check would pass while the policy silently lost a kind.
type AssignableTo<A extends B, B> = A & B;
export type ReadingKindsAgree = [
  AssignableTo<PolicyReadingViolationKind, GeneratorReadingViolationKind>,
  AssignableTo<GeneratorReadingViolationKind, PolicyReadingViolationKind>,
];
export type ListeningKindsAgree = [
  AssignableTo<PolicyListeningViolationKind, GeneratorListeningViolationKind>,
  AssignableTo<GeneratorListeningViolationKind, PolicyListeningViolationKind>,
];
export type BuildASentenceKindsAgree = [
  AssignableTo<PolicyBuildASentenceViolationKind, GateBuildASentenceViolationKind>,
  AssignableTo<GateBuildASentenceViolationKind, PolicyBuildASentenceViolationKind>,
];
export type SpeakingKindsAgree = [
  AssignableTo<PolicySpeakingViolationKind, GateSpeakingViolationKind>,
  AssignableTo<GateSpeakingViolationKind, PolicySpeakingViolationKind>,
];

const CONFORMANCE_KINDS: readonly DiversityIssueKind[] = [
  "plan-drift",
  "domain-drift",
];

describe("generation check policy — tiers", () => {
  it("classifies every check into exactly one of the three tiers", () => {
    const checks: GenerationCheck[] = [
      { family: "plan-diversity", kind: "containment", taskType: "listen_choose" },
      { family: "content-gate", section: "reading", kind: "explanation-length-ctw" },
      { family: "content-gate", section: "listening", kind: "composition" },
      { family: "audio-pace", section: "speaking", verdict: "out-of-band" },
    ];
    for (const check of checks) {
      const policy = classifyGenerationCheck(check);
      expect(["fatal", "advisory", "repair-then-accept"]).toContain(policy.tier);
    }
  });
});

// The tests below pin each tier, so changing a tier in the policy means changing it here too,
// deliberately.
describe("generation check policy — plan admission", () => {
  it("records Catalog overlap rather than blocking on it", () => {
    const policy = classifyGenerationCheck({ family: "plan-diversity", kind: "containment", taskType: "conversation" });
    expect(policy.tier).toBe("advisory");
  });

  it("blocks a plan that drifts from its own declared structure", () => {
    for (const kind of CONFORMANCE_KINDS) {
      const policy = classifyGenerationCheck({ family: "plan-diversity", kind, taskType: "conversation" });
      expect(policy.tier, kind).toBe("fatal");
    }
  });

  it("repairs build_sentence domain-balance by replanning, and records it everywhere else", () => {
    expect(
      classifyGenerationCheck({ family: "plan-diversity", kind: "domain-balance", taskType: "build_sentence" }),
    ).toEqual({ tier: "repair-then-accept", unrepaired: "advisory" });
    for (const taskType of ["listen_choose", "daily_life", "interview"] as NoveltyTaskType[]) {
      expect(
        classifyGenerationCheck({ family: "plan-diversity", kind: "domain-balance", taskType }).tier,
        taskType,
      ).toBe("advisory");
    }
  });
});

describe("generation check policy — module difficulty", () => {
  it("is the one conformance property that fails a job", () => {
    for (const section of ["reading", "listening"] as const) {
      expect(classifyGenerationCheck({ family: "module-difficulty", section }).tier).toBe("fatal");
      expect(blocksGeneration({ family: "module-difficulty", section })).toBe(true);
    }
  });
});

describe("generation check policy — content gate", () => {
  it("hard-fails a reading composition violation with no repair budget", () => {
    const policy = classifyGenerationCheck({ family: "content-gate", section: "reading", kind: "composition" });
    expect(policy.tier).toBe("fatal");
  });

  it("repairs every remediable reading kind, and fails the job only on an unusable key", () => {
    for (const kind of READING_REMEDIABLE_KINDS) {
      const policy = classifyGenerationCheck({ family: "content-gate", section: "reading", kind });
      expect(policy.tier, kind).toBe("repair-then-accept");
      expect(policy.tier === "repair-then-accept" && policy.unrepaired, kind).toBe(kind === "invalid-answer-key" ? "fatal" : "advisory");
    }
  });

  // The gap-leak rule is ours, not ETS's, and the harm it prevents is that practice gets easier:
  // neither an unusable Set nor one that teaches a wrong answer, which is the bar ADR 0006 sets for
  // `fatal`. So a leak the repair rounds cannot fix is published with a note.
  it("repairs a reading gap leak, then accepts it rather than discarding the Set", () => {
    const policy = classifyGenerationCheck({ family: "content-gate", section: "reading", kind: "ctw-gap-leak" });
    expect(policy.tier).toBe("repair-then-accept");
    expect(policy.tier === "repair-then-accept" && policy.unrepaired).toBe("advisory");
    expect(blocksGeneration({ family: "content-gate", section: "reading", kind: "ctw-gap-leak" })).toBe(false);
  });

  // A Stimulus outside its length range (`ctw-word-count-over` for a Complete the Words paragraph
  // over its range, `word-count` for the rest) still leaves every Item answerable and correctly
  // keyed: off-target practice, not an unusable Set.
  it("records every reading word-count breach rather than blocking on it", () => {
    for (const kind of ["ctw-word-count-over", "word-count"] as const) {
      expect(classifyGenerationCheck({ family: "content-gate", section: "reading", kind }).tier, kind).toBe("advisory");
      expect(blocksGeneration({ family: "content-gate", section: "reading", kind }), kind).toBe(false);
    }
  });

  // A 3-option MCQ is usable practice: it raises guessing odds (33% against the exam's 25%) but does
  // not teach a wrong answer, so ADR 0006's rule puts it in `advisory`, recorded on the Set and never
  // repaired or failed. The generation guide's "exactly 4 options" is the mechanism; this gate is the
  // backstop.
  it("records a reading MCQ with fewer than 4 options rather than blocking on it", () => {
    expect(classifyGenerationCheck({ family: "content-gate", section: "reading", kind: "option-count" }).tier)
      .toBe("advisory");
    expect(blocksGeneration({ family: "content-gate", section: "reading", kind: "option-count" })).toBe(false);
  });

  // A module reading outside its absolute ETS band is off-target practice (a Router Module harder
  // than moderate routes on text ETS's router does not use; a Lower Module in the high band is not
  // the easier second stage it claims to be), but every Item in it is still answerable and correctly
  // keyed, so ADR 0006's rule puts it in `advisory`. The relative Upper-vs-Lower ordering, which
  // makes a routed Band Estimate honest, is a different family and stays fatal.
  it("records an out-of-band module difficulty while the relative ordering stays fatal", () => {
    expect(
      classifyGenerationCheck({ family: "content-gate", section: "reading", kind: "module-difficulty-band" }).tier,
    ).toBe("advisory");
    expect(
      blocksGeneration({ family: "content-gate", section: "reading", kind: "module-difficulty-band" }),
    ).toBe(false);
    expect(classifyGenerationCheck({ family: "module-difficulty", section: "reading" }).tier).toBe("fatal");
    expect(blocksGeneration({ family: "module-difficulty", section: "reading" })).toBe(true);
  });

  // The same bands at Complete the Words paragraph granularity, and the same tier for the same
  // reason: an off-register paragraph is off-target practice, not an unusable Set or a wrong key. A
  // 70-100 word paragraph is also a small enough sample that the readability index is noisy on it,
  // so a fatal tier would fail jobs over estimator jitter. The check never looks at the gaps, which
  // follow ETS's own algorithm (RR-25-12 §II-3).
  it("records an out-of-band CtW paragraph rather than blocking on it", () => {
    const check = {
      family: "content-gate",
      section: "reading",
      kind: "ctw-paragraph-difficulty-band",
    } as const;
    expect(classifyGenerationCheck(check).tier).toBe("advisory");
    expect(blocksGeneration(check)).toBe(false);
  });

  it("repairs the remediable listening kinds, and fails the job only on an unusable Stimulus or key", () => {
    for (const kind of LISTENING_REMEDIABLE_KINDS) {
      const policy = classifyGenerationCheck({ family: "content-gate", section: "listening", kind });
      expect(policy.tier, kind).toBe("repair-then-accept");
      const unusable = kind === "invalid-answer-key" || kind === "transcript-language";
      expect(policy.tier === "repair-then-accept" && policy.unrepaired, kind).toBe(unusable ? "fatal" : "advisory");
    }
  });

  it("hard-fails a listening composition violation", () => {
    expect(classifyGenerationCheck({ family: "content-gate", section: "listening", kind: "composition" }).tier).toBe("fatal");
  });
});

// Writing's gate answers `repair-then-accept` for every kind (each buys the candidate loop's bounded
// regeneration) and differs only in the ending. The two lists below are the tiering decision itself,
// so moving a kind means changing them deliberately.
describe("generation check policy — build a sentence content gate", () => {
  const writingGate = (kind: PolicyBuildASentenceViolationKind) =>
    classifyGenerationCheck({ family: "content-gate", section: "writing", kind });

  const UNUSABLE: readonly PolicyBuildASentenceViolationKind[] = [
    "frame-missing",
    "frame-unparseable",
    "answer-length",
    "answer-not-from-tiles",
  ];
  const TOLERATED: readonly PolicyBuildASentenceViolationKind[] = [
    // An all-blank frame is not a kind at all: it is the reorder task the real exam sets
    // (docs/adr/0009).
    "frame-final-punctuation",
    "tile-count",
    "distractor-count",
    "tile-final-punctuation",
    "tile-initial-capital",
  ];

  it("gives every kind a bounded regeneration first", () => {
    for (const kind of [...UNUSABLE, ...TOLERATED]) {
      expect(writingGate(kind).tier, kind).toBe("repair-then-accept");
    }
  });

  it("still fails the job for the four kinds that leave an Item unanswerable or mis-keyed", () => {
    for (const kind of UNUSABLE) {
      const policy = writingGate(kind);
      expect(policy.tier === "repair-then-accept" && policy.unrepaired, kind).toBe("fatal");
      expect(blocksGeneration({ family: "content-gate", section: "writing", kind }), kind).toBe(true);
    }
  });

  it("publishes a Set whose remaining defects are format, difficulty or a position leak", () => {
    for (const kind of TOLERATED) {
      const policy = writingGate(kind);
      expect(policy.tier === "repair-then-accept" && policy.unrepaired, kind).toBe("advisory");
      expect(blocksGeneration({ family: "content-gate", section: "writing", kind }), kind).toBe(false);
    }
  });

  it("classifies every kind exactly once — the two lists are the whole union", () => {
    const listed = [...UNUSABLE, ...TOLERATED];
    expect(new Set(listed).size).toBe(listed.length);
    // Widening BuildASentenceViolationKind without touching this file fails here, not silently: the
    // mutual-assignability assertion at the top of the file pins the union, and this counts it.
    expect(listed).toHaveLength(9);
  });
});

// Speaking's gate answers `repair-then-accept` with an `advisory` ending for both its kinds. While
// the candidate loop's 3-attempt budget lasts, a Listen and Repeat Item over-long in words or as
// projected speech buys a whole-candidate regeneration (the gate runs before TTS, so no paid render
// is at stake); one that survives the budget is recorded on the published Set and never fails the
// job. A sentence a few words past the ETS-observed 13-15-word ceiling, or a clip half a second past
// ETS's longest, is harder practice than designed, not an unusable Set (ADR 0006).
describe("generation check policy — listen and repeat content gate", () => {
  it.each(["lr-word-count-over", "lr-clip-duration-over"] as const)(
    "regenerates a %s item while attempts remain, then records it rather than blocking",
    (kind) => {
      const policy = classifyGenerationCheck({ family: "content-gate", section: "speaking", kind });
      expect(policy.tier).toBe("repair-then-accept");
      expect(policy.tier === "repair-then-accept" && policy.unrepaired).toBe("advisory");
      expect(blocksGeneration({ family: "content-gate", section: "speaking", kind })).toBe(false);
    },
  );
});

describe("generation check policy — audio pace", () => {
  it("fails only a malfunction", () => {
    for (const section of ["speaking", "listening"] as const) {
      expect(
        classifyGenerationCheck({ family: "audio-pace", section, verdict: "malfunction" satisfies PaceVerdict }).tier,
      ).toBe("fatal");
      expect(classifyGenerationCheck({ family: "audio-pace", section, verdict: "in-band" }).tier).toBe("advisory");
    }
  });

  // A clip whose speech rate misses its band buys one corrective re-render and is accepted either
  // way.
  it("repairs an out-of-band clip once, then accepts it", () => {
    for (const section of ["speaking", "listening"] as const) {
      const policy = classifyGenerationCheck({ family: "audio-pace", section, verdict: "out-of-band" });
      expect(policy.tier, section).toBe("repair-then-accept");
      expect(policy.tier === "repair-then-accept" && policy.unrepaired, section).toBe("advisory");
      // The point of the degrade target: a speech-rate miss never stops a job.
      expect(blocksGeneration({ family: "audio-pace", section, verdict: "out-of-band" }), section).toBe(false);
    }
  });
});

describe("blocksGeneration", () => {
  it("is true for fatal and for a repair tier that degrades to fatal", () => {
    expect(blocksGeneration({ family: "content-gate", section: "listening", kind: "composition" })).toBe(true);
    expect(blocksGeneration({ family: "content-gate", section: "listening", kind: "invalid-answer-key" })).toBe(true);
    expect(blocksGeneration({ family: "content-gate", section: "reading", kind: "invalid-answer-key" })).toBe(true);
  });

  it("is false for advisory", () => {
    expect(blocksGeneration({ family: "audio-pace", section: "listening", verdict: "out-of-band" })).toBe(false);
    expect(blocksGeneration({ family: "plan-diversity", kind: "containment", taskType: "conversation" })).toBe(false);
  });
});

describe("GENERATION_SECTIONS", () => {
  it("names all four sections", () => {
    expect([...GENERATION_SECTIONS].sort()).toEqual(["listening", "reading", "speaking", "writing"]);
  });
});

// A delivered Listen and Repeat clip that runs past its Set's clip ceiling.
describe("audio-clip-ceiling", () => {
  // The corrective re-render is the repair. A clip still past the ceiling after it is a harder
  // Listen and Repeat Item, not an unusable one, so the Set publishes with a note (ADR 0006).
  it("publishes a render that delivered a clip past the ceiling, with a note", () => {
    expect(classifyGenerationCheck({ family: "audio-clip-ceiling", section: "speaking" }))
      .toEqual({ tier: "repair-then-accept", unrepaired: "advisory" });
    expect(blocksGeneration({ family: "audio-clip-ceiling", section: "speaking" })).toBe(false);
  });

  // The content gate's generation-time projection of clip length is a separate check with its own
  // advisory ending: an Item it flags still publishes when its clip comes back inside the ceiling.
  it("leaves the content gate's clip-duration projection advisory", () => {
    const projection = classifyGenerationCheck({
      family: "content-gate", section: "speaking", kind: "lr-clip-duration-over",
    });
    expect(projection.tier).toBe("repair-then-accept");
    expect(projection).toEqual({ tier: "repair-then-accept", unrepaired: "advisory" });
    expect(blocksGeneration({ family: "content-gate", section: "speaking", kind: "lr-clip-duration-over" })).toBe(false);
  });
});
