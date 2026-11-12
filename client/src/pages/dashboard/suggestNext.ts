import type { Section, SetupCapability, SetupPiece, SetupStatusVM } from "@toefl-prep/shared";

/** The four sections in the order the test sits them. Every Dashboard list of sections uses it. */
export const TEST_ORDER: readonly Section[] = ["reading", "listening", "writing", "speaking"];

/**
 * Whether this machine can score a section, read off GET /api/setup-status:
 * - `ready` — everything its scoring needs is known to be present.
 * - `blocked` — `missing` names the pieces known to be absent that turn its scoring off.
 * - `checking` — its scoring is off, but no piece is known to be missing: a CLI's boot-time check
 *   has not answered yet.
 * - `unknown` — there is no setup status to read (it failed to load, or has not yet).
 */
export type Scorability =
  | { state: "ready" }
  | { state: "blocked"; missing: SetupPiece[] }
  | { state: "checking" }
  | { state: "unknown" };

// Reading and Listening are scored on this machine against each Set's key and need nothing. A
// Writing band needs its essays judged; a Speaking band needs its recordings accepted (ffmpeg) and
// judged.
const SCORING_NEEDS: Record<Section, readonly SetupCapability[]> = {
  reading: [],
  listening: [],
  writing: ["writing-scoring"],
  speaking: ["speaking-scoring", "speaking-uploads"],
};

export function sectionScorability(section: Section, status: SetupStatusVM | null): Scorability {
  const needs = SCORING_NEEDS[section];
  if (needs.length === 0) return { state: "ready" };
  if (!status) return { state: "unknown" };
  if (needs.every((capability) => status.capabilities[capability])) return { state: "ready" };
  const missing = status.missing.filter((entry) => entry.disables.some((capability) => needs.includes(capability))).map((entry) => entry.piece);
  return missing.length > 0 ? { state: "blocked", missing } : { state: "checking" };
}

export type Suggestion =
  /** Take this section's Simulation: it has no band yet, or it is the one furthest below its Target. */
  | { kind: "simulation"; section: Section; reason: "no-band" }
  | { kind: "simulation"; section: Section; reason: "below-target"; band: number; target: number }
  /**
   * The run the rule picked cannot be scored on this machine. `missing` names what turns its scoring
   * off; empty means the setup check has not answered yet. `reason` says why this section was picked
   * ("full-test": a Full-Test Run, whose Writing or Speaking this is).
   */
  | { kind: "unavailable"; section: Section; reason: "no-band" | "below-target" | "full-test"; missing: SetupPiece[] }
  /** Every section is at or above its Target: sit the whole test. */
  | { kind: "full-test" };

type SuggestNextInput = {
  /** Each section's headline Band Estimate; a section without one is absent. */
  bands: Partial<Record<Section, number>>;
  targets: Record<Section, number>;
  scorability: Record<Section, Scorability>;
};

/**
 * The Dashboard's one suggested next step.
 *
 * 1. The first section in test order with no Band Estimate: its Simulation.
 * 2. Otherwise the section furthest below its Target, ties to test order: its Simulation.
 * 3. Otherwise (every section at or above its Target): a Full-Test Run.
 *
 * A run is never offered when this machine could not score it: the suggestion then names what is
 * missing for that section instead. A section counts as unscorable only when the setup status says
 * so (`blocked` or `checking`); when there is no setup status to read (`unknown`), the run is
 * offered.
 */
export function suggestNext({ bands, targets, scorability }: SuggestNextInput): Suggestion {
  const blocker = (section: Section): SetupPiece[] | null => {
    const s = scorability[section];
    if (s.state === "blocked") return s.missing;
    if (s.state === "checking") return [];
    return null;
  };

  const unbanded = TEST_ORDER.find((section) => bands[section] === undefined);
  if (unbanded) {
    const missing = blocker(unbanded);
    return missing ? { kind: "unavailable", section: unbanded, reason: "no-band", missing } : { kind: "simulation", section: unbanded, reason: "no-band" };
  }

  let furthest: { section: Section; gap: number } | null = null;
  for (const section of TEST_ORDER) {
    const gap = targets[section] - bands[section]!;
    // Strictly greater, so the earlier section in test order keeps a tie.
    if (gap > 0 && (furthest === null || gap > furthest.gap)) furthest = { section, gap };
  }
  if (furthest) {
    const { section } = furthest;
    const missing = blocker(section);
    return missing
      ? { kind: "unavailable", section, reason: "below-target", missing }
      : { kind: "simulation", section, reason: "below-target", band: bands[section]!, target: targets[section] };
  }

  for (const section of TEST_ORDER) {
    const missing = blocker(section);
    if (missing) return { kind: "unavailable", section, reason: "full-test", missing };
  }
  return { kind: "full-test" };
}
