import { Kicker } from "../../ui/Heading";

/**
 * A spoken Item's prompt, to play again once its run is over: the sentence for Listen and Repeat,
 * the question for Take an Interview. Audio only; the served Set carries no text for either. Its
 * label names the prompt, so it cannot be taken for the User's own recording beside it.
 *
 * Only for a run that is over (a completed Attempt's review, a Drill's results): while an Item is
 * being answered, its prompt plays once, as the run decides.
 */
export function SpokenPromptAudio({ audio, isRepeat, title }: { audio: string; isRepeat: boolean; title: string }) {
  const label = isRepeat ? "The sentence you heard" : "The question you heard";
  return (
    <div className="space-y-1">
      <Kicker as="p">{label}</Kicker>
      <audio src={`/api/audio/${audio}`} controls className="w-full max-w-measure" aria-label={`${label}, ${title}`} />
    </div>
  );
}
