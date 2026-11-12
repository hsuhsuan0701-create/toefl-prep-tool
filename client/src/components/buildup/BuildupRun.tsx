import { useCallback, useEffect, useRef, useState } from "react";
import { heldWordCount, type BuildupItemVM, type BuildupPhase, type BuildupRepVM } from "@toefl-prep/shared";
import { useRecorder } from "../../hooks/useRecorder";
import { postBuildupRep } from "../../lib/api";
import { Button } from "../../ui/Button";
import { Card } from "../../ui/Card";
import { cx } from "../../ui/cx";
import { formatWhen } from "../../ui/format";
import { Kicker, SectionHeader } from "../../ui/Heading";
import { IconArrowLeft, IconArrowRight, IconCheck, IconChevronRight, IconMic, IconPlay, IconSpinner, IconStop } from "../../ui/icons";
import { Notice } from "../../ui/Notice";
import { RecordingIndicator } from "../../ui/Recording";
import { BuildupDiff } from "./BuildupDiff";

/**
 * One sentence, drilled end to end: a blind baseline, then the backward buildup, then a blind
 * re-test.
 *
 * The order is the method, not a UI convenience. The baseline has to be recorded before the sentence
 * is read, because once it has been read there is no way back to a first-hearing measurement of it,
 * and without that number the re-test at the end compares against nothing. The buildup steps then run
 * with the text visible (they are a reading drill; that is the point), and the closing rep hides it
 * again: the buffer is only trained under the blind condition, so a run that stopped after the
 * steps would have practised articulation and measured nothing.
 */
export default function BuildupRun({ item, onExit }: { item: BuildupItemVM; onExit: () => void }) {
  const [reps, setReps] = useState<BuildupRepVM[]>(item.reps);
  const [stage, setStage] = useState<"baseline" | "steps" | "post">(
    item.reps.some((r) => r.phase === "baseline") ? "steps" : "baseline",
  );

  // One mic acquisition for the whole run: both blind reps (and any re-record within them) record
  // off this held stream instead of opening and closing the device per rep, whose deferred macOS
  // Voice Processing I/O teardown glitches whatever clip plays within the next second or so.
  //
  // Held per run rather than per Drill Lab visit: the glitch only bites where a mic close sits
  // within ~1s of the next playback, which only happens inside a run, and a page-wide hold would keep
  // the recording indicator lit while the User is just browsing. Acquiring on mount also fronts
  // the permission prompt, so a first visit is not interrupted between hearing the one-shot blind
  // clip and repeating it. StrictMode's simulated unmount releases this acquire before the remount
  // asks again; useRecorder never hands the remount that released request, so the hold survives.
  //
  // A failed acquire is swallowed: each rep's start() then acquires per rep and shows its own
  // mic-error state. The unmount cleanup covers every way out, mid-rep included.
  const recorder = useRecorder();
  // useRecorder() returns a fresh object every render; the ref lets the mount effect and its
  // cleanup read the latest callbacks without re-running (and mis-firing release) each render.
  const recorderRef = useRef(recorder);
  recorderRef.current = recorder;
  useEffect(() => {
    void recorderRef.current.acquire().catch(() => {});
    return () => {
      if (recorderRef.current.state === "recording") void recorderRef.current.stop();
      recorderRef.current.release();
    };
  }, []);

  const baseline = lastOfPhase(reps, "baseline");
  const post = lastOfPhase(reps, "post");
  const addRep = useCallback((rep: BuildupRepVM) => setReps((prev) => [...prev, rep]), []);

  return (
    <div className="space-y-10">
      <header className="space-y-3">
        <Button variant="quiet" size="sm" icon={<IconArrowLeft size={14} />} onClick={onExit} className="-ml-3">
          Back to the sentences
        </Button>
        <div className="space-y-1">
          <Kicker as="p">Backward buildup</Kicker>
          <h1 className="font-serif text-title font-semibold text-ink">{item.scenarioTitle}</h1>
          <p className="text-meta text-graphite">
            <span className="font-mono text-caption">
              {item.setId} · {item.itemId}
            </span>{" "}
            · {item.steps.length} buildup steps
            {item.pastScores.length > 0 && <> · past scores {item.pastScores.join(", ")} (estimates)</>}
          </p>
        </div>
      </header>

      <StageNav stage={stage} onStage={setStage} hasBaseline={Boolean(baseline)} />

      {stage === "baseline" && (
        <BlindRep
          key="baseline"
          recorder={recorder}
          item={item}
          phase="baseline"
          title="Step 1: Blind baseline"
          blurb="Don't look at the sentence. Press play, listen once, and repeat it straight away. This take is what the re-test is compared with — skip it and there is nothing to compare."
          rep={baseline}
          onRecorded={addRep}
          nextLabel="Start the backward buildup"
          onNext={() => setStage("steps")}
        />
      )}

      {stage === "steps" && <StepDrill item={item} onDone={() => setStage("post")} />}

      {stage === "post" && (
        <BlindRep
          key="post"
          recorder={recorder}
          item={item}
          phase="post"
          title="Step 3: Blind re-test"
          blurb="The text is hidden again. As before: listen once, repeat once. If you get stuck, don't stop, don't fill with uh, don't go back to fix it — finish the sentence with whatever words you have."
          rep={post}
          onRecorded={addRep}
          comparison={baseline}
        />
      )}

      <RepHistory reps={reps} />
    </div>
  );
}

