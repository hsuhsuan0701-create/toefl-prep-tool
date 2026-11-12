import {
  compareStrings,
  issue,
  issueOrder,
  TASK_ORDER,
  type DiversityIssue,
  type NoveltyTaskType,
} from "./diversityIssues.js";
import {
  emptyDomainCount,
  inferGenerationDomain,
  type DomainCount,
} from "./generationDomains.js";
import {
  containmentScore,
  contentTokens,
  normalizeNoveltyText,
} from "./noveltySimilarity.js";
import type { SetBankKind, SetParseCategory, SetStore } from "./setStore.js";
import { assertNever } from "../lib/assertNever.js";
import type {
  AnySet,
  GenerationDomainFamily,
  GenerationPlan,
  ListeningGenerationInput,
  ListeningGenerationPlan,
  ListeningSet,
  ReadingGeneratedSet,
  ReadingGenerationPlan,
  ReadingSet,
  SpeakingGenerationInput,
  SpeakingGenerationPlan,
  WritingGenerationInput,
  WritingGenerationPlan,
} from "@toefl-prep/shared";

// =================================================================================================
// The Catalog: the prior Sets a Plan is checked against for novelty. What a Catalog entry is and
// how one is derived from a Plan or a Set (`entriesFromPlan`/`entriesFromSet`), how two entries are
// compared (`compareCatalogEntries`), and how the whole bank is built and cached
// (`buildNoveltyCatalog`).
//
// The planner sends a bounded slice of these entries to the model, which is what steers a new Set
// away from old ones, and measures each planned component against all of them.
//
// Provider-free by construction: `buildNoveltyCatalog` reads Sets only through the `SetStore` port
// (a type-only import), and that port has no member that can reach a provider (setStore.test.ts
// walks its import graph). The novelty audit therefore cannot spend money.
// =================================================================================================

export type NoveltyPlan = Extract<GenerationPlan, { kind: "speaking" | "writing" | "reading" | "listening" }>;

type NoveltySet = Extract<AnySet, { kind: "speaking" | "writing" | "reading" | "listening" }>;

/**
 * One component of a Plan or a Set (one Stimulus, situation or task) as the Catalog compares it.
 *
 * The normalized fields (`descriptor`, `noveltyKey`, `canonicalTitle`, `conceptTokens`) are derived
 * from raw source text exactly once, when the entry is built, and nothing downstream may normalize
 * them again: normalization is not idempotent ("buildings" stems to "building", and a second pass
 * to "build"), so a twice-normalized field can never match a once-normalized one.
 */
export interface NoveltyCatalogEntry {
  setId: string;
  source: "ets-sample" | "generated" | "imported";
  // Only decides which entries survive the planner prompt's size bound (newest first). Never part
  // of any comparison.
  createdAt: string;
  taskType: NoveltyTaskType;
  domain: GenerationDomainFamily;
  noveltyKey?: string;
  canonicalTitle?: string;
  /** Normalized; what the planner prompt shows. */
  descriptor: string;
  /**
   * The descriptor's source text, unnormalized: what the domain classifier reads. The classifier
   * keeps the stop words normalization drops ("student" is a campus-academics keyword) and stems
   * once, so it must never be handed `descriptor`.
   */
  classifierText: string;
  /** Unique content tokens the containment measure compares. */
  conceptTokens: string[];
  itemPosition: number;
  // Plan entries of Reading and Listening only: the slot's own plan text, for retry-prompt
  // readability. Never used in any comparison.
  planLabel?: string;
}

/**
 * Two components overlap when at least this share of the smaller one's concept tokens appears in the
 * other, and the smaller one has enough tokens for the share to mean something.
 */
export const NOVELTY_THRESHOLDS = Object.freeze({
  containment: 0.78,
  containmentMinTokens: 5,
});

/**
 * The `createdAt` of an entry with no saved Set (a reserved Plan). It sorts newest, so the planner
 * prompt's size bound drops saved Sets' entries before an in-flight Plan's.
 */
