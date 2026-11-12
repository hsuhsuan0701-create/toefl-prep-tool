import fs from "node:fs";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { config } from "../src/lib/config.js";
import {
  addReason,
  runVerifyLoop,
  GenerationVerifyExhaustedError,
  MAX_VERIFY_ATTEMPTS,
  VerifyRemediation,
  type RemediationSpec,
  type VerifyPolicy,
} from "../src/services/generationVerifyLoop.js";
import type { SkillTaskRunner } from "../src/services/generationReasoning.js";

// The verify loop's own invariants, shared by Reading and Listening and exercised here against a
// stand-in policy: the round budget, the remediation guard and its failure ledger, the
// explanations-first dispatch order, the wholesale-this-round exclusion, and the shape of the
// endings. The two section suites keep only what a section decides: which violation routes to which
// remediation, at which grain, with which prompt.

type FakeSet = { readonly marks: readonly string[] };
type FakeViolation = { readonly kind: string; readonly id: string };
type FakeVerdict = { readonly findings: number };

const CLEAN: FakeVerdict = { findings: 0 };

type Harness = {
  readonly policy: VerifyPolicy<FakeSet, FakeViolation, FakeVerdict, string>;
  /** Every remediation `apply` the loop actually issued, in dispatch order, with its admitted ids. */
  readonly issued: { category: string; ids: string[] }[];
  readonly prompts: string[];
  readonly finished: FakeSet[];
  /** What the loop told the policy about each round, in order. */
  readonly rounds: { attempt: number; isFinalRound: boolean }[];
};

function buildHarness(input: {
  /** Per round (1-based); the last entry repeats once the list runs out. */
  violations?: readonly (readonly FakeViolation[])[];
  verdicts?: readonly FakeVerdict[];
  blocking?: readonly string[];
  advisory?: readonly string[];
  degradable?: readonly string[];
  exhaustionParts?: readonly string[];
  remediations?: (
    round: { attempt: number; set: FakeSet; issued: { category: string; ids: string[] }[] },
  ) => readonly (readonly VerifyRemediation<FakeSet>[])[];
}): Harness {
  const issued: { category: string; ids: string[] }[] = [];
  const prompts: string[] = [];
  const finished: FakeSet[] = [];
  const rounds: { attempt: number; isFinalRound: boolean }[] = [];
  const at = <T>(list: readonly T[] | undefined, attempt: number, fallback: T): T => {
    if (!list || list.length === 0) return fallback;
    return list[Math.min(attempt, list.length) - 1]!;
  };
  let attempt = 0;
  const policy: VerifyPolicy<FakeSet, FakeViolation, FakeVerdict, string> = {
    logPrefix: "[fakeGenerator]",
    diagnostic: (text) => text,
    preflight: () => {},
    violations: () => {
      attempt += 1;
      return at(input.violations, attempt, []);
    },
    isBlocking: (violation) => (input.blocking ?? []).includes(violation.kind),
    isAdvisory: (violation) => (input.advisory ?? []).includes(violation.kind),
    isDegradable: (violation) =>
      (input.advisory ?? []).includes(violation.kind) || (input.degradable ?? []).includes(violation.kind),
    formatViolations: (violations) => violations.map((v) => `${v.kind}:${v.id}`).join(", "),
    describeGateFailure: (violations) => `gate failed with ${violations.length}`,
    // One unit that never passes, so every round sends a verify call. The carry-forward of passed
    // units is exercised in verifyCarryForward.test.ts.
    units: () => new Map([["unit", "content"]]),
    emptyVerdict: CLEAN,
    verify: () => ({
      task: { task: "verify", context: "reading" },
      prompt: `verify round ${attempt}`,
      jsonSchema: {},
      parse: () => at(input.verdicts, attempt, CLEAN),
    }),
    planRound: (round) => {
      rounds.push({ attempt: round.attempt, isFinalRound: round.isFinalRound });
      return {
        verdictFindings: round.verdict.findings,
        passed: [],
        remediations: input.remediations?.({ attempt: round.attempt, set: round.set, issued }) ?? [],
        exhaustionParts: input.exhaustionParts ?? [],
      };
    },
    describeExhaustion: ({ parts }) => `exhausted after ${MAX_VERIFY_ATTEMPTS}: ${parts.join(" | ")}`,
    finish: (set) => {
      finished.push(set);
      return { marks: [...set.marks, "finished"] };
    },
  };
  const wrappedPrompt = policy.verify;
  return {
    policy: {
      ...policy,
      verify: (set, pending) => {
        const request = wrappedPrompt(set, pending);
        prompts.push(request.prompt);
        return request;
      },
    },
    issued,
    prompts,
    finished,
    rounds,
  };
}

