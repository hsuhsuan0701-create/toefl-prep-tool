import { TextLink } from "../../ui/Button";
import { RECORDINGS_NOT_SAVED, SCORING_NOT_SET_UP } from "../../ui/labels";
import { Notice } from "../../ui/Notice";
import { useSectionScorability, useSpeakingUploadsOff } from "./sectionScorability";

// What a Speaking or Writing screen says when the setup status reports that this machine cannot
// score the section: before the run starts (ScoringSetupNotice), when a scoring job fails now
// (ScoringNotSetUpFailure), and beside a stored failure that a Re-score could clear
// (RescoreNeedsSetup). Each names a capability, not a provider, and points to the Dashboard's Setup
// checklist, which says what is missing.

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
 * The one exception to "stored": with Speaking uploads off, intake refuses every recording at
 * transcode and keeps nothing, so the notice says the run's recordings will not be saved and that
 * nothing from it can be scored, now or later. It still does not block starting.
 *
 * `buildSentence`: the run includes Build a Sentence, which is scored on this machine against the
 * Set's key and needs no setup, so the notice says it is unaffected.
 */
export function ScoringSetupNotice({ section, buildSentence = false }: { section: "speaking" | "writing"; buildSentence?: boolean }) {
  const scorability = useSectionScorability(section);
  const uploadsOff = useSpeakingUploadsOff();
  if (scorability.state !== "blocked") return null;
  if (section === "speaking" && uploadsOff) {
    return (
      <Notice tone={RECORDINGS_NOT_SAVED.tone} title={RECORDINGS_NOT_SAVED.label} action={<SetupLink />}>
        Your recordings won't be saved until Setup is complete, so nothing you record in this run can be scored, now or
        later. Complete Setup before you sit it.
      </Notice>
    );
  }
  const responses = section === "speaking" ? "recordings" : "essays";
  return (
    <Notice tone={SCORING_NOT_SET_UP.tone} title={SCORING_NOT_SET_UP.label} action={<SetupLink />}>
      Your {responses} will be saved, but they can't be scored here until Setup is complete. Once it is, you can score them
      from this Attempt's report.{buildSentence ? " Build a Sentence is scored as usual." : ""}
    </Notice>
  );
}

/**
 * What a scoring job that has just failed says, in place of the server's bare error, when
 * useScoringNotSetUp reports that this machine cannot score the section. Shown with SetupLink and
 * Retry. Only for a job that reached the server and has just failed there (ScoringProgress): one
 * exists only once its Response is stored (an essay before its job, a recording before its
 * transcript), and its failure is today's, so both claims hold. A failure stored earlier keeps its
 * own reason (RescoreNeedsSetup).
 */
export function ScoringNotSetUpFailure() {
  return (
    <p>
      {SCORING_NOT_SET_UP.label}, so this Response couldn't be scored. It is saved, and can be scored once Setup is complete.
    </p>
  );
}

/**
 * Beside a stored scoring failure that a Re-score from this page would retry, when
 * useScoringNotSetUp reports this machine cannot score the section. It speaks of now, not of why the
 * Item failed then: that stays the recorded reason. Shown with SetupLink.
 */
export function RescoreNeedsSetup() {
  return <p>{SCORING_NOT_SET_UP.label}, so a Re-score here can't succeed until Setup is complete.</p>;
}
