import { describe, expect, it, vi } from "vitest";
import {
  aggregate,
  aggregateSpeaking,
  buildAggregatePayload,
  buildAggregateSpeakingPayload,
  type AggregateInput,
  type AggregateSpeakingInput,
} from "../src/services/arbiter.js";
import type { DeliveryReport, JudgeReport, ScoreReport } from "@toefl-prep/shared";
import type { SkillTaskRequest } from "../src/services/reasoning/router.js";
import { expectEveryObjectPropertyRequired } from "./schemaAssertions.js";

const judge = (name: "gemini" | "openai", score: number): JudgeReport => ({
  judge: name,
  taskType: "email",
  items: [{
    itemId: "em1",
    score,
    dimensions: [{ name: "mechanics", score, evidence: "clean spelling" }],
    deductions: [{ quote: "q", issue: "i", fix: "f", category: "grammar" }],
  }],
});

const input = {
  taskType: "email" as const,
  itemId: "em1",
  materials: { scenario: "s" },
  responseText: "Dear…",
};

const reportItem = {
  itemId: "em1",
  ownScore: 4,
  finalScore: 4,
  maxScore: 5 as const,
  dimensions: [{ name: "mechanics", note: "ok" }],
  deductions: [],
  reconciliationNote: "agreed",
  feedbackZh: "寫得不錯。",
};

function scoreReport(
  taskType: ScoreReport["taskType"],
  items: ScoreReport["items"] = [reportItem],
): ScoreReport {
  return { taskType, items };
}

function routeSuccess(
  value: ScoreReport,
  provider: "claude" | "codex" = "claude",
) {
  return vi.fn(async (_request: SkillTaskRequest<ScoreReport>) => ({
    ok: true as const,
    value,
    provider,
    attempts: [],
  }));
}

function routeFailure() {
  return vi.fn(async () => ({
    ok: false as const,
    error: "Structured reasoning unavailable: Claude (quota) → Codex (timeout).",
    attempts: [
      { provider: "claude" as const, kind: "quota" as const },
      { provider: "codex" as const, kind: "timeout" as const },
    ],
  }));
}

// The Arbiter commits its own score from the evidence before it reconciles with the Judges', so
// every number goes in partB, after partA (output-order commitment, ADR 0001).
describe("buildAggregatePayload", () => {
  it("strips every numeric score from partA and puts numbers only in partB, last", () => {
    const payload = buildAggregatePayload(input, [judge("gemini", 4), judge("openai", 3)]);
    expect(JSON.stringify(payload.partA)).not.toMatch(/"score"/);
    expect(payload.partB.scores).toEqual([
      { judge: "gemini", itemScore: 4 },
      { judge: "openai", itemScore: 3 },
    ]);
    expect(Object.keys(payload)).toEqual(["partA", "partB"]);
  });
});

