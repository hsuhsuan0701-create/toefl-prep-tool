import { useCallback, useEffect, useRef, useState } from "react";
import { expectServedSet, type ServedWritingSet } from "@toefl-prep/shared";
import { HttpError, createAttempt, flagAttempt, getAttempt, getSet, scoreTask, type SetMeta } from "../../lib/api";
import { requestErrorMessage } from "../../lib/requestError";
import { retryWithinBudget } from "../../lib/captureRetry";
import { TASK_TYPES } from "../../lib/taskTypes";
import {
  BUILD_A_SENTENCE_BUDGET_CLOCK,
  BUILD_A_SENTENCE_BUDGET_SEC,
  BuildSentenceTask,
  type BuildSentenceResponse,
} from "../../components/buildSentence";
import TimedEditor from "../../components/TimedEditor";
import { Button } from "../../ui/Button";
import { ExamIntro, ExamSetLine } from "../../ui/ExamIntro";
import { ExamExit, ExamShell } from "../../ui/ExamShell";
import { IconArrowRight, IconCaution, IconCheck, IconSpinner } from "../../ui/icons";
import { Notice } from "../../ui/Notice";
import { formatDuration, joinAnd } from "../../ui/format";
import type { LeaveMessage } from "../../hooks/leaveGuardContext";
import { useLeaveGuard } from "../../hooks/useLeaveGuard";
import { CompletionFailed, LoadingMain, ErrorMain, SimulationStatus } from "./SimulationScreens";
import {
  FINISH_SEQUENCE_GUARD_MS,
  WRITING_FINISHING_TIMEOUT_MS,
  advanceFullTestSection,
  completeWritingAttempt,
  fallbackSetTitle,
  findListedSet,
  pickSimulationSet,
  predictRepeat,
  repeatNoticeText,
  sleep,
  useFlagOnHidden,
  withTimeout,
  type FullTestSectionContext,
} from "./simulationShell";
import { useFinishingSequence } from "./finishingSequence";
import {
  clearDraft,
  clearWritingSession,
  readDraft,
  readWritingSession,
  writeDraft,
  writeWritingSession,
  type WritingSession,
  type WritingTask,
} from "./writingDrafts";

// ---------------------------------------------------------------------------
// Writing Simulation: Build a Sentence (one pooled 6:50 budget across every Item) -> Email (7:00) ->
// Academic Discussion (10:00), continuous. Build a Sentence is the BuildSentenceTask module the
// Writing Drill also mounts: this page hands it the Items and receives the Responses.
//
// A Response is the User's work and must not be lost to one failed request, a reload, or the User
// walking away, so:
//   * each Task's Responses are sent the moment that Task ends (feedback is still deferred to the
//     report — sending is not scoring anything the User sees), retried within a budget, and a send
//     that still fails is shown on screen rather than logged and forgotten;
//   * the section in progress and every Item's draft are mirrored to sessionStorage
//     (writingDrafts.ts), so a reload, or coming back to this page in the same tab, picks the same
//     Attempt up where the clock allows. A Task whose clock ran out while the page was away is
//     handed in as it stood, and the next Task opens with its full clock;
//   * the wrap-up re-sends anything still outstanding and completes the Attempt only once the server
//     has every Response. It runs detached, so leaving the screen cannot cancel it; if a Response
//     still cannot be sent, the section stops on a screen that says which and offers Retry;
//   * the section hands off (and inside a Full-Test Run advances it) only once the Attempt is
//     completed. A completion that still fails after its retries stops the section on a screen that
//     says so, with Retry, and the draft session and the leave guard stay until it lands or the User
//     opens the report as it stands.
// ---------------------------------------------------------------------------

type WritingSimStage =
  | "loading"
  | "error"
  | "intro"
  | "bs-running"
  | "essay-running"
  | "finishing"
  | "held"
  | "completion-failed";
type EssayTask = "email" | "discussion";
type EssayAnswer = { itemId: string; text: string; secondsUsed: number };
type SendStatus = "sending" | "sent" | "unsent";

