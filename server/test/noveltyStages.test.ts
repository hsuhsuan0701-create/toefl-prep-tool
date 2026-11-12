import { describe, expect, it } from "vitest";
import {
  compareCatalogEntries,
  entriesFromPlan,
  entriesFromSet,
  type NoveltyCatalogEntry,
} from "../src/services/generationCatalog.js";
import { candidateDomainDriftNotes, validateGenerationPlan } from "../src/services/generationNovelty.js";
import { normalizeNoveltyText } from "../src/services/noveltySimilarity.js";
import {
  speakingPlanFixture,
  speakingSetFixture,
  writingPlanFixture,
  writingSetFixture,
} from "./helpers/generationDiversityFixtures.js";

// Novelty is measured once, when a Plan is admitted, and the candidate stage records only domain
// drift: a pure function of the Plan and the generated Set that never rejects.

function entry(overrides: Partial<NoveltyCatalogEntry> = {}): NoveltyCatalogEntry {
  return {
    setId: "spk-prior",
    source: "generated",
    createdAt: "2026-07-31T00:00:00Z",
    taskType: "interview",
    domain: "everyday-life",
    descriptor: normalizeNoveltyText("planning short study breaks during difficult homework"),
    classifierText: "planning short study breaks during difficult homework",
    conceptTokens: ["planning", "short", "study", "break", "difficult", "homework"],
    itemPosition: 0,
    ...overrides,
  };
}

describe("plan admission's similarity measure", () => {
  it("compares components of the same Task Type only", () => {
    expect(compareCatalogEntries(entry(), entry({ setId: "wri-copy", taskType: "email" }))).toEqual([]);
  });

  it("measures a plan against concurrently reserved plans too", () => {
    const plan = speakingPlanFixture();
    const catalog = entriesFromPlan(plan, { setId: "pending:other-job", source: "generated" });

    expect(validateGenerationPlan({ plan, catalog }).some((issue) =>
      issue.conflictingSetIds.includes("pending:other-job")
    )).toBe(true);
  });
});

describe("candidate domain drift", () => {
  it("records nothing for Speaking and Writing candidates that follow their plans", () => {
    expect(candidateDomainDriftNotes(speakingPlanFixture(), speakingSetFixture())).toEqual([]);
    expect(candidateDomainDriftNotes(writingPlanFixture(), writingSetFixture())).toEqual([]);
  });

  it("records an Interview whose content positively contradicts its planned domain", () => {
    const plan = speakingPlanFixture();
    plan.interview.domain = "arts-culture";

    // The interview candidate names a bus and a ticket counter and no arts-culture keyword at all:
    // two independent keywords pointing elsewhere, which is what contradiction means here.
    expect(candidateDomainDriftNotes(plan, speakingSetFixture())).toContainEqual({
      check: "plan-conformance",
      detail: "domain-drift",
      taskType: "interview",
    });
  });

  it("records nothing for realistic content that carries no domain signal at all", () => {
    // 65 of 80 saved Build a Sentence items in the real bank classify as everyday-life: a three-tile
    // answer carries no reliable domain signal, so silence is never drift.
    const candidate = writingSetFixture();
    const buildSentence = entriesFromSet(candidate).filter(
      ({ taskType }) => taskType === "build_sentence",
    );

    expect(
      buildSentence.filter(({ domain }) => domain === "everyday-life").length,
    ).toBeGreaterThanOrEqual(8);
    expect(candidateDomainDriftNotes(writingPlanFixture(), candidate)).toEqual([]);
  });

  it("records a Build a Sentence item that positively contradicts its planned domain", () => {
    const candidate = writingSetFixture();
    // Planned health-wellbeing, written as a gallery visit: two arts-culture keywords, no
    // health-wellbeing keyword. One stray keyword would not be enough, and must not be.
    candidate.buildASentence.items[3] = {
      ...candidate.buildASentence.items[3],
      prompt: "When does the museum gallery open for the follow-up visit?",
      tiles: ["It", "opens", "Thursday", "afternoon."],
      answers: [["It", "opens", "Thursday", "afternoon."]],
    };

    expect(candidateDomainDriftNotes(writingPlanFixture(), candidate)).toEqual([{
      check: "plan-conformance",
      detail: "domain-drift",
      taskType: "build_sentence",
    }]);
  });

  it("reads each component's raw text, so 'students' still counts for campus-academics", () => {
    const plan = speakingPlanFixture();
    plan.interview.domain = "campus-academics";
    const candidate = speakingSetFixture();
    // Two services-travel keywords and one campus-academics keyword that normalization would drop.
    candidate.interview.scenarioTitle = "Students and the Bus";
    candidate.interview.intro = "A survey about how students travel.";
    candidate.interview.questions = candidate.interview.questions.map((question) => ({
      ...question,
      question: "How often do you take the bus to the station?",
    }));

    expect(normalizeNoveltyText("students")).toBe("");
    expect(candidateDomainDriftNotes(plan, candidate)).toEqual([]);
  });
});
