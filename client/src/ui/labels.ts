import type {
  AttemptMode,
  AttemptStatus,
  FullTestRunStatus,
  FullTestSectionState,
  GenerationBatchStatus,
  GenerationJobStatus,
  ModulePath,
  ScoringJobStatus,
  Section,
  SetAdvisoryNote,
  TranscriptionJobStatus,
} from "@toefl-prep/shared";

// The one place a raw status, mode, source or method code becomes words on screen.
//
// A table for a code the shared package defines (Attempt, Full-Test Run and job statuses, Section,
// mode, Module Path) is keyed by that union, so a new status added to shared/src/viewModels.ts
// fails `tsc` here until it has a label — the same exhaustive-by-construction rule
// lib/taskTypes.ts follows for Task Type names (which are not restated here: import taskTypeLabel).
// Estimate methods, Deduction categories and advisory notes are keyed by string instead, and an
// unknown code falls back to `humanize` or a generic sentence.
// The tables are separate per domain on purpose: the same word means different things in each
// (an Attempt's `in_progress` is an unfinished practice run, a Full-Test Run's `in-progress` is a
// sitting you can resume, a job's `running` is a machine working).
//
// Copy rules (docs/design-system.md, "Copy"): say what the User needs to know first, in the
// vocabulary of CONTEXT.md; the raw code is never the primary label.

/** The colour role a status is drawn in. Never the only signal: every status also has a glyph and words. */
export type Tone = "neutral" | "accent" | "positive" | "caution" | "critical" | "correction";

/** The shape that carries a status without colour. See ui/icons.tsx's StatusGlyph. */
export type Glyph = "check" | "cross" | "progress" | "pending" | "caution" | "dash" | "none";

export type StatusPresentation = {
  label: string;
  tone: Tone;
  glyph: Glyph;
  /** One sentence for a tooltip or a secondary line: what this means for the User. */
  hint?: string;
};

export const ATTEMPT_STATUS: Record<AttemptStatus, StatusPresentation> = {
  in_progress: {
    label: "Unfinished",
    tone: "caution",
    glyph: "progress",
    hint: "Started but never submitted. Finish it to get it scored, or discard it.",
  },
  completed: { label: "Completed", tone: "positive", glyph: "check" },
  aborted: { label: "Discarded", tone: "neutral", glyph: "dash", hint: "Discarded. It counts toward nothing." },
};

export const FULL_TEST_RUN_STATUS: Record<FullTestRunStatus, StatusPresentation> = {
  "in-progress": {
    label: "In progress",
    tone: "caution",
    glyph: "progress",
    hint: "Resume picks up at the section you were on.",
  },
  completed: { label: "Completed", tone: "positive", glyph: "check" },
  abandoned: {
    label: "Abandoned",
    tone: "neutral",
    glyph: "dash",
    hint: "Given up before every section was sat: no Overall, and its finished sections keep their bands.",
  },
};

/** An Item's `scoringStatus` (typed `string` on ItemVM, hence the fallback in itemScoringStatus). */
export type ItemScoringStatus = "scored" | "pending" | "transcription_pending" | "failed";

export const ITEM_SCORING_STATUS: Record<ItemScoringStatus, StatusPresentation> = {
  scored: { label: "Scored", tone: "positive", glyph: "check" },
  pending: { label: "Not scored yet", tone: "neutral", glyph: "pending" },
  transcription_pending: {
    label: "Transcribing",
    tone: "accent",
    glyph: "progress",
    hint: "The recording is being transcribed; scoring starts after.",
  },
  failed: {
    label: "Scoring failed",
    tone: "critical",
    glyph: "cross",
    hint: "Nothing was scored for this Item. Re-score it, or leave it out.",
  },
};

/**
 * A scored Item of a Simulation still in progress: its mark waits for the Attempt to complete, as the
 * key and the Explanation do, so the chip says only that the Response is in (issue #48).
 */
export const ITEM_MARK_DEFERRED: StatusPresentation = {
  label: "Submitted",
  tone: "neutral",
  glyph: "dash",
  hint: "Marked correct or incorrect once this Attempt is complete.",
};

export function itemScoringStatus(raw: string): StatusPresentation {
  return (ITEM_SCORING_STATUS as Record<string, StatusPresentation | undefined>)[raw] ?? unknownStatus(raw);
}

