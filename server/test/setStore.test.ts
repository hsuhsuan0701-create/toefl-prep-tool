import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { AnySet } from "@toefl-prep/shared";
import { createSetStore, type SetReader } from "../src/services/setStore.js";
import { setTitleFor } from "../src/services/setTitle.js";
import { setTitlesById } from "../src/routes/attemptViewModels.js";
import { speakingSetFixture, writingSetFixture } from "./helpers/generationDiversityFixtures.js";

const here = path.dirname(fileURLToPath(import.meta.url));
const scratchDirs: string[] = [];

afterEach(() => {
  for (const directory of scratchDirs.splice(0)) {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

function scratchBank(): string {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "set-store-"));
  scratchDirs.push(dataDir);
  return dataDir;
}

function writeSet(dataDir: string, set: AnySet, file = `${set.id}.json`): void {
  const dir = path.join(dataDir, "question-sets", set.kind);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, file), JSON.stringify(set, null, 2));
}

function writeRaw(dataDir: string, kind: string, file: string, body: string): void {
  const dir = path.join(dataDir, "question-sets", kind);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, file), body);
}

// Text that exists only inside the broken files. A zod message quotes the offending value and
// Node's SyntaxError quotes the fragment it choked on, so neither may reach a descriptor.
const CANARY = "SET_STORE_CANARY_scenario_text_that_must_never_be_disclosed";

// The bank's one defensive parse policy, tested here and nowhere else: a file that is not JSON or
// fails AnySetSchema is skipped and reported (GET /api/sets/unloadable), never thrown or dropped.
// Each failure also carries a coarse `category`, the form the Catalog's warning prints.
describe("SetStore parse policy", () => {
  it("keeps every Set that parses and REPORTS every one that does not, rather than throwing or dropping it", () => {
    const dataDir = scratchBank();
    const healthy = writingSetFixture();
    healthy.id = "wri-healthy";
    writeSet(dataDir, healthy);
    const broken = { ...writingSetFixture(), id: "wri-schemabroken", email: { ...writingSetFixture().email, scenario: CANARY, bullets: "seven minutes" } };
    writeRaw(dataDir, "writing", "wri-schemabroken.json", JSON.stringify(broken));
    writeRaw(dataDir, "writing", "wri-notjson.json", `{ ${CANARY}`);
    // Not a Set file at all: skipped without becoming a failure.
    writeRaw(dataDir, "writing", "notes.txt", "ignore me");

    const scan = createSetStore(dataDir).scanBank();

    expect(scan.sets.map((s) => s.set.id)).toEqual(["wri-healthy"]);
    expect(scan.failures.map((f) => f.file)).toEqual(["wri-notjson.json", "wri-schemabroken.json"]);
    expect(scan.failures.every((f) => f.kind === "writing")).toBe(true);
    // `files` carries both, in one bank-ordered sequence, so a caller that reports failures inline
    // with the Sets it accepted keeps its exact interleaving.
    expect(scan.files.map((f) => [f.file, f.ok])).toEqual([
      ["wri-healthy.json", true],
      ["wri-notjson.json", false],
      ["wri-schemabroken.json", false],
    ]);
  });

  it("names the failing field and rule, and categorises the failure, without quoting the file's own text", () => {
    const dataDir = scratchBank();
    writeRaw(dataDir, "writing", "wri-schemabroken.json", JSON.stringify({
      ...writingSetFixture(),
      id: "wri-schemabroken",
      email: { ...writingSetFixture().email, scenario: CANARY, bullets: "seven minutes" },
    }));
    writeRaw(dataDir, "writing", "wri-notjson.json", `{ ${CANARY}`);

    const failures = createSetStore(dataDir).scanBank().failures;
    const schema = failures.find((f) => f.file === "wri-schemabroken.json")!;
    const syntax = failures.find((f) => f.file === "wri-notjson.json")!;

    // Specific, not generic: the field and the rule, plus what the schema demanded.
    expect(schema.error).toContain("email.bullets");
    expect(schema.error).toContain("invalid_type");
    expect(schema.error).toContain("array");
    expect(schema.category).toBe("schema-validation");
    expect(syntax.error).toContain("SyntaxError");
    // Strictly coarser than `error`, and the exact wording the Catalog's warning prints.
    expect(syntax.category).toBe("invalid-json");

    const disclosed = JSON.stringify(failures);
    expect(disclosed).not.toContain(CANARY);
    expect(disclosed).not.toContain("SET_STORE_CANARY");
    expect(disclosed).not.toContain("seven minutes"); // the offending value, which zod's message quotes
  });

  it("tolerates a bank whose kind directories do not all exist, and reports nothing for an empty one", () => {
    const dataDir = scratchBank();
    const speaking = speakingSetFixture();
    speaking.id = "spk-only";
    writeSet(dataDir, speaking);

    const scan = createSetStore(dataDir).scanBank();
    expect(scan.sets.map((s) => s.set.id)).toEqual(["spk-only"]);
    expect(scan.failures).toEqual([]);
    expect(createSetStore(scratchBank()).scanBank()).toEqual({ files: [], sets: [], failures: [] });
  });

  it("tags each Set with the DIRECTORY it was read from, so a caller can still reject a kind mismatch", () => {
    const dataDir = scratchBank();
    const speaking = speakingSetFixture();
    speaking.id = "spk-misfiled";
    // A Speaking Set filed under question-sets/writing/. It parses (AnySetSchema does not know where
    // the file sits), so the store keeps it and the Catalog's own kind check rejects it.
    writeRaw(dataDir, "writing", "spk-misfiled.json", JSON.stringify(speaking));

    const [banked] = createSetStore(dataDir).scanBank().sets;
    expect(banked!.kind).toBe("writing");
    expect(banked!.set.kind).toBe("speaking");
  });
});

