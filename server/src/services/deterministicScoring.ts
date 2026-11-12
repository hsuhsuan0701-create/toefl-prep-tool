import type {
  AnySet,
  AnyTaskType,
  ListeningModule,
  ListeningSet,
  ReadingModule,
  ReadingSet,
  ScoreRequest,
  SpeakingWritingTaskType,
} from "@toefl-prep/shared";
import { scoreCtwGap } from "./ctwScorer.js";
import { scoreMcq } from "./mcqScorer.js";
import { NotFound } from "./scoreItems.js";
import type { AttemptRow, ItemResultRow } from "../db/rows.js";

/**
 * The one write deterministic scoring makes: every Item of one Task Type request, committed as a
 * single unit or not at all (db/stores/attempts.ts runs it in one transaction). There is
 * deliberately no per-Item writer. A client retrying a submission treats the route's
 * `alreadyScored: true` 409 as "the whole request landed", which is true only while no request can
 * be half-written; a partial commit would leave the unwritten Items unscored behind that answer.
 */
export type DeterministicScoreStore = {
  scoreDeterministicItemsBatch(
    items: Array<{ attemptId: string; itemId: string; taskType: string; score: number; scoreJson: string }>,
  ): void;
};

type Repo = DeterministicScoreStore;
// An Attempt row with its item_results rows; `.items` is what the idempotency check and the Router
// census read.
export type AttemptWithItems = AttemptRow & { items: ItemResultRow[] };

// One entry per scoreable Item id across all three modules of a Reading or Listening Set. A
// Complete the Words gap keeps its `completion` and Explanation; a multiple-choice question keeps
// what scoreMcq needs plus its skill and Explanation. `module` tags score_json: it drives the
// Module-order guard below and the band rule, which needs the Items of each Module the Attempt
// took (sectionEstimates.ts's bandShortfall). `transcript` is set only for Listening's conversation, announcement and
// academic talk questions: the audio is not on screen the way a Reading passage is, so a Drill's
// review needs the words. Listen and Choose a Response never gets one (see indexListeningModule).
type McqTaskType = Exclude<AnyTaskType, "complete_words" | SpeakingWritingTaskType>;

export type DeterministicItemRef =
  | { taskType: "complete_words"; module: "router" | "lower" | "upper"; completion: string; explanationZh: string }
  | {
      taskType: McqTaskType;
      module: "router" | "lower" | "upper";
      question: { options: { id: string; text: string }[]; correctOptionId: string; skill: string; explanationZh: string };
      transcript?: string;
    };

type McqQuestionLike = { id: string; options: { id: string; text: string }[]; correctOptionId: string; skill: string; explanationZh: string };

// One entry of the walk: an Item id and what the Set says about it.
type DeterministicItemEntry = readonly [id: string, ref: DeterministicItemRef];

// One multiple-choice question: the shape shared by Reading's daily_life/academic_passage questions
// and all four Listening Task Types (a listen_choose Item is one such question with no wrapper; the
// other three nest theirs under `.questions`).
function mcqEntry(
  taskType: McqTaskType,
  modulePath: "router" | "lower" | "upper",
  question: McqQuestionLike,
  transcript?: string,
): DeterministicItemEntry {
  return [question.id, {
    taskType, module: modulePath,
    question: { options: question.options, correctOptionId: question.correctOptionId, skill: question.skill, explanationZh: question.explanationZh },
    ...(transcript !== undefined ? { transcript } : {}),
  }];
}

function* readingModuleEntries(module: ReadingModule, modulePath: "router" | "lower" | "upper"): Generator<DeterministicItemEntry> {
  for (const passage of module.ctwPassages) {
    for (const gap of passage.gaps) {
      yield [gap.id, { taskType: "complete_words", module: modulePath, completion: gap.completion, explanationZh: gap.explanationZh }];
    }
  }
  for (const text of module.dailyLife) for (const question of text.questions) yield mcqEntry("daily_life", modulePath, question);
  for (const passage of module.academic) for (const question of passage.questions) yield mcqEntry("academic_passage", modulePath, question);
}

