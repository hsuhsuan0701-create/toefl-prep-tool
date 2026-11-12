import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { formatSupersessionManifest } from "@toefl-prep/shared";
import { openDb } from "../src/db/db.js";
import { createSqliteSupersessionStore } from "../src/db/stores/supersession.js";
import { listSets } from "../src/routes/sets.js";
import { createSetStore } from "../src/services/setStore.js";
import { applySupersessionManifest, supersessionManifestPath } from "../src/services/supersessionManifest.js";

// A manifest pair may retire a Set whose file a given checkout does not have: ETS's sample Sets are
// kept out of the public tree, so a fresh clone carries their pairs without their files. The boot
// pass skips a pair only for its replacement (missing, or of another kind), never for a missing
// retired Set: the row it adds is inert where the file is absent and works where it is present.

const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

function writingSet(dataDir: string, id: string): void {
  const dir = path.join(dataDir, "question-sets/writing");
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, `${id}.json`), JSON.stringify({
    id, kind: "writing", source: "generated", createdAt: "2026-07-27T00:00:00Z",
    buildASentence: { items: Array.from({ length: 10 }, (_, i) => ({
      id: `bs${i + 1}`, prompt: `P${i + 1}?`, tiles: ["a", "b", "c"], answers: [["a", "b", "c"]] })) },
    email: { id: "em1", scenario: "s", to: "t@u.edu", subject: "x", bullets: ["1", "2", "3"], timeLimitSec: 420, wordGuidance: { min: 80, max: 120 } },
    academicDiscussion: { id: "ad1", courseTitle: "c", professorName: "p", professorPost: "q",
      studentPosts: [{ name: "A", post: "y" }, { name: "B", post: "n" }], timeLimitSec: 600, minWords: 100 },
  }));
}

describe("a manifest pair whose retired Set file is absent", () => {
  it("is applied, not skipped, and leaves the listing showing only the replacement", () => {
    const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "supersession-local-only-"));
    dirs.push(dataDir);
    writingSet(dataDir, "wri-replacement");
    const manifest = supersessionManifestPath(dataDir);
    fs.writeFileSync(manifest, formatSupersessionManifest([
      { setId: "wri-kept-elsewhere", supersededBy: "wri-replacement", supersededAt: "2026-08-23 15:03:27" },
    ]));
    const store = createSqliteSupersessionStore(openDb(":memory:"), path.join(dataDir, "unused.json"));

    const result = applySupersessionManifest({ manifestPath: manifest, store, setReader: createSetStore(dataDir) });

    expect(result).toEqual({ pairs: 1, inserted: 1, skipped: [] });
    expect([...store.listSupersededSetIds()]).toEqual(["wri-kept-elsewhere"]);
    expect(listSets(dataDir, store.listSupersededSetIds()).map((set) => set.id)).toEqual(["wri-replacement"]);
  });
});
