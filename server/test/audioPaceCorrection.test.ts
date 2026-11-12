import { describe, expect, it, vi } from "vitest";

import { ABSOLUTE_DURATION_TOLERANCE_SEC, assessPace, type PaceBand } from "../src/services/audioPace.js";
import {
  DEFAULT_MAX_CORRECTION_ROUNDS,
  paceDirectionFor,
  renderClipWithPaceCorrection,
} from "../src/services/audioPaceCorrection.js";
import { buildDeliveryPrompt, type DeliveryNotes } from "../src/services/audioPrompt.js";
import { classifyGenerationCheck } from "../src/services/generationCheckPolicy.js";

const BAND: PaceBand = { targetWpm: 160, minWpm: 150, maxWpm: 170 };
const WORDS = 160; // one minute at target, so wpm === 60 / durationSec * 160

/** The duration that makes a clip of WORDS words measure exactly `wpm`. */
function durationForWpm(wpm: number): number {
  return (WORDS / wpm) * 60;
}

/**
 * One take path per round, the way both renderers name theirs: round 0 is the first take and every
 * later round its own file, because two takes are on disk at once whenever one is being compared
 * against the other.
 */
const takePath = (round: number): string => (round === 0 ? "/tmp/first.mp3" : `/tmp/retake${round}.mp3`);
const RETAKE_1 = takePath(1);

function harness(input: {
  takes: number[];
  role?: string;
  clipId?: string;
  maxCorrectionRounds?: number;
}) {
  const durations = [...input.takes];
  const synthesize = vi.fn(async (_correction, _outPath: string) => undefined);
  const discarded: string[] = [];
  // `onTake`'s return value is the module's handle on a take, and the outcome hands back the winner's.
  // Recording the objects lets the assertions compare by identity, so "the take that shipped is that
  // one" is stated without re-deriving it from correctionCount, which is the decision under test.
  const takes: { wpm: number; correctionCount: number }[] = [];
  return {
    synthesize,
    discarded,
    takes,
    run: () =>
      renderClipWithPaceCorrection({
        section: "listening",
        band: BAND,
        wordCount: WORDS,
        takePath,
        ...(input.maxCorrectionRounds === undefined ? {} : { maxCorrectionRounds: input.maxCorrectionRounds }),
        role: input.role ?? "lcr-utterance",
        ...(input.clipId === undefined ? {} : { clipId: input.clipId }),
        synthesize: synthesize as never,
        probeDuration: async () => durations.shift()!,
        discardTake: (filePath) => discarded.push(filePath),
        onTake: (assessment, correctionCount) => {
          const take = { wpm: Number(assessment.wpm.toFixed(1)), correctionCount };
          takes.push(take);
          return take;
        },
      }),
  };
}

describe("paceDirectionFor", () => {
  it("slows a clip above the band ceiling and speeds up one below the floor", () => {
    expect(paceDirectionFor({ wpm: 180 } as never, BAND)).toBe("slower");
    expect(paceDirectionFor({ wpm: 120 } as never, BAND)).toBe("faster");
  });

  it("keys off the CEILING, not the target — a clip inside its band is never called too fast", () => {
    // 168 is above the 160 target but inside the 150-170 band. Correcting it would chase a clip that
    // needed nothing; this is the distinction that makes a correction safe to spend.
    expect(paceDirectionFor({ wpm: 168 } as never, BAND)).toBe("faster");
  });
});

