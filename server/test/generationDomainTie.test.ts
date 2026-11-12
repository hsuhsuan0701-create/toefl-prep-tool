import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";

import { createGenerationPlanner } from "../src/services/generationPlanner.js";

import { ListeningGenerationPlanSchema, type ListeningGenerationPlan } from "@toefl-prep/shared";
import type { DiversityIssue } from "../src/services/diversityIssues.js";
import {
  domainCompatible,
  domainKeywordHits,
  inferGenerationDomain,
} from "../src/services/generationDomains.js";
import { entriesFromPlan } from "../src/services/generationCatalog.js";
import { blocksGeneration } from "../src/services/generationCheckPolicy.js";
import { validateGenerationPlan } from "../src/services/generationNovelty.js";

function isPlanBlockingIssue(issue: DiversityIssue): boolean {
  return blocksGeneration({ family: "plan-diversity", kind: issue.kind, taskType: issue.taskType });
}

/**
 * Three real Listening Plans, taken verbatim from one generation job's `plan:listening` diagnostics
 * rows (ADR 0004): 108 plan entries between them, a measured population for the domain rule.
 * Offline: this file makes no model call and touches no provider.
 */
const PLANS: ListeningGenerationPlan[] = (
  JSON.parse(
    fs.readFileSync(
      path.resolve(import.meta.dirname, "fixtures/three-listening-plans.json"),
      "utf8",
    ),
  ) as unknown[]
).map((plan) => ListeningGenerationPlanSchema.parse(plan));

function fatalIssues(plan: ListeningGenerationPlan): DiversityIssue[] {
  return validateGenerationPlan({ plan, catalog: [] }).filter(isPlanBlockingIssue);
}

describe("the Plan fixture", () => {
  it("holds three Plans of 36 entries each", () => {
    expect(PLANS).toHaveLength(3);
    const entries = PLANS.reduce(
      (total, plan) =>
        total + plan.listenChoose.length + plan.conversations.length +
        plan.announcements.length + plan.academicTalks.length,
      0,
    );
    expect(entries).toBe(108);
  });
});

describe("a Plan's declared domain survives a keyword tie", () => {
  // Three entries from those Plans, verbatim, reduced to the wording that decides them. Each declares
  // a domain with real keyword support, yet a winner-takes-all classifier gives it to another domain
  // on a single incidental keyword whose only advantage is an earlier place in the classifier's
  // fixed rule order.
  const TIE_CASES = [
    {
      what: "a family photograph donated to a heritage archive",
      declared: "history-social-change" as const,
      text: "donating an old family photograph to a heritage archive heritage archivist grandmother's photo from the 1950s festival",
      stolenBy: "arts-culture",
    },
    {
      what: "an Academic Talk whose discipline is literally history",
      declared: "history-social-change" as const,
      text: "history history lecturer trade routes shifted after new roads built local guild records reveal price changes oral histories preserved through recorded",
      stolenBy: "services-travel",
    },
    {
      what: "a wellness clinic Announcement, on a three-way tie",
      declared: "health-wellbeing" as const,
      text: "wellness clinic lobby clinic administrator walk-in vaccination hours added clinic closing early for training new patient forms updated online",
      stolenBy: "technology-media",
    },
  ];

  it("goes to another domain under winner-takes-all inference, in every case", () => {
    // Pins why these three are ties, so the tests below cannot pass for an unrelated reason:
    // winner-takes-all inference (inferGenerationDomain) disagrees with the declared domain on every
    // one of them, and names the domain that takes it.
    for (const testCase of TIE_CASES) {
      expect(inferGenerationDomain(testCase.text), testCase.what).toBe(testCase.stolenBy);
    }
  });

  it("has real keyword support for the declared domain in every case, so the tie-break, not the count, decides", () => {
    for (const testCase of TIE_CASES) {
      expect(domainKeywordHits(testCase.text)[testCase.declared] ?? 0, testCase.what).toBeGreaterThan(0);
    }
  });

  it("reports no contradiction for any of them under domainCompatible", () => {
    for (const testCase of TIE_CASES) {
      expect(domainCompatible(testCase.declared, testCase.text), testCase.what).toBe(true);
    }
  });

  it("still reports a contradiction on zero support plus two or more distinct keywords elsewhere", () => {
    // The rule's other half: nothing supports the declared domain, and something else has two
    // independent keywords.
    expect(domainCompatible("campus-academics", "laboratory experiment on habitat biodiversity")).toBe(false);
  });

  it("does not report a contradiction on a single stray keyword", () => {
    expect(domainCompatible("campus-academics", "a laboratory")).toBe(true);
  });

  it("does not report a contradiction when the declared domain has any support at all", () => {
    // Even outnumbered: one keyword for the declared domain is support, and support ends the question.
    expect(domainCompatible("campus-academics", "campus laboratory experiment habitat")).toBe(true);
  });
});

describe("the three real Plans validate with no fatal issue", () => {
  it.each([0, 1, 2])("Plan %i", (index) => {
    expect(fatalIssues(PLANS[index]!)).toEqual([]);
  });

  it("reports issues for these Plans, none of them fatal", () => {
    // Against a bank holding the same Plan, each one reports an overlap, and none of it is fatal.
    // Without this, "no fatal issues" would pass just as well against a validator that had stopped
    // looking.
    for (const plan of PLANS) {
      const catalog = entriesFromPlan(plan, { setId: "lsn-saved", source: "generated" });
      const reported = validateGenerationPlan({ plan, catalog });
      expect(reported.length).toBeGreaterThan(0);
      expect(reported.filter(isPlanBlockingIssue)).toEqual([]);
    }
  });
});

describe("novelty still reaches the Plan prompt as bias", () => {
  it("hands the planner the preferred domains derived from the bank", async () => {
    // Novelty reaches the planner as a preference. Stated up front it costs nothing; enforced after
    // generation, the same preference would discard whole paid runs.
    const runSkillTask = vi.fn(async (request: { prompt: string; parse: (v: unknown) => unknown }) => ({
      ok: true as const,
      value: request.parse(PLANS[0]),
    }));
    const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "novelty-bias-"));
    try {
      await createGenerationPlanner({ dataDir }).reserve({
        kind: "listening",
        ownerId: "bias-check",
        runSkillTask: runSkillTask as never,
      });
    } catch {
      // Reservation outcome is not what this test is about; the prompt is.
    }
    expect(runSkillTask).toHaveBeenCalled();
    const prompt = runSkillTask.mock.calls[0]![0].prompt;
    expect(prompt).toContain("preferredDomains");
    // The keyword table the planner is graded against is shown to it, which is what makes the
    // domain rule satisfiable rather than a hidden gate.
    expect(prompt).toContain("science-environment");
  });
});

describe("similarity never blocks a Set", () => {
  it("treats Catalog overlap and catalog-relative domain balance as non-blocking", () => {
    const kinds = ["containment", "domain-balance"] as const;
    for (const kind of kinds) {
      expect(
        isPlanBlockingIssue({ taskType: "listen_choose", kind, conflictingSetIds: [] }),
        kind,
      ).toBe(false);
    }
  });
});
