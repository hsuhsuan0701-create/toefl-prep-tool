import { describe, expect, it, vi } from "vitest";
import { SKIPPED_ITEM_REASON } from "@toefl-prep/shared";
import {
  computeSectionEstimate,
  readPersistedEstimate,
  recomputeSectionEstimate,
  type EstimateAttempt,
  type EstimateItemRow,
  type SectionBandResult,
} from "../src/services/sectionEstimates.js";
import { openSqliteStores } from "./helpers/sqliteStores.js";
import { moduleScoreJson, wholeSittingItems } from "./helpers/wholeSitting.js";

// The band rule, the scored-Item filter, the judged-vs-deterministic dispatch and the Simulation +
// Module Path gate are pure functions of an Attempt, so computeSectionEstimate is driven with plain
// Attempt objects. The recompute (which writes or clears the persisted row) and the read side run
// over the real SQLite stores, the same adapters production hands them.

function item(overrides: Partial<EstimateItemRow> & { task_type: string }): EstimateItemRow {
  return { score: 5, scoring_status: "scored", score_json: null, ...overrides };
}

function attempt(overrides: Partial<EstimateAttempt> & { kind: string }): EstimateAttempt {
  return { mode: "simulation", module_path: null, items: [], ...overrides };
}

// One scored Item of every Task Type a section needs, at the given score — the smallest Attempt
// that can carry a band.
function fullSpeaking(score = 5): EstimateItemRow[] {
  return [item({ task_type: "listen_repeat", score }), item({ task_type: "interview", score })];
}
function fullWriting(): EstimateItemRow[] {
  return [item({ task_type: "build_sentence", score: 1 }), item({ task_type: "email", score: 5 }), item({ task_type: "discussion", score: 5 })];
}
// Reading's: one per Task Type each Module taken carries, the Router Module's and the one the
// Module Path names, each row tagged with its Module.
function fullReading(correct = 1, modulePath: "lower" | "upper" = "upper"): EstimateItemRow[] {
  return wholeSittingItems("reading", modulePath).map((i) => item({ task_type: i.taskType, score: correct, score_json: i.scoreJson }));
}
function tagged(task_type: string, module: "router" | "lower" | "upper"): EstimateItemRow {
  return item({ task_type, score: 1, score_json: moduleScoreJson(module) });
}

function estimateOf(result: SectionBandResult) {
  if (result.status !== "estimated") throw new Error(`expected a band, got ${result.status}`);
  return result.estimate;
}

type Stores = ReturnType<typeof openSqliteStores>;

/** Writes one Item row as upload and scoring leave it; a 'pending' Item gets no score write. */
function writeItem(r: Stores, attemptId: string, itemId: string, row: EstimateItemRow): void {
  r.insertItemResult({ attemptId, itemId, taskType: row.task_type });
  if (row.scoring_status === "pending") return;
  r.updateItemScore({ attemptId, itemId, score: row.score, scoreJson: row.score_json ?? "{}", scoringStatus: row.scoring_status });
}

/** An Attempt row in SQLite, routed when it names a Module Path, holding `a.items` in order. */
function seedAttempt(r: Stores, id: string, a: Omit<EstimateAttempt, "items"> & { items: EstimateItemRow[] }): void {
  r.createAttempt({ id, kind: a.kind, mode: a.mode, setId: `${a.kind}-set`, isRepeat: false });
  if (a.module_path) r.setAttemptRouting(id, a.module_path, 0.7);
  a.items.forEach((row, i) => writeItem(r, id, `${row.task_type}-${i + 1}`, row));
}

const skippedJson = JSON.stringify({ skipped: true, reason: SKIPPED_ITEM_REASON });