/** Records the ids one remediation was actually handed. The loop is the only thing that can call it. */
function recorder(
  issued: { category: string; ids: string[] }[],
  category: string,
  spec: Omit<RemediationSpec<FakeSet, true>, "category" | "apply"> & {
    readonly onApply?: (set: FakeSet) => Promise<FakeSet>;
  },
): VerifyRemediation<FakeSet> {
  return VerifyRemediation.declare<FakeSet, true>({
    category,
    pass: spec.pass,
    targets: spec.targets,
    scope: spec.scope,
    claims: spec.claims,
    apply: async (set, targets) => {
      issued.push({ category, ids: [...targets.keys()] });
      if (spec.onApply) return spec.onApply(set);
      return { marks: [...set.marks, category] };
    },
  });
}

const targetsOf = (...ids: readonly string[]): ReadonlyMap<string, true> =>
  new Map(ids.map((id) => [id, true as const]));

let verifyCalls = 0;
const fakeRun: SkillTaskRunner = (async (request: { parse: (value: unknown) => unknown }) => {
  verifyCalls += 1;
  return { ok: true as const, value: request.parse({}), provider: "claude" as const, attempts: [] };
}) as unknown as SkillTaskRunner;

/** The loop's throw, typed — `.catch()` alone widens it with the resolved Set. */
async function rejection(promise: Promise<unknown>): Promise<GenerationVerifyExhaustedError> {
  try {
    await promise;
  } catch (error) {
    return error as GenerationVerifyExhaustedError;
  }
  throw new Error("expected runVerifyLoop to throw");
}

function runLoop(harness: Harness): Promise<FakeSet> {
  return runVerifyLoop({
    set: { marks: [] },
    policy: harness.policy,
    run: fakeRun,
    onProgress: undefined,
    setId: "fake-1",
  });
}

beforeEach(() => {
  verifyCalls = 0;
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("the round budget", () => {
  it("publishes on the first round when nothing is outstanding, spending exactly one verify call", async () => {
    const harness = buildHarness({});
    await expect(runLoop(harness)).resolves.toEqual({ marks: ["finished"] });
    expect(verifyCalls).toBe(1);
    expect(harness.finished).toHaveLength(1);
  });

  it(`spends exactly MAX_VERIFY_ATTEMPTS (${MAX_VERIFY_ATTEMPTS}) verify calls before throwing, never more`, async () => {
    const harness = buildHarness({ verdicts: [{ findings: 1 }] });
    await expect(runLoop(harness)).rejects.toBeInstanceOf(GenerationVerifyExhaustedError);
    expect(verifyCalls).toBe(MAX_VERIFY_ATTEMPTS);
    expect(harness.prompts).toHaveLength(MAX_VERIFY_ATTEMPTS);
  });

  it("stops the moment a round comes back clean, leaving the rest of the budget unspent", async () => {
    const harness = buildHarness({ verdicts: [{ findings: 1 }, { findings: 1 }, CLEAN] });
    await expect(runLoop(harness)).resolves.toEqual({ marks: ["finished"] });
    expect(verifyCalls).toBe(3);
  });

  // A policy whose tier changes on the last round (Listening's Academic Talk `register` verdict:
  // counted while repair rounds remain, recorded as an advisory note on the last one) has to know
  // which round that is. The loop hands it `isFinalRound` rather than leaving the policy to rebuild
  // the loop's bounds from MAX_VERIFY_ATTEMPTS, so a change to the budget or the ending cannot turn
  // "publishes with a note" into "fails a fully paid job".
  it("tells the policy which round is the final one, rather than leaving it to be reconstructed", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => {});
    const harness = buildHarness({
      violations: [[{ kind: "slow", id: "a" }]],
      degradable: ["slow"],
    });
    await expect(runLoop(harness)).resolves.toEqual({ marks: ["finished"] });
    expect(harness.rounds).toEqual(
      Array.from({ length: MAX_VERIFY_ATTEMPTS }, (_, index) => ({
        attempt: index + 1,
        isFinalRound: index + 1 === MAX_VERIFY_ATTEMPTS,
      })),
    );
    // And it is the same round the loop decides the ending on: the degraded publish happens on the
    // one round it flagged.
    expect(harness.finished).toHaveLength(1);
    expect(verifyCalls).toBe(MAX_VERIFY_ATTEMPTS);
  });

  it("issues no remediation at all on the final round — the budget is spent, so a repair has nowhere to land", async () => {
    const harness = buildHarness({
      verdicts: [{ findings: 1 }],
      remediations: ({ issued }) => [[recorder(issued, "repair", { pass: "wholesale", targets: targetsOf("a") })]],
    });
    await expect(runLoop(harness)).rejects.toBeInstanceOf(GenerationVerifyExhaustedError);
    expect(harness.issued.map((entry) => entry.category)).toEqual(
      Array.from({ length: MAX_VERIFY_ATTEMPTS - 1 }, () => "repair"),
    );
  });
});

