import type { Section } from "@toefl-prep/shared";

// Every number the generation UI states about cost and time, in one place: the picker's cost line,
// the batch confirmation and the progress panels all read from here.

/** The sections a run can be asked for, in test order: the order the picker lists them and a batch queues them. */
export const GENERATION_SECTIONS: readonly Section[] = ["reading", "listening", "writing", "speaking"];

/** One number per section: a rate, or how many Sets are asked for. */
export type PerSection = Record<Section, number>;

/** The most Sets one request may ask for. Mirrors MAX_BATCH_TOTAL in server/src/routes/generate.ts, which refuses more. */
export const MAX_BATCH_TOTAL = 10;

/** How many Sets of a batch run past planning at once. Mirrors GENERATION_BATCH_WINDOW in server/src/services/generationBatchWindow.ts. */
export const BATCH_WINDOW = 7;

/** Text-to-speech clips in every Speaking Set: 1 briefing, 7 Listen and Repeat, 1 interview intro, 4 questions. */
export const SPEAKING_CLIPS_PER_SET = 13;

type SectionCost = {
  /** Structured AI calls (Claude, or Codex standing in) on the normal path. */
  calls: number;
  /**
   * The ceiling once bounded retries for variety run (up to three Plans and three drafts). Each
   * section's own repair passes inside a step are capped separately and not counted here.
   */
  maxCalls: number;
  /** Text-to-speech clips at one take each; null where the count depends on the Set. */
  clips: number | null;
  /** Text-to-speech calls if every clip needs its pace corrected as often as it may be; null as above. */
  maxClipCalls: number | null;
  /** How long one Set has taken, as a range: the time includes waiting for the AI CLIs. */
  duration: string;
  /** What its audio involves, in a sentence; null for a Set with none. */
  audio: string | null;
};

export const SECTION_COST: Record<Section, SectionCost> = {
  // Plan, then one draft whose four Complete the Words passages each get an Explanation call, then verify.
  reading: { calls: 7, maxCalls: 19, clips: null, maxClipCalls: null, duration: "about 20 minutes to an hour", audio: null },
  // Plan, draft, verify; verify may take up to five calls of its own.
  listening: {
    calls: 3,
    maxCalls: 11,
    clips: null,
    maxClipCalls: null,
    duration: "about 40 minutes to an hour and a half",
    audio:
      "Each Listening Set records one audio clip per Stimulus (a Conversation is one clip for the whole dialogue), so its clip count depends on the Set. A clip whose pace misses its range is recorded again, up to three more times.",
  },
  // Plan, draft, verify Build a Sentence.
  writing: { calls: 3, maxCalls: 7, clips: 0, maxClipCalls: 0, duration: "about 5 to 25 minutes", audio: null },
  // Plan and draft, then 13 clips, each recorded once more if its pace misses its range.
  speaking: {
    calls: 2,
    maxCalls: 6,
    clips: SPEAKING_CLIPS_PER_SET,
    maxClipCalls: SPEAKING_CLIPS_PER_SET * 2,
    duration: "about 10 to 30 minutes",
    audio: `Each Speaking Set records ${SPEAKING_CLIPS_PER_SET} audio clips one after another; a clip whose pace misses its range is recorded once more.`,
  },
};

export type BatchCost = {
  /** Sets asked for. */
  total: number;
  calls: number;
  maxCalls: number;
  /** Clips whose count is known up front (Speaking's); Listening's are described, not counted. */
  clips: number;
  maxClipCalls: number;
  /** The sections in the mix that carry audio, for their sentences. */
  audioSections: Section[];
};

/** What a mix of Sets costs: each section's count times its rates, summed. */
export function batchCost(counts: PerSection): BatchCost {
  const sum = (rate: (cost: SectionCost) => number) =>
    GENERATION_SECTIONS.reduce((total, section) => total + counts[section] * rate(SECTION_COST[section]), 0);
  return {
    total: sum(() => 1),
    calls: sum((c) => c.calls),
    maxCalls: sum((c) => c.maxCalls),
    clips: sum((c) => c.clips ?? 0),
    maxClipCalls: sum((c) => c.maxClipCalls ?? 0),
    audioSections: GENERATION_SECTIONS.filter((section) => counts[section] > 0 && SECTION_COST[section].audio !== null),
  };
}

/** "1 Set", "3 Sets". */
export function setCount(n: number): string {
  return `${n} ${n === 1 ? "Set" : "Sets"}`;
}

/** The one-line cost under the picker: "3 Sets · about 8 AI calls · 13 Speaking audio clips · Listening audio". */
export function costLine(cost: BatchCost): string {
  const parts = [setCount(cost.total), `about ${cost.calls} AI ${cost.calls === 1 ? "call" : "calls"}`];
  if (cost.clips > 0) parts.push(`${cost.clips} Speaking audio clips`);
  if (cost.audioSections.includes("listening")) parts.push("Listening audio");
  return parts.join(" · ");
}
