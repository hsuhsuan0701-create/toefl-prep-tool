import {
  FULL_TEST_SECTION_ORDER,
  type FullTestOverallVM,
  type FullTestSection,
  type FullTestSectionBandVM,
  type FullTestSectionState,
  type SectionEstimateVM,
} from "@toefl-prep/shared";
import { meanBand } from "./bandEstimator.js";
import type { EstimateItemRow, SectionBandResult } from "./sectionEstimates.js";
import { liveScoringOutstanding, type LiveScoringFacts } from "./liveScoring.js";

// Pure rules of a Full-Test Run. Nothing here touches the database, the filesystem or the request:
// routes/fullTests.ts supplies the facts and applies the answers, so every rule below is
// unit-testable on its own and the route stays a thin shell over them.

/**
 * Which sections a Run can sit: all four. Kept as data rather than a constant `true` because two
 * surfaces must agree on it, the `runnable` flag on every section view model and checkFullTestLink's
 * refusal to attach an Attempt to a section no Run can sit, so taking a section out stays one edit.
 */
export const RUNNABLE_FULL_TEST_SECTIONS: ReadonlySet<FullTestSection> = new Set<FullTestSection>(
  FULL_TEST_SECTION_ORDER,
);

/**
 * The two `attempts` columns a section's state is derived from, named exactly as SQLite holds them
 * so an `AttemptRow` can be handed straight in.
 */
export type SectionAttemptFacts = { status: string; capture_finished_at?: string | null };

/**
 * A section's state, derived from the Attempt sitting it (or its absence).
 *
 * The Run stores no section state of its own precisely so this stays a function of the Attempt: a
 * client that completes Reading and then dies before telling the Run about it still shows Reading
 * as complete on the next load. An unrecognised status degrades to 'in-progress' rather than
 * throwing — `attempts.status` has a CHECK constraint, so this is defence in depth.
 *
 * `capture_finished_at` is what lets a Run move past Speaking. A Speaking Simulation ends at capture:
 * every recording is uploaded, every score request is fired, and the marker is written, but the
 * Attempt's `status` stays 'in_progress' until server-side reconciliation sees the Judges land,
 * which can be minutes later. The exam does not wait for scoring, so for a Run capture-finished
 * counts as 'completed'. Only a Speaking Simulation ever gets the marker. The band arrives later
 * through its section_estimates row; until then the section reads complete with band status
 * "scoring".
 */
export function fullTestSectionState(attempt: SectionAttemptFacts | null | undefined): FullTestSectionState {
  if (!attempt) return "pending";
  if (attempt.status === "completed") return "completed";
  if (attempt.status === "aborted") return "aborted";
  if (attempt.capture_finished_at) return "completed";
  return "in-progress";
}

/** The facts a section's band status is derived from — all of them reads, none of them writes. */
export type SectionBandFacts = {
  state: FullTestSectionState;
  /** The Attempt sitting the section; undefined before it is created. */
  attempt: LiveScoringFacts["attempt"] & { items: readonly EstimateItemRow[] } | undefined;
  /** The Attempt's queued or running scoring jobs. */
  activeJobs: LiveScoringFacts["activeJobs"];
  /** The current transcription job's status per Item, where there is one. */
  transcriptionStatuses: LiveScoringFacts["transcriptionStatuses"];
  /** The Attempt's persisted Band Estimate, already refused when it fails the band rule. */
  persisted: SectionEstimateVM | null;
  /** The estimate decision over the Attempt's current Items (sectionEstimates.ts). */
  computed: SectionBandResult;
};

/**
 * Where a section's Band Estimate stands (FullTestSectionBandVM), and the estimate to show with it.
 *
 * A finished section reads "scoring" (CONTEXT.md calls it pending) while work that can still score
 * its Attempt is live: a Speaking capture its finalizer has not completed yet, an active scoring
 * job, or a transcription job with work left (liveScoringOutstanding, the rule the Attempt review
 * applies too). A persisted band, such as the one a re-score is about to replace, is withheld until
 * the work settles, because its outcome decides the band.
 *
 * Once settled, the section has its persisted band or it has none. With none, the shortfall comes
 * from the Attempt's current Items — per Task Type, how many failed, are unscored or were never
 * captured, and which Task Types are absent — so the report can say "essay scoring failed", or that
 * recordings were never scored, rather than showing a band from part of the section or promising
 * one nothing is working on.
 */
export function fullTestSectionBand(facts: SectionBandFacts): { bandStatus: FullTestSectionBandVM; estimate: SectionEstimateVM | null } {
  const { attempt } = facts;
  if (facts.state !== "completed" || !attempt) return { bandStatus: { status: "not-finished" }, estimate: null };

  const outstanding = liveScoringOutstanding({ attempt, activeJobs: facts.activeJobs, transcriptionStatuses: facts.transcriptionStatuses });
  if (outstanding) return { bandStatus: { status: "scoring", outstanding }, estimate: null };

  if (facts.persisted) return { bandStatus: { status: "estimated" }, estimate: facts.persisted };

  const shortfall = facts.computed.status === "incomplete" ? facts.computed.shortfall : { unscored: [], absent: [] };
  return { bandStatus: { status: "no-band", ...shortfall }, estimate: null };
}

/** Is this section finished, so the Run is not waiting on it? */
export function isTerminalSectionState(state: FullTestSectionState): boolean {
  return state === "completed" || state === "aborted";
}

