import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { AnySetSchema, type AnySet, type SpeakingSet, type WritingSet } from "@toefl-prep/shared";
import { config } from "../src/lib/config.js";
import { SET_TITLE_MAX_LENGTH, setTitleFor } from "../src/services/setTitle.js";
import { LISTENING_FIXTURE } from "./fixtures/listening-set.fixture.js";
import { READING_FIXTURE } from "./fixtures/reading-set.fixture.js";

// What the practice lists call a Set. Derived from the Set's own content, through the served form,
// so a title can only quote text the User is shown anyway.

const SECRET = "ANSWER-BEARING-SECRET";

function speakingSet(over: { lrTitle?: string; interviewTitle?: string } = {}): SpeakingSet {
  return {
    id: "spk-title", kind: "speaking", source: "generated", createdAt: "2026-08-01T00:00:00.000Z",
    listenAndRepeat: {
      scenarioTitle: over.lrTitle ?? "Roommate Move-In Walkthrough",
      scenarioDescription: "You're giving your new roommate a quick tour of the apartment.",
      items: Array.from({ length: 7 }, (_, i) => ({
        id: `lr${i + 1}`,
        sentence: `${SECRET} sentence ${i + 1}.`,
        audio: `stimuli/spk-title/lr${i + 1}.mp3`,
        responseWindowSec: i < 2 ? 8 : i < 5 ? 10 : 12,
      })),
    },
    interview: {
      scenarioTitle: over.interviewTitle ?? "Campus Club Participation Survey",
      intro: "Thanks for joining us today.",
      questions: Array.from({ length: 4 }, (_, i) => ({
        id: `iq${i + 1}`, type: i < 2 ? "factual" : "opinion",
        question: `${SECRET} question ${i + 1}?`, audio: `stimuli/spk-title/iq${i + 1}.mp3`,
        responseWindowSec: 45,
      })),
    },
  } as SpeakingSet;
}

function writingSet(subject = "Comments on the proposed route 9 timetable"): WritingSet {
  return {
    id: "wri-title", kind: "writing", source: "generated", createdAt: "2026-08-01T00:00:00.000Z",
    buildASentence: {
      items: Array.from({ length: 10 }, (_, i) => ({
        id: `bas-${i + 1}`, prompt: `Prompt ${i + 1}?`, tiles: ["a", "b", "c"],
        answers: [[SECRET, "b", "c"]],
      })),
    },
    email: {
      id: "em1", scenario: "Rowley Regional Transit has announced a change.", to: "t@u.edu", subject,
      bullets: ["1", "2", "3"], timeLimitSec: 420, wordGuidance: { min: 80, max: 120 },
    },
    academicDiscussion: {
      id: "ad1", courseTitle: "Business 214: Work and Organizations", professorName: "Dr. Lee",
      professorPost: "Should companies allow remote work?",
      studentPosts: [{ name: "A", post: "yes" }, { name: "B", post: "no" }],
      timeLimitSec: 600, minWords: 100,
    },
  } as WritingSet;
}

describe("setTitleFor — one title per section, from what the learner is shown", () => {
  it("Speaking: the Listen and Repeat scenario, with the Interview scenario as the summary", () => {
    expect(setTitleFor(speakingSet())).toEqual({
      title: "Roommate Move-In Walkthrough",
      summary: "Interview · Campus Club Participation Survey",
    });
  });

  it("Writing: the email subject, with the Academic Discussion course as the summary", () => {
    expect(setTitleFor(writingSet())).toEqual({
      title: "Comments on the proposed route 9 timetable",
      summary: "Academic Discussion · Business 214: Work and Organizations",
    });
  });

  it("Reading: the Router Module's academic passage title, with every passage's discipline as the summary", () => {
    expect(setTitleFor(READING_FIXTURE)).toEqual({
      title: "The Mirror Test",
      summary: "Academic passages · life science",
    });
  });

  it("Listening: the Router Module's first conversation setting, with the talk disciplines as the summary", () => {
    expect(setTitleFor(LISTENING_FIXTURE)).toEqual({
      title: "Campus dining hall",
      summary: "Academic talks · marine biology, astronomy",
    });
  });

  it("drops a leading article and anything after the first comma of a Listening setting", () => {
    const set = structuredClone(LISTENING_FIXTURE);
    set.router.conversations[0]!.setting =
      "a university student housing office during move-in week, following up on a delayed room key issue";
    expect(setTitleFor(set).title).toBe("University student housing office during move-in week");
  });

  it("lists a discipline once even when two talks share it", () => {
    const set = structuredClone(LISTENING_FIXTURE);
    set.upperModule.academicTalks[0]!.discipline = "marine biology";
    expect(setTitleFor(set).summary).toBe("Academic talks · marine biology");
  });
});

