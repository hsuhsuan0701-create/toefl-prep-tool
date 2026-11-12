import { describe, expect, it, vi } from "vitest";
import type { AnySet, JudgeReport, ScoreReport, ScoreRequest } from "@toefl-prep/shared";
import { readBankSet } from "./helpers/setFixtures.js";
import { openSqliteStores } from "./helpers/sqliteStores.js";
import { runScoringJob } from "../src/services/scoringJobs.js";

// A re-score of a completed Attempt changes an Item's score, and the Band Estimate is computed from
// the Items. The write that ends the job commits both, so no crash can leave a band that describes
// scores other than the stored ones. No onTerminal hook is passed here: the estimate can only have
// moved inside the job's own terminal transaction.

const SET_ID = "wri-77af733e";
const set = readBankSet("writing", SET_ID) as Extract<AnySet, { kind: "writing" }>;
const emailId = set.email.id;
const discussionId = set.academicDiscussion.id;

function emailReport(finalScore: number): ScoreReport {
  return {
    taskType: "email",
    items: [{
      itemId: emailId, ownScore: finalScore, finalScore, maxScore: 5, dimensions: [{ name: "mechanics", note: "as scored" }],
      deductions: [], reconciliationNote: "judges agreed", feedbackZh: "已評分。",
    }],
  };
}

function judgeReport(judge: "gemini" | "openai", score: number): JudgeReport {
  return { judge, taskType: "email", items: [{ itemId: emailId, score, dimensions: [{ name: "mechanics", score, evidence: "as scored" }], deductions: [] }] };
}

const request: ScoreRequest = { taskType: "email", items: [{ itemId: emailId, text: "Dear Sir, I am writing to...", secondsUsed: 90 }] };

/** A completed Writing Simulation whose three Task Types are scored, with the estimate that gives. */
function completedSimulation() {
  const repo = openSqliteStores();
  repo.createAttempt({ id: "att", kind: "writing", mode: "simulation", setId: SET_ID, isRepeat: false });
  for (const [itemId, taskType, score] of [["bas-1", "build_sentence", 1], [emailId, "email", 5], [discussionId, "discussion", 5]] as const) {
    repo.insertItemResult({ attemptId: "att", itemId, taskType, responseText: "Dear Sir, I am writing to..." });
    repo.updateItemScore({ attemptId: "att", itemId, score, scoreJson: "{}", scoringStatus: "scored" });
  }
  repo.settleAttempt({ attemptId: "att" });
  return repo;
}

function scoringDeps(repo: ReturnType<typeof openSqliteStores>, aggregate: () => Promise<{ report: ScoreReport; provider: "claude" | "codex" }>, judgeScore: number) {
  const judgeEssay = vi.fn(async (judge: "gemini" | "openai") => ({
    report: judgeReport(judge, judgeScore),
    provider: judge === "gemini" ? ("gemini-http" as const) : ("codex" as const),
  }));
  return { repo, judgeEssay, aggregate: vi.fn(aggregate), judgeSpeaking: vi.fn(), aggregateSpeaking: vi.fn() };
}

describe("a re-score of a completed Attempt", () => {
  it("commits the new Item score and the Band Estimate computed from it together", async () => {
    const repo = completedSimulation();
    const before = repo.getSectionEstimate("att")!;
    expect(repo.getAttempt("att")!.status).toBe("completed");

    repo.createScoringJob({ id: "rescore", attemptId: "att", taskType: "email", itemIds: [emailId] });
    await runScoringJob(scoringDeps(repo, async () => ({ report: emailReport(1), provider: "claude" }), 1), "rescore", { attemptId: "att", set, request });

    expect(repo.getScoringJob("rescore")!.status).toBe("done");
    expect(repo.getAttempt("att")!.items.find((item) => item.item_id === emailId)?.score).toBe(1);
    const after = repo.getSectionEstimate("att")!;
    expect(after.rawDetail).not.toBe(before.rawDetail);
    expect(after.estimatedBand).toBeLessThan(before.estimatedBand);

    // The stored estimate is already the one a fresh recompute from the Items gives.
    repo.settleAttempt({ attemptId: "att" });
    expect(repo.getSectionEstimate("att")).toEqual(after);
  });

  it("leaves the estimate as it was when the re-score fails and the committed score stands", async () => {
    const repo = completedSimulation();
    const before = repo.getSectionEstimate("att")!;

    repo.createScoringJob({ id: "rescore", attemptId: "att", taskType: "email", itemIds: [emailId] });
    const errors = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      await runScoringJob(scoringDeps(repo, async () => { throw new Error("arbiter unavailable"); }, 1), "rescore", { attemptId: "att", set, request });
    } finally {
      errors.mockRestore();
    }

    expect(repo.getScoringJob("rescore")!.status).toBe("failed");
    expect(repo.getAttempt("att")!.items.find((item) => item.item_id === emailId)?.score).toBe(5);
    expect(repo.getSectionEstimate("att")).toEqual(before);
  });

  it("writes no estimate for an Attempt that is still in progress", async () => {
    const repo = openSqliteStores();
    repo.createAttempt({ id: "att", kind: "writing", mode: "simulation", setId: SET_ID, isRepeat: false });
    repo.insertItemResult({ attemptId: "att", itemId: emailId, taskType: "email", responseText: "Dear Sir, I am writing to..." });

    repo.createScoringJob({ id: "first", attemptId: "att", taskType: "email", itemIds: [emailId] });
    await runScoringJob(scoringDeps(repo, async () => ({ report: emailReport(4), provider: "claude" }), 4), "first", { attemptId: "att", set, request });

    expect(repo.getScoringJob("first")!.status).toBe("done");
    expect(repo.getSectionEstimate("att")).toBeUndefined();
  });
});