function lastOfPhase(reps: BuildupRepVM[], phase: BuildupPhase): BuildupRepVM | undefined {
  return [...reps].reverse().find((r) => r.phase === phase);
}

function StageNav({
  stage,
  onStage,
  hasBaseline,
}: {
  stage: "baseline" | "steps" | "post";
  onStage: (s: "baseline" | "steps" | "post") => void;
  hasBaseline: boolean;
}) {
  const stages = [
    { key: "baseline" as const, label: "1. Blind baseline" },
    { key: "steps" as const, label: "2. Backward buildup" },
    { key: "post" as const, label: "3. Blind re-test" },
  ];
  // Jumping between steps is allowed (and re-arms a blind step's one play), except to the re-test
  // before a baseline exists: without one the re-test compares against nothing.
  return (
    <nav aria-label="Buildup steps" className="flex flex-wrap gap-2">
      {stages.map((s) => (
        <button
          key={s.key}
          type="button"
          onClick={() => onStage(s.key)}
          disabled={s.key === "post" && !hasBaseline}
          aria-current={stage === s.key ? "step" : undefined}
          className={cx(
            "min-h-9 rounded-control border px-3 text-ui font-medium transition-colors duration-(--duration-quick) ease-quiet pointer-coarse:min-h-11",
            "disabled:cursor-not-allowed disabled:border-rule disabled:text-faint",
            stage === s.key ? "border-accent bg-accent-wash text-accent" : "border-rule-strong bg-sheet text-ink-soft hover:border-graphite",
          )}
        >
          {s.label}
        </button>
      ))}
    </nav>
  );
}

/**
 * Step 2: walks the buildup steps tail-first, two clean reps each.
 *
 * "Back one step, not back to the start" is enforced by the controls rather than left to the
 * User: restarting from the full sentence re-rehearses the opening (already the strong part) and
 * leaves the tail with the same single rep it had when it collapsed, which is the exact
 * distribution backward buildup exists to invert.
 */