/**
 * The one section an in-progress Run lets the User start: the first, in ETS order, whose Attempt has
 * not reached a terminal state. Null once every section is finished.
 *
 * Derived from the four Attempts rather than read off the Run's `current_section` cursor. The cursor
 * moves on a best-effort hand-off POST, and losing one must cost the Run its cursor and nothing
 * else: a rule keyed on the cursor would deadlock the Run, with the finished section locked and the
 * next refused for not being current. POST /advance moves the cursor to this answer too, so
 * whichever advance fires next repairs any number of lost hand-offs at once.
 *
 * An aborted section is skipped rather than offered again: the Run has moved past it, and its
 * Attempt keeps its record.
 */
export function launchableFullTestSection(
  states: Readonly<Record<FullTestSection, FullTestSectionState>>,
): FullTestSection | null {
  return FULL_TEST_SECTION_ORDER.find((section) => !isTerminalSectionState(states[section])) ?? null;
}

/**
 * The versioned rule that turns four section bands into the Run's Overall, named like a section's
 * `linear-v2`/`table3-v1` so the report labels it as an estimate and a future change to the rule
 * (weighting the sections, say) cannot silently reinterpret a number the User has already seen.
 */
export const FULL_TEST_OVERALL_METHOD = "mean-of-sections-v1";

/**
 * The Run's Overall Band Estimate: the mean of the four section bands, rounded to the nearest half
 * band by bandEstimator's `meanBand` (ETS's rule, and the one the Dashboard's Overall uses).
 *
 * Nothing is stored. A Run completes when its Speaking section finishes capture, while the Judges
 * that produce Speaking's band (and possibly Writing's essays) are still running, so the Overall is
 * derived on every read and appears once the last band lands.
 *
 * Fewer than four bands yields `band: null`, never a mean of the sections present: that is a
 * different quantity, not an approximation (ADR 0010). `pendingSections` names what is missing.
 */
export function deriveFullTestOverall(
  sections: readonly { section: FullTestSection; estimate: { band: number } | null }[],
): FullTestOverallVM {
  // Driven by FULL_TEST_SECTION_ORDER rather than by the caller's array, so a section the caller
  // left out reports as pending instead of shortening the mean.
  const bandOf = (section: FullTestSection): number | null =>
    sections.find((s) => s.section === section)?.estimate?.band ?? null;

  const bands = FULL_TEST_SECTION_ORDER.map(bandOf);
  const pendingSections = FULL_TEST_SECTION_ORDER.filter((_, i) => bands[i] === null);
  const scored = bands.filter((band): band is number => band !== null);

  return {
    band: pendingSections.length === 0 ? meanBand(scored) : null,
    method: FULL_TEST_OVERALL_METHOD,
    scoredSections: scored.length,
    pendingSections,
  };
}

export type SelectableSet = { id: string; kind: string };

export type FullTestSetSelection = Record<FullTestSection, string | null>;

/**
 * Draws one Set per section for a new Run, in this priority order per section:
 *
 * 1. An explicit override, when the caller named one. The route validates that it exists and is of
 *    the right kind; this function only honours it.
 * 2. A Set no Run has claimed and no Attempt has sat: the first in `sets` order (the route passes
 *    the bank newest first).
 * 3. Failing that, the least-recently-attempted unclaimed Set, which keeps a Run off the Set the
 *    User sat yesterday when every Set has been sat at some point.
 * 4. Failing even that (every Set of this kind is claimed by some Run), the same rule over all Sets
 *    of the kind: a Set is reused across Runs only once no alternative remains, because a repeat
 *    beats a Run that cannot be sat at all.
 *
 * Each pick joins the claimed set as it is made, so no two sections of one Run draw the same Set.
 *
 * Returns null for a section whose kind has no Sets at all; the route refuses to create a Run
 * missing any of the four.
 */
export function pickFullTestSets(input: {
  sets: readonly SelectableSet[];
  /** setId -> start of its most recent Attempt that counts as a sitting (space-form UTC, so it sorts as text). */
  lastAttemptedAt: ReadonlyMap<string, string>;
  /** Set ids already drawn by any existing Run. */
  claimedSetIds: ReadonlySet<string>;
  overrides?: Partial<Record<FullTestSection, string>>;
}): FullTestSetSelection {
  const claimed = new Set(input.claimedSetIds);
  const out = {} as FullTestSetSelection;

  for (const section of FULL_TEST_SECTION_ORDER) {
    const override = input.overrides?.[section];
    if (override) {
      out[section] = override;
      claimed.add(override);
      continue;
    }

    const ofKind = input.sets.filter((s) => s.kind === section);
    const unclaimed = ofKind.filter((s) => !claimed.has(s.id));
    const pool = unclaimed.length > 0 ? unclaimed : ofKind;

    const unattempted = pool.find((s) => !input.lastAttemptedAt.has(s.id));
    const picked =
      unattempted ??
      // Stable: ties on the timestamp fall back to `pool` order, which is the caller's own ordering.
      pool.reduce<SelectableSet | null>((best, candidate) => {
        if (!best) return candidate;
        const a = input.lastAttemptedAt.get(candidate.id) ?? "";
        const b = input.lastAttemptedAt.get(best.id) ?? "";
        return a < b ? candidate : best;
      }, null);

    out[section] = picked?.id ?? null;
    if (picked) claimed.add(picked.id);
  }

  return out;
}
