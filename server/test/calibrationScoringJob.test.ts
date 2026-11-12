import { describe, expect, it, vi } from "vitest";
import { useFakeTimersInTest } from "./helpers/fakeTimers.js";
import {
  parseAcceptedScoringJob,
  parseListenRepeatScoreResult,
  pollScoringJobResult,
} from "../../scripts/lib/scoringJob.js";

const validResult = {
  taskType: "listen_repeat",
  report: {
    taskType: "listen_repeat",
    items: [
      {
        itemId: "lr-1",
        ownScore: 4,
        finalScore: 4,
        maxScore: 5,
        dimensions: [{ name: "intelligibility", note: "clear" }],
        deductions: [],
        reconciliationNote: "agreed",
        feedbackZh: "清楚。",
      },
    ],
  },
  judges: [
    {
      judge: "openai",
      mode: "audio",
      items: [{ itemId: "lr-1", score: 4 }],
    },
  ],
  judgesFailed: [],
  items: [{ itemId: "lr-1", target: "Repeat this." }],
};

// The calibration scripts' client for a scoring job (scripts/lib/scoringJob.ts). Scoring makes paid
// calls, so the client polls the one job it started and never resubmits, and an overall deadline
// bounds the run even when a poll request hangs.
describe("calibration scoring-job polling", () => {
  it("requires a non-empty accepted jobId", () => {
    expect(parseAcceptedScoringJob(202, { jobId: "job-1" })).toBe(
      "job-1"
    );
    expect(() => parseAcceptedScoringJob(202, {})).toThrow(
      /missing jobId/
    );
    expect(() =>
      parseAcceptedScoringJob(202, { jobId: "" })
    ).toThrow(/missing jobId/);
    expect(() =>
      parseAcceptedScoringJob(200, { jobId: "job-1" })
    ).toThrow(/expected 202/);
  });

  it("polls one accepted job without resubmitting, sleeps between non-terminal states, and validates the done result", async () => {
    let now = 0;
    const sleep = vi.fn(async (ms: number) => {
      now += ms;
    });
    const fetchImpl = vi
      .fn()
      .mockResolvedValueOnce(
        Response.json({
          jobId: "job-1",
          status: "queued",
          stage: null,
          progress: null,
        })
      )
      .mockResolvedValueOnce(
        Response.json({
          jobId: "job-1",
          status: "running",
          stage: "judging",
          progress: null,
        })
      )
      .mockResolvedValueOnce(
        Response.json({
          jobId: "job-1",
          status: "done",
          stage: "persisting",
          progress: null,
          result: validResult,
        })
      );

    const result = await pollScoringJobResult(
      "http://localhost:8787",
      "attempt-1",
      "job-1",
      parseListenRepeatScoreResult,
      {
        fetchImpl: fetchImpl as never,
        intervalMs: 1500,
        timeoutMs: 600_000,
        now: () => now,
        sleep,
      }
    );

    expect(result.report.items[0].finalScore).toBe(4);
    expect(fetchImpl).toHaveBeenCalledTimes(3);
    expect(
      fetchImpl.mock.calls.every(
        ([url, init]) =>
          url ===
            "http://localhost:8787/api/attempts/attempt-1/score-jobs/job-1" &&
          init?.signal instanceof AbortSignal
      )
    ).toBe(true);
    expect(sleep.mock.calls).toEqual([[1500], [1500]]);
  });

  it("aborts an in-flight poll fetch at the overall deadline and clears its timer", async () => {
    const clock = useFakeTimersInTest();
    vi.setSystemTime(0);
    let observedSignal: AbortSignal | undefined;
    const fetchImpl = vi.fn(
      (_url: RequestInfo | URL, init?: RequestInit) => {
        observedSignal = init?.signal ?? undefined;
        if (!observedSignal) {
          return Promise.reject(
            new Error("missing deadline signal")
          );
        }
        return new Promise<Response>((_resolve, reject) => {
          observedSignal!.addEventListener(
            "abort",
            () =>
              reject(
                new DOMException(
                  "request aborted",
                  "AbortError"
                )
              ),
            { once: true }
          );
        });
      }
    );

    const outcome = pollScoringJobResult(
      "http://localhost:8787",
      "attempt-1",
      "job-1",
      parseListenRepeatScoreResult,
      {
        fetchImpl: fetchImpl as never,
        timeoutMs: 2000,
      }
    ).catch((error: unknown) => error);

    await clock.advanceBy(2000);
    const error = await outcome;

    expect(error).toBeInstanceOf(Error);
    expect((error as Error).message).toBe(
      "Scoring job job-1 timed out after 2000ms."
    );
    expect(observedSignal?.aborted).toBe(true);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("rejects a done body that resolves after the deadline even when the fake fetch ignores abort", async () => {
    const clock = useFakeTimersInTest();
    vi.setSystemTime(0);
    let observedSignal: AbortSignal | undefined;
    const response = {
      ok: true,
      status: 200,
      json: () =>
        new Promise<unknown>((resolve) => {
          setTimeout(
            () =>
              resolve({
                jobId: "job-1",
                status: "done",
                stage: "persisting",
                progress: null,
                result: validResult,
              }),
            2001
          );
        }),
    } as Response;
    const fetchImpl = vi.fn(
      (_url: RequestInfo | URL, init?: RequestInit) => {
        observedSignal = init?.signal ?? undefined;
        return Promise.resolve(response);
      }
    );

    const outcome = pollScoringJobResult(
      "http://localhost:8787",
      "attempt-1",
      "job-1",
      parseListenRepeatScoreResult,
      {
        fetchImpl: fetchImpl as never,
        timeoutMs: 2000,
      }
    ).then(
      (value) => ({ value }),
      (error: unknown) => ({ error })
    );

    await clock.advanceBy(2001);
    const result = await outcome;

    expect(result).toHaveProperty("error");
    expect(String("error" in result ? result.error : "")).toBe(
      "Error: Scoring job job-1 timed out after 2000ms."
    );
    expect(observedSignal?.aborted).toBe(true);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    expect(vi.getTimerCount()).toBe(0);
  });

  it.each([
    ["failed", { error: "both judges failed" }, /job job-1 failed/],
    ["cancelled", {}, /job job-1 was cancelled/],
    ["mystery", {}, /unknown status/],
  ])(
    "surfaces terminal/unknown status %s clearly",
    async (status, extra, expected) => {
      const fetchImpl = vi.fn().mockResolvedValue(
        Response.json({
          jobId: "job-1",
          status,
          stage: null,
          progress: null,
          ...extra,
        })
      );

      await expect(
        pollScoringJobResult(
          "http://localhost:8787",
          "attempt-1",
          "job-1",
          parseListenRepeatScoreResult,
          { fetchImpl: fetchImpl as never }
        )
      ).rejects.toThrow(expected);
      expect(fetchImpl).toHaveBeenCalledTimes(1);
    }
  );

  it("rejects non-OK polls, malformed done results, and bounded timeouts", async () => {
    await expect(
      pollScoringJobResult(
        "http://localhost:8787",
        "attempt-1",
        "job-1",
        parseListenRepeatScoreResult,
        {
          fetchImpl: vi
            .fn()
            .mockResolvedValue(
              new Response("not found", { status: 404 })
            ) as never,
        }
      )
    ).rejects.toThrow(/poll failed with HTTP 404/);

    await expect(
      pollScoringJobResult(
        "http://localhost:8787",
        "attempt-1",
        "job-1",
        parseListenRepeatScoreResult,
        {
          fetchImpl: vi
            .fn()
            .mockResolvedValue(
              Response.json({
                jobId: "job-1",
                status: "done",
                stage: "persisting",
                progress: null,
                result: { taskType: "listen_repeat" },
              })
            ) as never,
        }
      )
    ).rejects.toThrow(/invalid result/);

    let now = 0;
    const sleep = vi.fn(async (ms: number) => {
      now += ms;
    });
    const fetchImpl = vi.fn().mockImplementation(async () =>
      Response.json({
        jobId: "job-1",
        status: "running",
        stage: "judging",
        progress: null,
      })
    );
    await expect(
      pollScoringJobResult(
        "http://localhost:8787",
        "attempt-1",
        "job-1",
        parseListenRepeatScoreResult,
        {
          fetchImpl: fetchImpl as never,
          intervalMs: 1000,
          timeoutMs: 2000,
          now: () => now,
          sleep,
        }
      )
    ).rejects.toThrow(/timed out after 2000ms/);
    expect(fetchImpl).toHaveBeenCalledTimes(2);
    expect(sleep).toHaveBeenCalledTimes(2);
  });
});