const TASKS: readonly WritingTask[] = ["build_sentence", "email", "discussion"];
const NEXT_TASK: Record<WritingTask, WritingTask | "finishing"> = {
  build_sentence: "email",
  email: "discussion",
  discussion: "finishing",
};
// Bounds one request so a connection that never answers cannot hold a send open past its budget.
const SEND_ATTEMPT_TIMEOUT_MS = 15_000;

const LEAVE_MESSAGE: LeaveMessage =
  "Leave the Writing section? What you've written is kept in this browser tab, and coming back to this page picks it up where the clock allows — but the clock keeps running while you're away.";

// Every Response is on the server; only the completion is missing, and the draft session keeps the
// wrap-up, so coming back to this page in the same tab runs it again.
const LEAVE_BEFORE_COMPLETED_MESSAGE: LeaveMessage =
  "Leave before the Writing Attempt is finished? Your Responses are sent and kept, but until the Attempt is finished it has no Band Estimate. Coming back to this page finishes it, and so does Finish and score on the Progress page.";

/** The server read the request and refused it; sending the same thing again cannot help. */
function isPermanentFailure(e: unknown): boolean {
  return e instanceof HttpError && e.status >= 400 && e.status < 500 && e.status !== 408 && e.status !== 429;
}

function taskSeconds(set: ServedWritingSet, task: WritingTask): number {
  if (task === "build_sentence") return BUILD_A_SENTENCE_BUDGET_SEC;
  return task === "email" ? set.email.timeLimitSec : set.academicDiscussion.timeLimitSec;
}

function essayItemId(set: ServedWritingSet, task: EssayTask): string {
  return task === "email" ? set.email.id : set.academicDiscussion.id;
}

function itemIdsOf(set: ServedWritingSet, task: WritingTask): string[] {
  return task === "build_sentence" ? set.buildASentence.items.map((item) => item.id) : [essayItemId(set, task)];
}

