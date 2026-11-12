import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { AnySetSchema, type AnySet } from "@toefl-prep/shared";
import { config } from "../lib/config.js";
import { setTitleFor, type SetTitle } from "./setTitle.js";

// =================================================================================================
// The Set bank's one adapter. Everything about how banked Sets sit on disk lives here:
//
//   * the layout: `question-sets/<kind>/<setId>.json`, staged through `question-sets/.staging/`;
//   * the publication protocol: write the staging JSON, let the caller commit, atomically rename;
//   * one defensive parse policy: a Set file that is not JSON, or fails `AnySetSchema`, is skipped
//     rather than thrown, and always reported (`GET /api/sets/unloadable`, the boot log, the
//     Catalog's warning) rather than dropped.
//
// PROVIDER-FREE BY CONSTRUCTION: do not add a member that can reach a paid provider. This module
// imports only `node:*`, `shared`, `../lib/config.js` and `./setTitle.js` (a pure function of a
// Set, itself importing only `shared`); setStore.test.ts walks its real import
// graph and fails on any specifier matching reasoning/, tts, openai, gemini, judges, sceneImage,
// generator or generation. The novelty Catalog reads Sets only through a SetStore, so the novelty
// audit is provider-free because this store is. Cleanup of a Set's other artifacts (its audio
// directory, its scene image) therefore lives in setArtifacts.ts, which may reach sceneImage.ts;
// this store owns only the bank's own JSON.
// =================================================================================================

/**
 * The four `question-sets/` subdirectories, in the order every full pass over the bank walks them.
 * A checkout may be missing any of them, so every pass tolerates an absent directory.
 */
export const SET_BANK_KINDS = ["speaking", "writing", "reading", "listening"] as const;
export type SetBankKind = (typeof SET_BANK_KINDS)[number];

export function isSetBankKind(kind: string): kind is SetBankKind {
  return (SET_BANK_KINDS as readonly string[]).includes(kind);
}

const SET_ID_RE = /^[A-Za-z0-9_-]+$/;

// A parse failure's `.message` quotes the file's own content (JSON.parse quotes a fragment of what
// it choked on; a zod message names offending values), and here that content is scenario text,
// interview questions and target sentences, so it never reaches a log or an API response. A failure
// is described by the error's name plus an enum-shaped `code` (ENOENT, EACCES) or, for a schema
// failure, up to this many issues built from zod's schema-side fields only: `path` (the schema's key
// names and array indices), `code`, `expected` and `origin`. That says which field broke, which tells
// a schema narrowing from a corrupt file. `message`, `keys`, `input` and `received` derive from the
// data and stay out.
const MAX_REPORTED_ZOD_ISSUES = 3;

type AllowlistedZodIssue = { code?: unknown; path?: unknown; expected?: unknown; origin?: unknown };

// Named `segments` so it does not shadow the `path` import.
function zodIssuePath(segments: unknown): string {
  if (!Array.isArray(segments) || segments.length === 0) return "(root)";
  return segments.reduce<string>((acc, segment) => {
    if (typeof segment === "number") return `${acc}[${segment}]`;
    const key = String(segment).slice(0, 60);
    return acc === "" ? key : `${acc}.${key}`;
  }, "");
}

function zodIssueDescriptor(issue: AllowlistedZodIssue): string {
  const code = typeof issue.code === "string" ? issue.code.slice(0, 40) : "invalid";
  // Schema-side, never data-side: `expected` is the type or literal the schema demanded and
  // `origin` the type it demanded it of; both come from the shared schemas, not the Set file.
  const expected = typeof issue.expected === "string" ? issue.expected : undefined;
  const origin = typeof issue.origin === "string" ? issue.origin : undefined;
  const qualifier = expected ?? origin;
  return `${zodIssuePath(issue.path)}: ${code}${qualifier ? ` (${qualifier.slice(0, 60)})` : ""}`;
}

// Duck-typed rather than `instanceof z.ZodError`: `shared` and `server` each declare their own zod
// dependency, and if an install stopped hoisting them to one copy an `instanceof` check would
// silently always be false.
function zodIssues(err: unknown): AllowlistedZodIssue[] | undefined {
  const issues = (err as { issues?: unknown }).issues;
  return Array.isArray(issues) ? (issues as AllowlistedZodIssue[]) : undefined;
}

/**
 * The bounded, content-free description of why a Set file was skipped (see the allowlist note
 * above). Never carries the file's own text, so it is safe in a log line and an API response.
 */
