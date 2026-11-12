import { useCallback, useEffect, useRef, useState } from "react";
import { useParams } from "react-router-dom";
import type { BuildSentenceDrillScoreItemVM, ServedWritingSet } from "@toefl-prep/shared";
import { scoreTask, type BuildSentenceScoreResponse } from "../lib/api";
import { TASK_TYPES } from "../lib/taskTypes";
import { useStageEntry } from "../hooks/useStageEntry";
import { useDrillShell, useListedSet } from "./drill/drillShell";
import { fallbackSetTitle } from "./simulation/simulationShell";
import {
  DrillCompletionFailed,
  DrillErrorScreen,
  DrillIntroScreen,
  DrillLoadingScreen,
  DrillPickerScreen,
} from "./drill/DrillScreens";
import { BUILD_A_SENTENCE_BUDGET_CLOCK, BuildSentenceTask, type BuildSentenceResponse } from "../components/buildSentence";
import TimedEditor from "../components/TimedEditor";
import { CompletedStageView, type CompletedStage, type EssayKind, type SubmittedAnswer } from "./WritingDrillResults";
import { Button } from "../ui/Button";
import { ExamSetLine, type ExamIntroFact } from "../ui/ExamIntro";
import { ExamExit, ExamShell } from "../ui/ExamShell";
import { Kicker } from "../ui/Heading";
import { formatDuration } from "../ui/format";
import { Notice } from "../ui/Notice";

// The Writing Drill's run body: Build a Sentence, Write an Email and Academic Discussion, one at a
// time or all three in a row, each on the exam shell. Feedback is immediate — Build a Sentence is
// scored on hand-in, and each essay's scoring job starts the moment it is handed in and runs while
// the next Task is written. The shell around the run (loading the Set, the Attempt and its Repeat
// tag, finish-and-navigate) is the shared Drill shell's.

type TaskKind = "build_sentence" | "email" | "discussion";

/** Whether a Build a Sentence answer carries every Item's key, as a Drill's does (a Simulation's does not). */
function hasBuildSentenceKeys(
  res: BuildSentenceScoreResponse,
): res is { taskType: "build_sentence"; items: BuildSentenceDrillScoreItemVM[] } {
  return res.items.every((item) => "correctAnswers" in item && Array.isArray(item.correctAnswers));
}

type Stage = "picker" | "intro" | "bs-running" | "essay-running" | "scoring" | "drill-done";

function taskDetail(kind: TaskKind, set: ServedWritingSet): string {
  // One pooled budget for the whole Task, not a clock per Item, written as the clock reading the
  // User will race ("6:50"), never rounded to minutes.
  if (kind === "build_sentence")
    return `${set.buildASentence.items.length} Items · one ${BUILD_A_SENTENCE_BUDGET_CLOCK} clock for all of them`;
  if (kind === "email")
    return `${formatDuration(set.email.timeLimitSec)} · ${set.email.wordGuidance.min}–${set.email.wordGuidance.max} words`;
  return `${formatDuration(set.academicDiscussion.timeLimitSec)} · ${set.academicDiscussion.minWords}+ words`;
}

const TASK_OPTIONS: { label: string; kinds: TaskKind[] }[] = [
  { label: TASK_TYPES.build_sentence.label, kinds: ["build_sentence"] },
  { label: TASK_TYPES.email.label, kinds: ["email"] },
  { label: TASK_TYPES.discussion.label, kinds: ["discussion"] },
  { label: "All three Task Types", kinds: ["build_sentence", "email", "discussion"] },
];

/** What the intro says the picked Task Types will ask: one line per Task, then when feedback comes. */
function introFacts(kinds: readonly TaskKind[], set: ServedWritingSet): ExamIntroFact[] {
  return [
    ...kinds.map((kind) => ({ term: TASK_TYPES[kind].label, detail: taskDetail(kind, set) })),
    {
      term: "Feedback",
      detail:
        "Each Task is scored as you hand it in. Essays are scored by two Judges and an Arbiter while you go on, which takes a few minutes.",
    },
  ];
}