describe("computeSectionEstimate", () => {
  describe("the scored-Item filter", () => {
    it("counts every scored Item, one coverage entry per Task Type", () => {
      const result = computeSectionEstimate(attempt({
        kind: "speaking",
        items: [
          item({ task_type: "listen_repeat", score: 5 }),
          item({ task_type: "listen_repeat", score: 3 }),
          item({ task_type: "interview", score: 5 }),
        ],
      }));

      expect(estimateOf(result).coverage).toEqual([
        { taskType: "listen_repeat", itemCount: 2, skippedCount: 0 },
        { taskType: "interview", itemCount: 1, skippedCount: 0 },
      ]);
    });

    it("scales each Item by its own Task Type: a Writing attempt mixes 0-1 Build a Sentence with 0-5 judged types", () => {
      expect(computeSectionEstimate(attempt({ kind: "writing", items: fullWriting() }))).toEqual({
        status: "estimated",
        estimate: expect.objectContaining({ section: "writing", band: 6, raw: 1, method: "linear-v2" }),
      });
    });

    it("discloses a deliberate skip in coverage while still counting it as a real 0 in the mean", () => {
      const estimate = estimateOf(computeSectionEstimate(attempt({
        kind: "speaking",
        items: [
          item({ task_type: "listen_repeat", score: 5 }),
          item({ task_type: "listen_repeat", score: 0, score_json: skippedJson }),
          item({ task_type: "interview", score: 5 }),
        ],
      })));
      expect(estimate.coverage[0]).toEqual({ taskType: "listen_repeat", itemCount: 2, skippedCount: 1 });
      // Listen and Repeat averages 0.5, not 1.0: the skip is in the mean.
      expect(estimate.raw).toBeCloseTo((7 / 11) * 0.5 + 4 / 11);
    });

    it("a judged 0 is NOT a skip, and corrupt score_json is not one either", () => {
      const estimate = estimateOf(computeSectionEstimate(attempt({
        kind: "speaking",
        items: [
          item({ task_type: "listen_repeat", score: 0, score_json: JSON.stringify({ error: "judges failed" }) }),
          item({ task_type: "interview", score: 0, score_json: "{not json" }),
        ],
      })));
      expect(estimate.coverage.map((c) => c.skippedCount)).toEqual([0, 0]);
    });
  });

  describe("the band rule", () => {
    it("a Speaking Attempt with one silent Listen and Repeat 0, six failed Items and three skipped Interviews has no band and says why", () => {
      const result = computeSectionEstimate(attempt({
        kind: "speaking",
        items: [
          item({ task_type: "listen_repeat", score: 0 }),
          ...[1, 2, 3, 4, 5, 6].map(() => item({ task_type: "listen_repeat", score: null, scoring_status: "failed" })),
          item({ task_type: "interview", score: 3 }),
          ...[1, 2, 3].map(() => item({ task_type: "interview", score: 0, score_json: skippedJson })),
        ],
      }));
      expect(result).toEqual({
        status: "incomplete",
        section: "speaking",
        shortfall: { unscored: [{ taskType: "listen_repeat", failed: 6, pending: 0, notCaptured: 0 }], absent: [] },
      });
    });

    it("Build a Sentence scored while the essays are still pending is not a Writing band", () => {
      const result = computeSectionEstimate(attempt({
        kind: "writing",
        items: [
          ...Array.from({ length: 10 }, () => item({ task_type: "build_sentence", score: 1 })),
          item({ task_type: "email", score: null, scoring_status: "pending" }),
          item({ task_type: "discussion", score: null, scoring_status: "pending" }),
        ],
      }));
      expect(result).toMatchObject({
        status: "incomplete",
        shortfall: {
          unscored: [
            { taskType: "email", failed: 0, pending: 1, notCaptured: 0 },
            { taskType: "discussion", failed: 0, pending: 1, notCaptured: 0 },
          ],
          absent: [],
        },
      });
    });

    it("nothing recorded is every Task Type absent", () => {
      expect(computeSectionEstimate(attempt({ kind: "writing", items: [] }))).toEqual({
        status: "incomplete",
        section: "writing",
        shortfall: { unscored: [], absent: ["build_sentence", "email", "discussion"] },
      });
    });

    it("a routed Reading Simulation missing a Task Type of its Modules has no band", () => {
      expect(computeSectionEstimate(attempt({
        kind: "reading", mode: "simulation", module_path: "upper",
        items: [tagged("complete_words", "router"), tagged("academic_passage", "router"), ...fullReading().filter((i) => i.score_json === moduleScoreJson("upper"))],
      }))).toEqual({
        status: "incomplete",
        section: "reading",
        shortfall: { unscored: [], absent: [], moduleShortfalls: [{ module: "router", sat: true, absent: ["daily_life"] }] },
      });
    });
  });

  // A routed Attempt's band needs Items of both Modules it took. The Router Module carries every Task
  // Type of the section, so a section-wide count would take a Router-only sitting for the whole one.
  describe("the per-Module rule for a routed Simulation", () => {
    const routerOnly = () => fullReading().filter((i) => i.score_json === moduleScoreJson("router"));

    it("a Router Module alone, routed and then finished, has no band, and names the Module it never sat", () => {
      for (const module_path of ["lower", "upper"] as const) {
        const result = computeSectionEstimate(attempt({ kind: "reading", mode: "simulation", module_path, items: routerOnly() }));
        expect(result).toEqual({
          status: "incomplete",
          section: "reading",
          shortfall: {
            unscored: [],
            absent: [],
            moduleShortfalls: [{
              module: module_path,
              sat: false,
              absent: module_path === "upper" ? ["complete_words", "academic_passage"] : ["complete_words", "daily_life", "academic_passage"],
            }],
          },
        });
      }
      const listening = computeSectionEstimate(attempt({
        kind: "listening", mode: "simulation", module_path: "upper",
        items: wholeSittingItems("listening", "upper").filter((i) => i.itemId.startsWith("router-")).map((i) => item({ task_type: i.taskType, score: 1, score_json: i.scoreJson })),
      }));
      expect(listening).toMatchObject({ status: "incomplete", shortfall: { moduleShortfalls: [{ module: "upper", sat: false }] } });
    });

    it("a second Module short of one of its Task Types has no band, and names what it lacks", () => {
      expect(computeSectionEstimate(attempt({
        kind: "reading", mode: "simulation", module_path: "upper",
        items: [...routerOnly(), tagged("complete_words", "upper")],
      }))).toMatchObject({ status: "incomplete", shortfall: { absent: [], moduleShortfalls: [{ module: "upper", sat: true, absent: ["academic_passage"] }] } });
    });

    it("counts an Item only toward the Module it is tagged with: the other second Module's Items, and untagged ones, cover nothing", () => {
      const lowerItems = fullReading(1, "lower").filter((i) => i.score_json === moduleScoreJson("lower"));
      expect(computeSectionEstimate(attempt({ kind: "reading", mode: "simulation", module_path: "upper", items: [...routerOnly(), ...lowerItems] })))
        .toMatchObject({ status: "incomplete", shortfall: { moduleShortfalls: [{ module: "upper", sat: false }] } });

      const untagged = fullReading().map((i) => ({ ...i, score_json: JSON.stringify({ correct: true }) }));
      expect(computeSectionEstimate(attempt({ kind: "reading", mode: "simulation", module_path: "upper", items: untagged })))
        .toMatchObject({
          status: "incomplete",
          shortfall: { moduleShortfalls: [{ module: "router", sat: false }, { module: "upper", sat: false }] },
        });
    });

    it("an Upper Module carrying an extra Daily Life text, as older Sets do, still has its band", () => {
      expect(computeSectionEstimate(attempt({
        kind: "reading", mode: "simulation", module_path: "upper",
        items: [...fullReading(), tagged("daily_life", "upper")],
      })).status).toBe("estimated");
    });
  });

  describe("the estimator dispatch", () => {
    it("Speaking and Writing take linear-v2", () => {
      expect(estimateOf(computeSectionEstimate(attempt({ kind: "speaking", items: fullSpeaking(3) })))).toMatchObject({ section: "speaking", method: "linear-v2" });
      expect(estimateOf(computeSectionEstimate(attempt({ kind: "writing", items: fullWriting() })))).toMatchObject({ section: "writing", method: "linear-v2" });
    });

    it("Reading and Listening take table3-v1, and the Module Path is fed to it", () => {
      const upper = estimateOf(computeSectionEstimate(attempt({ kind: "reading", mode: "simulation", module_path: "upper", items: fullReading() })));
      const lower = estimateOf(computeSectionEstimate(attempt({ kind: "reading", mode: "simulation", module_path: "lower", items: fullReading(1, "lower") })));
      expect(upper).toMatchObject({ section: "reading", method: "table3-v1", raw: 1, band: 6 });
      // The Lower Module's cap (ours, not ETS policy; bandEstimator.ts), on the same perfect score.
      expect(lower).toMatchObject({ section: "reading", method: "table3-v1", raw: 1, band: 4.5 });
    });
  });

  describe("the Simulation + Module Path gate", () => {
    it("a routed Reading Simulation gets a band", () => {
      expect(computeSectionEstimate(attempt({ kind: "reading", mode: "simulation", module_path: "upper", items: fullReading() })).status).toBe("estimated");
    });

    it("a Reading DRILL never does — Drills only ever expose the Router Module", () => {
      expect(computeSectionEstimate(attempt({ kind: "reading", mode: "drill", module_path: null, items: fullReading() }))).toEqual({ status: "not-applicable" });
      expect(computeSectionEstimate(attempt({ kind: "reading", mode: "drill", module_path: "upper", items: fullReading() }))).toEqual({ status: "not-applicable" });
    });

    it("a Simulation completed before POST /:id/route ran never does either", () => {
      expect(computeSectionEstimate(attempt({ kind: "reading", mode: "simulation", module_path: null, items: fullReading() }))).toEqual({ status: "not-applicable" });
      expect(computeSectionEstimate(attempt({
        kind: "listening", mode: "simulation", module_path: null,
        items: [item({ task_type: "conversation", score: 1 })],
      }))).toEqual({ status: "not-applicable" });
    });

    it("does NOT gate Speaking or Writing — a Drill covering every Task Type gets a band", () => {
      expect(computeSectionEstimate(attempt({ kind: "speaking", mode: "drill", items: fullSpeaking(4) })).status).toBe("estimated");
      expect(computeSectionEstimate(attempt({ kind: "writing", mode: "drill", items: fullWriting() })).status).toBe("estimated");
    });
  });
});