export function safeSetErrorDescriptor(err: unknown): string {
  if (!(err instanceof Error)) return "unknown";
  const issues = zodIssues(err);
  if (issues !== undefined) {
    const shown = issues.slice(0, MAX_REPORTED_ZOD_ISSUES).map(zodIssueDescriptor).join("; ");
    const omitted = issues.length - Math.min(issues.length, MAX_REPORTED_ZOD_ISSUES);
    return `${err.name}: ${issues.length} issue(s) — ${shown}${omitted > 0 ? `; +${omitted} more` : ""}`;
  }
  const code = (err as { code?: unknown }).code;
  if (typeof code === "string" || typeof code === "number") return `${err.name} (${String(code).slice(0, 40)})`;
  return err.name;
}

/**
 * Which half of the parse policy a file failed: a coarser projection of `error`. Anything carrying
 * zod issues is a schema failure; everything else (not JSON, unreadable, permission denied) is
 * grouped with the JSON failures. The Catalog's warning reports this.
 */
export type SetParseCategory = "invalid-json" | "schema-validation";

/**
 * One Set file on disk that did not survive `AnySetSchema`. Content-free by construction: `error` is
 * `safeSetErrorDescriptor`'s output, `category` is an enum, and `kind`/`file` are a directory and a
 * filename, so it is safe to hand to the client as well as to the log.
 */
export type SetParseFailure = {
  /** The `question-sets/` subdirectory the file sits in: speaking | writing | reading | listening. */
  kind: SetBankKind;
  /** The file's own name, e.g. "spk-7ed36c39.json" — with `kind`, enough to go open it. */
  file: string;
  /** Bounded descriptor naming the failing field and rule. Never carries the file's own text. */
  error: string;
  /** Coarse projection of `error`, for callers that report a category rather than a field. */
  category: SetParseCategory;
};

/** One Set file that DID survive the parse, tagged with the directory it was read from. */
export type BankedSet = {
  /** The `question-sets/` subdirectory it was read from — NOT necessarily `set.kind`. */
  kind: SetBankKind;
  file: string;
  set: AnySet;
};

/**
 * One scanned file, in bank order: kind order (see SET_BANK_KINDS) then filename, ascending. A
 * discriminated union rather than two parallel arrays, so a caller that reports failures inline with
 * the Sets it accepted (the Catalog builder) keeps bank order.
 */
export type ScannedSetFile =
  | ({ ok: true } & BankedSet)
  | ({ ok: false } & SetParseFailure);

export type SetBankScan = {
  /** Every file the scan looked at, in bank order, kept or skipped. */
  files: ScannedSetFile[];
  /** Just the ones that parsed. */
  sets: BankedSet[];
  /** Just the ones that did not. */
  failures: SetParseFailure[];
};

export type PublicationIntentPaths = {
  setId: string;
  kind: SetBankKind;
  stagingPath: string;
  canonicalPath: string;
  contentHash: string;
};

/**
 * The durable go/no-go a caller may interpose between the staging write and the atomic rename.
 * Returning false means "do not publish": the staging JSON is removed and `publish` reports
 * `false`. What that means to the CALLER (generation treats it as user cancellation) is the
 * caller's business — the store has no opinion and throws nothing of its own.
 */
export type PublicationCommit = (intent: PublicationIntentPaths) => boolean | Promise<boolean>;

export type PublishSetInput = {
  kind: SetBankKind;
  setId: string;
  set: AnySet;
  commit?: PublicationCommit;
};

/**
 * The Set bank, as the members its consumers use. `createSetStore` satisfies it, and a plain object
 * literal satisfies whichever subset a test needs.
 *
 * No member here can reach a paid provider, and none may be added that can (see the module header).
 */
export type SetStore = {
  /** `<dataDir>/question-sets`, for callers that only need to NAME the bank (a log line). */
  readonly bankDir: string;
  /**
   * The canonical Set reader. Re-reads and re-parses the file on EVERY call — deliberately
   * uncached, because `GET /api/sets/:id` scrambles the Build a Sentence tray on the copy it gets
   * (tileScramble.ts) and must be permuting a per-request copy, never a shared one.
   *
   * `undefined` for an unknown id, a traversal-shaped id, or a file that fails the parse policy —
   * a Set superseded or hidden from the listing still reads, so AttemptReview can render a past
   * Attempt against a retired Set.
   */
  readSet(id: string): AnySet | undefined;
  /**
   * The Set's title and summary (setTitle.ts), for a caller that needs nothing else of it: the
   * Attempt log titles every row. Cached per Set id against the file's size, mtime and inode, so an
   * unchanged file is neither re-read nor re-parsed, which is sound because a published Set is never
   * edited (ADR 0011). A file that changes is read again; one that is gone, or fails the parse
   * policy, yields `undefined`, as `readSet` does.
   */
  readSetTitle(id: string): SetTitle | undefined;
  /** One full pass over the bank under the one parse policy. Costs a read of every Set file. */
  scanBank(): SetBankScan;
  /**
   * A cheap change token over the bank's files (name, size, mtime). Changes whenever a Set is
   * published, edited or removed; does NOT change when a Set is superseded, which touches no Set
   * file (only the supersession manifest beside them).
   */
  fingerprint(): string;
  /**
   * Staging write, optional durable commit, atomic rename. `true` once the canonical JSON exists;
   * `false` when `commit` refused, in which case the staging JSON has been removed again.
   */
  publish(input: PublishSetInput): Promise<boolean>;
  /** Where `publish` stages `setId` before the rename — the bank's one cleanup target. */
  stagingSetPath(setId: string): string;
  /** Removes a staged, never-published JSON. Best effort; a non-regular-file collision is kept. */
  cleanupStagedSet(setId: string): boolean;
  /** Whether a VALID published Set JSON of exactly this kind and id exists — the publication guard. */
  hasPublishedSet(kind: SetBankKind, setId: string): boolean;
};

