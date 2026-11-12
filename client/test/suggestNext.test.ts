import { describe, expect, it } from "vitest";
import type { Section, SetupStatusVM } from "@toefl-prep/shared";
import { sectionScorability, suggestNext, type Scorability } from "../src/pages/dashboard/suggestNext";

// The Dashboard's one primary action. The rule: a section with no Band Estimate comes first, in test
// order, and its Simulation is the suggestion — unless this machine cannot score that section, in
// which case the suggestion says what is missing instead of offering a run that would fail. With
// every band in hand, the section furthest below its Target, ties to test order. At or above every
// Target, a Full-Test Run.

const TARGETS: Record<Section, number> = { reading: 5.5, listening: 5.5, writing: 5.5, speaking: 5.5 };
const READY: Record<Section, Scorability> = {
  reading: { state: "ready" },
  listening: { state: "ready" },
  writing: { state: "ready" },
  speaking: { state: "ready" },
};

describe("suggestNext", () => {
  it("on a first run suggests the Reading Simulation, the first section in test order", () => {
    expect(suggestNext({ bands: {}, targets: TARGETS, scorability: READY })).toEqual({
      kind: "simulation",
      section: "reading",
      reason: "no-band",
    });
  });

  it("takes the first section without a band in test order, even when another is far below its Target", () => {
    expect(suggestNext({ bands: { reading: 2, listening: 6 }, targets: TARGETS, scorability: READY })).toEqual({
      kind: "simulation",
      section: "writing",
      reason: "no-band",
    });
  });

  it("says what is missing for a band-less section this machine cannot score, rather than skipping past it", () => {
    const scorability = { ...READY, writing: { state: "blocked", missing: ["gemini-api-key", "openai-api-key"] } } satisfies Record<Section, Scorability>;
    expect(suggestNext({ bands: { reading: 5, listening: 5 }, targets: TARGETS, scorability })).toEqual({
      kind: "unavailable",
      section: "writing",
      reason: "no-band",
      missing: ["gemini-api-key", "openai-api-key"],
    });
  });

  it("says a section is still being checked rather than calling it missing nothing", () => {
    const scorability = { ...READY, speaking: { state: "checking" } } satisfies Record<Section, Scorability>;
    expect(suggestNext({ bands: { reading: 5, listening: 5, writing: 5 }, targets: TARGETS, scorability })).toEqual({
      kind: "unavailable",
      section: "speaking",
      reason: "no-band",
      missing: [],
    });
  });

  it("offers the run when whether it can be scored is unknown (the setup check did not answer)", () => {
    const scorability = { ...READY, writing: { state: "unknown" } } satisfies Record<Section, Scorability>;
    expect(suggestNext({ bands: { reading: 5, listening: 5 }, targets: TARGETS, scorability })).toMatchObject({
      kind: "simulation",
      section: "writing",
    });
  });

  it("with every band in hand, picks the section furthest below its own Target — not the lowest band", () => {
    // Writing has the lowest band but sits at its own Target; Speaking is a whole band short of its.
    const targets = { ...TARGETS, reading: 6, writing: 4 };
    expect(
      suggestNext({ bands: { reading: 5.5, listening: 5.5, writing: 4, speaking: 4.5 }, targets, scorability: READY }),
    ).toEqual({ kind: "simulation", section: "speaking", reason: "below-target", band: 4.5, target: 5.5 });
  });

  it("breaks a tie by test order", () => {
    expect(
      suggestNext({ bands: { reading: 6, listening: 5, writing: 6, speaking: 5 }, targets: TARGETS, scorability: READY }),
    ).toEqual({ kind: "simulation", section: "listening", reason: "below-target", band: 5, target: 5.5 });
  });

  it("counts a section exactly at its Target as done, and suggests a Full-Test Run when all are", () => {
    expect(
      suggestNext({ bands: { reading: 6, listening: 5.5, writing: 5.5, speaking: 6 }, targets: TARGETS, scorability: READY }),
    ).toEqual({ kind: "full-test" });
  });

  it("says what is missing for the section furthest below its Target when it cannot be scored now", () => {
    const scorability = { ...READY, speaking: { state: "blocked", missing: ["ffmpeg"] } } satisfies Record<Section, Scorability>;
    expect(
      suggestNext({ bands: { reading: 6, listening: 6, writing: 5.5, speaking: 4 }, targets: TARGETS, scorability }),
    ).toEqual({ kind: "unavailable", section: "speaking", reason: "below-target", missing: ["ffmpeg"] });
  });

  it("does not offer a Full-Test Run whose Writing or Speaking could not be scored", () => {
    const scorability = { ...READY, writing: { state: "blocked", missing: ["claude-cli", "codex-cli"] } } satisfies Record<Section, Scorability>;
    expect(
      suggestNext({ bands: { reading: 6, listening: 6, writing: 6, speaking: 6 }, targets: TARGETS, scorability }),
    ).toEqual({ kind: "unavailable", section: "writing", reason: "full-test", missing: ["claude-cli", "codex-cli"] });
  });
});

function status(over: Partial<SetupStatusVM> = {}): SetupStatusVM {
  return {
    claudeCli: "ready",
    codexCli: "ready",
    geminiApiKey: true,
    openaiApiKey: true,
    geminiJudgeModel: true,
    openaiJudgeModel: true,
    ffmpeg: true,
    ffprobe: true,
    capabilities: {
      "reading-writing-generation": true,
      "speaking-listening-generation": true,
      "writing-scoring": true,
      "speaking-scoring": true,
      "speaking-uploads": true,
    },
    missing: [],
    rubrics: { source: "rewritten" },
    ...over,
  };
}

describe("sectionScorability", () => {
  it("Reading and Listening are scored on this machine against the key, whatever else is missing", () => {
    const none = status({
      claudeCli: "not-installed",
      codexCli: "not-installed",
      capabilities: {
        "reading-writing-generation": false,
        "speaking-listening-generation": false,
        "writing-scoring": false,
        "speaking-scoring": false,
        "speaking-uploads": false,
      },
    });
    expect(sectionScorability("reading", none)).toEqual({ state: "ready" });
    expect(sectionScorability("listening", null)).toEqual({ state: "ready" });
  });

  it("is unknown for Writing and Speaking when there is no setup status to read", () => {
    expect(sectionScorability("writing", null)).toEqual({ state: "unknown" });
    expect(sectionScorability("speaking", null)).toEqual({ state: "unknown" });
  });

  it("names the pieces that turn a section's scoring off", () => {
    const s = status({
      geminiApiKey: false,
      ffmpeg: false,
      capabilities: {
        "reading-writing-generation": true,
        "speaking-listening-generation": false,
        "writing-scoring": true,
        "speaking-scoring": false,
        "speaking-uploads": false,
      },
      missing: [
        { piece: "gemini-api-key", disables: ["speaking-listening-generation", "speaking-scoring"] },
        { piece: "ffmpeg", disables: ["speaking-listening-generation", "speaking-scoring", "speaking-uploads"] },
      ],
    });
    expect(sectionScorability("writing", s)).toEqual({ state: "ready" });
    expect(sectionScorability("speaking", s)).toEqual({ state: "blocked", missing: ["gemini-api-key", "ffmpeg"] });
  });

  it("is still checking when a capability is off but no piece is known to be missing", () => {
    const s = status({
      claudeCli: "checking",
      codexCli: "checking",
      capabilities: {
        "reading-writing-generation": false,
        "speaking-listening-generation": false,
        "writing-scoring": false,
        "speaking-scoring": false,
        "speaking-uploads": true,
      },
    });
    expect(sectionScorability("writing", s)).toEqual({ state: "checking" });
  });
});