describe("aggregate", () => {
  it.each(["email", "discussion"] as const)(
    "routes %s with the exact descriptor, slash prompt, schema, parser, and provider",
    async (taskType) => {
      const raw = scoreReport(taskType);
      const runSkillTask = routeSuccess(raw, "codex");
      const aggregateInput: AggregateInput = {
        ...input,
        taskType,
        judgeReports: [judge("gemini", 4), judge("openai", 4)],
      };

      const result = await aggregate(aggregateInput, { runSkillTask });

      expect(result.provider).toBe("codex");
      expect(result.report.items[0].finalScore).toBe(4);
      expect(runSkillTask).toHaveBeenCalledTimes(1);
      const request = runSkillTask.mock.calls[0][0] as SkillTaskRequest<ScoreReport>;
      const payload = buildAggregatePayload(aggregateInput, aggregateInput.judgeReports);
      expect(request.task).toEqual({ task: "aggregate", context: taskType });
      expect(request.prompt).toBe(
        `/toefl-writing\nAGGREGATE ${taskType}\n\n\`\`\`json\n${JSON.stringify(payload, null, 2)}\n\`\`\``,
      );
      // The schema both CLIs answer must be one Codex's strict structured output accepts: every
      // property required, no composition keywords (isCodexStrictOutputSchema in codexRunner.ts).
      // The server-derived flags are absent from it, and the optional Model Rewrite is a
      // required nullable field that the parser turns back into an absent one.
      expect(request.jsonSchema).toMatchObject({ type: "object" });
      expectEveryObjectPropertyRequired(request.jsonSchema);
      const reasoningRaw = {
        ...raw,
        items: raw.items.map((item) => ({
          ...item,
          modelRewrite: null,
        })),
      };
      const reasoningItemSchema = (
        request.jsonSchema as {
          properties: {
            items: {
              items: {
                properties: Record<string, unknown>;
              };
            };
          };
        }
      ).properties.items.items;
      expect(reasoningItemSchema.properties).not.toHaveProperty("singleJudge");
      expect(reasoningItemSchema.properties).not.toHaveProperty("lowConfidence");
      expect(reasoningItemSchema.properties).not.toHaveProperty("selfArbitrated");
      expect(reasoningItemSchema.properties.modelRewrite).toMatchObject({
        anyOf: expect.arrayContaining([{ type: "null" }]),
      });
      const serializedSchema = JSON.stringify(request.jsonSchema);
      for (const unsupportedKeyword of [
        "oneOf",
        "allOf",
        "not",
        "dependentRequired",
        "dependentSchemas",
        "if",
        "then",
        "else",
      ]) {
        expect(serializedSchema).not.toContain(`"${unsupportedKeyword}"`);
      }
      expect(request.parse(reasoningRaw)).toEqual(raw);
      expect(request.parse({
        ...reasoningRaw,
        items: reasoningRaw.items.map((item) => ({
          ...item,
          singleJudge: true,
          lowConfidence: true,
          selfArbitrated: true,
        })),
      })).toEqual(raw);
      expect(request.parse({
        ...reasoningRaw,
        items: reasoningRaw.items.map((item) => ({
          ...item,
          modelRewrite: "A polished rewrite.",
        })),
      })).toEqual({
        ...raw,
        items: raw.items.map((item) => ({
          ...item,
          modelRewrite: "A polished rewrite.",
        })),
      });
      expect(() => request.parse({ nonsense: true })).toThrow();
    },
  );

  it("forwards provider events to the optional observer", async () => {
    const events: unknown[] = [];
    const runSkillTask = vi.fn(async (request: SkillTaskRequest<ScoreReport>) => {
      request.onEvent?.({ state: "queued", provider: "claude", queuePosition: 2 });
      request.onEvent?.({
        state: "fallback",
        provider: "codex",
        fallbackFrom: "claude",
        failureKind: "quota",
      });
      request.onEvent?.({ state: "running", provider: "codex", fallbackFrom: "claude" });
      return {
        ok: true as const,
        value: scoreReport("email"),
        provider: "codex" as const,
        attempts: [{ provider: "claude" as const, kind: "quota" as const }],
      };
    });

    await aggregate(
      { ...input, judgeReports: [judge("gemini", 4), judge("openai", 4)] },
      { runSkillTask, onEvent: (event) => events.push(event) },
    );

    expect(events).toEqual([
      { state: "queued", provider: "claude", queuePosition: 2 },
      { state: "fallback", provider: "codex", fallbackFrom: "claude", failureKind: "quota" },
      { state: "running", provider: "codex", fallbackFrom: "claude" },
    ]);
  });

  // The Disagreement Flag, singleJudge and selfArbitrated are facts about the run that only the
  // server knows; a model's copy of them is discarded and the server's re-applied.
  it("reapplies only server-derived flags and strips all model-authored flags", async () => {
    const modeled = scoreReport("email", [{
      ...reportItem,
      lowConfidence: true,
      singleJudge: true,
      selfArbitrated: true,
    }] as ScoreReport["items"]);
    const agreeing = await aggregate(
      { ...input, judgeReports: [judge("gemini", 4), judge("openai", 4)] },
      { runSkillTask: routeSuccess(modeled) },
    );
    expect(agreeing.report.items[0].lowConfidence).toBeUndefined();
    expect(agreeing.report.items[0].singleJudge).toBeUndefined();
    expect(agreeing.report.items[0].selfArbitrated).toBeUndefined();

    const disagreeing = await aggregate(
      { ...input, judgeReports: [judge("gemini", 4.5), judge("openai", 3)] },
      { runSkillTask: routeSuccess(modeled) },
    );
    expect(disagreeing.report.items[0].lowConfidence).toBe(true);
    expect(disagreeing.report.items[0].singleJudge).toBeUndefined();
    expect(disagreeing.report.items[0].selfArbitrated).toBeUndefined();

    const single = await aggregate(
      { ...input, judgeReports: [judge("gemini", 4)] },
      { runSkillTask: routeSuccess(modeled) },
    );
    expect(single.report.items[0].singleJudge).toBe(true);
    expect(single.report.items[0].selfArbitrated).toBeUndefined();
  });

  it("forces selfArbitrated when Codex authored the OpenAI Judge report and arbitrated", async () => {
    const modeled = scoreReport("email", [{
      ...reportItem,
      selfArbitrated: false,
    }]);

    const result = await aggregate(
      {
        ...input,
        judgeReports: [judge("gemini", 4), judge("openai", 4)],
        openaiJudgeProvider: "codex",
      },
      { runSkillTask: routeSuccess(modeled, "codex") },
    );

    expect(result.report.items[0].selfArbitrated).toBe(true);
  });

  it.each([
    ["claude", "codex"],
    ["codex", "openai-http"],
    ["codex", undefined],
  ] as const)(
    "does not fabricate selfArbitrated for arbiter %s and OpenAI Judge %s",
    async (arbiterProvider, openaiJudgeProvider) => {
      const modeled = scoreReport("email", [{
        ...reportItem,
        selfArbitrated: true,
      }]);

      const result = await aggregate(
        {
          ...input,
          judgeReports: [judge("gemini", 4), judge("openai", 4)],
          openaiJudgeProvider,
        },
        { runSkillTask: routeSuccess(modeled, arbiterProvider) },
      );

      expect(result.report.items[0].selfArbitrated).toBeUndefined();
    },
  );

  it("throws ArbiterError containing only the sanitized failed route chain", async () => {
    await expect(aggregate(
      { ...input, judgeReports: [judge("gemini", 4)] },
      { runSkillTask: routeFailure() },
    )).rejects.toThrow(
      "arbiter failed: Structured reasoning unavailable: Claude (quota) → Codex (timeout).",
    );
  });
});