export const PENDING_ENTRY_CREATED_AT = "9999-12-31T23:59:59.999Z";

interface EntryIdentity {
  setId: string;
  source: "ets-sample" | "generated" | "imported";
  createdAt?: string;
}

/** The overlap between two components of the same Task Type, or nothing. */
export function compareCatalogEntries(
  candidate: NoveltyCatalogEntry,
  prior: NoveltyCatalogEntry,
): DiversityIssue[] {
  if (candidate.taskType !== prior.taskType) return [];
  const smallerTokenCount = Math.min(
    new Set(candidate.conceptTokens).size,
    new Set(prior.conceptTokens).size,
  );
  if (smallerTokenCount < NOVELTY_THRESHOLDS.containmentMinTokens) return [];
  const containment = containmentScore(candidate.conceptTokens, prior.conceptTokens);
  if (containment < NOVELTY_THRESHOLDS.containment) return [];
  return [issue(candidate.taskType, "containment", candidate.setId, prior.setId, containment)];
}

/**
 * Every same-Task-Type overlap among `entries`, pairwise. `options.withinSet` also compares
 * components of one Set (Build a Sentence's ten situations, say), which the novelty audit wants to
 * see.
 */
export function findCatalogCollisions(
  entries: readonly NoveltyCatalogEntry[],
  options: { withinSet?: boolean } = {},
): DiversityIssue[] {
  const issues: DiversityIssue[] = [];
  for (let left = 0; left < entries.length; left += 1) {
    for (let right = left + 1; right < entries.length; right += 1) {
      const sameSet = entries[left].setId === entries[right].setId;
      if (sameSet && !options.withinSet) continue;
      issues.push(...compareCatalogEntries(entries[left], entries[right]));
    }
  }
  return issues.sort(issueOrder);
}

function normalizedJoin(...parts: readonly string[]): string {
  return normalizeNoveltyText(parts.join(" ")) || "unclassified content";
}

function substantiveDiscussionProposition(professorPost: string): string {
  const sentences = professorPost.split(/(?<=[.!?])\s+/u);
  const substantiveQuestions = sentences.filter(
    (sentence) =>
      sentence.includes("?") && contentTokens(sentence).length >= 5,
  );
  return substantiveQuestions.at(-1) ?? professorPost;
}

function catalogEntry(input: Omit<
  NoveltyCatalogEntry,
  "createdAt" | "descriptor" | "classifierText" | "conceptTokens"
> & {
  createdAt?: string;
  descriptorParts: readonly string[];
  /** Raw text whose tokens represent this component for comparison, when not the whole descriptor. */
  comparisonText?: string;
  noveltyKeyRaw?: string;
  canonicalTitleRaw?: string;
}): NoveltyCatalogEntry {
  const {
    descriptorParts,
    comparisonText,
    noveltyKeyRaw,
    canonicalTitleRaw,
    createdAt,
    ...rest
  } = input;
  const descriptorRaw = descriptorParts.join(" ");
  const noveltyKey = noveltyKeyRaw === undefined
    ? undefined
    : normalizeNoveltyText(noveltyKeyRaw);
  const canonicalTitle = canonicalTitleRaw === undefined
    ? undefined
    : normalizeNoveltyText(canonicalTitleRaw);
  return {
    ...rest,
    createdAt: createdAt ?? PENDING_ENTRY_CREATED_AT,
    ...(noveltyKey ? { noveltyKey } : {}),
    ...(canonicalTitle ? { canonicalTitle } : {}),
    descriptor: normalizedJoin(descriptorRaw),
    classifierText: descriptorRaw,
    conceptTokens: contentTokens(comparisonText ?? descriptorRaw),
  };
}

