import { describe, expect, it, vi } from "vitest";
import { AnyTaskType, isDeterministicTaskType, type AnySet, type ScoreReport, type ScoreRequest } from "@toefl-prep/shared";
import {
  admit,
  arbitrate,
  createScoringSession,
  runJudges,
  type ScoringProgress,
} from "../src/services/judgeEnsemble.js";
import { NotFound, Rescorable, TranscriptionPending } from "../src/services/scoringErrors.js";
import type { ArbitrationResult } from "../src/services/arbiter.js";
import { openDb } from "../src/db/db.js";
import { sqliteStores } from "./helpers/sqliteStores.js";

// Every test in this file drives the Judge ensemble with fake Judges and a fake Arbiter over the
// real SQLite store: no HTTP and no model. Writes are read back from the database.

type SeededResponse = { itemId: string; taskType?: string; transcript?: string; scoringStatus?: string; responseText?: string };

/**
 * A fresh in-memory database holding Attempt `attempt-1` with the given Responses (spoken ones by
 * default) and, unless `jobStatus` is null, scoring job `job-1` in that status. `db` is returned for
 * the one statement no store makes: deleting a job row outright.
 */
function seededStore(options: { kind?: string; responses?: SeededResponse[]; jobStatus?: string | null } = {}) {
  const db = openDb(":memory:");
  const store = sqliteStores(db);
  const kind = options.kind ?? "speaking";
  store.createAttempt({ id: "attempt-1", kind, mode: "drill", setId: `${kind === "writing" ? "wri" : "spk"}-test`, isRepeat: false });
  for (const response of options.responses ?? []) {
    store.insertItemResult({
      attemptId: "attempt-1",
      itemId: response.itemId,
      taskType: response.taskType ?? (response.itemId.startsWith("iv") ? "interview" : "listen_repeat"),
      responseText: response.responseText,
      // A spoken Response carries its recording; an essay carries its text instead.
      responseAudioPath: response.responseText === undefined ? `audio/responses/attempt-1/${response.itemId}.webm` : undefined,
      transcript: response.transcript,
      deliveryReport: "{}",
      scoringStatus: response.scoringStatus,
    });
  }
  const jobStatus = options.jobStatus === undefined ? "running" : options.jobStatus;
  if (jobStatus !== null) store.seedScoringJob({ id: "job-1", attempt_id: "attempt-1", status: jobStatus });
  const getScoringJob = vi.spyOn(store, "getScoringJob");
  return { db, store, getScoringJob };
}

// admit reads exactly four things off a Set. Casting a minimal literal keeps these tests free of
// the multi-hundred-line real fixtures — nothing here exercises the Set schema.
const writingSet = {
  kind: "writing",
  email: { id: "em1", scenario: "a late delivery" },
  academicDiscussion: { id: "ad1", prompt: "urban transit" },
} as unknown as AnySet;

const speakingSet = {
  kind: "speaking",
  listenAndRepeat: {
    items: [
      { id: "lr-1", sentence: "The bus leaves at nine." },
      { id: "lr-2", sentence: "Please take the second exit." },
    ],
  },
  interview: { questions: [{ id: "iv-1", question: "Tell me about your neighbourhood." }] },
} as unknown as AnySet;

const emailRequest: ScoreRequest = {
  taskType: "email",
  items: [{ itemId: "em1", text: "Dear team, …", secondsUsed: 200 }],
};
const listenRepeatRequest: ScoreRequest = {
  taskType: "listen_repeat",
  items: [{ itemId: "lr-1" }, { itemId: "lr-2" }],
};

