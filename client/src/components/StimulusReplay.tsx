import { Disclosure } from "../ui/Disclosure";
import { Kicker } from "../ui/Heading";
import { Prose } from "../ui/Prose";

// A Listening Stimulus heard again once nothing is left to answer about it: in a Drill once its
// Items are scored, in review once the Attempt is complete. While a Stimulus is being answered it
// plays exactly once (StimulusPlayer, behind ListeningStimulusQuestions' gate) and none of this is
// mounted, so a call site renders it only after that point.
//
// A plain labelled <audio controls>, as the review plays back the User's own recording
// (review/SpokenItemReview), so the browser's own play, pause and seek are what the User gets.
// `preload="none"`: nothing is fetched until the User asks to hear it.

export type StimulusReplayProps = {
  /** The Stimulus's audio path as the served Set names it (under `/api/audio/`). */
  audio: string;
  /** What the control is called to a screen reader: which Stimulus this is. */
  label: string;
  /**
   * What was said, behind a Disclosure: a Conversation, an Announcement or an Academic Talk only.
   * Never passed for a Listen and Choose a Response, whose utterance is never shown as text.
   */
  transcript?: string;
};

export default function StimulusReplay({ audio, label, transcript }: StimulusReplayProps) {
  return (
    <div className="min-w-0 space-y-2">
      <Kicker as="p">Listen again</Kicker>
      <audio src={`/api/audio/${audio}`} controls preload="none" aria-label={label} className="w-full max-w-measure" />
      {transcript && (
        <Disclosure summary="Transcript">
          <Prose size="body" preserveLines className="mt-1">
            {transcript}
          </Prose>
        </Disclosure>
      )}
    </div>
  );
}
