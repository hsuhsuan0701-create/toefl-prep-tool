import { afterEach, describe, expect, it, vi } from "vitest";
import type { JudgeReport, ReasoningFailureKind } from "@toefl-prep/shared";
import { config } from "../src/lib/config.js";
import {
  composeJudgePrompt,
  judgeEssay,
  JudgeError,
} from "../src/services/judges/index.js";
import type { ProviderResult } from "../src/services/reasoning/contracts.js";
import { createProviderState } from "../src/services/reasoning/providerState.js";
import type { ModelCallInsert } from "../src/db/rows.js";
import {
  resetModelCallSink,
  setModelCallSink,
} from "../src/services/modelCallLog.js";
import {
  runOpenAiText as realRunOpenAiText,
  type OpenAiTextRouteDeps,
  type OpenAiTextRequest,
} from "../src/services/reasoning/router.js";
import { virtualDelay } from "./helpers/virtualDelay.js";

const SECRET =
  "PROMPT_CANARY raw-response-canary sk-live-credential";

const validReport: JudgeReport = {
  judge: "gemini",
  taskType: "email",
  items: [
    {
      itemId: "em1",
      score: 4,
      dimensions: [
        {
          name: "communicative goal & social conventions",
          score: 4,
          evidence: "polite request made",
        },
        {
          name: "elaboration & cohesion",
          score: 4,
          evidence: "covers bullets",
        },
        {
          name: "grammar & vocabulary",
          score: 3.5,
          evidence: "one broken clause",
        },
        {
          name: "mechanics",
          score: 4,
          evidence: "minor typos",
        },
      ],
      deductions: [
        {
          quote: "can sucessfully sent",
          issue: "collapsed verb phrase",
          fix: "can successfully be sent",
          category: "grammar",
        },
      ],
    },
  ],
};

const geminiWrap = (value: unknown) =>
  new Response(
    JSON.stringify({
      candidates: [
        { content: { parts: [{ text: JSON.stringify(value) }] } },
      ],
    }),
    { status: 200 }
  );

const openaiWrap = (value: unknown) =>
  new Response(
    JSON.stringify({
      choices: [{ message: { content: JSON.stringify(value) } }],
    }),
    { status: 200 }
  );

const input = {
  taskType: "email" as const,
  materials: { scenario: "s", bullets: ["1", "2", "3"] },
  responseText: "Dear Prof…",
};

function codexFailure(
  kind: ReasoningFailureKind
): ProviderResult<never, "codex"> {
  return {
    ok: false,
    failure: { provider: "codex", kind, source: "call" },
  };
}

function routerBackedRunner(options: {
  runCodex: ReturnType<typeof vi.fn>;
  primary?: "codex" | "http";
  providerState?: ReturnType<typeof createProviderState>;
}): typeof realRunOpenAiText {
  const runner: typeof realRunOpenAiText = (request, deps) =>
    realRunOpenAiText(request, {
      ...deps,
      providerState: options.providerState ?? createProviderState(),
      runCodex: options.runCodex as never,
      onLog: () => undefined,
      ...(options.primary ? { openaiTextPrimary: options.primary } : {}),
    });
  return runner;
}

function parseBody(fetchImpl: ReturnType<typeof vi.fn>, call = 0) {
  return JSON.parse(
    (fetchImpl.mock.calls[call][1] as RequestInit).body as string
  ) as {
    model: string;
    messages: { role: string; content: string }[];
    response_format: { type: string };
  };
}

describe("composeJudgePrompt", () => {
  it("embeds rubric text, dimension names, and the response", () => {
    const prompt = composeJudgePrompt(
      "email",
      input.materials,
      input.responseText
    );
    expect(prompt).toContain("Score: 5");
    expect(prompt).toContain(
      "communicative goal & social conventions"
    );
    expect(prompt).toContain("Dear Prof…");
    expect(prompt).not.toMatch(/AGGREGATE|partA|partB/);
  });

  it("embeds the discussion rubric without leaking arbiter vocabulary", () => {
    const prompt = composeJudgePrompt(
      "discussion",
      input.materials,
      input.responseText
    );
    expect(prompt).toContain("argument & engagement");
    expect(prompt).toContain("support & cohesion");
    expect(prompt).toContain("grammar & vocabulary");
    expect(prompt).toContain("mechanics");
    expect(prompt).toContain("Score: 5");
    expect(prompt).not.toMatch(/AGGREGATE|partA|partB/);
  });
});

