import { useCallback, useEffect, useRef, useState } from "react";
import { useRecorder } from "../hooks/useRecorder";
import { Button } from "../ui/Button";
import { IconMic, IconStop } from "../ui/icons";
import { Notice } from "../ui/Notice";
import { RecordingIndicator } from "../ui/Recording";
import StimulusPlayer from "./StimulusPlayer";
import { playBeep } from "./beepCue";
import { classifyMicError, MIC_FIX_STEPS } from "./micTroubleshooting";
import ResponseCountdown from "./ResponseCountdown";

// One Speaking Item's prompt -> beep -> recording -> countdown sequence, shared by the Speaking
// Drill and the Speaking Simulation so the two cannot drift apart.
export type RunnableItem = { id: string; audio: string; responseWindowSec: number };

type RecorderApi = ReturnType<typeof useRecorder>;
type ItemPhase = "stimulus" | "stimulus-error" | "beep" | "recording" | "mic-error";

/**
 * Runs one Item end to end: play its audio prompt once, beep, start the shared `recorder`, show the
 * countdown, then hand over the take through `onFinished` when the time runs out or the User stops
 * early. The caller keys it by Item id, so the next Item gets fresh local state.
 *
 * A prompt that fails to load or play never leads into the beep: recording over a prompt nobody
 * heard would score the User for the app's failure. It is retried `stimulusAutoRetries` times on a
 * fresh audio element, then the Item stops on a gate with a Retry button (and `onStimulusGate`
 * fires, for a caller that records the interruption). No clock runs while the gate is up: the
 * response window only starts after the beep.
 *
 * If the microphone goes away mid-take, what was recorded so far is handed over through
 * `onFinished` as the Item's Response. If the microphone cannot start at all, the User can try
 * again, or, where the caller passes `onSkip` (a Simulation, which cannot stop for long), skip the
 * Item instead of being held there.
 */
