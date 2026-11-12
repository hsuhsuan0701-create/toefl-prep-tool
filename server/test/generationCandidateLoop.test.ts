import { describe, expect, it } from "vitest";
import {
  runCandidateLoop,
  retryHintsAfter,
  GenerationCandidateExhaustedError,
  CANDIDATE_ATTEMPT_BUDGET,
  type CandidateAdapter,
  type CandidateExhaustion,
  type GenerationCandidate,
  type PlannedCandidate,
  type RejectionClass,
} from "../src/services/generationCandidateLoop.js";
import type { ReservedGenerationPlan } from "../src/services/generationPlanner.js";
import { speakingPlanFixture, speakingSetFixture } from "./helpers/generationDiversityFixtures.js";
import type { SkillTaskRunner } from "../src/services/generationReasoning.js";

// The retry-hint rule, which every section's candidate loop shares: the hint table a rejection
// produces (`retryHintsAfter`) carries that rejection's hint and nothing else, for every class, in
// every order. A hint that survived would reach the prompt of an attempt rejected over something
// else.

const ALL_CLASSES: readonly RejectionClass[] = [
  "conformance",
  "difficulty",
  "item-ids",
];

/**
 * A section's rejection type is a discriminated union on `rejection` — that is what lets the loop's
 * `lastByClass` hand each ladder rung the right member back. This stand-in has one member per class
 * so the table and the accumulator are exercised over all three.
 */
type TestRejection = {
  readonly [C in RejectionClass]: {
    readonly rejection: C;
    readonly hint?: string;
    readonly note: string;
  };
}[RejectionClass];

describe("the retry-hint table", () => {
  for (const rejection of ALL_CLASSES) {
    it(`a ${rejection} rejection leaves ${rejection}'s hint live and every other class's cleared`, () => {
      const hints = retryHintsAfter<TestRejection>({
        rejection,
        hint: `hint-for-${rejection}`,
        note: "",
      } as TestRejection);
      const table = hints as Partial<Record<RejectionClass, string>>;
      expect(table[rejection]).toBe(`hint-for-${rejection}`);
      for (const other of ALL_CLASSES.filter((c) => c !== rejection)) {
        expect(table[other]).toBeUndefined();
      }
      // Not merely "the others read undefined": no other row exists at all, so a stale hint cannot
      // be expressed.
      expect(Object.keys(table)).toEqual([rejection]);
    });
  }

  it("a class that carries no prompt hint still clears every other class", () => {
    const table = retryHintsAfter<TestRejection>({
      rejection: "item-ids",
      note: "",
    }) as Partial<Record<RejectionClass, string>>;
    for (const other of ALL_CLASSES) expect(table[other]).toBeUndefined();
  });
});

// The same invariant, driven through the real loop: whatever the previous attempt was rejected
// over, the next prompt sees exactly that one hint.

const fakeCandidate = { kind: "speaking" } as unknown as GenerationCandidate;

const fakeReservation = {
  reservationId: "r",
  ownerId: "o",
  plan: { kind: "speaking" },
} as unknown as ReservedGenerationPlan;

const fakeRun: SkillTaskRunner = (async (request: { parse: (value: unknown) => unknown }) => ({
  ok: true as const,
  value: request.parse({}),
  provider: "claude" as const,
  attempts: [],
})) as unknown as SkillTaskRunner;

function loopHarness(input: {
  rejections: readonly TestRejection[];
  accept?: PlannedCandidate;
}): {
  adapter: CandidateAdapter<GenerationCandidate, GenerationCandidate, TestRejection>;
  promptHints: Record<string, unknown>[];
  exhaustion: CandidateExhaustion<TestRejection>[];
} {
  const promptHints: Record<string, unknown>[] = [];
  const exhaustion: CandidateExhaustion<TestRejection>[] = [];
  let seen = 0;
  const adapter: CandidateAdapter<GenerationCandidate, GenerationCandidate, TestRejection> = {
    task: { task: "generate", context: "speaking" },
    jsonSchema: {},
    parseResponse: (value) => value as GenerationCandidate,
    parseCandidate: () => fakeCandidate,
    prompt: (hints) => {
      promptHints.push({ ...(hints as Record<string, unknown>) });
      return "prompt";
    },
    prepare: async () => ({ candidate: fakeCandidate }),
    decide: () => {
      const rejection = input.rejections[seen];
      seen += 1;
      if (rejection === undefined && input.accept) return { accepted: input.accept };
      return { rejected: rejection as TestRejection };
    },
    describeExhaustion: (state) => {
      exhaustion.push(state);
      return `exhausted after ${state.attempts}: ${state.newest.note}`;
    },
  };
  return { adapter, promptHints, exhaustion };
}

describe("runCandidateLoop", () => {
  it("carries only the newest rejection's hint into the next attempt's prompt", async () => {
    const { adapter, promptHints } = loopHarness({
      rejections: [
        { rejection: "conformance", hint: "format", note: "1" },
        { rejection: "difficulty", hint: "harder", note: "2" },
        { rejection: "item-ids", note: "3" },
      ],
    });

    await expect(runCandidateLoop({
      adapter,
      run: fakeRun,
      reservation: fakeReservation,
    })).rejects.toThrow(/exhausted after 3/u);

    expect(promptHints).toHaveLength(CANDIDATE_ATTEMPT_BUDGET);
    // Attempt 1 is told nothing; attempts 2 and 3 are told exactly one thing each, and it is always
    // the class the attempt before them was rejected under.
    expect(promptHints[0]).toEqual({});
    expect(promptHints[1]).toEqual({ conformance: "format" });
    expect(promptHints[2]).toEqual({ difficulty: "harder" });
  });

  it("hands the exhaustion formatter the newest rejection and a sticky last-of-each-class", async () => {
    const { adapter, exhaustion } = loopHarness({
      rejections: [
        { rejection: "difficulty", hint: "harder", note: "1" },
        { rejection: "conformance", hint: "format", note: "2" },
        { rejection: "conformance", hint: "format", note: "3" },
      ],
    });

    await expect(runCandidateLoop({
      adapter,
      run: fakeRun,
      reservation: fakeReservation,
    })).rejects.toBeInstanceOf(GenerationCandidateExhaustedError);

    const state = exhaustion[0]!;
    expect(state.attempts).toBe(3);
    expect(state.newest.note).toBe("3");
    // Sticky: the difficulty rejection is still reachable two conformance rejections later.
    expect(state.lastByClass.difficulty?.note).toBe("1");
    expect(state.lastByClass.conformance?.note).toBe("3");
    expect(state.rejections.map((r) => r.note)).toEqual(["1", "2", "3"]);
  });

  it("stops at the first accepted candidate and never spends a further attempt", async () => {
    const accepted = {
      kind: "speaking",
      plan: speakingPlanFixture(),
      candidate: speakingSetFixture(),
    } as unknown as PlannedCandidate;
    const { adapter, promptHints } = loopHarness({
      rejections: [{ rejection: "conformance", hint: "format", note: "1" }],
      accept: accepted,
    });

    await expect(runCandidateLoop({
      adapter,
      run: fakeRun,
      reservation: fakeReservation,
    })).resolves.toBe(accepted);
    expect(promptHints).toHaveLength(2);
  });
});
