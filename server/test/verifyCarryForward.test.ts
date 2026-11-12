import { describe, expect, it } from "vitest";
import {
  runVerifyLoop,
  VerifyRemediation,
  type VerifyPolicy,
} from "../src/services/generationVerifyLoop.js";
import { verifyListeningSet } from "../src/services/listeningGenerator.js";
import { verifyReadingSet } from "../src/services/readingGenerator.js";
import { positionReferenceInstruction } from "../src/services/optionQuality.js";
import type { SkillTaskRunner } from "../src/services/generationReasoning.js";
import type { SkillTaskRequest } from "../src/services/reasoning/router.js";
import {
  allOkReadingVerdict,
  assembledReadingSet,
  fence,
  readingVerifyPayload,
  routed,
} from "./helpers/readingVerifyFixture.js";
import {
  allOkListeningVerdict,
  listeningSetForVerify,
  listeningVerifyPayload,
} from "./helpers/listeningGenerationFixture.js";

// A pass stands until the content it was about changes. The Verifier is not consistent with itself
// across calls on unchanged content, so judging an Item it already passed again can flag it in the
// final round and fail the job over content no round touched.

// A stand-in policy for the loop: two units, and a gate finding that one wholesale remediation of
// unit b clears.
type UnitSet = { readonly content: Readonly<Record<string, string>>; readonly gateClean: boolean };
type Gate = { readonly kind: "fixable"; readonly id: string };
type Verdict = { readonly passed: readonly string[] };

function standInPolicy(sent: string[][]): VerifyPolicy<UnitSet, Gate, Verdict, string> {
  return {
    logPrefix: "[standIn]",
    diagnostic: (text) => text,
    preflight: () => {},
    violations: (set) => (set.gateClean ? [] : [{ kind: "fixable", id: "b" }]),
    isBlocking: () => false,
    isAdvisory: () => false,
    isDegradable: () => false,
    formatViolations: (violations) => violations.map((v) => v.id).join(","),
    describeGateFailure: () => "gate failed",
    units: (set) => new Map(Object.entries(set.content)),
    emptyVerdict: { passed: [] },
    verify: (_set, pending) => {
      sent.push([...pending].sort());
      return {
        task: { task: "verify", context: "reading" },
        prompt: [...pending].join(","),
        jsonSchema: {},
        parse: () => ({ passed: [...pending] }),
      };
    },
    planRound: ({ verdict, violations }) => ({
      verdictFindings: 0,
      passed: verdict.passed,
      remediations: [[
        VerifyRemediation.declare({
          category: "fix b",
          pass: "wholesale",
          targets: new Map(violations.map((v) => [v.id, true] as const)),
          apply: async (set) => ({ content: { ...set.content, b: "b-fixed" }, gateClean: true }),
        }),
      ]],
      exhaustionParts: [],
    }),
    describeExhaustion: () => "exhausted",
    finish: (set) => set,
  };
}

const passThroughRun = (async (request: SkillTaskRequest<unknown>) => ({
  ok: true as const,
  value: request.parse(undefined),
  provider: "claude" as const,
  attempts: [],
})) as SkillTaskRunner;

describe("runVerifyLoop — carrying passes forward", () => {
  it("re-sends only the unit whose content changed since it passed", async () => {
    const sent: string[][] = [];
    await runVerifyLoop({
      set: { content: { a: "a", b: "b" }, gateClean: false },
      policy: standInPolicy(sent),
      run: passThroughRun,
      onProgress: undefined,
      setId: "fake",
    });
    expect(sent).toEqual([["a", "b"], ["b"]]);
  });

  it("makes no verify call in a round where every unit has already passed at its current content", async () => {
    const sent: string[][] = [];
    const policy = standInPolicy(sent);
    await runVerifyLoop({
      set: { content: { a: "a" }, gateClean: false },
      policy: {
        ...policy,
        // The remediation fixes the gate without touching any unit the Verifier judges.
        planRound: (round) => ({
          ...policy.planRound(round),
          remediations: [[
            VerifyRemediation.declare({
              category: "fix gate",
              pass: "wholesale",
              targets: new Map(round.violations.map((v) => [v.id, true] as const)),
              apply: async (set) => ({ ...set, gateClean: true }),
            }),
          ]],
        }),
      },
      run: passThroughRun,
      onProgress: undefined,
      setId: "fake",
    });
    expect(sent).toEqual([["a"]]);
  });
});

