import fs from "node:fs";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { DeliveryReport } from "@toefl-prep/shared";
import {
  composeSpeakingJudgePrompt,
  judgeSpeaking,
  type SpeakingJudgeItem,
} from "../src/services/judges/speaking.js";
import { JudgeError } from "../src/services/judges/index.js";
import { config } from "../src/lib/config.js";
import type { ProviderResult } from "../src/services/reasoning/contracts.js";
import { createProviderState } from "../src/services/reasoning/providerState.js";
import type { ModelCallInsert } from "../src/db/rows.js";
import {
  resetModelCallSink,
  setModelCallSink,
} from "../src/services/modelCallLog.js";
import {
  runOpenAiText as realRunOpenAiText,
} from "../src/services/reasoning/router.js";
import { virtualDelay } from "./helpers/virtualDelay.js";

const WEBM = path.resolve(import.meta.dirname, "fixtures/tiny.webm");
const MP3 = path.resolve(import.meta.dirname, "fixtures/tiny.mp3");
const SECRET =
  "PROMPT_CANARY raw-audio-response-canary sk-live-credential";

const deliveryReport: DeliveryReport = {
  paceWpm: 118,
  pauses: "brief pause mid-sentence",
  intelligibility: "clear",
  suspectedMispronunciations: [],
  intonation: "natural, falling at the end",
};

function lrItems(n: number, audioPath: string = WEBM): SpeakingJudgeItem[] {
  return Array.from({ length: n }, (_, i) => ({
    itemId: `lr-${i + 1}`,
    audioPath,
    transcript: `we have a shelf of cookbooks number ${i + 1}`,
    deliveryReport,
    target: `We have a shelf of cookbooks number ${i + 1}.`,
    diff: [
      { op: "match" as const, targetWord: "We", saidWord: "we" },
      { op: "match" as const, targetWord: "have", saidWord: "have" },
    ],
  }));
}

function interviewItems(n: number, audioPath: string = WEBM): SpeakingJudgeItem[] {
  return Array.from({ length: n }, (_, i) => ({
    itemId: `int-${i + 1}`,
    audioPath,
    transcript: `my answer to interview question ${i + 1}`,
    deliveryReport,
    question: `Interview question number ${i + 1}?`,
  }));
}

const LR_DIMS = ["accuracy of repetition", "intelligibility"];
const INTERVIEW_DIMS = ["topical elaboration", "pace & pausing", "intelligibility & prosody", "grammar & vocabulary"];

function reportFor(
  items: SpeakingJudgeItem[],
  taskType: "listen_repeat" | "interview",
  judge: "gemini" | "openai" = "gemini"
) {
  const dims = taskType === "listen_repeat" ? LR_DIMS : INTERVIEW_DIMS;
  return {
    judge,
    taskType,
    items: items.map((it) => ({
      itemId: it.itemId,
      score: 4.5,
      dimensions: dims.map((name) => ({ name, score: 4.5, evidence: "solid, well-supported response" })),
      deductions: [],
    })),
  };
}

const geminiWrap = (o: unknown) =>
  new Response(JSON.stringify({ candidates: [{ content: { parts: [{ text: JSON.stringify(o) }] } }] }), { status: 200 });
const openaiWrap = (o: unknown) =>
  new Response(JSON.stringify({ choices: [{ message: { content: JSON.stringify(o) } }] }), { status: 200 });

type BodyOf = { fetch: ReturnType<typeof vi.fn>; call: number };
function bodyOf(f: ReturnType<typeof vi.fn>, call = 0): Record<string, unknown> {
  return JSON.parse((f.mock.calls[call][1] as RequestInit).body as string);
}

function codexFailure(
  kind: "invalid-output" | "quota"
): ProviderResult<never, "codex"> {
  return {
    ok: false,
    failure: { provider: "codex", kind, source: "call" },
  };
}

function routerBackedRunner(
  runCodex: ReturnType<typeof vi.fn>,
  providerState = createProviderState()
): typeof realRunOpenAiText {
  const runner: typeof realRunOpenAiText = (request, deps) =>
    realRunOpenAiText(request, {
      ...deps,
      providerState,
      runCodex: runCodex as never,
      onLog: () => undefined,
    });
  return runner;
}