/**
 * The one member a consumer that only reads Sets needs, so no service re-declares the reader's
 * signature as its own injectable. Satisfied by `SetStore`, and by `{ readSet: () => undefined }` in
 * a test.
 */
export type SetReader = Pick<SetStore, "readSet">;

/**
 * What `createSetStore` reads Set files through. `readFile` is the one read every parse makes;
 * production reads the file as UTF-8, and a test counts the calls to prove a cache holds.
 */
export type SetStoreOptions = {
  readFile?: (file: string) => string;
};

function readUtf8(file: string): string {
  return fs.readFileSync(file, "utf8");
}

function parseSetFile(
  file: string,
  readFile: (file: string) => string,
): { ok: true; set: AnySet } | { ok: false; error: string; category: SetParseCategory } {
  try {
    return { ok: true, set: AnySetSchema.parse(JSON.parse(readFile(file))) };
  } catch (err) {
    return {
      ok: false,
      error: safeSetErrorDescriptor(err),
      category: zodIssues(err) === undefined ? "invalid-json" : "schema-validation",
    };
  }
}

/** A cached title, valid while the file it was read from still has this size, mtime and inode. */
type CachedSetTitle = { file: string; size: number; mtimeMs: number; ino: number; title: SetTitle | undefined };

export function createSetStore(dataDir: string = config.dataDir, options: SetStoreOptions = {}): SetStore {
  const readFile = options.readFile ?? readUtf8;
  const bankDir = path.join(dataDir, "question-sets");
  const kindDir = (kind: SetBankKind): string => path.join(bankDir, kind);
  const stagingDir = (): string => path.join(bankDir, ".staging");
  const stagingSetPath = (setId: string): string => path.join(stagingDir(), `${setId}.json`);
  const publishedSetPath = (kind: SetBankKind, setId: string): string => path.join(kindDir(kind), `${setId}.json`);

  // Cleanup runs while handling another failure (or recovering one at boot), so it must never
  // replace that failure or stop state recovery — each removal gets its own error boundary.
  const removeStagedRegularFile = (file: string): boolean => {
    try {
      // The staging writer owns exactly a regular temp file. A directory, symlink, FIFO, or other
      // entry at the same name is an unrelated collision; preserve it rather than broadening
      // cleanup into recursive deletion of a target whose ownership is unresolved.
      if (!fs.lstatSync(file).isFile()) return false;
      fs.rmSync(file, { force: true });
      return true;
    } catch {
      return false;
    }
  };

  // The published file a Set id names: the first kind directory holding `<id>.json`, or undefined
  // for an unknown or traversal-shaped id.
  const locatePublishedSet = (id: string): { kind: SetBankKind; file: string } | undefined => {
    // Validate id format to prevent path traversal: only alphanumeric, dash, and underscore.
    if (!SET_ID_RE.test(id)) return undefined;
    for (const kind of SET_BANK_KINDS) {
      const file = publishedSetPath(kind, id);
      // Boundary check: the file must sit inside the kind directory. A missing directory needs no
      // guard: `file` then simply does not exist.
      const dir = kindDir(kind);
      if (!file.startsWith(dir + path.sep) && file !== dir) continue;
      if (fs.existsSync(file)) return { kind, file };
    }
    return undefined;
  };

  const parseLocated = ({ kind, file }: { kind: SetBankKind; file: string }, id: string): AnySet | undefined => {
    const parsed = parseSetFile(file, readFile);
    if (parsed.ok) return parsed.set;
    console.warn(`Failed to parse set file ${id} in ${kind}: ${parsed.error}`);
    return undefined;
  };

  // Per store instance, so the production store keeps it for the life of the process and a store
  // built over a scratch bank starts empty.
  const titleCache = new Map<string, CachedSetTitle>();

  return {
    bankDir,
    stagingSetPath,

    readSet(id) {
      const located = locatePublishedSet(id);
      return located ? parseLocated(located, id) : undefined;
    },

    readSetTitle(id) {
      const located = locatePublishedSet(id);
      let stat: fs.Stats | undefined;
      try {
        stat = located ? fs.statSync(located.file) : undefined;
      } catch {
        stat = undefined;
      }
      if (!located || !stat) {
        titleCache.delete(id);
        return undefined;
      }
      const cached = titleCache.get(id);
      if (cached && cached.file === located.file && cached.size === stat.size && cached.mtimeMs === stat.mtimeMs && cached.ino === stat.ino) {
        return cached.title;
      }
      // Stat before read: a file replaced between the two is cached under its old stat, so the next
      // lookup sees the new stat and reads it again. The other order could pin an old title to a new
      // stat for good.
      const set = parseLocated(located, id);
      let title: SetTitle | undefined;
      try {
        title = set ? setTitleFor(set) : undefined;
      } catch {
        title = undefined;
      }
      titleCache.set(id, { file: located.file, size: stat.size, mtimeMs: stat.mtimeMs, ino: stat.ino, title });
      return title;
    },

    scanBank() {
      const files: ScannedSetFile[] = [];
      const sets: BankedSet[] = [];
      const failures: SetParseFailure[] = [];
      for (const kind of SET_BANK_KINDS) {
        const dir = kindDir(kind);
        if (!fs.existsSync(dir)) continue;
        // Sorted, so one full pass over the bank is reproducible rather than dependent on whatever
        // order the filesystem hands back.
        for (const file of fs.readdirSync(dir).sort()) {
          if (!file.endsWith(".json")) continue;
          const parsed = parseSetFile(path.join(dir, file), readFile);
          if (parsed.ok) {
            const banked: BankedSet = { kind, file, set: parsed.set };
            sets.push(banked);
            files.push({ ok: true, ...banked });
          } else {
            const failure: SetParseFailure = { kind, file, error: parsed.error, category: parsed.category };
            failures.push(failure);
            files.push({ ok: false, ...failure });
          }
        }
      }
      return { files, sets, failures };
    },

    fingerprint() {
      const parts: string[] = [];
      for (const kind of SET_BANK_KINDS) {
        const directory = kindDir(kind);
        let names: string[];
        try {
          names = fs.readdirSync(directory).sort();
        } catch {
          parts.push(`${kind}:absent`);
          continue;
        }
        for (const name of names) {
          if (!name.endsWith(".json")) continue;
          try {
            const stat = fs.statSync(path.join(directory, name));
            parts.push(`${kind}/${name}:${stat.size}:${stat.mtimeMs}`);
          } catch {
            parts.push(`${kind}/${name}:gone`);
          }
        }
      }
      return parts.join("|");
    },

    async publish({ kind, setId, set, commit }) {
      const dir = kindDir(kind);
      const staging = stagingDir();
      fs.mkdirSync(dir, { recursive: true });
      fs.mkdirSync(staging, { recursive: true });
      const tmp = stagingSetPath(setId);
      const canonical = publishedSetPath(kind, setId);
      // Throws rather than skipping: nothing invalid may enter the bank. The defensive policy above
      // is for files already there.
      const body = JSON.stringify(AnySetSchema.parse(set), null, 2);
      fs.writeFileSync(tmp, body);
      if (commit && !await commit({
        setId,
        kind,
        stagingPath: tmp,
        canonicalPath: canonical,
        contentHash: crypto.createHash("sha256").update(body).digest("hex"),
      })) {
        fs.rmSync(tmp, { force: true });
        return false;
      }
      fs.renameSync(tmp, canonical);
      // Keep the shared staging directory: another process may already rely on it.
      return true;
    },

    cleanupStagedSet(setId) {
      if (!SET_ID_RE.test(setId)) return false;
      return removeStagedRegularFile(stagingSetPath(setId));
    },

    hasPublishedSet(kind, setId) {
      if (!SET_ID_RE.test(setId)) return false;
      const file = publishedSetPath(kind, setId);
      try {
        // lstat is deliberate: a directory, symlink, or other collision at the canonical JSON path
        // is not this attempt's immutable publication and must not shield its orphaned assets.
        if (!fs.lstatSync(file).isFile()) return false;
      } catch {
        return false;
      }
      const parsed = parseSetFile(file, readFile);
      return parsed.ok && parsed.set.kind === kind && parsed.set.id === setId;
    },
  };
}

/**
 * The production store, bound to `config.dataDir`. Call sites that already thread a `dataDir`
 * (tests against a scratch bank, the audit CLI) build their own with `createSetStore`.
 */
export const setStore: SetStore = createSetStore();