const OVERLONG_ZH = "解析".repeat(110);

describe("verify:listening — an Item a round passed is not judged again", () => {
  it("publishes when the Verifier would flag a passed, unchanged Item on a later round", async () => {
    const set = listeningSetForVerify();
    // A gate finding that takes one repair round, so the loop runs a second verify round.
    set.router.listenChoose[0]!.explanationZh = OVERLONG_ZH;
    const sentLcr: string[][] = [];
    const run = (async (request: SkillTaskRequest<unknown>) => {
      if (request.task.task === "generate") {
        const payload = fence(request.prompt, "explanation-rewrite") as { flagged: { id: string }[] };
        return routed(request, {
          explanations: payload.flagged.map(({ id }) => ({ id, explanationZh: `題目 ${id}:正解說明錄音提到請求關門。` })),
        });
      }
      const payload = listeningVerifyPayload(request.prompt);
      sentLcr.push(payload.listenChooseItems.map((item) => item.id));
      const verdict = allOkListeningVerdict(request.prompt);
      // From the second call on, the Verifier changes its mind about lcr-r6 — content it passed.
      if (sentLcr.length > 1) {
        verdict.listenChooseItems = verdict.listenChooseItems.map((item) =>
          item.id === "lcr-r6" ? { id: item.id, verdict: "issue" as never, reason: "generic acknowledgment" } as never : item
        );
      }
      return routed(request, verdict);
    }) as SkillTaskRunner;

    const published = await verifyListeningSet(set, run, undefined, set.id);
    expect(published.router.listenChoose[0]!.explanationZh).not.toBe(OVERLONG_ZH);
    expect(sentLcr[0]!.length).toBe(20);
    expect(sentLcr.slice(1)).toEqual([["lcr-r1"]]);
  });
});