describe("the remediation guard", () => {
  it("catches a broken remediation, leaves the Set unchanged for that category, and goes another round", async () => {
    const errored = vi.spyOn(console, "error").mockImplementation(() => {});
    const harness = buildHarness({
      verdicts: [{ findings: 1 }, { findings: 1 }, CLEAN],
      remediations: ({ attempt, issued }) => [[
        recorder(issued, "flaky", {
          pass: "wholesale",
          targets: targetsOf("a"),
          onApply: async (set) => {
            if (attempt === 1) throw new TypeError("a zod message that must never be logged");
            return { marks: [...set.marks, "flaky"] };
          },
        }),
      ]],
    });
    // Round 1's remediation threw, so its mark is absent; round 2's landed; round 3 was clean.
    await expect(runLoop(harness)).resolves.toEqual({ marks: ["flaky", "finished"] });
    expect(errored).toHaveBeenCalledWith(
      `[fakeGenerator] verify attempt 1/${MAX_VERIFY_ATTEMPTS}: flaky (TypeError) remediation failed, will retry next round`,
    );
  });

  it("names the error CLASS and never its message — a remediation's failure surface quotes Set content", async () => {
    const errored = vi.spyOn(console, "error").mockImplementation(() => {});
    const harness = buildHarness({
      verdicts: [{ findings: 1 }],
      remediations: ({ issued }) => [[
        recorder(issued, "flaky", {
          pass: "wholesale",
          targets: targetsOf("a"),
          onApply: async () => {
            throw new RangeError("LEAK_TOKEN: the passage said 機密");
          },
        }),
      ]],
    });
    const error = await rejection(runLoop(harness));
    expect(error).toBeInstanceOf(GenerationVerifyExhaustedError);
    expect(error.message).toContain(`remediation failures: flaky (RangeError) x${MAX_VERIFY_ATTEMPTS - 1}`);
    expect(error.message).not.toContain("LEAK_TOKEN");
    for (const call of errored.mock.calls) expect(String(call[0])).not.toContain("LEAK_TOKEN");
  });

  it("counts every failing category separately across rounds, and names each in the thrown message", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    const harness = buildHarness({
      verdicts: [{ findings: 1 }],
      remediations: ({ attempt, issued }) => [[
        recorder(issued, "always", {
          pass: "wholesale",
          targets: targetsOf("a"),
          onApply: async () => {
            throw new Error("nope");
          },
        }),
        recorder(issued, "sometimes", {
          pass: "wholesale",
          targets: targetsOf("b"),
          onApply: async (set) => {
            if (attempt === 1) throw new TypeError("nope");
            return set;
          },
        }),
      ]],
    });
    const error = await rejection(runLoop(harness));
    expect(error.message).toContain(
      `remediation failures: always (Error) x${MAX_VERIFY_ATTEMPTS - 1}, sometimes (TypeError) x1`,
    );
  });

  it("has no way to issue a remediation outside the guard: a thrown apply never escapes the loop", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    const harness = buildHarness({
      verdicts: [{ findings: 1 }, CLEAN],
      remediations: ({ issued }) => [[
        recorder(issued, "explodes", {
          pass: "wholesale",
          targets: targetsOf("a"),
          onApply: async () => {
            throw new Error("boom");
          },
        }),
      ]],
    });
    // Not a rejection with "boom": the guard swallowed it and the next round published.
    await expect(runLoop(harness)).resolves.toEqual({ marks: ["finished"] });
  });
});