describe("HTTP judge transcript recording", () => {
  afterEach(() => resetModelCallSink());

  it("records the prompt and the model's text for both HTTP judges, and never a credential", async () => {
    const rows: ModelCallInsert[] = [];
    setModelCallSink((row) => rows.push(row));

    await judgeEssay("gemini", input, { fetchImpl: vi.fn().mockResolvedValue(geminiWrap(validReport)) as never });
    await judgeEssay("openai", input, {
      fetchImpl: vi.fn().mockResolvedValue(openaiWrap(validReport)) as never,
      // Real router, forced onto the HTTP leg — Codex is this route's default primary.
      runOpenAiText: routerBackedRunner({ runCodex: vi.fn(), primary: "http" }),
    });

    expect(rows.map((r) => [r.route, r.provider, r.outcome])).toEqual([
      ["gemini-essay-judge", "gemini-http", "succeeded"],
      ["openai-text-judge", "openai-http", "succeeded"],
    ]);
    expect(rows.every((r) => r.prompt.includes("Dear Prof"))).toBe(true);
    expect(rows.every((r) => (r.response ?? "").includes("grammar"))).toBe(true);

    // The invariant the whole table depends on: rows carry bodies, never headers. The Gemini key
    // rides in x-goog-api-key and the OpenAI key in Authorization, so neither can reach a row
    // unless someone starts recording the request envelope instead of the prompt.
    const serialized = JSON.stringify(rows);
    for (const secret of [config.geminiKey, config.openaiKey].filter((k): k is string => Boolean(k))) {
      expect(serialized).not.toContain(secret);
    }
    expect(serialized).not.toContain("Authorization");
    expect(serialized).not.toContain("x-goog-api-key");
  });

  it("records a failed HTTP judge call with its status, so a bad response is not simply missing", async () => {
    const rows: ModelCallInsert[] = [];
    setModelCallSink((row) => rows.push(row));

    // 400 rather than a 5xx: withJudgeRetries backs off for a full 5s on retryable statuses, and
    // this test is about what gets recorded, not about the retry schedule.
    await expect(
      judgeEssay("gemini", input, { fetchImpl: vi.fn().mockResolvedValue(new Response("nope", { status: 400 })) as never })
    ).rejects.toThrow();

    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ outcome: "failed", failureKind: "http-400" });
    // A failed call has no model text — recorded as absent rather than as an empty answer.
    expect(rows.every((r) => r.response === undefined)).toBe(true);
  });
});

