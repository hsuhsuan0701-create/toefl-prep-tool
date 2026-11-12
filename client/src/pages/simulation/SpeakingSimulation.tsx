import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { expectServedSet, type ServedSpeakingSet } from "@toefl-prep/shared";
import { HttpError, createAttempt, flagAttempt, getSet, scoreTask, uploadItemAudio, type SetMeta } from "../../lib/api";
import { requestErrorMessage } from "../../lib/requestError";
import { retryWithinBudget } from "../../lib/captureRetry";
import { TASK_TYPES } from "../../lib/taskTypes";
import { lostUploadItemIds, uploadUntilSectionEnds, type SimUploadOutcome } from "../simulationUpload";
import { useRecorder } from "../../hooks/useRecorder";
import { useLeaveGuard } from "../../hooks/useLeaveGuard";
import MicCheck from "../../components/MicCheck";
import SpeakingScenarioBriefing from "../../components/SpeakingScenarioBriefing";
import InterviewIntro from "../../components/InterviewIntro";
import SceneImage from "../../components/SceneImage";
import ItemRecorder, { type RunnableItem } from "../../components/ItemRecorder";
import { armBeepCue } from "../../components/beepCue";
import { Button } from "../../ui/Button";
import { cx } from "../../ui/cx";
import { ExamIntro, ExamSetLine } from "../../ui/ExamIntro";
import { ExamExit, ExamShell } from "../../ui/ExamShell";
import { IconArrowLeft, IconArrowRight } from "../../ui/icons";
import { Notice } from "../../ui/Notice";
import { ProgressBar } from "../../ui/Progress";
import { CompletionFailed, LoadingMain, ErrorMain, SimulationStatus } from "./SimulationScreens";
import {
  FINISH_SEQUENCE_GUARD_MS,
  SPEAKING_FINISHING_TIMEOUT_MS,
  advanceFullTestSection,
  fallbackSetTitle,
  findListedSet,
  leaveRestartsSectionMessage,
  markSpeakingCaptureFinished,
  pickSimulationSet,
  predictRepeat,
  repeatNoticeText,
  sleep,
  useFlagOnHidden,
  withTimeout,
  type FullTestSectionContext,
} from "./simulationShell";
import { useFinishingSequence } from "./finishingSequence";

// ---------------------------------------------------------------------------
// Speaking Simulation: scenario -> 7 Listen and Repeat Items -> interview intro -> 4 questions,
// continuous once the mic check passes, on one held microphone stream.
//
// Uploads are never awaited before advancing — the next Item starts straight away — and a recording
// the server cannot take yet is kept and retried until the section is over (simulationUpload.ts).
// Each Task Type's one score request fires once all of its own uploads have settled: Listen and
// Repeat's at the L&R -> interview transition (it then runs server-side during the interview), the
// interview's at section end. One request per Task Type matters: a second would supersede (cancel)
// the first job on the server.
//
// The wrap-up waits for every upload and both score requests, then sends POST
// /:id/capture-finished once, naming the Items whose recordings never reached the server. The
// server's own reconciliation completes the Attempt when judging lands; AttemptReview renders that
// live. A marker that still cannot be written after its retries stops the section on a screen that
// says so, with Retry: without it the Attempt never completes, so the section neither hands off
// nor advances a Full-Test Run.
// ---------------------------------------------------------------------------

type SpeakingSimStage =
  | "loading"
  | "error"
  | "intro"
  | "mic-check"
  | "ready"
  | "scenario-briefing"
  | "item-running"
  | "finishing"
  | "completion-failed";
type SpeakingTaskType = "listen_repeat" | "interview";

// How many times an Item's prompt is reloaded on its own before the Item stops on a Retry gate.
const STIMULUS_AUTO_RETRIES = 2;
// How long one score request may take before it is given up and sent again.
const SCORE_REQUEST_TIMEOUT_MS = 15_000;