// The "quality" verdict (correctly keyed but weak) buys one regeneration, then an advisory note.
describe("verify:reading — a weak but correctly keyed MCQ", () => {
  it("is regenerated once, then published with a note when the Verifier still calls it weak", async () => {
    const set = await assembledReadingSet();
    const regenerated: string[] = [];
    const run = (async (request: SkillTaskRequest<unknown>) => {
      if (request.task.task === "generate") {
        const payload = fence(request.prompt, "mcq-regeneration") as { flaggedQuestions: { id: string; stem: string }[] };
        regenerated.push(...payload.flaggedQuestions.map((q) => q.id));
        expect(request.prompt).toContain(positionReferenceInstruction());
        return routed(request, {
          questions: payload.flaggedQuestions.map((q) => ({ ...q, stem: `${q.stem} (rewritten)` })),
        });
      }
      const verdict = allOkReadingVerdict(request.prompt);
      return routed(request, {
        ...verdict,
        mcqItems: verdict.mcqItems.map((item) =>
          item.id === "dl-r1-q1" ? { id: item.id, verdict: "quality", reason: "distractor C is obviously wrong" } : item
        ),
      });
    }) as SkillTaskRunner;

    const published = await verifyReadingSet(set, run, undefined, set.id);
    expect(regenerated).toEqual(["dl-r1-q1"]);
    expect(published.router.dailyLife[0]!.questions[0]!.stem).toContain("(rewritten)");
    expect(published.advisoryNotes).toContainEqual({ check: "content-gate", detail: "item-quality", taskType: "daily_life" });
  });

  it("keeps a wrong key fatal: an \"issue\" still unresolved after every round fails the job", async () => {
    const set = await assembledReadingSet();
    const run = (async (request: SkillTaskRequest<unknown>) => {
      if (request.task.task === "generate") {
        const payload = fence(request.prompt, "mcq-regeneration") as { flaggedQuestions: { id: string; stem: string }[] };
        return routed(request, { questions: payload.flaggedQuestions.map((q, i) => ({ ...q, stem: `${q.stem} v${i}${Math.random()}` })) });
      }
      const verdict = allOkReadingVerdict(request.prompt);
      return routed(request, {
        ...verdict,
        mcqItems: verdict.mcqItems.map((item) =>
          item.id === "dl-r1-q1" ? { id: item.id, verdict: "issue", reason: "the key is wrong" } : item
        ),
      });
    }) as SkillTaskRunner;
    await expect(verifyReadingSet(set, run, undefined, set.id)).rejects.toThrow(/dl-r1-q1/);
  });

  it("sends only the regenerated question, and its text, to the next round", async () => {
    const set = await assembledReadingSet();
    const payloads: ReturnType<typeof readingVerifyPayload>[] = [];
    const run = (async (request: SkillTaskRequest<unknown>) => {
      if (request.task.task === "generate") {
        const payload = fence(request.prompt, "mcq-regeneration") as { flaggedQuestions: { id: string; stem: string }[] };
        return routed(request, { questions: payload.flaggedQuestions.map((q) => ({ ...q, stem: `${q.stem} (rewritten)` })) });
      }
      payloads.push(readingVerifyPayload(request.prompt));
      const verdict = allOkReadingVerdict(request.prompt);
      if (payloads.length > 1) return routed(request, verdict);
      return routed(request, {
        ...verdict,
        mcqItems: verdict.mcqItems.map((item) =>
          item.id === "ap-r1-q2" ? { id: item.id, verdict: "issue", reason: "two options are defensible" } : item
        ),
      });
    }) as SkillTaskRunner;
    await verifyReadingSet(set, run, undefined, set.id);
    expect(payloads).toHaveLength(2);
    expect(payloads[1]!.ctwPassages).toEqual([]);
    expect(payloads[1]!.mcqItems.map((item) => item.id)).toEqual(["ap-r1-q2"]);
    expect(payloads[1]!.stimuli!.map((stimulus) => stimulus.id)).toEqual(["ap-r1"]);
  });
});

describe("verify:listening — a weak but correctly keyed Listen-and-Choose item", () => {
  it("is regenerated once, then published with a note", async () => {
    const set = listeningSetForVerify();
    const regenerated: string[] = [];
    const run = (async (request: SkillTaskRequest<unknown>) => {
      if (request.task.task === "generate") {
        const payload = fence(request.prompt, "lcr-regeneration") as { items: { id: string; utterance: string }[] };
        regenerated.push(...payload.items.map((item) => item.id));
        expect(request.prompt).toContain(positionReferenceInstruction());
        return routed(request, {
          items: payload.items.map(({ id }) => ({
            id, utterance: "Could you shut the window please",
            options: [
              { id: "a", text: "Sure, right away." }, { id: "b", text: "It opens at nine." },
              { id: "c", text: "I had lunch already." }, { id: "d", text: "That was a great film." },
            ],
            correctOptionId: "a", skill: "function", explanationZh: `題目 ${id}:正解回應關窗請求。`,
          })),
        });
      }
      const verdict = allOkListeningVerdict(request.prompt);
      return routed(request, {
        ...verdict,
        listenChooseItems: verdict.listenChooseItems.map((item) =>
          item.id === "lcr-r2" ? { id: item.id, verdict: "quality", reason: "answerable by social script" } : item
        ),
      });
    }) as SkillTaskRunner;

    const published = await verifyListeningSet(set, run, undefined, set.id);
    expect(regenerated).toEqual(["lcr-r2"]);
    expect(published.advisoryNotes).toContainEqual({ check: "content-gate", detail: "item-quality", taskType: "listen_choose" });
  });
});