function StepDrill({ item, onDone }: { item: BuildupItemVM; onDone: () => void }) {
  const [index, setIndex] = useState(0);
  const [clean, setClean] = useState(0);
  const step = item.steps[index];
  const isLast = index === item.steps.length - 1;

  if (!step) return null;

  const markClean = () => {
    if (clean + 1 < 2) {
      setClean(clean + 1);
      return;
    }
    if (isLast) {
      onDone();
      return;
    }
    setIndex(index + 1);
    setClean(0);
  };

  const stumble = () => {
    setClean(0);
    if (index > 0) setIndex(index - 1);
  };

  return (
    <section aria-labelledby="buildup-title" className="space-y-5">
      <SectionHeader
        id="buildup-title"
        title="Step 2: Backward buildup"
        description="Say each step out loud and at full speed: slowing down changes how the words link, and trains a different movement. Two clean reps move you on to the next step."
      />

      <Card padding="lg" className="space-y-3">
        <Kicker as="p">
          Step {step.ordinal} of {item.steps.length}
        </Kicker>
        <p className="text-figure-sm leading-snug text-ink">
          <mark className="rounded-chip bg-highlight px-1 text-ink">{step.addedChunk}</mark>
          {step.text.length > step.addedChunk.length && <span className="text-ink-soft"> {step.text.slice(step.addedChunk.length + 1)}</span>}
        </p>
        {step.ordinal > 1 && (
          <p className="text-meta text-graphite">The highlighted part is new in this step. The rest you already know: just join it on.</p>
        )}
      </Card>

      <div className="flex flex-wrap items-center gap-3">
        <Button variant="primary" icon={<IconCheck size={16} />} onClick={markClean}>
          Clean rep ({clean} of 2)
        </Button>
        <Button onClick={stumble}>Stumbled — back one step</Button>
        <Button variant="quiet" iconEnd={<IconArrowRight size={16} />} onClick={onDone} className="sm:ml-auto">
          Skip to the re-test
        </Button>
      </div>

      <ol className="space-y-1.5 text-ui">
        {item.steps.map((s, i) => (
          <li
            key={s.ordinal}
            aria-current={i === index ? "step" : undefined}
            className={cx("flex gap-2", i === index ? "font-medium text-ink" : i < index ? "text-ink-soft" : "text-graphite")}
          >
            <span aria-hidden="true" className="mt-0.5 w-4 shrink-0">
              {i < index ? <IconCheck size={14} /> : i === index ? <IconChevronRight size={14} /> : null}
            </span>
            <span className="sr-only">{i < index ? "Done: " : i === index ? "Current: " : ""}</span>
            {s.text}
          </li>
        ))}
      </ol>
    </section>
  );
}