export const SCORING_JOB_STATUS: Record<ScoringJobStatus, StatusPresentation> = {
  queued: { label: "Waiting its turn", tone: "neutral", glyph: "pending" },
  running: { label: "Scoring", tone: "accent", glyph: "progress" },
  done: { label: "Scored", tone: "positive", glyph: "check" },
  failed: { label: "Scoring failed", tone: "critical", glyph: "cross" },
  cancelled: { label: "Cancelled", tone: "neutral", glyph: "dash" },
};

export const TRANSCRIPTION_JOB_STATUS: Record<TranscriptionJobStatus, StatusPresentation> = {
  queued: { label: "Waiting to transcribe", tone: "neutral", glyph: "pending" },
  running: { label: "Transcribing", tone: "accent", glyph: "progress" },
  retry_wait: { label: "Retrying shortly", tone: "caution", glyph: "progress" },
  awaiting_score: { label: "Transcribed, scoring next", tone: "accent", glyph: "progress" },
  done: { label: "Transcribed", tone: "positive", glyph: "check" },
  failed: { label: "Transcription failed", tone: "critical", glyph: "cross" },
  superseded: { label: "Replaced by a newer attempt", tone: "neutral", glyph: "dash" },
};

export const GENERATION_JOB_STATUS: Record<GenerationJobStatus, StatusPresentation> = {
  queued: { label: "Waiting its turn", tone: "neutral", glyph: "pending" },
  running: { label: "Writing the Set", tone: "accent", glyph: "progress" },
  done: { label: "Ready", tone: "positive", glyph: "check" },
  failed: { label: "Generation failed", tone: "critical", glyph: "cross" },
  cancelled: { label: "Cancelled", tone: "neutral", glyph: "dash" },
};

export const GENERATION_BATCH_STATUS: Record<GenerationBatchStatus, StatusPresentation> = {
  queued: { label: "Waiting its turn", tone: "neutral", glyph: "pending" },
  running: { label: "Generating", tone: "accent", glyph: "progress" },
  done: { label: "All Sets ready", tone: "positive", glyph: "check" },
  partial: { label: "Some Sets failed", tone: "caution", glyph: "caution" },
  failed: { label: "Generation failed", tone: "critical", glyph: "cross" },
  cancelled: { label: "Cancelled", tone: "neutral", glyph: "dash" },
};

/**
 * Where a Set stands for the User: `attempted` needs an Attempt that has a scored Item, or is
 * completed and holds at least one Item (ATTEMPT_COUNTS_AS_SITTING_SQL in
 * server/src/db/stores/attempts.ts); an Attempt that was only started leaves the Set `started`.
 */
export type SetPracticeState = "new" | "started" | "attempted";

export const SET_PRACTICE_STATE: Record<SetPracticeState, StatusPresentation> = {
  new: { label: "New", tone: "accent", glyph: "none" },
  started: { label: "Started", tone: "caution", glyph: "progress", hint: "Opened, but nothing in it is scored yet." },
  attempted: {
    label: "Attempted",
    tone: "neutral",
    glyph: "check",
    hint: "Another Attempt on this Set is a Repeat and is left out of Band Estimates.",
  },
};

/**
 * A Set in the Drill Lab's bank, by how many of its Listen and Repeat sentences are answered (a
 * recorded take that was scored, the one rule the lab reveals a sentence by). Narrower than
 * SET_PRACTICE_STATE on purpose: a sentence counts here only once it can no longer be spoiled.
 * Null when every sentence is answered, since then nothing in the Set is hidden.
 */
export function drillLabSetState(answered: number, total: number): StatusPresentation | null {
  if (answered >= total) return null;
  if (answered === 0) {
    return { label: "Not attempted", tone: "caution", glyph: "caution", hint: "Every sentence stays hidden until you open it." };
  }
  return {
    label: `${answered} of ${total} sentences answered`,
    tone: "neutral",
    glyph: "progress",
    hint: "The sentences you haven't answered stay hidden until you open them.",
  };
}

export const SET_SOURCE: Record<"ets-sample" | "generated" | "imported", string> = {
  "ets-sample": "ETS sample",
  generated: "Generated",
  imported: "Imported",
};

export function setSourceLabel(raw: string): string {
  return (SET_SOURCE as Record<string, string | undefined>)[raw] ?? humanize(raw);
}

export const SECTION_LABEL: Record<Section, string> = {
  reading: "Reading",
  listening: "Listening",
  writing: "Writing",
  speaking: "Speaking",
};

