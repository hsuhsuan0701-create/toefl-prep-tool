import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { framelessWritingSet, placeholderSpeakingSet } from "./helpers/setFixtures.js";
import { formatSupersessionManifest, SupersessionManifestSchema, type Supersession } from "@toefl-prep/shared";
import { openDb } from "../src/db/db.js";
import { createSqliteStores, generationStore } from "../src/db/stores/index.js";
import { createSqliteSupersessionStore } from "../src/db/stores/supersession.js";
import { config } from "../src/lib/config.js";
import { listSets } from "../src/routes/sets.js";
import { registeredBootRecoveryPasses, wireBootRecoveryPasses } from "../src/services/bootRecoveryRegistry.js";
import { createSetStore } from "../src/services/setStore.js";
import { recordSupersessionOnPublication } from "../src/services/supersession.js";
import {
  applySupersessionManifest,
  readSupersessionManifest,
  supersessionManifestPath,
  wireSupersessionManifest,
} from "../src/services/supersessionManifest.js";
import { sqliteStores } from "./helpers/sqliteStores.js";

/**
 * The committed bank, manifest included, as this file's seeded copy holds it, so a Set generated
 * locally and never committed cannot change the result. Nothing in this file writes under it.
 */
const REAL_DATA_DIR = config.dataDir;
const REAL_MANIFEST = supersessionManifestPath(REAL_DATA_DIR);

const scratchDirs: string[] = [];
function scratchDir(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "supersession-manifest-"));
  scratchDirs.push(dir);
  return dir;
}
afterEach(() => {
  for (const dir of scratchDirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
  vi.restoreAllMocks();
});

function fakeServer() {
  const listeners: (() => void)[] = [];
  return {
    server: { on: (_event: "listening", listener: () => void) => { listeners.push(listener); } },
    fireListening: () => { for (const listener of listeners) listener(); },
  };
}

function rows(db: ReturnType<typeof openDb>) {
  return db.prepare("SELECT set_id, superseded_by, superseded_at FROM superseded_sets ORDER BY set_id").all();
}

/** A minimal valid Writing Set file, enough for the boot pass's replacement check to read it. */
function writeWritingSet(dataDir: string, id: string): void {
  const dir = path.join(dataDir, "question-sets/writing");
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, `${id}.json`), JSON.stringify(framelessWritingSet(id)));
}

const pair = (setId: string, supersededBy: string, supersededAt = "2026-08-23 13:21:03"): Supersession =>
  ({ setId, supersededBy, supersededAt });

// Retired Sets whose files are kept out of the public tree (.gitignore): ETS's own sample Sets,
// which may not be redistributed. Their pairs stay in the manifest because on a machine that holds
// the files they retire them; where the files are absent the pair adds an inert row (see
// supersessionManifest.localOnlySets.test.ts).
const LOCAL_ONLY_RETIRED_SETS: ReadonlySet<string> = new Set(["spk-8d9ee619"]);

describe("the tracked supersession manifest", () => {
  it("parses, is in canonical form, and names only Sets that are in the bank", () => {
    const text = fs.readFileSync(REAL_MANIFEST, "utf8");
    const pairs = SupersessionManifestSchema.parse(JSON.parse(text)).supersessions;
    expect(pairs.length).toBeGreaterThanOrEqual(40);
    // Canonical: re-formatting the parsed file reproduces it byte for byte, so every writer's output
    // and a hand edit that kept the order look the same in a diff.
    expect(formatSupersessionManifest(pairs)).toBe(text);
    const bank = createSetStore(REAL_DATA_DIR);
    for (const p of pairs) {
      if (!LOCAL_ONLY_RETIRED_SETS.has(p.setId)) expect(bank.readSet(p.setId), p.setId).toBeDefined();
      expect(bank.readSet(p.supersededBy), p.supersededBy).toBeDefined();
    }
  });

  it("after a boot against an empty database, the listing shows no retired Set and every live replacement", () => {
    const db = openDb(":memory:");
    const store = createSqliteSupersessionStore(db, path.join(scratchDir(), "unused.json"));
    const { server, fireListening } = fakeServer();
    wireSupersessionManifest(server, store, REAL_DATA_DIR);
    fireListening();

    const pairs = readSupersessionManifest(REAL_MANIFEST);
    const retired = new Set(pairs.map((p) => p.setId));
    const listed = new Set(listSets(REAL_DATA_DIR, store.listSupersededSetIds()).map((s) => s.id));
    for (const id of retired) expect(listed.has(id), `${id} is retired`).toBe(false);
    for (const p of pairs) {
      // A replacement that a later pair retires in turn is correctly absent; every other one shows.
      if (retired.has(p.supersededBy)) continue;
      expect(listed.has(p.supersededBy), `${p.supersededBy} replaces ${p.setId}`).toBe(true);
    }
    expect(rows(db)).toHaveLength(pairs.length);
  });
});

