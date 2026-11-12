import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  AnySetSchema,
  BuildASentenceItemSchema,
  FRAME_BLANK_MARKER,
  SentenceFrameError,
  WritingGenerationInputSchema,
  parseSentenceFrame,
  stripAnswers,
  toPersistedWritingSet,
  type SentenceFrameSegment,
  type WritingSet,
} from "@toefl-prep/shared";
import { config } from "../src/lib/config.js";

// The reference Item: this project's own, in the shape of the one Item ETS publishes (see the
// fixture's sourceNote). Read from disk rather than inlined so the fixture stays the single copy
// every consumer checks against.
const REFERENCE_ITEM = JSON.parse(fs.readFileSync(
  path.join(config.projectRoot, "server/test/fixtures/build-a-sentence-reference-item.json"),
  "utf8",
)) as { item: unknown; completedSentence: string };
const REFERENCE_FRAME = "The ___ ___ ___ ___ ___ ___ wonderful.";

/** The learner-visible sentence: frame literals in order, each blank replaced by its filled tile. */
function fillFrame(frame: string, fills: readonly string[]): string {
  return parseSentenceFrame(frame)
    .map((seg) => (seg.type === "text" ? seg.text : fills[seg.index]))
    .join("");
}

const blanksOf = (segments: readonly SentenceFrameSegment[]) => segments.filter((s) => s.type === "blank");

describe("parseSentenceFrame", () => {
  it("splits the reference frame into alternating literals and six ordered blanks", () => {
    const segments = parseSentenceFrame(REFERENCE_FRAME);

    expect(segments[0]).toEqual({ type: "text", text: "The " });
    expect(segments.at(-1)).toEqual({ type: "text", text: " wonderful." });
    expect(blanksOf(segments).map((b) => b.index)).toEqual([0, 1, 2, 3, 4, 5]);
    // Every literal between two blanks survives verbatim, so a renderer can concatenate the
    // segments back into the frame it was given.
    expect(segments.map((s) => (s.type === "text" ? s.text : FRAME_BLANK_MARKER)).join(""))
      .toBe(REFERENCE_FRAME);
  });

  it("reads a run of any length past three as exactly one blank", () => {
    // ETS's own overview draws each blank as six underscores, and a frame copied from that layout
    // must mean the same six-blank frame as the three-underscore form this app writes, or the two
    // would silently disagree about the blank count.
    const long = parseSentenceFrame("The ______ ______ ______ ______ ______ ______ wonderful.");
    expect(blanksOf(long)).toHaveLength(6);

    // Mixed run lengths within one frame are the same story.
    expect(blanksOf(parseSentenceFrame("___ and _____."))).toHaveLength(2);
  });

  it("emits no empty literal when a blank opens or closes the frame", () => {
    expect(parseSentenceFrame("___ is ___")).toEqual([
      { type: "blank", index: 0 },
      { type: "text", text: " is " },
      { type: "blank", index: 1 },
    ]);
  });

  // The two frame shapes seen on the real exam: one that opens with a blank, and a full reorder.
  // The conformance gate and the renderer both depend on this parse.
  it("parses a frame that BEGINS with a blank, emitting no phantom leading literal", () => {
    const segments = parseSentenceFrame("___ ___ ___ ___ ___ ___ the deadline.");

    expect(segments[0]).toEqual({ type: "blank", index: 0 });
    expect(segments.at(-1)).toEqual({ type: "text", text: " the deadline." });
    expect(blanksOf(segments)).toHaveLength(6);
  });

  it("parses a full reorder — nothing fixed but the sentence-final punctuation", () => {
    const segments = parseSentenceFrame("___ ___ ___ ___ ___ ___ ___ ___ ___.");

    expect(blanksOf(segments).map((b) => b.index)).toEqual([0, 1, 2, 3, 4, 5, 6, 7, 8]);
    // A renderer draws nine boxes and one full stop, with no leading literal at all: the first
    // segment is the first blank, and the only tail is the period.
    expect(segments[0]).toEqual({ type: "blank", index: 0 });
    expect(segments.at(-1)).toEqual({ type: "text", text: "." });
    expect(segments.map((s) => (s.type === "text" ? s.text : FRAME_BLANK_MARKER)).join(""))
      .toBe("___ ___ ___ ___ ___ ___ ___ ___ ___.");
  });

  it("keeps a blank that abuts its neighbouring words, without inventing whitespace", () => {
    expect(parseSentenceFrame("(___)")).toEqual([
      { type: "text", text: "(" },
      { type: "blank", index: 0 },
      { type: "text", text: ")" },
    ]);
  });

  it("rejects a frame with no blanks", () => {
    expect(() => parseSentenceFrame("The volunteers were wonderful.")).toThrow(SentenceFrameError);
    expect(() => parseSentenceFrame("The volunteers were wonderful.")).toThrow(/no blanks/);
  });

  it("rejects an empty or whitespace-only frame", () => {
    expect(() => parseSentenceFrame("")).toThrow(SentenceFrameError);
    expect(() => parseSentenceFrame("   \n ")).toThrow(SentenceFrameError);
  });

  it("rejects a one- or two-underscore run rather than reading it as literal text", () => {
    // Almost always a mistyped blank. Read as literal text, it would give a frame with one blank
    // fewer than the author meant, which then fails the blank/tile arithmetic far from the typo.
    expect(() => parseSentenceFrame("The __ ___ wonderful.")).toThrow(SentenceFrameError);
    expect(() => parseSentenceFrame("The _ ___ wonderful.")).toThrow(/underscore/);
  });

  it("names no frame content in its error messages", () => {
    // Same rule routes/sets.ts's safeSetErrorDescriptor follows: a frame is Item content, and these
    // messages travel into schema issues and logs.
    for (const bad of ["A secretword sentence.", "A secretword __ sentence."]) {
      try {
        parseSentenceFrame(bad);
        expect.unreachable(`${bad} should not parse`);
      } catch (err) {
        expect(err).toBeInstanceOf(SentenceFrameError);
        expect((err as Error).message).not.toContain("secretword");
      }
    }
  });
});

