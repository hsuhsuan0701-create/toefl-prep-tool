import { useEffect, useRef, useState } from "react";
import { cx } from "../ui/cx";
import { Kicker } from "../ui/Heading";
import { Prose } from "../ui/Prose";
import SceneImage from "./SceneImage";
import StimulusPlayer from "./StimulusPlayer";

export type SpeakingScenarioBriefingProps = {
  scenarioTitle: string;
  scenarioDescription: string;
  introAudio?: string;
  sceneFile?: string;
  onComplete: () => void;
};

// How long the scenario's text stands alone when there is no introduction to hear: a Set banked
// without intro audio, or an intro that would not play.
const TEXT_ONLY_BRIEFING_MS = 2000;

/**
 * The Listen and Repeat scenario, heard once before its first Item: the scene, its title and its
 * description in print, and the introduction playing. Listen-only — it owns no recording or timing
 * mechanics. A Set banked without intro audio shows the text for two seconds and moves on; an intro
 * that fails to play does the same, since the same words are on screen.
 */
export default function SpeakingScenarioBriefing({
  scenarioTitle,
  scenarioDescription,
  introAudio,
  sceneFile,
  onComplete,
}: SpeakingScenarioBriefingProps) {
  const finishedRef = useRef(false);
  const onCompleteRef = useRef(onComplete);
  const fallbackTimerRef = useRef<number | null>(null);
  const [showPlayer, setShowPlayer] = useState(Boolean(introAudio));

  onCompleteRef.current = onComplete;

  useEffect(() => {
    return () => {
      if (fallbackTimerRef.current !== null) window.clearTimeout(fallbackTimerRef.current);
    };
  }, []);

  useEffect(() => {
    if (introAudio) return;
    fallbackTimerRef.current = window.setTimeout(finish, TEXT_ONLY_BRIEFING_MS);
    return () => {
      if (fallbackTimerRef.current !== null) window.clearTimeout(fallbackTimerRef.current);
      fallbackTimerRef.current = null;
    };
  }, [introAudio]);

  const finish = () => {
    if (finishedRef.current) return;
    finishedRef.current = true;
    onCompleteRef.current();
  };

  const handleError = () => {
    setShowPlayer(false);
    fallbackTimerRef.current = window.setTimeout(finish, TEXT_ONLY_BRIEFING_MS);
  };

  return (
    <div className={cx("grid gap-8", sceneFile && "lg:grid-cols-[minmax(0,1fr)_minmax(0,1fr)] lg:items-center lg:gap-12")}>
      <section aria-labelledby="scenario-title" className={cx("min-w-0 space-y-4", !sceneFile && "mx-auto max-w-measure")}>
        <Kicker as="p">Listen and Repeat · the scene</Kicker>
        <h1 id="scenario-title" className="text-heading font-semibold text-ink">
          {scenarioTitle}
        </h1>
        <Prose size="stimulus">
          <p>{scenarioDescription}</p>
        </Prose>
        <p className="text-meta text-graphite">Listen only. Nothing is recorded during this part.</p>
        {introAudio && showPlayer && (
          <StimulusPlayer key={introAudio} src={`/api/audio/${introAudio}`} onEnded={finish} onError={handleError} />
        )}
      </section>
      {/* After the text in the reading order (a phone shows what to listen for first); from lg the
          scene moves to the left column. */}
      {sceneFile && <SceneImage file={sceneFile} focusRegions={[]} currentIndex={-1} className="max-sm:max-w-72 lg:order-first" />}
    </div>
  );
}
