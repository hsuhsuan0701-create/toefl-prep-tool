// Backward buildup (倒序堆疊): the Drill Lab's chunker, steps and view models.
//
// In `shared` because both sides must agree on the chunking: the server persists a rep against the
// target sentence's word indices, and the client renders the same sentence split into the same
// chunks. A `breakdownIndex` recorded under one chunking is meaningless under another.

/**
 * A backward-buildup step: one growing SUFFIX of the target sentence.
 *
 * Building forward rehearses a sentence's opening N times and its tail once, and the tail is what
 * collapses; building backward rehearses the tail N times. A suffix rather than any window, because
 * every step then ends where the real sentence ends, so the closing intonation the User practises is
 * always the right one. A forward fragment would rehearse a falling contour where the full sentence
 * has none.
 */
export type BuildupStep = {
  /** 1-based, counting from the shortest (tail-only) step up to the full sentence. */
  ordinal: number;
  /** The chunk newly PREPENDED at this step — what the learner adds to what they can already say. */
  addedChunk: string;
  /** The full text to say at this step: `addedChunk` plus every chunk after it. */
  text: string;
  /** Word index into the target sentence where this step's text begins. */
  startWordIndex: number;
};

// Cut BEFORE these: each opens a phrase, so the boundary in front of it is a real prosodic seam
// rather than a position inside a unit the learner has to hold whole.
const PHRASE_OPENERS = new Set([
  // relative pronouns and complementizers
  "who", "whose", "whom", "which", "that",
  // prepositions
  "in", "on", "at", "by", "for", "with", "from", "into", "inside", "outside", "beside",
  "before", "after", "during", "under", "over", "through", "across", "without", "within",
  "between", "near", "around", "behind", "above", "below", "against", "toward", "towards",
  "onto", "upon", "about", "to",
  // coordinators
  "and", "but", "or", "so", "yet", "nor",
  // subordinators
  "when", "while", "if", "because", "although", "though", "unless", "until", "since", "whenever",
  "where", "wherever", "how", "whether",
  // modals and auxiliaries: a verb phrase's left edge is as real a seam as a preposition's, and in a
  // "[head noun] [relative clause] [main verb]" sentence it is the seam before the main verb
  "can", "could", "should", "would", "will", "shall", "may", "might", "must",
]);

// A chunk must never END on one of these: they bind rightward to the word they modify, and a chunk
// boundary between "the" and "sign-in sheet" splits the very unit chunking exists to keep whole.
const BINDS_RIGHTWARD = new Set([
  "the", "a", "an", "this", "that", "these", "those",
  "my", "your", "his", "her", "its", "our", "their",
  "some", "any", "each", "every", "no", "another", "both", "either", "neither",
  "to", "of", "and", "or",
]);

const MIN_CHUNK_WORDS = 2;
const MAX_CHUNK_WORDS = 6;
const IDEAL_CHUNK_WORDS = 4;
// What a boundary that does not sit at a phrase opener costs, in the same units as the squared
// deviation from IDEAL_CHUNK_WORDS. A chunk of 2 or 6 already costs 4 on size alone, so a value below
// 4 lets size win and the partition emits 4-word blocks that cut through phrases (at 3, "whose badge
// you print today" split into "whose badge you" + "print today will remember"). At 10 a seam
// outranks every size compromise the range permits: chunk length is a comfort target, but a boundary
// inside a phrase breaks the unit the User has to hold whole.
const AWKWARD_BOUNDARY_COST = 10;

