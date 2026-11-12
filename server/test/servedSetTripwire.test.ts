import { describe, expect, it } from "vitest";
import { stripAnswers, type AnySet } from "@toefl-prep/shared";
import { config } from "../src/lib/config.js";
import { createSetStore } from "../src/services/setStore.js";
import { scrambleBuildASentenceTiles } from "../src/services/tileScramble.js";

// `stripAnswers` removes the fields it names and passes everything else through, so a field added to
// a Set schema is served by default. This file is the tripwire for that: it computes every key path
// GET /api/sets/:id serves, across every committed Set (this file's seeded copy of the bank, so a Set
// generated locally and never committed cannot change the result), and compares the
// result with the reviewed list below. A new served path fails here until someone decides it names
// no answer and adds it; a path that stops being served fails too, so the list never carries an
// entry nothing serves.
//
// Paths are dotted object keys with `[]` for an array element. Reading and Listening serve three
// identically stripped modules (router, lowerModule, upperModule); their paths are folded into one
// `<module>` prefix so each module path is reviewed once.

const ALLOWED: Record<AnySet["kind"], readonly string[]> = {
  speaking: [
    "advisoryNotes", "advisoryNotes[].check", "advisoryNotes[].detail", "advisoryNotes[].maxWpm",
    "advisoryNotes[].measuredWpm", "advisoryNotes[].minWpm", "advisoryNotes[].take",
    "advisoryNotes[].targetWpm", "advisoryNotes[].taskType",
    "createdAt", "id", "kind", "source",
    "interview", "interview.intro", "interview.introAudio", "interview.scenarioTitle",
    // No `question`: the question text is what the User answers sight unseen.
    "interview.questions", "interview.questions[].audio", "interview.questions[].id",
    "interview.questions[].responseWindowSec", "interview.questions[].type",
    "listenAndRepeat", "listenAndRepeat.introAudio", "listenAndRepeat.scenarioDescription",
    "listenAndRepeat.scenarioTitle",
    // No `prompt`: the scene prompt lists all seven target sentences.
    "listenAndRepeat.image", "listenAndRepeat.image.file", "listenAndRepeat.image.model",
    // No `sentence`: the target sentence is what the User repeats back.
    "listenAndRepeat.items", "listenAndRepeat.items[].audio", "listenAndRepeat.items[].id",
    "listenAndRepeat.items[].responseWindowSec",
    "listenAndRepeat.items[].focusRegion", "listenAndRepeat.items[].focusRegion.h",
    "listenAndRepeat.items[].focusRegion.w", "listenAndRepeat.items[].focusRegion.x",
    "listenAndRepeat.items[].focusRegion.y",
  ],
  writing: [
    "createdAt", "id", "kind", "source",
    // No `answers`; `tiles` is served in an order drawn per request.
    "buildASentence", "buildASentence.items", "buildASentence.items[].frame", "buildASentence.items[].id",
    "buildASentence.items[].prompt", "buildASentence.items[].tiles", "buildASentence.items[].timeLimitSec",
    "email", "email.bullets", "email.id", "email.scenario", "email.subject", "email.timeLimitSec", "email.to",
    "email.wordGuidance", "email.wordGuidance.max", "email.wordGuidance.min",
    "academicDiscussion", "academicDiscussion.courseTitle", "academicDiscussion.id",
    "academicDiscussion.minWords", "academicDiscussion.professorName", "academicDiscussion.professorPost",
    "academicDiscussion.studentPosts", "academicDiscussion.studentPosts[].name",
    "academicDiscussion.studentPosts[].post", "academicDiscussion.timeLimitSec",
  ],
  reading: [
    "advisoryNotes", "advisoryNotes[].check", "advisoryNotes[].detail", "advisoryNotes[].itemPosition",
    "advisoryNotes[].taskType",
    "createdAt", "id", "kind", "source",
    "<module>", "<module>.timeLimitSec",
    // No `sourceParagraph`, and no gap `completion`/`explanationZh`: the deleted letters.
    "<module>.ctwPassages", "<module>.ctwPassages[].id", "<module>.ctwPassages[].taskType",
    "<module>.ctwPassages[].topic",
    "<module>.ctwPassages[].gaps", "<module>.ctwPassages[].gaps[].blankLength", "<module>.ctwPassages[].gaps[].id",
    "<module>.ctwPassages[].gaps[].prefix",
    "<module>.ctwPassages[].segments", "<module>.ctwPassages[].segments[].gapId",
    "<module>.ctwPassages[].segments[].text", "<module>.ctwPassages[].segments[].type",
    // No `correctOptionId`, `skill` or `explanationZh` on any question.
    "<module>.dailyLife", "<module>.dailyLife[].genre", "<module>.dailyLife[].id", "<module>.dailyLife[].taskType",
    "<module>.dailyLife[].text",
    "<module>.dailyLife[].questions", "<module>.dailyLife[].questions[].id", "<module>.dailyLife[].questions[].stem",
    "<module>.dailyLife[].questions[].options", "<module>.dailyLife[].questions[].options[].id",
    "<module>.dailyLife[].questions[].options[].text",
    "<module>.academic", "<module>.academic[].discipline", "<module>.academic[].id", "<module>.academic[].taskType",
    "<module>.academic[].text", "<module>.academic[].title",
    "<module>.academic[].questions", "<module>.academic[].questions[].id", "<module>.academic[].questions[].stem",
    "<module>.academic[].questions[].options", "<module>.academic[].questions[].options[].id",
    "<module>.academic[].questions[].options[].text",
  ],
  listening: [
    "advisoryNotes", "advisoryNotes[].check", "advisoryNotes[].clipId",
    "advisoryNotes[].conflictingSetIds", "advisoryNotes[].detail",
    "advisoryNotes[].itemPosition", "advisoryNotes[].maxWpm", "advisoryNotes[].measuredWpm",
    "advisoryNotes[].minWpm", "advisoryNotes[].score", "advisoryNotes[].take", "advisoryNotes[].targetWpm",
    "advisoryNotes[].taskType",
    "createdAt", "id", "kind", "source",
    "<module>", "<module>.timeLimitSec",
    // No `utterance`, ever, and no MCQ key/skill/explanation. Speakers lose `voice`/`provider`.
    "<module>.listenChoose", "<module>.listenChoose[].audio", "<module>.listenChoose[].id",
    "<module>.listenChoose[].taskType",
    "<module>.listenChoose[].options", "<module>.listenChoose[].options[].id",
    "<module>.listenChoose[].options[].text",
    "<module>.listenChoose[].speaker", "<module>.listenChoose[].speaker.accent",
    "<module>.listenChoose[].speaker.gender", "<module>.listenChoose[].speaker.id",
    "<module>.listenChoose[].speaker.role",
    // No `transcript` on any of the three Stimulus shapes below.
    "<module>.conversations", "<module>.conversations[].audio", "<module>.conversations[].id",
    "<module>.conversations[].setting", "<module>.conversations[].taskType",
    "<module>.conversations[].speakers", "<module>.conversations[].speakers[].accent",
    "<module>.conversations[].speakers[].gender", "<module>.conversations[].speakers[].id",
    "<module>.conversations[].speakers[].role",
    "<module>.conversations[].questions", "<module>.conversations[].questions[].id",
    "<module>.conversations[].questions[].stem", "<module>.conversations[].questions[].options",
    "<module>.conversations[].questions[].options[].id", "<module>.conversations[].questions[].options[].text",
    "<module>.announcements", "<module>.announcements[].audio", "<module>.announcements[].id",
    "<module>.announcements[].setting", "<module>.announcements[].taskType",
    "<module>.announcements[].speaker", "<module>.announcements[].speaker.accent",
    "<module>.announcements[].speaker.gender", "<module>.announcements[].speaker.id",
    "<module>.announcements[].speaker.role",
    "<module>.announcements[].questions", "<module>.announcements[].questions[].id",
    "<module>.announcements[].questions[].stem", "<module>.announcements[].questions[].options",
    "<module>.announcements[].questions[].options[].id", "<module>.announcements[].questions[].options[].text",
    "<module>.academicTalks", "<module>.academicTalks[].audio", "<module>.academicTalks[].discipline",
    "<module>.academicTalks[].id", "<module>.academicTalks[].taskType",
    "<module>.academicTalks[].speaker", "<module>.academicTalks[].speaker.accent",
    "<module>.academicTalks[].speaker.gender", "<module>.academicTalks[].speaker.id",
    "<module>.academicTalks[].speaker.role",
    "<module>.academicTalks[].questions", "<module>.academicTalks[].questions[].id",
    "<module>.academicTalks[].questions[].stem", "<module>.academicTalks[].questions[].options",
    "<module>.academicTalks[].questions[].options[].id", "<module>.academicTalks[].questions[].options[].text",
  ],
};