describe("SetStore.readSet", () => {
  it("reads a Set from any kind directory, and re-parses the file on every call", () => {
    const dataDir = scratchBank();
    const writing = writingSetFixture();
    writing.id = "wri-read1";
    writeSet(dataDir, writing);
    const speaking = speakingSetFixture();
    speaking.id = "spk-read1";
    writeSet(dataDir, speaking);
    const store = createSetStore(dataDir);

    expect(store.readSet("wri-read1")?.kind).toBe("writing");
    expect(store.readSet("spk-read1")?.kind).toBe("speaking");
    // Uncached: two reads are equal in value but never the same object, which is what lets
    // GET /api/sets/:id scramble the Build a Sentence tray on a per-request copy (tileScramble.ts).
    expect(store.readSet("wri-read1")).not.toBe(store.readSet("wri-read1"));
    expect(store.readSet("wri-read1")).toEqual(store.readSet("wri-read1"));
  });

  it("returns undefined — never throws — for an unknown id, a traversal-shaped id, and a file that fails the parse policy", () => {
    const dataDir = scratchBank();
    writeRaw(dataDir, "writing", "wri-broken.json", `{ ${CANARY}`);
    const store = createSetStore(dataDir);
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      expect(store.readSet("wri-nosuchset")).toBeUndefined();
      expect(store.readSet("../../etc/passwd")).toBeUndefined();
      expect(store.readSet("wri-broken")).toBeUndefined();
      const logged = warnSpy.mock.calls.flat(2).map((v) => (typeof v === "string" ? v : JSON.stringify(v))).join(" ");
      expect(logged).toContain("wri-broken");
      expect(logged).not.toContain("SET_STORE_CANARY");
    } finally {
      warnSpy.mockRestore();
    }
  });
});

