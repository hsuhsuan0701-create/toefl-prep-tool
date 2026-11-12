import type {
  AnySet,
  ListeningModule,
  ListeningSet,
  ModulePath,
  ReadingModule,
  ReadingSet,
  Speaker,
  SpeakingSet,
  WritingSet,
} from "./schemas.js";

// ---------------------------------------------------------------------------
// The SERVED Set: what GET /api/sets/:id actually puts on the wire, as a type.
//
// `stripAnswers` below is the only producer, and this module is the only place the served shapes
// are named. Every member is derived from its stored counterpart in ./schemas.js by exactly the
// `Omit` the strip performs, never hand-written, so renaming or removing a field on a Set schema is
// a compile error at every client reader rather than a runtime `undefined`.
//
// Not a Zod schema, and parsed nowhere: a served Set no longer conforms to its own Set schema, and
// the client types its responses without validating them (client/src/lib/api.ts). It is a
// compile-time contract between the one producer and every reader. A newly served key path also
// fails server/test/servedSetTripwire.test.ts until it is reviewed into that test's allow-list.
//
// Kept beside `stripAnswers` rather than in ./viewModels.ts because the dependency runs one way
// (servedSet -> schemas) and these types exist only to say what that function returns.
// ---------------------------------------------------------------------------

// ---- Speaking -------------------------------------------------------------

/** One Listen and Repeat Item, minus the target `sentence` the drill exists to elicit unseen. */
export type ServedListenAndRepeatItem = Omit<SpeakingSet["listenAndRepeat"]["items"][number], "sentence">;

/**
 * The scene illustration as served: the server-owned file path and the trusted model provenance,
 * never `prompt` — the prompt embeds all seven target sentences verbatim (see stripAnswers below).
 */
export type ServedSceneImage = Pick<NonNullable<SpeakingSet["listenAndRepeat"]["image"]>, "file" | "model">;

export type ServedListenAndRepeat = Omit<SpeakingSet["listenAndRepeat"], "image" | "items"> & {
  image?: ServedSceneImage;
  items: ServedListenAndRepeatItem[];
};

/** One interview Item, minus the `question` text — Speaking's other pre-drill answer. */
export type ServedInterviewQuestion = Omit<SpeakingSet["interview"]["questions"][number], "question">;

export type ServedInterview = Omit<SpeakingSet["interview"], "questions"> & {
  questions: ServedInterviewQuestion[];
};

export type ServedSpeakingSet = Omit<
  SpeakingSet,
  "generationPlan" | "audioProfile" | "listenAndRepeat" | "interview"
> & {
  listenAndRepeat: ServedListenAndRepeat;
  interview: ServedInterview;
};

// ---- Writing --------------------------------------------------------------

/**
 * One Build a Sentence Item as served. `answers` (the correct tile orderings) is gone; `tiles` is
 * present but its ORDER is drawn per request by server/src/services/tileScramble.ts, so nothing
 * downstream may treat the served order as meaningful.
 */
export type ServedBuildASentenceItem = Omit<WritingSet["buildASentence"]["items"][number], "answers">;

export type ServedWritingSet = Omit<WritingSet, "generationPlan" | "buildASentence"> & {
  buildASentence: { items: ServedBuildASentenceItem[] };
};

// ---- Reading / Listening MCQs ---------------------------------------------

/**
 * Any question built from the `mcqQuestionSchema` factory (schemas/multipleChoice.ts), as served: no `correctOptionId`,
 * no `skill` (a weakness-tracking tag that would narrow the option set for free), no `explanationZh`
 * (the 錯題解析, withheld until the Item is scored). One alias for both skill vocabularies, mirroring
 * the single `stripMcqQuestion` that produces them.
 */
export type ServedMcqQuestion<Q extends { correctOptionId: string; skill: string; explanationZh: string }> =
  Omit<Q, "correctOptionId" | "skill" | "explanationZh">;

export type ServedMcqOption = ReadingModule["dailyLife"][number]["questions"][number]["options"][number];

// ---- Reading --------------------------------------------------------------

type StoredCtwPassage = ReadingModule["ctwPassages"][number];
type StoredDailyLifeText = ReadingModule["dailyLife"][number];
type StoredAcademicPassage = ReadingModule["academic"][number];

/** A Complete the Words gap: the visible `prefix` and the box count, never the deleted letters. */
export type ServedCtwGap = Omit<StoredCtwPassage["gaps"][number], "completion" | "explanationZh">;

