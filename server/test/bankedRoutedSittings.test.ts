import { describe, expect, it } from "vitest";
import type { ListeningSet, ReadingSet, ScoreRequest } from "@toefl-prep/shared";
import { config } from "../src/lib/config.js";
import { deterministicItemEntries, scoreDeterministicItems } from "../src/services/deterministicScoring.js";
import { bandShortfall, computeSectionEstimate } from "../src/services/sectionEstimates.js";
import { createSetStore } from "../src/services/setStore.js";
import { openSqliteStores } from "./helpers/sqliteStores.js";

// The band rule asks each Module a routed Attempt took for an Item of every Task Type the Module
// composition names (READING_MODULE_COMPOSITION / LISTENING_MODULE_COMPOSITION), not of what the
// Set's own Module happens to hold. A banked Set composed some other way would leave every complete
// sitting of it without a band. This sits every banked Reading and Listening Set in full, on both
// paths, through the real scorer and store, and holds each sitting to the rule.

// A banked Set's file name: a section prefix and eight hex digits.
const BANKED_SET_FILE = /^(rd|lsn)-[0-9a-f]{8}\.json$/;

function bankedRoutedSets(): (ReadingSet | ListeningSet)[] {
  return createSetStore(config.dataDir)
    .scanBank()
    .sets.filter((banked) => BANKED_SET_FILE.test(banked.file))
    .map((banked) => banked.set)
    .filter((set): set is ReadingSet | ListeningSet => set.kind === "reading" || set.kind === "listening");
}

/** One score request per Task Type for the Items of `module`, in the shape the client sends. */
function moduleRequests(set: ReadingSet | ListeningSet, module: "router" | "lower" | "upper"): ScoreRequest[] {
  const byTaskType = new Map<string, string[]>();
  for (const [id, ref] of deterministicItemEntries(set)) {
    if (ref.module !== module) continue;
    byTaskType.set(ref.taskType, [...(byTaskType.get(ref.taskType) ?? []), id]);
  }
  return [...byTaskType].map(([taskType, ids]) => ({
    taskType,
    items: ids.map((itemId) => (taskType === "complete_words" ? { itemId, typed: "" } : { itemId, selectedOptionId: "a" })),
  }) as ScoreRequest);
}

describe("every banked Reading and Listening Set, sat in full", () => {
  const sets = bankedRoutedSets();

  it("walks both sections, including Sets whose Upper Module still carries a Daily Life text", () => {
    expect(sets.some((set) => set.kind === "reading")).toBe(true);
    expect(sets.some((set) => set.kind === "listening")).toBe(true);
    // The older Reading composition the rule must keep honouring.
    expect(sets.some((set) => set.kind === "reading" && set.upperModule.dailyLife.length > 0)).toBe(true);
  });

  it("has a band on either path, with no shortfall", () => {
    const repo = openSqliteStores();
    for (const set of sets) {
      for (const path of ["lower", "upper"] as const) {
        const attemptId = `${set.id}-${path}`;
        repo.createAttempt({ id: attemptId, kind: set.kind, mode: "simulation", setId: set.id, isRepeat: false });
        for (const request of moduleRequests(set, "router")) {
          scoreDeterministicItems({ repo, attempt: repo.getAttempt(attemptId)!, set, request });
        }
        repo.setAttemptRouting(attemptId, path, 0.5);
        for (const request of moduleRequests(set, path)) {
          scoreDeterministicItems({ repo, attempt: repo.getAttempt(attemptId)!, set, request });
        }

        const attempt = repo.getAttempt(attemptId)!;
        expect(bandShortfall(set.kind, path, attempt.items), `${set.id} on the ${path} path`).toBeNull();
        expect(computeSectionEstimate(attempt).status, `${set.id} on the ${path} path`).toBe("estimated");
      }
    }
  });
});