/** Steps 1 and 3: one blind rep, heard once and repeated with the text hidden. */
function BlindRep({
  recorder,
  item,
  phase,
  title,
  blurb,
  rep,
  comparison,
  onRecorded,
  nextLabel,
  onNext,
}: {
  /** The run-held recorder, owned by BuildupRun so both blind stages record off one
   * mic acquisition; this stage only starts/stops the MediaRecorder on it. */
  recorder: ReturnType<typeof useRecorder>;
  item: BuildupItemVM;
  phase: BuildupPhase;
  title: string;
  blurb: string;
  rep?: BuildupRepVM;
  comparison?: BuildupRepVM;
  onRecorded: (rep: BuildupRepVM) => void;
  /**
   * Advancing is the User's click, never a side effect of the upload resolving: the one thing the
   * baseline is for is seeing where the sentence broke, and an automatic advance would replace that
   * diff with the next stage the instant it arrived.
   */
  nextLabel?: string;
  onNext?: () => void;
}) {
  const [played, setPlayed] = useState(false);
  // The structural overlap gate: with echo cancellation off (useRecorder), recording while any clip
  // is sounding leaks that audio verbatim into the take, so "listen, then record" has to be a state
  // the controls enforce, not a convention. These track the only two audible sources this stage
  // owns (the one-shot stimulus clip and the saved take's player); while either is true the record
  // control is disabled, and while recording the take's player is not rendered at all. The overlap
  // has no representable path, the same property ItemRecorder gets from its phases.
  const [clipAudible, setClipAudible] = useState(false);
  const [takeAudible, setTakeAudible] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<BuildupRepVM | undefined>(rep);
  const audioRef = useRef<HTMLAudioElement | null>(null);
  // Written by a callback ref that ignores unmount's null, so the stage-leave cleanup below can
  // still reach the element: React detaches plain element refs before passive cleanups run.
  const takeAudioRef = useRef<HTMLAudioElement | null>(null);

  // A run that leaves this stage mid-recording must not leave the recorder running, and one that
  // leaves mid-playback must not stay audible into the next stage.
  //
  // stop() ends only the MediaRecorder: the held stream (BuildupRun's) stays live for the
  // other blind stage's rep, and BuildupRun's own unmount is what finally release()s it. The two
  // pause() calls are the cross-stage half of the overlap gate: a detached clip or a removed
  // <audio> keeps sounding by spec, and the next stage's gate state cannot see this stage's
  // sources, so silencing them on the way out is what keeps "nothing is audible while recording"
  // true across a StageNav jump.
  //
  // Through refs with an empty dependency list, not `[recorder]`: useRecorder returns a fresh
  // object literal on every render, so a dependency on it would make this cleanup run on every
  // render and stop the recorder the moment anything else in this component re-rendered, which
  // recording itself does.
  const stopRef = useRef(recorder.stop);
  stopRef.current = recorder.stop;
  useEffect(
    () => () => {
      void stopRef.current().catch(() => {});
      audioRef.current?.pause();
      takeAudioRef.current?.pause();
    },
    [],
  );

  const play = () => {
    setError(null);
    const audio = audioRef.current ?? new Audio(`/api/audio/${item.audio}`);
    audioRef.current = audio;
    // Both ways the clip can stop sounding re-arm the record control; a mid-play failure must not
    // leave it locked behind an `ended` that will never fire.
    audio.onended = () => setClipAudible(false);
    audio.onerror = () => setClipAudible(false);
    audio.currentTime = 0;
    void audio.play().then(
      () => {
        setPlayed(true);
        setClipAudible(true);
      },
      () => setError("The audio didn't play."),
    );
  };

  const record = async () => {
    setError(null);
    try {
      await recorder.start();
    } catch {
      setError(recorder.error ?? "Couldn't open the microphone.");
    }
  };

  const finish = async () => {
    setBusy(true);
    setError(null);
    try {
      const blob = await recorder.stop();
      const saved = await postBuildupRep(item.setId, item.itemId, phase, blob);
      setResult(saved);
      onRecorded(saved);
    } catch {
      setError("This take wasn't saved. Record it again.");
    } finally {
      setBusy(false);
    }
  };

  const recording = recorder.state === "recording";

  return (
    <section aria-label={title} className="space-y-5">
      <SectionHeader title={title} description={blurb} />

      <div className="flex flex-wrap items-center gap-3">
        {/*
          One play, and the control says so. This step measures what survives a single hearing, so a
          replay would make reps incomparable: a baseline heard three times and a re-test heard once
          would have their whole difference put down to the buildup, and nothing records how many
          plays a take had.

          Not a trap: switching step unmounts this stage, so leaving and coming back re-arms the clip,
          an explicit act one click away for a fumbled take.
        */}
        <Button onClick={play} disabled={recording || played} icon={played ? <IconCheck size={16} /> : <IconPlay size={14} />}>
          {played ? "Played" : "Play once"}
        </Button>
        {!recording ? (
          <Button
            variant="primary"
            icon={<IconMic size={16} />}
            onClick={record}
            // The overlap gate's record half: not startable while the stimulus clip or a prior
            // take is still sounding — see clipAudible/takeAudible above.
            disabled={busy || clipAudible || takeAudible}
          >
            Record
          </Button>
        ) : (
          <Button variant="primary" icon={<IconStop size={14} />} onClick={finish}>
            Stop and compare
          </Button>
        )}
        {recording && <RecordingIndicator />}
        {busy && (
          <span role="status" className="inline-flex items-center gap-1.5 text-ui text-graphite">
            <IconSpinner size={14} />
            Transcribing…
          </span>
        )}
      </div>

      {error && (
        <Notice tone="critical" live="polite">
          {error}
        </Notice>
      )}

      {result && (
        <Card className="space-y-4">
          <p className="text-ui text-ink-soft">
            <span className="text-graphite">Target: </span>
            {item.sentence}
          </p>
          <BuildupDiff rep={result} />
          {/*
            The overlap gate's playback half: while recording, the prior take's player does not
            exist, so playback cannot be started mid-recording. The record gate above guarantees
            the take is not sounding at the moment recording starts, so unmounting it here never
            cuts off audible sound.
          */}
          {result.audioPath && !recording && (
            <audio
              controls
              src={`/api/audio/${result.audioPath}`}
              ref={(el) => {
                if (el) takeAudioRef.current = el;
              }}
              onPlay={() => setTakeAudible(true)}
              onPause={() => setTakeAudible(false)}
              onEnded={() => setTakeAudible(false)}
              className="w-full max-w-md"
            />
          )}
          {comparison && <HeldWordsDelta baseline={comparison} current={result} />}
          {nextLabel && onNext && (
            <Button variant="primary" iconEnd={<IconArrowRight size={16} />} onClick={onNext}>
              {nextLabel}
            </Button>
          )}
        </Card>
      )}
    </section>
  );
}

