import { describe, expect, it } from "vitest";
import {
  asUntrustedServedSet,
  expectServedSet,
  stripAnswers,
  type ServedListeningSet,
  type ServedReadingSet,
  type ServedSet,
  type ServedSpeakingSet,
  type ServedWritingSet,
} from "@toefl-prep/shared";
import { speakingSetFixture, writingSetFixture } from "./helpers/generationDiversityFixtures.js";
import { READING_FIXTURE } from "./fixtures/reading-set.fixture.js";
import { LISTENING_FIXTURE } from "./fixtures/listening-set.fixture.js";

// The leak scans in schemas.test.ts, schemas.reading.test.ts and schemas.listening.test.ts prove
// stripAnswers removes the right fields at runtime. This file covers the other half of the contract:
// the type it declares says so too, and the two narrowing helpers behave the way their two kinds of
// reader need.
//
// Every `@ts-expect-error` below is a guard: server/tsconfig.json includes `test`, so an expectation
// that stops being an error fails `npm run typecheck`. Widening ServedSet so that it admits a
// stripped field is the drift this catches.

describe("stripAnswers declares the served union", () => {
  it("returns a Speaking Set with no sentence, question, prompt, plan or audio profile in its type", () => {
    const served: ServedSet = stripAnswers(speakingSetFixture());
    const speaking: ServedSpeakingSet = expectServedSet("speaking", served);

    // @ts-expect-error the L&R target sentence is stripped — the served type must not offer it
    void speaking.listenAndRepeat.items[0].sentence;
    // @ts-expect-error the interview question text is stripped
    void speaking.interview.questions[0].question;
    // @ts-expect-error the scene prompt embeds all seven target sentences and is stripped
    void speaking.listenAndRepeat.image?.prompt;
    // @ts-expect-error generation provenance is stripped
    void speaking.generationPlan;
    // @ts-expect-error renderer provenance is stripped (CLAUDE.md: no provider provenance in responses)
    void speaking.audioProfile;

    // What is served, and must keep compiling: the ring the Drill draws while the sentence is hidden.
    void speaking.listenAndRepeat.items[0].focusRegion;
    void speaking.listenAndRepeat.image?.file;
    void speaking.advisoryNotes;
  });

  it("returns a Writing Set whose Build a Sentence Items have no answer key in their type", () => {
    const writing: ServedWritingSet = expectServedSet("writing", stripAnswers(writingSetFixture()));

    // @ts-expect-error the correct tile orderings are stripped
    void writing.buildASentence.items[0].answers;
    // @ts-expect-error generation provenance is stripped
    void writing.generationPlan;

    // The tray itself is served, in an order drawn per request (tileScramble.ts).
    expect(writing.buildASentence.items[0].tiles.length).toBeGreaterThan(0);
    void writing.buildASentence.items[0].frame;
    void writing.email.bullets;
    void writing.academicDiscussion.studentPosts;
  });

  it("returns a Reading Set with no completion, key, skill or explanation in its type", () => {
    const reading: ServedReadingSet = expectServedSet("reading", stripAnswers(READING_FIXTURE));

    // @ts-expect-error the deleted letters are stripped
    void reading.router.ctwPassages[0].gaps[0].completion;
    // @ts-expect-error the 錯題解析 is withheld until the Item is scored
    void reading.router.ctwPassages[0].gaps[0].explanationZh;
    // @ts-expect-error the paragraph the letters were deleted from is stripped
    void reading.router.ctwPassages[0].sourceParagraph;
    // @ts-expect-error the MCQ key is stripped
    void reading.lowerModule.dailyLife[0].questions[0].correctOptionId;
    // @ts-expect-error the weakness-tracking skill tag is stripped (it narrows the options for free)
    void reading.router.academic[0].questions[0].skill;

    // The blank the Drill draws is served whole.
    void reading.router.ctwPassages[0].segments;
    void reading.router.ctwPassages[0].gaps[0].prefix;
    void reading.router.ctwPassages[0].gaps[0].blankLength;
  });

  it("returns a Listening Set with no utterance, transcript, key or voice in its type", () => {
    const listening: ServedListeningSet = expectServedSet("listening", stripAnswers(LISTENING_FIXTURE));

    // @ts-expect-error the Listen-and-Choose utterance is never rendered as text, even post-answer
    void listening.router.listenChoose[0].utterance;
    // @ts-expect-error the MCQ key is stripped
    void listening.router.listenChoose[0].correctOptionId;
    // @ts-expect-error the conversation transcript is stripped
    void listening.router.conversations[0].transcript;
    // @ts-expect-error the TTS voice id is render provenance and is stripped
    void listening.router.conversations[0].speakers[0].voice;
    // @ts-expect-error renderer provenance is stripped whole
    void listening.audioProfile;

    // The speaker's avatar card (AvatarCard.tsx) is built from these, and none names an answer.
    void listening.router.conversations[0].speakers[0].role;
    void listening.router.conversations[0].speakers[0].gender;
    void listening.router.conversations[0].speakers[0].accent;
    void listening.router.listenChoose[0].options;
  });
});

describe("expectServedSet — the Drill/Simulation narrowing, which fails loudly", () => {
  it("returns the Set unchanged when the kind matches", () => {
    const served = stripAnswers(writingSetFixture());
    expect(expectServedSet("writing", served)).toBe(served);
  });

  it("throws for a Set of another kind, naming both kinds and no Set content", () => {
    const served = stripAnswers(READING_FIXTURE);
    expect(() => expectServedSet("speaking", served)).toThrow(
      "served Set is not a speaking Set (got reading)",
    );
  });

  it("throws rather than reading through a payload that is not a Set at all", () => {
    // A page that narrows and then reads its kind's content unconditionally must not get a
    // TypeError three renders later; the fetch's own `.catch` turns this into its error stage.
    for (const junk of [null, undefined, {}, { kind: "nonsense" }, "not a set"]) {
      expect(() => expectServedSet("writing", junk as unknown as ServedSet)).toThrow(
        "served Set is not a writing Set (got unknown)",
      );
    }
  });
});

describe("asUntrustedServedSet — Attempt review's deliberate distrust of a retired Set", () => {
  it("never throws, whatever it is handed", () => {
    for (const junk of [null, undefined, "not a set", 7, [], { kind: "nonsense" }]) {
      expect(() => asUntrustedServedSet(junk)).not.toThrow();
    }
  });

  it("reduces a non-object to a Set with no kind, so every field read falls back", () => {
    const doubted = asUntrustedServedSet("404: not found");
    expect(doubted.kind).toBeUndefined();
  });

  it("keeps a real served Set readable field by field", () => {
    const doubted = asUntrustedServedSet(stripAnswers(speakingSetFixture()));
    expect(doubted.kind).toBe("speaking");
    if (doubted.kind !== "speaking") throw new Error("kind changed");
    // Optional on the doubted type, since a stale Set may not carry the group, but present here.
    expect(doubted.listenAndRepeat?.items.length).toBe(7);
  });
});