export type ServedCtwPassage = Omit<StoredCtwPassage, "sourceParagraph" | "gaps"> & {
  gaps: ServedCtwGap[];
};

export type ServedReadingMcqQuestion = ServedMcqQuestion<StoredDailyLifeText["questions"][number]>;

export type ServedDailyLifeText = Omit<StoredDailyLifeText, "questions"> & {
  questions: ServedReadingMcqQuestion[];
};

export type ServedAcademicPassage = Omit<StoredAcademicPassage, "questions"> & {
  questions: ServedReadingMcqQuestion[];
};

/** The three Reading Stimulus shapes, discriminated by `taskType`. */
export type ServedReadingStimulus = ServedCtwPassage | ServedDailyLifeText | ServedAcademicPassage;

export type ServedReadingModule = Omit<ReadingModule, "ctwPassages" | "dailyLife" | "academic"> & {
  ctwPassages: ServedCtwPassage[];
  dailyLife: ServedDailyLifeText[];
  academic: ServedAcademicPassage[];
};

export type ServedReadingSet = Omit<ReadingSet, "generationPlan" | "router" | "lowerModule" | "upperModule"> & {
  router: ServedReadingModule;
  lowerModule: ServedReadingModule;
  upperModule: ServedReadingModule;
};

// ---- Listening ------------------------------------------------------------

/** The avatar card's Speaker: id/role/gender/accent, never the TTS `voice`/`provider` provenance. */
export type ServedSpeaker = Omit<Speaker, "voice" | "provider">;

type StoredListenChooseItem = ListeningModule["listenChoose"][number];
type StoredConversation = ListeningModule["conversations"][number];
type StoredAnnouncement = ListeningModule["announcements"][number];
type StoredAcademicTalk = ListeningModule["academicTalks"][number];

export type ServedListeningMcqQuestion = ServedMcqQuestion<StoredConversation["questions"][number]>;

/**
 * A Listen and Choose a Response Item: its options and nothing else that speaks. `utterance` is
 * absent — it is NEVER rendered as text, even post-answer (ETS rule) — and the Item itself IS the
 * question, so there is no stem either.
 */
export type ServedListenChooseItem = Omit<
  StoredListenChooseItem,
  "utterance" | "correctOptionId" | "skill" | "explanationZh" | "speaker"
> & { speaker: ServedSpeaker };

export type ServedConversation = Omit<StoredConversation, "transcript" | "speakers" | "questions"> & {
  speakers: ServedSpeaker[];
  questions: ServedListeningMcqQuestion[];
};

export type ServedAnnouncement = Omit<StoredAnnouncement, "transcript" | "speaker" | "questions"> & {
  speaker: ServedSpeaker;
  questions: ServedListeningMcqQuestion[];
};

export type ServedAcademicTalk = Omit<StoredAcademicTalk, "transcript" | "speaker" | "questions"> & {
  speaker: ServedSpeaker;
  questions: ServedListeningMcqQuestion[];
};

/** The four Listening Stimulus shapes, discriminated by `taskType`. */
export type ServedListeningStimulus =
  | ServedListenChooseItem
  | ServedConversation
  | ServedAnnouncement
  | ServedAcademicTalk;

export type ServedListeningModule = Omit<
  ListeningModule,
  "listenChoose" | "conversations" | "announcements" | "academicTalks"
> & {
  listenChoose: ServedListenChooseItem[];
  conversations: ServedConversation[];
  announcements: ServedAnnouncement[];
  academicTalks: ServedAcademicTalk[];
};

export type ServedListeningSet = Omit<
  ListeningSet,
  "generationPlan" | "audioProfile" | "router" | "lowerModule" | "upperModule"
> & {
  router: ServedListeningModule;
  lowerModule: ServedListeningModule;
  upperModule: ServedListeningModule;
};

// ---- Routed Modules --------------------------------------------------------

/** One Module of a routed Reading or Listening Set: the Router Module, or the Module it routes to. */
export type RoutedModule = "router" | ModulePath;

/**
 * A served Reading or Listening Set's Module by name. The Set's own fields for the second two are
 * `lowerModule` and `upperModule`.
 */
export function routedModule<M>(set: { router: M; lowerModule: M; upperModule: M }, module: RoutedModule): M {
  if (module === "router") return set.router;
  return module === "lower" ? set.lowerModule : set.upperModule;
}

// ---- The union ------------------------------------------------------------

/** Everything GET /api/sets/:id can return, discriminated by `kind` exactly as `AnySet` is. */
export type ServedSet = ServedSpeakingSet | ServedWritingSet | ServedReadingSet | ServedListeningSet;

