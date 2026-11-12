import { asUntrustedServedSet, type FocusRegion, type UntrustedServedSet } from "@toefl-prep/shared";

/**
 * What Attempt review keeps from the Set an Attempt was taken against.
 *
 * An Attempt renders entirely from GET /api/attempts/:id. The Set is fetched separately and
 * best-effort: it never gates the page or errors it, and a Set that cannot be read at all (deleted,
 * 404, offline) leaves the snapshot null. Retired Sets stay readable so past Attempts remain
 * reviewable, and a review must not become a broken page the day its Set goes away.
 *
 * Everything in here is therefore a display enrichment with a working fallback, and this module
 * reduces one `getSet` response to those enrichments without ever throwing: a snapshot that threw
 * inside the fetch's `.then` would lose the other enrichments with it. So it reads through
 * `UntrustedServedSet` (shared/src/servedSet.ts), not `expectServedSet`, the throwing narrowing the
 * Drills and Simulations use: a retired Set that no longer parses, or has gone away, degrades to "no
 * enrichment", never to an error. The shared type still keeps the field names below the served
 * union's own, so renaming one on a Set schema breaks this compile instead of silently dropping the
 * enrichment it fed.
 *
 * Only one kind of enrichment applies to any one Set (a Set is one section), but they share one
 * snapshot because they arrive on one request and are dropped together.
 */

/** The Listen and Repeat scene image, plus which part of it each Item points at. */
export type AttemptSceneSnapshot = Readonly<{
  file: string;
  focusRegionsByItemId: Readonly<Record<string, Readonly<FocusRegion> | undefined>>;
}>;

/** One Build a Sentence Item as the Set serves it today: its frame (if any), tiles and prompt. */
export type SentenceItemSnapshot = Readonly<{ frame?: string; tiles: readonly string[]; prompt?: string }>;

export type SnapshotModule = "router" | "lower" | "upper";

/**
 * One Reading or Listening Stimulus, in the Set's own order: which Module it belongs to, its Task
 * Type, the words that name it (a passage title, a text's genre, a talk's discipline, a setting),
 * and its Item ids in order. Review groups an Attempt's Items under these.
 */
export type StimulusSnapshot = Readonly<{
  id: string;
  module: SnapshotModule;
  taskType: string;
  name: string | null;
  itemIds: readonly string[];
}>;

/**
 * What a Reading or Listening Item showed the User: a question's stem and options, or a Complete
 * the Words gap's visible prefix. The served Set carries neither key nor Explanation; those come
 * only from the Attempt detail, and only once the Attempt is complete.
 */
export type QuestionSnapshot = Readonly<{
  stimulusId: string;
  stem: string | null;
  options: readonly Readonly<{ id: string; text: string }>[];
  prefix: string | null;
}>;

/** The task an essay Item answered, as the Set serves it: the lines that set it. */
export type EssayTaskSnapshot = Readonly<{ lines: readonly string[] }>;

export type AttemptSetSnapshot = Readonly<{
  /** The Set this was read from, so a snapshot left over from a previous Attempt is discarded. */
  setId: string;
  scene: AttemptSceneSnapshot | null;
  /**
   * Each Build a Sentence Item by id: the frame its tiles complete (see shared/src/sentenceFrame.ts),
   * absent for a frameless Item, and the tiles the Item serves today, which is how a review tells
   * whether a Response was given against this version of the Item at all (see
   * {@link buildSentenceComposition}). Read through the functions below, never indexed directly.
   */
  sentenceItemsByItemId: Readonly<Record<string, SentenceItemSnapshot>>;
  /** A Reading or Listening Set's Stimuli in test order; empty for any other Set. */
  stimuli: readonly StimulusSnapshot[];
  /** Each Reading or Listening Item by id. Read through {@link questionFor}. */
  questionsByItemId: Readonly<Record<string, QuestionSnapshot>>;
  /** The Email and Academic Discussion task by Item id. Read through {@link essayTaskFor}. */
  essayTasksByItemId: Readonly<Record<string, EssayTaskSnapshot>>;
}>;

export function snapshotAttemptSet(setId: string, value: unknown): AttemptSetSnapshot {
  const set = asUntrustedServedSet(value);
  const { stimuli, questionsByItemId } = snapshotStimuli(set);
  return Object.freeze({
    setId,
    scene: snapshotScene(set),
    sentenceItemsByItemId: snapshotSentenceItems(set),
    stimuli,
    questionsByItemId,
    essayTasksByItemId: snapshotEssayTasks(set),
  });
}