describe("admit — the single scoreability check", () => {
  it("reports every deterministic Task Type as not scoreable by the ensemble, and exactly those", () => {
    const { store, getScoringJob } = seededStore();
    for (const taskType of AnyTaskType.options) {
      // One over-wide item literal covers every member's shape; admit never reads past itemId.
      const request = {
        taskType,
        items: [{ itemId: "nope", text: "t", secondsUsed: 1, tileOrder: [], typed: "a", selectedOptionId: "o" }],
      } as unknown as ScoreRequest;
      let verdict: string;
      try {
        verdict = admit(store, "attempt-1", writingSet, request).verdict;
      } catch {
        // A judged Task Type that got past the deterministic gate and then failed a real check.
        verdict = "rejected";
      }
      expect(verdict === "not-scoreable-here", taskType).toBe(isDeterministicTaskType(taskType));
    }
    // Side-effect-free: the scoreability check never touches the job row (its store parameter is
    // narrowed to getAttempt, so it cannot write at all).
    expect(getScoringJob).not.toHaveBeenCalled();
  });

  it("resolves the essay's materials once, and rejects a wrong Set kind or an unknown Item", () => {
    const { store } = seededStore({ kind: "writing" });
    const admission = admit(store, "attempt-1", writingSet, emailRequest);
    expect(admission).toEqual({
      verdict: "ok",
      admitted: {
        kind: "essay",
        taskType: "email",
        itemId: "em1",
        responseText: "Dear team, …",
        materials: { id: "em1", scenario: "a late delivery" },
      },
    });
    expect(admit(store, "attempt-1", writingSet, {
      taskType: "discussion",
      items: [{ itemId: "ad1", text: "I agree …", secondsUsed: 90 }],
    }).verdict).toBe("ok");

    expect(() => admit(store, "attempt-1", speakingSet, emailRequest)).toThrow(NotFound);
    expect(() => admit(store, "attempt-1", writingSet, {
      taskType: "email",
      items: [{ itemId: "not-this-one", text: "…", secondsUsed: 5 }],
    })).toThrow(/unknown item not-this-one/);
  });

  it("resolves each spoken Item's Response row and its target/question, in requested order", () => {
    const { store } = seededStore({
      responses: [
        { itemId: "lr-2", transcript: "please take the second exit" },
        { itemId: "lr-1", transcript: "the bus leaves at nine" },
        { itemId: "iv-1", transcript: "it is a quiet place" },
      ],
    });
    const admission = admit(store, "attempt-1", speakingSet, listenRepeatRequest);
    if (admission.verdict !== "ok" || admission.admitted.kind !== "speaking") throw new Error("expected an admitted speaking Response");
    expect(admission.admitted.taskType).toBe("listen_repeat");
    expect(admission.admitted.items.map((i) => [i.itemId, "target" in i ? i.target : undefined])).toEqual([
      ["lr-1", "The bus leaves at nine."],
      ["lr-2", "Please take the second exit."],
    ]);
    expect(admission.admitted.items[0].row.transcript).toBe("the bus leaves at nine");

    const interview = admit(store, "attempt-1", speakingSet, { taskType: "interview", items: [{ itemId: "iv-1" }] });
    if (interview.verdict !== "ok" || interview.admitted.kind !== "speaking" || interview.admitted.taskType !== "interview") {
      throw new Error("expected an admitted interview Response");
    }
    expect(interview.admitted.items[0].question).toBe("Tell me about your neighbourhood.");
  });

  it("prefers transcription-pending over missing-transcript, and rejects a wrong Set kind", () => {
    const pending = seededStore({
      responses: [
        { itemId: "lr-1", scoringStatus: "transcription_pending" },
        { itemId: "lr-2" },
      ],
    });
    try {
      admit(pending.store, "attempt-1", speakingSet, listenRepeatRequest);
      throw new Error("expected TranscriptionPending");
    } catch (err) {
      expect(err).toBeInstanceOf(TranscriptionPending);
      expect((err as TranscriptionPending).itemIds).toEqual(["lr-1"]);
    }

    const missing = seededStore({ responses: [{ itemId: "lr-1", transcript: "the bus leaves at nine" }] });
    expect(() => admit(missing.store, "attempt-1", speakingSet, listenRepeatRequest))
      .toThrow(/missing transcript for item\(s\): lr-2/);

    expect(() => admit(missing.store, "attempt-1", writingSet, listenRepeatRequest))
      .toThrow(/listen_repeat requires a speaking set/);
  });

  it("rejects an unknown spoken Item up front, before any of its siblings' materials are prepared", () => {
    // The id check runs before the loop that builds each Item's materials, where an earlier
    // sibling's ffprobe would already have run.
    const { store } = seededStore({
      responses: [
        { itemId: "lr-1", transcript: "the bus leaves at nine" },
        { itemId: "lr-9", transcript: "a Response to an Item the Set does not have" },
      ],
    });
    expect(() => admit(store, "attempt-1", speakingSet, {
      taskType: "listen_repeat",
      items: [{ itemId: "lr-1" }, { itemId: "lr-9" }],
    })).toThrow(/unknown item lr-9/);
  });
});

type FakeJudgeResult = { report: string; provider: "gemini-http" | "codex" | "openai-http" };

const geminiResult: FakeJudgeResult = { report: "gemini-report", provider: "gemini-http" };
const openaiCodexResult: FakeJudgeResult = { report: "openai-report", provider: "codex" };

