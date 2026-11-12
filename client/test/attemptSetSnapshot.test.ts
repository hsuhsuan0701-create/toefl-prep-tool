import { describe, expect, it } from "vitest";
import {
  buildSentenceComposition,
  questionFor,
  sentenceFrameFor,
  snapshotAttemptSet,
  spokenPromptAudioFor,
  stimulusAudioFor,
  stimulusContentFor,
  stimulusFor,
} from "../src/pages/attemptSetSnapshot";

// What GET /api/sets/:id serves for a Writing Set: stripAnswers drops `answers` (and
// `generationPlan`) and keeps everything else, `frame` included, so the frame reaches the client on
// the fetch Attempt review already makes. The framed Item is the project's reference Item
// (server/test/fixtures/build-a-sentence-reference-item.json); `bas-legacy` is frameless, like the
// Sets banked before frames existed.
const REFERENCE_FRAME = "The ___ ___ ___ ___ ___ ___ wonderful.";

const writingSet = {
  id: "wri-ref",
  kind: "writing",
  source: "generated",
  createdAt: "2026-01-01T00:00:00Z",
  buildASentence: {
    items: [
      {
        id: "bas-ref-1",
        prompt: "How did the museum visit go?",
        frame: REFERENCE_FRAME,
        tiles: ["were", "the", "was", "new wing", "led us through", "who", "volunteers"],
      },
      {
        id: "bas-legacy",
        prompt: "Whose notebook is this?",
        tiles: ["think", "I", "it's mine.", "thinks"],
      },
    ],
  },
};

const speakingSet = {
  id: "spk-1",
  kind: "speaking",
  listenAndRepeat: {
    image: { file: "images/scenarios/spk-1.webp", model: "gpt-image-2" },
    items: [
      { id: "lr-1", focusRegion: { x: 0.1, y: 0.2, width: 0.3, height: 0.4 } },
      { id: "lr-2" },
    ],
  },
};

describe("snapshotAttemptSet — Build a Sentence frames", () => {
  it("maps each framed Item's frame by Item id", () => {
    const snapshot = snapshotAttemptSet("wri-ref", writingSet);
    expect(snapshot.setId).toBe("wri-ref");
    expect(sentenceFrameFor(snapshot, "bas-ref-1")).toBe(REFERENCE_FRAME);
  });

  it("carries no frame for a frameless Item, so it keeps rendering as it always has", () => {
    const snapshot = snapshotAttemptSet("wri-ref", writingSet);
    expect(sentenceFrameFor(snapshot, "bas-legacy")).toBeUndefined();
  });

  it("carries no frame for an Item id the Set does not have", () => {
    // An Attempt whose Set was regenerated under the same id, or simply a non-Build-a-Sentence
    // Item — either way there is no frame to compose with and the review falls back.
    const snapshot = snapshotAttemptSet("wri-ref", writingSet);
    expect(sentenceFrameFor(snapshot, "em-1")).toBeUndefined();
  });

  it("never returns an inherited property as if it were a frame", () => {
    // Item ids are `[A-Za-z0-9_-]+`, so "constructor" and "toString" are both legal ids that are
    // also Object.prototype keys. A plain `map[itemId]` lookup would hand the review a function.
    const snapshot = snapshotAttemptSet("wri-ref", writingSet);
    expect(sentenceFrameFor(snapshot, "constructor")).toBeUndefined();
    expect(sentenceFrameFor(snapshot, "toString")).toBeUndefined();
  });

  it("has no frames for a Set of another kind", () => {
    const snapshot = snapshotAttemptSet("spk-1", speakingSet);
    expect(sentenceFrameFor(snapshot, "lr-1")).toBeUndefined();
  });
});

describe("sentenceFrameFor without a snapshot", () => {
  it("returns no frame when the Set could not be read at all", () => {
    // The Set fetch is best-effort: a deleted Set, a 404 or an offline server leaves the snapshot
    // null, and review must still render the Response it has.
    expect(sentenceFrameFor(null, "bas-ref-1")).toBeUndefined();
  });
});