function entriesFromSpeakingPlan(
  plan: SpeakingGenerationPlan,
  identity: EntryIdentity,
): NoveltyCatalogEntry[] {
  return [
    catalogEntry({
      ...identity,
      taskType: "listen_repeat",
      domain: plan.listenAndRepeat.domain,
      noveltyKeyRaw: plan.listenAndRepeat.noveltyKey,
      itemPosition: 0,
      descriptorParts: [
        plan.listenAndRepeat.setting,
        plan.listenAndRepeat.speakerRole,
        plan.listenAndRepeat.communicativePurpose,
        ...plan.listenAndRepeat.requiredConcepts,
      ],
    }),
    catalogEntry({
      ...identity,
      taskType: "interview",
      domain: plan.interview.domain,
      noveltyKeyRaw: plan.interview.noveltyKey,
      itemPosition: 0,
      descriptorParts: [
        plan.interview.topic,
        plan.interview.premise,
        ...plan.interview.questionArc,
        ...plan.interview.requiredConcepts,
      ],
    }),
  ];
}

function entriesFromWritingPlan(
  plan: WritingGenerationPlan,
  identity: EntryIdentity,
): NoveltyCatalogEntry[] {
  const buildASentence = plan.buildASentence.situations.map(
    (situation, itemPosition) => catalogEntry({
      ...identity,
      taskType: "build_sentence",
      domain: situation.domain,
      noveltyKeyRaw: situation.noveltyKey,
      itemPosition,
      descriptorParts: [
        situation.situation,
        ...situation.participantRoles,
        ...situation.requiredConcepts,
      ],
    }),
  );
  return [
    ...buildASentence,
    catalogEntry({
      ...identity,
      taskType: "email",
      domain: plan.email.domain,
      noveltyKeyRaw: plan.email.noveltyKey,
      itemPosition: 0,
      descriptorParts: [
        plan.email.situation,
        plan.email.recipientRole,
        ...plan.email.communicativeActs,
        ...plan.email.requiredConcepts,
      ],
    }),
    catalogEntry({
      ...identity,
      taskType: "discussion",
      domain: plan.academicDiscussion.domain,
      noveltyKeyRaw: plan.academicDiscussion.noveltyKey,
      itemPosition: 0,
      descriptorParts: [
        plan.academicDiscussion.proposition,
        ...plan.academicDiscussion.competingValues,
        ...plan.academicDiscussion.requiredConcepts,
      ],
      // A Set without a stored Plan has its Discussion narrowed to the professor's question
      // (entriesFromSet), so the planned side is narrowed the same way: the proposition, not the
      // framing or the competing values.
      comparisonText: plan.academicDiscussion.proposition,
    }),
  ];
}

function entriesFromReadingPlan(
  plan: ReadingGenerationPlan,
  identity: EntryIdentity,
): NoveltyCatalogEntry[] {
  const ctwPassages = plan.ctwPassages.map((entry, itemPosition) =>
    catalogEntry({
      ...identity,
      taskType: "complete_words" as const,
      domain: entry.domain,
      noveltyKeyRaw: entry.noveltyKey,
      itemPosition,
      planLabel: entry.topic,
      descriptorParts: [entry.topic, entry.angle, ...entry.requiredConcepts],
    })
  );
  const dailyLifeTexts = plan.dailyLifeTexts.map((entry, itemPosition) =>
    catalogEntry({
      ...identity,
      taskType: "daily_life" as const,
      domain: entry.domain,
      noveltyKeyRaw: entry.noveltyKey,
      itemPosition,
      planLabel: `${entry.genre}: ${entry.scenario}`,
      descriptorParts: [entry.genre, entry.scenario, ...entry.requiredConcepts],
    })
  );
  const academicPassages = plan.academicPassages.map((entry, itemPosition) =>
    catalogEntry({
      ...identity,
      taskType: "academic_passage" as const,
      domain: entry.domain,
      noveltyKeyRaw: entry.noveltyKey,
      itemPosition,
      planLabel: entry.title,
      descriptorParts: [entry.title, entry.discipline, entry.angle, ...entry.requiredConcepts],
    })
  );
  return [...ctwPassages, ...dailyLifeTexts, ...academicPassages];
}

