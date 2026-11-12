// Every advisory note reaches a Set through `recordAdvisoryNotes`: at mint time, in both content
// gates' finishing step and in both audio renderers. It is therefore the one place that holds the
// cap, the truncation warning and the omit-rather-than-empty rule.
//
// The `advisory` tier (docs/adr/0006) promises an issue is recorded and never blocks. The Set schema
// rejects more than `MAX_SET_ADVISORY_NOTES` notes and the Set is parsed again when it is
// published, so a producer that appended past the cap would fail a fully paid run at its last step
// over a diagnostic. Producers mint notes (a novelty residual, a Build a Sentence conformance
// finding, a content-gate violation, an off-pace clip) and know nothing about the cap.

import { MAX_SET_ADVISORY_NOTES, type SetAdvisoryNote } from "@toefl-prep/shared";

/**
 * The one field this module reads, on a Set of any kind or on the candidate on its way into
 * `AnySetSchema.parse`. Structural rather than `AnySet` so the ledger stays a leaf module.
 */
export interface AdvisoryNoteCarrier {
  readonly advisoryNotes?: readonly SetAdvisoryNote[];
}

/**
 * Appends `notes` to whatever `carrier` already records and returns a carrier the Set schema
 * accepts:
 *
 *  - **Capped** at `MAX_SET_ADVISORY_NOTES`, the number the schema rejects past. The tail is
 *    dropped, never the Set, and the earliest findings (from the stages that ran first) survive.
 *  - **Reported.** A truncation is logged with `source` (a server-authored producer label) and the
 *    real count.
 *  - **Omitted rather than empty.** With no notes, the field is removed, so a Set with no findings
 *    looks like one published before notes existed; the client and the Set listing treat the field
 *    as absent, never empty.
 *
 * The constraint is `object` rather than `AdvisoryNoteCarrier` because that interface is a weak type
 * (every property optional): TypeScript rejects an argument sharing none of its properties, and the
 * mint-time candidate has no `advisoryNotes` until this call gives it one.
 */
export function recordAdvisoryNotes<S extends object>(
  carrier: S,
  notes: readonly SetAdvisoryNote[],
  source: string,
): S {
  const merged = [...((carrier as AdvisoryNoteCarrier).advisoryNotes ?? []), ...notes];
  if (merged.length === 0) return withoutAdvisoryNotes(carrier);
  const kept = merged.slice(0, MAX_SET_ADVISORY_NOTES);
  if (merged.length > kept.length) {
    console.warn(
      `[setAdvisoryLedger] ${source} carries ${merged.length} advisory notes; recording the first ${MAX_SET_ADVISORY_NOTES}`,
    );
  }
  // TypeScript cannot prove that a spread of `S` with `advisoryNotes` added is still an `S`.
  return { ...carrier, advisoryNotes: kept } as S;
}

function withoutAdvisoryNotes<S extends object>(carrier: S): S {
  if (!("advisoryNotes" in carrier)) return carrier;
  const { advisoryNotes: _dropped, ...rest } = carrier;
  return rest as S;
}