const lrItemIds = Array.from({ length: 7 }, (_, i) => `lr-${i + 1}`);
const flatDeliveryReport: DeliveryReport = {
  paceWpm: 130,
  pauses: "none notable",
  intelligibility: "clear",
  suspectedMispronunciations: [],
  intonation: "flat",
};

function speakingJudgeReport(judgeName: "gemini" | "openai", scores: number[]): JudgeReport {
  return {
    judge: judgeName,
    taskType: "listen_repeat",
    items: lrItemIds.map((itemId, i) => ({
      itemId,
      score: scores[i],
      dimensions: [{ name: "intelligibility", score: scores[i], evidence: "clear audio" }],
      deductions: [],
    })),
  };
}

function speakingInput(geminiScores: number[], openaiScores?: number[]): AggregateSpeakingInput {
  const items = lrItemIds.map((itemId, i) => ({
    itemId,
    target: `Target sentence ${i + 1}.`,
    transcript: `Transcript ${i + 1}.`,
    deliveryReport: flatDeliveryReport,
    diff: [{ op: "match" as const, targetWord: "a", saidWord: "a" }],
  }));
  const judgeReports = [speakingJudgeReport("gemini", geminiScores)];
  if (openaiScores) judgeReports.push(speakingJudgeReport("openai", openaiScores));
  return { taskType: "listen_repeat", items, judgeReports };
}