function ownEntry<T>(record: Readonly<Record<string, T>>, key: string): T | undefined {
  return Object.prototype.hasOwnProperty.call(record, key) ? record[key] : undefined;
}

/** One Reading or Listening Item's question, or undefined without a snapshot or for an unknown id. */
export function questionFor(snapshot: AttemptSetSnapshot | null, itemId: string): QuestionSnapshot | undefined {
  return snapshot ? ownEntry(snapshot.questionsByItemId, itemId) : undefined;
}

/** The task an Email or Academic Discussion Item set, or undefined. */
export function essayTaskFor(snapshot: AttemptSetSnapshot | null, itemId: string): EssayTaskSnapshot | undefined {
  return snapshot ? ownEntry(snapshot.essayTasksByItemId, itemId) : undefined;
}

/** A Build a Sentence Item's prompt as served today, or undefined. */
export function sentencePromptFor(snapshot: AttemptSetSnapshot | null, itemId: string): string | undefined {
  return sentenceItemFor(snapshot, itemId)?.prompt;
}

/**
 * `hasOwnProperty` rather than a bare index: an Item id is `[A-Za-z0-9_-]+` (SafeIdSchema), which
 * admits "constructor" and "toString", and a bare index would hand the caller an inherited function.
 */
function sentenceItemFor(snapshot: AttemptSetSnapshot | null, itemId: string): SentenceItemSnapshot | undefined {
  if (!snapshot) return undefined;
  const items = snapshot.sentenceItemsByItemId;
  return Object.prototype.hasOwnProperty.call(items, itemId) ? items[itemId] : undefined;
}

/**
 * One Build a Sentence Item's frame in the Set as served today, or undefined when there is none to
 * be had — no snapshot (the Set has not arrived yet, or could not be read), a frameless Item, or an
 * Item id the Set does not carry.
 */
export function sentenceFrameFor(snapshot: AttemptSetSnapshot | null, itemId: string): string | undefined {
  return sentenceItemFor(snapshot, itemId)?.frame;
}

/**
 * How a review should write out a Build a Sentence Response and its key.
 *
 * `frame` is what to compose the tile texts with (undefined: join them in order, as a frameless
 * Item's tiles already form the sentence). `revised` says the Item has changed since the Response
 * was given, so the Response belongs to an Item version that no longer exists and the review should
 * say so.
 *
 * The Set read today is not always the version a Response was given against (a frameless Item can
 * have become a frame Item), and composing a Response with a frame it was not answered against reads
 * as garbled text under a tick. So the frame is chosen in this order:
 *   1. the frame persisted with the Response at scoring time (`scoreJson.frame`; null = frameless);
 *   2. today's frame, but only when the Response and every key arrangement are drawn from today's
 *      tiles (a sub-multiset), the evidence that the Item has not changed underneath them;
 *   3. otherwise none, and `revised`, unless the Set could not be read at all, where nothing can be
 *      said either way.
 */
export function buildSentenceComposition(
  snapshot: AttemptSetSnapshot | null,
  itemId: string,
  scoreJson: unknown,
  arrangements: readonly (readonly string[])[],
): { frame: string | undefined; revised: boolean } {
  if (typeof scoreJson === "object" && scoreJson !== null && Object.prototype.hasOwnProperty.call(scoreJson, "frame")) {
    const persisted = (scoreJson as { frame?: unknown }).frame;
    if (typeof persisted === "string" && persisted !== "") return { frame: persisted, revised: false };
    if (persisted === null) return { frame: undefined, revised: false };
  }
  if (!snapshot || Object.keys(snapshot.sentenceItemsByItemId).length === 0) return { frame: undefined, revised: false };

  const current = sentenceItemFor(snapshot, itemId);
  if (!current) return { frame: undefined, revised: true };
  const fits = arrangements.every((tiles) => isSubMultiset(tiles, current.tiles));
  return fits ? { frame: current.frame, revised: false } : { frame: undefined, revised: true };
}