// Listening's novelty axes are settings, speaker roles and topics. A Conversation's two speaker roles
// are both folded into its descriptor, so comparison sees the whole pairing. `planLabel` is populated
// for all four Task Types, as Reading's are, for retry-prompt addressability.
function entriesFromListeningPlan(
  plan: ListeningGenerationPlan,
  identity: EntryIdentity,
): NoveltyCatalogEntry[] {
  const listenChoose = plan.listenChoose.map((entry, itemPosition) =>
    catalogEntry({
      ...identity,
      taskType: "listen_choose" as const,
      domain: entry.domain,
      noveltyKeyRaw: entry.noveltyKey,
      itemPosition,
      planLabel: entry.topic,
      descriptorParts: [entry.topic, entry.speakerRole, ...entry.requiredConcepts],
    })
  );
  const conversations = plan.conversations.map((entry, itemPosition) =>
    catalogEntry({
      ...identity,
      taskType: "conversation" as const,
      domain: entry.domain,
      noveltyKeyRaw: entry.noveltyKey,
      itemPosition,
      planLabel: `${entry.speakerRoles[0]} & ${entry.speakerRoles[1]}: ${entry.setting}`,
      descriptorParts: [entry.setting, ...entry.speakerRoles, ...entry.requiredConcepts],
    })
  );
  const announcements = plan.announcements.map((entry, itemPosition) =>
    catalogEntry({
      ...identity,
      taskType: "announcement" as const,
      domain: entry.domain,
      noveltyKeyRaw: entry.noveltyKey,
      itemPosition,
      planLabel: `${entry.speakerRole}: ${entry.setting}`,
      descriptorParts: [entry.setting, entry.speakerRole, ...entry.requiredConcepts],
    })
  );
  const academicTalks = plan.academicTalks.map((entry, itemPosition) =>
    catalogEntry({
      ...identity,
      taskType: "academic_talk" as const,
      domain: entry.domain,
      noveltyKeyRaw: entry.noveltyKey,
      itemPosition,
      planLabel: entry.discipline,
      descriptorParts: [entry.discipline, entry.speakerRole, ...entry.requiredConcepts],
    })
  );
  return [...listenChoose, ...conversations, ...announcements, ...academicTalks];
}

/** A Plan's Catalog entries, one per planned component, positioned by its index in the Plan. */
export function entriesFromPlan(
  plan: NoveltyPlan,
  identity: EntryIdentity,
): NoveltyCatalogEntry[] {
  if (plan.kind === "speaking") return entriesFromSpeakingPlan(plan, identity);
  if (plan.kind === "writing") return entriesFromWritingPlan(plan, identity);
  if (plan.kind === "reading") return entriesFromReadingPlan(plan, identity);
  if (plan.kind === "listening") return entriesFromListeningPlan(plan, identity);
  return assertNever(plan);
}

// A Reading Set's modules are flattened in this order, separately for each Stimulus shape, so a
// candidate's Nth Complete the Words / Daily Life / Academic entry lines up with the Plan's Nth
// entry of that shape (readingGenerator.ts consumes the Plan's entries walking the modules in the
// same order). generationNovelty.ts's candidateDomainDriftNotes matches planned to generated entries
// by (taskType, itemPosition) alone, so an entry count that differs from the Plan's would silently
// pair the wrong components.
const READING_MODULE_ORDER = ["router", "lowerModule", "upperModule"] as const;

function entriesFromReadingSet(
  set: ReadingSet | ReadingGeneratedSet,
  identity: EntryIdentity,
): NoveltyCatalogEntry[] {
  const ctwPassages = READING_MODULE_ORDER.flatMap((moduleName) => set[moduleName].ctwPassages);
  const dailyLife = READING_MODULE_ORDER.flatMap((moduleName) => set[moduleName].dailyLife);
  const academic = READING_MODULE_ORDER.flatMap((moduleName) => set[moduleName].academic);

  const ctw = ctwPassages.map((passage, itemPosition) =>
    catalogEntry({
      ...identity,
      taskType: "complete_words" as const,
      domain: inferGenerationDomain([passage.topic, passage.sourceParagraph].join(" ")),
      canonicalTitleRaw: passage.topic,
      itemPosition,
      descriptorParts: [passage.topic, passage.sourceParagraph],
    })
  );
  const dl = dailyLife.map((text, itemPosition) =>
    catalogEntry({
      ...identity,
      taskType: "daily_life" as const,
      domain: inferGenerationDomain([text.genre, text.text].join(" ")),
      itemPosition,
      descriptorParts: [text.genre, text.text],
    })
  );
  const ap = academic.map((passage, itemPosition) =>
    catalogEntry({
      ...identity,
      taskType: "academic_passage" as const,
      domain: inferGenerationDomain([passage.title, passage.discipline, passage.text].join(" ")),
      canonicalTitleRaw: passage.title,
      itemPosition,
      descriptorParts: [passage.title, passage.discipline, passage.text],
    })
  );
  return [...ctw, ...dl, ...ap];
}