export const ATTEMPT_MODE_LABEL: Record<AttemptMode, string> = {
  drill: "Drill",
  simulation: "Simulation",
};

export const MODULE_PATH_LABEL: Record<ModulePath, string> = {
  lower: "Lower Module",
  upper: "Upper Module",
};

/** Any Module of a routed Reading or Listening Set, the Router Module included. */
export const MODULE_LABEL: Record<"router" | ModulePath, string> = {
  router: "Router Module",
  ...MODULE_PATH_LABEL,
};

export type MethodPresentation = {
  /** What the User reads first. */
  label: string;
  /** One or two sentences behind a Disclosure, followed by the internal name in mono. */
  detail: string;
};

/**
 * Band Estimate methods (CONTEXT.md, "Band Estimate"). The internal name (`linear-v2`) is shown
 * only inside a Disclosure, after this label and detail — never as the primary copy.
 */
export const ESTIMATE_METHOD: Record<string, MethodPresentation> = {
  "linear-v2": {
    label: "Weighted average of your scored Items",
    detail:
      "Each Task Type's average 0–5 score, weighted by its share of the section's points, mapped onto the 1–6 band.",
  },
  "linear-v1": {
    label: "Weighted average (earlier weights)",
    detail: "Computed before the Task Type weights were corrected. Kept as it was when it was computed.",
  },
  "table3-v1": {
    label: "Percent correct, read off ETS's score table",
    detail:
      "Your percent correct, projected onto the 0–30 scale and read off ETS's published band table. The Lower Module caps the band.",
  },
  "mean-of-sections-v1": {
    label: "Mean of the four section bands",
    detail: "Rounded to the nearest half band, the rule ETS uses for an overall score.",
  },
};

export function estimateMethod(raw: string): MethodPresentation {
  return ESTIMATE_METHOD[raw] ?? { label: "Estimate", detail: "Computed by an estimate method this build does not describe." };
}

function unknownStatus(raw: string): StatusPresentation {
  return { label: humanize(raw), tone: "neutral", glyph: "none" };
}

/** Last resort for a code no table knows: `retry_wait` → "Retry wait". Never the first choice. */
export function humanize(raw: string): string {
  const spaced = raw.replace(/[_-]+/g, " ").trim();
  return spaced.charAt(0).toUpperCase() + spaced.slice(1);
}

// Set advisory notes.
//
// A Set carries advisory notes from the checks run when it was generated (SetAdvisoryNoteSchema):
// internal codes, each naming a part of the Set that departs from the real exam without making the
// Set unusable. The User reads one sentence per kind saying what to expect when practising, keyed
// "check/detail". Several codes that mean the same thing to the User share one entry, and so one
// line. An entry with `hidden` is never shown: the note neither changes how the Set practises nor
// gives the User anything to act on, and `hidden` says why. Speech-rate notes are composed from the
// clip's role and which way its pace missed, below.

type AdvisoryNoteText = {
  /** What `count` affected parts of the Set mean for practice, as one sentence. */
  text: (count: number) => string;
  /** Set when the User never sees this note: why it says nothing they can use. */
  hidden?: string;
};

/** "one Interview question" / "3 Interview questions", for the middle of a sentence. */
function countOf(n: number, one: string, many: string): string {
  return n === 1 ? `one ${one}` : `${n} ${many}`;
}

/** The same, opening a sentence. */
function CountOf(n: number, one: string, many: string): string {
  return n === 1 ? `One ${one}` : `${n} ${many}`;
}

function agree(n: number, one: string, many: string): string {
  return n === 1 ? one : many;
}

const REPEATS_BANK: AdvisoryNoteText = {
  text: (n) => `${CountOf(n, "part", "parts")} of this Set ${agree(n, "repeats", "repeat")} content from another Set in your bank.`,
};

const GIVES_AWAY_LAST: AdvisoryNoteText = {
  text: (n) =>
    `In ${countOf(n, "Build a Sentence Item", "Build a Sentence Items")}, a tile carries the sentence's final punctuation, which gives away that it goes last.`,
};

const LONG_EXPLANATION: AdvisoryNoteText = {
  text: (n) => `${CountOf(n, "Explanation runs", "Explanations run")} longer than intended.`,
  hidden: "An Explanation is read after answering, and its length changes nothing about the practice.",
};