describe("setTitleFor — length and whitespace", () => {
  it(`never exceeds ${SET_TITLE_MAX_LENGTH} characters, cutting at a word boundary with an ellipsis`, () => {
    const subject = "Cracked Screen on New Laptop – Need a Replacement Before This Week's Deadline";
    const { title } = setTitleFor(writingSet(subject));
    expect(title.length).toBeLessThanOrEqual(SET_TITLE_MAX_LENGTH);
    expect(title).toBe("Cracked Screen on New Laptop – Need a Replacement Before…");
  });

  it("collapses runs of whitespace and trims", () => {
    expect(setTitleFor(speakingSet({ lrTitle: "  Lighting \n Booth   Orientation " })).title).toBe("Lighting Booth Orientation");
  });

  it("falls back to the Interview scenario, then to a kind label, rather than an empty title", () => {
    expect(setTitleFor(speakingSet({ lrTitle: "   " })).title).toBe("Campus Club Participation Survey");
    expect(setTitleFor(speakingSet({ lrTitle: "   ", interviewTitle: "" })).title).toBe("Untitled Speaking Set");
  });

  it("omits the summary when there is nothing to summarise", () => {
    expect(setTitleFor(speakingSet({ interviewTitle: "" })).summary).toBeNull();
  });

  it("falls back for a Reading Set whose Router Module has no academic passage", () => {
    const set = structuredClone(READING_FIXTURE);
    set.router.academic = [];
    expect(setTitleFor(set)).toEqual({ title: "Prehistoric dance", summary: null });
  });
});

describe("setTitleFor — never answer-bearing", () => {
  it("quotes no L&R target sentence, interview question or Build a Sentence key", () => {
    for (const set of [speakingSet(), writingSet()]) {
      const { title, summary } = setTitleFor(set);
      expect(`${title} ${summary ?? ""}`).not.toContain(SECRET);
    }
  });

  it("quotes no transcript, utterance, completion, key or explanation from a Reading or Listening Set", () => {
    const answerBearing = [
      ...LISTENING_FIXTURE.router.listenChoose.map((item) => item.utterance),
      ...LISTENING_FIXTURE.router.announcements.map((a) => a.transcript),
      ...LISTENING_FIXTURE.router.academicTalks.map((t) => t.transcript),
      ...LISTENING_FIXTURE.router.conversations.flatMap((c) => c.transcript.map((turn) => turn.text)),
      ...READING_FIXTURE.router.ctwPassages.flatMap((p) => p.gaps.flatMap((g) => [g.completion, g.explanationZh])),
      ...READING_FIXTURE.router.academic.flatMap((p) => p.questions.map((q) => q.explanationZh)),
    ];
    for (const set of [READING_FIXTURE, LISTENING_FIXTURE]) {
      const { title, summary } = setTitleFor(set);
      for (const secret of answerBearing) {
        expect(title).not.toContain(secret);
        expect(summary ?? "").not.toContain(secret);
      }
    }
  });
});

describe("setTitleFor over the real bank", () => {
  // Every committed Set gets a non-empty title within bounds. Read from this file's seeded copy of
  // the bank, so a Set generated locally and never committed cannot change the result.
  it("gives every banked Set a bounded, non-empty title", () => {
    const bank = path.join(config.dataDir, "question-sets");
    let checked = 0;
    for (const kind of ["speaking", "writing", "reading", "listening"]) {
      const dir = path.join(bank, kind);
      if (!fs.existsSync(dir)) continue;
      for (const file of fs.readdirSync(dir).filter((f) => f.endsWith(".json"))) {
        const parsed = AnySetSchema.safeParse(JSON.parse(fs.readFileSync(path.join(dir, file), "utf8")));
        if (!parsed.success) continue;
        const { title, summary } = setTitleFor(parsed.data as AnySet);
        expect(title.trim().length).toBeGreaterThan(0);
        expect(title.length).toBeLessThanOrEqual(SET_TITLE_MAX_LENGTH);
        expect(title.startsWith("Untitled")).toBe(false);
        if (summary !== null) expect(summary.length).toBeGreaterThan(0);
        checked += 1;
      }
    }
    expect(checked).toBeGreaterThan(0);
  });
});
