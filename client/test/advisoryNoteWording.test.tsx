import { describe, expect, it, vi } from "vitest";
import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { SetAdvisoryNote } from "@toefl-prep/shared";
import { GenerateSetsDialog } from "../src/components/generation/GenerateSetsDialog";
import { SPEECH_RATE_ROLE, advisoryNoteLines } from "../src/ui/labels";

// A Set's advisory notes read the same wherever the User meets them: the Sets page's rows and the
// replace-a-Set choice in Generate Sets both go through `advisoryNoteLines` in ui/labels.ts, which
// words each kind once and leaves out the kinds the User cannot act on.

vi.mock("../src/lib/api", () => ({ listSets: vi.fn() }));

// What the generator still writes onto a published Set. Banked Sets may carry retired kinds too;
// those keep their own entries in labels.ts and are covered by advisoryNoteLines.test.ts.
const PRODUCED: SetAdvisoryNote[] = [
  { check: "catalog-novelty", detail: "containment", taskType: "listen_choose", itemPosition: 0 },
  { check: "catalog-novelty", detail: "domain-balance", taskType: "build_sentence", itemPosition: 0 },
  ...[
    // Reading
    "word-count",
    "ctw-word-count-over",
    "item-language",
    "explanation-language",
    "academic-coverage",
    "explanation-length-ctw",
    "explanation-length-mcq",
    "ctw-gap-leak",
    "option-length-bias",
    "explanation-position-reference",
    "option-count",
    "module-difficulty-band",
    "passage-difficulty-band",
    "ctw-paragraph-difficulty-band",
    // Listening
    "syllable-estimate",
    "explanation-length",
    // Writing (Build a Sentence)
    "frame-final-punctuation",
    "tile-count",
    "distractor-count",
    "tile-final-punctuation",
    "tile-initial-capital",
    // Speaking
    "lr-word-count-over",
    "lr-clip-duration-over",
    "lr-clip-over-ceiling",
  ].map((detail): SetAdvisoryNote => ({ check: "content-gate", detail })),
  { check: "talk-register", detail: "below-task-register", taskType: "academic_talk", itemPosition: 0 },
  ...["lr-item", "interview-question", "lcr-utterance", "conversation", "announcement", "academic-talk"].map(
    (role): SetAdvisoryNote => ({ check: "speech-rate", detail: role, measuredWpm: 120, minWpm: 140, maxWpm: 180 }),
  ),
];

// Every clip role a speech-rate note can carry as its `detail`: the role policies in
// server/src/services/speakingAudioRenderer.ts and listeningAudioRenderer.ts.
const SPEECH_RATE_ROLES = [
  "lr-briefing",
  "lr-item",
  "interview-intro",
  "interview-question",
  "lcr-utterance",
  "conversation",
  "announcement",
  "academic-talk",
];

// The line a note gets when labels.ts has no entry for its kind.
const UNKNOWN = /did not pass a check run when it was generated/;

describe("advisory note wording", () => {
  it.each(PRODUCED.map((note) => [`${note.check}/${note.detail}`, note] as const))("gives %s a sentence of its own", (_kind, note) => {
    for (const line of advisoryNoteLines([note])) expect(line).not.toMatch(UNKNOWN);
  });

  it("knows every clip role a speech-rate note names, so none reads as an anonymous recording", () => {
    for (const role of SPEECH_RATE_ROLES) expect(SPEECH_RATE_ROLE[role], role).toBeDefined();
  });

  it("hides the notes a learner cannot use: Plan drift and an unscored introduction's pace", () => {
    expect(advisoryNoteLines([{ check: "plan-conformance", detail: "domain-drift", taskType: "conversation", itemPosition: 0 }])).toEqual([]);
    expect(advisoryNoteLines([{ check: "speech-rate", detail: "lr-briefing", measuredWpm: 120, minWpm: 140, maxWpm: 180 }])).toEqual([]);
  });
});

describe("the replace-a-Set choice in Generate Sets", () => {
  it("words the Set's notes as the Sets page does, and leaves out the ones a learner cannot use", async () => {
    const api = await import("../src/lib/api");
    const notes: SetAdvisoryNote[] = [
      { check: "catalog-novelty", detail: "containment", taskType: "conversation", itemPosition: 0, conflictingSetIds: ["lsn-0"] },
      { check: "catalog-novelty", detail: "jaccard", taskType: "conversation", itemPosition: 0, conflictingSetIds: ["lsn-0"] },
      { check: "plan-conformance", detail: "domain-drift", taskType: "conversation", itemPosition: 0 },
    ];
    vi.mocked(api.listSets).mockResolvedValue([
      {
        id: "lsn-1",
        kind: "listening",
        source: "generated",
        createdAt: "2026-11-01T00:00:00.000Z",
        title: "Neuroscience Talk",
        summary: null,
        attempted: false,
        advisoryNotes: notes,
      },
    ]);
    render(<GenerateSetsDialog open onClose={() => {}} onStart={() => {}} busy={false} setup={null} />);
    await userEvent.click(screen.getByRole("button", { name: "Fewer Writing Sets" }));
    await userEvent.click(screen.getByRole("button", { name: "More Listening Sets" }));

    const expected = advisoryNoteLines(notes);
    expect(expected).toEqual(["One part of this Set repeats content from another Set in your bank."]);
    const notice = (await screen.findByText(/“Neuroscience Talk” carries 1 note/)).closest("[role='note'], div")!;
    const items = within(notice.parentElement as HTMLElement).getAllByRole("listitem").map((li) => li.textContent);
    expect(items).toEqual(expected);
    expect(screen.queryByText(/containment|jaccard|lsn-0|Drifted from its plan|Overlaps your existing bank/)).toBeNull();
  });
});