export type ServedSetKind = ServedSet["kind"];

/** The one member of the union a given `kind` names. */
export type ServedSetOfKind<K extends ServedSetKind> = Extract<ServedSet, { kind: K }>;

const SERVED_SET_KINDS: readonly ServedSetKind[] = ["speaking", "writing", "reading", "listening"];

// Only ever prints one of the four server-owned enum labels, or "unknown" — never echoes an
// arbitrary payload field back into an error message that reaches the UI.
function describeKind(value: unknown): string {
  return SERVED_SET_KINDS.includes(value as ServedSetKind) ? String(value) : "unknown";
}

/**
 * Narrows a served Set to one section's shape, throwing when it is anything else.
 *
 * For the Drill and Simulation paths, which load a Set of one known kind and read that kind's
 * content unconditionally. A mismatch there is a routing bug: each page's Set fetch sends a rejected
 * promise to its own error stage, so a mismatch shows that page's ordinary error instead of crashing
 * mid-render.
 *
 * Not for Attempt review, which reads a possibly retired Set best-effort and must never be gated on
 * it; that path uses `asUntrustedServedSet` below.
 */
export function expectServedSet<K extends ServedSetKind>(kind: K, set: ServedSet): ServedSetOfKind<K> {
  const actual = (set as { kind?: unknown } | null | undefined)?.kind;
  if (actual !== kind) {
    throw new Error(`served Set is not a ${kind} Set (got ${describeKind(actual)})`);
  }
  return set as ServedSetOfKind<K>;
}

// The discriminant, plus every other top-level field made optional. One level only: what a retired
// or stale Set can be missing is a whole task group (or the discriminant), and its readers re-check
// the nested shapes at runtime.
type Doubted<S extends { kind: ServedSetKind }> = { kind: S["kind"] } & Partial<Omit<S, "kind">>;

/**
 * A served Set as a doubting reader must see it: the real member shapes, but the discriminant may be
 * absent and every top-level field is optional.
 *
 * For Attempt review, which renders from GET /api/attempts/:id and fetches the Set separately,
 * best-effort, for display enrichments only; the Set may be retired, stale or gone, so review never
 * narrows with `expectServedSet` and never throws. The field names are still the served union's own,
 * so renaming a field on a Set schema breaks review's compile instead of silently dropping what it
 * showed.
 */
export type UntrustedServedSet =
  | { kind?: undefined }
  | Doubted<ServedSpeakingSet>
  | Doubted<ServedWritingSet>
  | Doubted<ServedReadingSet>
  | Doubted<ServedListeningSet>;

/**
 * The non-throwing counterpart of `expectServedSet`: reduces any fetched value to something that can
 * be read field by field, with no claim that any field is there. A non-object (null, a string, a
 * failed parse) becomes an empty Set rather than an error, because every caller of this has a
 * working fallback for "no Set" already.
 */
export function asUntrustedServedSet(value: unknown): UntrustedServedSet {
  return typeof value === "object" && value !== null ? (value as UntrustedServedSet) : {};
}

// One strip for every MCQ built from the mcqQuestionSchema factory, Reading's and Listening's alike,
// so the two cannot strip differently.
function stripMcqQuestion<Q extends { correctOptionId: string; skill: string; explanationZh: string }>(
  { correctOptionId: _correctOptionId, skill: _skill, explanationZh: _explanationZh, ...question }: Q
) {
  return question;
}
function stripReadingModule(module: ReadingModule) {
  return {
    ...module,
    ctwPassages: module.ctwPassages.map(({ sourceParagraph: _sourceParagraph, ...passage }) => ({
      ...passage,
      gaps: passage.gaps.map(({ completion: _completion, explanationZh: _explanationZh, ...gap }) => gap),
    })),
    dailyLife: module.dailyLife.map((text) => ({ ...text, questions: text.questions.map(stripMcqQuestion) })),
    academic: module.academic.map((passage) => ({ ...passage, questions: passage.questions.map(stripMcqQuestion) })),
  };
}
function stripSpeaker({ voice: _voice, provider: _provider, ...speaker }: Speaker) {
  return speaker;
}
function stripListeningModule(module: ListeningModule) {
  return {
    ...module,
    listenChoose: module.listenChoose.map(
      ({ utterance: _utterance, correctOptionId: _correctOptionId, skill: _skill, explanationZh: _explanationZh, speaker, ...item }) => ({
        ...item,
        speaker: stripSpeaker(speaker),
      })
    ),
    conversations: module.conversations.map(({ transcript: _transcript, speakers, questions, ...rest }) => ({
      ...rest,
      speakers: speakers.map(stripSpeaker),
      questions: questions.map(stripMcqQuestion),
    })),
    announcements: module.announcements.map(({ transcript: _transcript, speaker, questions, ...rest }) => ({
      ...rest,
      speaker: stripSpeaker(speaker),
      questions: questions.map(stripMcqQuestion),
    })),
    academicTalks: module.academicTalks.map(({ transcript: _transcript, speaker, questions, ...rest }) => ({
      ...rest,
      speaker: stripSpeaker(speaker),
      questions: questions.map(stripMcqQuestion),
    })),
  };
}