describe("composeSpeakingJudgePrompt", () => {
  it("embeds the L&R rubric, dimension names, target/transcript/deliveryReport/diff, and the primary-evidence framing", () => {
    const items = lrItems(2);
    const p = composeSpeakingJudgePrompt("listen_repeat", items);
    expect(p).toContain("Score: 5"); // rubric file content present
    expect(p).toContain("accuracy of repetition");
    expect(p).toContain("intelligibility");
    expect(p).toContain(items[0].target!);
    expect(p).toContain(items[0].transcript);
    expect(p).toContain(JSON.stringify(items[0].deliveryReport));
    expect(p).toContain(JSON.stringify(items[0].diff));
    expect(p).toMatch(/PRIMARY evidence/);
    expect(p).toMatch(/ASR/);
    expect(p).not.toMatch(/AGGREGATE|partA|partB/); // judge ≠ arbiter
  });

  it("embeds the interview rubric, its four dimension names, and questions (no diff)", () => {
    const items = interviewItems(2);
    const p = composeSpeakingJudgePrompt("interview", items);
    expect(p).toContain("topical elaboration");
    expect(p).toContain("pace & pausing");
    expect(p).toContain("intelligibility & prosody");
    expect(p).toContain("grammar & vocabulary");
    expect(p).toContain(items[0].question!);
    expect(p).toContain(items[0].transcript);
    expect(p).not.toMatch(/AGGREGATE|partA|partB/);
  });

  it("includes one item block per item, in order, keyed by itemId", () => {
    const items = lrItems(7);
    const p = composeSpeakingJudgePrompt("listen_repeat", items);
    for (const item of items) expect(p).toContain(`### Item ${item.itemId}`);
    expect(p.indexOf("### Item lr-1")).toBeLessThan(p.indexOf("### Item lr-7"));
  });

  it("mode 'text-fallback' swaps the PRIMARY-evidence/listen-yourself sentence for an explicit no-audio note, leaving everything else intact", () => {
    const items = lrItems(2);
    const audioPrompt = composeSpeakingJudgePrompt("listen_repeat", items);
    const fallbackPrompt = composeSpeakingJudgePrompt("listen_repeat", items, "text-fallback");

    expect(fallbackPrompt).toContain(
      "No audio is available for this evaluation — score from the transcript and Delivery Report only."
    );
    expect(fallbackPrompt).not.toMatch(/PRIMARY evidence/);
    expect(fallbackPrompt).not.toMatch(/listen to the audio yourself/);

    // Everything else (rubric, item blocks, output schema) is unchanged between modes.
    expect(fallbackPrompt).toContain(items[0].target!);
    expect(fallbackPrompt).toContain(JSON.stringify(items[0].diff));
    expect(audioPrompt).toMatch(/PRIMARY evidence/); // default mode unaffected
  });
});

describe("speaking judge transcript recording", () => {
  afterEach(() => resetModelCallSink());

  it("records the prompt and a manifest of the attached clips, never the audio itself", async () => {
    const rows: ModelCallInsert[] = [];
    setModelCallSink((row) => rows.push(row));
    const items = lrItems(2, MP3);
    const fetchImpl = vi.fn().mockResolvedValue(geminiWrap(reportFor(items, "listen_repeat")));

    await judgeSpeaking("gemini", { taskType: "listen_repeat", items }, { fetchImpl: fetchImpl as never });

    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ route: "gemini-speaking-judge", provider: "gemini-http", outcome: "succeeded" });
    // The clips are named by path so a transcript can be replayed against the same recordings…
    expect(rows[0].prompt).toContain("[attached audio]");
    expect(rows[0].prompt).toContain(`lr-1: ${MP3}`);
    // …but their bytes stay on disk. The request that actually went out carries megabytes of
    // base64; a row that copied it would dwarf everything else in the database.
    const sentBody = (fetchImpl.mock.calls[0][1] as RequestInit).body as string;
    const inlineAudio = JSON.parse(sentBody).contents[0].parts.find((p: Record<string, unknown>) => "inline_data" in p);
    expect(inlineAudio.inline_data.data.length).toBeGreaterThan(0);
    expect(rows[0].prompt).not.toContain(inlineAudio.inline_data.data);
    expect(rows[0].prompt.length).toBeLessThan(sentBody.length);
  });
});