const PLAN_DRIFT: AdvisoryNoteText = {
  text: (n) => `${CountOf(n, "part", "parts")} of this Set ${agree(n, "differs", "differ")} from the Plan it was written from.`,
  hidden: "Plans are never shown to the learner, and drifting from one says nothing about how the Set practises.",
};

const UNKNOWN_NOTE: AdvisoryNoteText = {
  text: (n) => `${CountOf(n, "part", "parts")} of this Set did not pass a check run when it was generated. You can still practise it.`,
};

export const ADVISORY_NOTE_TEXT: Record<string, AdvisoryNoteText> = {
  // Reading and Listening content checks.
  "content-gate/word-count": {
    text: (n) => `${CountOf(n, "Stimulus is", "Stimuli are")} longer or shorter than on the real exam.`,
  },
  "content-gate/ctw-word-count-over": {
    text: (n) => `${CountOf(n, "Complete the Words paragraph runs", "Complete the Words paragraphs run")} longer than on the real exam.`,
  },
  "content-gate/academic-coverage": {
    text: (n) => `In ${countOf(n, "Academic Passage", "Academic Passages")}, the questions leave out a kind of question the real exam asks.`,
  },
  "content-gate/option-count": {
    text: (n) => `${CountOf(n, "question has", "questions have")} fewer than four options, so guessing is easier than on the real exam.`,
  },
  "content-gate/module-difficulty-band": {
    text: (n) => `${CountOf(n, "Module reads", "Modules read")} easier or harder than the real exam's.`,
  },
  "content-gate/passage-difficulty-band": {
    text: (n) =>
      `${CountOf(n, "Academic Passage reads", "Academic Passages read")} easier or harder than the real exam's for ${agree(n, "its", "their")} Module.`,
  },
  "content-gate/ctw-paragraph-difficulty-band": {
    text: (n) =>
      `${CountOf(n, "Complete the Words paragraph reads", "Complete the Words paragraphs read")} easier or harder than the real exam's for ${agree(n, "its", "their")} Module.`,
  },
  "content-gate/item-language": {
    text: (n) => `${CountOf(n, "question has", "questions have")} some wording that is not in English.`,
  },
  "content-gate/explanation-language": {
    text: (n) => `${CountOf(n, "Explanation is", "Explanations are")} partly not in Traditional Chinese.`,
    hidden: "An Explanation is read after answering, and its language changes nothing about the practice.",
  },
  "content-gate/explanation-length": LONG_EXPLANATION,
  "content-gate/explanation-length-ctw": LONG_EXPLANATION,
  "content-gate/explanation-length-mcq": LONG_EXPLANATION,
  "content-gate/explanation-position-reference": {
    text: (n) =>
      `${CountOf(n, "Explanation names", "Explanations name")} an option by its letter, so ${agree(n, "that question keeps its", "those questions keep their")} original option order.`,
    hidden: "The Explanation stays accurate, and one question's option order changes nothing about the practice.",
  },
  "content-gate/ctw-gap-leak": {
    text: (n) =>
      `In ${countOf(n, "Complete the Words paragraph", "Complete the Words paragraphs")}, a blanked word also appears in full, so it can be copied rather than recalled.`,
  },
  "content-gate/option-length-bias": {
    text: () => "The right answer is often the longest option, which makes guessing easier than on the real exam.",
  },
  "content-gate/syllable-estimate": {
    text: (n) =>
      `${CountOf(n, "Listen and Choose a Response line is", "Listen and Choose a Response lines are")} longer or shorter than on the real exam.`,
  },
  "content-gate/item-quality": {
    text: (n) =>
      `${CountOf(n, "question has", "questions have")} a wrong option that is easy to rule out. ${agree(n, "Its answer key is", "Their answer keys are")} still correct.`,
  },
  // Build a Sentence content checks.
  "content-gate/frame-final-punctuation": GIVES_AWAY_LAST,
  "content-gate/tile-final-punctuation": GIVES_AWAY_LAST,
  "content-gate/tile-initial-capital": {
    text: (n) =>
      `In ${countOf(n, "Build a Sentence Item", "Build a Sentence Items")}, a tile starts with a capital letter, which gives away that it goes first.`,
  },
  "content-gate/tile-count": {
    text: (n) => `${CountOf(n, "Build a Sentence Item has", "Build a Sentence Items have")} more or fewer tiles than the real exam uses.`,
  },
  "content-gate/distractor-count": {
    text: (n) =>
      `${CountOf(n, "Build a Sentence Item has", "Build a Sentence Items have")} no extra tile, or more than one, where the real exam has exactly one.`,
  },
  // Listen and Repeat content checks.
  "content-gate/lr-word-count-over": {
    text: (n) =>
      `${CountOf(n, "Listen and Repeat sentence is", "Listen and Repeat sentences are")} longer than the real exam's, so harder to repeat.`,
  },
  "content-gate/lr-clip-duration-over": {
    text: (n) => `${CountOf(n, "Listen and Repeat sentence", "Listen and Repeat sentences")} may run a little longer than the real exam's longest.`,
  },
  "content-gate/lr-clip-over-ceiling": {
    text: (n) =>
      `${CountOf(n, "Listen and Repeat sentence runs", "Listen and Repeat sentences run")} longer than the real exam's longest, so ${agree(n, "it is", "they are")} harder to repeat.`,
  },
  "talk-register/below-task-register": {
    text: (n) =>
      `${CountOf(n, "Academic Talk uses", "Academic Talks use")} plainer language than the real exam's, so ${agree(n, "it is", "they are")} easier to follow.`,
  },
  "intra-set-similarity/intra-candidate": {
    text: (n) => `${CountOf(n, "part", "parts")} of this Set ${agree(n, "covers", "cover")} much the same ground as another part of it.`,
  },
  // Overlap with other Sets: every similarity measure means the same thing to the User.
  "catalog-novelty/novelty-key": REPEATS_BANK,
  "catalog-novelty/canonical-title": REPEATS_BANK,
  "catalog-novelty/descriptor": REPEATS_BANK,
  "catalog-novelty/jaccard": REPEATS_BANK,
  "catalog-novelty/containment": REPEATS_BANK,
  "catalog-novelty/trigram-dice": REPEATS_BANK,
  "catalog-novelty/semantic-signature": REPEATS_BANK,
  "catalog-novelty/domain-balance": {
    text: (n) => `${CountOf(n, "part", "parts")} of this Set ${agree(n, "is", "are")} on a topic your bank already covers often.`,
  },
  "plan-conformance/plan-drift": PLAN_DRIFT,
  "plan-conformance/domain-drift": PLAN_DRIFT,
  "plan-conformance/required-concept": PLAN_DRIFT,
};