describe("a clip outside its band triggers a corrective re-render — by default, exactly one", () => {
  it("re-renders once, with a correction, when the first take misses", async () => {
    const h = harness({ takes: [durationForWpm(140), durationForWpm(160)] });
    await h.run();
    expect(h.synthesize).toHaveBeenCalledTimes(2);
    expect(h.synthesize.mock.calls[0]![0]).toBeUndefined();
    expect(h.synthesize.mock.calls[1]![0]).toEqual({ direction: "faster", round: 1 });
  });

  it("does not re-render a clip that landed in its band", async () => {
    const h = harness({ takes: [durationForWpm(160)] });
    const outcome = await h.run();
    expect(h.synthesize).toHaveBeenCalledTimes(1);
    expect(outcome.corrected).toBe(false);
    expect(outcome.note).toBeUndefined();
  });

  it("never spends a second render on a malfunction", async () => {
    // Far outside the 0.3x-3.0x sanity window: a truncated or stuck synthesis, which the policy still
    // calls fatal. Re-rendering it would buy a paid call for a defect a pace nudge cannot fix.
    const h = harness({ takes: [durationForWpm(600)] });
    const outcome = await h.run();
    expect(outcome.assessment.verdict).toBe("malfunction");
    expect(h.synthesize).toHaveBeenCalledTimes(1);
  });

  it("stops at one — a second miss buys no third take", async () => {
    const h = harness({ takes: [durationForWpm(140), durationForWpm(142)] });
    await h.run();
    expect(h.synthesize).toHaveBeenCalledTimes(2);
  });

  it("defaults to a budget of one round, so a caller that sets none buys one corrective take even far below the band", async () => {
    expect(DEFAULT_MAX_CORRECTION_ROUNDS).toBe(1);
    // 120 WPM is far below the 150 floor, the case that earns escalating rounds, and it still buys
    // exactly one round here because this caller set no budget. Speaking is that caller.
    const h = harness({ takes: [durationForWpm(120), durationForWpm(122)] });
    await h.run();
    expect(h.synthesize).toHaveBeenCalledTimes(2);
  });
});

/**
 * The bounded escalation, driven by a mocked take sequence.
 *
 * One prompt nudge moves a take about 7 WPM, so a single corrective round cannot close a 20 WPM gap.
 * The spend rule: a miss one nudge could plausibly close gets one round, a miss it could not gets
 * more, and the budget bounds both.
 */