describe("recomputeSectionEstimate", () => {
  it("upserts what it computed and returns it", () => {
    const r = openSqliteStores();
    seedAttempt(r, "att-1", attempt({ kind: "speaking", items: fullSpeaking() }));

    const estimate = recomputeSectionEstimate(r, "att-1");

    expect(estimate).toMatchObject({ section: "speaking", band: 6, method: "linear-v2" });
    expect(r.getSectionEstimate("att-1")).toMatchObject({
      section: "speaking",
      rawDetail: JSON.stringify({ raw: estimate!.raw, coverage: estimate!.coverage }),
      estimatedBand: 6,
      method: "linear-v2",
    });
    expect(r.countSectionEstimates("att-1")).toBe(1);
  });

  it("writes no band for an unknown attempt, a gated one, or one short of a Task Type", () => {
    const r = openSqliteStores();
    seedAttempt(r, "drill", attempt({ kind: "reading", mode: "drill", items: fullReading() }));
    seedAttempt(r, "empty", attempt({ kind: "writing", items: [] }));
    seedAttempt(r, "partial", attempt({ kind: "writing", items: [item({ task_type: "build_sentence", score: 1 })] }));

    expect(recomputeSectionEstimate(r, "missing")).toBeNull();
    expect(recomputeSectionEstimate(r, "drill")).toBeNull();
    expect(recomputeSectionEstimate(r, "empty")).toBeNull();
    expect(recomputeSectionEstimate(r, "partial")).toBeNull();
    for (const id of ["drill", "empty", "partial"]) expect(r.countSectionEstimates(id), id).toBe(0);
  });

  it("a repeat recompute REPLACES the one current row rather than appending a second", () => {
    const r = openSqliteStores();
    seedAttempt(r, "att-1", attempt({ kind: "speaking", items: fullSpeaking() }));

    recomputeSectionEstimate(r, "att-1");
    writeItem(r, "att-1", "interview-extra", item({ task_type: "interview", score: 0 }));
    const second = recomputeSectionEstimate(r, "att-1");

    expect(r.countSectionEstimates("att-1")).toBe(1);
    // 7/11 * 1 + 4/11 * 0.5 = 9/11 -> 5.09 -> 5.0
    expect(second!.band).toBe(5);
    expect(readPersistedEstimate(r, "att-1")).toMatchObject({ band: 5 });
  });

  it("CLEARS the persisted band once an Item stops being scored — a band never outlives the rule", () => {
    const r = openSqliteStores();
    seedAttempt(r, "att-1", attempt({ kind: "speaking", items: fullSpeaking() }));
    recomputeSectionEstimate(r, "att-1");
    expect(readPersistedEstimate(r, "att-1")).toMatchObject({ band: 6 });

    // The Interview was re-scored and both Judges failed: its score is gone.
    r.updateItemScore({ attemptId: "att-1", itemId: "interview-2", score: null, scoreJson: JSON.stringify({ error: "both judges failed" }), scoringStatus: "failed" });

    expect(recomputeSectionEstimate(r, "att-1")).toBeNull();
    expect(readPersistedEstimate(r, "att-1")).toBeNull();
    expect(r.countSectionEstimates("att-1")).toBe(0);
  });

  it("does not clear anything for an attempt that does not exist", () => {
    const r = openSqliteStores();
    const clear = vi.spyOn(r, "clearSectionEstimate");
    recomputeSectionEstimate(r, "missing");
    expect(clear).not.toHaveBeenCalled();
  });
});