const MODULE_PREFIX = /^(router|lowerModule|upperModule)(?=\.|$)/;

function collectPaths(value: unknown, prefix: string, out: Set<string>): void {
  if (Array.isArray(value)) {
    for (const element of value) collectPaths(element, `${prefix}[]`, out);
    return;
  }
  if (value === null || typeof value !== "object") return;
  for (const [key, child] of Object.entries(value)) {
    const keyPath = prefix ? `${prefix}.${key}` : key;
    out.add(keyPath.replace(MODULE_PREFIX, "<module>"));
    collectPaths(child, keyPath, out);
  }
}

/** What GET /api/sets/:id puts on the wire for `set`, in the route's own order of operations. */
function served(set: AnySet): unknown {
  return stripAnswers(scrambleBuildASentenceTiles(set));
}

function servedPaths(sets: readonly AnySet[]): Set<string> {
  const paths = new Set<string>();
  for (const set of sets) collectPaths(served(set), "", paths);
  return paths;
}

function compare(kind: AnySet["kind"], paths: Set<string>) {
  const allowed = new Set(ALLOWED[kind]);
  return {
    unreviewed: [...paths].filter((p) => !allowed.has(p)).sort(),
    neverServed: [...allowed].filter((p) => !paths.has(p)).sort(),
  };
}

const bank = createSetStore(config.dataDir).scanBank().sets.map((banked) => banked.set);

describe("served Set key paths across the tracked bank", () => {
  for (const kind of Object.keys(ALLOWED) as AnySet["kind"][]) {
    it(`${kind}: every served path is on the reviewed list, and every listed path is served`, () => {
      const sets = bank.filter((set) => set.kind === kind);
      expect(sets.length).toBeGreaterThan(0);
      expect(compare(kind, servedPaths(sets))).toEqual({ unreviewed: [], neverServed: [] });
    });
  }

  it("catches a field the strip does not name", () => {
    const speaking = bank.find((set) => set.kind === "speaking")!;
    const withNewField = structuredClone(speaking) as AnySet & { listenAndRepeat: { items: object[] } };
    Object.assign(withNewField.listenAndRepeat.items[0]!, { sentenceHint: "the target sentence" });
    expect(compare("speaking", servedPaths([withNewField])).unreviewed).toEqual([
      "listenAndRepeat.items[].sentenceHint",
    ]);
  });
});