// Renders a conversation's turns as one review string, "<role>: <text>" per line, labelling each
// speaker by its `role` (e.g. "professor"), the label the speaker card shows, rather than its internal
// id. Every question of the conversation shares the whole exchange, as announcement and academic
// talk questions share their one transcript.
function formatConversationTranscript(conversation: {
  speakers: { id: string; role: string }[];
  transcript: { speakerId: string; text: string }[];
}): string {
  const roleById = new Map(conversation.speakers.map((speaker) => [speaker.id, speaker.role]));
  return conversation.transcript.map((turn) => `${roleById.get(turn.speakerId) ?? turn.speakerId}: ${turn.text}`).join("\n");
}

function* listeningModuleEntries(module: ListeningModule, modulePath: "router" | "lower" | "upper"): Generator<DeterministicItemEntry> {
  // A listen_choose Item is itself the one scoreable question, and it gets no `transcript`: its
  // `utterance` is never rendered as text, even after it is answered (`stripAnswers` withholds it
  // too). Its Explanation refers to the audio, which is a different disclosure from the verbatim
  // utterance.
  for (const item of module.listenChoose) yield mcqEntry("listen_choose", modulePath, item);
  for (const conversation of module.conversations) {
    const transcript = formatConversationTranscript(conversation);
    for (const question of conversation.questions) yield mcqEntry("conversation", modulePath, question, transcript);
  }
  for (const announcement of module.announcements) {
    for (const question of announcement.questions) yield mcqEntry("announcement", modulePath, question, announcement.transcript);
  }
  for (const talk of module.academicTalks) {
    for (const question of talk.questions) yield mcqEntry("academic_talk", modulePath, question, talk.transcript);
  }
}

/**
 * Every scoreable Item of a Reading or Listening Set's three modules, in the Set's own order, each
 * tagged with the module it came from. Ids are as the file has them, duplicates included; anything
 * that looks an Item up by id goes through indexDeterministicItems instead.
 */
export function* deterministicItemEntries(set: ReadingSet | ListeningSet): Generator<DeterministicItemEntry> {
  if (set.kind === "reading") {
    yield* readingModuleEntries(set.router, "router");
    yield* readingModuleEntries(set.lowerModule, "lower");
    yield* readingModuleEntries(set.upperModule, "upper");
  } else {
    yield* listeningModuleEntries(set.router, "router");
    yield* listeningModuleEntries(set.lowerModule, "lower");
    yield* listeningModuleEntries(set.upperModule, "upper");
  }
}

/**
 * Two Items of one Set share an id. Item rows are keyed by id, so either Item's Response could be
 * scored against the other's key, which would teach a wrong answer. The Set schema does not check
 * this on load (narrowing it would make banked Sets unloadable), so the lookup refuses the Set
 * instead.
 */
export class DuplicateItemIdError extends Error {
  constructor(readonly setId: string, readonly itemId: string) {
    super(`set ${setId} has more than one item with id ${itemId}`);
    this.name = "DuplicateItemIdError";
  }
}

/**
 * Flattens a Reading or Listening Set's three modules into one lookup keyed by Item id, each entry
 * tagged with the module it came from. Throws DuplicateItemIdError when an id appears twice, rather
 * than letting the later Item replace the earlier one.
 */
export function indexDeterministicItems(set: ReadingSet | ListeningSet): Map<string, DeterministicItemRef> {
  const index = new Map<string, DeterministicItemRef>();
  for (const [id, ref] of deterministicItemEntries(set)) {
    if (index.has(id)) throw new DuplicateItemIdError(set.id, id);
    index.set(id, ref);
  }
  return index;
}

export class UnknownItemError extends Error {}
export class AlreadyScoredError extends Error {}
// The Attempt exists but is the wrong kind for this Task Type: a conflict (409), unlike NotFound.
export class KindMismatchError extends Error {}
// Scoring after the Attempt has routed: either a Router Module Item (the Router Module is locked)
// or an Item from the second module the Router did not select. Both map to 409; only the message
// tells them apart.
export class ModuleLockedError extends Error {}

