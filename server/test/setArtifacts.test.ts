import fs from "node:fs";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { SpeakingSetSchema } from "@toefl-prep/shared";
import { config } from "../src/lib/config.js";
import { cleanupUnpublishedSetArtifacts, unpublishedSetCleanupTargets } from "../src/services/setArtifacts.js";
import { sceneImageLocation } from "../src/services/sceneImage.js";
import { persistAndReconcileCleanupDebt } from "../src/services/generationPublication.js";
import { openSqliteStores } from "./helpers/sqliteStores.js";

const createdSetIds = new Set<string>();
const uniqueSetId = () => `spk-cleanup-${Math.random().toString(16).slice(2, 10)}`;

function artifactPaths(setId: string) {
  return {
    final: path.join(config.dataDir, "question-sets/speaking", `${setId}.json`),
    staging: path.join(config.dataDir, "question-sets/.staging", `${setId}.json`),
    audio: path.join(config.dataDir, "audio/stimuli", setId),
    scene: sceneImageLocation(setId).path,
  };
}

function createAttemptArtifacts(setId: string): ReturnType<typeof artifactPaths> {
  createdSetIds.add(setId);
  const paths = artifactPaths(setId);
  fs.mkdirSync(path.dirname(paths.staging), { recursive: true });
  fs.mkdirSync(paths.audio, { recursive: true });
  fs.mkdirSync(path.dirname(paths.scene), { recursive: true });
  fs.writeFileSync(paths.staging, "staging");
  fs.writeFileSync(path.join(paths.audio, "lr1.mp3"), "audio");
  fs.writeFileSync(paths.scene, "scene");
  return paths;
}

function validPublishedSet(setId: string) {
  const fixture = SpeakingSetSchema.parse(JSON.parse(fs.readFileSync(
    path.join(config.dataDir, "question-sets/speaking/spk-e5b2b735.json"),
    "utf8",
  )));
  return { ...fixture, id: setId };
}

afterEach(() => {
  for (const setId of createdSetIds) {
    const paths = artifactPaths(setId);
    fs.rmSync(paths.final, { recursive: true, force: true });
    fs.rmSync(paths.staging, { recursive: true, force: true });
    fs.rmSync(paths.audio, { recursive: true, force: true });
    fs.rmSync(paths.scene, { force: true });
  }
  createdSetIds.clear();
});

describe("cleanupUnpublishedSetArtifacts publication guard", () => {
  it("preserves a staging directory collision while removing audio and scene artifacts without throwing", () => {
    const setId = uniqueSetId();
    const paths = createAttemptArtifacts(setId);
    fs.rmSync(paths.staging);
    fs.mkdirSync(paths.staging);
    fs.writeFileSync(path.join(paths.staging, "owner.txt"), "unrelated collision");

    let removed: boolean | undefined;
    expect(() => {
      removed = cleanupUnpublishedSetArtifacts("speaking", setId);
    }).not.toThrow();
    expect(removed).toBe(true);

    expect(fs.lstatSync(paths.staging).isDirectory()).toBe(true);
    expect(fs.readFileSync(path.join(paths.staging, "owner.txt"), "utf8")).toBe("unrelated collision");
    expect(fs.existsSync(paths.audio)).toBe(false);
    expect(fs.existsSync(paths.scene)).toBe(false);
  });

  it("does not treat corrupt JSON at the final path as published and leaves that collision untouched", () => {
    const setId = uniqueSetId();
    const paths = createAttemptArtifacts(setId);
    fs.mkdirSync(path.dirname(paths.final), { recursive: true });
    fs.writeFileSync(paths.final, "{ not valid JSON");

    expect(cleanupUnpublishedSetArtifacts("speaking", setId)).toBe(true);

    expect(fs.readFileSync(paths.final, "utf8")).toBe("{ not valid JSON");
    expect(fs.existsSync(paths.staging)).toBe(false);
    expect(fs.existsSync(paths.audio)).toBe(false);
    expect(fs.existsSync(paths.scene)).toBe(false);
  });

  it("does not treat a valid set with the wrong id as this attempt's publication", () => {
    const setId = uniqueSetId();
    const paths = createAttemptArtifacts(setId);
    fs.mkdirSync(path.dirname(paths.final), { recursive: true });
    const collision = validPublishedSet("spk-someone-else");
    fs.writeFileSync(paths.final, JSON.stringify(collision, null, 2));

    expect(cleanupUnpublishedSetArtifacts("speaking", setId)).toBe(true);

    expect(JSON.parse(fs.readFileSync(paths.final, "utf8")).id).toBe("spk-someone-else");
    expect(fs.existsSync(paths.staging)).toBe(false);
    expect(fs.existsSync(paths.audio)).toBe(false);
    expect(fs.existsSync(paths.scene)).toBe(false);
  });

  it("preserves assets when the final path is a valid regular set JSON for the expected kind and id", () => {
    const setId = uniqueSetId();
    const paths = createAttemptArtifacts(setId);
    fs.mkdirSync(path.dirname(paths.final), { recursive: true });
    fs.writeFileSync(paths.final, JSON.stringify(validPublishedSet(setId), null, 2));

    expect(cleanupUnpublishedSetArtifacts("speaking", setId)).toBe(false);

    expect(fs.existsSync(paths.final)).toBe(true);
    expect(fs.existsSync(paths.staging)).toBe(true);
    expect(fs.existsSync(paths.audio)).toBe(true);
    expect(fs.existsSync(paths.scene)).toBe(true);
  });
});

// A cancelled job records its unpublished artifacts as cleanup debt before removing them, so a
// removal that fails is retried at boot. The scene writer's temp files carry a random suffix, so the
// debt has to name each one found, or a temp left by a killed write outlives the job.
describe("unpublishedSetCleanupTargets", () => {
  it("names the scene image's temp files beside the canonical image, and the debt removes them", () => {
    const setId = uniqueSetId();
    const paths = createAttemptArtifacts(setId);
    const temp = path.join(path.dirname(paths.scene), `.${setId}.ab12cd34.webp.tmp`);
    const neighbour = path.join(path.dirname(paths.scene), `.${setId}-more.ab12cd34.webp.tmp`);
    fs.writeFileSync(temp, "half-written scene");
    fs.writeFileSync(neighbour, "another Set's temp");

    const targets = unpublishedSetCleanupTargets("speaking", setId);
    expect(targets).toEqual(expect.arrayContaining([paths.staging, paths.audio, paths.scene, temp]));
    expect(targets).not.toContain(neighbour);

    const repo = openSqliteStores();
    repo.createGenerationJob({ id: "job-cancelled", kind: "speaking" });
    expect(persistAndReconcileCleanupDebt(repo, "job-cancelled", targets)).toEqual({ completed: targets.length, failed: 0 });
    expect(repo.listPendingCleanupDebt()).toEqual([]);
    for (const removed of [paths.staging, paths.audio, paths.scene, temp]) expect(fs.existsSync(removed)).toBe(false);
    expect(fs.existsSync(neighbour)).toBe(true);
    fs.rmSync(neighbour, { force: true });
  });
});