// The Listening counterpart to entriesFromReadingSet, in the same router/lower/upper order. A
// generated candidate carries no Plan until it is published, so this is the path candidate checks
// take, not only a fallback for saved Sets without one. The domain is inferred from the content, as
// for Reading; Listening Stimuli have no title-like field, so there is no `canonicalTitle`.
function entriesFromListeningSet(
  set: ListeningSet | ListeningGenerationInput,
  identity: EntryIdentity,
): NoveltyCatalogEntry[] {
  const modules = [set.router, set.lowerModule, set.upperModule];
  const listenChoose = modules.flatMap((module) => module.listenChoose);
  const conversations = modules.flatMap((module) => module.conversations);
  const announcements = modules.flatMap((module) => module.announcements);
  const academicTalks = modules.flatMap((module) => module.academicTalks);

  const lc = listenChoose.map((item, itemPosition) =>
    catalogEntry({
      ...identity,
      taskType: "listen_choose" as const,
      domain: inferGenerationDomain([item.utterance, item.speaker.role].join(" ")),
      itemPosition,
      descriptorParts: [item.utterance, item.speaker.role],
    })
  );
  const conv = conversations.map((conversation, itemPosition) =>
    catalogEntry({
      ...identity,
      taskType: "conversation" as const,
      domain: inferGenerationDomain([
        conversation.setting,
        ...conversation.speakers.map((speaker) => speaker.role),
        ...conversation.transcript.map((turn) => turn.text),
      ].join(" ")),
      itemPosition,
      descriptorParts: [
        conversation.setting,
        ...conversation.speakers.map((speaker) => speaker.role),
        ...conversation.transcript.map((turn) => turn.text),
      ],
    })
  );
  const ann = announcements.map((announcement, itemPosition) =>
    catalogEntry({
      ...identity,
      taskType: "announcement" as const,
      domain: inferGenerationDomain([announcement.setting, announcement.speaker.role, announcement.transcript].join(" ")),
      itemPosition,
      descriptorParts: [announcement.setting, announcement.speaker.role, announcement.transcript],
    })
  );
  const talks = academicTalks.map((talk, itemPosition) =>
    catalogEntry({
      ...identity,
      taskType: "academic_talk" as const,
      domain: inferGenerationDomain([talk.discipline, talk.speaker.role, talk.transcript].join(" ")),
      itemPosition,
      descriptorParts: [talk.discipline, talk.speaker.role, talk.transcript],
    })
  );
  return [...lc, ...conv, ...ann, ...talks];
}

/**
 * A Set's or a candidate's Catalog entries: from its stored Plan when it carries one, so a
 * generated Set is compared exactly as it was planned; otherwise derived from its content. A
 * candidate carries no Plan before publication, so candidate checks always read content.
 */
