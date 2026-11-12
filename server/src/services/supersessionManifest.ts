import { randomUUID } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { formatSupersessionManifest, SupersessionManifestSchema, type Supersession } from "@toefl-prep/shared";
import { config } from "../lib/config.js";
import type { BootRecoveryServer } from "./scoringJobs.js";
import { createSetStore, safeSetErrorDescriptor, type SetReader } from "./setStore.js";

// The supersession manifest, `<dataDir>/question-sets/supersessions.json`, is the source of truth for
// which Sets are retired (ADR 0011); it is tracked in git so a fresh clone retires the same Sets.
// `superseded_sets` is the runtime index the Set listing and the Novelty Catalog read. Two paths
// keep the two in step:
//
//   * at boot, every manifest pair is inserted into the table if the table does not already hold a
//     row for that Set (applySupersessionManifest below);
//   * at runtime, db/stores/supersession.ts writes the table row and the manifest in one
//     transaction, so a retirement the app records is in the file as soon as it is in the table.

export const SUPERSESSION_MANIFEST_FILE = "supersessions.json";

export function supersessionManifestPath(dataDir: string): string {
  return path.join(dataDir, "question-sets", SUPERSESSION_MANIFEST_FILE);
}

/** Every pair in the manifest. A missing file is an empty manifest; a malformed one throws. */
export function readSupersessionManifest(file: string): Supersession[] {
  let text: string;
  try {
    text = fs.readFileSync(file, "utf8");
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw err;
  }
  return SupersessionManifestSchema.parse(JSON.parse(text)).supersessions;
}

/**
 * Replaces the manifest with `pairs`, in its canonical order and format. Written to a sibling temp
 * file and renamed over the original, so a reader sees the old file or the new one and never a
 * partial write.
 */
export function writeSupersessionManifest(file: string, pairs: readonly Supersession[]): void {
  const body = formatSupersessionManifest(pairs);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const temp = path.join(path.dirname(file), `.${path.basename(file)}.${process.pid}.${randomUUID()}.tmp`);
  try {
    fs.writeFileSync(temp, body);
    fs.renameSync(temp, file);
  } catch (err) {
    fs.rmSync(temp, { force: true });
    throw err;
  }
}

/** The one table write the boot pass needs: insert a row unless one for that Set already exists. */
export type SupersessionIndexStore = {
  /** Returns whether a row was inserted. Never replaces or deletes an existing row. */
  insertSupersessionIfAbsent(pair: Supersession): boolean;
};

export type SupersessionManifestApplication = {
  /** Pairs read from the manifest. */
  pairs: number;
  /** Rows newly inserted into the table. */
  inserted: number;
  /** Retired ids whose pair was skipped because its replacement is not a readable Set of the same kind. */
  skipped: string[];
};

/**
 * Inserts every manifest pair the table does not already hold.
 *
 * A row the table already has for that Set is left exactly as it is, whatever the manifest says:
 * the local database may have recorded a newer replacement than the checkout's manifest knows of.
 *
 * A pair is skipped when its replacement Set is not on disk, or is a different kind from the Set it
 * retires. Retiring a Set whose replacement is missing would take the only Set for that slot out of
 * the listing; skipping leaves both visible, which is the recoverable side.
 */
export function applySupersessionManifest(input: {
  manifestPath: string;
  store: SupersessionIndexStore;
  setReader: SetReader;
}): SupersessionManifestApplication {
  const pairs = readSupersessionManifest(input.manifestPath);
  let inserted = 0;
  const skipped: string[] = [];
  for (const pair of pairs) {
    const replacement = input.setReader.readSet(pair.supersededBy);
    const retired = input.setReader.readSet(pair.setId);
    if (!replacement || (retired && retired.kind !== replacement.kind)) {
      skipped.push(pair.setId);
      continue;
    }
    if (input.store.insertSupersessionIfAbsent(pair)) inserted += 1;
  }
  return { pairs: pairs.length, inserted, skipped };
}

/**
 * Registers the manifest as a boot pass (bootRecoveryRegistry.ts). Never throws: failures are logged,
 * because a throwing pass would stop the passes after it.
 */
export function wireSupersessionManifest(
  server: BootRecoveryServer,
  store: SupersessionIndexStore,
  dataDir: string = config.dataDir,
): void {
  server.on("listening", () => {
    try {
      const result = applySupersessionManifest({
        manifestPath: supersessionManifestPath(dataDir),
        store,
        setReader: createSetStore(dataDir),
      });
      if (result.inserted > 0) {
        console.log(`[server] supersessions: retired ${result.inserted} Set(s) from ${SUPERSESSION_MANIFEST_FILE}`);
      }
      if (result.skipped.length > 0) {
        console.warn(
          `[server] supersessions: kept ${result.skipped.length} Set(s) listed because their replacement is missing or of another kind: ${result.skipped.join(", ")}`,
        );
      }
    } catch (err) {
      console.error(`[server] could not apply ${SUPERSESSION_MANIFEST_FILE}:`, safeSetErrorDescriptor(err));
    }
  });
}