export default function ItemRecorder({
  item,
  recorder,
  onFinished,
  stimulusAutoRetries = 0,
  onStimulusGate,
  onSkip,
}: {
  item: RunnableItem;
  recorder: RecorderApi;
  onFinished: (blob: Blob) => void;
  stimulusAutoRetries?: number;
  onStimulusGate?: () => void;
  onSkip?: () => void;
}) {
  const [phase, setPhase] = useState<ItemPhase>("stimulus");
  // Keys the StimulusPlayer: each retry mounts a fresh one, which is a fresh load of the clip.
  const [stimulusTry, setStimulusTry] = useState(0);
  const autoRetriesUsedRef = useRef(0);
  const finishedRef = useRef(false);
  const mountedRef = useRef(true);
  const onFinishedRef = useRef(onFinished);
  onFinishedRef.current = onFinished;
  const onStimulusGateRef = useRef(onStimulusGate);
  onStimulusGateRef.current = onStimulusGate;
  // `recorder` is a fresh object every parent render; a ref keeps the unmount cleanup below reading
  // the latest start, stop and state.
  const recorderRef = useRef(recorder);
  recorderRef.current = recorder;

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
      // This component can unmount mid-recording (the Drill swapping which Item is being re-recorded,
      // the User leaving). The parent shares one recorder across Items, so a take left running here
      // would be captured into the next Item's upload. On the normal advance the recorder is already
      // inactive and this is a no-op.
      if (recorderRef.current.state === "recording") void recorderRef.current.stop();
    };
  }, []);

  const beginRecording = useCallback(() => {
    setPhase("beep");
    void playBeep().then(async () => {
      if (!mountedRef.current) return;
      try {
        await recorder.start();
      } catch {
        if (mountedRef.current) setPhase("mic-error");
        return;
      }
      if (mountedRef.current) setPhase("recording");
    });
  }, [recorder]);

  const finish = useCallback(() => {
    if (finishedRef.current) return;
    finishedRef.current = true;
    void recorder.stop().then((blob) => {
      onFinishedRef.current(blob);
    });
  }, [recorder]);

  // The microphone went away under a running take: hand over what it captured.
  useEffect(() => {
    if (phase === "recording" && recorder.state === "error") finish();
  }, [phase, recorder.state, finish]);

  const handleStimulusError = useCallback(() => {
    if (!mountedRef.current) return;
    if (autoRetriesUsedRef.current < stimulusAutoRetries) {
      autoRetriesUsedRef.current += 1;
      setStimulusTry((n) => n + 1);
      return;
    }
    setPhase("stimulus-error");
    onStimulusGateRef.current?.();
  }, [stimulusAutoRetries]);

  const retryStimulus = useCallback(() => {
    setStimulusTry((n) => n + 1);
    setPhase("stimulus");
  }, []);

  // Said once per phase, politely, for a screen reader: what is about to happen and what to do. The
  // prompt's own "Listen…" comes from StimulusPlayer, and both failure gates are Notices that
  // announce themselves, so neither is repeated here. The countdown is deliberately silent.
  const announcement =
    phase === "beep"
      ? "Get ready. Recording starts after the tone."
      : phase === "recording"
        ? `Recording. Speak now. You have ${item.responseWindowSec} seconds.`
        : "";

  const skipButton = onSkip && (
    <Button size="sm" onClick={onSkip}>
      Skip this Item
    </Button>
  );
  // Only a Simulation passes `onSkip`. There the skipped Item is recorded as never captured, the
  // app's failure rather than the User's miss, and an Attempt with a never-captured Item has no Band
  // Estimate (CONTEXT.md, Band Estimate).
  const skipNote = onSkip && (
    <p className="mt-1">Skipping is not counted as your miss, but without a Response for this Item the Attempt gets no Band Estimate.</p>
  );
  const micProblem = classifyMicError(recorder.error);

  return (
    <div className="rounded-sheet border border-rule bg-sheet p-5 sm:p-6">
      {phase === "stimulus" && (
        <StimulusPlayer
          key={`stimulus-${stimulusTry}`}
          src={`/api/audio/${item.audio}`}
          onEnded={beginRecording}
          onError={handleStimulusError}
        />
      )}

      {phase === "stimulus-error" && (
        // Not the User's fault, so caution rather than critical: the app could not play the prompt.
        <Notice
          tone="caution"
          live="polite"
          title="Couldn't play the audio prompt for this Item."
          action={
            <>
              <Button variant="primary" size="sm" onClick={retryStimulus}>
                Retry
              </Button>
              {skipButton}
            </>
          }
        >
          <p>Nothing has been recorded, and no time runs until it plays.</p>
          {skipNote}
        </Notice>
      )}

      {phase === "beep" && (
        <div className="flex flex-col items-center gap-2 py-8 text-center">
          <IconMic size={20} className="shrink-0 text-graphite" />
          <p className="text-body font-medium text-ink">Get ready</p>
          <p className="text-meta text-graphite">Recording starts after the tone.</p>
        </div>
      )}

      {phase === "recording" && (
        <div className="space-y-5 py-2">
          <div className="flex flex-wrap items-center justify-between gap-3">
            <RecordingIndicator />
            <Button size="sm" icon={<IconStop size={14} />} onClick={finish}>
              Stop recording
            </Button>
          </div>
          <ResponseCountdown seconds={item.responseWindowSec} onExpire={finish} />
          <p className="text-meta text-graphite">Speak now. Recording stops by itself when the time is up.</p>
        </div>
      )}

      {phase === "mic-error" && (
        <Notice
          tone="critical"
          live="assertive"
          title="The microphone isn't recording"
          action={
            <>
              <Button variant="primary" size="sm" onClick={beginRecording}>
                Try again
              </Button>
              {skipButton}
            </>
          }
        >
          <p>{recorder.error ?? "Couldn't start recording."}</p>
          <ul className="mt-1.5 list-disc space-y-0.5 pl-5">
            {MIC_FIX_STEPS[micProblem].map((step) => (
              <li key={step}>{step}</li>
            ))}
          </ul>
          {skipNote}
        </Notice>
      )}

      <p aria-live="polite" className="sr-only">
        {announcement}
      </p>
    </div>
  );
}
