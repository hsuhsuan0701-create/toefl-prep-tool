import type Database from "better-sqlite3";
import type { LatestEstimateRow } from "../rows.js";
import { persistedRowToEstimate, type EstimateItemRow, type EstimateStore } from "../../services/sectionEstimates.js";
import type { StatsReadStore } from "../../routes/stats.js";

// ---------------------------------------------------------------------------------------------
// The Band Estimate aggregate, over SQLite
// ---------------------------------------------------------------------------------------------
//
// Table: `section_estimates`, joined to `attempts` for the completion requirement, the repeat
// exclusion, the Simulation preference and the Module Path — properties of the estimate's Attempt
// that decide which estimate is a section's headline.
//
// `getAttempt` is NOT here even though EstimateStore declares it: that read belongs to the Attempt
// aggregate (stores/attempts.ts), which is why this adapter satisfies `Omit<EstimateStore,
// "getAttempt">` and the composition root intersects the two. Every read below does fetch the
// Attempt's current Item rows, narrowed to the four fields the band rule reads, because whether a
// persisted row is still a band is decided from them (sectionEstimates' persistedRowToEstimate).

/** The four item_results fields the band rule reads, for one Attempt. */
function estimateItemRows(db: Database.Database, attemptId: string): EstimateItemRow[] {
  return db.prepare(
    "SELECT task_type, score, scoring_status, score_json FROM item_results WHERE attempt_id=? ORDER BY created_at, rowid"
  ).all(attemptId) as EstimateItemRow[];
}

/**
 * A section's headline Band Estimate: the latest completed, non-Repeat Attempt whose persisted row
 * is a band. Completion is what persists an estimate, so a row on an Attempt in any other state is
 * not a result of it.
 *
 * Order: Simulations before Drills whatever their recency, then latest by COMPLETION time (an
 * Attempt started earlier but finished later is the more recent result), then rowid for exact
 * same-second ties. Rows are walked in that order and the first one that `persistedRowToEstimate`
 * accepts wins — the band rule every other reader applies, run over the Attempt's current Items —
 * so a row written under an older rule for an Attempt with an unscored Item is stepped over rather
 * than surfaced.
 */
export function selectLatestEstimate(db: Database.Database, section: string): LatestEstimateRow | undefined {
  const rows = db.prepare(
    `SELECT se.attempt_id AS attemptId, se.section AS section, se.raw_detail AS rawDetail,
            se.estimated_band AS estimatedBand, se.method AS method,
            a.mode AS mode, a.started_at AS startedAt, a.completed_at AS completedAt,
            a.module_path AS modulePath
     FROM section_estimates se
     JOIN attempts a ON a.id = se.attempt_id
     WHERE se.section = ? AND a.status = 'completed' AND a.is_repeat = 0
     ORDER BY CASE WHEN a.mode = 'simulation' THEN 0 ELSE 1 END, a.completed_at DESC, se.rowid DESC`
  ).iterate(section) as IterableIterator<LatestEstimateRow>;
  // Leaving the loop early closes the statement's iterator.
  for (const row of rows) {
    if (persistedRowToEstimate({ ...row, items: estimateItemRows(db, row.attemptId) })) return row;
  }
  return undefined;
}

/**
 * The bands of a section's most recent completed, non-Repeat Simulations that are bands at all (the
 * same rules as the headline), newest first, at most `limit` of them.
 */
export function selectRecentSimulationBands(db: Database.Database, section: string, limit: number): number[] {
  const rows = db.prepare(
    `SELECT se.attempt_id AS attemptId, se.section AS section, se.raw_detail AS rawDetail,
            se.estimated_band AS estimatedBand, se.method AS method, a.module_path AS modulePath
     FROM section_estimates se
     JOIN attempts a ON a.id = se.attempt_id
     WHERE se.section = ? AND a.status = 'completed' AND a.is_repeat = 0 AND a.mode = 'simulation'
     ORDER BY a.completed_at DESC, se.rowid DESC`
  ).iterate(section) as IterableIterator<{ attemptId: string; section: string; rawDetail: string; estimatedBand: number; method: string; modulePath: "lower" | "upper" | null }>;
  const bands: number[] = [];
  for (const row of rows) {
    if (bands.length >= limit) break;
    const estimate = persistedRowToEstimate({ ...row, items: estimateItemRows(db, row.attemptId) });
    if (estimate) bands.push(estimate.band);
  }
  return bands;
}

export function createSqliteEstimateStore(db: Database.Database) {
  return {
    saveSectionEstimate(e: { attemptId: string; section: string; rawDetail: string; estimatedBand: number; method: string }) {
      db.prepare(
        `INSERT INTO section_estimates (attempt_id, section, raw_detail, estimated_band, method) VALUES (?,?,?,?,?)
         ON CONFLICT(attempt_id, section) DO UPDATE SET raw_detail=excluded.raw_detail, estimated_band=excluded.estimated_band, method=excluded.method`
      ).run(e.attemptId, e.section, e.rawDetail, e.estimatedBand, e.method);
    },
    // An Attempt with no band has no row: recomputeSectionEstimate calls this whenever the Attempt's
    // current state yields no band, so a band written from an earlier state cannot outlive it.
    clearSectionEstimate(attemptId: string) {
      db.prepare("DELETE FROM section_estimates WHERE attempt_id=?").run(attemptId);
    },
    getLatestEstimates(): {
      speaking: LatestEstimateRow | undefined;
      writing: LatestEstimateRow | undefined;
      reading: LatestEstimateRow | undefined;
      listening: LatestEstimateRow | undefined;
    } {
      return {
        speaking: selectLatestEstimate(db, "speaking"),
        writing: selectLatestEstimate(db, "writing"),
        reading: selectLatestEstimate(db, "reading"),
        listening: selectLatestEstimate(db, "listening"),
      };
    },
    recentSimulationBands(section: string, limit: number): number[] {
      return selectRecentSimulationBands(db, section, limit);
    },
    // The estimate persisted for THIS attempt — not the section-wide headline, which excludes
    // Repeats and prefers Simulations: an Attempt review shows whatever band this Attempt got, even
    // when a later Attempt has since become the headline or this one is itself a Repeat. The
    // Attempt's Module Path and current Item rows ride along so the read side checks the band rule
    // against the Modules it took and the Items as they stand now.
    getSectionEstimate(attemptId: string): { section: string; rawDetail: string; estimatedBand: number; method: string; modulePath: "lower" | "upper" | null; items: EstimateItemRow[] } | undefined {
      const row = db.prepare(
        `SELECT se.section, se.raw_detail AS rawDetail, se.estimated_band AS estimatedBand, se.method,
                a.module_path AS modulePath
         FROM section_estimates se LEFT JOIN attempts a ON a.id = se.attempt_id
         WHERE se.attempt_id=? ORDER BY se.rowid DESC LIMIT 1`
      ).get(attemptId) as { section: string; rawDetail: string; estimatedBand: number; method: string; modulePath: "lower" | "upper" | null } | undefined;
      return row && { ...row, items: estimateItemRows(db, attemptId) };
    },
  } satisfies Omit<EstimateStore, "getAttempt"> & Pick<StatsReadStore, "getLatestEstimates" | "recentSimulationBands">;
}