function speakingReportItem(itemId: string, finalScore = 4) {
  return {
    itemId,
    ownScore: finalScore,
    finalScore,
    maxScore: 5 as const,
    dimensions: [{ name: "intelligibility", note: "ok" }],
    deductions: [],
    reconciliationNote: "agreed",
    feedbackZh: "表現不錯。",
  };
}

describe("buildAggregateSpeakingPayload", () => {
  it("preserves all items/evidence in score-free partA and puts per-item scores in partB, last", () => {
    const speaking = speakingInput(
      [4, 4, 4, 4, 4, 4, 4],
      [3.5, 3.5, 3.5, 3.5, 3.5, 3.5, 3.5],
    );
    const payload = buildAggregateSpeakingPayload(speaking, speaking.judgeReports);
    expect(payload.partA.items).toHaveLength(7);
    expect(JSON.stringify(payload.partA)).not.toMatch(/"score"/);
    expect(Object.keys(payload)).toEqual(["partA", "partB"]);
    expect(payload.partB.scores).toHaveLength(14);
    expect(payload.partB.scores.slice(0, 2)).toEqual([
      { itemId: "lr-1", judge: "gemini", itemScore: 4 },
      { itemId: "lr-1", judge: "openai", itemScore: 3.5 },
    ]);
  });

  it("keeps task-specific material and optional judge modes in partA", () => {
    const speaking = speakingInput(
      [4, 4, 4, 4, 4, 4, 4],
      [4, 4, 4, 4, 4, 4, 4],
    );
    const payload = buildAggregateSpeakingPayload(
      { ...speaking, modes: { gemini: "audio", openai: "text-fallback" } },
      speaking.judgeReports,
    );
    expect(payload.partA.items[0]).toMatchObject({
      itemId: "lr-1",
      target: "Target sentence 1.",
      judges: [
        expect.objectContaining({ judge: "gemini", mode: "audio" }),
        expect.objectContaining({ judge: "openai", mode: "text-fallback" }),
      ],
    });
    expect(payload.partA.items[0]).not.toHaveProperty("question");
    expect(JSON.stringify(payload.partA)).not.toMatch(/"score"/);
  });
});