describe("applying the manifest at boot", () => {
  function scratchBank(): { dataDir: string; manifest: string } {
    const dataDir = scratchDir();
    for (const id of ["wri-a", "wri-b", "wri-c", "wri-d", "wri-e"]) writeWritingSet(dataDir, id);
    return { dataDir, manifest: supersessionManifestPath(dataDir) };
  }

  it("inserts what is absent and never overwrites or deletes a row the table already has", () => {
    const { dataDir, manifest } = scratchBank();
    fs.writeFileSync(manifest, formatSupersessionManifest([pair("wri-a", "wri-b"), pair("wri-c", "wri-d")]));
    const db = openDb(":memory:");
    const store = createSqliteSupersessionStore(db, path.join(scratchDir(), "unused.json"));
    // Local rows the manifest disagrees with or does not mention.
    db.prepare("INSERT INTO superseded_sets VALUES ('wri-a','wri-e','2026-09-01 00:00:00')").run();
    db.prepare("INSERT INTO superseded_sets VALUES ('wri-d','wri-e','2026-09-01 00:00:00')").run();

    const first = applySupersessionManifest({ manifestPath: manifest, store, setReader: createSetStore(dataDir) });
    expect(first).toEqual({ pairs: 2, inserted: 1, skipped: [] });
    expect(rows(db)).toEqual([
      { set_id: "wri-a", superseded_by: "wri-e", superseded_at: "2026-09-01 00:00:00" },
      { set_id: "wri-c", superseded_by: "wri-d", superseded_at: "2026-08-23 13:21:03" },
      { set_id: "wri-d", superseded_by: "wri-e", superseded_at: "2026-09-01 00:00:00" },
    ]);

    const second = applySupersessionManifest({ manifestPath: manifest, store, setReader: createSetStore(dataDir) });
    expect(second.inserted).toBe(0);
    expect(rows(db)).toHaveLength(3);
  });

  it("keeps a Set listed when its replacement is missing from disk or is another kind", () => {
    const { dataDir, manifest } = scratchBank();
    const speakingDir = path.join(dataDir, "question-sets/speaking");
    fs.mkdirSync(speakingDir, { recursive: true });
    fs.writeFileSync(path.join(speakingDir, "spk-other-kind.json"), JSON.stringify(placeholderSpeakingSet("spk-other-kind")));
    fs.writeFileSync(manifest, formatSupersessionManifest([
      pair("wri-a", "wri-missing"),
      pair("wri-b", "wri-c"),
      pair("wri-d", "spk-other-kind"),
    ]));
    const db = openDb(":memory:");
    const store = createSqliteSupersessionStore(db, path.join(scratchDir(), "unused.json"));
    const setReader = createSetStore(dataDir);
    // The replacement is a readable Set, so only its kind can be what keeps wri-d listed.
    expect(setReader.readSet("spk-other-kind")?.kind).toBe("speaking");
    const result = applySupersessionManifest({ manifestPath: manifest, store, setReader });
    expect(result).toEqual({ pairs: 3, inserted: 1, skipped: ["wri-a", "wri-d"] });
    expect([...store.listSupersededSetIds()]).toEqual(["wri-b"]);
  });

  it("does nothing, and does not throw, when the manifest is absent or malformed", () => {
    const { dataDir, manifest } = scratchBank();
    const db = openDb(":memory:");
    const store = createSqliteSupersessionStore(db, path.join(scratchDir(), "unused.json"));
    const error = vi.spyOn(console, "error").mockImplementation(() => {});

    const absent = fakeServer();
    wireSupersessionManifest(absent.server, store, dataDir);
    expect(() => absent.fireListening()).not.toThrow();

    fs.writeFileSync(manifest, '{"supersessions":[{"setId":"wri-a"}]}');
    const malformed = fakeServer();
    wireSupersessionManifest(malformed.server, store, dataDir);
    expect(() => malformed.fireListening()).not.toThrow();

    expect(rows(db)).toEqual([]);
    expect(error).toHaveBeenCalledTimes(1);
  });

  it("is a registered boot pass that reads the configured data directory", () => {
    const pass = registeredBootRecoveryPasses().find((p) => p.name === "supersession-manifest");
    expect(pass?.phase).toBe("housekeeping");

    const repo = sqliteStores(openDb(":memory:"));
    const { server, fireListening } = fakeServer();
    vi.spyOn(console, "log").mockImplementation(() => {});
    vi.spyOn(console, "warn").mockImplementation(() => {});
    // This pass never reconciles an Attempt; the finalizer is here only because the registry requires one.
    wireBootRecoveryPasses(server, { repo, speakingFinalization: { reconcileAttempt: vi.fn() } });
    fireListening();

    const expected = applySupersessionManifest({
      manifestPath: supersessionManifestPath(config.dataDir),
      store: createSqliteSupersessionStore(openDb(":memory:"), path.join(scratchDir(), "unused.json")),
      setReader: createSetStore(config.dataDir),
    });
    expect(repo.listSupersededSetIds().size).toBe(expected.inserted);
  });
});