/**
 * The Set as GET /api/sets/:id serves it: every answer, and everything that would give one away,
 * removed. Every kind loses `generationPlan` (topics and concepts kept for novelty checks, of no use
 * to a learner).
 *
 * Speaking: the Listen and Repeat `sentence` and the interview `question` text go, since repeating
 * the sentence and answering the question unseen is the task. The scene image keeps only `file` and
 * `model`: its `prompt` lists all seven target sentences (composeScenePrompt) and stays on disk.
 * `focusRegion` stays: the highlight moves between objects while the sentences are still hidden,
 * and four numbers name no words. `audioProfile` (TTS provider and model) goes whole; no client
 * reads it.
 *
 * Writing: Build a Sentence `answers` (the accepted tile orders) go.
 *
 * Reading: each Complete the Words gap loses `completion` and `explanationZh`, its passage the
 * `sourceParagraph` the letters were deleted from, and every MCQ its `correctOptionId`, `skill` and
 * `explanationZh`. `segments`, `prefix` and `blankLength` stay: they are the blank the drill draws
 * and name no deleted letter. `skill` goes because a tag such as "vocabulary" narrows the options.
 *
 * Listening: a Listen and Choose a Response Item loses its `utterance` (never shown as text) and the
 * same MCQ fields; a Conversation, Announcement or Academic Talk loses its `transcript` and its
 * questions' MCQ fields. Every Speaker loses `voice` and `provider`, keeping the `id`, `role`,
 * `gender` and `accent` its avatar card shows. `audioProfile` goes whole.
 *
 * Reading and Listening strip all three modules alike, the variant the Attempt will not be routed to
 * included: routing happens on the server after the Router Module is scored, so the client gets both.
 *
 * `advisoryNotes` stays on every kind: the Set listing badges a Set that carries notes, and the
 * schema has no field an answer could occupy. It rides through each branch's spread, so a new kind
 * keeps it without being listed. No branch's output satisfies its own Set schema; each cast names its
 * member of the served union.
 */
export function stripAnswers(set: AnySet): ServedSet {
  const { generationPlan: _generationPlan, ...publicSet } = set;
  if (set.kind === "reading") {
    return {
      ...publicSet,
      router: stripReadingModule(set.router),
      lowerModule: stripReadingModule(set.lowerModule),
      upperModule: stripReadingModule(set.upperModule),
    } as ServedReadingSet;
  }
  if (set.kind === "listening") {
    const { generationPlan: _listeningGenerationPlan, audioProfile: _audioProfile, ...publicListeningSet } = set;
    return {
      ...publicListeningSet,
      router: stripListeningModule(set.router),
      lowerModule: stripListeningModule(set.lowerModule),
      upperModule: stripListeningModule(set.upperModule),
    } as ServedListeningSet;
  }
  if (set.kind === "writing") {
    return {
      ...publicSet,
      buildASentence: {
        items: set.buildASentence.items.map(({ answers: _answers, ...rest }) => rest),
      },
    } as ServedWritingSet;
  }
  const { generationPlan: _speakingGenerationPlan, audioProfile: _speakingAudioProfile, ...publicSpeakingSet } = set;
  return {
    ...publicSpeakingSet,
    listenAndRepeat: {
      ...set.listenAndRepeat,
      ...(set.listenAndRepeat.image
        ? { image: { file: set.listenAndRepeat.image.file, model: set.listenAndRepeat.image.model } }
        : {}),
      items: set.listenAndRepeat.items.map(({ sentence: _sentence, ...rest }) => rest),
    },
    interview: {
      ...set.interview,
      questions: set.interview.questions.map(({ question: _question, ...rest }) => rest),
    },
  } as ServedSpeakingSet;
}