describe("a clip FAR below its band buys further, escalating rounds", () => {
  // BAND is 150-170, so FAR_BELOW_BAND_WPM (15) puts the escalation threshold at 135 WPM.
  const BUDGET = 3;

  it("keeps re-rendering while it is far below, and stops the moment a take lands in band", async () => {
    // Slow, slow, in band: two rounds beyond the first correction, and no fourth take.
    const h = harness({
      takes: [durationForWpm(118), durationForWpm(124), durationForWpm(158)],
      maxCorrectionRounds: BUDGET,
    });
    const outcome = await h.run();

    expect(h.synthesize).toHaveBeenCalledTimes(3);
    expect(h.synthesize.mock.calls.map((call) => call[0])).toEqual([
      undefined,
      { direction: "faster", round: 1 },
      { direction: "faster", round: 2 },
    ]);
    // The in-band take publishes, every loser is deleted, and nothing is left to disclose.
    expect(outcome.publishPath).toBe(takePath(2));
    expect(outcome.note).toBeUndefined();
    expect(h.discarded).toEqual(["/tmp/first.mp3", RETAKE_1]);
    expect(h.takes.map((take) => take.correctionCount)).toEqual([0, 1, 2]);
  });

  it("spends the budget and NEVER more, then publishes the best take with a note naming the clip", async () => {
    const h = harness({
      takes: [durationForWpm(116), durationForWpm(119), durationForWpm(122), durationForWpm(128)],
      maxCorrectionRounds: BUDGET,
      clipId: "r-lc-07",
    });
    const outcome = await h.run();

    // Four syntheses: the first take plus the three rounds budgeted. A fifth is never bought,
    // however far below the band the clip stays — that bound is what keeps TTS spend legible.
    expect(h.synthesize).toHaveBeenCalledTimes(1 + BUDGET);
    expect(h.synthesize.mock.calls.at(-1)![0]).toEqual({ direction: "faster", round: 3 });
    expect(outcome.publishPath).toBe(takePath(3)); // 128 is the closest of the four
    expect(outcome.note).toEqual({
      check: "speech-rate",
      detail: "lcr-utterance",
      clipId: "r-lc-07",
      take: "retake",
      measuredWpm: 128,
      targetWpm: 160,
      minWpm: 150,
      maxWpm: 170,
    });
  });

  it("buys nothing extra for a miss one nudge could plausibly close", async () => {
    // 140 WPM is 10 below the floor, within FAR_BELOW_BAND_WPM (15) of it, so one nudge could close
    // the gap and one round is all it gets.
    const h = harness({
      takes: [durationForWpm(140), durationForWpm(143)],
      maxCorrectionRounds: BUDGET,
    });
    const outcome = await h.run();
    expect(h.synthesize).toHaveBeenCalledTimes(2);
    expect(outcome.note?.measuredWpm).toBe(143);
  });

  it("stops as soon as a round brings it back within one nudge of the band, even if still out", async () => {
    // 118 -> 137: still below the 150 floor, but no longer far below it. The next round is not bought,
    // and the clip publishes with a note like any other miss.
    const h = harness({
      takes: [durationForWpm(118), durationForWpm(137)],
      maxCorrectionRounds: BUDGET,
    });
    const outcome = await h.run();
    expect(h.synthesize).toHaveBeenCalledTimes(2);
    expect(outcome.note?.measuredWpm).toBe(137);
    expect(outcome.note?.take).toBe("retake");
  });

  it("escalates against the take that would PUBLISH, not the newest one", async () => {
    // Round 1 overshoots the ceiling (250 WPM, 80 past it) and so loses to the 118 WPM first take,
    // which is 32 below the floor. Round 2 therefore corrects the take still standing — the slow one —
    // rather than the discarded fast one, and it does so at the next rung up. It lands at 137, inside
    // one nudge of the floor, so nothing further is bought.
    const h = harness({
      takes: [durationForWpm(118), durationForWpm(250), durationForWpm(137)],
      maxCorrectionRounds: BUDGET,
    });
    await h.run();
    expect(h.synthesize.mock.calls.map((call) => call[0])).toEqual([
      undefined,
      { direction: "faster", round: 1 },
      { direction: "faster", round: 2 },
    ]);
  });

  it("stops buying when a bought round fails outright", async () => {
    // A 429 is not a pace problem, and the remaining budget is not the thing to spend on a provider
    // that has just refused a call. The best take so far is on disk and publishes.
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const durations = [durationForWpm(116)];
    const synthesize = vi.fn(async (correction: unknown) => {
      if (correction !== undefined) throw new Error("429 Too Many Requests");
    });
    try {
      const outcome = await renderClipWithPaceCorrection({
        section: "listening",
        band: BAND,
        wordCount: WORDS,
        takePath,
        maxCorrectionRounds: BUDGET,
        role: "lcr-utterance",
        clipId: "r-lc-01",
        synthesize: synthesize as never,
        probeDuration: async () => durations.shift()!,
        discardTake: () => undefined,
        onTake: () => undefined,
      });
      expect(synthesize).toHaveBeenCalledTimes(2);
      expect(outcome.publishPath).toBe("/tmp/first.mp3");
      expect(outcome.note?.take).toBe("first");
      expect(outcome.note?.clipId).toBe("r-lc-01");
    } finally {
      warn.mockRestore();
    }
  });

  it("never spends an escalated round on a malfunction", async () => {
    const h = harness({ takes: [durationForWpm(600)], maxCorrectionRounds: BUDGET });
    const outcome = await h.run();
    expect(h.synthesize).toHaveBeenCalledTimes(1);
    expect(outcome.assessment.verdict).toBe("malfunction");
    expect(outcome.note).toBeUndefined();
  });

  /**
   * A malfunctioning retake is not a thrown round. A round that throws ends the loop ("stops buying
   * when a bought round fails outright"), because a provider that just refused a call is not one to
   * spend the rest of the budget on. A take that comes back truncated, empty or stuck says nothing
   * about the pace of the take that would publish, which is still far below its floor, so the
   * remaining rounds are still spent on it.
   */
  it("keeps spending the escalated budget when every corrective retake comes back malfunctioning", async () => {
    // 116 WPM: far below the 150 floor, so the escalation is bought. Every retake at 16s against a
    // 60s target is under the 0.3x sanity ratio: a truncated synthesis, three times running.
    const h = harness({
      takes: [durationForWpm(116), durationForWpm(600), durationForWpm(600), durationForWpm(600)],
      maxCorrectionRounds: BUDGET,
    });
    const outcome = await h.run();

    // The full budget is spent, and each round still escalates against the take that would publish.
    expect(h.synthesize).toHaveBeenCalledTimes(1 + BUDGET);
    expect(h.synthesize.mock.calls.map((call) => call[0])).toEqual([
      undefined,
      { direction: "faster", round: 1 },
      { direction: "faster", round: 2 },
      { direction: "faster", round: 3 },
    ]);
    // A malfunctioning take never wins, so the first take publishes, and the render does not fail:
    // a speech-rate miss never ends a job.
    expect(outcome.publishPath).toBe("/tmp/first.mp3");
    expect(outcome.assessment.verdict).toBe("out-of-band");
    expect(outcome.corrected).toBe(true);
    expect(outcome.publishedTake).toBe(h.takes[0]);
    // Every malfunctioning take is measured, recorded and then deleted.
    expect(h.takes.map((take) => take.correctionCount)).toEqual([0, 1, 2, 3]);
    expect(h.discarded).toEqual([RETAKE_1, takePath(2), takePath(3)]);
    // The clip is still out of band, so it publishes with an advisory note naming the first take's
    // rate, not any of the malfunctioning retakes'.
    expect(outcome.note).toEqual({
      check: "speech-rate",
      detail: "lcr-utterance",
      take: "first",
      measuredWpm: 116,
      targetWpm: 160,
      minWpm: 150,
      maxWpm: 170,
    });
  });
});