describe("judgeEssay (gemini HTTP)", () => {
  it("uses the injected fetchImpl instead of global fetch", async () => {
    const injectedFetch = vi
      .fn()
      .mockResolvedValue(geminiWrap(validReport));
    const globalFetch = vi
      .fn()
      .mockRejectedValue(new Error("billable global fetch"));
    const originalFetch = globalThis.fetch;
    vi.stubGlobal("fetch", globalFetch);

    try {
      const result = await judgeEssay(
        "gemini",
        input,
        { fetchImpl: injectedFetch as unknown as typeof fetch }
      );
      expect(result.provider).toBe("gemini-http");
      expect(injectedFetch).toHaveBeenCalledTimes(1);
      expect(globalFetch).not.toHaveBeenCalled();
    } finally {
      vi.stubGlobal("fetch", originalFetch);
    }
  });

  it("keeps an empty plain dependency object valid and uses production defaults", async () => {
    const globalFetch = vi
      .fn()
      .mockResolvedValue(geminiWrap(validReport));
    const originalFetch = globalThis.fetch;
    vi.stubGlobal("fetch", globalFetch);

    try {
      await expect(
        judgeEssay("gemini", input, {})
      ).resolves.toMatchObject({ provider: "gemini-http" });
      expect(globalFetch).toHaveBeenCalledTimes(1);
    } finally {
      vi.stubGlobal("fetch", originalFetch);
    }
  });

  it("preserves the Gemini request and retry/repair behavior, then wraps the stamped report", async () => {
    const fetchImpl = vi
      .fn()
      .mockResolvedValueOnce(geminiWrap("not a report"))
      .mockResolvedValueOnce(
        geminiWrap({
          ...validReport,
          judge: "openai",
          taskType: "discussion",
        })
      );

    const result = await judgeEssay("gemini", input, {
      fetchImpl: fetchImpl as never,
    });

    expect(result.provider).toBe("gemini-http");
    expect(result.report.judge).toBe("gemini");
    expect(result.report.taskType).toBe("email");
    expect(result.report.items[0].dimensions).toHaveLength(4);
    expect(fetchImpl).toHaveBeenCalledTimes(2);
    expect(fetchImpl.mock.calls[0][0]).toContain(
      "generativelanguage.googleapis.com"
    );
    expect(
      JSON.parse(
        (fetchImpl.mock.calls[0][1] as RequestInit).body as string
      )
    ).toMatchObject({
      generationConfig: { responseMimeType: "application/json" },
    });
  });

  it("retries a 429, and gives up at once on a non-retryable 400", async () => {
    const retryClock = virtualDelay();
    const succeedsAfterRateLimit = vi
      .fn()
      .mockResolvedValueOnce(new Response("slow down", { status: 429 }))
      .mockResolvedValueOnce(geminiWrap(validReport));
    await expect(
      judgeEssay("gemini", input, {
        fetchImpl: succeedsAfterRateLimit as never,
        delay: retryClock.delay,
      })
    ).resolves.toMatchObject({ provider: "gemini-http" });
    expect(succeedsAfterRateLimit).toHaveBeenCalledTimes(2);
    expect(retryClock.waits).toEqual([1000]);

    const terminalClock = virtualDelay();
    const badRequest = vi
      .fn()
      .mockResolvedValue(new Response("bad", { status: 400 }));
    await expect(
      judgeEssay("gemini", input, {
        fetchImpl: badRequest as never,
        delay: terminalClock.delay,
      })
    ).rejects.toBeInstanceOf(JudgeError);
    expect(badRequest).toHaveBeenCalledTimes(1);
    expect(terminalClock.waits).toEqual([]);
  });

  it.each([
    ["exhausted 429s", 429],
    ["exhausted 5xx", 503],
  ])("backs off 1 s then 4 s before giving up on %s", async (_label, status) => {
    const clock = virtualDelay();
    const alwaysFails = vi
      .fn()
      .mockImplementation(async () => new Response("try later", { status }));
    await expect(
      judgeEssay("gemini", input, {
        fetchImpl: alwaysFails as never,
        delay: clock.delay,
      })
    ).rejects.toBeInstanceOf(JudgeError);
    expect(alwaysFails).toHaveBeenCalledTimes(3);
    expect(clock.waits).toEqual([1000, 4000]);
  });

  it("never exposes raw HTTP or invalid model output in JudgeError", async () => {
    const httpFailure = vi
      .fn()
      .mockResolvedValue(
        new Response(SECRET, { status: 401 })
      );
    await expect(
      judgeEssay("gemini", input, {
        fetchImpl: httpFailure as never,
      })
    ).rejects.toSatisfy((error: unknown) => {
      expect(error).toBeInstanceOf(JudgeError);
      expect(String(error)).toContain("judge gemini 401");
      expect(String(error)).not.toContain(SECRET);
      expect(JSON.stringify(error)).not.toContain(SECRET);
      return true;
    });

    const invalidOutput = vi
      .fn()
      .mockResolvedValue(geminiWrap(SECRET));
    await expect(
      judgeEssay("gemini", input, {
        fetchImpl: invalidOutput as never,
      })
    ).rejects.toSatisfy((error: unknown) => {
      expect(error).toBeInstanceOf(JudgeError);
      expect(String(error)).toContain(
        "invalid structured output"
      );
      expect(String(error)).not.toContain(SECRET);
      expect(JSON.stringify(error)).not.toContain(SECRET);
      return true;
    });
    expect(invalidOutput).toHaveBeenCalledTimes(2);
  });
});