describe("SetStore.readSetTitle", () => {
  // The store with its one file read counted, per path.
  function countingStore(dataDir: string) {
    const reads = new Map<string, number>();
    const store = createSetStore(dataDir, {
      readFile: (file) => {
        reads.set(path.basename(file), (reads.get(path.basename(file)) ?? 0) + 1);
        return fs.readFileSync(file, "utf8");
      },
    });
    return { store, reads };
  }

  function titledWritingSet(id: string, subject: string): AnySet {
    const set = writingSetFixture();
    set.id = id;
    set.email.subject = subject;
    return set;
  }

  it("is the title setTitleFor derives, and an unchanged file is read once however often it is asked for", () => {
    const dataDir = scratchBank();
    const set = titledWritingSet("wri-title1", "Order #4127 - damaged panel");
    writeSet(dataDir, set);
    const { store, reads } = countingStore(dataDir);

    expect(store.readSetTitle("wri-title1")).toEqual(setTitleFor(set));
    expect(store.readSetTitle("wri-title1")?.title).toBe("Order #4127 - damaged panel");
    expect(reads.get("wri-title1.json")).toBe(1);
  });

  it("re-reads a file that changed, and yields undefined once it is gone or fails to parse", () => {
    const dataDir = scratchBank();
    writeSet(dataDir, titledWritingSet("wri-title2", "First subject"));
    const { store, reads } = countingStore(dataDir);
    expect(store.readSetTitle("wri-title2")?.title).toBe("First subject");

    // A different length, and an mtime moved on, so the change is visible to the stat however fast
    // the rewrite lands.
    writeSet(dataDir, titledWritingSet("wri-title2", "A second, longer subject line"));
    const file = path.join(dataDir, "question-sets/writing/wri-title2.json");
    const later = new Date(Date.now() + 60_000);
    fs.utimesSync(file, later, later);
    expect(store.readSetTitle("wri-title2")?.title).toBe("A second, longer subject line");
    expect(reads.get("wri-title2.json")).toBe(2);

    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      fs.writeFileSync(file, `{ ${CANARY}`);
      expect(store.readSetTitle("wri-title2")).toBeUndefined();
    } finally {
      warnSpy.mockRestore();
    }
    fs.rmSync(file);
    expect(store.readSetTitle("wri-title2")).toBeUndefined();
    expect(store.readSetTitle("../../etc/passwd")).toBeUndefined();
  });

  it("titles the Attempt log from the cache: a second listing re-reads no unchanged Set file", () => {
    const dataDir = scratchBank();
    writeSet(dataDir, titledWritingSet("wri-log1", "First Set"));
    writeSet(dataDir, titledWritingSet("wri-log2", "Second Set"));
    const { store, reads } = countingStore(dataDir);
    const page = ["wri-log1", "wri-log2", "wri-log1", "wri-gone"];

    const first = setTitlesById(page, store);
    expect(Object.fromEntries(first)).toEqual({ "wri-log1": "First Set", "wri-log2": "Second Set", "wri-gone": null });
    expect(setTitlesById(page, store)).toEqual(first);
    expect(Object.fromEntries(reads)).toEqual({ "wri-log1.json": 1, "wri-log2.json": 1 });
  });
});

describe("SetStore.fingerprint", () => {
  it("is stable across reads and changes when the bank does", () => {
    const dataDir = scratchBank();
    const store = createSetStore(dataDir);
    const empty = store.fingerprint();
    expect(store.fingerprint()).toBe(empty);

    const writing = writingSetFixture();
    writing.id = "wri-fp1";
    writeSet(dataDir, writing);
    const withOne = store.fingerprint();
    expect(withOne).not.toBe(empty);
    expect(store.fingerprint()).toBe(withOne);

    const second = writingSetFixture();
    second.id = "wri-fp2";
    writeSet(dataDir, second);
    expect(store.fingerprint()).not.toBe(withOne);

    fs.rmSync(path.join(dataDir, "question-sets/writing/wri-fp2.json"));
    expect(store.fingerprint()).toBe(withOne);
  });
});

describe("SetStore.publish (staging + atomic rename)", () => {
  it("stages, commits, renames — and leaves the canonical JSON as the only trace", async () => {
    const dataDir = scratchBank();
    const store = createSetStore(dataDir);
    const set = writingSetFixture();
    set.id = "wri-pub1";
    const seen: { stagingPath: string; canonicalPath: string; contentHash: string }[] = [];

    const published = await store.publish({
      kind: "writing",
      setId: "wri-pub1",
      set,
      commit: (intent) => {
        // The commit runs while the staged bytes are on disk and the canonical path is still empty.
        expect(fs.existsSync(intent.stagingPath)).toBe(true);
        expect(fs.existsSync(intent.canonicalPath)).toBe(false);
        seen.push(intent);
        return true;
      },
    });

    expect(published).toBe(true);
    expect(seen).toHaveLength(1);
    expect(seen[0]!.stagingPath).toBe(store.stagingSetPath("wri-pub1"));
    expect(fs.existsSync(seen[0]!.stagingPath)).toBe(false);
    expect(store.readSet("wri-pub1")?.id).toBe("wri-pub1");
    expect(seen[0]!.contentHash).toMatch(/^[0-9a-f]{64}$/u);
  });

  it("publishes with no commit hook at all (the direct generate/import path)", async () => {
    const dataDir = scratchBank();
    const store = createSetStore(dataDir);
    const set = writingSetFixture();
    set.id = "wri-pub2";
    expect(await store.publish({ kind: "writing", setId: "wri-pub2", set })).toBe(true);
    expect(store.readSet("wri-pub2")?.id).toBe("wri-pub2");
  });

  it("a refused commit publishes nothing and removes the staged JSON, reporting false rather than throwing", async () => {
    const dataDir = scratchBank();
    const store = createSetStore(dataDir);
    const set = writingSetFixture();
    set.id = "wri-refused";

    const published = await store.publish({ kind: "writing", setId: "wri-refused", set, commit: () => false });

    expect(published).toBe(false);
    expect(fs.existsSync(store.stagingSetPath("wri-refused"))).toBe(false);
    expect(store.readSet("wri-refused")).toBeUndefined();
  });

  it("refuses to mint an invalid Set at all — write-side validation throws, unlike the read-side policy", async () => {
    const dataDir = scratchBank();
    const store = createSetStore(dataDir);
    const invalid = { ...writingSetFixture(), id: "wri-invalid", email: undefined } as unknown as AnySet;
    await expect(store.publish({ kind: "writing", setId: "wri-invalid", set: invalid })).rejects.toThrow();
  });
});

