import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useParams } from "react-router-dom";
import { uploadItemAudio } from "../lib/api";
import { useRecorder } from "../hooks/useRecorder";
import { useStageEntry } from "../hooks/useStageEntry";
import { requestErrorMessage } from "../lib/requestError";
import { TASK_TYPES } from "../lib/taskTypes";
import { useDrillShell, useListedSet } from "./drill/drillShell";
import {
  DrillCompletionFailed,
  DrillErrorScreen,
  DrillIntroScreen,
  DrillLoadingScreen,
  DrillPickerScreen,
} from "./drill/DrillScreens";
import { fallbackSetTitle } from "./simulation/simulationShell";
import MicCheck from "../components/MicCheck";
import SpeakingScenarioBriefing from "../components/SpeakingScenarioBriefing";
import InterviewIntro from "../components/InterviewIntro";
import ItemRecorder, { type RunnableItem } from "../components/ItemRecorder";
import { armBeepCue } from "../components/beepCue";
import SceneImage from "../components/SceneImage";
import SpeakingResultSlot from "./speakingDrill/SpeakingResultSlot";
import UploadsSettling from "./speakingDrill/UploadsSettling";
import {
  allSettled,
  snapshotScene,
  type SpeakingSlotSpec,
  type SpeakingTaskKind,
  type UploadEntry,
} from "./speakingDrill/speakingDrillModel";
import { Button } from "../ui/Button";
import { cx } from "../ui/cx";
import { EmptyState } from "../ui/EmptyState";
import { ExamSetLine } from "../ui/ExamIntro";
import { ExamExit, ExamShell } from "../ui/ExamShell";
import { Kicker } from "../ui/Heading";
import { IconArrowLeft } from "../ui/icons";
import { Notice } from "../ui/Notice";

// The Speaking Drill's run body: the mic check, the intro that starts the run, then each Item's
// prompt -> beep -> recording -> countdown, uploaded as soon as it is recorded. A Task is handed to
// scoring the moment every one of its recordings has settled, and its job runs while the Drill
// moves on; the results arrive Task by Task. The shell around the run (loading the Set, the Attempt
// and its Repeat tag, finish-and-navigate) is the shared Drill shell's.
//
// One microphone stream is held for the whole run, from the first Item to the last: opening and
// closing the device per Item engages macOS's deferred Voice Processing teardown, which glitches the
// next Item's prompt about a second in. Every way out releases it.

type Stage = "picker" | "mic-check" | "ready" | "scenario-briefing" | "item-running" | "uploads-settling" | "drill-done";

const TASK_OPTIONS: { label: string; kinds: SpeakingTaskKind[] }[] = [
  { label: TASK_TYPES.listen_repeat.label, kinds: ["listen_repeat"] },
  { label: TASK_TYPES.interview.label, kinds: ["interview"] },
  { label: "Both Task Types", kinds: ["listen_repeat", "interview"] },
];