describe("snapshotAttemptSet — malformed payloads", () => {
  // `getSet` is typed (`ServedSet`) but never validated, and a retired or stale Set can be any of
  // these at runtime. Every one must degrade to "no frame", never throw: a snapshot that throws
  // inside the fetch's `.then` would take the scene with it and leave the page with no snapshot at
  // all. That is why Attempt review reads through `asUntrustedServedSet` and not the throwing
  // `expectServedSet` every Drill and Simulation uses.
  it.each([
    ["null", null],
    ["a non-object", "not a set"],
    ["a Writing Set with no buildASentence", { id: "wri-x", kind: "writing" }],
    ["a buildASentence whose items are not an array", { id: "wri-x", kind: "writing", buildASentence: { items: 3 } }],
    ["items that are not objects", { id: "wri-x", kind: "writing", buildASentence: { items: [null, 7] } }],
    [
      "an Item whose frame is not a string",
      { id: "wri-x", kind: "writing", buildASentence: { items: [{ id: "bas-1", frame: 42 }] } },
    ],
  ])("degrades to no frames for %s", (_label, value) => {
    const snapshot = snapshotAttemptSet("wri-x", value);
    expect(snapshot.setId).toBe("wri-x");
    expect(sentenceFrameFor(snapshot, "bas-1")).toBeUndefined();
  });
});

describe("snapshotAttemptSet — the Listen and Repeat scene it already carried", () => {
  it("still snapshots the scene image and per-Item focus regions", () => {
    const snapshot = snapshotAttemptSet("spk-1", speakingSet);
    expect(snapshot.scene?.file).toBe("images/scenarios/spk-1.webp");
    expect(snapshot.scene?.focusRegionsByItemId["lr-1"]).toEqual({ x: 0.1, y: 0.2, width: 0.3, height: 0.4 });
    expect(snapshot.scene?.focusRegionsByItemId["lr-2"]).toBeUndefined();
  });

  it("has no scene for a Set that is not a Speaking Set, or has no image", () => {
    expect(snapshotAttemptSet("wri-ref", writingSet).scene).toBeNull();
    expect(snapshotAttemptSet("spk-2", { kind: "speaking", listenAndRepeat: { items: [] } }).scene).toBeNull();
    expect(snapshotAttemptSet("spk-3", null).scene).toBeNull();
  });
});

// What GET /api/sets/:id serves for a Speaking Set: each sentence's and question's audio, with the
// `sentence` and `question` text stripped. Review plays the audio again; it never has the text.
describe("spokenPromptAudioFor — a spoken Item's prompt to play again", () => {
  const served = {
    id: "spk-1",
    kind: "speaking",
    listenAndRepeat: {
      introAudio: "stimuli/spk-1/intro.mp3",
      items: [
        { id: "lr-1", audio: "stimuli/spk-1/lr-1.mp3", responseWindowSec: 8 },
        { id: "lr-2", audio: "stimuli/spk-1/lr-2.mp3", responseWindowSec: 8 },
      ],
    },
    interview: {
      introAudio: "stimuli/spk-1/interview-intro.mp3",
      questions: [
        { id: "int-1", audio: "stimuli/spk-1/int-1.mp3", responseWindowSec: 45 },
        { id: "int-2", audio: "stimuli/spk-1/int-2.mp3", responseWindowSec: 45 },
      ],
    },
  };

  it("maps each sentence and each question to its own clip, never the introduction", () => {
    const snapshot = snapshotAttemptSet("spk-1", served);
    expect(spokenPromptAudioFor(snapshot, "lr-2")).toBe("stimuli/spk-1/lr-2.mp3");
    expect(spokenPromptAudioFor(snapshot, "int-1")).toBe("stimuli/spk-1/int-1.mp3");
    expect(Object.values(snapshot.spokenPromptAudioByItemId)).not.toContain("stimuli/spk-1/interview-intro.mp3");
  });

  it("has nothing without a readable Set, for an unknown or inherited id, or for a malformed Item", () => {
    expect(spokenPromptAudioFor(null, "lr-1")).toBeUndefined();
    const snapshot = snapshotAttemptSet("spk-1", served);
    expect(spokenPromptAudioFor(snapshot, "lr-9")).toBeUndefined();
    expect(spokenPromptAudioFor(snapshot, "constructor")).toBeUndefined();
    const malformed = snapshotAttemptSet("spk-2", { kind: "speaking", listenAndRepeat: { items: [{ id: "lr-1" }, null, { id: "lr-3", audio: 7 }] }, interview: { questions: "nope" } });
    expect(malformed.spokenPromptAudioByItemId).toEqual({});
    expect(snapshotAttemptSet("wri-ref", writingSet).spokenPromptAudioByItemId).toEqual({});
  });
});