/**
 * How a Speaking Attempt whose section could not be closed is finished later. Finish and score
 * closes it without naming the Items whose recordings never reached the server, so the server
 * counts those as skips scored 0; only this page's Retry keeps them marked as never received. The
 * advice says so whenever there is such an Item.
 */
function finishLaterText(unsentCount: number): string {
  if (unsentCount === 0) return "Finish and score, on the Progress page, finishes it later.";
  const items = unsentCount === 1 ? "the Item with no recording" : `the ${unsentCount} Items with no recording`;
  return `Retry closes it with ${items} marked as never received. Finish and score, on the Progress page, would count ${unsentCount === 1 ? "it" : "them"} as skipped and score ${unsentCount === 1 ? "it" : "them"} 0.`;
}

/** Resolves once the last Item has been recorded (or the page is left): see uploadUntilSectionEnds. */
function newSectionEnd(): { ended: Promise<void>; end: () => void } {
  let end!: () => void;
  const ended = new Promise<void>((resolve) => {
    end = resolve;
  });
  return { ended, end };
}

export default function SpeakingSimulation({ fullTest }: { fullTest?: FullTestSectionContext }) {
  const recorder = useRecorder();
  // Read out once so the hooks below depend on primitives, not an object the caller re-creates.
  const fullTestRunId = fullTest?.runId;
  const fullTestSetId = fullTest?.setId;
  const fullTestAttemptId = fullTest?.attemptId;

  const [stage, setStage] = useState<SpeakingSimStage>("loading");
  const [set, setSet] = useState<ServedSpeakingSet | null>(null);
  const [errorMsg, setErrorMsg] = useState<string | null>(null);
  const [attemptId, setAttemptId] = useState<string | null>(null);
  const [taskIndex, setTaskIndex] = useState<0 | 1>(0); // 0 = listen_repeat, 1 = interview
  const [itemIndex, setItemIndex] = useState(0);
  const [introAudioDone, setIntroAudioDone] = useState(true);
  const [isStarting, setIsStarting] = useState(false);
  // The Set as the bank lists it, for its title and whether it has been attempted (a Repeat).
  const [listing, setListing] = useState<SetMeta | null>(null);
  const [isRepeat, setIsRepeat] = useState(false);
  // How many recordings have been handed to the upload queue, and how many of those have settled —
  // for the wrap-up's "Recordings sent" bar. The outcomes themselves live in uploadResultsRef.
  const [uploads, setUploads] = useState({ started: 0, settled: 0 });
  // Why the capture marker could not be written, and how many Items it names as having no
  // recording on the server, for the "completion-failed" screen.
  const [completionFailure, setCompletionFailure] = useState<{ error: unknown; unsentCount: number } | null>(null);

  const mountedRef = useRef(true);
  const recorderRef = useRef(recorder);
  recorderRef.current = recorder;
  // Each Item's settled upload outcome (simulationUpload.ts's SimUploadOutcome) — a ref, not state,
  // so the settle step reads the latest outcomes synchronously. Only "done" Items are scored; the
  // server's own recovery owns "recovery-pending" ones; the rest are reported as lost.
  const uploadResultsRef = useRef<Record<string, SimUploadOutcome>>({});
  // Bucketed by task index (0 = listen_repeat, 1 = interview): L&R's score request awaits only
  // its own uploads.
  const uploadPromisesByTaskRef = useRef<[Promise<void>[], Promise<void>[]]>([[], []]);
  // fireTaskScore's single-flight guard, set synchronously the first time it runs for a Task Type,
  // so the settle step's own call joins the request already fired at the L&R -> interview transition.
  const taskFirePromiseRef = useRef<Partial<Record<SpeakingTaskType, Promise<void>>>>({});
  const retryRef = useRef<(() => void) | null>(null);
  const startingRef = useRef(false);
  const sectionEndRef = useRef(newSectionEnd());

  // Every way out turns the recording indicator off: stop() ends a running take, and release() ends
  // the held stream's tracks, which stop() deliberately leaves live in held mode.
  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
      if (recorderRef.current.state === "recording") void recorderRef.current.stop();
      recorderRef.current.release();
      // A recording still waiting to be sent gets its last budget now rather than retrying forever
      // for a page nobody is on.
      sectionEndRef.current.end();
    };
  }, []);

  // One mic stream for the whole section, acquired when the Item phase begins (the mic check has
  // already secured permission) and reused by every Item: opening and closing the device per Item
  // glitches the next Item's stimulus on macOS (useRecorder.ts). A failure is swallowed — each
  // ItemRecorder's start() then acquires per Item and shows its own mic-error state.
  useEffect(() => {
    if (stage !== "item-running") return;
    void recorderRef.current.acquire().catch(() => {});
  }, [stage]);

  const loadSet = useCallback(async () => {
    setStage("loading");
    setErrorMsg(null);
    try {
      // Inside a Full-Test Run the Set is the one the Run drew (the server refuses any other), looked
      // up in the bank only for its title and `attempted` flag; standalone, the automatic pick.
      // predictRepeat lets the intro disclose a Repeat before the User starts.
      const entry = fullTestSetId ? await findListedSet(fullTestSetId) : await pickSimulationSet("speaking");
      const s = await getSet(fullTestSetId ?? entry!.id);
      const repeat = await predictRepeat(entry, fullTestAttemptId);
      if (!mountedRef.current) return;
      setSet(expectServedSet("speaking", s));
      setListing(entry);
      setIsRepeat(repeat);
      setStage("intro");
    } catch (e) {
      if (!mountedRef.current) return;
      setErrorMsg(requestErrorMessage(e));
      retryRef.current = () => void loadSet();
      setStage("error");
    }
  }, [fullTestSetId, fullTestAttemptId]);

  useEffect(() => {
    void loadSet();
  }, [loadSet]);

  // Deliberately still active through "finishing", not just "item-running": leaving the tab during
  // the wrap-up still flags the Attempt.
  useFlagOnHidden(attemptId, stage !== "error" && stage !== "loading");

  // From the scenario briefing until the hand-off. "finishing" is included because a reload there
  // would kill uploads still in flight — but leaving within the app does not stop them, so the
  // prompt says so there. The page's own exits go through guard.leave.
  const guard = useLeaveGuard(
    attemptId !== null &&
      (stage === "scenario-briefing" || stage === "item-running" || stage === "finishing" || stage === "completion-failed"),
    stage === "finishing"
      ? "Leave before the wrap-up ends? Your recordings are still being sent. Leaving this page won't stop that, but reloading or closing the tab before it finishes could lose them."
      : stage === "completion-failed"
        ? `Leave before the Speaking section is closed? Your recordings are kept, but until the section is closed the Attempt can't be finished or get a Band Estimate. ${finishLaterText(completionFailure?.unsentCount ?? 0)}`
        : leaveRestartsSectionMessage("Speaking"),
  );

  const beginAttempt = useCallback(async () => {
    if (!set || startingRef.current) return;
    startingRef.current = true;
    setIsStarting(true);
    setErrorMsg(null);
    try {
      const res = await createAttempt({
        kind: "speaking",
        mode: "simulation",
        setId: set.id,
        ...(fullTestRunId ? { fullTestRunId } : {}),
      });
      // While this request is in flight, Ready's Back button does nothing (startingRef), so the only
      // way to lose the response is an unmount: the User has left this flow, and it is ignored.
      if (!mountedRef.current) return;
      setAttemptId(res.attemptId);
      // The server's answer decided the Attempt's own Repeat tag, so it wins over the intro's read.
      setIsRepeat(res.isRepeat);
      setTaskIndex(0);
      setItemIndex(0);
      setIntroAudioDone(true);
      uploadResultsRef.current = {};
      uploadPromisesByTaskRef.current = [[], []];
      setUploads({ started: 0, settled: 0 });
      taskFirePromiseRef.current = {};
      sectionEndRef.current = newSectionEnd();
      setStage("scenario-briefing");
    } catch (e) {
      if (!mountedRef.current) return;
      setErrorMsg(requestErrorMessage(e));
      setStage("ready");
    } finally {
      startingRef.current = false;
      if (mountedRef.current) setIsStarting(false);
    }
  }, [set, fullTestRunId]);

  // Never awaited before advancing — the next Item starts straight away. A recording the server
  // cannot take yet is kept and retried until the section is over (uploadUntilSectionEnds), so a
  // server that is down for a few minutes costs nothing once it is back.
  const startUpload = useCallback(
    (itemId: string, blob: Blob, taskIdx: 0 | 1) => {
      if (!attemptId) return;
      const p = uploadUntilSectionEnds(
        () => uploadItemAudio(attemptId, itemId, blob),
        { now: () => Date.now(), sleep: (ms) => new Promise((r) => setTimeout(r, ms)) },
        sectionEndRef.current.ended,
      ).then((outcome) => {
        uploadResultsRef.current[itemId] = outcome;
        if (mountedRef.current) setUploads((u) => ({ ...u, settled: u.settled + 1 }));
      });
      uploadPromisesByTaskRef.current[taskIdx].push(p);
      setUploads((u) => ({ ...u, started: u.started + 1 }));
    },
    [attemptId]
  );

  // Fires a Task Type's one score request once every one of its own uploads has settled, for the
  // "done" Items only; a second call joins the first. The request is retried within a budget like
  // every other Simulation request, because the server marks a transcribed Item that no score
  // request covers as failed once the capture marker has stood for a grace period.
  const fireTaskScore = useCallback(
    (taskType: SpeakingTaskType, taskIdx: 0 | 1, items: RunnableItem[]): Promise<void> => {
      const existing = taskFirePromiseRef.current[taskType];
      if (existing) return existing;
      const promise = (async () => {
        if (!attemptId) return;
        await Promise.allSettled(uploadPromisesByTaskRef.current[taskIdx]);
        const doneItems = items
          .filter((i) => uploadResultsRef.current[i.id] === "done")
          .map((i) => ({ itemId: i.id }));
        if (doneItems.length === 0) return;
        const sent = await retryWithinBudget(
          // Each send is given a limit of its own: a request that never answers would otherwise
          // hold the finishing sequence until its overall time runs out.
          () => withTimeout(scoreTask(attemptId, { taskType, items: doneItems }), SCORE_REQUEST_TIMEOUT_MS),
          { now: () => Date.now(), sleep },
          (attempt, e) => console.error(`speaking simulation: ${taskType} score request attempt ${attempt} failed`, e),
          undefined,
          (e) => e instanceof HttpError && e.status >= 400 && e.status < 500 && e.status !== 408 && e.status !== 429,
        );
        if (!sent) console.error(`speaking simulation: ${taskType} score request never landed`);
      })();
      taskFirePromiseRef.current[taskType] = promise;
      return promise;
    },
    [attemptId]
  );

  const currentItems: RunnableItem[] = useMemo(() => {
    if (!set) return [];
    return taskIndex === 0 ? set.listenAndRepeat.items : set.interview.questions;
  }, [set, taskIndex]);

  const listenRepeatFocusRegions = useMemo(
    () => set?.listenAndRepeat.items.map((item) => item.focusRegion) ?? [],
    [set],
  );

  // Moves the section on from the Item that just ended, however it ended.
  const advancePastItem = useCallback(() => {
    const nextItemIndex = itemIndex + 1;
    if (nextItemIndex < currentItems.length) {
      setItemIndex(nextItemIndex);
    } else if (taskIndex === 0) {
      // L&R done -> straight into the interview intro, no click-through in between. L&R's scoring
      // job fires now: it waits for its own uploads and then runs server-side during the interview.
      setTaskIndex(1);
      setItemIndex(0);
      setIntroAudioDone(false);
      void fireTaskScore("listen_repeat", 0, currentItems);
    } else {
      // The interview's last question: nothing records past this point, so stop holding the mic.
      recorderRef.current.release();
      sectionEndRef.current.end();
      setStage("finishing");
    }
  }, [currentItems, itemIndex, taskIndex, fireTaskScore]);

  const handleItemFinished = useCallback(
    (blob: Blob) => {
      const item = currentItems[itemIndex];
      if (!item) return;
      startUpload(item.id, blob, taskIndex);
      advancePastItem();
    },
    [currentItems, itemIndex, taskIndex, startUpload, advancePastItem]
  );

  // The Item's prompt would not play or the microphone would not open, and the User moved on: no
  // recording exists, and the reason is the app's, so it is reported with the lost uploads.
  const handleItemSkipped = useCallback(() => {
    const item = currentItems[itemIndex];
    if (!item) return;
    uploadResultsRef.current[item.id] = "not-captured";
    advancePastItem();
  }, [currentItems, itemIndex, advancePastItem]);

  // A prompt that will not play is flagged the way leaving the tab is: the Attempt was interrupted.
  const handleStimulusGate = useCallback(() => {
    if (attemptId) void flagAttempt(attemptId).catch(() => {});
  }, [attemptId]);

  // Inside a Run, capture-finished is what makes the Speaking section terminal; the advance is
  // best-effort (advanceFullTestSection says why).
  const handOff = (id: string) => {
    if (!fullTestRunId) {
      guard.leave(`/attempts/${id}`);
      return;
    }
    void advanceFullTestSection(fullTestRunId, "speaking").then(() => guard.leave(`/full-test/${fullTestRunId}`));
  };

  // The wrap-up (finishingSequence.ts): settle every upload and both score requests, then post the
  // capture marker once. The settle step runs to the end even after the User has navigated away,
  // because it is the one path to the marker, and the marker may not go out ahead of the score
  // requests. Scoring jobs are never awaited here; the report renders them landing.
  const showEscape = useFinishingSequence({
    active: stage === "finishing" && set !== null,
    attemptId,
    settle: async () => {
      await Promise.allSettled([...uploadPromisesByTaskRef.current[0], ...uploadPromisesByTaskRef.current[1]]);
      if (set) {
        // L&R's request normally fired at the L&R -> interview transition, so this joins it.
        await fireTaskScore("listen_repeat", 0, set.listenAndRepeat.items);
        await fireTaskScore("interview", 1, set.interview.questions);
      }
      return "settled";
    },
    // Every upload has settled by now, so the outcomes are final.
    complete: (id) => markSpeakingCaptureFinished(id, lostUploadItemIds(uploadResultsRef.current)),
    timeoutMs: SPEAKING_FINISHING_TIMEOUT_MS,
    guardMs: FINISH_SEQUENCE_GUARD_MS,
    onFinished: handOff,
    onCompletionFailed: (_id, error) => {
      setCompletionFailure({ error, unsentCount: lostUploadItemIds(uploadResultsRef.current).length });
      setStage("completion-failed");
    },
  });

  if (stage === "loading") return <LoadingMain label="Loading simulation…" />;
  if (stage === "error") return <ErrorMain message={errorMsg ?? "Something went wrong."} onRetry={retryRef.current} fullTestRunId={fullTestRunId} />;
  if (!set) return null;

  const leaveTo = fullTestRunId ? `/full-test/${fullTestRunId}` : "/";
  // Before the Attempt exists there is nothing to lose, so leaving asks nothing.
  const plainExit = <ExamExit to={leaveTo} asks={false} />;
  const runningExit = <ExamExit to={leaveTo} asks />;
  const setTitle = listing?.title ?? fallbackSetTitle("Speaking", set.createdAt);
  // Inside a Full-Test Run the section leads and its Set follows; on its own, the Set leads.
  const introHeading = {
    kicker: fullTestRunId ? "Full-Test Run · Section 4 of 4" : "Speaking Simulation",
    title: fullTestRunId ? "Speaking section" : setTitle,
    meta: (
      <>
        {fullTestRunId && <span className="font-medium text-ink-soft">{setTitle}</span>}
        <ExamSetLine source={set.source} createdAt={set.createdAt} setId={set.id} />
      </>
    ),
  };
  const introPart = fullTestRunId ? "Full-Test Run" : "Simulation";
  const repeatNotice = isRepeat ? <Notice tone="caution">{repeatNoticeText("Speaking")}</Notice> : null;
  const lrCount = set.listenAndRepeat.items.length;
  const questionCount = set.interview.questions.length;

  if (stage === "intro") {
    return (
      <ExamShell section="Speaking" part={introPart} exit={plainExit}>
        <ExamIntro
          {...introHeading}
          notice={repeatNotice}
          facts={[
            { term: "Time", detail: "About 6 to 9 min, without a break." },
            {
              term: "Items",
              detail: `${lrCount} Listen and Repeat sentences, then an Interview: a short introduction and ${questionCount} questions.`,
            },
            {
              term: "Recording",
              detail:
                "Each Item plays once. There are no replays, no re-recording and no pausing once you begin, and each response window starts by itself after the tone.",
            },
            {
              term: "If sending fails",
              detail:
                "A recording that can't be sent right away is kept and sent again until the section ends. Only one that still can't be sent is left out of your score.",
            },
            { term: "Feedback", detail: "Scoring and your report wait until the very end." },
            { term: "Leaving", detail: "Switching to another tab is noted on the Attempt. Leaving the section ends it; it can't be resumed." },
          ]}
          actions={
            <Button variant="primary" iconEnd={<IconArrowRight size={16} />} onClick={() => setStage("mic-check")}>
              Check your microphone
            </Button>
          }
        />
      </ExamShell>
    );
  }

  if (stage === "mic-check") {
    return (
      <ExamShell
        section="Speaking"
        part="Microphone check"
        exit={plainExit}
        footer={
          <Button variant="quiet" icon={<IconArrowLeft size={16} />} onClick={() => setStage("intro")}>
            Back
          </Button>
        }
      >
        <MicCheck onPass={() => setStage("ready")} />
      </ExamShell>
    );
  }

  if (stage === "ready") {
    return (
      <ExamShell section="Speaking" part="Ready" exit={plainExit}>
        <ExamIntro
          {...introHeading}
          notice={
            <>
              <Notice tone="positive" title="Your microphone works" />
              {repeatNotice}
              {errorMsg && (
                <Notice tone="critical" live="assertive" title="The Simulation didn't start">
                  {errorMsg}
                </Notice>
              )}
            </>
          }
          facts={[
            { term: "Task 1", detail: `Listen and Repeat · ${lrCount} sentences` },
            { term: "Task 2", detail: `Interview · ${questionCount} questions` },
            { term: "Once you start", detail: "The section runs straight through. Each response window starts by itself after the tone." },
          ]}
          actions={
            <>
              <Button
                variant="primary"
                iconEnd={<IconArrowRight size={16} />}
                loading={isStarting}
                onClick={() => {
                  // Create/wake the shared beep context inside this real click, so Safari honors the
                  // non-gesture resumes the per-Item beeps need later. Fire-and-forget.
                  void armBeepCue();
                  void beginAttempt();
                }}
              >
                Start Speaking Simulation
              </Button>
              <Button
                variant="quiet"
                disabled={isStarting}
                onClick={() => {
                  if (startingRef.current) return;
                  setStage("intro");
                }}
              >
                Back
              </Button>
            </>
          }
        >
          <p className="text-meta text-graphite">The voices you will hear are AI-generated practice voices.</p>
        </ExamIntro>
      </ExamShell>
    );
  }

  if (stage === "scenario-briefing") {
    return (
      <ExamShell section="Speaking" part="Listen and Repeat · Task 1 of 2" exit={runningExit}>
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
    const item = currentItems[itemIndex];
    const showIntroAudio = taskIndex === 1 && !introAudioDone;
    const taskLabel = taskIndex === 0 ? TASK_TYPES.listen_repeat.label : TASK_TYPES.interview.label;
    const scene = taskIndex === 0 ? set.listenAndRepeat.image : undefined;
    return (
      <ExamShell
        section="Speaking"
        part={`${taskLabel} · Task ${taskIndex + 1} of 2`}
        exit={runningExit}
        progress={
          showIntroAudio
            ? undefined
            : { current: itemIndex + 1, total: currentItems.length, label: `Item ${itemIndex + 1} of ${currentItems.length}` }
        }
      >
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
            <ItemRecorder
              key={item.id}
              item={item}
              recorder={recorder}
              onFinished={handleItemFinished}
              stimulusAutoRetries={STIMULUS_AUTO_RETRIES}
              onStimulusGate={handleStimulusGate}
              onSkip={handleItemSkipped}
            />
            {scene && (
              <SceneImage file={scene.file} focusRegions={listenRepeatFocusRegions} currentIndex={itemIndex} className="max-sm:max-w-72 lg:order-first" />
            )}
          </div>
        ) : null}
      </ExamShell>
    );
  }

  // The capture marker could not be written. Retry re-enters the wrap-up, whose uploads and score
  // requests have all settled, so it sends only the marker again, naming the same Items.
  if (stage === "completion-failed" && completionFailure) {
    const { error, unsentCount } = completionFailure;
    return (
      <ExamShell section="Speaking" part="Not finished" exit={null}>
        <CompletionFailed
          title="Couldn't close the Speaking section"
          error={error}
          onRetry={() => setStage("finishing")}
          onOpenReport={() => attemptId && guard.leave(`/attempts/${attemptId}`)}
          later={`The report as it stands shows the Attempt unfinished. ${finishLaterText(unsentCount)}`}
        >
          <p>
            {unsentCount === 0
              ? "Every recording reached the server and is safe."
              : `The recordings that reached the server are safe. ${unsentCount === 1 ? "1 Item has" : `${unsentCount} Items have`} no recording there.`}{" "}
            Closing the section is what lets the server finish the Attempt and give it a Band Estimate once scoring is done
            {fullTestRunId ? ", and what lets the Full-Test Run go on to the next section" : ""}.
          </p>
        </CompletionFailed>
      </ExamShell>
    );
  }

  // stage === "finishing": normally brief — the last uploads, the score requests and the capture
  // marker. Transcription and judging are rendered live on the report, not waited out here.
  // Leaving does not abandon anything: the wrap-up keeps running and still posts the capture marker
  // in order. Inside a Run, the Run is where this section returns to.
  const reportLink = fullTestRunId ? `/full-test/${fullTestRunId}` : attemptId ? `/attempts/${attemptId}` : "/";
  return (
    <ExamShell section="Speaking" part="Wrapping up" exit={<ExamExit to={reportLink} asks />}>
      <SimulationStatus busy title="Wrapping up…">
        <p>Sending your recordings and handing in your Responses. Your report opens in a moment.</p>
        {uploads.started > 0 && <ProgressBar label="Recordings sent" value={uploads.settled} max={uploads.started} />}
        {showEscape && attemptId && (
          <Button variant="secondary" onClick={() => guard.leave(reportLink)}>
            {fullTestRunId ? "This is taking a while — back to the Full-Test Run" : "This is taking a while — open my report now"}
          </Button>
        )}
      </SimulationStatus>
    </ExamShell>
  );
}