/** A speech-rate note's `detail` is the role of the clip it measured. */
export const SPEECH_RATE_ROLE: Record<string, { one: string; many: string; hidden?: string }> = {
  "lr-item": { one: "Listen and Repeat sentence", many: "Listen and Repeat sentences" },
  "interview-question": { one: "Interview question", many: "Interview questions" },
  "lcr-utterance": { one: "Listen and Choose a Response line", many: "Listen and Choose a Response lines" },
  conversation: { one: "Conversation", many: "Conversations" },
  announcement: { one: "Announcement", many: "Announcements" },
  "academic-talk": { one: "Academic Talk", many: "Academic Talks" },
  "lr-briefing": {
    one: "scenario introduction",
    many: "scenario introductions",
    hidden: "The introduction before the sentences is neither repeated nor scored, so its pace changes nothing about the practice.",
  },
  "interview-intro": {
    one: "interview introduction",
    many: "interview introductions",
    hidden: "The interviewer's opening is neither answered nor scored, so its pace changes nothing about the practice.",
  },
};

const UNKNOWN_ROLE = { one: "recording", many: "recordings" };

// Measured rates run a little low across the bank (every clip carries more leading and trailing
// silence than ETS's), so the pace is stated as "a little", never as a size.
function paceOf(note: SetAdvisoryNote): string {
  const { measuredWpm, minWpm, maxWpm } = note;
  if (measuredWpm !== undefined && minWpm !== undefined && measuredWpm < minWpm) return "a little slower than on the real exam";
  if (measuredWpm !== undefined && maxWpm !== undefined && measuredWpm > maxWpm) return "a little faster than on the real exam";
  return "at a different pace from the real exam";
}

// One entry per (role, pace), kept so that notes about the same kind of clip group into one line.
const speechRateEntries = new Map<string, AdvisoryNoteText>();

