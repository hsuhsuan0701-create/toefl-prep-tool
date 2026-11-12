import { useCallback, useEffect, useReducer, useRef, useState } from "react";
import { expectServedSet, routedModule, type ServedReadingSet } from "@toefl-prep/shared";
import { createAttempt, getSet, routeAttempt, scoreDeterministicTask, type SetMeta } from "../../lib/api";
import { requestErrorMessage } from "../../lib/requestError";
import { taskTypeLabel } from "../../lib/taskTypes";
import {
  MODULE_TIME_LIMIT_SEC,
  buildScoreRequests,
  flattenReadingModule,
  readingItemCount,
  readingScreens,
  reduceReadingSim,
} from "../readingSimulation";
import { useLeaveGuard } from "../../hooks/useLeaveGuard";
import { useStageEntry } from "../../hooks/useStageEntry";
import StimulusQuestions from "../../components/StimulusQuestions";
import ModulePathDisclosure from "../../components/ModulePathDisclosure";
import { Button } from "../../ui/Button";
import { ConfirmDialog } from "../../ui/ConfirmDialog";
import { Disclosure } from "../../ui/Disclosure";
import { ExamIntro, ExamSetLine } from "../../ui/ExamIntro";
import { DeadlineClock, ExamExit, ExamShell } from "../../ui/ExamShell";
import { formatDuration } from "../../ui/format";
import { IconArrowLeft, IconArrowRight } from "../../ui/icons";
import { MODULE_LABEL, MODULE_PATH_LABEL } from "../../ui/labels";
import { Notice } from "../../ui/Notice";
import { QuestionNavigator, type NavigatorStop } from "../../ui/QuestionNavigator";
import { CompletionWrapUp, LoadingMain, ErrorMain, SimulationStatus } from "./SimulationScreens";
import {
  fallbackSetTitle,
  findListedSet,
  leaveBeforeCompletedMessage,
  leaveRestartsSectionMessage,
  pickSimulationSet,
  predictRepeat,
  repeatNoticeText,
  sleep,
  useAttemptCompletion,
  useFlagOnHidden,
  useHandOffOnceCompleted,
  type FullTestSectionContext,
} from "./simulationShell";
import { submitModule } from "./submitModule";

// ---------------------------------------------------------------------------
// Reading Simulation: Router Module -> route -> path-reveal -> the routed Lower/Upper Module ->
// complete, driven by readingSimulation.ts's pure reduceReadingSim. Each Module is submitted (and
// the Router Module routed) through submitModule.ts; feedback is deferred to the report.
//
// A Module is sat screen by screen, as on the test: a whole Complete the Words passage on one
// screen, then each question of a Daily Life text or an academic passage beside its text. Within a
// Module the User moves freely — Back, Next, or any stop on the question navigator — and changes any
// Response until the Module is submitted, by the User (after a confirmation that counts the Items
// with no Response) or by its clock.
// ---------------------------------------------------------------------------

const hasResponse = (answers: ReadonlyMap<string, string>, itemId: string) => (answers.get(itemId) ?? "").trim() !== "";