describe("runJudges — the fixed Gemini-then-OpenAI fan-out", () => {
  it("fans out over the fixed tuple and takes provenance from the OpenAI settlement", async () => {
    const callJudge = vi.fn(async (judge: "gemini" | "openai") =>
      judge === "gemini" ? geminiResult : openaiCodexResult);
    const result = await runJudges(callJudge);
    expect(callJudge.mock.calls.map((c) => c[0])).toEqual(["gemini", "openai"]);
    expect(result.fulfilled).toEqual([
      { judge: "gemini", value: geminiResult },
      { judge: "openai", value: openaiCodexResult },
    ]);
    expect(result.judgesFailed).toEqual([]);
    expect(result.openaiJudgeProvider).toBe("codex");
  });

  it("reports each settle with the cumulative tally, prospectively", async () => {
    const progress: ScoringProgress[] = [];
    await runJudges(
      async (judge) => (judge === "gemini" ? geminiResult : openaiCodexResult),
      { onProgress: (p) => progress.push(p) },
    );
    expect(progress).toEqual([
      { stage: "judging" },
      { stage: "judging", detail: { judgesDone: ["gemini"], judgesFailed: [] } },
      { stage: "judging", detail: { judgesDone: ["gemini", "openai"], judgesFailed: [], openaiJudgeProvider: "codex" } },
    ]);
  });

  it("degrades to a single Judge when one family fails, and keeps that failure out of the tally's done list", async () => {
    const progress: ScoringProgress[] = [];
    const result = await runJudges(
      async (judge) => {
        if (judge === "gemini") throw new Error("gemini unavailable");
        return openaiCodexResult;
      },
      { onProgress: (p) => progress.push(p) },
    );
    expect(result.fulfilled).toEqual([{ judge: "openai", value: openaiCodexResult }]);
    expect(result.judgesFailed).toEqual(["gemini"]);
    expect(result.openaiJudgeProvider).toBe("codex");
    expect(progress.at(-1)?.detail).toEqual({
      judgesDone: ["openai"],
      judgesFailed: ["gemini"],
      openaiJudgeProvider: "codex",
    });
  });

  it("sources provenance from the OpenAI settlement alone, never from whichever result happens to carry one", async () => {
    const result = await runJudges(async (judge) => {
      if (judge === "gemini") return { report: "gemini-report", provider: "codex" as const };
      throw new Error("openai unavailable");
    });
    expect(result.fulfilled.map((f) => f.judge)).toEqual(["gemini"]);
    expect(result.openaiJudgeProvider).toBeUndefined();
  });

  it("honours an abort raised while the Judges were in flight", async () => {
    await expect(runJudges(
      async () => geminiResult,
      { signal: AbortSignal.abort() },
    )).rejects.toThrow();
  });
});

const arbitratedReport: ScoreReport = {
  taskType: "email",
  items: [{
    itemId: "em1",
    ownScore: 4,
    finalScore: 4,
    maxScore: 5,
    dimensions: [{ name: "mechanics", note: "ok" }],
    deductions: [],
    reconciliationNote: "agreed",
    feedbackZh: "寫得不錯。",
  }],
};

const arbitration: ArbitrationResult = { report: arbitratedReport, provider: "claude" };

describe("arbitrate — Score Report assembly", () => {
  it("returns the Arbiter's Score Report and forwards its route events as aggregating progress", async () => {
    const progress: ScoringProgress[] = [];
    const markFailed = vi.fn();
    const report = await arbitrate(
      async (opts) => {
        opts.onEvent?.({ state: "queued", provider: "claude", queuePosition: 2 });
        opts.onEvent?.({ state: "fallback", provider: "codex", fallbackFrom: "claude", failureKind: "quota" });
        return arbitration;
      },
      { onProgress: (p) => progress.push(p), markFailed },
    );
    expect(report).toBe(arbitratedReport);
    expect(markFailed).not.toHaveBeenCalled();
    expect(progress).toEqual([
      { stage: "aggregating" },
      { stage: "aggregating", detail: { arbiterProvider: "claude", queuePosition: 2 } },
      { stage: "aggregating", detail: { arbiterProvider: "codex", fallbackFrom: "claude" } },
    ]);
  });

  it("marks the Items failed with the same message it throws Rescorable with", async () => {
    const markFailed = vi.fn();
    await expect(arbitrate(
      async () => { throw new Error("arbiter failed: both routes unavailable"); },
      { markFailed },
    )).rejects.toThrow(Rescorable);
    expect(markFailed).toHaveBeenCalledTimes(1);
    expect(markFailed.mock.calls[0][0]).toBe("Error: arbiter failed: both routes unavailable");
  });

  it("treats a throwing progress sink as an arbitration failure", async () => {
    const markFailed = vi.fn();
    await expect(arbitrate(
      async () => arbitration,
      { onProgress: () => { throw new Error("progress persistence failed"); }, markFailed },
    )).rejects.toThrow(Rescorable);
    expect(markFailed).toHaveBeenCalledTimes(1);
  });

  it("lets an abort surface as an abort, without marking anything failed", async () => {
    const markFailed = vi.fn();
    const controller = new AbortController();
    await expect(arbitrate(
      async () => {
        controller.abort();
        throw new Error("aborted mid-call");
      },
      { signal: controller.signal, markFailed },
    )).rejects.not.toThrow(Rescorable);
    expect(markFailed).not.toHaveBeenCalled();
  });
});

