import { afterEach, describe, expect, it, vi } from "vitest";
import { config } from "../src/lib/config.js";
import { judgeEssay, JudgeError } from "../src/services/judges/index.js";
import { createProviderState } from "../src/services/reasoning/providerState.js";
import { runOpenAiText } from "../src/services/reasoning/router.js";

// OPENAI_JUDGE_MODEL is the one route setting config.ts does not validate at boot (it defaults to
// blank). The OpenAI text route is the place that requires it, in Codex-first mode too, because
// its HTTP fallback leg cannot run without a model.

const originalModel = config.openaiJudgeModel;

afterEach(() => {
  config.openaiJudgeModel = originalModel;
});

describe("the OpenAI text route requires OPENAI_JUDGE_MODEL", () => {
  it.each(["", "   "])("refuses to start with model %j, before any provider or observer runs", async (model) => {
    config.openaiJudgeModel = model;
    const runCodex = vi.fn();
    const runHttp = vi.fn();
    const onEvent = vi.fn();
    const onLog = vi.fn();

    await expect(runOpenAiText(
      { prompt: "p", jsonSchema: { type: "object" }, parse: (value) => value, onEvent },
      { providerState: createProviderState(), openaiTextPrimary: "codex", runCodex, runHttp, onLog },
    )).rejects.toThrow("OPENAI_JUDGE_MODEL is not set.");

    expect(runCodex).not.toHaveBeenCalled();
    expect(runHttp).not.toHaveBeenCalled();
    expect(onEvent).not.toHaveBeenCalled();
    expect(onLog).not.toHaveBeenCalled();
  });

  it("surfaces to the essay Judge as the OpenAI Judge being unavailable", async () => {
    config.openaiJudgeModel = "";
    const runCodex = vi.fn();
    const fetchImpl = vi.fn();

    await expect(judgeEssay(
      "openai",
      { taskType: "email", materials: {}, responseText: "Dear team," },
      {
        fetchImpl: fetchImpl as never,
        runOpenAiText: (request, deps) => runOpenAiText(request, {
          ...deps,
          providerState: createProviderState(),
          runCodex,
          onLog: () => undefined,
        }),
      },
    )).rejects.toSatisfy((error: unknown) => {
      expect(error).toBeInstanceOf(JudgeError);
      expect(String(error)).toBe("JudgeError: judge openai unavailable: structured reasoning unavailable");
      return true;
    });
    expect(runCodex).not.toHaveBeenCalled();
    expect(fetchImpl).not.toHaveBeenCalled();
  });
});