export function entriesFromSet(
  set:
    | NoveltySet
    | SpeakingGenerationInput
    | WritingGenerationInput
    | ReadingGeneratedSet
    | ListeningGenerationInput,
): NoveltyCatalogEntry[] {
  const persistedPlan = "generationPlan" in set
    ? set.generationPlan
    : undefined;
  const identity: EntryIdentity = {
    setId: set.id,
    source: set.source,
    createdAt: set.createdAt,
  };
  if (persistedPlan) {
    return entriesFromPlan(persistedPlan, identity);
  }
  if (set.kind === "reading") {
    return entriesFromReadingSet(set, identity);
  }
  if (set.kind === "listening") {
    return entriesFromListeningSet(set, identity);
  }
  if (set.kind === "speaking") {
    const listenRaw = [
      set.listenAndRepeat.scenarioTitle,
      set.listenAndRepeat.scenarioDescription,
      ...set.listenAndRepeat.items.map((item) => item.sentence),
    ];
    const interviewRaw = [
      set.interview.scenarioTitle,
      set.interview.intro,
      ...set.interview.questions.map((question) => question.question),
    ];
    return [
      catalogEntry({
        ...identity,
        taskType: "listen_repeat",
        domain: inferGenerationDomain(listenRaw.join(" ")),
        canonicalTitleRaw: set.listenAndRepeat.scenarioTitle,
        itemPosition: 0,
        descriptorParts: listenRaw,
      }),
      catalogEntry({
        ...identity,
        taskType: "interview",
        domain: inferGenerationDomain(interviewRaw.join(" ")),
        canonicalTitleRaw: set.interview.scenarioTitle,
        itemPosition: 0,
        descriptorParts: interviewRaw,
      }),
    ];
  }

  const buildASentence = set.buildASentence.items.map(
    (item, itemPosition) => {
      const acceptedAnswers = [...new Set(
        item.answers.map((answer) => answer.join(" ")),
      )];
      // The frame's FIXED words count too: an accepted answer is only the tiles, and the frame is
      // where a proper noun or a date has to live (no tile may carry a capital). Blanks are erased
      // rather than parsed: this function reads every banked Set and must not throw on one whose
      // frame is malformed.
      const frameWords = typeof item.frame === "string"
        ? [item.frame.replace(/_+/gu, " ")]
        : [];
      const descriptorParts = [item.prompt, ...frameWords, ...acceptedAnswers];
      return catalogEntry({
        ...identity,
        taskType: "build_sentence" as const,
        domain: inferGenerationDomain(descriptorParts.join(" ")),
        itemPosition,
        descriptorParts,
      });
    },
  );
  const emailRaw = [
    set.email.subject,
    set.email.scenario,
    set.email.to,
    ...set.email.bullets,
  ];
  const discussionRaw = [
    set.academicDiscussion.courseTitle,
    set.academicDiscussion.professorPost,
    ...set.academicDiscussion.studentPosts.map((post) => post.post),
  ];
  // The descriptor keeps the course context, proposition and both positions, but comparison reads
  // only the professor's substantive question: a long framing paragraph and two opposing student
  // posts would otherwise dilute a near-identical proposition below the containment threshold.
  // Generic tails such as "Why or why not?" fall below the minimum content-token rule.
  const discussionProposition = substantiveDiscussionProposition(
    set.academicDiscussion.professorPost,
  );
  return [
    ...buildASentence,
    catalogEntry({
      ...identity,
      taskType: "email",
      domain: inferGenerationDomain(emailRaw.join(" ")),
      canonicalTitleRaw: set.email.subject,
      itemPosition: 0,
      descriptorParts: emailRaw,
    }),
    catalogEntry({
      ...identity,
      taskType: "discussion",
      domain: inferGenerationDomain(discussionRaw.join(" ")),
      itemPosition: 0,
      descriptorParts: discussionRaw,
      comparisonText: discussionProposition,
    }),
  ];
}

/** The Catalog's sort order: Task Type, then Set id, then position. */
export function compareCatalogOrder(
  left: NoveltyCatalogEntry,
  right: NoveltyCatalogEntry,
): number {
  return (
    TASK_ORDER.indexOf(left.taskType) - TASK_ORDER.indexOf(right.taskType) ||
    compareStrings(left.setId, right.setId) ||
    left.itemPosition - right.itemPosition
  );
}

function safeWarning(
  warn: (message: string) => void,
  kind: SetBankKind,
  file: string,
  category: SetParseCategory | "kind-mismatch",
): void {
  warn(`Skipping invalid set file ${kind}/${file}: ${category}`);
}

