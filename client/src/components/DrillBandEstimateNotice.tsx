import { Notice } from "../ui/Notice";

// Drills never produce a Band Estimate for Reading or Listening — only a routed Simulation does — and
// a User who expects one must be told so where they would look for it, not left to wonder. One
// component, so the wording is the same on every screen that shows it and a test pins it.
const DRILL_NOTICE = "A Drill doesn't change your Band Estimate. For a band, take a Simulation.";

export default function DrillBandEstimateNotice() {
  return <Notice tone="info">{DRILL_NOTICE}</Notice>;
}
