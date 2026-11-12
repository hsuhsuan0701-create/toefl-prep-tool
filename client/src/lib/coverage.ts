import type { SectionEstimateVM } from "@toefl-prep/shared";

// The arithmetic over what a Band Estimate was computed over: the per-Task-Type Item counts a
// SectionEstimateVM carries. The words for one entry are ui/format.ts's coverageText.

// `skippedCount` is optional on the wire (estimate rows persisted before skips were counted carry
// none), and an absent count is not zero: the stored row cannot say. It adds nothing to the total
// here, and coverageText prints the bare count rather than implying "none skipped".
type CoverageEntryVM = SectionEstimateVM["coverage"][number];

/** How many Items across the estimate were skipped, and so scored 0. */
export function totalSkipped(coverage: readonly CoverageEntryVM[]): number {
  return coverage.reduce((sum, entry) => sum + (entry.skippedCount ?? 0), 0);
}