describe("the explanations-first dispatch order", () => {
  it("runs every explanation remediation before every wholesale one, whatever order they were declared in", async () => {
    const harness = buildHarness({
      verdicts: [{ findings: 1 }, CLEAN],
      remediations: ({ issued }) => [
        // Declared wholesale-first, because claim order is coarsest-first — dispatch must not follow it.
        [
          recorder(issued, "wholesale-1", { pass: "wholesale", targets: targetsOf("w1") }),
          recorder(issued, "wholesale-2", { pass: "wholesale", targets: targetsOf("w2") }),
        ],
        [recorder(issued, "explanation-1", { pass: "explanation", targets: targetsOf("e1") })],
        [recorder(issued, "explanation-2", { pass: "explanation", targets: targetsOf("e2") })],
      ],
    });
    await runLoop(harness);
    expect(harness.issued.map((entry) => entry.category)).toEqual([
      "explanation-1",
      "explanation-2",
      "wholesale-1",
      "wholesale-2",
    ]);
  });

  it("keeps each pass in the order its own section declared it", async () => {
    const harness = buildHarness({
      verdicts: [{ findings: 1 }, CLEAN],
      remediations: ({ issued }) => [[
        recorder(issued, "second", { pass: "explanation", targets: targetsOf("b") }),
        recorder(issued, "first", { pass: "explanation", targets: targetsOf("a") }),
      ]],
    });
    await runLoop(harness);
    expect(harness.issued.map((entry) => entry.category)).toEqual(["second", "first"]);
  });
});

describe("the wholesale-this-round exclusion", () => {
  it("never hands a later wave an id an earlier wave already claimed", async () => {
    const harness = buildHarness({
      verdicts: [{ findings: 1 }, CLEAN],
      remediations: ({ issued }) => [
        [recorder(issued, "wholesale", { pass: "wholesale", targets: targetsOf("shared", "w-only") })],
        [recorder(issued, "explanation", { pass: "explanation", targets: targetsOf("shared", "e-only") })],
      ],
    });
    await runLoop(harness);
    expect(harness.issued).toEqual([
      { category: "explanation", ids: ["e-only"] },
      { category: "wholesale", ids: ["shared", "w-only"] },
    ]);
  });

  it("does not issue a remediation whose every target was claimed — no call, and nothing in the ledger", async () => {
    const harness = buildHarness({
      verdicts: [{ findings: 1 }, CLEAN],
      remediations: ({ issued }) => [
        [recorder(issued, "wholesale", { pass: "wholesale", targets: targetsOf("shared") })],
        [recorder(issued, "explanation", { pass: "explanation", targets: targetsOf("shared") })],
      ],
    });
    await runLoop(harness);
    expect(harness.issued.map((entry) => entry.category)).toEqual(["wholesale"]);
  });

  it("lets two remediations in the SAME wave both touch an id: a wave is how a section says they may", async () => {
    const harness = buildHarness({
      verdicts: [{ findings: 1 }, CLEAN],
      remediations: ({ issued }) => [[
        recorder(issued, "left", { pass: "wholesale", targets: targetsOf("shared") }),
        recorder(issued, "right", { pass: "wholesale", targets: targetsOf("shared") }),
      ]],
    });
    await runLoop(harness);
    expect(harness.issued).toEqual([
      { category: "left", ids: ["shared"] },
      { category: "right", ids: ["shared"] },
    ]);
  });

  it("excludes at the declared SCOPE, not only at the target's own id (Reading's gap-inside-a-passage case)", async () => {
    const harness = buildHarness({
      verdicts: [{ findings: 1 }, CLEAN],
      remediations: ({ issued }) => [
        [recorder(issued, "passage", { pass: "wholesale", targets: targetsOf("p1") })],
        [recorder(issued, "gap-explanation", {
          pass: "explanation",
          targets: targetsOf("p1-g1", "p2-g1"),
          scope: (gapId) => gapId.split("-g")[0]!,
        })],
      ],
    });
    await runLoop(harness);
    expect(harness.issued).toEqual([
      { category: "gap-explanation", ids: ["p2-g1"] },
      { category: "passage", ids: ["p1"] },
    ]);
  });

  it("honours a claim that EXPANDS past the target's own id (Listening's Stimulus-owns-its-questions case)", async () => {
    const harness = buildHarness({
      verdicts: [{ findings: 1 }, CLEAN],
      remediations: ({ issued }) => [
        [recorder(issued, "stimulus", {
          pass: "wholesale",
          targets: targetsOf("conv-1"),
          claims: (stimulusId) => [stimulusId, `${stimulusId}-q1`, `${stimulusId}-q2`],
        })],
        [recorder(issued, "question", { pass: "wholesale", targets: targetsOf("conv-1-q1", "conv-2-q1") })],
      ],
    });
    await runLoop(harness);
    expect(harness.issued).toEqual([
      { category: "stimulus", ids: ["conv-1"] },
      { category: "question", ids: ["conv-2-q1"] },
    ]);
  });

  it("re-derives the exclusion every round rather than carrying it across: a deferred id is picked up next round", async () => {
    const harness = buildHarness({
      verdicts: [{ findings: 1 }, { findings: 1 }, CLEAN],
      remediations: ({ attempt, issued }) => [
        [recorder(issued, "wholesale", {
          pass: "wholesale",
          targets: attempt === 1 ? targetsOf("shared") : targetsOf(),
        })],
        [recorder(issued, "explanation", { pass: "explanation", targets: targetsOf("shared") })],
      ],
    });
    await runLoop(harness);
    expect(harness.issued).toEqual([
      { category: "wholesale", ids: ["shared"] },
      { category: "explanation", ids: ["shared"] },
    ]);
  });
});

