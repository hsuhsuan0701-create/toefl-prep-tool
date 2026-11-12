import type { CancellationMetadataVM, CancellationReason } from "@toefl-prep/shared";
import { sqliteTimestampToIso } from "./timestamps.js";

// The three cancellation columns every cancellable job row carries, in whatever row type holds them
// — scoring_jobs, generation_jobs and generation_batches all declare the same trio. Structural, not
// a union of the three row types, so a fourth cancellable table needs no edit here.
export interface CancellableRow {
  cancel_requested_at: string | null;
  terminal_at: string | null;
  cancellation_reason: CancellationReason | null;
}

// Builds a job view model's cancellation fields (CancellationMetadataVM) from its row, each timestamp
// converted at the boundary; every job route uses it. Accepts `undefined` because the scoring-job
// cancel handler reads the row back after its write, and an absent row yields all nulls.
export function cancellationMetadata(row: CancellableRow | undefined): Required<CancellationMetadataVM> {
  return {
    cancellationRequestedAt: sqliteTimestampToIso(row?.cancel_requested_at ?? null),
    terminalAt: sqliteTimestampToIso(row?.terminal_at ?? null),
    cancellationReason: row?.cancellation_reason ?? null,
  };
}
