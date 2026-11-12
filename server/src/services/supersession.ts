import { sqliteTimestamp, type SqliteTimestamp } from "../db/timestamps.js";

// ---------------------------------------------------------------------------------------------
// The `superseded_sets` aggregate: which Sets are retired, and by what (ADR 0011)
// ---------------------------------------------------------------------------------------------

/**
 * A Set id that has been through `recordSupersessionOnPublication` below, the one function allowed
 * to retire a Set and the only place this brand is minted. Type-only, like `SqliteTimestamp`.
 *
 * The generation runner's store also exposes the raw `supersedeSet` writer; the brand stops it being
 * called with a plain string, so a retirement cannot be written before the replacement has
 * published. db/stores/supersession.ts declares `supersededBy: string` and still satisfies the port,
 * since a function accepting a wider parameter satisfies one promising a narrower.
 */
declare const publishedSetBrand: unique symbol;
export type PublishedSetId = string & { readonly [publishedSetBrand]: "published" };

/**
 * One recorded retirement: `setId` is the Set being retired, `supersededBy` its replacement, and
 * `at` the moment, in the on-disk timestamp form every `*_at` column uses (db/timestamps.ts).
 */
export type SupersedeSetInput = { setId: string; supersededBy: PublishedSetId; at?: SqliteTimestamp };

/**
 * The supersession port: exactly the two members the generation runner uses.
 * db/stores/supersession.ts implements it, writing `superseded_sets` and
 * data/question-sets/supersessions.json together; tests use a plain object.
 *
 * `unsupersedeSet` is deliberately not here: this port is part of GenerationJobStore, and the
 * generation runner must never un-retire a Set. It lives on the concrete store only.
 */
export type SupersessionStore = {
  supersedeSet(input: SupersedeSetInput): void;
  listSupersededSetIds(): Set<string>;
};

// ---------------------------------------------------------------------------------------------
// Create before supersede
// ---------------------------------------------------------------------------------------------

/**
 * Records that a freshly published Set retires an older one: the only way the running app retires a
 * Set. (The boot pass in supersessionManifest.ts also inserts rows, but only ones the tracked
 * manifest already records.)
 *
 * The replacement publishes first and the retirement is recorded second, because the two crash
 * windows are not symmetric:
 *
 *   - recorded first, then a crash: the replacement's artifacts are cleaned up by boot recovery,
 *     and the retired Set leaves the picker with nothing in its slot, unrecoverably;
 *   - published first, then a crash: the User sees both Sets, which a one-entry manifest edit fixes.
 *
 * The writer accepts only a PublishedSetId, which only this function mints, from the publication's
 * own outcome; so a retirement cannot be written anywhere else.
 *
 * Never throws: the Set is already on disk, and a fault here reaching the job's terminal write would
 * flip a 'done' job to 'failed' and send boot recovery after artifacts that are live. Not
 * transactional with that terminal write; the crash window between them is the harmless one.
 */
export function recordSupersessionOnPublication(
  store: SupersessionStore,
  publication: {
    /** The generation job that just published — used only to name the job in the failure log. */
    jobId: string;
    /** The Set this job published. The replacement — hence "create BEFORE supersede". */
    publishedSetId: string;
    /** The Set being retired, or undefined when this job replaces nothing (the common case). */
    supersedesSetId: string | undefined;
  },
): void {
  if (!publication.supersedesSetId) return;
  try {
    store.supersedeSet({
      setId: publication.supersedesSetId,
      // The one place the brand is minted. It does not prove the bytes are on disk; it records that
      // the caller is generationJobs.ts's `commit`, which runs only after the Set has published and
      // the job has claimed 'done'.
      supersededBy: publication.publishedSetId as PublishedSetId,
      at: sqliteTimestamp(),
    });
  } catch (err) {
    console.error(
      `[supersession] job ${publication.jobId} published ${publication.publishedSetId} but could not record supersession of ${publication.supersedesSetId}:`,
      err instanceof Error ? err.name : "unknown",
    );
  }
}

// ---------------------------------------------------------------------------------------------
// The read side
// ---------------------------------------------------------------------------------------------

/**
 * Which saved Sets have been retired by a newer one, read by everything that must stop showing them:
 * the Set listing (routes/sets.ts), the Sets a Full-Test Run may be started on (routes/fullTests.ts)
 * and the Catalog (generationPlanner.ts).
 *
 * Installed once at the composition root (index.ts) rather than defaulting to a database read here,
 * because a default that opened its own database would give the process a second writer as a side
 * effect of an import. Until then it reports nothing superseded. Consumers take the id set as a
 * parameter and use this only as their production default, so the filtering functions stay pure.
 */
export type SupersededSetIdsReader = () => ReadonlySet<string>;

const EMPTY: ReadonlySet<string> = new Set<string>();

let reader: SupersededSetIdsReader = () => EMPTY;

/** Installs the reader; null restores the empty default. */
export function setSupersededSetIdsReader(next: SupersededSetIdsReader | null): void {
  reader = next ?? (() => EMPTY);
}

/**
 * The retired Set ids. Never throws: a failed read must not fail the Set listing or abort a paid
 * generation run, so it falls back to "nothing is superseded", showing more than intended rather
 * than hiding a Set the User still needs.
 */
export function supersededSetIds(): ReadonlySet<string> {
  try {
    return reader();
  } catch (err) {
    console.warn(
      `[supersession] could not read superseded sets (${err instanceof Error ? err.name : "unknown"}); treating none as superseded`,
    );
    return EMPTY;
  }
}

export function createRepoSupersededSetIdsReader(
  store: Pick<SupersessionStore, "listSupersededSetIds">,
): SupersededSetIdsReader {
  return () => store.listSupersededSetIds();
}