// `key`, `explanationZh` and `transcript` are Drill-only and never persisted: score_json does not
// store them.
type DeterministicScoreItem = { itemId: string; correct: boolean; key?: string; explanationZh?: string; transcript?: string };

/**
 * Router Module census for POST /api/attempts/:id/route: how many of the Set's Router Module Items
 * this Attempt has a row for, how many are missing, and how many were correct. A Reading or
 * Listening row is only ever written already scored (scoreDeterministicItemsBatch, in one
 * transaction), so a row's presence means scored and its `score` (0 or 1) is the correctness.
 *
 * Throws KindMismatchError for a non-Reading/Listening Attempt, NotFound when the Set is a different
 * kind from the Attempt (`set.kind !== attempt.kind` also narrows `set` for the index), and a plain
 * Error when the Router Module is empty: that is a malformed Set, and an empty census would hand
 * decidePath (0, 0), whose routerRaw is NaN.
 */
export function censusRouterItems(
  set: AnySet,
  attempt: AttemptWithItems
): { total: number; missing: number; correctCount: number } {
  if (attempt.kind !== "reading" && attempt.kind !== "listening") {
    throw new KindMismatchError(`routing requires a reading or listening attempt (this attempt is ${attempt.kind})`);
  }
  if (set.kind !== attempt.kind) {
    throw new NotFound(`routing requires a ${attempt.kind} set (this set is ${set.kind})`);
  }

  const index = indexDeterministicItems(set);
  const routerIds = [...index.entries()].filter(([, ref]) => ref.module === "router").map(([id]) => id);
  if (routerIds.length === 0) {
    throw new Error(`router census is empty — invalid ${set.kind} set`);
  }

  const byId = new Map(attempt.items.map((row) => [row.item_id, row]));
  let missing = 0;
  let correctCount = 0;
  for (const id of routerIds) {
    const row = byId.get(id);
    if (!row) {
      missing += 1;
      continue;
    }
    if (row.score === 1) correctCount += 1;
  }
  return { total: routerIds.length, missing, correctCount };
}

/**
 * Scores one Task Type request for Reading's three or Listening's four Task Types, inline: no
 * Judges, no Arbiter, no job row. Every check runs before the one write, in order: Attempt and Set
 * kind, unknown Item ids (UnknownItemError), any Item already scored (AlreadyScoredError, failing
 * the whole request), then the post-routing module guard (ModuleLockedError). The write commits
 * every Item or none. A Drill's response carries each Item's key and Explanation; a Simulation's
 * carries bare correctness.
 */