describe("the reference Build a Sentence Item", () => {
  const item = BuildASentenceItemSchema.parse(REFERENCE_ITEM.item);

  it("is representable in frame form, with the opening word and the closing word fixed", () => {
    // What the frame field is for: without a frame, "The" and "wonderful." would have to be folded
    // into tiles, and each would give away its own position.
    expect(item.frame).toBe(REFERENCE_FRAME);
    expect(item.prompt).toBe("How did the museum visit go?");
    expect(fillFrame(item.frame!, item.answers[0])).toBe(REFERENCE_ITEM.completedSentence);
    expect(REFERENCE_ITEM.completedSentence)
      .toBe("The volunteers who led us through the new wing were wonderful.");
  });

  it("offers seven tiles for six blanks — one distractor, as ETS's published Item does", () => {
    const blanks = blanksOf(parseSentenceFrame(item.frame!)).length;
    expect(item.tiles).toHaveLength(7);
    expect(blanks).toBe(6);
    expect(item.answers[0]).toHaveLength(blanks);

    const unused = item.tiles.filter((tile) => !item.answers[0].includes(tile));
    expect(unused).toEqual(["was"]); // number agreement against plural "volunteers"
  });

  it("leaves capitalisation and the final period to the frame, never to a tile", () => {
    // A capitalised tile or one carrying the terminal "." leaks its own position: it can only be
    // first or last. Here the frame supplies both.
    for (const tile of item.tiles) {
      expect(tile).not.toMatch(/^[A-Z]/);
      expect(tile).not.toMatch(/[.!?]$/);
    }
  });

  it("keys its answers by tile text, never by blank index", () => {
    // `tiles` is re-drawn at serve time (tileScramble.ts), so an index-keyed answer would become a
    // different answer every time the Item is served.
    for (const answer of item.answers) {
      for (const token of answer) expect(item.tiles).toContain(token);
    }
  });
});

const legacyItem = {
  id: "bs1",
  prompt: "Who left this note on my desk?",
  tiles: ["write", "Daniel", "wrote", "it."],
  answers: [["Daniel", "wrote", "it."]],
};

const writingSetWith = (item: unknown): unknown => ({
  id: "wri-frame1", kind: "writing", source: "generated", createdAt: "2026-08-22T00:00:00Z",
  buildASentence: { items: Array.from({ length: 10 }, (_, i) => ({ ...(item as object), id: `bs${i + 1}` })) },
  email: {
    id: "em1", scenario: "s", to: "t@u.edu", subject: "x",
    bullets: ["1", "2", "3"], timeLimitSec: 420, wordGuidance: { min: 80, max: 120 },
  },
  academicDiscussion: {
    id: "ad1", courseTitle: "c", professorName: "p", professorPost: "q",
    studentPosts: [{ name: "A", post: "y" }, { name: "B", post: "n" }],
    timeLimitSec: 600, minWords: 100,
  },
});