/**
 * The verdict decides which take ships; `bandDistance` only breaks a tie.
 *
 * `bandDistance` measures the WPM band, while publication and the note read the verdict, which is
 * the band or ABSOLUTE_DURATION_TOLERANCE_SEC. On a short clip the two disagree, because 0.4 s of
 * duration reaches past the band edge once the clip is about six words or fewer for this band, which
 * covers most Listen and Choose a Response clips. Ranking by distance alone would delete a retake
 * `assessPace` rules in band in favour of an out-of-band first take, and the Set would carry a note
 * saying the retake "came out no better" about audio nothing was wrong with.
 *
 * The numbers are the real `lcr-utterance` band and a real clip length, and the first case re-derives
 * the premise from `assessPace`, so a band retune that dissolves it fails that setup instead of
 * leaving a test that proves nothing.
 */
describe("a retake rescued by the absolute-duration tolerance wins, even though it sits further outside the WPM band", () => {
  // LISTENING_ROLE_POLICY["lcr-utterance"], and a five-word utterance: target duration 1.765s.
  const SHORT_BAND: PaceBand = { targetWpm: 170, minWpm: 135, maxWpm: 205 };
  const SHORT_WORDS = 5;
  const FIRST_SEC = 2.3; // 130.4 WPM: 4.6 below the floor, and 0.535s from target, so out of band.
  const RETAKE_SEC = 1.4; // 214.3 WPM: 9.3 above the ceiling, but 0.365s from target, so in band.

  const assess = (durationSec: number) =>
    assessPace({ wordCount: SHORT_WORDS, durationSec, band: SHORT_BAND });

  it("sets up the exact disagreement: the in-band take is the one further outside the band", () => {
    const first = assess(FIRST_SEC);
    const retake = assess(RETAKE_SEC);
    expect(first.verdict).toBe("out-of-band");
    expect(retake.verdict).toBe("in-band");
    expect(retake.inBand, "in band by the TOLERANCE, not by the WPM band").toBe(false);
    expect(Math.abs(RETAKE_SEC - retake.targetDurationSec)).toBeLessThanOrEqual(
      ABSOLUTE_DURATION_TOLERANCE_SEC,
    );
    // The premise in band-distance units: the acceptable take is 9.3 WPM outside the band and the
    // unacceptable one only 4.6, so ranking by distance alone would keep the wrong one.
    expect(retake.wpm - SHORT_BAND.maxWpm).toBeGreaterThan(SHORT_BAND.minWpm - first.wpm);
  });

  it("publishes the in-band retake and leaves no note", async () => {
    const durations = [FIRST_SEC, RETAKE_SEC];
    const discarded: string[] = [];
    const takes: { correctionCount: number }[] = [];
    const synthesize = vi.fn(async (_correction, _outPath: string) => undefined);

    const outcome = await renderClipWithPaceCorrection({
      section: "listening",
      band: SHORT_BAND,
      wordCount: SHORT_WORDS,
      takePath,
      role: "lcr-utterance",
      clipId: "lcr-1",
      synthesize: synthesize as never,
      probeDuration: async () => durations.shift()!,
      discardTake: (filePath) => discarded.push(filePath),
      onTake: (_assessment, correctionCount) => {
        const take = { correctionCount };
        takes.push(take);
        return take;
      },
    });

    expect(synthesize).toHaveBeenCalledTimes(2);
    expect(outcome.publishPath).toBe(RETAKE_1);
    expect(outcome.publishedTake).toBe(takes[1]);
    expect(outcome.assessment.verdict).toBe("in-band");
    expect(discarded).toEqual(["/tmp/first.mp3"]);
    // The published take is in band, so there is nothing to disclose.
    expect(outcome.note).toBeUndefined();
  });
});

