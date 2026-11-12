import fs from "node:fs";
import path from "node:path";
import { config } from "../lib/config.js";
import { cleanupSceneImageArtifacts, sceneImageLocation, sceneImageTempPaths } from "./sceneImage.js";
import { isSetBankKind, setStore, type SetBankKind } from "./setStore.js";

const SET_ID_RE = /^[A-Za-z0-9_-]+$/;

// Removes what a Set owns outside the bank's own JSON before it publishes: its audio directory
// (Speaking and Listening) and its scene image (Speaking), plus its staged JSON through the store.
// Called when generation fails and by boot recovery for an interrupted generation job.

/** The kinds whose unpublished artifacts can be cleaned: every bank kind. */
export type CleanableSetKind = SetBankKind;

// Narrows a `kind: string` read from a database row, so the check is visible at the call site.
export function isCleanableSetKind(kind: string): kind is CleanableSetKind {
  return isSetBankKind(kind);
}

// The paths one Set owns before its JSON publishes it, recorded as cleanup debt by generation: the
// staged JSON (named by the store), the audio directory for Speaking and Listening, and for Speaking
// the scene image and any temp files its writer left. This module is where a kind maps to its
// artifacts.
export function unpublishedSetCleanupTargets(kind: CleanableSetKind, setId: string): string[] {
  const targets = [setStore.stagingSetPath(setId)];
  if (kind === "speaking" || kind === "listening") targets.push(path.join(config.dataDir, "audio/stimuli", setId));
  if (kind === "speaking") targets.push(sceneImageLocation(setId).path, ...sceneImageTempPaths(setId));
  return targets;
}

// Cleanup runs while handling another failure (or recovering one at boot), so it must never replace
// that failure or stop state recovery. Each target gets its own error boundary: a collision or
// permission failure at one path cannot prevent cleanup attempts at the remaining exact-set paths.
function bestEffort(remove: () => boolean): boolean {
  try {
    return remove();
  } catch {
    return false;
  }
}

function removeDirectory(dir: string): boolean {
  return bestEffort(() => {
    // Audio is rendered into a real per-Set directory; anything else at that path is a collision and
    // is kept.
    if (!fs.lstatSync(dir).isDirectory()) return false;
    fs.rmSync(dir, { recursive: true, force: true });
    return true;
  });
}

// Deletes the artifacts of a Set that never published, and returns whether anything was removed.
// The one publication guard shared by generation failure handling and boot recovery: only a valid,
// regular Set JSON of the expected kind and id counts as published (the store's `hasPublishedSet`).
// An invalid file at that path is neither deleted nor treated as a publication. `preserveAudio`
// keeps the audio directory, for a render that failed because that directory already existed and so
// is not this attempt's.
export function cleanupUnpublishedSetArtifacts(kind: CleanableSetKind, setId: string, options: { preserveAudio?: boolean } = {}): boolean {
  // Still checked at runtime, not just typed: a caller crossing a JS boundary (a DB row read back
  // without a static type) can still hand this an arbitrary string.
  if (!isCleanableSetKind(kind) || !SET_ID_RE.test(setId)) return false;

  if (setStore.hasPublishedSet(kind, setId)) return false;

  let removedAnything = false;
  if (setStore.cleanupStagedSet(setId)) removedAnything = true;
  if (kind === "speaking") {
    const stimuliDir = path.join(config.dataDir, "audio/stimuli", setId);
    if (!options.preserveAudio && removeDirectory(stimuliDir)) removedAnything = true;
    if (bestEffort(() => cleanupSceneImageArtifacts(setId))) removedAnything = true;
  }
  if (kind === "listening") {
    // Same audio directory as Speaking; Listening has no scene image.
    const stimuliDir = path.join(config.dataDir, "audio/stimuli", setId);
    if (!options.preserveAudio && removeDirectory(stimuliDir)) removedAnything = true;
  }
  return removedAnything;
}