describe("judgeSpeaking (gemini)", () => {
  it("uses the injected fetchImpl instead of global fetch", async () => {
    const items = lrItems(1);
    const injectedFetch = vi
      .fn()
      .mockResolvedValue(
        geminiWrap(reportFor(items, "listen_repeat"))
      );
    const globalFetch = vi
      .fn()
      .mockRejectedValue(new Error("billable global fetch"));
    const originalFetch = globalThis.fetch;
    vi.stubGlobal("fetch", globalFetch);

    try {
      const result = await judgeSpeaking(
        "gemini",
        { taskType: "listen_repeat", items },
        { fetchImpl: injectedFetch as unknown as typeof fetch }
      );
      expect(result.provider).toBe("gemini-http");
      expect(injectedFetch).toHaveBeenCalledTimes(1);
      expect(globalFetch).not.toHaveBeenCalled();
    } finally {
      vi.stubGlobal("fetch", originalFetch);
    }
  });

  it("batches all 7 L&R items into ONE call with 7 inline_data audio/webm parts and parses the report", async () => {
    const items = lrItems(7);
    const f = vi.fn().mockResolvedValue(geminiWrap(reportFor(items, "listen_repeat")));
    const result = await judgeSpeaking("gemini", { taskType: "listen_repeat", items }, { fetchImpl: f as never });

    expect(f).toHaveBeenCalledTimes(1);
    expect(result.mode).toBe("audio");
    expect(result.provider).toBe("gemini-http");
    expect(result.report.items).toHaveLength(7);
    expect((f.mock.calls[0][0] as string)).toContain("generativelanguage.googleapis.com");

    const body = bodyOf(f);
    const parts = (body.contents as { parts: Array<{ text?: string; inline_data?: { mime_type: string; data: string } }> }[])[0].parts;
    const audioParts = parts.filter((p) => p.inline_data);
    expect(audioParts).toHaveLength(7);
    for (const p of audioParts) expect(p.inline_data!.mime_type).toBe("audio/webm");
    expect(audioParts[0].inline_data!.data).toBe(fs.readFileSync(WEBM).toString("base64"));
    expect(parts.some((p) => p.text === "Item lr-1 audio:")).toBe(true);
    expect((body.generationConfig as { responseMimeType: string }).responseMimeType).toBe("application/json");
  });

  it("uses audio/mpeg for an .mp3 audioPath (smoke-test path where only an mp3 exists)", async () => {
    const items = lrItems(1, MP3);
    const f = vi.fn().mockResolvedValue(geminiWrap(reportFor(items, "listen_repeat")));
    await judgeSpeaking("gemini", { taskType: "listen_repeat", items }, { fetchImpl: f as never });
    const body = bodyOf(f);
    const parts = (body.contents as { parts: Array<{ inline_data?: { mime_type: string; data: string } }> }[])[0].parts;
    const audioPart = parts.find((p) => p.inline_data)!;
    expect(audioPart.inline_data!.mime_type).toBe("audio/mpeg");
    expect(audioPart.inline_data!.data).toBe(fs.readFileSync(MP3).toString("base64"));
  });

  it("batches all 4 interview items into ONE call", async () => {
    const items = interviewItems(4);
    const f = vi.fn().mockResolvedValue(geminiWrap(reportFor(items, "interview")));
    const result = await judgeSpeaking("gemini", { taskType: "interview", items }, { fetchImpl: f as never });
    expect(f).toHaveBeenCalledTimes(1);
    expect(result.report.items).toHaveLength(4);
    const body = bodyOf(f);
    const parts = (body.contents as { parts: Array<{ inline_data?: unknown }> }[])[0].parts;
    expect(parts.filter((p) => p.inline_data)).toHaveLength(4);
  });

  it("stamps judge/taskType server-side, overriding whatever the model returned", async () => {
    const items = lrItems(1);
    const wrongPayload = { ...reportFor(items, "listen_repeat", "gemini"), judge: "openai", taskType: "interview" };
    const f = vi.fn().mockResolvedValue(geminiWrap(wrongPayload));
    const result = await judgeSpeaking("gemini", { taskType: "listen_repeat", items }, { fetchImpl: f as never });
    expect(result.report.judge).toBe("gemini");
    expect(result.report.taskType).toBe("listen_repeat");
  });

  it("repairs once on invalid JSON, resending the same audio, then succeeds", async () => {
    const items = lrItems(1);
    const f = vi.fn()
      .mockResolvedValueOnce(geminiWrap("not a report"))
      .mockResolvedValueOnce(geminiWrap(reportFor(items, "listen_repeat")));
    const result = await judgeSpeaking("gemini", { taskType: "listen_repeat", items }, { fetchImpl: f as never });
    expect(f).toHaveBeenCalledTimes(2);
    expect(result.mode).toBe("audio");
    const secondBody = bodyOf(f, 1);
    const parts = (secondBody.contents as { parts: Array<{ inline_data?: unknown }> }[])[0].parts;
    expect(parts.filter((p) => p.inline_data)).toHaveLength(1); // audio resent on repair
  });

  it("gives up after the one JSON repair retry", async () => {
    const items = lrItems(1);
    const f = vi.fn()
      .mockResolvedValueOnce(geminiWrap("still not a report"))
      .mockResolvedValueOnce(geminiWrap("still not a report"));
    await expect(judgeSpeaking("gemini", { taskType: "listen_repeat", items }, { fetchImpl: f as never })).rejects.toBeInstanceOf(JudgeError);
    expect(f).toHaveBeenCalledTimes(2);
  });

  it("retries 429 then succeeds; gives up on 400 without retrying", async () => {
    const items = lrItems(1);
    const clock1 = virtualDelay();
    const f1 = vi.fn()
      .mockResolvedValueOnce(new Response("slow down", { status: 429 }))
      .mockResolvedValueOnce(geminiWrap(reportFor(items, "listen_repeat")));
    await expect(judgeSpeaking("gemini", { taskType: "listen_repeat", items }, { fetchImpl: f1 as never, delay: clock1.delay })).resolves.toBeTruthy();
    expect(f1).toHaveBeenCalledTimes(2);
    expect(clock1.waits).toEqual([1000]);

    const clock2 = virtualDelay();
    const f2 = vi.fn().mockResolvedValue(new Response("bad request", { status: 400 }));
    await expect(judgeSpeaking("gemini", { taskType: "listen_repeat", items }, { fetchImpl: f2 as never, delay: clock2.delay })).rejects.toBeInstanceOf(JudgeError);
    expect(f2).toHaveBeenCalledTimes(1);
    expect(clock2.waits).toEqual([]);
  });
});

