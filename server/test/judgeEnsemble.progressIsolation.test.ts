import { describe, expect, it, vi } from "vitest";
import { runJudges, type ScoringProgress } from "../src/services/judgeEnsemble.js";

// runJudges' production progress sink is a database write (durableJobRunner's progress.save). A
// failed progress write is an observability loss, never a scoring one: whatever the sink does, the
// fan-out returns exactly what the Judges returned.

type FakeJudgeResult = { report: string; provider: "gemini-http" | "codex" | "openai-http" };

const geminiResult: FakeJudgeResult = { report: "gemini-report", provider: "gemini-http" };
const openaiResult: FakeJudgeResult = { report: "openai-report", provider: "codex" };

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

describe("runJudges — a failing progress sink never changes the result", () => {
  it("keeps both Judge Reports and the OpenAI provenance when every progress call throws", async () => {
    const onProgress = vi.fn(() => {
      throw new Error("progress persistence failed");
    });
    const result = await runJudges(
      async (judge) => (judge === "gemini" ? geminiResult : openaiResult),
      { onProgress },
    );
    expect(result.fulfilled).toEqual([
      { judge: "gemini", value: geminiResult },
      { judge: "openai", value: openaiResult },
    ]);
    expect(result.judgesFailed).toEqual([]);
    expect(result.openaiJudgeProvider).toBe("codex");
    // The opening report and one per settle were all attempted, despite each one throwing.
    expect(onProgress).toHaveBeenCalledTimes(3);
  });

  it("counts a Judge whose settle report threw as done, in every later report", async () => {
    const gemini = deferred<FakeJudgeResult>();
    const openai = deferred<FakeJudgeResult>();
    const progress: ScoringProgress[] = [];
    const run = runJudges(
      (judge) => (judge === "gemini" ? gemini.promise : openai.promise),
      {
        onProgress: (p) => {
          progress.push(p);
          if (p.detail?.judgesDone?.length === 1) throw new Error("progress persistence failed");
        },
      },
    );
    openai.resolve(openaiResult);
    await vi.waitFor(() => expect(progress).toHaveLength(2));
    gemini.resolve(geminiResult);
    const result = await run;

    expect(result.fulfilled.map((f) => f.judge)).toEqual(["gemini", "openai"]);
    expect(result.openaiJudgeProvider).toBe("codex");
    expect(progress.at(-1)).toEqual({
      stage: "judging",
      detail: { judgesDone: ["openai", "gemini"], judgesFailed: [], openaiJudgeProvider: "codex" },
    });
  });

  it("reports a Judge failure as that Judge's failure only, even when the sink throws on it", async () => {
    const result = await runJudges(
      async (judge) => {
        if (judge === "gemini") throw new Error("gemini unavailable");
        return openaiResult;
      },
      {
        onProgress: (p) => {
          if (p.detail?.judgesFailed?.includes("gemini")) throw new Error("progress persistence failed");
        },
      },
    );
    expect(result.fulfilled).toEqual([{ judge: "openai", value: openaiResult }]);
    expect(result.judgesFailed).toEqual(["gemini"]);
    expect(result.openaiJudgeProvider).toBe("codex");
  });
});