export default function SpeakingDrill() {
  const { setId } = useParams<{ setId: string }>();
  const recorder = useRecorder();
  const drill = useDrillShell("speaking", setId);
  const listed = useListedSet("speaking", setId);
  const { attemptId, beginAttempt, errorMsg, finish, isRepeat, set, setErrorMsg } = drill;

  const [stage, setStage] = useState<Stage>("picker");
  const [taskQueue, setTaskQueue] = useState<SpeakingTaskKind[]>([]);
  const [queueIndex, setQueueIndex] = useState(0);
  const [completed, setCompleted] = useState<SpeakingSlotSpec[]>([]);
  const [index, setIndex] = useState(0);
  const [introAudioDone, setIntroAudioDone] = useState(true);
  // The current Task's recordings. Reset per Task, so it only ever describes the Task on screen.
  const [uploads, setUploads] = useState<Record<string, UploadEntry>>({});
  // Items anywhere in this Drill whose recording went to background recovery (an Item that later
  // uploads cleanly leaves again). It spans every Task, unlike `uploads`, so the results screen can
  // say how many Items are not scored there and point at the one report that shows them.
  const [recoveryPendingItemIds, setRecoveryPendingItemIds] = useState<Set<string>>(new Set());
  const [rerecordItemId, setRerecordItemId] = useState<string | null>(null);
  // Task Types whose scoring job has not landed yet. Finish waits for these, so the Attempt — and
  // the Band Estimate completing it computes — only completes once nothing is still being scored.
  const [inFlightTasks, setInFlightTasks] = useState<Set<SpeakingTaskKind>>(new Set());

  const transcriptsRef = useRef<Record<string, string>>({});
  const mountedRef = useRef(true);
  // useRecorder() returns a fresh object every render — a ref keeps the unmount cleanup reading the
  // latest stop/release/state without re-running the mount effect on every render.
  const recorderRef = useRef(recorder);
  recorderRef.current = recorder;
  // The current Task's scoring slot is appended at most once per Task; reset when a Task begins.
  const firedRef = useRef(false);
  const startingRef = useRef(false);
  // Both Tasks run in `item-running`, and an Interview opens on its introduction before its first
  // Item, so the Task's place in the queue and the introduction are part of the stage's name.
  useStageEntry(drill.phase === "ready" ? `${stage}:${queueIndex}:${introAudioDone}` : null);

  // Every way out releases the microphone: stop() ends a running take, and release() ends the
  // run-long held stream, which stop() deliberately leaves live between Items.
  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
      if (recorderRef.current.state === "recording") void recorderRef.current.stop();
      recorderRef.current.release();
    };
  }, []);

  // Hold one stream for the run, acquired when the Items begin (the mic check already has
  // permission, so this does not prompt) and reused by every Item. Idempotent on re-entry, so the
  // whole run opens the device once. A failure is swallowed: each Item's start() then opens the
  // microphone for itself and shows its own error.
  useEffect(() => {
    if (stage !== "item-running") return;
    void recorderRef.current.acquire().catch(() => {});
  }, [stage]);

  const currentItems: RunnableItem[] = useMemo(() => {
    if (!set || taskQueue.length === 0) return [];
    return taskQueue[queueIndex] === "listen_repeat" ? set.listenAndRepeat.items : set.interview.questions;
  }, [set, taskQueue, queueIndex]);

  const listenRepeatFocusRegions = useMemo(() => set?.listenAndRepeat.items.map((item) => item.focusRegion) ?? [], [set]);

  const startUpload = useCallback(
    (itemId: string, blob: Blob) => {
      if (!attemptId) return;
      setUploads((prev) => ({ ...prev, [itemId]: { status: "uploading", blob } }));
      void uploadItemAudio(attemptId, itemId, blob).then((outcome) => {
        if (!mountedRef.current) return;
        if (outcome.ok) {
          // A 200 whose body could not be read carries no transcript; the Item is still done.
          if (outcome.data) transcriptsRef.current[itemId] = outcome.data.transcript;
          setUploads((prev) => ({ ...prev, [itemId]: { status: "done", blob } }));
          setRecoveryPendingItemIds((prev) => {
            if (!prev.has(itemId)) return prev;
            const next = new Set(prev);
            next.delete(itemId);
            return next;
          });
        } else if (outcome.kind === "recovery-pending") {
          // Durably accepted: no resend or re-record is offered, since a resend would resolve to
          // the same job. The job stays visible here, and on the Attempt report afterwards.
          setUploads((prev) => ({ ...prev, [itemId]: { status: "recovery-pending", blob, job: outcome.job } }));
          setRecoveryPendingItemIds((prev) => {
            if (prev.has(itemId)) return prev;
            const next = new Set(prev);
            next.add(itemId);
            return next;
          });
        } else {
          setUploads((prev) => ({
            ...prev,
            [itemId]: { status: outcome.kind === "retryable" ? "retryable-failed" : "needs-rerecord-failed", blob },
          }));
        }
      });
    },
    [attemptId],
  );

  const startTask = useCallback((kind: SpeakingTaskKind) => {
    setIndex(0);
    setUploads({});
    setRerecordItemId(null);
    setIntroAudioDone(kind !== "interview");
    firedRef.current = false;
    setStage("item-running");
  }, []);

  const handlePick = useCallback((kinds: SpeakingTaskKind[]) => {
    setTaskQueue(kinds);
    setStage("mic-check");
  }, []);

  const beginDrill = useCallback(async () => {
    if (!setId || taskQueue.length === 0 || startingRef.current) return;
    startingRef.current = true;
    setErrorMsg(null);
    try {
      await beginAttempt();
      // Ignore the response only after a genuine unmount: the User has left this flow.
      if (!mountedRef.current) return;
      setCompleted([]);
      setInFlightTasks(new Set());
      setQueueIndex(0);
      // Reset only here: this list spans every Task of the Drill.
      setRecoveryPendingItemIds(new Set());
      transcriptsRef.current = {};
      if (taskQueue[0] === "listen_repeat") {
        setIndex(0);
        setUploads({});
        setRerecordItemId(null);
        firedRef.current = false;
        setStage("scenario-briefing");
      } else {
        setIntroAudioDone(false);
        setStage("item-running");
      }
    } catch (e) {
      if (!mountedRef.current) return;
      // Not the shell's `fail`, which would replace the page with the error screen: a failed
      // Attempt creation leaves the User on the intro with the message, one click from trying again.
      setErrorMsg(requestErrorMessage(e));
      setStage("ready");
    } finally {
      startingRef.current = false;
    }
  }, [setId, taskQueue, beginAttempt, setErrorMsg]);

  const advanceQueue = useCallback(() => {
    const next = queueIndex + 1;
    if (next < taskQueue.length) {
      setQueueIndex(next);
      startTask(taskQueue[next]);
    } else {
      // Nothing records past this point: stop holding the microphone while results are on screen.
      recorderRef.current.release();
      setStage("drill-done");
    }
  }, [queueIndex, taskQueue, startTask]);

  // The moment every Item of the current Task has settled — transcribed ("done") or durably taken
  // for background recovery — append its slot (which fires its scoring job) and move on. A failed
  // upload or a refused recording still holds the queue: those need the User first.
  //
  // Only transcribed Items go into the scoring request; one taken for recovery is scored later, on
  // its own, and naming it here would make the server refuse the whole request. A Task with no
  // transcribed Item at all gets no slot, since a slot always fires its request when it mounts.
  useEffect(() => {
    if (stage !== "uploads-settling" || firedRef.current) return;
    const kind = taskQueue[queueIndex];
    if (!kind || currentItems.length === 0 || !allSettled(currentItems, uploads)) return;
    firedRef.current = true;
    const scoreableItems = currentItems.filter((it) => uploads[it.id]?.status === "done");
    if (scoreableItems.length > 0) {
      const transcripts: Record<string, string> = {};
      for (const it of scoreableItems) transcripts[it.id] = transcriptsRef.current[it.id] ?? "";
      // Numbered from the whole Task, so an Item left out leaves a gap instead of renumbering.
      const numberByItemId: Record<string, number> = {};
      currentItems.forEach((it, i) => {
        numberByItemId[it.id] = i + 1;
      });
      const scene = kind === "listen_repeat" && set ? snapshotScene(set) : undefined;
      setCompleted((c) => [...c, { kind, items: scoreableItems, transcripts, numberByItemId, scene }]);
    }
    advanceQueue();
  }, [stage, uploads, currentItems, taskQueue, queueIndex, set, advanceQueue]);

  const handleItemFinished = useCallback(
    (blob: Blob) => {
      const item = currentItems[index];
      if (!item) return;
      startUpload(item.id, blob);
      if (index + 1 < currentItems.length) setIndex(index + 1);
      else setStage("uploads-settling");
    },
    [currentItems, index, startUpload],
  );

  const handleRerecordFinished = useCallback(
    (itemId: string, blob: Blob) => {
      startUpload(itemId, blob);
      setRerecordItemId(null);
    },
    [startUpload],
  );

  const handleTaskStatusChange = useCallback((kind: SpeakingTaskKind, inFlight: boolean) => {
    setInFlightTasks((prev) => {
      if (inFlight === prev.has(kind)) return prev;
      const next = new Set(prev);
      if (inFlight) next.add(kind);
      else next.delete(kind);
      return next;
    });
  }, []);

  // When something in this Drill went to background recovery, finishing opens the Attempt report —
  // the only screen that shows those Items — rather than going home.
  const handleFinish = useCallback(
    () => finish(attemptId && recoveryPendingItemIds.size > 0 ? `/attempts/${attemptId}` : "/"),
    [attemptId, finish, recoveryPendingItemIds],
  );

  if (drill.phase === "loading") return <DrillLoadingScreen />;

  // Only a failed Set load reaches this screen: a failed Attempt start stays on the intro
  // (beginDrill), and uploads and scoring are retried where they show.
  if (drill.phase === "error") return <DrillErrorScreen message={drill.errorMsg} retry={null} />;

  if (!set) return null;

  const setTitle = listed?.title ?? fallbackSetTitle("Speaking", set.createdAt);

  if (stage === "picker") {
    return (
      <DrillPickerScreen
        section="Speaking"
        setTitle={setTitle}
        meta={<ExamSetLine source={set.source} createdAt={set.createdAt} setId={set.id} />}
        subtitle="Choose what to practise. You check your microphone first, and each Task is scored as soon as its recordings are sent."
        options={TASK_OPTIONS.map((opt) => ({
          label: opt.label,
          detail:
            opt.kinds.length > 1
              ? "Listen and Repeat, then Interview"
              : opt.kinds[0] === "listen_repeat"
                ? `${set.listenAndRepeat.items.length} Items · repeat each sentence you hear`
                : `${set.interview.questions.length} Items · 45 s to answer each question`,
          onPick: () => handlePick(opt.kinds),
        }))}
      />
    );
  }

  // No Attempt exists before Start, so until then leaving asks nothing.
  const exit = <ExamExit to="/" asks={drill.guarded} />;
  const changeTask = () => {
    if (startingRef.current) return;
    setStage("picker");
  };

  if (stage === "mic-check") {
    return (
      <ExamShell
        section="Speaking"
        part="Drill · Microphone check"
        exit={exit}
        footer={
          <Button variant="quiet" icon={<IconArrowLeft size={16} />} onClick={changeTask}>
            Change Task Type
          </Button>
        }
      >
        <MicCheck onPass={() => setStage("ready")} />
      </ExamShell>
    );
  }

  if (stage === "ready") {
    return (
      <DrillIntroScreen
        section="Speaking"
        part="Drill · Ready"
        heading={taskQueue.length > 1 ? "Both Task Types" : TASK_TYPES[taskQueue[0]].label}
        meta={setTitle}
        backLabel="Change Task Type"
        onBack={changeTask}
        notice={
          <>
            <Notice tone="positive" title="Your microphone works" />
            {errorMsg && (
              <Notice tone="critical" live="assertive" title="The Drill didn't start">
                {errorMsg}
              </Notice>
            )}
          </>
        }
        facts={[
          ...taskQueue.map((kind) => ({
            term: TASK_TYPES[kind].label,
            detail:
              kind === "listen_repeat"
                ? `${set.listenAndRepeat.items.length} sentences. Repeat each one exactly as you hear it.`
                : `${set.interview.questions.length} questions, after a short introduction. Up to 45 s to answer each.`,
          })),
          {
            term: "Recording",
            detail: "Each Item plays once. Recording starts by itself after the tone and stops when the response time is up.",
          },
          {
            term: "Feedback",
            detail: "Each Task is scored as soon as its recordings are sent, while the next one runs.",
          },
        ]}
        onStart={async () => {
          // Create/wake the shared beep context inside this real click, so Safari honors the
          // non-gesture resumes the per-Item beeps need later. Fire-and-forget.
          void armBeepCue();
          await beginDrill();
        }}
      >
        <p className="text-meta text-graphite">The voices you will hear are AI-generated practice voices.</p>
      </DrillIntroScreen>
    );
  }

  const kind = taskQueue[queueIndex];
  const multi = taskQueue.length > 1;
  const part = `Drill · ${TASK_TYPES[kind].label}${multi ? ` · Task ${queueIndex + 1} of ${taskQueue.length}` : ""}`;
  // Earlier Tasks' results, one line each while the Drill runs; in full on the results screen. Each
  // slot starts its scoring job through lib/scoringJobOnce.ts, so drawing it in both places never
  // scores a Task twice.
  const slots = (compact: boolean) =>
    completed.map((c, i) => (
      <SpeakingResultSlot key={i} attemptId={attemptId} spec={c} compact={compact} onStatusChange={handleTaskStatusChange} />
    ));
  const runningStatus = completed.length > 0 && <div className="mb-8 space-y-1">{slots(true)}</div>;

  if (stage === "scenario-briefing") {
    return (
      <ExamShell section="Speaking" part={part} exit={exit}>
        {runningStatus}
        <SpeakingScenarioBriefing
          scenarioTitle={set.listenAndRepeat.scenarioTitle}
          scenarioDescription={set.listenAndRepeat.scenarioDescription}
          introAudio={set.listenAndRepeat.introAudio}
          sceneFile={set.listenAndRepeat.image?.file}
          onComplete={() => setStage("item-running")}
        />
      </ExamShell>
    );
  }

  if (stage === "item-running") {
    const item = currentItems[index];
    const showIntroAudio = kind === "interview" && !introAudioDone;
    const scene = kind === "listen_repeat" ? set.listenAndRepeat.image : undefined;
    return (
      <ExamShell
        section="Speaking"
        part={part}
        exit={exit}
        progress={showIntroAudio ? undefined : { current: index + 1, total: currentItems.length, label: `Item ${index + 1} of ${currentItems.length}` }}
      >
        {runningStatus}
        {showIntroAudio ? (
          <InterviewIntro
            scenarioTitle={set.interview.scenarioTitle}
            intro={set.interview.intro}
            introAudio={set.interview.introAudio}
            onEnded={() => setIntroAudioDone(true)}
          />
        ) : item ? (
          <div className={cx("grid gap-8", scene ? "lg:grid-cols-[minmax(0,1fr)_minmax(0,1fr)] lg:items-center lg:gap-12" : "mx-auto max-w-measure")}>
            {/* The recorder comes first in the reading order, so on a phone it sits above the scene and
                "Recording" is never below the fold; from lg the scene moves to the left column. */}
            <ItemRecorder key={item.id} item={item} recorder={recorder} onFinished={handleItemFinished} />
            {scene && (
              <SceneImage file={scene.file} focusRegions={listenRepeatFocusRegions} currentIndex={index} className="max-sm:max-w-72 lg:order-first" />
            )}
          </div>
        ) : null}
      </ExamShell>
    );
  }

  if (stage === "uploads-settling") {
    return (
      <ExamShell section="Speaking" part={part} exit={exit}>
        {runningStatus}
        <UploadsSettling
          items={currentItems}
          uploads={uploads}
          recorder={recorder}
          rerecordItemId={rerecordItemId}
          onRetryUpload={startUpload}
          onRerecord={setRerecordItemId}
          onRerecordFinished={handleRerecordFinished}
          onCancelRerecord={() => setRerecordItemId(null)}
        />
      </ExamShell>
    );
  }

  // stage === "drill-done"
  const stillScoring = inFlightTasks.size > 0;
  const recoveringCount = recoveryPendingItemIds.size;
  return (
    <ExamShell
      section="Speaking"
      part="Drill · Results"
      // The way out is the finish button, which completes the Attempt.
      exit={null}
      footer={
        <>
          <div className="flex min-w-0 flex-wrap items-center gap-x-4 gap-y-1.5">
            <p className="text-meta text-graphite" role="status">
              {stillScoring ? "Waiting for scoring to finish…" : ""}
            </p>
            <DrillCompletionFailed completion={drill.completion} />
          </div>
          <Button
            variant="primary"
            onClick={handleFinish}
            disabled={stillScoring}
            loading={drill.completion.status === "finishing"}
          >
            {recoveringCount > 0 && attemptId ? "Finish and open the report" : "Back to Practice"}
          </Button>
        </>
      }
    >
      <div className="mx-auto max-w-page space-y-10">
        <header className="space-y-3">
          <div>
            <Kicker as="p">Speaking Drill</Kicker>
            <h1 className="mt-1 font-serif text-title font-semibold text-ink">Results</h1>
          </div>
          {isRepeat && (
            <Notice tone="caution">This Attempt is a Repeat: you have practised this Set before. Repeats are left out of your Band Estimate.</Notice>
          )}
          {/* An Item taken for recovery is not in any result below; say how many, and where they are. */}
          {recoveringCount > 0 && attemptId && (
            <Notice tone="info">
              {recoveringCount === 1
                ? "1 recording was saved but not transcribed in time, so it isn't scored below."
                : `${recoveringCount} recordings were saved but not transcribed in time, so they aren't scored below.`}{" "}
              Transcription keeps retrying in the background, and those Items are scored once it succeeds. Finish to open
              your Attempt report, which follows them.
            </Notice>
          )}
        </header>
        {completed.length === 0 && (
          <EmptyState title="Nothing was scored in this Drill">
            {recoveringCount > 0 ? "Every recording went to background transcription. Your Attempt report shows them." : "No Item was scored."}
          </EmptyState>
        )}
        {slots(false)}
      </div>
    </ExamShell>
  );
}