describe("judgeSpeaking (openai)", () => {
  it("sends input_audio parts (format mp3), modalities:['text'], and NO response_format key", async () => {
    const items = lrItems(7, MP3);
    const f = vi.fn().mockResolvedValue(openaiWrap(reportFor(items, "listen_repeat", "openai")));
    const runOpenAiText = vi.fn();
    const result = await judgeSpeaking("openai", { taskType: "listen_repeat", items }, {
      fetchImpl: f as never,
      runOpenAiText: runOpenAiText as never,
    });

    expect(f).toHaveBeenCalledTimes(1);
    expect(runOpenAiText).not.toHaveBeenCalled();
    expect(result.mode).toBe("audio");
    expect(result.provider).toBe("openai-http");
    expect(result.report.items).toHaveLength(7);

    const body = bodyOf(f);
    expect(body.modalities).toEqual(["text"]);
    expect(body).not.toHaveProperty("response_format");
    const content = body.messages as { role: string; content: Array<{ type: string; text?: string; input_audio?: { data: string; format: string } }> }[];
    const parts = content[0].content;
    const audioParts = parts.filter((p) => p.type === "input_audio");
    expect(audioParts).toHaveLength(7);
    for (const p of audioParts) expect(p.input_audio!.format).toBe("mp3");
    expect(audioParts[0].input_audio!.data).toBe(fs.readFileSync(MP3).toString("base64"));
    expect(parts.some((p) => p.type === "text" && p.text === "Item lr-1 audio:")).toBe(true);
  });

  it("batches all 4 interview items into ONE call", async () => {
    const items = interviewItems(4, MP3);
    const f = vi.fn().mockResolvedValue(openaiWrap(reportFor(items, "interview", "openai")));
    const result = await judgeSpeaking("openai", { taskType: "interview", items }, { fetchImpl: f as never });
    expect(f).toHaveBeenCalledTimes(1);
    expect(result.report.items).toHaveLength(4);
    const body = bodyOf(f);
    const content = body.messages as { content: Array<{ type: string }> }[];
    expect(content[0].content.filter((p) => p.type === "input_audio")).toHaveLength(4);
  });

  it("repairs once on invalid JSON, resending the same audio, then succeeds", async () => {
    const items = lrItems(1, MP3);
    const f = vi.fn()
      .mockResolvedValueOnce(openaiWrap("not a report"))
      .mockResolvedValueOnce(openaiWrap(reportFor(items, "listen_repeat", "openai")));
    const result = await judgeSpeaking("openai", { taskType: "listen_repeat", items }, { fetchImpl: f as never });
    expect(f).toHaveBeenCalledTimes(2);
    expect(result.mode).toBe("audio");
  });

  it("retries 429 then succeeds", async () => {
    const items = lrItems(1, MP3);
    const clock = virtualDelay();
    const f = vi.fn()
      .mockResolvedValueOnce(new Response("slow down", { status: 429 }))
      .mockResolvedValueOnce(openaiWrap(reportFor(items, "listen_repeat", "openai")));
    await expect(judgeSpeaking("openai", { taskType: "listen_repeat", items }, { fetchImpl: f as never, delay: clock.delay })).resolves.toBeTruthy();
    expect(f).toHaveBeenCalledTimes(2);
    expect(clock.waits).toEqual([1000]);
  });

  it("stamps judge/taskType server-side on the audio-success branch, overriding a wrong payload", async () => {
    const items = lrItems(1, MP3);
    const wrongPayload = { ...reportFor(items, "listen_repeat", "openai"), judge: "gemini", taskType: "interview" };
    const f = vi.fn().mockResolvedValue(openaiWrap(wrongPayload));
    const result = await judgeSpeaking("openai", { taskType: "listen_repeat", items }, { fetchImpl: f as never });
    expect(result.mode).toBe("audio");
    expect(result.report.judge).toBe("openai");
    expect(result.report.taskType).toBe("listen_repeat");
  });

  it("does not warn on the audio-success path", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      const items = lrItems(1, MP3);
      const f = vi.fn().mockResolvedValue(openaiWrap(reportFor(items, "listen_repeat", "openai")));
      await judgeSpeaking("openai", { taskType: "listen_repeat", items }, { fetchImpl: f as never });
      expect(warn).not.toHaveBeenCalled();
    } finally {
      warn.mockRestore();
    }
  });
});