export default function WritingDrill() {
  const { setId } = useParams<{ setId: string }>();
  const drill = useDrillShell("writing", setId);
  const listed = useListedSet("writing", setId);
  const { attemptId, beginAttempt, fail, finish, isRepeat, resume, set } = drill;

  const [stage, setStage] = useState<Stage>("picker");
  const [taskQueue, setTaskQueue] = useState<TaskKind[]>([]);
  const [queueIndex, setQueueIndex] = useState(0);
  const [completed, setCompleted] = useState<CompletedStage[]>([]);
  // Essay Tasks whose scoring job has not settled (done, failed or cancelled) yet. The
  // results screen's Finish waits on these, so completing the Attempt — which computes its Band
  // Estimate — happens only once whatever was still in flight has settled.
  const [inFlightEssays, setInFlightEssays] = useState<Set<EssayKind>>(new Set());

  // Build a Sentence is scored synchronously (deterministic, no Judges); this holds a failed commit
  // so the error screen's Retry can send it again.
  const pendingBsRef = useRef<SubmittedAnswer[] | null>(null);
  const mountedRef = useRef(true);
  // The Email and the Discussion share `essay-running`, so the Task's place in the queue is part of
  // the stage's name.
  useStageEntry(drill.phase === "ready" ? `${stage}:${queueIndex}` : null);

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
    };
  }, []);

  // Entering "bs-running" mounts BuildSentenceTask, which begins the run and its one pooled budget;
  // leaving it unmounts the module and ends the run, so a later Build a Sentence run mounts a fresh
  // module and cannot inherit a spent budget.
  const startTask = useCallback((kind: TaskKind) => {
    setStage(kind === "build_sentence" ? "bs-running" : "essay-running");
  }, []);

  const handlePick = useCallback((kinds: TaskKind[]) => {
    setTaskQueue(kinds);
    setStage("intro");
  }, []);

  const handleStart = useCallback(async () => {
    if (!setId || taskQueue.length === 0) return;
    try {
      await beginAttempt();
      setCompleted([]);
      setInFlightEssays(new Set());
      setQueueIndex(0);
      startTask(taskQueue[0]);
    } catch (e) {
      fail(e);
    }
  }, [setId, taskQueue, startTask, beginAttempt, fail]);

  const advanceQueue = useCallback(() => {
    const next = queueIndex + 1;
    if (next < taskQueue.length) {
      setQueueIndex(next);
      startTask(taskQueue[next]);
    } else {
      setStage("drill-done");
    }
  }, [queueIndex, taskQueue, startTask]);

  const runBuildSentenceScore = useCallback(
    async (items: SubmittedAnswer[]) => {
      if (!attemptId || !set) return;
      pendingBsRef.current = items;
      setStage("scoring");
      try {
        const res = await scoreTask(attemptId, { taskType: "build_sentence", items });
        if (!mountedRef.current) return;
        if (!("items" in res)) throw new Error("unexpected async response scoring build_sentence");
        // A Drill's answer carries every Item's key, which the results show.
        if (!hasBuildSentenceKeys(res)) throw new Error("build_sentence response is missing its keys");
        setCompleted((c) => [
          ...c,
          { kind: "build_sentence", items: set.buildASentence.items, answers: items, results: res.items },
        ]);
        pendingBsRef.current = null;
        advanceQueue();
      } catch (e) {
        if (!mountedRef.current) return;
        fail(e);
      }
    },
    [attemptId, set, advanceQueue, fail],
  );

  // The module commits one Response per Item in the Set's order (arranged Items as arranged, Items
  // never reached as empty), exactly once, whether the User finished early or the pooled budget
  // expired.
  const handleBuildSentenceComplete = useCallback(
    (responses: readonly BuildSentenceResponse[]) => {
      void runBuildSentenceScore([...responses]);
    },
    [runBuildSentenceScore],
  );

  // An essay's slot is added (and the Drill moves on) the moment it is handed in; its scoring job
  // runs in the background while the User writes the next Task.
  const handleEssaySubmit = useCallback(
    (text: string, secondsUsed: number) => {
      const kind = taskQueue[queueIndex];
      if (!set || (kind !== "email" && kind !== "discussion")) return;
      const materials = kind === "email" ? set.email : set.academicDiscussion;
      setCompleted((c) => [...c, { kind, userText: text, itemId: materials.id, secondsUsed }]);
      advanceQueue();
    },
    [taskQueue, queueIndex, set, advanceQueue],
  );

  const handleEssayStatusChange = useCallback((kind: EssayKind, inFlight: boolean) => {
    setInFlightEssays((prev) => {
      const already = prev.has(kind);
      if (inFlight === already) return prev;
      const next = new Set(prev);
      if (inFlight) next.add(kind);
      else next.delete(kind);
      return next;
    });
  }, []);

  // The error screen's Retry: back to the run first, so the "Scoring…" screen replaces the button
  // (a second click cannot send the commit twice) and the leave guard is up again while it is sent.
  // Another failure lands on the error screen again, still holding the commit.
  const handleRetryScore = useCallback(() => {
    const pending = pendingBsRef.current;
    if (!pending) return;
    resume();
    void runBuildSentenceScore(pending);
  }, [resume, runBuildSentenceScore]);

  if (drill.phase === "loading") return <DrillLoadingScreen />;

  if (drill.phase === "error") {
    // A failed Build a Sentence commit can be sent again from here; any other failure (a failed Set
    // load or Attempt start) offers only the way back.
    return (
      <DrillErrorScreen
        message={drill.errorMsg}
        retry={pendingBsRef.current ? { label: "Retry", onRetry: handleRetryScore } : null}
      />
    );
  }

  if (!set) return null;

  const setTitle = listed?.title ?? fallbackSetTitle("Writing", set.createdAt);

  if (stage === "picker") {
    return (
      <DrillPickerScreen
        section="Writing"
        setTitle={setTitle}
        meta={<ExamSetLine source={set.source} createdAt={set.createdAt} setId={set.id} />}
        subtitle="Choose what to practise. Each Task is scored as you hand it in."
        options={TASK_OPTIONS.map((opt) => ({
          label: opt.label,
          detail:
            opt.kinds.length > 1 ? opt.kinds.map((k) => TASK_TYPES[k].label).join(", then ") : taskDetail(opt.kinds[0], set),
          onPick: () => handlePick(opt.kinds),
        }))}
      />
    );
  }

  if (stage === "intro") {
    return (
      <DrillIntroScreen
        section="Writing"
        heading={taskQueue.length > 1 ? "All three Task Types" : TASK_TYPES[taskQueue[0]].label}
        meta={setTitle}
        backLabel="Change Task Type"
        onBack={() => setStage("picker")}
        onStart={handleStart}
        facts={introFacts(taskQueue, set)}
      />
    );
  }

  const kind = taskQueue[queueIndex];
  const multi = taskQueue.length > 1;
  const part = `Drill · ${TASK_TYPES[kind].label}${multi ? ` · Task ${queueIndex + 1} of ${taskQueue.length}` : ""}`;
  const exit = <ExamExit to="/" asks={drill.guarded} />;
  // What earlier Tasks came to, one line each, above the Task on screen. Each essay's slot fires its
  // own scoring job, through lib/scoringJobOnce.ts, so drawing it here and again on the results
  // screen never scores it twice.
  const stageStatus = (compact: boolean) =>
    completed.map((c, i) => (
      <CompletedStageView key={i} stage={c} attemptId={attemptId} compact={compact} onEssayStatusChange={handleEssayStatusChange} />
    ));
  const runningStatus = completed.length > 0 ? <div className="space-y-1">{stageStatus(true)}</div> : undefined;

  if (stage === "bs-running") {
    // The Items go in, the Responses come back out: the pooled budget, the Frame slot filling, the
    // tile state, navigation, the Item overview, the early-finish question and the expiry commit
    // all belong to the module, and so does the exam screen it is drawn on.
    return (
      <BuildSentenceTask
        items={set.buildASentence.items}
        mode="drill"
        chrome={{ section: "Writing", part, exit, before: runningStatus }}
        onComplete={handleBuildSentenceComplete}
      />
    );
  }

  if (stage === "essay-running") {
    const chrome = {
      section: "Writing",
      part,
      exit,
      progress: multi ? { current: queueIndex + 1, total: taskQueue.length, label: `Task ${queueIndex + 1} of ${taskQueue.length}` } : undefined,
      before: runningStatus,
    };
    // Keyed per Task: both essays render from this one slot and the Email -> Discussion hand-off
    // never leaves `essay-running`, so without distinct keys React would reconcile them as one
    // editor and the Discussion would inherit the Email's text, its running clock and its
    // already-submitted latch.
    return kind === "email" ? (
      <TimedEditor key="email" task="email" materials={set.email} seconds={set.email.timeLimitSec} chrome={chrome} onSubmit={handleEssaySubmit} />
    ) : (
      <TimedEditor
        key="discussion"
        task="discussion"
        materials={set.academicDiscussion}
        seconds={set.academicDiscussion.timeLimitSec}
        chrome={chrome}
        onSubmit={handleEssaySubmit}
      />
    );
  }

  if (stage === "scoring") {
    return (
      <ExamShell section="Writing" part={part} exit={exit}>
        <p role="status" className="text-ui text-graphite">
          Scoring Build a Sentence…
        </p>
      </ExamShell>
    );
  }

  // stage === "drill-done"
  const stillScoring = inFlightEssays.size > 0;
  return (
    <ExamShell
      section="Writing"
      part="Drill · Results"
      // The way out is Back to Practice, which completes the Attempt.
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
            onClick={() => finish()}
            disabled={stillScoring}
            loading={drill.completion.status === "finishing"}
          >
            Back to Practice
          </Button>
        </>
      }
    >
      <div className="mx-auto max-w-page space-y-10">
        <header className="space-y-3">
          <div>
            <Kicker as="p">Writing Drill</Kicker>
            <h1 className="mt-1 font-serif text-title font-semibold text-ink">Results</h1>
          </div>
          {isRepeat && (
            <Notice tone="caution">This Attempt is a Repeat: you have practised this Set before. Repeats are left out of your Band Estimate.</Notice>
          )}
        </header>
        {stageStatus(false)}
      </div>
    </ExamShell>
  );
}