describe("readPersistedEstimate", () => {
  // A row persisted under the section-wide rule for a routed Attempt that was finished after its
  // Router Module: its stored coverage spans every Task Type (the Router carries them all), so only
  // the per-Module check over the Attempt's current Items refuses it.
  it("refuses a row persisted for a routed Attempt that never sat its second Module", () => {
    const r = openSqliteStores();
    const routerOnly = fullReading().filter((i) => i.score_json === moduleScoreJson("router"));
    seedAttempt(r, "att-router-only", attempt({ kind: "reading", mode: "simulation", module_path: "upper", items: routerOnly }));
    r.saveSectionEstimate({
      attemptId: "att-router-only",
      section: "reading",
      rawDetail: JSON.stringify({ raw: 1, coverage: ["complete_words", "daily_life", "academic_passage"].map((taskType) => ({ taskType, itemCount: 1, skippedCount: 0 })) }),
      estimatedBand: 6,
      method: "table3-v1",
    });
    expect(readPersistedEstimate(r, "att-router-only")).toBeNull();
  });

  it("reads back the persisted row in AttemptDetailVM's shape", () => {
    const r = openSqliteStores();
    seedAttempt(r, "att-1", attempt({ kind: "reading", mode: "simulation", module_path: "upper", items: fullReading() }));
    const written = recomputeSectionEstimate(r, "att-1");

    expect(readPersistedEstimate(r, "att-1")).toEqual({
      section: "reading",
      band: written!.band,
      raw: written!.raw,
      method: "table3-v1",
      coverage: written!.coverage,
    });
  });

  it("null for an attempt with no row, and null (never a throw) for a corrupt rawDetail", () => {
    const r = openSqliteStores();
    seedAttempt(r, "att-1", attempt({ kind: "speaking", items: fullSpeaking() }));
    expect(readPersistedEstimate(r, "att-1")).toBeNull();

    r.saveSectionEstimate({ attemptId: "att-1", section: "speaking", rawDetail: "{not json", estimatedBand: 5, method: "linear-v2" });
    expect(readPersistedEstimate(r, "att-1")).toBeNull();
  });

  // A row persisted under a looser rule, from three skipped Interviews alone, on an Attempt whose
  // Items are all scored now: the row's own coverage is what refuses it.
  it("refuses a row persisted from part of a section, whatever the Attempt's Items say now", () => {
    const r = openSqliteStores();
    seedAttempt(r, "att-partial-row", attempt({ kind: "speaking", items: fullSpeaking() }));
    r.saveSectionEstimate({
      attemptId: "att-partial-row",
      section: "speaking",
      rawDetail: JSON.stringify({ raw: 0, coverage: [{ taskType: "interview", itemCount: 3, skippedCount: 3 }] }),
      estimatedBand: 1,
      method: "linear-v2",
    });
    expect(readPersistedEstimate(r, "att-partial-row")).toBeNull();
  });

  it("refuses a row with no coverage at all", () => {
    const r = openSqliteStores();
    seedAttempt(r, "a", attempt({ kind: "writing", items: fullWriting() }));
    r.saveSectionEstimate({ attemptId: "a", section: "writing", rawDetail: "{}", estimatedBand: 4, method: "linear-v2" });
    expect(readPersistedEstimate(r, "a")).toBeNull();
  });

  it("passes an older method through verbatim — a persisted estimate keeps the method it was computed under", () => {
    const r = openSqliteStores();
    const coverage = [
      { taskType: "build_sentence", itemCount: 10 },
      { taskType: "email", itemCount: 1 },
      { taskType: "discussion", itemCount: 1 },
    ];
    seedAttempt(r, "att-1", attempt({ kind: "writing", items: fullWriting() }));
    r.saveSectionEstimate({ attemptId: "att-1", section: "writing", rawDetail: JSON.stringify({ raw: 0.6, coverage }), estimatedBand: 4, method: "linear-v1" });

    expect(readPersistedEstimate(r, "att-1")).toEqual({
      section: "writing",
      band: 4,
      raw: 0.6,
      method: "linear-v1",
      // A row persisted without skip tallies carries no skippedCount; its absence reads as "not
      // disclosed".
      coverage,
    });
  });
});