describe("a corrected clip inside the band publishes with no note", () => {
  it("publishes the retake and records nothing", async () => {
    const h = harness({ takes: [durationForWpm(140), durationForWpm(158)] });
    const outcome = await h.run();
    expect(outcome.publishPath).toBe(RETAKE_1);
    expect(outcome.note).toBeUndefined();
    expect(outcome.corrected).toBe(true);
    // The losing take is deleted, never left where it could be published by accident.
    expect(h.discarded).toEqual(["/tmp/first.mp3"]);
  });
});

describe("a clip still outside the band after one correction publishes, carrying a note", () => {
  it("names the measured rate and the target band", async () => {
    const h = harness({ takes: [durationForWpm(140), durationForWpm(142)] });
    const outcome = await h.run();
    expect(outcome.publishPath).toBe(RETAKE_1);
    expect(outcome.note).toEqual({
      check: "speech-rate",
      detail: "lcr-utterance",
      take: "retake",
      measuredWpm: 142,
      targetWpm: 160,
      minWpm: 150,
      maxWpm: 170,
    });
  });

  it("carries the rate of the take it actually published, not the discarded one", async () => {
    const h = harness({ takes: [durationForWpm(140), durationForWpm(146)] });
    const outcome = await h.run();
    expect(outcome.note?.measuredWpm).toBe(146);
  });
});

describe("a speech-rate miss never fails a generation job", () => {
  it("keeps the original take when the corrective re-render comes back malfunctioning", async () => {
    // The first take was merely out of band, so failing here would let a speech-rate miss end a job.
    const h = harness({ takes: [durationForWpm(140), durationForWpm(600)] });
    const outcome = await h.run();
    expect(outcome.publishPath).toBe("/tmp/first.mp3");
    expect(outcome.assessment.verdict).toBe("out-of-band");
    expect(outcome.note?.measuredWpm).toBe(140);
    expect(h.discarded).toEqual([RETAKE_1]);
  });

  it("resolves rather than throwing on any sequence of two takes", async () => {
    for (const takes of [
      [durationForWpm(140), durationForWpm(600)],
      [durationForWpm(200), durationForWpm(210)],
      [durationForWpm(140), durationForWpm(160)],
    ]) {
      await expect(harness({ takes }).run()).resolves.toBeDefined();
    }
  });
});

describe("the corrective re-render can itself fail, and must not take the Set with it", () => {
  it("keeps the first take when the second synthesis rejects", async () => {
    // The re-render is a paid call of its own, so it can 429 or 5xx. A rejection that reached the
    // renderer's catch would delete the whole output directory: every clip the Set had already paid
    // for, lost over one clip that was merely off pace.
    const synthesize = vi.fn(async (correction: unknown) => {
      if (correction !== undefined) throw new Error("429 Too Many Requests");
    });
    const discarded: string[] = [];
    const durations = [durationForWpm(140)];
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    try {
      const outcome = await renderClipWithPaceCorrection({
        section: "listening",
        band: BAND,
        wordCount: WORDS,
        takePath,
        role: "lcr-utterance",
        synthesize: synthesize as never,
        probeDuration: async () => durations.shift()!,
        discardTake: (filePath) => discarded.push(filePath),
        onTake: () => undefined,
      });
      expect(outcome.publishPath).toBe("/tmp/first.mp3");
      expect(outcome.note?.take).toBe("first");
      expect(discarded).toEqual([RETAKE_1]);
    } finally {
      warn.mockRestore();
    }
  });

  it("keeps the first take when probing the retake rejects", async () => {
    let probes = 0;
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    try {
      const outcome = await renderClipWithPaceCorrection({
        section: "listening",
        band: BAND,
        wordCount: WORDS,
        takePath,
        role: "lcr-utterance",
        synthesize: async () => undefined,
        probeDuration: async () => {
          probes += 1;
          if (probes === 1) return durationForWpm(140);
          throw new Error("ENOENT");
        },
        discardTake: () => undefined,
        onTake: () => undefined,
      });
      expect(outcome.publishPath).toBe("/tmp/first.mp3");
    } finally {
      warn.mockRestore();
    }
  });
});