describe("judgeEssay (OpenAI text facade)", () => {
  it("uses the existing prompt/schema/parser through Codex and never fetches HTTP on Codex success", async () => {
    const fetchImpl = vi.fn();
    const runCodex = vi.fn(async (options: {
      prompt: string;
      jsonSchema: object;
      parse: (value: unknown) => JudgeReport;
    }) => ({
      ok: true as const,
      provider: "codex" as const,
      value: options.parse({
        ...validReport,
        judge: "gemini",
        taskType: "discussion",
      }),
    }));

    const result = await judgeEssay("openai", input, {
      fetchImpl: fetchImpl as never,
      runOpenAiText: routerBackedRunner({ runCodex }),
    });

    expect(result.provider).toBe("codex");
    expect(result.report.judge).toBe("openai");
    expect(result.report.taskType).toBe("email");
    expect(fetchImpl).not.toHaveBeenCalled();
    expect(runCodex).toHaveBeenCalledTimes(1);

    const request = runCodex.mock.calls[0][0];
    expect(request.prompt).toBe(
      composeJudgePrompt(
        input.taskType,
        input.materials,
        input.responseText
      )
    );
    expect(request.prompt).not.toContain("/toefl-writing");
    expect(request.jsonSchema).toMatchObject({
      type: "object",
      properties: {
        judge: expect.any(Object),
        taskType: expect.any(Object),
        items: expect.any(Object),
      },
    });
    expect(() => request.parse({ invalid: true })).toThrow();
  });

  it("falls back after Codex invalid output, uses the captured HTTP model, and performs exactly one HTTP JSON repair", async () => {
    const capturedModel = "captured-http-model";
    const fetchImpl = vi
      .fn()
      .mockResolvedValueOnce(openaiWrap("not a report"))
      .mockResolvedValueOnce(openaiWrap(validReport));
    const runCodex = vi
      .fn()
      .mockResolvedValue(codexFailure("invalid-output"));
    const routed = routerBackedRunner({ runCodex });
    const runOpenAiText: typeof realRunOpenAiText = (
      request,
      deps
    ) => {
      const wrappedHttp: OpenAiTextRouteDeps<
        unknown
      >["runHttp"] = async (httpRequest) => {
        Object.assign(config, {
          openaiJudgeModel: `${SECRET}-mutated-model`,
        });
        return (deps.runHttp as OpenAiTextRouteDeps<unknown>["runHttp"])(
          { ...httpRequest, model: capturedModel }
        );
      };
      return routed(request, {
        ...deps,
        runHttp: wrappedHttp as never,
      });
    };
    const originalModel = config.openaiJudgeModel;

    try {
      const result = await judgeEssay("openai", input, {
        fetchImpl: fetchImpl as never,
        runOpenAiText,
      });

      expect(result.provider).toBe("openai-http");
      expect(result.report.judge).toBe("openai");
      expect(fetchImpl).toHaveBeenCalledTimes(2);
      expect(parseBody(fetchImpl, 0).model).toBe(capturedModel);
      expect(parseBody(fetchImpl, 1).model).toBe(capturedModel);
      expect(parseBody(fetchImpl, 0).messages[0].content).toBe(
        composeJudgePrompt(
          input.taskType,
          input.materials,
          input.responseText
        )
      );
      expect(parseBody(fetchImpl, 1).messages[0].content).toMatch(
        /previous output was invalid/
      );
      expect(parseBody(fetchImpl, 1).response_format).toEqual({
        type: "json_object",
      });
    } finally {
      config.openaiJudgeModel = originalModel;
    }
  });

  it("treats a malformed 200 JSON envelope as invalid output and repairs once on the HTTP fallback", async () => {
    const fetchImpl = vi
      .fn()
      .mockResolvedValueOnce(
        new Response("{ malformed", { status: 200 })
      )
      .mockResolvedValueOnce(openaiWrap(validReport));
    const runCodex = vi
      .fn()
      .mockResolvedValue(codexFailure("invalid-output"));

    const result = await judgeEssay("openai", input, {
      fetchImpl: fetchImpl as never,
      runOpenAiText: routerBackedRunner({ runCodex }),
    });

    expect(result.provider).toBe("openai-http");
    expect(fetchImpl).toHaveBeenCalledTimes(2);
    expect(parseBody(fetchImpl, 1).messages[0].content).toMatch(
      /previous output was invalid/
    );
  });

  it.each([
    ["quota failure", "quota" as const, false],
    ["open circuit", "quota" as const, true],
  ])(
    "falls back to HTTP after a Codex %s",
    async (_label, kind, openCircuit) => {
      const providerState = createProviderState();
      if (openCircuit) {
        providerState.recordPreflight("codex", {
          ok: false,
          kind,
        });
      }
      const runCodex = vi
        .fn()
        .mockResolvedValue(codexFailure(kind));
      const fetchImpl = vi
        .fn()
        .mockResolvedValue(openaiWrap(validReport));

      const result = await judgeEssay("openai", input, {
        fetchImpl: fetchImpl as never,
        runOpenAiText: routerBackedRunner({
          runCodex,
          providerState,
        }),
      });

      expect(result.provider).toBe("openai-http");
      expect(fetchImpl).toHaveBeenCalledTimes(1);
      expect(runCodex).toHaveBeenCalledTimes(openCircuit ? 0 : 1);
    }
  );

  it("honors HTTP-primary rollback without invoking Codex", async () => {
    const runCodex = vi.fn();
    const fetchImpl = vi
      .fn()
      .mockResolvedValue(openaiWrap(validReport));

    const result = await judgeEssay("openai", input, {
      fetchImpl: fetchImpl as never,
      runOpenAiText: routerBackedRunner({
        runCodex,
        primary: "http",
      }),
    });

    expect(result.provider).toBe("openai-http");
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    expect(runCodex).not.toHaveBeenCalled();
  });

  it("normalizes both-route failures into one fixed sanitized OpenAI judge error", async () => {
    const runCodex = vi
      .fn()
      .mockResolvedValue(codexFailure("invalid-output"));
    const fetchImpl = vi.fn().mockResolvedValue(
      new Response(SECRET, {
        status: 401,
      })
    );

    let error: unknown;
    try {
      await judgeEssay("openai", input, {
        fetchImpl: fetchImpl as never,
        runOpenAiText: routerBackedRunner({ runCodex }),
      });
    } catch (caught) {
      error = caught;
    }

    expect(error).toBeInstanceOf(JudgeError);
    expect(String(error)).toBe(
      "JudgeError: judge openai unavailable: structured reasoning unavailable"
    );
    expect(String(error)).not.toContain("Codex");
    expect(String(error)).not.toContain("OpenAI HTTP");
    expect(String(error)).not.toContain(SECRET);
    expect(JSON.stringify(error)).not.toContain(SECRET);
    expect(error).not.toHaveProperty("body");
    expect(error).not.toHaveProperty("raw");
    expect(error).not.toHaveProperty("issues");
  });

  it("sanitizes an injected facade exception instead of leaking its diagnostic", async () => {
    const runOpenAiText = vi.fn(async (
      _request: OpenAiTextRequest<unknown>
    ) => {
      throw new Error(SECRET);
    }) as unknown as typeof realRunOpenAiText;

    await expect(
      judgeEssay("openai", input, { runOpenAiText })
    ).rejects.toSatisfy((error: unknown) => {
      expect(error).toBeInstanceOf(JudgeError);
      expect(String(error)).not.toContain(SECRET);
      return true;
    });
  });
});