export default function ReadingSimulation({ fullTest }: { fullTest?: FullTestSectionContext }) {
  // Read out once so the hooks below can depend on primitives rather than on an object identity
  // the caller re-creates on every render.
  const fullTestRunId = fullTest?.runId;
  const fullTestSetId = fullTest?.setId;
  const fullTestAttemptId = fullTest?.attemptId;
  const exitTo = fullTestRunId ? `/full-test/${fullTestRunId}` : "/";

  const [pageStage, setPageStage] = useState<"loading" | "error" | "ready">("loading");
  const [set, setSet] = useState<ServedReadingSet | null>(null);
  const [listing, setListing] = useState<SetMeta | null>(null);
  const [errorMsg, setErrorMsg] = useState<string | null>(null);
  const [attemptId, setAttemptId] = useState<string | null>(null);
  const [isStarting, setIsStarting] = useState(false);
  const [isRepeat, setIsRepeat] = useState(false);
  // A manual "Submit Module" is irreversible (it locks the Module server-side, as timer expiry does),
  // so it asks first. Reset only where a new Module starts (beginAttempt, continueToModule2) —
  // resetting on every render would close a confirm the User has open.
  const [confirmingSubmit, setConfirmingSubmit] = useState(false);
  // Whether the clock, not the User, ended the Module now being scored — said on the scoring screen.
  const [endedByClock, setEndedByClock] = useState(false);
  const [simState, dispatch] = useReducer(reduceReadingSim, { stage: "intro" as const });
  // Both Modules run in `module`, so which one is part of the stage's name. Moving between its
  // screens is not a stage change.
  useStageEntry(pageStage === "ready" ? `${simState.stage}:${"module" in simState ? simState.module : ""}` : pageStage);

  const mountedRef = useRef(true);
  const retryRef = useRef<(() => void) | null>(null);
  const startingRef = useRef(false);
  // The last answers seen while a Module was open — what the submitting effect scores from, since the
  // "submitting" stage carries no answers.
  const answersRef = useRef<Map<string, string>>(new Map());
  // Which of the current Module's Task Types the server has already accepted, so "Retry submit"
  // re-sends only what is outstanding (submitModule.ts). Reset only where a new Module starts —
  // never on a retry, which is the whole point.
  const acceptedTaskTypesRef = useRef<Set<string>>(new Set());

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
    };
  }, []);

  useEffect(() => {
    if (simState.stage === "module") answersRef.current = simState.answers;
  }, [simState]);

  const loadSet = useCallback(async () => {
    setPageStage("loading");
    setErrorMsg(null);
    try {
      // Inside a Full-Test Run the Set is the one the Run drew (the server refuses any other),
      // looked up in the bank only for its title and `attempted` flag; standalone, the automatic
      // pick. predictRepeat lets the intro disclose a Repeat before the User commits about 30
      // minutes.
      const entry = fullTestSetId ? await findListedSet(fullTestSetId) : await pickSimulationSet("reading");
      const s = await getSet(fullTestSetId ?? entry!.id);
      const repeat = await predictRepeat(entry, fullTestAttemptId);
      if (!mountedRef.current) return;
      setSet(expectServedSet("reading", s));
      setListing(entry);
      setIsRepeat(repeat);
      setPageStage("ready");
    } catch (e) {
      if (!mountedRef.current) return;
      setErrorMsg(requestErrorMessage(e));
      retryRef.current = () => void loadSet();
      setPageStage("error");
    }
  }, [fullTestSetId, fullTestAttemptId]);

  useEffect(() => {
    void loadSet();
  }, [loadSet]);

  useFlagOnHidden(attemptId, pageStage === "ready" && simState.stage !== "intro");

  // Terminal, once both Modules are scored: complete the Attempt, retrying, and show a failure
  // rather than pass over it.
  const completion = useAttemptCompletion(simState.stage === "complete", attemptId, "reading simulation");

  // From the first Module until the Attempt is completed: leaving in that window leaves the Attempt
  // unfinished, with no way back into the section.
  const guard = useLeaveGuard(
    attemptId !== null && simState.stage !== "intro" && completion.status !== "completed",
    simState.stage === "complete" ? leaveBeforeCompletedMessage("Reading") : leaveRestartsSectionMessage("Reading"),
  );

  const beginAttempt = useCallback(async () => {
    if (!set || startingRef.current) return;
    startingRef.current = true;
    setIsStarting(true);
    setErrorMsg(null);
    try {
      const res = await createAttempt({
        kind: "reading",
        mode: "simulation",
        setId: set.id,
        ...(fullTestRunId ? { fullTestRunId } : {}),
      });
      if (!mountedRef.current) return;
      setAttemptId(res.attemptId);
      // The server's answer is the one that decided the Attempt's own Repeat tag, so it wins over
      // the intro's earlier read.
      setIsRepeat(res.isRepeat);
      acceptedTaskTypesRef.current = new Set();
      setConfirmingSubmit(false);
      setEndedByClock(false);
      dispatch({ type: "begin" });
    } catch (e) {
      if (!mountedRef.current) return;
      setErrorMsg(requestErrorMessage(e));
    } finally {
      startingRef.current = false;
      if (mountedRef.current) setIsStarting(false);
    }
  }, [set, fullTestRunId]);

  // A fresh Module 2 (Lower/Upper) is a genuinely new Module — see acceptedTaskTypesRef's own doc
  // comment for why this must reset alongside beginAttempt's, not on every "module" render.
  const continueToModule2 = useCallback(() => {
    acceptedTaskTypesRef.current = new Set();
    setConfirmingSubmit(false);
    setEndedByClock(false);
    dispatch({ type: "continue-to-module2" });
  }, []);

  // The Module submit itself is submitModule.ts, shared with the Listening Simulation; this is its
  // React half. The switch is exhaustive so a new outcome fails to compile here.
  useEffect(() => {
    if (simState.stage !== "submitting" || !attemptId || !set) return;
    const module = simState.module;
    let cancelled = false;
    (async () => {
      const outcome = await submitModule({
        attemptId,
        module,
        requests: buildScoreRequests(set, module, answersRef.current),
        acceptedTaskTypes: acceptedTaskTypesRef.current,
        scoreTaskType: scoreDeterministicTask,
        route: routeAttempt,
        clock: { now: () => Date.now(), sleep },
        stillActive: () => !cancelled && mountedRef.current,
        section: "reading",
        log: (message, error) => console.error(message, error),
      });
      switch (outcome.kind) {
        case "routed":
          dispatch({ type: "routed", path: outcome.path });
          return;
        case "module2-scored":
          dispatch({ type: "module2-scored" });
          return;
        case "submit-error":
          dispatch({ type: "submit-error" });
          return;
        // The component is gone or superseded — dispatching anything would be the bug this outcome
        // exists to name.
        case "abandoned":
          return;
        default: {
          const unhandled: never = outcome;
          throw new Error(`unhandled module submit outcome: ${String(unhandled)}`);
        }
      }
    })();
    return () => {
      cancelled = true;
    };
    // Deliberately keyed on `simState.stage` alone (not the rest of simState, which TS also can't
    // narrow `.module` off of outside the effect body) — every entry into "submitting" comes from a
    // different stage ("module", or "submit-failed" on a retry), so this fires exactly once per
    // submit attempt. `answers` are read from answersRef rather than the dependency array so scoring
    // a Module does not re-fire on every keystroke made while it was still open.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [simState.stage, attemptId, set]);

  // Only a completed Attempt hands off: to the report, or inside a Run to the Run.
  useHandOffOnceCompleted(
    simState.stage === "complete" && completion.status === "completed",
    attemptId,
    guard.leave,
    "reading",
    fullTestRunId,
  );

  if (pageStage === "loading") return <LoadingMain label="Loading the Set…" />;
  if (pageStage === "error") {
    return (
      <ErrorMain
        message={errorMsg ?? "Something went wrong."}
        onRetry={retryRef.current}
        fullTestRunId={fullTestRunId}
      />
    );
  }
  if (!set) return null;

  // In-section exits navigate, and the leave guard asks first while the section is running.
  const exitButton = <ExamExit to={exitTo} asks />;
  const repeatNotice = isRepeat ? <Notice tone="caution">{repeatNoticeText("Reading")}</Notice> : null;

  if (simState.stage === "intro") {
    const setTitle = listing?.title ?? fallbackSetTitle("Reading", set.createdAt);
    const routerTime = MODULE_TIME_LIMIT_SEC.router;
    const secondTime = MODULE_TIME_LIMIT_SEC.lower;
    return (
      <ExamShell
        section="Reading"
        part={fullTestRunId ? "Full-Test Run" : "Simulation"}
        exit={<ExamExit to={exitTo} asks={false} />}
      >
        <ExamIntro
          // Inside a Full-Test Run the section leads and its Set follows; on its own, the Set leads.
          kicker={fullTestRunId ? "Full-Test Run · Section 1 of 4" : "Reading Simulation"}
          title={fullTestRunId ? "Reading section" : setTitle}
          meta={
            <>
              {fullTestRunId && <span className="font-medium text-ink-soft">{setTitle}</span>}
              <ExamSetLine source={set.source} createdAt={set.createdAt} setId={set.id} />
            </>
          }
          notice={repeatNotice}
          facts={[
            {
              term: "Time",
              detail: `${formatDuration(routerTime + secondTime)} in all: ${formatDuration(routerTime)} for the Router Module, then ${formatDuration(secondTime)} for the next Module. Each Module has its own clock.`,
            },
            {
              term: "Items",
              detail: `${readingItemCount(set.router)} Items in the Router Module, then ${readingItemCount(set.lowerModule)} in the Lower Module or ${readingItemCount(set.upperModule)} in the Upper Module.`,
            },
            {
              term: "Moving around",
              detail: "Within a Module, go back to any question and change your Response until you submit the Module. A submitted Module is final.",
            },
            {
              term: "Feedback",
              detail: "After the last Module: your Band Estimate, then the key and the Explanation for every Item.",
            },
            {
              term: "Leaving",
              detail: "Switching to another tab is noted on the Attempt. Leaving the section ends it; it can't be resumed.",
            },
          ]}
          actions={
            <Button variant="primary" iconEnd={<IconArrowRight size={16} />} onClick={() => void beginAttempt()} loading={isStarting}>
              Start Reading Simulation
            </Button>
          }
        >
          <Disclosure summary="How the second Module is chosen">
            <p>
              Your Router Module score picks it: 60% correct or more routes you to the Upper Module, below that to the Lower
              Module. The 60% threshold is this app's assumption; ETS does not publish its rule. A Band Estimate from the Lower
              Module is capped at 4.5.
            </p>
          </Disclosure>
          {errorMsg && (
            <Notice tone="critical" live="assertive" title="The Simulation didn't start">
              {errorMsg}
            </Notice>
          )}
        </ExamIntro>
      </ExamShell>
    );
  }

  if (simState.stage === "module") {
    const moduleLabel = MODULE_LABEL[simState.module];
    const stimuli = flattenReadingModule(routedModule(set, simState.module));
    const screens = readingScreens(stimuli);
    // Unreachable for a Set that passed generation (READING_MODULE_COMPOSITION), but the Module must
    // still be submittable rather than a blank page with no way forward.
    if (screens.length === 0) {
      return (
        <ExamShell
          section="Reading"
          part={<span>{moduleLabel}</span>}
          exit={exitButton}
          footer={
            <Button variant="primary" className="ml-auto" onClick={() => dispatch({ type: "submit-module" })}>
              Submit Module
            </Button>
          }
        >
          <Notice tone="caution">This Module has no questions to show.</Notice>
        </ExamShell>
      );
    }
    const itemTotal = screens.reduce((n, sc) => n + sc.itemIds.length, 0);
    const found = screens.findIndex(
      (sc) => sc.stimulusIdx === simState.visitedStimulusIdx && sc.questionIdx === (simState.visitedQuestionIdx ?? 0),
    );
    const screenIdx = Math.max(0, found);
    const current = screens[screenIdx];
    const stimulus = stimuli[current.stimulusIdx];
    const lastItem = current.firstItem + current.itemIds.length - 1;
    const isLast = screenIdx === screens.length - 1;
    const unanswered = screens.reduce((n, sc) => n + sc.itemIds.filter((id) => !hasResponse(simState.answers, id)).length, 0);
    const go = (i: number) => dispatch({ type: "navigate", stimulusIdx: screens[i].stimulusIdx, questionIdx: screens[i].questionIdx });
    const stops: NavigatorStop[] = screens.map((sc) => {
      const last = sc.firstItem + sc.itemIds.length - 1;
      const range = sc.itemIds.length > 1;
      return {
        key: `${sc.stimulusIdx}:${sc.questionIdx}`,
        label: range ? `${sc.firstItem}–${last}` : String(sc.firstItem),
        name: range ? `Questions ${sc.firstItem} to ${last}` : `Question ${sc.firstItem}`,
        answered: sc.itemIds.filter((id) => hasResponse(simState.answers, id)).length,
        total: sc.itemIds.length,
      };
    });

    return (
      <ExamShell
        section="Reading"
        part={
          <>
            <span>{moduleLabel}</span> · <span>{taskTypeLabel(stimulus.taskType)}</span>
          </>
        }
        // Against the wall clock: a system suspend mid-Module costs the time it took rather than
        // pausing the exam clock.
        clock={
          <DeadlineClock
            key={simState.module}
            label="Time remaining in this Module"
            deadlineMs={simState.deadlineMs}
            onExpire={() => {
              setEndedByClock(true);
              dispatch({ type: "timer-expired" });
            }}
          />
        }
        exit={exitButton}
        progress={{
          current: lastItem,
          total: itemTotal,
          label: current.itemIds.length > 1 ? `Questions ${current.firstItem}–${lastItem} of ${itemTotal}` : `Question ${current.firstItem} of ${itemTotal}`,
        }}
        footer={
          <>
            <Button icon={<IconArrowLeft size={16} />} onClick={() => go(screenIdx - 1)} disabled={screenIdx === 0}>
              Back
            </Button>
            <div className="flex items-center gap-2">
              <Button variant={isLast ? "primary" : "quiet"} onClick={() => setConfirmingSubmit(true)}>
                Submit Module…
              </Button>
              {!isLast && (
                <Button variant="primary" iconEnd={<IconArrowRight size={16} />} onClick={() => go(screenIdx + 1)}>
                  Next
                </Button>
              )}
            </div>
          </>
        }
      >
        <QuestionNavigator stops={stops} current={screenIdx} onSelect={go} className="mb-8 sm:mb-10" />
        {/* Keyed per screen: a new screen mounts fresh and takes focus. The Responses live in the
            reducer, so nothing typed is lost when a screen unmounts. No `results`: a Simulation's
            feedback is deferred to the report. */}
        <StimulusQuestions
          key={`${stimulus.id}:${current.questionIdx}`}
          stimulus={stimulus}
          reveal={{ policy: "one-at-a-time", questionIdx: current.questionIdx }}
          answers={simState.answers}
          onAnswer={(itemId, value) => dispatch({ type: "answer", itemId, value })}
          autoFocus
        />
        <ConfirmDialog
          open={confirmingSubmit}
          title={`Submit the ${moduleLabel}?`}
          confirmLabel="Submit Module"
          cancelLabel="Keep working"
          onCancel={() => setConfirmingSubmit(false)}
          onConfirm={() => {
            setConfirmingSubmit(false);
            dispatch({ type: "submit-module" });
          }}
        >
          {unanswered > 0 && (
            <p>
              {unanswered} of {itemTotal} {itemTotal === 1 ? "Item has" : "Items have"} no Response. As on the test, they will
              score 0.
            </p>
          )}
          <p>After you submit, you can't change any Response in this Module.</p>
        </ConfirmDialog>
      </ExamShell>
    );
  }

  if (simState.stage === "submitting") {
    const moduleLabel = MODULE_LABEL[simState.module];
    return (
      <ExamShell section="Reading" part={moduleLabel} exit={null}>
        <SimulationStatus busy title={`Scoring the ${moduleLabel}…`}>
          {endedByClock && <p>Time ran out, so the Module was submitted as it stood.</p>}
          <p>
            {simState.module === "router"
              ? "Then you'll go on to the Lower or the Upper Module."
              : "Your report opens as soon as it's done."}
          </p>
        </SimulationStatus>
      </ExamShell>
    );
  }

  if (simState.stage === "submit-failed") {
    const moduleLabel = MODULE_LABEL[simState.module];
    // Reached only once a request's retry budget is exhausted — never while it is still retrying.
    // "Retry submit" re-sends only the Task Types the server has not accepted.
    return (
      <ExamShell section="Reading" part={moduleLabel} exit={null}>
        <SimulationStatus
          title={`Couldn't submit the ${moduleLabel}`}
          actions={
            <>
              <Button variant="primary" onClick={() => dispatch({ type: "retry-submit" })}>
                Retry submit
              </Button>
              {attemptId && (
                <Button variant="quiet" onClick={() => guard.leave(fullTestRunId ? exitTo : `/attempts/${attemptId}`)}>
                  {fullTestRunId ? "Back to the Full-Test Run" : "View this Attempt instead"}
                </Button>
              )}
            </>
          }
        >
          <Notice tone="critical">
            Some Responses didn't reach the server, usually because the connection dropped. Nothing already sent is lost:
            Retry sends only what is still missing.
          </Notice>
          <p>Leaving now leaves this Attempt unfinished: it is not routed and gets no Band Estimate.</p>
        </SimulationStatus>
      </ExamShell>
    );
  }

  if (simState.stage === "path-reveal") {
    const pathLabel = MODULE_PATH_LABEL[simState.path];
    const nextModule = simState.path === "lower" ? set.lowerModule : set.upperModule;
    return (
      <ExamShell section="Reading" part="Router Module submitted" exit={exitButton}>
        <SimulationStatus
          title={`Module Path: ${pathLabel}`}
          actions={
            <Button variant="primary" iconEnd={<IconArrowRight size={16} />} onClick={continueToModule2}>
              Start the {pathLabel}
            </Button>
          }
        >
          <p>
            Your Router Module routed you to the {pathLabel}: {readingItemCount(nextModule)} Items in{" "}
            {formatDuration(MODULE_TIME_LIMIT_SEC[simState.path])}. Its clock starts when you do.
          </p>
          {simState.path === "lower" && (
            <Notice tone="caution">
              <ModulePathDisclosure modulePath={simState.path} />
            </Notice>
          )}
          <Disclosure summary="How the second Module is chosen">
            <p>
              60% correct or more in the Router Module routes to the Upper Module. That threshold is this app's assumption; ETS
              does not publish its rule.
            </p>
          </Disclosure>
        </SimulationStatus>
      </ExamShell>
    );
  }

  // simState.stage === "complete"
  return (
    <ExamShell section="Reading" part="Both Modules submitted" exit={null}>
      <CompletionWrapUp
        completion={completion}
        fullTestRunId={fullTestRunId}
        onOpenReport={() => attemptId && guard.leave(`/attempts/${attemptId}`)}
        notice={repeatNotice}
      />
    </ExamShell>
  );
}