describe("SetStore publication guard and staged cleanup", () => {
  it("hasPublishedSet is true only for a valid regular Set JSON of exactly that kind and id", () => {
    const dataDir = scratchBank();
    const store = createSetStore(dataDir);
    const writing = writingSetFixture();
    writing.id = "wri-guard";
    writeSet(dataDir, writing);

    expect(store.hasPublishedSet("writing", "wri-guard")).toBe(true);
    expect(store.hasPublishedSet("speaking", "wri-guard")).toBe(false);
    expect(store.hasPublishedSet("writing", "wri-absent")).toBe(false);
    expect(store.hasPublishedSet("writing", "../../etc/passwd")).toBe(false);

    // A file whose own id disagrees with its filename is not this set's publication.
    writeRaw(dataDir, "writing", "wri-mismatched.json", JSON.stringify({ ...writing, id: "wri-guard" }));
    expect(store.hasPublishedSet("writing", "wri-mismatched")).toBe(false);

    // An unparseable collision at the canonical path never counts as a publication either.
    writeRaw(dataDir, "writing", "wri-corrupt.json", "{ not json");
    expect(store.hasPublishedSet("writing", "wri-corrupt")).toBe(false);

    // Nor does a directory sitting at the canonical JSON path.
    fs.mkdirSync(path.join(dataDir, "question-sets/writing/wri-dir.json"), { recursive: true });
    expect(store.hasPublishedSet("writing", "wri-dir")).toBe(false);
  });

  it("cleanupStagedSet removes a staged regular file and preserves any other entry at that name", () => {
    const dataDir = scratchBank();
    const store = createSetStore(dataDir);
    const staged = store.stagingSetPath("wri-staged");
    fs.mkdirSync(path.dirname(staged), { recursive: true });
    fs.writeFileSync(staged, "{}");

    expect(store.cleanupStagedSet("wri-staged")).toBe(true);
    expect(fs.existsSync(staged)).toBe(false);
    // Idempotent, and never throws for something that is not there.
    expect(store.cleanupStagedSet("wri-staged")).toBe(false);
    expect(store.cleanupStagedSet("../../etc/passwd")).toBe(false);

    const collision = store.stagingSetPath("wri-collision");
    fs.mkdirSync(collision, { recursive: true });
    expect(store.cleanupStagedSet("wri-collision")).toBe(false);
    expect(fs.existsSync(collision)).toBe(true);
  });
});

describe("SetStore as a port", () => {
  it("a plain object literal satisfies the reader port a service depends on", () => {
    // Services that only read Sets (speakingFinalization.ts, transcriptionRecovery.ts) depend on
    // this narrow port, so a test can hand them a plain object.
    const fake: SetReader = { readSet: () => undefined };
    expect(fake.readSet("anything")).toBeUndefined();
    const real: SetReader = createSetStore(scratchBank());
    expect(real.readSet("anything")).toBeUndefined();
  });

  // The Catalog reads Sets through this store, and its isolation from paid providers is proved
  // structurally (noveltyAudit.test.ts walks its real import graph). That proof holds only while the
  // store itself cannot reach a provider, so this pins it at the source: no member of SetStore may
  // be backed by generation, scoring, rendering or transcription.
  it("cannot reach a reasoning runner or any paid provider", () => {
    const forbidden = /(reasoning\/|\btts\b|openai|gemini|judges|sceneImage|generator|generation)/iu;
    const sourceRoot = path.resolve(here, "../src");
    const visited = new Set<string>();
    const queue = [path.join(sourceRoot, "services/setStore.ts")];

    while (queue.length > 0) {
      const file = queue.pop() as string;
      if (visited.has(file)) continue;
      visited.add(file);
      for (const match of fs.readFileSync(file, "utf8").matchAll(/from\s+"([^"]+)"/gu)) {
        const specifier = match[1]!;
        expect(forbidden.test(specifier), `${path.relative(sourceRoot, file)} imports ${specifier}`).toBe(false);
        if (!specifier.startsWith(".")) continue;
        queue.push(path.resolve(path.dirname(file), specifier.replace(/\.js$/u, ".ts")));
      }
    }
  });
});