describe("the better take wins, not the newer one", () => {
  it("keeps the first take when the correction overshoots", async () => {
    // 172 WPM against a 150-170 band is 2 WPM out. Nudged "slower", the retake lands at 95 WPM —
    // 55 WPM out, and still inside the wide sanity window so it is not a malfunction. Publishing it
    // would replace a nearly-in-band clip with one at half the intended pace.
    const h = harness({ takes: [durationForWpm(172), durationForWpm(95)] });
    const outcome = await h.run();
    expect(outcome.publishPath).toBe("/tmp/first.mp3");
    expect(outcome.note?.measuredWpm).toBe(172);
    expect(outcome.note?.take).toBe("first");
    expect(h.discarded).toEqual([RETAKE_1]);
  });

  it("keeps the retake when it is genuinely closer to the band", async () => {
    const h = harness({ takes: [durationForWpm(120), durationForWpm(148)] });
    const outcome = await h.run();
    expect(outcome.publishPath).toBe(RETAKE_1);
    expect(outcome.note?.take).toBe("retake");
  });
});

describe("every take is recorded, including a discarded one", () => {
  it("reports both takes with their correction counts", async () => {
    const h = harness({ takes: [durationForWpm(140), durationForWpm(160)] });
    await h.run();
    expect(h.takes).toEqual([
      { wpm: 140, correctionCount: 0 },
      { wpm: 160, correctionCount: 1 },
    ]);
  });
});

describe("the correction reaches the prompt", () => {
  const notes: DeliveryNotes = {
    audioProfile: "an announcement",
    scene: "a campus public-address announcement",
    style: "clear and even",
    accent: "north-american",
    band: BAND,
  };

  it("adds a corrective direction to the pacing line, and only on a re-render", () => {
    const plain = buildDeliveryPrompt(notes, "Attention, please.");
    const slower = buildDeliveryPrompt(
      { ...notes, paceCorrection: { direction: "slower", round: 1 } },
      "Attention, please.",
    );
    expect(plain).not.toContain("too fast");
    expect(slower).toContain("too fast");
    expect(slower).toContain("Slow down");
  });

  it("keeps every WPM number out of the prompt, corrected or not, at every rung of the ladder", () => {
    // pacingDirection's rule: a numeric rate in a prompt invites the model to recite it aloud. Every
    // escalation rung is checked, since a rung is where a number would be most tempting to add.
    for (const direction of ["slower", "faster"] as const) {
      for (const round of [1, 2, 3, 4]) {
        const prompt = buildDeliveryPrompt(
          { ...notes, paceCorrection: { direction, round } },
          "Attention, please.",
        );
        for (const wpm of [BAND.targetWpm, BAND.minWpm, BAND.maxWpm]) {
          expect(prompt).not.toContain(String(wpm));
        }
        expect(prompt).not.toMatch(/\d/u);
      }
    }
  });

  /**
   * The escalation, at the seam where it reaches the model.
   *
   * Re-asking in the same words buys the same take again, so each later round must say something
   * different. Round 1's wording is pinned because every pace measurement in this codebase, the role
   * bands' derivation included, was collected under exactly that string.
   */
  it("escalates the wording round by round, keeping round 1 in the exact words every pace measurement was taken under", () => {
    const at = (direction: "slower" | "faster", round: number): string =>
      buildDeliveryPrompt({ ...notes, paceCorrection: { direction, round } }, "Attention, please.");

    expect(at("faster", 1)).toContain(
      "That last take came out too slow. Pick the pace up noticeably",
    );
    expect(at("slower", 1)).toContain(
      "That last take came out too fast. Slow down noticeably",
    );
    for (const direction of ["slower", "faster"] as const) {
      const rungs = [1, 2, 3].map((round) => at(direction, round));
      expect(new Set(rungs).size, `${direction}: every round must say something new`).toBe(3);
      expect(rungs[1]).toContain("markedly");
      expect(rungs[2]).toContain("Still too");
    }
  });

  it("repeats the strongest rung rather than interpolating undefined past the ladder's end", () => {
    // A caller that raises its correction budget without writing new wording must not publish a
    // Stimulus whose prompt reads "Pacing: … undefined".
    const beyond = buildDeliveryPrompt(
      { ...notes, paceCorrection: { direction: "faster", round: 9 } },
      "Attention, please.",
    );
    expect(beyond).not.toContain("undefined");
    expect(beyond).toContain("Still too slow");
  });
});