describe("the deterministic gate", () => {
  it("hard-fails before any verify call when a blocking kind is present, with the policy's own message", async () => {
    const harness = buildHarness({
      violations: [[{ kind: "composition", id: "router" }, { kind: "explanation-length", id: "q1" }]],
      blocking: ["composition"],
    });
    await expect(runLoop(harness)).rejects.toThrow("gate failed with 2");
    expect(verifyCalls).toBe(0);
  });

  it("does not wait a round on an advisory kind: it has no remediation route, so the Set publishes", async () => {
    const harness = buildHarness({
      violations: [[{ kind: "ctw-word-count-over", id: "ctw-1" }]],
      advisory: ["ctw-word-count-over"],
    });
    await expect(runLoop(harness)).resolves.toEqual({ marks: ["finished"] });
    expect(verifyCalls).toBe(1);
  });

  it("DOES wait on a degrading kind: it keeps every round it was going to get, and only the ending changes", async () => {
    const warned = vi.spyOn(console, "warn").mockImplementation(() => {});
    const harness = buildHarness({
      violations: [[{ kind: "ctw-gap-leak", id: "ctw-1" }]],
      degradable: ["ctw-gap-leak"],
    });
    await expect(runLoop(harness)).resolves.toEqual({ marks: ["finished"] });
    expect(verifyCalls).toBe(MAX_VERIFY_ATTEMPTS);
    expect(warned).toHaveBeenCalledWith(
      `[fakeGenerator] publishing with 1 unrepaired advisory violation(s) after ${MAX_VERIFY_ATTEMPTS} verify attempts: ctw-gap-leak`,
    );
  });

  it("carries the failure ledger into the degraded-publish warning too, not only into the throw", async () => {
    const warned = vi.spyOn(console, "warn").mockImplementation(() => {});
    vi.spyOn(console, "error").mockImplementation(() => {});
    const harness = buildHarness({
      violations: [[{ kind: "ctw-gap-leak", id: "ctw-1" }]],
      degradable: ["ctw-gap-leak"],
      remediations: ({ issued }) => [[
        recorder(issued, "leak", {
          pass: "wholesale",
          targets: targetsOf("ctw-1"),
          onApply: async () => {
            throw new TypeError("nope");
          },
        }),
      ]],
    });
    await runLoop(harness);
    expect(warned.mock.calls[0]?.[0]).toContain(
      `| remediation failures: leak (TypeError) x${MAX_VERIFY_ATTEMPTS - 1}`,
    );
  });
});