function isSubMultiset(part: readonly string[], whole: readonly string[]): boolean {
  const available = new Map<string, number>();
  for (const tile of whole) available.set(tile, (available.get(tile) ?? 0) + 1);
  for (const tile of part) {
    const left = available.get(tile) ?? 0;
    if (left === 0) return false;
    available.set(tile, left - 1);
  }
  return true;
}

function snapshotScene(set: UntrustedServedSet): AttemptSceneSnapshot | null {
  const listenAndRepeat = set.kind === "speaking" ? set.listenAndRepeat : undefined;
  if (!listenAndRepeat?.image || !Array.isArray(listenAndRepeat.items)) return null;

  const focusRegionsByItemId = Object.fromEntries(
    listenAndRepeat.items.map((item) => [
      item.id,
      item.focusRegion ? Object.freeze({ ...item.focusRegion }) : undefined,
    ]),
  );
  return Object.freeze({
    file: listenAndRepeat.image.file,
    focusRegionsByItemId: Object.freeze(focusRegionsByItemId),
  });
}

function snapshotSentenceItems(set: UntrustedServedSet): Readonly<Record<string, SentenceItemSnapshot>> {
  const items = set.kind === "writing" ? set.buildASentence?.items : undefined;
  if (!Array.isArray(items)) return Object.freeze({});

  const byId: Record<string, SentenceItemSnapshot> = {};
  for (const item of items) {
    if (typeof item?.id !== "string") continue;
    // A frame is optional on the schema, so "no frame" is an ordinary case, not a defect; anything
    // that is not a non-empty string is treated the same way, which is also what sentenceAnswerText
    // does with a frame it cannot parse. The served tile order is a fresh shuffle per request and
    // carries no meaning; only the multiset of tiles is used.
    const tiles = Array.isArray(item.tiles) ? item.tiles.filter((tile): tile is string => typeof tile === "string") : [];
    const frame = typeof item.frame === "string" && item.frame !== "" ? item.frame : undefined;
    const prompt = typeof item.prompt === "string" && item.prompt !== "" ? item.prompt : undefined;
    byId[item.id] = Object.freeze({ tiles, ...(frame === undefined ? {} : { frame }), ...(prompt === undefined ? {} : { prompt }) });
  }
  return Object.freeze(byId);
}

type LooseOption = { id?: unknown; text?: unknown };
type LooseQuestion = { id?: unknown; stem?: unknown; options?: unknown };

function readOptions(options: unknown): { id: string; text: string }[] {
  if (!Array.isArray(options)) return [];
  return (options as LooseOption[]).flatMap((o) =>
    typeof o?.id === "string" && typeof o.text === "string" ? [Object.freeze({ id: o.id, text: o.text })] : [],
  );
}

function text(value: unknown): string | null {
  return typeof value === "string" && value.trim() !== "" ? value : null;
}

/**
 * Walks a Reading or Listening Set's three Modules in test order. Every array is re-checked at
 * runtime, because a retired Set may not parse; anything malformed is skipped rather than thrown.
 */