function bareWord(token: string): string {
  return token.toLowerCase().replace(/[^\p{L}\p{N}'-]+/gu, "");
}

/**
 * Splits a sentence into 2-6 word chunks at phrase seams, preferring 4.
 *
 * Rule-based rather than a model call: it must give the same answer on both sides of the wire and on
 * every run, or the stored rep history stops lining up with the chunks.
 *
 * A shortest-path partition over whole sentences, not a greedy left-to-right scan. A greedy scan
 * commits to each boundary before seeing its cost downstream and strands the tail: on "The
 * assistant who is assigned to spotlight two should check her own angle" it cut after "spotlight",
 * leaving "two" alone, to be folded into an over-long, mid-phrase neighbour.
 *
 * Returns `[]` for a blank sentence, which callers treat as nothing to drill.
 */
export function chunkSentence(sentence: string): string[] {
  const words = sentence.trim().split(/\s+/u).filter((w) => w.length > 0);
  if (words.length === 0) return [];
  if (words.length <= MAX_CHUNK_WORDS && words.length < MIN_CHUNK_WORDS * 2) return [words.join(" ")];

  // No boundary after a word that binds to its right (BINDS_RIGHTWARD).
  const boundaryLegal = (at: number): boolean =>
    at === 0 || at === words.length || !BINDS_RIGHTWARD.has(bareWord(words[at - 1]!));

  const chunkCost = (start: number, length: number): number => {
    const sizeCost = (length - IDEAL_CHUNK_WORDS) ** 2;
    const seamCost = start > 0 && !PHRASE_OPENERS.has(bareWord(words[start]!)) ? AWKWARD_BOUNDARY_COST : 0;
    return sizeCost + seamCost;
  };

  // dp[i] = cheapest way to partition words[0..i); from[i] = where that final chunk started.
  const dp = new Array<number>(words.length + 1).fill(Number.POSITIVE_INFINITY);
  const from = new Array<number>(words.length + 1).fill(-1);
  dp[0] = 0;
  for (let end = MIN_CHUNK_WORDS; end <= words.length; end++) {
    for (let length = MIN_CHUNK_WORDS; length <= MAX_CHUNK_WORDS; length++) {
      const start = end - length;
      if (start < 0 || dp[start] === Number.POSITIVE_INFINITY) continue;
      if (!boundaryLegal(start)) continue;
      // Never strand a remainder too short to be its own chunk.
      const remaining = words.length - end;
      if (remaining > 0 && remaining < MIN_CHUNK_WORDS) continue;
      const cost = dp[start]! + chunkCost(start, length);
      if (cost < dp[end]!) {
        dp[end] = cost;
        from[end] = start;
      }
    }
  }
  // Every boundary illegal (a sentence that is all determiners, or shorter than one legal chunk):
  // one chunk is a worse drill than several, but it is still a correct one.
  if (dp[words.length] === Number.POSITIVE_INFINITY) return [words.join(" ")];

  const chunks: string[] = [];
  for (let end = words.length; end > 0; end = from[end]!) {
    chunks.unshift(words.slice(from[end]!, end).join(" "));
  }
  return chunks;
}

/**
 * The chunks of `sentence`, turned into the ordered steps a learner works through: tail first, one
 * chunk prepended per step, ending at the whole sentence.
 */
export function buildupSteps(sentence: string): BuildupStep[] {
  const chunks = chunkSentence(sentence);
  if (chunks.length === 0) return [];
  const chunkStartWord: number[] = [];
  let seen = 0;
  for (const chunk of chunks) {
    chunkStartWord.push(seen);
    seen += chunk.split(" ").length;
  }
  const steps: BuildupStep[] = [];
  for (let i = chunks.length - 1; i >= 0; i--) {
    steps.push({
      ordinal: chunks.length - i,
      addedChunk: chunks[i]!,
      text: chunks.slice(i).join(" "),
      startWordIndex: chunkStartWord[i]!,
    });
  }
  return steps;
}

// ---------------------------------------------------------------------------------------------
// Rep view models — the drill's phase B (blind attempt at the whole sentence)
// ---------------------------------------------------------------------------------------------

/**
 * One word-alignment operation between the target sentence and what the User said. Structurally
 * identical to server/src/services/wordDiff.ts's `DiffOp`, the alignment Listen and Repeat scoring
 * uses, so a practice rep and a scored Item cannot disagree about the same pair of strings; the
 * server's ops assign to this type directly.
 */
export type BuildupDiffOp =
  | { op: "match"; targetWord: string; saidWord: string }
  | { op: "substitution"; targetWord: string; saidWord: string }
  | { op: "omission"; targetWord: string }
  | { op: "insertion"; saidWord: string };

/** Which half of the drill a rep belongs to: before the buildup, or after it. */
export type BuildupPhase = "baseline" | "post";

export type BuildupRepVM = {
  id: string;
  phase: BuildupPhase;
  /** ISO-8601. */
  createdAt: string;
  transcript: string | null;
  /** Set when transcription failed; the recording is still stored and playable. */
  transcriptionError: string | null;
  breakdownIndex: number | null;
  targetWordCount: number;
  matchedWordCount: number | null;
  diff: BuildupDiffOp[] | null;
  /** Path for `/api/audio/...`, or null if the recording could not be stored. */
  audioPath: string | null;
};

export type BuildupItemVM = {
  setId: string;
  itemId: string;
  scenarioTitle: string;
  /** THE TARGET SENTENCE IN CLEARTEXT — see routes/drillLab.ts on why this route reveals it. */
  sentence: string;
  audio: string;
  chunks: string[];
  steps: BuildupStep[];
  /** Every score this item has ever earned in a real Attempt, newest first. */
  pastScores: number[];
  reps: BuildupRepVM[];
};

export type BuildupQueueEntryVM = {
  setId: string;
  itemId: string;
  scenarioTitle: string;
  wordCount: number;
  /** Lowest score this item ever earned — what put it in the queue. */
  worstScore: number;
  latestScore: number;
  repCount: number;
  /**
   * `heldWordCount` of the most recent measured rep, or null if this Item has none. Held words
   * rather than the raw breakdown index, whose null means "matched everything" on a measured rep and
   * "nothing measured" on one whose transcription failed.
   */
  latestHeldWords: number | null;
};

export type BuildupBankItemVM = {
  itemId: string;
  /** Null until this Item has a scored recording: a sentence's length is a hint about it too. */
  wordCount: number | null;
  /** The sentence, present only once this Item has a scored recording. */
  preview: string | null;
};

export type BuildupBankSetVM = {
  setId: string;
  scenarioTitle: string;
  /**
   * Whether every one of this Set's Listen and Repeat Items has a scored recording. The bank browser
   * marks the others, because opening a sentence here prints it, and a sentence read first can never
   * be heard blind afterwards.
   */
  attempted: boolean;
  items: BuildupBankItemVM[];
};

/**
 * How far into the target sentence a rep got before recall broke (the number the drill is steered
 * by), or null if the rep produced no measurement.
 *
 * Three states, because both shortcuts misread the columns: `breakdownIndex ?? 0` plots the best
 * rep (every word matched) as the worst, and `breakdownIndex ?? targetWordCount` plots a rep whose
 * transcription failed as a perfect one. `matchedWordCount` is written only when an alignment was
 * computed, so its null means "no measurement".
 */
export function heldWordCount(rep: {
  breakdownIndex: number | null;
  targetWordCount: number;
  matchedWordCount: number | null;
}): number | null {
  if (rep.matchedWordCount === null) return null;
  return rep.breakdownIndex ?? rep.targetWordCount;
}

/**
 * The 0-based index of the first target word the User failed to reproduce, or null for a rep that
 * matched every word. Insertions do not count: an inserted word (a filler, a false start, a
 * self-repair) consumes no target word, and treating one as the point where recall broke would fire
 * on the most common harmless event in speech.
 */
export function breakdownWordIndex(ops: BuildupDiffOp[]): number | null {
  let targetIndex = 0;
  for (const op of ops) {
    if (op.op === "insertion") continue;
    if (op.op !== "match") return targetIndex;
    targetIndex++;
  }
  return null;
}