/**
 * The closing rep against the baseline, in words held.
 *
 * Shows a delta only when both sides were measured, and otherwise says which one has no
 * transcript. `heldWordCount` returns null for a rep whose transcription failed; read as a number,
 * a failed transcription would show up as a large gain or loss that the User never made.
 */
function HeldWordsDelta({ baseline, current }: { baseline: BuildupRepVM; current: BuildupRepVM }) {
  const before = heldWordCount(baseline);
  const after = heldWordCount(current);
  if (before === null || after === null) {
    return (
      <p className="text-ui text-graphite">
        {before === null ? "The baseline has no transcript" : "This take has no transcript"}, so it can't be compared with the
        baseline. Record it again.
      </p>
    );
  }
  const delta = after - before;
  const words = (n: number) => `${n} ${n === 1 ? "word" : "words"}`;
  return (
    <p className="text-ui text-ink">
      The baseline held to word {before}; this take held to word {after}:{" "}
      <span className="font-semibold">
        {delta > 0 ? `${words(delta)} later` : delta === 0 ? "no change" : `${words(-delta)} earlier`}
      </span>
      .
    </p>
  );
}

/**
 * Every rep against this sentence, oldest first.
 *
 * Deliberately lists held-words rather than a score: see BreakdownMeter's note in BuildupDiff.tsx.
 * Reps from earlier days are what make the drill legible: one day's numbers are noise, the slope
 * across a week is not.
 */
function RepHistory({ reps }: { reps: BuildupRepVM[] }) {
  // Only measured reps carry a held-words number. An unmeasured rep also has no breakdown index,
  // which would read as clean to the last word: a best-ever result it never had.
  const usable = reps
    .map((rep) => ({ rep, held: heldWordCount(rep) }))
    .filter((entry): entry is { rep: BuildupRepVM; held: number } => entry.held !== null);
  if (usable.length === 0) return null;
  return (
    <section aria-labelledby="rep-history" className="space-y-3 border-t border-rule pt-8">
      <SectionHeader id="rep-history" as="h3" title="Every take of this sentence" description="Where each blind take first slipped, oldest first." />
      <ul className="divide-y divide-rule rounded-sheet border border-rule bg-sheet text-ui">
        {usable.map(({ rep, held }) => (
          <li key={rep.id} className="flex flex-wrap items-baseline gap-x-4 gap-y-0.5 px-4 py-2">
            <span className="w-36 shrink-0 text-meta text-graphite">{formatWhen(rep.createdAt)}</span>
            <span className="w-28 shrink-0 text-meta text-graphite">{rep.phase === "baseline" ? "Blind baseline" : "After buildup"}</span>
            <span className="figures text-ink">
              held to word {held} of {rep.targetWordCount}
            </span>
          </li>
        ))}
      </ul>
    </section>
  );
}
