import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import type { AnySet } from "@toefl-prep/shared";
import { buildNoveltyCatalog } from "../src/services/generationCatalog.js";
import { runNoveltyAudit } from "../src/services/noveltyAudit.js";
import {
  speakingSetFixture,
  writingSetFixture,
} from "./helpers/generationDiversityFixtures.js";

const here = path.dirname(fileURLToPath(import.meta.url));
const scratchDirs: string[] = [];

afterEach(() => {
  for (const directory of scratchDirs.splice(0)) {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

function scratchBank(): string {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "novelty-audit-"));
  scratchDirs.push(dataDir);
  fs.mkdirSync(path.join(dataDir, "question-sets/speaking"), {
    recursive: true,
  });
  fs.mkdirSync(path.join(dataDir, "question-sets/writing"), {
    recursive: true,
  });
  return dataDir;
}

function writeSet(dataDir: string, set: AnySet): void {
  fs.writeFileSync(
    path.join(
      dataDir,
      "question-sets",
      set.kind,
      `${set.id}.json`,
    ),
    JSON.stringify(set, null, 2),
  );
}

function duplicateBank(): {
  dataDir: string;
  privateFragments: string[];
} {
  const dataDir = scratchBank();
  const speakingA = speakingSetFixture();
  speakingA.id = "spk-0d5886fd";
  speakingA.listenAndRepeat.image = {
    file: "images/scenarios/private-scene.webp",
    prompt: "PRIVATE_IMAGE_PROMPT ceramic cleanup scene",
    model: "gpt-image-2",
  };
  speakingA.listenAndRepeat.items[0].audio =
    "audio/stimuli/private-speaking.mp3";
  const speakingB = structuredClone(speakingA);
  speakingB.id = "spk-f22a5687";
  writeSet(dataDir, speakingA);
  writeSet(dataDir, speakingB);

  const writingA = writingSetFixture();
  writingA.id = "wri-77af733e";
  const writingB = structuredClone(writingA);
  writingB.id = "wri-787b9d66";
  writeSet(dataDir, writingA);
  writeSet(dataDir, writingB);

  fs.writeFileSync(
    path.join(dataDir, "question-sets/writing/malformed.json"),
    "{ PRIVATE_MALFORMED_ANSWER",
  );

  return {
    dataDir,
    privateFragments: [
      "The Campus Ceramics Studio",
      "Where do you usually find route information",
      "When is the laboratory experiment",
      "It starts tomorrow",
      "PRIVATE_IMAGE_PROMPT",
      "private-speaking.mp3",
      "PRIVATE_MALFORMED_ANSWER",
      "catalog",
      "accepted-plan",
    ],
  };
}

function fileSnapshot(root: string): Record<
  string,
  { bytes: number; sha256: string }
> {
  const snapshot: Record<string, { bytes: number; sha256: string }> = {};
  const visit = (directory: string): void => {
    for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
      const absolute = path.join(directory, entry.name);
      if (entry.isDirectory()) {
        visit(absolute);
        continue;
      }
      const bytes = fs.readFileSync(absolute);
      snapshot[path.relative(root, absolute)] = {
        bytes: bytes.byteLength,
        sha256: crypto.createHash("sha256").update(bytes).digest("hex"),
      };
    }
  };
  visit(root);
  return snapshot;
}

