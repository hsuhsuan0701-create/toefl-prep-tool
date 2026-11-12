import type { Section } from "@toefl-prep/shared";
import { formatBand } from "../../ui/format";
import { SECTION_LABEL } from "../../ui/labels";
import type { Scorability } from "./suggestNext";

// The Dashboard's sentences about a section, in the User's terms. Pure, so the page and its tests
// read the same words.

/** Where each section's Simulation starts. */
export const SIMULATION_HREF: Record<Section, string> = {
  reading: "/simulate/reading",
  listening: "/simulate/listening",
  writing: "/simulate/writing",
  speaking: "/simulate/speaking",
};

/**
 * Why a section has no band, and what gets it one. A Band Estimate needs one Attempt with every Item
 * scored across every Task Type of its section; for Reading and Listening only a Simulation produces
 * one.
 */
export function missingBandText(section: Section, scorability: Scorability): string {
  const base: Record<Section, string> = {
    reading: "Take a Reading Simulation — it is scored the moment you finish. Drills don't produce a band.",
    listening: "Take a Listening Simulation — it is scored the moment you finish. Drills don't produce a band.",
    writing: "Score every Item of one Attempt with Build a Sentence, an Email and an Academic Discussion; a Writing Simulation has all three.",
    speaking: "Score every Item of one Attempt with Listen and Repeat and an Interview; a Speaking Simulation has both.",
  };
  if (scorability.state === "blocked") return `${base[section]} This machine can't score ${SECTION_LABEL[section]} yet — see Setup.`;
  if (scorability.state === "checking") return `${base[section]} Still checking whether this machine can score it.`;
  return base[section];
}

/** "Your last 3 Simulations: 5–6", for the spread under a section's band. */
export function rangeText(range: { min: number; max: number; count: number }): string {
  if (range.count === 1) return "1 Simulation so far";
  const spread = range.min === range.max ? `all ${formatBand(range.min)}` : `${formatBand(range.min)}–${formatBand(range.max)}`;
  return `Your last ${range.count} Simulations: ${spread}`;
}