// Building the Catalog parses every saved Set on the server's one event loop, twice per plan
// attempt (the prompt, then admission), long enough to stall job polling and the Dashboard. The
// saved entries are therefore cached per bank and invalidated by the store's fingerprint (file name,
// size, mtime), which changes whenever a Set is published, edited or removed. Reservations and the
// retired-Set filter are applied fresh on every build, never cached.
//
// Keyed on `store.bankDir` rather than on a store instance, so two stores over the same bank (the
// audit builds a fresh one per run) share one entry.
interface CatalogCache {
  fingerprint: string;
  entries: NoveltyCatalogEntry[];
}

const catalogCache = new Map<string, CatalogCache>();

// The store owns parsing and its failure categories. The Catalog adds one rule of its own: a Set
// file whose `kind` disagrees with the directory it sits in is skipped with a warning.
function readSavedEntries(
  store: SetStore,
  warn: (message: string) => void,
): NoveltyCatalogEntry[] {
  const entries: NoveltyCatalogEntry[] = [];
  // `files`, not `sets`/`failures`, so warnings come out interleaved in bank order.
  for (const scanned of store.scanBank().files) {
    if (!scanned.ok) {
      safeWarning(warn, scanned.kind, scanned.file, scanned.category);
      continue;
    }
    if (scanned.set.kind !== scanned.kind) {
      safeWarning(warn, scanned.kind, scanned.file, "kind-mismatch");
      continue;
    }
    entries.push(...entriesFromSet(scanned.set));
  }
  return entries;
}

/**
 * The Catalog over one bank: every saved Set's entries (minus retired Sets), plus every reserved
 * Plan's under the id `pending:<ownerId>`, sorted by `compareCatalogOrder`.
 *
 * Takes the `SetStore` port rather than a directory, so the store is the only way Sets reach this
 * function and the Catalog's provider-freedom is structural (see the header). A caller with just a
 * directory builds one with `createSetStore(dataDir)`.
 */
export function buildNoveltyCatalog(input: {
  store: SetStore;
  reservations?: readonly { ownerId: string; plan: NoveltyPlan }[];
  warn?: (message: string) => void;
  // Saved Sets retired by a newer Set (the supersession manifest, docs/adr/0011). They must stop
  // constraining what a replacement may look like, since a replacement naturally resembles the Set
  // it replaces. Applied after the cache, never inside readSavedEntries: retiring a Set changes no
  // Set file, so the fingerprint would not notice it.
  supersededSetIds?: ReadonlySet<string>;
}): NoveltyCatalogEntry[] {
  const warn = input.warn ?? ((message: string) => console.warn(message));
  const store = input.store;
  const fingerprint = store.fingerprint();
  const cached = catalogCache.get(store.bankDir);
  const saved = cached?.fingerprint === fingerprint
    ? cached.entries
    : readSavedEntries(store, warn);
  if (cached?.fingerprint !== fingerprint) {
    catalogCache.set(store.bankDir, { fingerprint, entries: saved });
  }
  const superseded = input.supersededSetIds;
  const entries = superseded && superseded.size > 0
    ? saved.filter((entry) => !superseded.has(entry.setId))
    : [...saved];
  for (const reservation of input.reservations ?? []) {
    entries.push(...entriesFromPlan(reservation.plan, {
      setId: `pending:${reservation.ownerId}`,
      source: "generated",
    }));
  }
  return entries.sort(compareCatalogOrder);
}

export type DomainCountsByTask = Record<NoveltyTaskType, DomainCount>;

/** Per Task Type, how many Catalog entries fall in each domain family. */
export function domainCounts(
  entries: readonly NoveltyCatalogEntry[],
): DomainCountsByTask {
  const result = Object.fromEntries(
    TASK_ORDER.map((taskType) => [taskType, emptyDomainCount()]),
  ) as DomainCountsByTask;
  for (const entry of entries) {
    result[entry.taskType][entry.domain] += 1;
  }
  return result;
}