describe("retiring a Set at runtime", () => {
  it("writes the table row and the manifest pair together, and re-points both", () => {
    const manifest = path.join(scratchDir(), "question-sets", "supersessions.json");
    const db = openDb(":memory:");
    const store = createSqliteSupersessionStore(db, manifest);

    store.supersedeSet({ setId: "wri-b", supersededBy: "wri-c", at: "2026-09-02 10:00:00" });
    store.supersedeSet({ setId: "wri-a", supersededBy: "wri-c", at: "2026-09-02 10:00:01" });
    expect(readSupersessionManifest(manifest)).toEqual([
      pair("wri-a", "wri-c", "2026-09-02 10:00:01"),
      pair("wri-b", "wri-c", "2026-09-02 10:00:00"),
    ]);
    // Same canonical bytes the tracked file is held to.
    expect(fs.readFileSync(manifest, "utf8")).toBe(formatSupersessionManifest(readSupersessionManifest(manifest)));

    store.supersedeSet({ setId: "wri-a", supersededBy: "wri-d", at: "2026-09-03 00:00:00" });
    expect(readSupersessionManifest(manifest)[0]).toEqual(pair("wri-a", "wri-d", "2026-09-03 00:00:00"));
    expect(rows(db)[0]).toEqual({ set_id: "wri-a", superseded_by: "wri-d", superseded_at: "2026-09-03 00:00:00" });
    // No temp file is left beside the manifest.
    expect(fs.readdirSync(path.dirname(manifest))).toEqual(["supersessions.json"]);
  });

  it("stamps the table and the manifest with the same instant when the caller gives none", () => {
    const manifest = path.join(scratchDir(), "supersessions.json");
    const db = openDb(":memory:");
    createSqliteSupersessionStore(db, manifest).supersedeSet({ setId: "wri-a", supersededBy: "wri-b" });
    const [written] = readSupersessionManifest(manifest);
    expect(rows(db)).toEqual([{ set_id: "wri-a", superseded_by: "wri-b", superseded_at: written!.supersededAt }]);
  });

  it("records nothing in the table when the manifest cannot be written", () => {
    const dir = scratchDir();
    // A directory where the manifest file should be: the rename onto it fails.
    const manifest = path.join(dir, "supersessions.json");
    fs.mkdirSync(manifest);
    const db = openDb(":memory:");
    const store = createSqliteSupersessionStore(db, manifest);
    expect(() => store.supersedeSet({ setId: "wri-a", supersededBy: "wri-b" })).toThrow();
    expect(rows(db)).toEqual([]);
    expect(fs.readdirSync(dir)).toEqual(["supersessions.json"]);
  });

  it("leaves a malformed manifest alone rather than overwriting what it cannot read", () => {
    const manifest = path.join(scratchDir(), "supersessions.json");
    fs.writeFileSync(manifest, "{ not json");
    const db = openDb(":memory:");
    expect(() => createSqliteSupersessionStore(db, manifest).supersedeSet({ setId: "wri-a", supersededBy: "wri-b" })).toThrow();
    expect(fs.readFileSync(manifest, "utf8")).toBe("{ not json");
    expect(rows(db)).toEqual([]);
  });

  it("un-retiring removes the pair from both", () => {
    const manifest = path.join(scratchDir(), "supersessions.json");
    const db = openDb(":memory:");
    const store = createSqliteSupersessionStore(db, manifest);
    store.supersedeSet({ setId: "wri-a", supersededBy: "wri-b" });
    store.supersedeSet({ setId: "wri-c", supersededBy: "wri-d" });

    expect(store.unsupersedeSet("wri-a")).toBe(true);
    expect(readSupersessionManifest(manifest).map((p) => p.setId)).toEqual(["wri-c"]);
    expect([...store.listSupersededSetIds()]).toEqual(["wri-c"]);
    expect(store.unsupersedeSet("wri-a")).toBe(false);

    // A pair only the manifest holds is still removed from it, or the next boot would restore it.
    fs.writeFileSync(manifest, formatSupersessionManifest([pair("wri-c", "wri-d"), pair("wri-x", "wri-y")]));
    expect(store.unsupersedeSet("wri-x")).toBe(true);
    expect(readSupersessionManifest(manifest).map((p) => p.setId)).toEqual(["wri-c"]);
  });

  it("the generation store production composes writes the manifest under its data directory", () => {
    const dataDir = scratchDir();
    const db = openDb(":memory:");
    recordSupersessionOnPublication(generationStore(createSqliteStores(db, { dataDir })), {
      jobId: "job-1",
      publishedSetId: "wri-new",
      supersedesSetId: "wri-old",
    });
    expect(readSupersessionManifest(supersessionManifestPath(dataDir)).map((p) => [p.setId, p.supersededBy]))
      .toEqual([["wri-old", "wri-new"]]);
    expect(rows(db)).toEqual([expect.objectContaining({ set_id: "wri-old", superseded_by: "wri-new" })]);
  });
});