describe("aggregateSpeaking", () => {
  it.each(["listen_repeat", "interview"] as const)(
    "routes %s with the exact descriptor, slash prompt, parser, events, and provider",
    async (taskType) => {
      const base = speakingInput(
        [4, 4, 4, 4, 4, 4, 4],
        [4, 4, 4, 4, 4, 4, 4],
      );
      const speaking: AggregateSpeakingInput = taskType === "listen_repeat"
        ? base
        : {
            ...base,
            taskType,
            items: base.items.map(({ target: _target, diff: _diff, ...item }, i) => ({
              ...item,
              question: `Question ${i + 1}?`,
            })),
          };
      const raw = scoreReport(
        taskType,
        lrItemIds.map((id) => speakingReportItem(id)),
      );
      const events: unknown[] = [];
      const runSkillTask = vi.fn(async (request: SkillTaskRequest<ScoreReport>) => {
        request.onEvent?.({ state: "running", provider: "codex", fallbackFrom: "claude" });
        return { ok: true as const, value: raw, provider: "codex" as const, attempts: [] };
      });

      const result = await aggregateSpeaking(speaking, {
        runSkillTask,
        onEvent: (event) => events.push(event),
      });

      expect(result.provider).toBe("codex");
      expect(result.report.items.map((item) => item.itemId)).toEqual(lrItemIds);
      const request = runSkillTask.mock.calls[0][0] as SkillTaskRequest<ScoreReport>;
      const payload = buildAggregateSpeakingPayload(speaking, speaking.judgeReports);
      expect(request.task).toEqual({ task: "aggregate", context: taskType });
      expect(request.prompt).toBe(
        `/toefl-speaking\nAGGREGATE ${taskType}\n\n\`\`\`json\n${JSON.stringify(payload, null, 2)}\n\`\`\``,
      );
      const reasoningRaw = {
        ...raw,
        items: raw.items.map((item) => ({
          ...item,
          modelRewrite: null,
        })),
      };
      expect(request.parse(reasoningRaw)).toEqual(raw);
      expect(() => request.parse({ nonsense: true })).toThrow();
      expect(events).toEqual([
        { state: "running", provider: "codex", fallbackFrom: "claude" },
      ]);
    },
  );

  it("reapplies only current server-derived flags and never selfArbitrated", async () => {
    const speaking = speakingInput(
      [4, 4, 4.5, 4, 4, 4, 4],
      [4, 4, 3, 4, 4, 4, 4],
    );
    const modeled = scoreReport(
      "listen_repeat",
      lrItemIds.map((id) => ({
        ...speakingReportItem(id),
        singleJudge: true,
        lowConfidence: true,
        selfArbitrated: true,
      })),
    );
    const result = await aggregateSpeaking(speaking, {
      runSkillTask: routeSuccess(modeled, "claude"),
    });
    expect(result.provider).toBe("claude");
    expect(result.report.items.filter((item) => item.lowConfidence).map((item) => item.itemId))
      .toEqual(["lr-3"]);
    expect(result.report.items.every((item) => item.singleJudge === undefined)).toBe(true);
    expect(result.report.items.every((item) => item.selfArbitrated === undefined)).toBe(true);
  });

  it("forces singleJudge on every item with one report", async () => {
    const speaking = speakingInput([4, 4, 4, 4, 4, 4, 4]);
    const raw = scoreReport(
      "listen_repeat",
      lrItemIds.map((id) => speakingReportItem(id)),
    );
    const result = await aggregateSpeaking(speaking, {
      runSkillTask: routeSuccess(raw),
    });
    expect(result.report.items.every((item) => item.singleJudge)).toBe(true);
  });

  it("forces selfArbitrated consistently across a Codex/Codex speaking batch", async () => {
    const speaking = {
      ...speakingInput(
        [4, 4, 4, 4, 4, 4, 4],
        [4, 4, 4, 4, 4, 4, 4],
      ),
      openaiJudgeProvider: "codex" as const,
    };
    const modeled = scoreReport(
      "listen_repeat",
      lrItemIds.map((id) => ({
        ...speakingReportItem(id),
        selfArbitrated: false,
      })),
    );

    const result = await aggregateSpeaking(speaking, {
      runSkillTask: routeSuccess(modeled, "codex"),
    });

    expect(result.report.items).toHaveLength(lrItemIds.length);
    expect(result.report.items.every((item) => item.selfArbitrated === true)).toBe(true);
  });

  it.each([
    ["claude", "codex"],
    ["codex", "openai-http"],
    ["codex", undefined],
  ] as const)(
    "does not fabricate speaking selfArbitrated for arbiter %s and OpenAI Judge %s",
    async (arbiterProvider, openaiJudgeProvider) => {
      const speaking = {
        ...speakingInput(
          [4, 4, 4, 4, 4, 4, 4],
          [4, 4, 4, 4, 4, 4, 4],
        ),
        openaiJudgeProvider,
      };
      const modeled = scoreReport(
        "listen_repeat",
        lrItemIds.map((id) => ({
          ...speakingReportItem(id),
          selfArbitrated: true,
        })),
      );

      const result = await aggregateSpeaking(speaking, {
        runSkillTask: routeSuccess(modeled, arbiterProvider),
      });

      expect(result.report.items.every((item) => item.selfArbitrated === undefined)).toBe(true);
    },
  );

  it("throws a sanitized ArbiterError for a failed provider chain", async () => {
    const speaking = speakingInput([4, 4, 4, 4, 4, 4, 4]);
    await expect(aggregateSpeaking(speaking, {
      runSkillTask: routeFailure(),
    })).rejects.toThrow(
      "arbiter failed: Structured reasoning unavailable: Claude (quota) → Codex (timeout).",
    );
  });
});
