import { TextLink } from "../../ui/Button";
import { SCORING_NOT_SET_UP } from "../../ui/labels";
import { Notice } from "../../ui/Notice";
import { useSectionScorability } from "./sectionScorability";

// What a Speaking or Writing screen says when the setup status reports that this machine cannot
// score the section: before the run starts (ScoringSetupNotice), and in place of a bare scoring
// failure (ScoringNotSetUpFailure). Both name a capability, not a provider, and point to the
// Dashboard's Setup checklist, which says what is missing.

/** The Dashboard's Setup section (SetupSection's `id`). */
export const SETUP_HREF = "/#setup";

export function SetupLink() {
  return (
    <span className="inline-flex min-h-8 items-center text-ui">
      <TextLink to={SETUP_HREF}>{SCORING_NOT_SET_UP.setupLink}</TextLink>
    </span>
  );
}

/**
 * The caution on the first screens of a Speaking or Writing Drill or Simulation. It never blocks
 * starting: a Response is stored before anything scores it, and once the machine is set up the
 * Attempt's report scores it (Retry transcription for a recording, Re-score for anything else).
 * Renders nothing while scoring is ready, still being checked, or unknown.
 *
 * `buildSentence`: the run includes Build a Sentence, which is scored on this machine against the
 * Set's key and needs no setup, so the notice says it is unaffected.
 */
export function ScoringSetupNotice({ section, buildSentence = false }: { section: "speaking" | "writing"; buildSentence?: boolean }) {
  const scorability = useSectionScorability(section);
  if (scorability.state !== "blocked") return null;
  const responses = section === "speaking" ? "recordings" : "essays";
  return (
    <Notice tone={SCORING_NOT_SET_UP.tone} title={SCORING_NOT_SET_UP.label} action={<SetupLink />}>
      Your {responses} will be saved, but they can't be scored here until Setup is complete. Once it is, you can score them
      from this Attempt's report.{buildSentence ? " Build a Sentence is scored as usual." : ""}
    </Notice>
  );
}

/**
 * What a scoring failure says, in place of the server's bare error, when useScoringNotSetUp reports
 * that this machine cannot score the section. Shown with SetupLink.
 */
export function ScoringNotSetUpFailure() {
  return (
    <p>
      {SCORING_NOT_SET_UP.label}, so this Response couldn't be scored. It is saved, and can be scored once Setup is complete.
    </p>
  );
}