describe("the policy is what says a missed band is repairable", () => {
  it("classifies out-of-band as repair-then-accept, degrading to advisory", () => {
    for (const section of ["speaking", "listening"] as const) {
      const policy = classifyGenerationCheck({ family: "audio-pace", section, verdict: "out-of-band" });
      expect(policy.tier).toBe("repair-then-accept");
      expect(policy.tier === "repair-then-accept" && policy.unrepaired).toBe("advisory");
    }
  });

  it("still calls a malfunction fatal", () => {
    expect(
      classifyGenerationCheck({ family: "audio-pace", section: "speaking", verdict: "malfunction" }).tier,
    ).toBe("fatal");
  });
});

/**
 * clip_measurements holds one row per take, and this module publishes the better take, not the
 * newer one, so "the last row" and "max(correction_count)" both name the discarded take whenever a
 * correction was bought and lost. `publishedTake` names the winner. It is asserted by identity
 * because an assertion phrased in correctionCount would be a second copy of the decision under test.
 */
describe("the outcome names the take that ships", () => {
  it("names the FIRST take when the retake comes back worse — the case the naive query gets wrong", async () => {
    // 140 WPM against a 150-170 band, corrected to 95: still inside the sanity window, so not a
    // malfunction, merely much worse. The newer take exists, was measured, and is thrown away.
    const h = harness({ takes: [durationForWpm(140), durationForWpm(95)] });
    const outcome = await h.run();
    expect(h.takes.map((take) => take.correctionCount)).toEqual([0, 1]);
    expect(outcome.publishPath).toBe("/tmp/first.mp3");
    expect(outcome.publishedTake).toBe(h.takes[0]);
    // The two naive queries over the take rows both land on the discarded take.
    expect(h.takes.at(-1)).not.toBe(outcome.publishedTake);
    expect(h.takes.find((take) => take.correctionCount === 1)).not.toBe(outcome.publishedTake);
  });

  it("names the RETAKE when the correction lands", async () => {
    const h = harness({ takes: [durationForWpm(140), durationForWpm(158)] });
    const outcome = await h.run();
    expect(outcome.publishPath).toBe(RETAKE_1);
    expect(outcome.publishedTake).toBe(h.takes[1]);
  });

  it("names the only take when no correction was bought at all", async () => {
    const h = harness({ takes: [durationForWpm(160)] });
    const outcome = await h.run();
    expect(h.takes).toHaveLength(1);
    expect(outcome.publishedTake).toBe(h.takes[0]);
  });

  it("names the first take when the corrective re-render never produced one", async () => {
    // The retake threw, so onTake never fired for it and there is no second handle to confuse.
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const takes: { correctionCount: number }[] = [];
    try {
      const outcome = await renderClipWithPaceCorrection({
        section: "listening",
        band: BAND,
        wordCount: WORDS,
        takePath,
        role: "lcr-utterance",
        synthesize: (async (correction: unknown) => {
          if (correction !== undefined) throw new Error("429 Too Many Requests");
        }) as never,
        probeDuration: async () => durationForWpm(140),
        discardTake: () => undefined,
        onTake: (_assessment, correctionCount) => {
          const take = { correctionCount };
          takes.push(take);
          return take;
        },
      });
      expect(takes).toHaveLength(1);
      expect(outcome.publishedTake).toBe(takes[0]);
    } finally {
      warn.mockRestore();
    }
  });
});