describe("runNoveltyAudit", () => {
  it("reports the complete bank deterministically using only safe fields and never writes", () => {
    const { dataDir, privateFragments } = duplicateBank();
    const before = fileSnapshot(dataDir);
    const warnings: string[] = [];

    const result = runNoveltyAudit({
      dataDir,
      allowExisting: false,
      warn: (message) => warnings.push(message),
    });
    const after = fileSnapshot(dataDir);
    const output = [...warnings, ...result.lines].join("\n");

    expect(result.exitCode).toBe(1);
    expect(result.collisions.length).toBeGreaterThan(0);
    expect(result.lines).toEqual(
      runNoveltyAudit({
        dataDir,
        allowExisting: false,
        warn: () => {},
      }).lines,
    );
    expect(output).toContain("spk-0d5886fd");
    expect(output).toContain("spk-f22a5687");
    expect(output).toContain("wri-77af733e");
    expect(output).toContain("wri-787b9d66");
    expect(output).toMatch(/listen_repeat|interview/u);
    expect(output).toMatch(/build_sentence|email|discussion/u);
    expect(output).toMatch(/domains=[a-z-]+,[a-z-]+/u);
    expect(output).toMatch(/score=1\.000/u);
    expect(output).toMatch(/containment collisions: \d+/u);
    expect(output).toMatch(/total collisions: \d+/u);
    for (const privateFragment of privateFragments) {
      expect(output).not.toContain(privateFragment);
    }
    expect(warnings).toEqual([
      "Skipping invalid set file writing/malformed.json: invalid-json",
    ]);
    expect(after).toEqual(before);
  });

  // The audit's isolation from paid providers. The audit imports the Catalog, the Catalog reads Sets
  // only through a `SetStore`, and `SetStore` has no member that can reach a provider, so the import
  // graph is small and closed. Two tests assert that:
  //
  //   1. the graph is exactly that closed set: an allow-list, so a new provider module cannot join
  //      it unnamed, as one could slip past a deny-list regex; and
  //   2. the Catalog needs nothing but the port: it builds a full Catalog from an object literal,
  //      touching no filesystem and no other store member.
  //
  // `setStore.ts`'s own subtree is setStore.test.ts's "cannot reach a reasoning runner or any paid
  // provider", over a stricter forbidden list (it also forbids `generation`), so the walk below stops
  // at that file. The scan reads `from "…"` specifiers only and cannot see a dynamic `import()` or a
  // `require`; none of these modules uses either.

  it("cannot reach a reasoning runner or any paid provider", () => {
    const sourceRoot = path.resolve(here, "../src");
    // Stop here rather than descending: setStore.test.ts owns this subtree, under a stricter list.
    const delegated = path.join(sourceRoot, "services/setStore.ts");
    const visited = new Set<string>();
    const queue = [path.join(sourceRoot, "services/noveltyAudit.ts")];

    while (queue.length > 0) {
      const file = queue.pop() as string;
      if (visited.has(file)) continue;
      visited.add(file);
      if (file === delegated) continue;
      for (const match of fs.readFileSync(file, "utf8").matchAll(/from\s+"([^"]+)"/gu)) {
        const specifier = match[1]!;
        if (!specifier.startsWith(".")) continue;
        queue.push(path.resolve(path.dirname(file), specifier.replace(/\.js$/u, ".ts")));
      }
    }

    expect(
      [...visited].map((file) => path.relative(sourceRoot, file)).sort(),
    ).toEqual([
      "lib/assertNever.ts",
      "services/diversityIssues.ts",
      "services/generationCatalog.ts",
      "services/generationDomains.ts",
      "services/noveltyAudit.ts",
      "services/noveltySimilarity.ts",
      // Reached, never walked — see `delegated` above.
      "services/setStore.ts",
    ]);
  });

  it("builds a Catalog through the SetStore port alone, touching no filesystem", () => {
    const set = speakingSetFixture();
    set.id = "spk-0d5886fd";
    const unreachable = (member: string) => (): never => {
      throw new Error(`the Catalog called ${member}`);
    };
    // A plain object literal satisfying the port. If the Catalog could reach a Set any other way (a
    // `createSetStore` of its own, a `readdirSync`, a provider), this could not work.
    const catalog = buildNoveltyCatalog({
      store: {
        // Unique per test: buildNoveltyCatalog's fingerprint cache is keyed on this.
        bankDir: "/nonexistent/port-only-bank",
        fingerprint: () => "port-only",
        scanBank: () => ({
          files: [{ ok: true, kind: "speaking", file: `${set.id}.json`, set }],
          sets: [{ kind: "speaking", file: `${set.id}.json`, set }],
          failures: [],
        }),
        readSet: unreachable("readSet"),
        readSetTitle: unreachable("readSetTitle"),
        publish: unreachable("publish"),
        stagingSetPath: unreachable("stagingSetPath"),
        cleanupStagedSet: unreachable("cleanupStagedSet"),
        hasPublishedSet: unreachable("hasPublishedSet"),
      },
    });

    expect(catalog.length).toBeGreaterThan(0);
    expect(new Set(catalog.map((entry) => entry.setId))).toEqual(new Set([set.id]));
    expect(catalog.map((entry) => entry.taskType)).toEqual(["listen_repeat", "interview"]);
  });

  it("--allow-existing changes only the exit code, not the report", () => {
    const { dataDir } = duplicateBank();
    const strict = runNoveltyAudit({
      dataDir,
      allowExisting: false,
      warn: () => {},
    });
    const allowed = runNoveltyAudit({
      dataDir,
      allowExisting: true,
      warn: () => {},
    });

    expect(strict.exitCode).toBe(1);
    expect(allowed.exitCode).toBe(0);
    expect(allowed.collisions).toEqual(strict.collisions);
    expect(allowed.lines).toEqual(strict.lines);
  });

  it("returns a clean zero report for an empty bank", () => {
    const dataDir = scratchBank();

    expect(runNoveltyAudit({
      dataDir,
      allowExisting: false,
      warn: () => {},
    })).toEqual({
      collisions: [],
      lines: ["total collisions: 0"],
      exitCode: 0,
    });
  });
});