describe("judgeSpeaking (openai text-fallback degradation)", () => {
  it("continues to call Codex after a genuine structural audio 400 and returns the text-fallback/codex route without fetching HTTP", async () => {
    const items = lrItems(2, MP3);
    const f = vi.fn().mockResolvedValueOnce(
      new Response("audio input is not supported for this model", {
        status: 400,
      })
    );
    const runCodex = vi.fn(async (options: {
      prompt: string;
      jsonSchema: object;
      parse: (value: unknown) => ReturnType<typeof reportFor>;
    }) => ({
      ok: true as const,
      provider: "codex" as const,
      value: options.parse(
        reportFor(items, "listen_repeat", "openai")
      ),
    }));

    const result = await judgeSpeaking(
      "openai",
      { taskType: "listen_repeat", items },
      {
        fetchImpl: f as never,
        runOpenAiText: routerBackedRunner(runCodex),
      }
    );

    expect(f).toHaveBeenCalledTimes(1);
    expect(runCodex).toHaveBeenCalledTimes(1);
    expect(result.mode).toBe("text-fallback");
    expect(result.provider).toBe("codex");
    expect(result.report.items).toHaveLength(2);
    expect(result.report.judge).toBe("openai");
    expect(result.report.taskType).toBe("listen_repeat");

    const firstBody = bodyOf(f, 0);
    const firstContent = firstBody.messages as { content: Array<{ type: string }> }[];
    expect(firstContent[0].content.some((p) => p.type === "input_audio")).toBe(true);

    const fallbackPromptText = runCodex.mock.calls[0][0].prompt;
    expect(fallbackPromptText).toContain(
      "No audio is available for this evaluation — score from the transcript and Delivery Report only."
    );
    expect(fallbackPromptText).not.toMatch(/PRIMARY evidence/);
    expect(fallbackPromptText).not.toMatch(/listen to the audio yourself/);
    expect(fallbackPromptText).not.toContain("input_audio");
    expect(fallbackPromptText).not.toContain(
      fs.readFileSync(MP3).toString("base64")
    );
    expect(runCodex.mock.calls[0][0].jsonSchema).toMatchObject({
      type: "object",
      properties: { items: expect.any(Object) },
    });
    expect(() =>
      runCodex.mock.calls[0][0].parse({ invalid: true })
    ).toThrow();
  });

  it.each([401, 403])(
    "does NOT enter Text Fallback for an audio/model authorization failure with HTTP %s",
    async (status) => {
      const items = lrItems(1, MP3);
      const fetchImpl = vi.fn().mockResolvedValue(
        new Response(
          `not authorized for requested audio model ${SECRET}`,
          { status }
        )
      );
      const runOpenAiText = vi.fn().mockResolvedValue({
        ok: true,
        value: reportFor(
          items,
          "listen_repeat",
          "openai"
        ),
        provider: "codex",
        attempts: [],
      });
      const warn = vi
        .spyOn(console, "warn")
        .mockImplementation(() => {});

      try {
        let error: unknown;
        try {
          await judgeSpeaking(
            "openai",
            { taskType: "listen_repeat", items },
            {
              fetchImpl: fetchImpl as never,
              runOpenAiText: runOpenAiText as never,
            }
          );
        } catch (caught) {
          error = caught;
        }

        expect(error).toBeInstanceOf(JudgeError);
        expect(String(error)).not.toContain(SECRET);
        expect(JSON.stringify(error)).not.toContain(SECRET);
        expect(fetchImpl).toHaveBeenCalledTimes(1);
        expect(runOpenAiText).not.toHaveBeenCalled();
        expect(warn).not.toHaveBeenCalled();
      } finally {
        warn.mockRestore();
      }
    }
  );

  // Only a refusal of the audio content enters Text Fallback. A 404 or 408 is not one whatever its
  // body says, and an error about the configured model's name is configuration even though an audio
  // model's name contains "audio".
  const modelErrors: ReadonlyArray<readonly [number, string]> = [
    [404, `The model \`${config.openaiAudioJudgeModel}\` does not exist or you do not have access to it.`],
    [408, "the model timed out waiting for the request"],
    [400, `Invalid value for 'model': '${config.openaiAudioJudgeModel}' is not a supported model.`],
  ];
  it.each(modelErrors)("does NOT enter Text Fallback on an HTTP %s whose body is about the model, not the audio", async (status, body) => {
    expect(config.openaiAudioJudgeModel).toMatch(/audio/);
    const items = lrItems(1, MP3);
    const f = vi.fn().mockImplementation(async () => new Response(body, { status }));
    const runOpenAiText = vi.fn();
    await expect(judgeSpeaking("openai", { taskType: "listen_repeat", items }, {
      fetchImpl: f as never,
      runOpenAiText: runOpenAiText as never,
    })).rejects.toBeInstanceOf(JudgeError);
    expect(f).toHaveBeenCalledTimes(1);
    expect(runOpenAiText).not.toHaveBeenCalled();
  });

  it.each([
    [400, JSON.stringify({ error: { message: "This model does not support audio input.", type: "invalid_request_error", param: "messages.[0].content.[1].input_audio", code: "invalid_value" } })],
    [415, "unsupported media type for input_audio"],
    [422, "the requested modalities cannot be produced from this input"],
  ] as const)("enters Text Fallback on an HTTP %s that refuses the audio input", async (status, body) => {
    const items = lrItems(1, MP3);
    const f = vi.fn().mockResolvedValueOnce(new Response(body, { status }));
    const runCodex = vi.fn(async (options: { parse: (value: unknown) => ReturnType<typeof reportFor> }) => ({
      ok: true as const,
      provider: "codex" as const,
      value: options.parse(reportFor(items, "listen_repeat", "openai")),
    }));
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      const result = await judgeSpeaking("openai", { taskType: "listen_repeat", items }, {
        fetchImpl: f as never,
        runOpenAiText: routerBackedRunner(runCodex),
      });
      expect(result.mode).toBe("text-fallback");
      expect(runCodex).toHaveBeenCalledTimes(1);
    } finally {
      warn.mockRestore();
    }
  });

  it("does NOT fall back on a 400 unrelated to audio/model (e.g. a generic bad request)", async () => {
    const items = lrItems(1, MP3);
    const f = vi.fn().mockResolvedValue(new Response("malformed request body", { status: 400 }));
    const runOpenAiText = vi.fn();
    await expect(judgeSpeaking("openai", { taskType: "listen_repeat", items }, {
      fetchImpl: f as never,
      runOpenAiText: runOpenAiText as never,
    })).rejects.toBeInstanceOf(JudgeError);
    expect(f).toHaveBeenCalledTimes(1); // no fallback attempt
    expect(runOpenAiText).not.toHaveBeenCalled();
  });

  it("does NOT fall back after exhausted 429 retries (that's exhaustion, not a structural audio failure)", async () => {
    const items = lrItems(1, MP3);
    // A fresh Response per call: withJudgeRetries reads .text() on every non-ok attempt, and a single
    // shared Response instance can only have its body read once.
    const f = vi.fn().mockImplementation(async () => new Response("slow down", { status: 429 }));
    const runOpenAiText = vi.fn();
    const clock = virtualDelay();
    await expect(judgeSpeaking("openai", { taskType: "listen_repeat", items }, {
      fetchImpl: f as never,
      runOpenAiText: runOpenAiText as never,
      delay: clock.delay,
    })).rejects.toBeInstanceOf(JudgeError);
    expect(f).toHaveBeenCalledTimes(3); // 2 retries + initial, all on the audio call, no fallback
    expect(clock.waits).toEqual([1000, 4000]);
    expect(runOpenAiText).not.toHaveBeenCalled();
  });

  it("does NOT fall back after exhausted 5xx retries", async () => {
    const items = lrItems(1, MP3);
    const f = vi.fn().mockImplementation(
      async () =>
        new Response("temporary provider failure", {
          status: 503,
        })
    );
    const runOpenAiText = vi.fn();
    const clock = virtualDelay();

    await expect(
      judgeSpeaking(
        "openai",
        { taskType: "listen_repeat", items },
        {
          fetchImpl: f as never,
          runOpenAiText: runOpenAiText as never,
          delay: clock.delay,
        }
      )
    ).rejects.toBeInstanceOf(JudgeError);

    expect(f).toHaveBeenCalledTimes(3);
    expect(clock.waits).toEqual([1000, 4000]);
    expect(runOpenAiText).not.toHaveBeenCalled();
  });

  it("falls back from Codex invalid output to the same HTTP text call with one JSON repair", async () => {
    const items = lrItems(1, MP3);
    const f = vi.fn()
      .mockResolvedValueOnce(new Response("model rejected audio content", { status: 400 })) // audio call fails
      .mockResolvedValueOnce(openaiWrap("not a report")) // fallback attempt 1: invalid
      .mockResolvedValueOnce(openaiWrap(reportFor(items, "listen_repeat", "openai"))); // fallback attempt 2: valid
    const runCodex = vi
      .fn()
      .mockResolvedValue(codexFailure("invalid-output"));
    const result = await judgeSpeaking("openai", { taskType: "listen_repeat", items }, {
      fetchImpl: f as never,
      runOpenAiText: routerBackedRunner(runCodex),
    });
    expect(f).toHaveBeenCalledTimes(3);
    expect(result.mode).toBe("text-fallback");
    expect(result.provider).toBe("openai-http");

    const fallbackBody = bodyOf(f, 1);
    expect(fallbackBody.messages).toEqual([
      { role: "user", content: expect.any(String) },
    ]);
    expect(
      (fallbackBody.messages as { content: string }[])[0].content
    ).not.toContain("input_audio");
    expect(fallbackBody.response_format).toEqual({
      type: "json_object",
    });
    expect(
      (bodyOf(f, 2).messages as { content: string }[])[0].content
    ).toMatch(/previous output was invalid/);
  });

  it("falls back after a Codex circuit/quota failure and stamps the report domain as OpenAI", async () => {
    const items = lrItems(1, MP3);
    const wrongPayload = {
      ...reportFor(items, "listen_repeat", "openai"),
      judge: "gemini",
      taskType: "interview",
    };
    const f = vi.fn()
      .mockResolvedValueOnce(new Response("audio input is not supported for this model", { status: 400 }))
      .mockResolvedValueOnce(openaiWrap(wrongPayload));
    const providerState = createProviderState();
    providerState.recordPreflight("codex", {
      ok: false,
      kind: "quota",
    });
    const runCodex = vi.fn();
    const result = await judgeSpeaking("openai", { taskType: "listen_repeat", items }, {
      fetchImpl: f as never,
      runOpenAiText: routerBackedRunner(
        runCodex,
        providerState
      ),
    });
    expect(result.mode).toBe("text-fallback");
    expect(result.provider).toBe("openai-http");
    expect(result.report.judge).toBe("openai");
    expect(result.report.taskType).toBe("listen_repeat");
    expect(runCodex).not.toHaveBeenCalled();
  });

  it("keeps the structural fallback warning observable but strips raw provider diagnostics", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      const items = lrItems(1, MP3);
      const f = vi.fn()
        .mockResolvedValueOnce(
          new Response(
            `The model does not exist (audio). ${SECRET}`,
            { status: 400 }
          )
        );
      const runCodex = vi.fn(async (options: {
        parse: (value: unknown) => ReturnType<typeof reportFor>;
      }) => ({
        ok: true as const,
        provider: "codex" as const,
        value: options.parse(
          reportFor(items, "listen_repeat", "openai")
        ),
      }));
      const result = await judgeSpeaking("openai", { taskType: "listen_repeat", items }, {
        fetchImpl: f as never,
        runOpenAiText: routerBackedRunner(runCodex),
      });
      expect(result.mode).toBe("text-fallback");
      expect(warn).toHaveBeenCalledTimes(1);
      const [message, detail] = warn.mock.calls[0];
      expect(String(message)).toMatch(/degraded to text-fallback/);
      expect(detail).toEqual({ status: 400 });
      expect(JSON.stringify(warn.mock.calls)).not.toContain(SECRET);
    } finally {
      warn.mockRestore();
    }
  });

  it("sanitizes terminal Codex+HTTP text-route failures", async () => {
    const items = lrItems(1, MP3);
    const f = vi
      .fn()
      .mockResolvedValueOnce(
        new Response("audio unsupported by this model", {
          status: 400,
        })
      )
      .mockResolvedValueOnce(
        new Response(SECRET, { status: 401 })
      );
    const runCodex = vi
      .fn()
      .mockResolvedValue(codexFailure("invalid-output"));

    let error: unknown;
    try {
      await judgeSpeaking("openai", { taskType: "listen_repeat", items }, {
        fetchImpl: f as never,
        runOpenAiText: routerBackedRunner(runCodex),
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
  });
});
