import { Kicker } from "../ui/Heading";
import { Prose } from "../ui/Prose";
import StimulusPlayer from "./StimulusPlayer";

export type InterviewIntroProps = {
  scenarioTitle: string;
  intro: string;
  introAudio: string;
  onEnded: () => void;
};

/**
 * The Interview's introduction, shown in print alongside its audio before the first question (ETS's
 * test specifications deliver it "both aurally and in print"). Presentation only: no completion
 * mechanics of its own. Both Speaking screens render it behind their own `introAudioDone` flag and
 * `onEnded` moves them on. It passes no `onError`, so a failed play counts as ended, which the
 * continuous Simulation relies on: the same words are on screen.
 *
 * `intro` is safe to show before scoring: the served Set keeps the Interview's scenario and intro
 * and strips only each question's text, so nothing here can reveal a question.
 */
export default function InterviewIntro({ scenarioTitle, intro, introAudio, onEnded }: InterviewIntroProps) {
  return (
    <section aria-labelledby="interview-title" className="mx-auto max-w-measure space-y-4">
      <Kicker as="p">Interview · introduction</Kicker>
      <h1 id="interview-title" className="text-heading font-semibold text-ink">
        {scenarioTitle}
      </h1>
      <Prose size="stimulus">
        <p>{intro}</p>
      </Prose>
      <p className="text-meta text-graphite">Listen only. Recording starts with the first question.</p>
      <StimulusPlayer key={introAudio} src={`/api/audio/${introAudio}`} onEnded={onEnded} />
    </section>
  );
}
