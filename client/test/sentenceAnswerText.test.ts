import { describe, expect, it } from "vitest";
import { FRAME_BLANK_MARKER } from "@toefl-prep/shared";
import { sentenceAnswerText } from "../src/components/sentenceAnswerText";

// The project's own reference Item (server/test/fixtures/build-a-sentence-reference-item.json): six
// blanks, seven tiles, "was" the distractor. Its `completedSentence` is the string this module has to
// reproduce from the frame plus the six placed tiles; the tiles alone would read back as a fragment.
const FRAME = "The ___ ___ ___ ___ ___ ___ wonderful.";
const ANSWER = ["volunteers", "who", "led us through", "the", "new wing", "were"];
const SENTENCE = "The volunteers who led us through the new wing were wonderful.";

describe("sentenceAnswerText with a frame", () => {
  it("reads back as the whole sentence, frame text included", () => {
    expect(sentenceAnswerText(FRAME, ANSWER)).toBe(SENTENCE);
  });

  it("keeps the frame's own spacing verbatim, including a frame that opens or closes on a blank", () => {
    expect(sentenceAnswerText("___ were wonderful.", ["The volunteers"])).toBe("The volunteers were wonderful.");
    expect(sentenceAnswerText("The visit was ___", ["wonderful."])).toBe("The visit was wonderful.");
  });

  it("marks the blanks a partial answer never reached, instead of closing the sentence up", () => {
    // A Response is tile texts in blank order with the empty blanks dropped (blankOrderTexts), so
    // which blanks were left empty is not recoverable. The texts fill from the left, exactly as they
    // were scored, and the shortfall shows as blanks.
    expect(sentenceAnswerText(FRAME, ["volunteers", "who"])).toBe(
      `The volunteers who ${FRAME_BLANK_MARKER} ${FRAME_BLANK_MARKER} ${FRAME_BLANK_MARKER} ${FRAME_BLANK_MARKER} wonderful.`,
    );
  });

  it("draws every blank as a blank when nothing was placed at all", () => {
    expect(sentenceAnswerText(FRAME, [])).toBe(FRAME);
  });

  it("keeps texts that outnumber the blanks rather than dropping them", () => {
    // Unreachable from the Drill (the arrangement has exactly one slot per blank), but silently
    // swallowing part of a User's Response would be the worst possible way to be wrong.
    expect(sentenceAnswerText("___ wonderful.", ["The visit was", "really", "truly"])).toBe(
      "The visit was wonderful. really truly",
    );
  });
});

describe("sentenceAnswerText without a usable frame", () => {
  it("joins the tile texts with spaces, exactly as a frameless Item has always rendered", () => {
    expect(sentenceAnswerText(undefined, ["The volunteers", "were", "wonderful."])).toBe(
      "The volunteers were wonderful.",
    );
    expect(sentenceAnswerText(undefined, [])).toBe("");
  });

  it("falls back to the same join rather than throwing on a frame that does not parse", () => {
    // `BuildASentenceItemSchema` rejects these before a Set is ever served, so this is the same
    // defensive stance SentenceTiles takes: a bad frame must not blank the results view.
    expect(sentenceAnswerText("", ANSWER)).toBe(ANSWER.join(" "));
    expect(sentenceAnswerText("no blanks here", ANSWER)).toBe(ANSWER.join(" "));
  });
});