function speechRateText(note: SetAdvisoryNote): AdvisoryNoteText {
  const pace = paceOf(note);
  const key = `${note.detail}|${pace}`;
  const existing = speechRateEntries.get(key);
  if (existing) return existing;
  const role = SPEECH_RATE_ROLE[note.detail] ?? UNKNOWN_ROLE;
  const entry: AdvisoryNoteText = {
    text: (n) => `${CountOf(n, role.one, role.many)} ${agree(n, "plays", "play")} ${pace}.`,
    ...("hidden" in role && role.hidden ? { hidden: role.hidden } : {}),
  };
  speechRateEntries.set(key, entry);
  return entry;
}

function advisoryNoteText(note: SetAdvisoryNote): AdvisoryNoteText {
  if (note.check === "speech-rate") return speechRateText(note);
  return ADVISORY_NOTE_TEXT[`${note.check}/${note.detail}`] ?? UNKNOWN_NOTE;
}

// Which part of the Set a note is about. Several notes can name the same part (one per similarity
// measure); a note that names no position is its own part.
function partOf(note: SetAdvisoryNote, index: number): string {
  if (note.clipId) return `clip:${note.clipId}`;
  if (note.itemPosition !== undefined) return `${note.taskType ?? ""}#${note.itemPosition}`;
  return `note#${index}`;
}

/**
 * What the User should expect from a Set before practising it: one sentence per kind of note,
 * counting the parts of the Set each is about, in the order the notes first appear. Hidden kinds
 * produce nothing, so a Set whose every note is hidden has no lines at all.
 */
export function advisoryNoteLines(notes: readonly SetAdvisoryNote[]): string[] {
  const parts = new Map<AdvisoryNoteText, Set<string>>();
  notes.forEach((note, index) => {
    const entry = advisoryNoteText(note);
    if (entry.hidden) return;
    const seen = parts.get(entry) ?? new Set<string>();
    seen.add(partOf(note, index));
    parts.set(entry, seen);
  });
  return [...parts].map(([entry, seen]) => entry.text(seen.size));
}

/**
 * Where one piece of this installation stands (components/setup/setupChecklist.ts):
 * `optional` is a missing piece whose job another present piece already covers.
 */
export type SetupCheckState = "ready" | "missing" | "optional" | "checking";

export const SETUP_CHECK_STATE: Record<SetupCheckState, StatusPresentation> = {
  ready: { label: "Ready", tone: "positive", glyph: "check" },
  missing: { label: "Missing", tone: "caution", glyph: "caution", hint: "Something on this machine turns off until it is set up." },
  optional: { label: "Optional", tone: "neutral", glyph: "dash", hint: "Not set up, and nothing needs it right now." },
  checking: { label: "Checking", tone: "neutral", glyph: "pending", hint: "The server has not finished checking this yet." },
};

/**
 * A section whose scoring this machine cannot do, as the setup status reports it (`sectionScorability`
 * in pages/dashboard/suggestNext.ts says `blocked`). It names a capability, never a provider: which
 * piece is missing is the Setup checklist's to say.
 */
export const SCORING_NOT_SET_UP = {
  label: "Scoring isn't set up on this machine",
  tone: "caution",
  glyph: "caution",
  /** The way to the Setup checklist, wherever the notice links to it. */
  setupLink: "See what's missing",
} as const;

/**
 * This machine refuses every Speaking recording (the setup status's `speaking-uploads` is off), so a
 * Speaking run keeps nothing to score, now or after Setup. Critical where SCORING_NOT_SET_UP is a
 * caution: that one loses only time, this one loses the run.
 */
export const RECORDINGS_NOT_SAVED = {
  label: "Recordings can't be saved on this machine",
  tone: "critical",
  glyph: "cross",
} as const;

// Attempt review: Deductions, Judges, and the cautions a Score Report can carry.

/** A Deduction's `category` (DeductionCategory, shared/src/schemas/scoring.ts), as its chip reads. */
export const DEDUCTION_CATEGORY: Record<string, string> = {
  grammar: "Grammar",
  vocab: "Vocabulary",
  elaboration: "Elaboration",
  register: "Register",
  coherence: "Coherence",
  "pronunciation-proxy": "Pronunciation",
  content: "Content",
  completeness: "Completeness",
};

export function deductionCategoryLabel(raw: string): string {
  return DEDUCTION_CATEGORY[raw] ?? humanize(raw);
}

/** A recording saved but never transcribed, with nothing transcribing it now: no score is coming. */
export const NOT_TRANSCRIBED: StatusPresentation = {
  label: "Not transcribed",
  tone: "caution",
  glyph: "caution",
  hint: "The recording was saved, but nothing is transcribing it, so it has no score.",
};