function snapshotStimuli(set: UntrustedServedSet): {
  stimuli: readonly StimulusSnapshot[];
  questionsByItemId: Readonly<Record<string, QuestionSnapshot>>;
} {
  const stimuli: StimulusSnapshot[] = [];
  const questions: Record<string, QuestionSnapshot> = {};
  const add = (module: SnapshotModule, taskType: string, id: unknown, name: string | null, items: QuestionSnapshot[], itemIds: string[]) => {
    if (typeof id !== "string" || itemIds.length === 0) return;
    stimuli.push(Object.freeze({ id, module, taskType, name, itemIds: Object.freeze(itemIds) }));
    itemIds.forEach((itemId, i) => (questions[itemId] = Object.freeze(items[i])));
  };
  const mcqs = (stimulusId: unknown, list: unknown) => {
    const ids: string[] = [];
    const items: QuestionSnapshot[] = [];
    if (typeof stimulusId !== "string" || !Array.isArray(list)) return { ids, items };
    for (const q of list as LooseQuestion[]) {
      if (typeof q?.id !== "string") continue;
      ids.push(q.id);
      items.push({ stimulusId, stem: text(q.stem), options: Object.freeze(readOptions(q.options)), prefix: null });
    }
    return { ids, items };
  };
  const each = <T,>(list: unknown, fn: (entry: T) => void) => {
    if (Array.isArray(list)) for (const entry of list as T[]) if (typeof entry === "object" && entry !== null) fn(entry);
  };

  const modules: [SnapshotModule, string][] = [["router", "router"], ["lower", "lowerModule"], ["upper", "upperModule"]];
  if (set.kind === "reading") {
    for (const [module, key] of modules) {
      const m = set[key as "router"];
      if (!m) continue;
      each<{ id?: unknown; topic?: unknown; gaps?: unknown }>(m.ctwPassages, (p) => {
        const ids: string[] = [];
        const items: QuestionSnapshot[] = [];
        each<{ id?: unknown; prefix?: unknown }>(p.gaps, (g) => {
          if (typeof g.id !== "string" || typeof p.id !== "string") return;
          ids.push(g.id);
          items.push({ stimulusId: p.id, stem: null, options: [], prefix: text(g.prefix) });
        });
        add(module, "complete_words", p.id, text(p.topic), items, ids);
      });
      each<{ id?: unknown; genre?: unknown; questions?: unknown }>(m.dailyLife, (t) => {
        const { ids, items } = mcqs(t.id, t.questions);
        add(module, "daily_life", t.id, text(t.genre), items, ids);
      });
      each<{ id?: unknown; title?: unknown; questions?: unknown }>(m.academic, (p) => {
        const { ids, items } = mcqs(p.id, p.questions);
        add(module, "academic_passage", p.id, text(p.title), items, ids);
      });
    }
  } else if (set.kind === "listening") {
    for (const [module, key] of modules) {
      const m = set[key as "router"];
      if (!m) continue;
      // A Listen and Choose a Response Item is its own Stimulus: no stem, four options.
      each<{ id?: unknown; options?: unknown }>(m.listenChoose, (item) => {
        if (typeof item.id !== "string") return;
        add(module, "listen_choose", item.id, null, [{ stimulusId: item.id, stem: null, options: Object.freeze(readOptions(item.options)), prefix: null }], [item.id]);
      });
      each<{ id?: unknown; setting?: unknown; questions?: unknown }>(m.conversations, (c) => {
        const { ids, items } = mcqs(c.id, c.questions);
        add(module, "conversation", c.id, text(c.setting), items, ids);
      });
      each<{ id?: unknown; setting?: unknown; questions?: unknown }>(m.announcements, (a) => {
        const { ids, items } = mcqs(a.id, a.questions);
        add(module, "announcement", a.id, text(a.setting), items, ids);
      });
      each<{ id?: unknown; discipline?: unknown; questions?: unknown }>(m.academicTalks, (t) => {
        const { ids, items } = mcqs(t.id, t.questions);
        add(module, "academic_talk", t.id, text(t.discipline), items, ids);
      });
    }
  }
  return { stimuli: Object.freeze(stimuli), questionsByItemId: Object.freeze(questions) };
}

/** The Email and the Academic Discussion task, each as the lines that set it. */
function snapshotEssayTasks(set: UntrustedServedSet): Readonly<Record<string, EssayTaskSnapshot>> {
  if (set.kind !== "writing") return Object.freeze({});
  const byId: Record<string, EssayTaskSnapshot> = {};
  const email = set.email;
  if (email && typeof email.id === "string") {
    const bullets = Array.isArray(email.bullets) ? email.bullets.filter((b): b is string => typeof b === "string") : [];
    byId[email.id] = Object.freeze({
      lines: Object.freeze([
        text(email.scenario),
        text(email.to) && `To: ${email.to}`,
        text(email.subject) && `Subject: ${email.subject}`,
        ...bullets.map((b) => `• ${b}`),
      ].filter((l): l is string => typeof l === "string")),
    });
  }
  const discussion = set.academicDiscussion;
  if (discussion && typeof discussion.id === "string") {
    const posts = Array.isArray(discussion.studentPosts) ? discussion.studentPosts : [];
    byId[discussion.id] = Object.freeze({
      lines: Object.freeze([
        text(discussion.courseTitle),
        text(discussion.professorPost) && `${text(discussion.professorName) ?? "Professor"}: ${discussion.professorPost}`,
        ...posts.map((p) => (typeof p?.name === "string" && typeof p.post === "string" ? `${p.name}: ${p.post}` : null)),
      ].filter((l): l is string => typeof l === "string")),
    });
  }
  return Object.freeze(byId);
}
