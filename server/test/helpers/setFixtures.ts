import fs from "node:fs";
import path from "node:path";
import { SpeakingSetSchema, type AnySet, type SpeakingSet } from "@toefl-prep/shared";
import { config } from "../../src/lib/config.js";

// Sets the server suite builds or reads in more than one file. Each builder returns a fresh object,
// so a test may mutate what it gets.

/**
 * A schema-valid Speaking Set with fixed placeholder text and every audio path empty, so a renderer
 * has all thirteen clips to synthesize: seven Listen and Repeat Items on the response-window ramp and
 * four opinion questions. The text's word counts are load-bearing in the pace suites
 * (audioPaceParity, clipTakePublication): briefing 5, each Item 7, intro 6, each question 8.
 */
export function placeholderSpeakingSet(id = "spk-001"): SpeakingSet {
  return SpeakingSetSchema.parse({
    id, kind: "speaking", source: "generated", createdAt: "2026-01-01T00:00:00.000Z",
    listenAndRepeat: {
      scenarioTitle: "Campus", scenarioDescription: "Welcome to the campus library.",
      items: Array.from({ length: 7 }, (_, i) => ({
        id: `lr-${i + 1}`, sentence: `This is listen repeat sentence number ${i + 1}.`, audio: "",
        responseWindowSec: ([8, 8, 10, 10, 10, 12, 12] as const)[i],
      })),
    },
    interview: {
      scenarioTitle: "Interview", intro: "Thank you for joining us today.", introAudio: "",
      questions: Array.from({ length: 4 }, (_, i) => ({
        id: `q-${i + 1}`, type: "opinion", question: `What is your opinion about topic number ${i + 1}?`,
        audio: "", responseWindowSec: 45,
      })),
    },
  });
}

/**
 * A Writing Set as the generate step returns it, before any gate parses it: ten conforming Build a
 * Sentence frame Items (5 blanks, 6 tiles, exactly one distractor "f", no tile carrying a capital or
 * a final stop), so the conformance gate accepts it and the candidate loop does not regenerate. `id`
 * is omitted unless given, as a model's output omits it.
 */
export function validWritingSet(id?: string) {
  return {
    ...(id === undefined ? {} : { id }),
    kind: "writing", source: "generated", createdAt: "2026-07-27T00:00:00Z",
    buildASentence: { items: Array.from({ length: 10 }, (_, i) => ({
      id: `bs${i + 1}`, prompt: `P${i + 1}?`,
      frame: "The ___ ___ ___ ___ ___ this morning.",
      tiles: ["a", "b", "c", "d", "e", "f"], answers: [["a", "b", "c", "d", "e"]] })) },
    email: { id: "em1", scenario: "s", to: "t@u.edu", subject: "x", bullets: ["1", "2", "3"], timeLimitSec: 420, wordGuidance: { min: 80, max: 120 } },
    academicDiscussion: { id: "ad1", courseTitle: "c", professorName: "p", professorPost: "q",
      studentPosts: [{ name: "A", post: "y" }, { name: "B", post: "n" }], timeLimitSec: 600, minWords: 100 },
  };
}

/**
 * A minimal Writing Set as a published file holds it: ten frameless Build a Sentence Items of three
 * tiles each, and placeholder email and discussion text. `subject` and `courseTitle` are the two
 * fields the listing and read-model suites search and display.
 */
export function framelessWritingSet(id: string, over: { subject?: string; courseTitle?: string } = {}) {
  return {
    id, kind: "writing", source: "generated", createdAt: "2026-07-27T00:00:00Z",
    buildASentence: { items: Array.from({ length: 10 }, (_, i) => ({
      id: `bs${i + 1}`, prompt: `P${i + 1}?`, tiles: ["a", "b", "c"], answers: [["a", "b", "c"]] })) },
    email: { id: "em1", scenario: "s", to: "t@u.edu", subject: over.subject ?? "x", bullets: ["1", "2", "3"], timeLimitSec: 420, wordGuidance: { min: 80, max: 120 } },
    academicDiscussion: { id: "ad1", courseTitle: over.courseTitle ?? "c", professorName: "p", professorPost: "q",
      studentPosts: [{ name: "A", post: "y" }, { name: "B", post: "n" }], timeLimitSec: 600, minWords: 100 },
  };
}

/**
 * A Speaking Set as the generate step returns it, before any gate parses it, with one-word
 * placeholder text ("S1.", "hi", "Q1?"): short enough that speakingConformance's word and clip
 * budgets pass, and what the suites' fixed-duration probe stubs are tuned to. `id` is omitted unless
 * given, as a model's output omits it.
 */
export function validSpeakingSet(id?: string) {
  return {
    ...(id === undefined ? {} : { id }),
    kind: "speaking", source: "generated", createdAt: "2026-07-27T00:00:00Z",
    listenAndRepeat: { scenarioTitle: "t", scenarioDescription: "d",
      items: Array.from({ length: 7 }, (_, i) => ({ id: `lr${i + 1}`, sentence: `S${i + 1}.`, audio: "",
        responseWindowSec: (i < 2 ? 8 : i < 5 ? 10 : 12) as 8 | 10 | 12 })) },
    interview: { scenarioTitle: "t", intro: "hi", introAudio: "",
      questions: Array.from({ length: 4 }, (_, i) => ({ id: `iq${i + 1}`, type: "factual" as const,
        question: `Q${i + 1}?`, audio: "", responseWindowSec: 45 as const })) },
  };
}

/** A banked Set, read straight off this test file's data directory with no schema parse. */
export function readBankSet<K extends AnySet["kind"]>(kind: K, id: string): Extract<AnySet, { kind: K }> {
  return JSON.parse(
    fs.readFileSync(path.join(config.dataDir, "question-sets", kind, `${id}.json`), "utf8"),
  ) as Extract<AnySet, { kind: K }>;
}