export default function WritingSimulation({ fullTest }: { fullTest?: FullTestSectionContext }) {
  const fullTestRunId = fullTest?.runId;
  const fullTestSetId = fullTest?.setId;
  const fullTestAttemptId = fullTest?.attemptId ?? null;
  const scope = fullTestRunId ?? "standalone";

  const [stage, setStage] = useState<WritingSimStage>("loading");
  const [set, setSet] = useState<ServedWritingSet | null>(null);
  const [errorMsg, setErrorMsg] = useState<string | null>(null);
  const [attemptId, setAttemptId] = useState<string | null>(null);
  const [isStarting, setIsStarting] = useState(false);
  // The Set as the bank lists it, for its title and whether it has been attempted (a Repeat).
  const [listing, setListing] = useState<SetMeta | null>(null);
  const [isRepeat, setIsRepeat] = useState(false);
  // The Task on screen: which essay, the deadline its clock runs to, and what it opens with.
  const [essayTask, setEssayTask] = useState<EssayTask>("email");
  const [taskDeadline, setTaskDeadline] = useState<number>(0);
  const [essayOpening, setEssayOpening] = useState("");
  const [bsOpening, setBsOpening] = useState<Record<string, (string | null)[]>>({});
  const [sendStatus, setSendStatus] = useState<Partial<Record<WritingTask, SendStatus>>>({});
  // Why the completion could not be made, for the "completion-failed" screen.
  const [completionError, setCompletionError] = useState<unknown>(null);

  const mountedRef = useRef(true);
  const retryRef = useRef<(() => void) | null>(null);
  const startingRef = useRef(false);
  // The record mirrored to sessionStorage; null before an Attempt exists and once it is complete.
  const sessionRef = useRef<WritingSession | null>(null);
  // Each handed-in Task's Responses, exactly as they go on the wire.
  const responsesRef = useRef<{
    build_sentence?: BuildSentenceResponse[];
    email?: EssayAnswer;
    discussion?: EssayAnswer;
  }>({});
  // One send per Task at a time: a second caller (the wrap-up, a Retry) joins the one in flight. A
  // send that ends unsent is dropped from here, so the next caller starts a fresh one.
  const sendsRef = useRef<Partial<Record<WritingTask, Promise<SendStatus>>>>({});

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
    };
  }, []);

  const saveSession = useCallback(
    (next: WritingSession) => {
      sessionRef.current = next;
      writeWritingSession(scope, next);
    },
    [scope],
  );

  const sendTask = useCallback(
    (served: ServedWritingSet, id: string, task: WritingTask): Promise<SendStatus> => {
      const inFlight = sendsRef.current[task];
      if (inFlight) return inFlight;
      const items = responsesRef.current[task];
      if (!items) return Promise.resolve("unsent");
      const request =
        task === "build_sentence"
          ? { taskType: "build_sentence" as const, items: items as BuildSentenceResponse[] }
          : { taskType: task, items: [items as EssayAnswer] };
      setSendStatus((prev) => ({ ...prev, [task]: "sending" }));
      const promise = retryWithinBudget(
        () => withTimeout(scoreTask(id, request), SEND_ATTEMPT_TIMEOUT_MS),
        { now: () => Date.now(), sleep },
        (attempt, e) => console.error(`writing simulation: ${task} send attempt ${attempt} failed`, e),
        undefined,
        isPermanentFailure,
      ).then((accepted): SendStatus => {
        if (accepted) {
          // The server has it: the draft has done its job.
          for (const itemId of itemIdsOf(served, task)) clearDraft(id, itemId);
          const session = sessionRef.current;
          if (session?.attemptId === id && !session.accepted.includes(task)) {
            saveSession({ ...session, accepted: [...session.accepted, task] });
          }
        } else if (sendsRef.current[task] === promise) {
          delete sendsRef.current[task];
        }
        const status: SendStatus = accepted ? "sent" : "unsent";
        setSendStatus((prev) => ({ ...prev, [task]: status }));
        return status;
      });
      sendsRef.current[task] = promise;
      return promise;
    },
    [saveSession],
  );

  // Puts a Task on screen, running to `deadlineMs`, opening with whatever draft it has.
  const openTask = useCallback(
    (served: ServedWritingSet, task: WritingTask, deadlineMs: number) => {
      const session = sessionRef.current;
      if (!session) return;
      saveSession({ ...session, task, deadlineMs });
      setTaskDeadline(deadlineMs);
      if (task === "build_sentence") {
        const opening: Record<string, (string | null)[]> = {};
        for (const item of served.buildASentence.items) {
          const slots = readDraft(session.attemptId, item.id)?.slots;
          if (slots) opening[item.id] = slots;
        }
        setBsOpening(opening);
        setStage("bs-running");
      } else {
        setEssayTask(task);
        setEssayOpening(readDraft(session.attemptId, essayItemId(served, task))?.text ?? "");
        setStage("essay-running");
      }
    },
    [saveSession],
  );

  // A Task's Responses, rebuilt from its drafts — for a Task handed in before a reload, or one whose
  // clock ran out while the page was away. A Build a Sentence draft holds tile texts per blank, and
  // dropping the empty blanks is exactly how the Task itself commits an arrangement.
  const responsesFromDrafts = useCallback((served: ServedWritingSet, id: string, task: WritingTask) => {
    if (task === "build_sentence") {
      responsesRef.current.build_sentence = served.buildASentence.items.map((item) => ({
        itemId: item.id,
        tileOrder: (readDraft(id, item.id)?.slots ?? []).filter((text): text is string => text !== null),
      }));
      return;
    }
    const itemId = essayItemId(served, task);
    const draft = readDraft(id, itemId);
    responsesRef.current[task] = {
      itemId,
      text: draft?.text ?? "",
      secondsUsed: draft?.secondsUsed ?? taskSeconds(served, task),
    };
  }, []);

  // The one way a Task ends: its Responses are recorded, the next Task opens (or the wrap-up starts)
  // and the Responses go to the server straight away.
  const handIn = useCallback(
    (served: ServedWritingSet, task: WritingTask) => {
      const session = sessionRef.current;
      if (!session) return;
      const next = NEXT_TASK[task];
      if (next === "finishing") {
        saveSession({ ...session, task: "finishing", deadlineMs: null });
        setStage("finishing");
      } else {
        openTask(served, next, Date.now() + taskSeconds(served, next) * 1000);
      }
      void sendTask(served, session.attemptId, task);
    },
    [openTask, saveSession, sendTask],
  );

  const handleBuildSentenceComplete = useCallback(
    (responses: readonly BuildSentenceResponse[]) => {
      if (!set) return;
      responsesRef.current.build_sentence = [...responses];
      handIn(set, "build_sentence");
    },
    [set, handIn],
  );

  const handleEssaySubmit = useCallback(
    (text: string, secondsUsed: number) => {
      const session = sessionRef.current;
      if (!set || !session) return;
      const itemId = essayItemId(set, essayTask);
      responsesRef.current[essayTask] = { itemId, text, secondsUsed };
      writeDraft(session.attemptId, itemId, { text, secondsUsed });
      handIn(set, essayTask);
    },
    [set, essayTask, handIn],
  );

  // Picks a stored section back up: the Tasks already handed in are re-sent if the server never
  // accepted them, and the current Task resumes on its own deadline — or, if that has passed, is
  // handed in as it stood.
  const resume = useCallback(
    (served: ServedWritingSet, session: WritingSession) => {
      sessionRef.current = session;
      setAttemptId(session.attemptId);
      // Coming back to a section is leaving it, as far as the Attempt's record is concerned.
      void flagAttempt(session.attemptId).catch(() => {});
      const position = session.task === "finishing" ? TASKS.length : TASKS.indexOf(session.task);
      const accepted = new Set(session.accepted);
      setSendStatus(Object.fromEntries(session.accepted.map((task) => [task, "sent" as const])));
      for (const task of TASKS.slice(0, position)) {
        if (accepted.has(task)) {
          sendsRef.current[task] = Promise.resolve("sent");
          continue;
        }
        responsesFromDrafts(served, session.attemptId, task);
        if (session.task !== "finishing") void sendTask(served, session.attemptId, task);
      }
      if (session.task === "finishing") {
        setStage("finishing");
        return;
      }
      if (session.deadlineMs !== null && session.deadlineMs > Date.now()) {
        openTask(served, session.task, session.deadlineMs);
        return;
      }
      responsesFromDrafts(served, session.attemptId, session.task);
      handIn(served, session.task);
    },
    [handIn, openTask, responsesFromDrafts, sendTask],
  );

  // Only the latest load applies its result: StrictMode runs the load effect twice, and two resumes
  // racing each other would each hand in an expired Task.
  const loadGenerationRef = useRef(0);
  const loadSet = useCallback(async () => {
    const generation = ++loadGenerationRef.current;
    const current = () => mountedRef.current && generation === loadGenerationRef.current;
    setStage("loading");
    setErrorMsg(null);
    try {
      let stored = readWritingSession(scope);
      // Inside a Full-Test Run, only the Attempt the Run itself records may be picked up.
      if (stored && fullTestRunId && stored.attemptId !== fullTestAttemptId) stored = null;
      if (stored) {
        try {
          const detail = await getAttempt(stored.attemptId);
          if (detail.attempt.status !== "in_progress") stored = null;
        } catch (e) {
          if (!(e instanceof HttpError && e.status === 404)) throw e;
          stored = null;
        }
        if (!stored) clearWritingSession(scope);
      }
      // Inside a Run the Set is the one the Run drew for this section; standalone, a stored section
      // keeps its own Set, and otherwise one is picked automatically. A Set named either way is
      // looked up in the bank only for its title and `attempted` flag. A resumed Attempt carries its
      // own tag, and a restarted Run section the tag of the Attempt it replaces (predictRepeat).
      const named = stored?.setId ?? fullTestSetId;
      const entry = named ? await findListedSet(named) : await pickSimulationSet("writing");
      const served = expectServedSet("writing", await getSet(named ?? entry!.id));
      const repeat = await predictRepeat(entry, stored?.attemptId ?? fullTestAttemptId);
      if (!current()) return;
      setSet(served);
      setListing(entry);
      setIsRepeat(repeat);
      if (stored) resume(served, stored);
      else setStage("intro");
    } catch (e) {
      if (!current()) return;
      setErrorMsg(requestErrorMessage(e));
      retryRef.current = () => void loadSet();
      setStage("error");
    }
  }, [scope, fullTestRunId, fullTestSetId, fullTestAttemptId, resume]);

  useEffect(() => {
    void loadSet();
  }, [loadSet]);

  // Deliberately still active through the wrap-up: leaving the tab then still flags the Attempt.
  useFlagOnHidden(attemptId, stage !== "error" && stage !== "loading");

  const guard = useLeaveGuard(
    attemptId !== null &&
      (stage === "bs-running" ||
        stage === "essay-running" ||
        stage === "finishing" ||
        stage === "held" ||
        stage === "completion-failed"),
    stage === "finishing"
      ? "Leave before the wrap-up ends? Your Responses are still being sent. Leaving this page won't stop that, but closing the tab before it finishes could lose them."
      : stage === "held"
        ? "Leave without sending? Some of your Responses haven't reached the server yet. They're kept in this browser tab, and coming back to this page sends them."
        : stage === "completion-failed"
          ? LEAVE_BEFORE_COMPLETED_MESSAGE
          : LEAVE_MESSAGE,
  );

  const beginAttempt = useCallback(async () => {
    if (!set || startingRef.current) return;
    startingRef.current = true;
    setIsStarting(true);
    try {
      const res = await createAttempt({
        kind: "writing",
        mode: "simulation",
        setId: set.id,
        ...(fullTestRunId ? { fullTestRunId } : {}),
      });
      if (!mountedRef.current) return;
      setIsRepeat(res.isRepeat);
      responsesRef.current = {};
      sendsRef.current = {};
      setSendStatus({});
      sessionRef.current = { attemptId: res.attemptId, setId: set.id, task: "build_sentence", deadlineMs: null, accepted: [] };
      setAttemptId(res.attemptId);
      openTask(set, "build_sentence", Date.now() + BUILD_A_SENTENCE_BUDGET_SEC * 1000);
    } catch (e) {
      if (!mountedRef.current) return;
      setErrorMsg(requestErrorMessage(e));
      retryRef.current = () => void beginAttempt();
      setStage("error");
    } finally {
      startingRef.current = false;
      if (mountedRef.current) setIsStarting(false);
    }
  }, [set, fullTestRunId, openTask]);

  const handOff = useCallback(
    async (id: string) => {
      if (!fullTestRunId) {
        guard.leave(`/attempts/${id}`);
        return;
      }
      await advanceFullTestSection(fullTestRunId, "writing");
      guard.leave(`/full-test/${fullTestRunId}`);
    },
    [guard, fullTestRunId],
  );

  // The wrap-up: make sure the server has all three Tasks' Responses, then complete the Attempt.
  // Every send and the completion are bounded (their own budgets, each request timed out), so this
  // ends well inside the overall timeout; it reports `held` instead of completing while any Response
  // is still missing, and `completion-failed` instead of handing off when the completion could not
  // be made.
  useFinishingSequence({
    active: stage === "finishing",
    attemptId,
    settle: async (id) => {
      if (!set) return "held";
      const results = await Promise.all(TASKS.map((task) => sendTask(set, id, task)));
      return results.every((status) => status === "sent") ? "settled" : "held";
    },
    complete: async (id) => {
      const result = await completeWritingAttempt(id);
      // The draft session goes only with a completed Attempt: until then it holds the wrap-up, so
      // coming back to this page runs the completion again.
      if (result.kind === "completed") {
        sessionRef.current = null;
        clearWritingSession(scope);
      }
      return result;
    },
    timeoutMs: WRITING_FINISHING_TIMEOUT_MS,
    guardMs: FINISH_SEQUENCE_GUARD_MS,
    onFinished: (id) => void handOff(id),
    onHeld: () => setStage("held"),
    onCompletionFailed: (_id, error) => {
      setCompletionError(error);
      setStage("completion-failed");
    },
  });

  // The way out of a completion that failed: the report, with the Attempt unfinished. The User
  // chose it, so the draft session goes; no Response is in it that the server does not have.
  const openReportAsItStands = () => {
    if (!attemptId) return;
    sessionRef.current = null;
    clearWritingSession(scope);
    guard.leave(`/attempts/${attemptId}`);
  };

  if (stage === "loading") return <LoadingMain label="Loading simulation…" />;
  if (stage === "error") return <ErrorMain message={errorMsg ?? "Something went wrong."} onRetry={retryRef.current} fullTestRunId={fullTestRunId} />;
  if (!set) return null;

  const unsentTasks = TASKS.filter((task) => sendStatus[task] === "unsent");
  const section = "Writing";
  const leaveTo = fullTestRunId ? `/full-test/${fullTestRunId}` : "/";
  const taskNumber = (task: WritingTask) => TASKS.indexOf(task) + 1;

  if (stage === "intro") {
    const setTitle = listing?.title ?? fallbackSetTitle("Writing", set.createdAt);
    const totalSec = BUILD_A_SENTENCE_BUDGET_SEC + set.email.timeLimitSec + set.academicDiscussion.timeLimitSec;
    return (
      <ExamShell section={section} part={fullTestRunId ? "Full-Test Run" : "Simulation"} exit={<ExamExit to={leaveTo} asks={false} />}>
        <ExamIntro
          // Inside a Full-Test Run the section leads and its Set follows; on its own, the Set leads.
          kicker={fullTestRunId ? "Full-Test Run · Section 3 of 4" : "Writing Simulation"}
          title={fullTestRunId ? "Writing section" : setTitle}
          meta={
            <>
              {fullTestRunId && <span className="font-medium text-ink-soft">{setTitle}</span>}
              <ExamSetLine source={set.source} createdAt={set.createdAt} setId={set.id} />
            </>
          }
          notice={isRepeat ? <Notice tone="caution">{repeatNoticeText("Writing")}</Notice> : null}
          facts={[
            {
              term: "Time",
              detail: `About ${formatDuration(totalSec)}, without a break: one shared ${BUILD_A_SENTENCE_BUDGET_CLOCK} budget for all ${set.buildASentence.items.length} Build a Sentence Items together, then ${formatDuration(set.email.timeLimitSec)} for the email and ${formatDuration(set.academicDiscussion.timeLimitSec)} for the academic discussion post.`,
            },
            {
              term: "Moving around",
              detail:
                "Each Task starts as soon as the one before it ends. In Build a Sentence, move with Next and Back, jump to any Item from the overview, and finish the Task early once you are done with all of them. You can hand in the email and the post before their clocks run out.",
            },
            {
              term: "When time runs out",
              detail:
                "Every Item is handed in exactly as it stands and the next Task starts. Items you never reached are left empty rather than marched through, and score 0.",
            },
            { term: "Feedback", detail: "Each Task is sent as it ends. Scores wait for your report." },
            {
              term: "Leaving",
              detail:
                "Switching to another tab is noted on the Attempt. If the page reloads, what you have written is kept in this browser tab and the section picks up where its clock allows.",
            },
          ]}
          actions={
            <Button variant="primary" onClick={() => void beginAttempt()} loading={isStarting} iconEnd={<IconArrowRight size={16} />}>
              Start Writing Simulation
            </Button>
          }
        />
      </ExamShell>
    );
  }

  // Every running screen's Exit only navigates; the leave guard asks, in words fitting the stage.
  const exit = <ExamExit to={stage === "finishing" && !fullTestRunId && attemptId ? `/attempts/${attemptId}` : leaveTo} asks />;

  // A finished Task the server has not accepted yet: said while the section goes on, with a way to
  // send it now. Not a failure yet — it is kept, and the wrap-up sends it again.
  const unsentNotice =
    unsentTasks.length > 0 && attemptId ? (
      <Notice
        tone="caution"
        live="polite"
        title="Not sent yet"
        action={
          <Button size="sm" onClick={() => unsentTasks.forEach((task) => void sendTask(set, attemptId, task))}>
            Retry now
          </Button>
        }
      >
        <p>
          Your {joinAnd(unsentTasks.map((task) => TASK_TYPES[task].label))} Responses haven't reached the server yet.
          They're kept, and they'll be sent again when the section ends.
        </p>
      </Notice>
    ) : undefined;

  if (stage === "bs-running") {
    return (
      <BuildSentenceTask
        items={set.buildASentence.items}
        mode="simulation"
        chrome={{ section, part: `Build a Sentence · Task 1 of ${TASKS.length}`, exit }}
        onComplete={handleBuildSentenceComplete}
        resume={{ deadlineMs: taskDeadline, slotTexts: bsOpening }}
        onArrangementChange={(itemId, slotTexts) => {
          if (attemptId) writeDraft(attemptId, itemId, { slots: slotTexts });
        }}
      />
    );
  }

  if (stage === "essay-running") {
    const chrome = {
      section,
      part: `${TASK_TYPES[essayTask].label} · Task ${taskNumber(essayTask)} of ${TASKS.length}`,
      exit,
      before: unsentNotice,
    };
    return essayTask === "email" ? (
      <TimedEditor
        key="email"
        task="email"
        materials={set.email}
        seconds={set.email.timeLimitSec}
        deadlineMs={taskDeadline}
        initialText={essayOpening}
        onTextChange={(text) => attemptId && writeDraft(attemptId, set.email.id, { text })}
        onSubmit={handleEssaySubmit}
        chrome={chrome}
      />
    ) : (
      <TimedEditor
        key="discussion"
        task="discussion"
        materials={set.academicDiscussion}
        seconds={set.academicDiscussion.timeLimitSec}
        deadlineMs={taskDeadline}
        initialText={essayOpening}
        onTextChange={(text) => attemptId && writeDraft(attemptId, set.academicDiscussion.id, { text })}
        onSubmit={handleEssaySubmit}
        chrome={chrome}
      />
    );
  }

  if (stage === "held") {
    return (
      <ExamShell section={section} part="Not finished" exit={exit}>
        <SimulationStatus
          title="Some of your Responses haven't reached the server"
          actions={
            <>
              <Button variant="primary" onClick={() => setStage("finishing")}>
                Retry sending
              </Button>
              <Button variant="quiet" onClick={() => guard.leave(leaveTo)}>
                Leave for now
              </Button>
            </>
          }
        >
          <Notice tone="critical" title="Not sent yet">
            <ul className="mt-1 space-y-0.5">
              {unsentTasks.map((task) => (
                <li key={task} className="font-medium text-ink">
                  {TASK_TYPES[task].label}
                </li>
              ))}
            </ul>
          </Notice>
          <p>
            Your text is kept in this browser tab, and the Attempt is not finished until the server has it. If you leave now, coming back
            to this page before you close the tab sends it then.
          </p>
        </SimulationStatus>
      </ExamShell>
    );
  }

  if (stage === "completion-failed") {
    return (
      <ExamShell section={section} part="Not finished" exit={null}>
        <CompletionFailed error={completionError} onRetry={() => setStage("finishing")} onOpenReport={openReportAsItStands}>
          <p>
            Every Response reached the server and is safe. Finishing the Attempt is what gives it a Band Estimate
            {fullTestRunId ? ", and what lets the Full-Test Run go on to the next section" : ""}.
          </p>
        </CompletionFailed>
      </ExamShell>
    );
  }

  // stage === "finishing": normally a moment — the last send and the completion — before the report
  // opens with the essays' judging rendered live there.
  return (
    <ExamShell section={section} part="Wrapping up" exit={exit}>
      <SimulationStatus busy title="Wrapping up…">
        <p>Handing in your Responses. Your report opens in a moment.</p>
        <ul className="divide-y divide-rule rounded-sheet border border-rule bg-sheet" aria-live="polite">
          {TASKS.map((task) => {
            const status = sendStatus[task] === "sent" ? "sent" : sendStatus[task] === "unsent" ? "unsent" : "sending";
            return (
              <li key={task} className="flex items-center justify-between gap-4 px-4 py-3 text-ui">
                <span className="text-ink">{TASK_TYPES[task].label}</span>
                <span className="inline-flex items-center gap-1.5 text-graphite">
                  {status === "sent" ? <IconCheck size={14} /> : status === "unsent" ? <IconCaution size={14} /> : <IconSpinner size={14} />}
                  {status === "sent" ? "Handed in" : status === "unsent" ? "Not sent yet" : "Sending…"}
                </span>
              </li>
            );
          })}
        </ul>
      </SimulationStatus>
    </ExamShell>
  );
}