// No schema makes a Stimulus id unique across a Set's three Modules, so one can repeat. Each Item
// resolves to the Stimulus of its own Module, never to the first one in the Set with that id.
describe("stimulusContentFor and stimulusAudioFor — a Stimulus id repeated in two Modules", () => {
  const options = [{ id: "a", text: "Yes" }, { id: "b", text: "No" }];
  const emptyReading = { timeLimitSec: 540, ctwPassages: [], dailyLife: [], academic: [] };
  const reading = {
    id: "rd-dup",
    kind: "reading",
    router: { ...emptyReading, dailyLife: [{ id: "dl-1", taskType: "daily_life", genre: "notice", text: "The Router Module's notice.", questions: [{ id: "q-r", stem: "?", options }] }] },
    lowerModule: { ...emptyReading, dailyLife: [{ id: "dl-1", taskType: "daily_life", genre: "email", text: "The Lower Module's email.", questions: [{ id: "q-l", stem: "?", options }] }] },
    upperModule: emptyReading,
  };
  const emptyListening = { timeLimitSec: 400, listenChoose: [], conversations: [], announcements: [], academicTalks: [] };
  const listening = {
    id: "lsn-dup",
    kind: "listening",
    router: { ...emptyListening, conversations: [{ id: "conv-1", taskType: "conversation", audio: "stimuli/lsn-dup/router-conv.mp3", setting: "a library", questions: [{ id: "c-r", stem: "?", options }] }] },
    lowerModule: emptyListening,
    upperModule: { ...emptyListening, conversations: [{ id: "conv-1", taskType: "conversation", audio: "stimuli/lsn-dup/upper-conv.mp3", setting: "a lab", questions: [{ id: "c-u", stem: "?", options }] }] },
  };

  it("finds an Item's Stimulus in its own Module", () => {
    const rd = snapshotAttemptSet("rd-dup", reading);
    const lower = questionFor(rd, "q-l")!;
    expect(lower.module).toBe("lower");
    expect(stimulusContentFor(rd, lower.module, lower.stimulusId)).toMatchObject({ text: "The Lower Module's email." });
    const router = questionFor(rd, "q-r")!;
    expect(stimulusContentFor(rd, router.module, router.stimulusId)).toMatchObject({ text: "The Router Module's notice." });
    expect(stimulusFor(rd, "lower", "dl-1")?.name).toBe("email");

    const lsn = snapshotAttemptSet("lsn-dup", listening);
    const upper = questionFor(lsn, "c-u")!;
    expect(stimulusAudioFor(lsn, upper.module, upper.stimulusId)).toBe("stimuli/lsn-dup/upper-conv.mp3");
    expect(stimulusAudioFor(lsn, "router", "conv-1")).toBe("stimuli/lsn-dup/router-conv.mp3");
    expect(stimulusAudioFor(lsn, "lower", "conv-1")).toBeUndefined();
  });
});

describe("buildSentenceComposition — which frame a Response may be written out with", () => {
  const snapshot = snapshotAttemptSet("wri-ref", writingSet);
  const ANSWER = ["volunteers", "who", "led us through", "the", "new wing", "were"];

  it("uses today's frame when the Response and every key are drawn from today's tiles", () => {
    expect(buildSentenceComposition(snapshot, "bas-ref-1", {}, [ANSWER, ANSWER])).toEqual({ frame: REFERENCE_FRAME, revised: false });
  });

  it("counts tiles as a multiset: a tile used twice must be served twice", () => {
    expect(buildSentenceComposition(snapshot, "bas-ref-1", {}, [["the", "the"]])).toEqual({ frame: undefined, revised: true });
  });

  it("reports a revision when a key arrangement no longer fits, even if the Response does", () => {
    expect(buildSentenceComposition(snapshot, "bas-ref-1", {}, [ANSWER, ["The volunteers", "were"]])).toEqual({ frame: undefined, revised: true });
  });

  it("takes a frame persisted with the Response, and a persisted null as frameless, whatever the Set says now", () => {
    expect(buildSentenceComposition(snapshot, "bas-ref-1", { frame: "Our ___ ___." }, [["x"]])).toEqual({ frame: "Our ___ ___.", revised: false });
    expect(buildSentenceComposition(snapshot, "bas-ref-1", { frame: null }, [["x"]])).toEqual({ frame: undefined, revised: false });
  });

  it("says nothing either way without a readable Set", () => {
    expect(buildSentenceComposition(null, "bas-ref-1", {}, [["x"]])).toEqual({ frame: undefined, revised: false });
    expect(buildSentenceComposition(snapshotAttemptSet("spk-1", speakingSet), "bas-ref-1", {}, [["x"]])).toEqual({ frame: undefined, revised: false });
  });

  it("reports a revision for an Item the Set no longer carries", () => {
    expect(buildSentenceComposition(snapshot, "bas-gone", {}, [ANSWER])).toEqual({ frame: undefined, revised: true });
  });
});