/**
 * A completed Attempt that was expected to give a band and has none while its scoring is still on its
 * way (a Judge has yet to finish, or a recording is still being transcribed). Beside its "Completed"
 * status on an Attempt row, in the words the Attempt review and the Full-Test Run report use.
 */
export const STILL_SCORING: StatusPresentation & { hint: string } = {
  label: "Still scoring",
  tone: "accent",
  glyph: "progress",
  hint: "Completed, and still being scored. The band appears when scoring finishes.",
};

/**
 * A completed Attempt that was expected to give a band and has none, with its scoring settled: an
 * Item failed, was never transcribed, or is missing. Beside its "Completed" status on an Attempt row,
 * so the row stops implying all went well; the review says which Item and why.
 */
export const NO_BAND: StatusPresentation & { hint: string } = {
  label: "No band",
  tone: "caution",
  glyph: "caution",
  hint: "Completed without a Band Estimate: an Item is unscored or missing. Open it to see which.",
};

/** A Re-score of an Item that already had a score failed: the committed score stands (the server keeps it). */
export const RESCORE_FAILED: StatusPresentation & { hint: string } = {
  label: "Re-score failed",
  tone: "critical",
  glyph: "cross",
  hint: "The score below still stands: nothing from the Re-score was saved.",
};

/**
 * An Attempt's `flagged` boolean. It is one flag raised more than one way: the tab went hidden (or a
 * Writing Simulation was reopened), or a Speaking or Listening prompt would not play and the run
 * stopped on its gate. The flag does not say which, so the words never claim the User left: they say
 * the Simulation was interrupted, and why that matters.
 */
export const ATTEMPT_FLAG = {
  /** The chip in the review's header and the title of its notice. */
  heading: "Flagged",
  /** The chip on the Attempt's row, and its tooltip. */
  label: "Interrupted",
  hint: "This Simulation was interrupted: the tab was left, or a prompt would not play.",
  /** The review's notice, for a Simulation and for anything else. */
  simulationNote: "This Simulation was interrupted (the tab was left, or a prompt would not play), so its timing may not match the test.",
  otherNote: "This Attempt is flagged for review.",
} as const;

/** A Judge by its family (CONTEXT.md, Judge). */
export const JUDGE_LABEL: Record<"gemini" | "openai", string> = { gemini: "Gemini", openai: "OpenAI" };

export function judgeLabel(raw: string): string {
  return (JUDGE_LABEL as Record<string, string | undefined>)[raw] ?? humanize(raw);
}

/**
 * The flags that change how far to trust one Score Report. Each is a caution, never a fault: the
 * score stands and counts toward the band; the chip says what to keep in mind while reading it.
 */
export type ScoreCaution = "single-judge" | "disagreement" | "text-fallback" | "self-arbitrated";

export const SCORE_CAUTION: Record<ScoreCaution, StatusPresentation & { hint: string }> = {
  "single-judge": {
    label: "One Judge",
    tone: "caution",
    glyph: "caution",
    hint: "Only one Judge's report reached the Arbiter, so this score rests on one Judge and the Arbiter.",
  },
  disagreement: {
    label: "Judges disagree",
    tone: "caution",
    glyph: "caution",
    hint: "The Judges' scores are 1.5 points or more apart, so this score is less certain than most.",
  },
  "text-fallback": {
    label: "Scored from the transcript",
    tone: "caution",
    glyph: "caution",
    hint: "One Judge could not use the recording, so it scored the transcript and the Delivery Report instead of your voice.",
  },
  "self-arbitrated": {
    label: "Reduced model independence",
    tone: "caution",
    glyph: "caution",
    hint: "Codex wrote the OpenAI Judge Report and also acted as Arbiter, because the usual Arbiter was unavailable. The score still counts.",
  },
};

/** One section of a Full-Test Run, as its row reads (FullTestSectionVM.state). */
export const FULL_TEST_SECTION_STATE: Record<FullTestSectionState, StatusPresentation> = {
  pending: { label: "Not started", tone: "neutral", glyph: "pending" },
  "in-progress": { label: "In progress", tone: "caution", glyph: "progress", hint: "Left part-way through." },
  completed: { label: "Complete", tone: "positive", glyph: "check" },
  aborted: { label: "Abandoned", tone: "neutral", glyph: "dash", hint: "Its Attempt was discarded before it was finished, so it has no band." },
};