export function scoreDeterministicItems(args: {
  repo: Repo;
  attempt: AttemptWithItems;
  set: AnySet;
  request: ScoreRequest;
}): { taskType: string; items: DeterministicScoreItem[] } {
  const { repo, attempt, set, request } = args;
  const taskType = request.taskType;

  // Rules out a Speaking or Writing Attempt; the per-Item Task Type check in Phase 1 is what pins the
  // request to one section.
  if (attempt.kind !== "reading" && attempt.kind !== "listening") {
    throw new KindMismatchError(`${taskType} requires a reading or listening attempt (this attempt is ${attempt.kind})`);
  }
  // Defensive: creating an Attempt already refuses a Set of another kind, but readSet can return any
  // Set kind. Comparing against attempt.kind, rather than checking membership in {reading,
  // listening} again, also refuses a Reading Attempt pointed at a Listening Set, and narrows `set`.
  if (set.kind !== attempt.kind) {
    throw new NotFound(`${taskType} requires a ${attempt.kind} set (this set is ${set.kind})`);
  }

  const index = indexDeterministicItems(set);

  // Phase 1: resolve every requested item against the Set. An id that doesn't exist, or that
  // exists under a DIFFERENT task type, is "unknown" for this request — 404 before any write.
  const planned = request.items.map((item) => {
    const ref = index.get(item.itemId);
    if (!ref || ref.taskType !== taskType) throw new UnknownItemError(`unknown item ${item.itemId}`);
    return { itemId: item.itemId, ref, raw: item };
  });

  // Phase 2: any Item that already has a row fails the entire request, before anything is written.
  const existingIds = new Set(attempt.items.map((row) => row.item_id));
  const conflicts = planned.filter((p) => existingIds.has(p.itemId));
  if (conflicts.length > 0) {
    throw new AlreadyScoredError(`already scored: ${conflicts.map((p) => p.itemId).join(", ")}`);
  }

  // Phase 3: a Simulation sits its Modules in order. Before it has routed, only Router Module Items
  // may be scored: an Item of a second Module scored early would count toward a band the User was
  // never routed to. Once it has routed, the Router Module is locked and only the Module the Router
  // selected may be scored. Routing requires every Router Item scored, so a Router Item normally
  // fails Phase 2 first; this guard holds the lock whether or not a row exists. Separate throws, so
  // each conflict carries its own message. A Drill has no Module Path and is not held to an order.
  if (attempt.mode === "simulation" && attempt.module_path === null) {
    const early = planned.find((p) => p.ref.module !== "router");
    if (early) {
      throw new ModuleLockedError(
        `attempt ${attempt.id} has not been routed yet — cannot score "${early.ref.module}" module items before the router module`
      );
    }
  }
  if (attempt.module_path !== null) {
    if (planned.some((p) => p.ref.module === "router")) {
      throw new ModuleLockedError(
        `attempt ${attempt.id} has already routed to module "${attempt.module_path}" — the router module is locked`
      );
    }
    const wrongModule = planned.find((p) => p.ref.module !== attempt.module_path);
    if (wrongModule) {
      throw new ModuleLockedError(
        `attempt ${attempt.id} routed to module "${attempt.module_path}" — cannot score "${wrongModule.ref.module}" module items`
      );
    }
  }

  // A Drill discloses each Item's key and Explanation (錯題解析); a Simulation returns bare
  // correctness. Decided from attempt.mode, never from client input.
  const drill = attempt.mode === "drill";

  // Every Item's outcome is computed before anything is written, so the write below is one
  // all-or-nothing batch (see DeterministicScoreStore for why that matters).
  const computed = planned.map(({ itemId, ref, raw }) => {
    let correct: boolean;
    let key: string;
    let explanationZh: string;
    let skill: string | undefined;
    let answer: string;
    let transcript: string | undefined;

    if (ref.taskType === "complete_words") {
      const typed = "typed" in raw ? raw.typed : "";
      correct = scoreCtwGap(ref.completion, typed);
      key = ref.completion;
      explanationZh = ref.explanationZh;
      answer = typed;
      // A gap carries no skill tag and no transcript.
    } else {
      const selectedOptionId = "selectedOptionId" in raw ? raw.selectedOptionId : "";
      // MCQ_UNANSWERED_SENTINEL, and any option id that names no option, scores incorrect.
      correct = scoreMcq(ref.question, selectedOptionId).correct;
      key = ref.question.correctOptionId;
      explanationZh = ref.question.explanationZh;
      skill = ref.question.skill;
      answer = selectedOptionId;
      transcript = ref.transcript;
    }

    return { itemId, module: ref.module, correct, key, explanationZh, skill, answer, transcript };
  });

  repo.scoreDeterministicItemsBatch(
    computed.map((c) => ({
      attemptId: attempt.id,
      itemId: c.itemId,
      taskType,
      score: c.correct ? 1 : 0,
      scoreJson: JSON.stringify(
        c.skill !== undefined
          ? { correct: c.correct, skill: c.skill, module: c.module, answer: c.answer }
          : { correct: c.correct, module: c.module, answer: c.answer }
      ),
    }))
  );

  // `transcript` is spread in only when present, so a Reading Drill response carries no
  // `transcript` key at all, and a Simulation response carries no review field of any kind.
  const items: DeterministicScoreItem[] = computed.map(({ itemId, correct, key, explanationZh, transcript }) =>
    drill ? { itemId, correct, key, explanationZh, ...(transcript !== undefined ? { transcript } : {}) } : { itemId, correct }
  );

  return { taskType, items };
}
