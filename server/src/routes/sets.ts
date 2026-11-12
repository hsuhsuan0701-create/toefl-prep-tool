import { Hono } from "hono";
import {
  stripAnswers,
  type SetListEntryVM,
  type SetLoadFailureVM,
  type UnloadableSetsVM,
} from "@toefl-prep/shared";
import { config } from "../lib/config.js";
// Aliased: `listSets` below takes a parameter of the same name.
import { supersededSetIds as currentSupersededSetIds } from "../services/supersession.js";
// The bank's layout, parse policy and Set reader live in the store; this file lists and serves and
// knows no path.
import { createSetStore, safeSetErrorDescriptor } from "../services/setStore.js";
import { setTitleFor } from "../services/setTitle.js";
import { scrambleBuildASentenceTiles } from "../services/tileScramble.js";

/**
 * One Set file on disk that did not survive `AnySetSchema`, in the shape `GET /api/sets/unloadable`
 * serves and `UnloadableSetsNotice.tsx` renders. Content-free by construction: `error` is
 * `safeSetErrorDescriptor`'s output (setStore.ts) and `kind`/`file` are a directory and a filename,
 * so it is safe to hand to the client. The store's coarse `category` is dropped here.
 */
export type SetLoadFailure = SetLoadFailureVM;

/**
 * Every Set file on disk that the practice bank cannot show, and why. Costs one full pass over the
 * bank (the same pass `listSets` makes), so call it per request or per boot, not per Set.
 */
export function listSetLoadFailures(dataDir: string): SetLoadFailure[] {
  return createSetStore(dataDir).scanBank().failures.map(({ kind, file, error }) => ({ kind, file, error }));
}

/**
 * The startup diagnostic for unloadable Sets. A Set that stops parsing does not error: it vanishes
 * from the picker while its file looks fine, so a schema narrowing reads as silent data loss. This
 * reports each one at boot, at `console.error`, naming the file and the failing field.
 *
 * Never throws: it runs in a 'listening' listener alongside other work, and a throwing listener
 * stops the ones after it.
 */
export function reportSetLoadFailures(dataDir: string): SetLoadFailure[] {
  try {
    const store = createSetStore(dataDir);
    const failures = store.scanBank().failures;
    if (failures.length === 0) return [];
    console.error(
      `[server] ${failures.length} Set file(s) under ${store.bankDir} failed validation and are absent from the practice bank:`,
    );
    for (const failure of failures) console.error(`[server]   ${failure.kind}/${failure.file}: ${failure.error}`);
    return failures.map(({ kind, file, error }) => ({ kind, file, error }));
  } catch (err) {
    console.error("[server] set load scan failed:", safeSetErrorDescriptor(err));
    return [];
  }
}

/**
 * Every loadable Set, newest first, with its title and any advisory notes, minus the retired Sets in
 * `supersededSetIds` (data/question-sets/supersessions.json, ADR 0011). A retired Set leaves the
 * listing and the picker, but the store's `readSet` still loads it, so a past Attempt against it
 * still reviews. The retired ids are a parameter so the function stays pure; its callers (the route
 * below and routes/fullTests.ts) pass the production reader's.
 */
export function listSets(
  dataDir: string,
  supersededSetIds: ReadonlySet<string> = new Set<string>(),
): Omit<SetListEntryVM, "attempted">[] {
  // Skip, don't throw: one malformed file must not blank the bank. The skipped files are also served
  // by GET /api/sets/unloadable.
  const scan = createSetStore(dataDir).scanBank();
  for (const failure of scan.failures) {
    console.warn(`Skipping invalid set file ${failure.kind}/${failure.file}: ${failure.error}`);
  }
  return scan.sets
    .map((banked) => banked.set)
    .filter((set) => !supersededSetIds.has(set.id))
    .sort((a, b) => b.createdAt.localeCompare(a.createdAt))
    .map((set) => ({
      id: set.id,
      kind: set.kind,
      source: set.source,
      createdAt: set.createdAt,
      ...setTitleFor(set),
      // In the listing so the picker can badge a Set with notes without fetching every Set. Absent,
      // not empty, when a Set has none: an empty array would read as "checked and clean" for Sets
      // that were never checked.
      ...(set.advisoryNotes && set.advisoryNotes.length > 0 ? { advisoryNotes: set.advisoryNotes } : {}),
    }));
}

/**
 * What the Set routes read besides the bank on disk. `attemptedSetIds` is the Attempt store's
 * `listSetIdsCountedAsAttempted`; the listing stamps each entry with it so no client has to infer
 * "attempted" from a page of the Attempt log. `supersededSetIds` and `dataDir` default to the
 * production sources and exist for tests.
 */
export type SetsRouteDeps = {
  attemptedSetIds: () => ReadonlySet<string>;
  supersededSetIds?: () => ReadonlySet<string>;
  dataDir?: string;
};

export function buildSetsRoutes(deps: SetsRouteDeps) {
  const dataDir = deps.dataDir ?? config.dataDir;
  const superseded = deps.supersededSetIds ?? currentSupersededSetIds;
  const store = createSetStore(dataDir);
  return new Hono()
    .get("/", (c) => {
      const kind = c.req.query("kind");
      const attempted = deps.attemptedSetIds();
      const entries = listSets(dataDir, superseded())
        .filter((set) => !kind || set.kind === kind)
        .map((set) => ({ ...set, attempted: attempted.has(set.id) }) satisfies SetListEntryVM);
      return c.json(entries);
    })
    // The count and reason behind every Set the bank cannot show. Its own route because the listing
    // above is an array. Registered ahead of "/:id", which reserves the id "unloadable": generated
    // ids are `<prefix>-<hex>`, so nothing on disk collides. The payload is content-free (see
    // SetLoadFailure), although these Sets never passed `stripAnswers`.
    .get("/unloadable", (c) => {
      const failures = listSetLoadFailures(dataDir);
      return c.json({ count: failures.length, failures } satisfies UnloadableSetsVM);
    })
    // The route a client loads a Set through: answers are stripped and the Build a Sentence tray is
    // re-drawn here (tileScramble.ts). The scramble must run before `stripAnswers`, because its
    // re-draw gate reads the answer keys. `readSet` re-parses the file per request, so this permutes
    // a fresh copy.
    .get("/:id", (c) => {
      const set = store.readSet(c.req.param("id"));
      return set ? c.json(stripAnswers(scrambleBuildASentenceTiles(set))) : c.json({ error: "not found" }, 404);
    });
}

// The Set routes are mounted before the database exists, so the Attempt store reaches them through
// this reader, installed by index.ts once the stores are open. Until then (the test suite's `app`
// opens no database) no Set reads as attempted.
const NO_ATTEMPTED_SETS: ReadonlySet<string> = new Set();
let attemptedSetIdsReader: () => ReadonlySet<string> = () => NO_ATTEMPTED_SETS;

export function setAttemptedSetIdsReader(reader: () => ReadonlySet<string>): void {
  attemptedSetIdsReader = reader;
}

export const setsRoutes = buildSetsRoutes({ attemptedSetIds: () => attemptedSetIdsReader() });