describe("the frame field on a Writing Set", () => {
  it("is optional, so a legacy frameless Item still parses", () => {
    const parsed = AnySetSchema.parse(writingSetWith(legacyItem)) as WritingSet;
    expect(parsed.buildASentence.items[0]).not.toHaveProperty("frame");
  });

  it("round-trips a frame Item through the Set schema", () => {
    const parsed = AnySetSchema.parse(writingSetWith(REFERENCE_ITEM.item)) as WritingSet;
    expect(parsed.buildASentence.items[0].frame).toBe(REFERENCE_FRAME);
  });

  it("rejects a malformed frame, naming the frame field", () => {
    const noBlanks = AnySetSchema.safeParse(
      writingSetWith({ ...legacyItem, frame: "Daniel wrote it." }),
    );
    expect(noBlanks.success).toBe(false);
    const issue = noBlanks.error?.issues.find((i) => i.path.includes("frame"));
    expect(issue?.message).toMatch(/no blanks/);

    expect(AnySetSchema.safeParse(writingSetWith({ ...legacyItem, frame: "" })).success).toBe(false);
    expect(AnySetSchema.safeParse(writingSetWith({ ...legacyItem, frame: "__ wrote it." })).success)
      .toBe(false);
  });

  // `frame` is in the model-facing input in the one shape that passes the strict check every routed
  // schema is held to: required and nullable. An optional key would make isCodexStrictOutputSchema
  // false and fail Writing generation's Codex leg with `configuration` before any model saw the
  // prompt (reasoning.jsonSchema.test.ts checks every routed schema, this one included).
  it("is part of the model-facing generation input, required and nullable", () => {
    const parsed = WritingGenerationInputSchema.parse(writingSetWith(REFERENCE_ITEM.item));
    expect(parsed.buildASentence.items[0].frame).toBe(REFERENCE_FRAME);

    // Required: an Item that omits the key is refused, so the model cannot quietly emit frameless
    // Items.
    const { frame: _dropped, ...frameless } = REFERENCE_ITEM.item as Record<string, unknown>;
    expect(WritingGenerationInputSchema.safeParse(writingSetWith(frameless)).success).toBe(false);

    // Nullable: `null` is how a model says "no frame" under a schema that cannot carry an optional
    // key. It parses as generation input and is the shape the conformance gate reports as
    // `frame-missing`.
    expect(
      WritingGenerationInputSchema.parse(writingSetWith({ ...frameless, frame: null }))
        .buildASentence.items[0].frame,
    ).toBeNull();
  });

  it("loses its null on the way to the persisted Set", () => {
    // A persisted Item says "no frame" by having no key — one state, not two. toPersistedWritingSet
    // is the single seam that performs the conversion, and WritingSetSchema refuses `null` outright,
    // so a candidate that skipped the conversion fails at the moment the Set is minted rather than
    // writing a null into an immutable file.
    const { frame: _dropped, ...frameless } = REFERENCE_ITEM.item as Record<string, unknown>;
    const candidate = WritingGenerationInputSchema.parse(
      writingSetWith({ ...frameless, frame: null }),
    );

    const persisted = toPersistedWritingSet(candidate);

    expect(persisted.buildASentence.items[0]).not.toHaveProperty("frame");
    expect(AnySetSchema.safeParse(persisted).success).toBe(true);
    expect(AnySetSchema.safeParse(candidate).success).toBe(false);

    // A real frame survives it untouched.
    expect(
      toPersistedWritingSet(WritingGenerationInputSchema.parse(writingSetWith(REFERENCE_ITEM.item)))
        .buildASentence.items[0].frame,
    ).toBe(REFERENCE_FRAME);
  });

  it("survives stripAnswers — the frame is the question, not the answer", () => {
    // The client only ever receives a stripped Set, so dropping the frame here would leave the run
    // with nothing to render the blanks from.
    const stripped = stripAnswers(AnySetSchema.parse(writingSetWith(REFERENCE_ITEM.item)));
    if (stripped.kind !== "writing") throw new Error("kind changed");
    expect(stripped.buildASentence.items[0]).not.toHaveProperty("answers");
    expect(stripped.buildASentence.items[0].frame).toBe(REFERENCE_FRAME);
  });
});
