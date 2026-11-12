import { useEffect, useRef, useState } from "react";
import { useRecorder } from "../hooks/useRecorder";
import { useStageEntry } from "../hooks/useStageEntry";
import { Button } from "../ui/Button";
import { IconCheck, IconMic, IconRepeat, IconSpinner } from "../ui/icons";
import { Notice } from "../ui/Notice";
import { LEVEL_SPEECH_THRESHOLD, LevelMeter, RecordingIndicator } from "../ui/Recording";
import { classifyMicError, MIC_FIX_STEPS } from "./micTroubleshooting";

type MicCheckProps = { onPass: () => void };

type Stage = "idle" | "requesting" | "recording" | "reviewing" | "error";

const TEST_RECORD_MS = 2000;

/**
 * The gate before every Speaking Drill and Simulation: ask for the microphone, record a 2-second
 * test clip while a live level meter shows what the microphone hears, play it back, and pass only
 * when the User says it works. Each way it can fail says what to do about it, and the User can
 * always record again.
 *
 * It holds the microphone only while it is recording, and lets go of it when it unmounts.
 */
export default function MicCheck({ onPass }: MicCheckProps) {
  const recorder = useRecorder();
  const { start, stop, state, error, stream } = recorder;
  // Leaving mid-check must not leave the microphone on: stop() ends the test take, and in this
  // self-acquiring mode that also ends the tracks. release() covers a stream still being opened: a
  // start() whose permission prompt is answered after this cleanup sees the release, ends the new
  // tracks and records nothing.
  const recorderRef = useRef(recorder);
  recorderRef.current = recorder;
  useEffect(() => {
    return () => {
      if (recorderRef.current.state === "recording") void recorderRef.current.stop();
      recorderRef.current.release();
    };
  }, []);
  const [stage, setStage] = useState<Stage>("idle");
  const [level, setLevel] = useState(0);
  // The loudest level the test clip reached: a clip that never rose above it was silence, and
  // playing back silence is not a test of anything.
  const [peak, setPeak] = useState(0);
  const [audioUrl, setAudioUrl] = useState<string | null>(null);
  // Each step replaces the button that started it, so focus goes back to the check's heading
  // rather than the page body; the step is already in view, so the page does not move.
  const headingRef = useRef<HTMLHeadingElement>(null);
  useStageEntry(stage, { scroll: false, focusTarget: headingRef });

  const rafRef = useRef<number | null>(null);
  const stopTimerRef = useRef<number | null>(null);
  const audioUrlRef = useRef<string | null>(null);

  useEffect(() => {
    if (state === "error") setStage("error");
  }, [state]);

  // Once the hook has a live stream (permission granted, recording under way), wire a Web Audio
  // AnalyserNode to it for the RMS level meter, and stop the take after the test window.
  useEffect(() => {
    if (state !== "recording" || !stream) return;
    setStage("recording");
    setPeak(0);

    const AudioContextCtor = window.AudioContext ?? (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
    let teardownMeter = () => {};
    if (AudioContextCtor) {
      const ctx = new AudioContextCtor();
      const source = ctx.createMediaStreamSource(stream);
      const analyser = ctx.createAnalyser();
      analyser.fftSize = 1024;
      source.connect(analyser);
      const data = new Uint8Array(analyser.frequencyBinCount);
      const tick = () => {
        analyser.getByteTimeDomainData(data);
        let sumSquares = 0;
        for (let i = 0; i < data.length; i++) {
          const centered = (data[i] - 128) / 128;
          sumSquares += centered * centered;
        }
        const next = Math.min(1, Math.sqrt(sumSquares / data.length) * 4);
        setLevel(next);
        setPeak((p) => Math.max(p, next));
        rafRef.current = requestAnimationFrame(tick);
      };
      tick();
      teardownMeter = () => {
        source.disconnect();
        analyser.disconnect();
        void ctx.close();
      };
    }

    stopTimerRef.current = window.setTimeout(() => {
      void stop().then((blob) => {
        if (audioUrlRef.current) URL.revokeObjectURL(audioUrlRef.current);
        const url = URL.createObjectURL(blob);
        audioUrlRef.current = url;
        setAudioUrl(url);
        setStage("reviewing");
      });
    }, TEST_RECORD_MS);

    return () => {
      if (rafRef.current !== null) cancelAnimationFrame(rafRef.current);
      if (stopTimerRef.current !== null) window.clearTimeout(stopTimerRef.current);
      rafRef.current = null;
      stopTimerRef.current = null;
      teardownMeter();
      setLevel(0);
    };
  }, [state, stream, stop]);

  useEffect(() => {
    return () => {
      if (audioUrlRef.current) URL.revokeObjectURL(audioUrlRef.current);
    };
  }, []);

  const handleStart = () => {
    setStage("requesting");
    // Set the stage from the rejection itself, not from the [state] effect above: on a second
    // consecutive failure `state` is already "error", React bails out of the identical update and
    // the effect never re-runs, which would leave the screen on "requesting" with no way forward.
    start().catch(() => setStage("error"));
  };

  const problem = classifyMicError(error);
  const heardNothing = stage === "reviewing" && peak < LEVEL_SPEECH_THRESHOLD;

  return (
    <section aria-labelledby="mic-check-title" className="mx-auto max-w-lg space-y-5 rounded-sheet border border-rule bg-sheet p-5 sm:p-6">
      <div className="space-y-1.5">
        <h1 ref={headingRef} id="mic-check-title" tabIndex={-1} className="flex items-center gap-2 rounded-chip text-heading font-semibold text-ink">
          <IconMic size={18} className="shrink-0 text-graphite" />
          Microphone check
        </h1>
        <p className="text-ui text-ink-soft">
          Record a 2-second test clip, then play it back. Use the microphone and the room you will answer in.
        </p>
      </div>

      {stage === "idle" && (
        <Button variant="primary" block icon={<IconMic size={16} />} onClick={handleStart}>
          Start mic check
        </Button>
      )}

      {stage === "requesting" && (
        <p role="status" className="flex items-center gap-2 text-ui text-ink-soft">
          <IconSpinner size={16} />
          Requesting microphone permission. Allow it in the browser's prompt.
        </p>
      )}

      {stage === "recording" && (
        <div className="space-y-3">
          <p role="status">
            <RecordingIndicator label="Recording — say a sentence or two" />
          </p>
          <LevelMeter level={level} />
        </div>
      )}

      {stage === "reviewing" && audioUrl && (
        <div className="space-y-4">
          <p className="text-ui text-ink">Play back your test clip. Does it sound clear?</p>
          <audio src={audioUrl} controls className="w-full" />
          {heardNothing && (
            <Notice tone="caution" live="polite" title="That clip was very quiet">
              Check that the right microphone is selected and not muted, move closer to it, then record again.
            </Notice>
          )}
          <div className="flex flex-col-reverse gap-2 sm:flex-row sm:justify-end">
            <Button icon={<IconRepeat size={16} />} onClick={handleStart}>
              Record again
            </Button>
            <Button variant="primary" icon={<IconCheck size={16} />} onClick={onPass}>
              It works
            </Button>
          </div>
        </div>
      )}

      {stage === "error" && (
        <div className="space-y-4">
          <Notice tone="critical" live="assertive" title="The microphone didn't start">
            <p>{error}</p>
            <ul className="mt-1.5 list-disc space-y-0.5 pl-5">
              {MIC_FIX_STEPS[problem].map((step) => (
                <li key={step}>{step}</li>
              ))}
            </ul>
          </Notice>
          <Button variant="primary" block onClick={handleStart}>
            Try again
          </Button>
        </div>
      )}
    </section>
  );
}
