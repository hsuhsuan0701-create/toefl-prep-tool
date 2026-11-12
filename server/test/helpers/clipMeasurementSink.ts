import type { ClipMeasurementInsert, ClipTakeDisposition } from "../../src/db/rows.js";
import type { ClipMeasurementSink } from "../../src/services/clipMeasurementLog.js";

/**
 * An in-memory `clip_measurements`.
 *
 * The sink has two operations: a take is inserted as 'discarded', and the one that ships is marked
 * 'published' afterwards. A test that only collects inserted rows sees every take discarded and
 * proves nothing about which one was published. `settled()` applies the marks the way the table
 * would; write an assertion about what shipped against it.
 */
export function collectClipTakes(): {
  rows: ClipMeasurementInsert[];
  sink: ClipMeasurementSink;
  settled: () => (ClipMeasurementInsert & { takeDisposition: ClipTakeDisposition | undefined })[];
  publishedFiles: () => string[];
} {
  const rows: ClipMeasurementInsert[] = [];
  const marked = new Map<string, ClipTakeDisposition>();
  const settled = () =>
    rows.map((row) => ({ ...row, takeDisposition: marked.get(row.id) ?? row.takeDisposition }));
  return {
    rows,
    sink: {
      insert: (row) => {
        rows.push(row);
      },
      markTake: (id, disposition) => {
        marked.set(id, disposition);
      },
    },
    settled,
    publishedFiles: () => settled().filter((r) => r.takeDisposition === "published").map((r) => r.file),
  };
}