describe("the exhaustion diagnostic", () => {
  it("assembles its fragments in one fixed order: blocking, advisory-also-unresolved, the section's own, then the ledger", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    const harness = buildHarness({
      violations: [[
        { kind: "invalid-answer-key", id: "q1" },
        { kind: "ctw-gap-leak", id: "ctw-1" },
      ]],
      degradable: ["ctw-gap-leak"],
      exhaustionParts: ["2 MCQ item(s) with issues: q9 (why)"],
      remediations: ({ issued }) => [[
        recorder(issued, "key", {
          pass: "wholesale",
          targets: targetsOf("q1"),
          onApply: async () => {
            throw new TypeError("nope");
          },
        }),
      ]],
    });
    const error = await rejection(runLoop(harness));
    expect(error.message).toBe(
      `exhausted after ${MAX_VERIFY_ATTEMPTS}: `
        + "1 content-gate violation(s): invalid-answer-key:q1"
        + " | 1 advisory violation(s) also unresolved (not the cause of this failure): ctw-gap-leak:ctw-1"
        + " | 2 MCQ item(s) with issues: q9 (why)"
        + ` | remediation failures: key (TypeError) x${MAX_VERIFY_ATTEMPTS - 1}`,
    );
  });

  it("omits every fragment that has nothing to report rather than emitting an empty one", async () => {
    const harness = buildHarness({ verdicts: [{ findings: 1 }], exhaustionParts: ["3 unanswerable"] });
    const error = await rejection(runLoop(harness));
    expect(error.message).toBe(`exhausted after ${MAX_VERIFY_ATTEMPTS}: 3 unanswerable`);
  });

  it("is a structured error carrying the ledger, not just a string a caller has to re-parse", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    const harness = buildHarness({
      verdicts: [{ findings: 1 }],
      remediations: ({ issued }) => [[
        recorder(issued, "cat", {
          pass: "wholesale",
          targets: targetsOf("a"),
          onApply: async () => {
            throw new SyntaxError("nope");
          },
        }),
      ]],
    });
    const error = await rejection(runLoop(harness));
    expect(error).toBeInstanceOf(GenerationVerifyExhaustedError);
    expect(error.message).toContain(`cat (SyntaxError) x${MAX_VERIFY_ATTEMPTS - 1}`);
  });
});

describe("addReason", () => {
  it("concatenates rather than overwriting when two sources flag the same id in one round", () => {
    const target = new Map<string, string>();
    addReason(target, "q1", "the gate says it is too long");
    addReason(target, "q1", "the verifier says it is unanswerable");
    expect(target.get("q1")).toBe(
      "the gate says it is too long Separately: the verifier says it is unanswerable",
    );
  });

  it("stores the first reason as-is", () => {
    const target = new Map<string, string>();
    addReason(target, "q1", "only reason");
    expect(target.get("q1")).toBe("only reason");
  });
});

// Source scans: the round budget, addReason, the remediation guard and the exclusion belong to the
// loop, so a section generator that grows its own copy fails here.
describe("neither generator owns a second copy of what the loop owns", () => {
  const sources = ["readingGenerator", "listeningGenerator"].map((name) => ({
    name,
    source: fs.readFileSync(path.join(config.projectRoot, `server/src/services/${name}.ts`), "utf8"),
  }));

  for (const { name, source } of sources) {
    it(`${name}.ts declares no round budget of its own`, () => {
      expect(source).not.toMatch(/(const|let)\s+MAX_VERIFY_ATTEMPTS\s*=/);
      expect(source).toContain("MAX_VERIFY_ATTEMPTS");
    });

    it(`${name}.ts declares no addReason of its own`, () => {
      expect(source).not.toMatch(/function\s+addReason\s*\(/);
      expect(source).toContain("addReason");
    });

    it(`${name}.ts hand-rolls no remediation guard: no try/catch around a regeneration call`, () => {
      expect(source).not.toContain("withRemediationGuard");
      expect(source).not.toMatch(/remediation failed, will retry next round/);
    });

    it(`${name}.ts passes no hand-built exclusion set: the loop admits every remediation`, () => {
      expect(source).not.toMatch(/wholesaleThisRound/);
    });
  }
});