describe("the persist seam — one supersede guard for every write", () => {
  // A stale Judge Report on em1, so a test can tell whether the step's delete ran.
  function withEssayResponse(jobStatus: string | null) {
    const seeded = seededStore({
      kind: "writing",
      responses: [{ itemId: "em1", taskType: "email", responseText: "Dear team, …" }],
      jobStatus,
    });
    seeded.store.insertJudgeReport({ attemptId: "attempt-1", itemId: "em1", judge: "gemini", reportJson: "\"stale\"" });
    return seeded;
  }
  const write = (score: number) =>
    (writes: Parameters<Parameters<ReturnType<typeof createScoringSession>["persist"]>[0]>[0]) => {
      writes.deleteJudgeReports("attempt-1", "em1");
      writes.insertJudgeReport({ attemptId: "attempt-1", itemId: "em1", judge: "openai", reportJson: `"fresh ${score}"` });
      writes.updateItemScore({ attemptId: "attempt-1", itemId: "em1", score, scoreJson: "{}", scoringStatus: "scored" });
    };
  const em1 = (store: ReturnType<typeof seededStore>["store"]) =>
    store.getAttempt("attempt-1")!.items.find((item) => item.item_id === "em1")!;

  it("runs the step for a job that is still the active one", () => {
    const { store } = withEssayResponse("running");
    createScoringSession(store, "job-1").persist(write(4));
    expect(store.getJudgeReports("attempt-1")).toEqual([
      { item_id: "em1", judge: "openai", report_json: "\"fresh 4\"" },
    ]);
    expect(em1(store)).toMatchObject({ score: 4, scoring_status: "scored" });
  });

  it("skips the whole step — writes and the non-writes beside them — once the job has been superseded", () => {
    const { store } = withEssayResponse("superseded");
    const progress = vi.fn();
    createScoringSession(store, "job-1").persist((w) => {
      progress({ stage: "persisting" });
      write(4)(w);
    });
    expect(progress).not.toHaveBeenCalled();
    expect(store.getJudgeReports("attempt-1")).toEqual([
      { item_id: "em1", judge: "gemini", report_json: "\"stale\"" },
    ]);
    expect(em1(store)).toMatchObject({ score: null, scoring_status: "pending" });
  });

  it("re-reads the job's status on every step, never once up front", () => {
    const { db, store, getScoringJob } = withEssayResponse("running");
    const session = createScoringSession(store, "job-1");
    session.persist(write(4));
    store.seedScoringJobState({ id: "job-1", status: "cancelled" });
    session.persist(write(2));
    db.prepare("DELETE FROM scoring_jobs WHERE id=?").run("job-1"); // the row vanished entirely
    session.persist(write(1));
    expect(getScoringJob).toHaveBeenCalledTimes(3);
    // Only the first step landed.
    expect(em1(store).score).toBe(4);
    expect(store.getJudgeReports("attempt-1").map((r) => r.report_json)).toEqual(["\"fresh 4\""]);
  });

  it("treats a session with no job id as always active, and never asks", () => {
    const { store, getScoringJob } = withEssayResponse("cancelled");
    createScoringSession(store).persist(write(4));
    expect(getScoringJob).not.toHaveBeenCalled();
    expect(em1(store)).toMatchObject({ score: 4, scoring_status: "scored" });
  });

  it("records the Response outside the guard, so it survives a scoring failure", () => {
    const { store, getScoringJob } = seededStore({ kind: "writing", jobStatus: "cancelled" });
    createScoringSession(store, "job-1").recordResponse({
      attemptId: "attempt-1", itemId: "em1", taskType: "email", responseText: "Dear team, …",
    });
    expect(em1(store)).toMatchObject({ task_type: "email", response_text: "Dear team, …" });
    expect(getScoringJob).not.toHaveBeenCalled();
  });
});
