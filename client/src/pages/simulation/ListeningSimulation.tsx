import { useCallback, useEffect, useRef, useState } from "react";
import { expectServedSet, routedModule, type ServedListeningSet } from "@toefl-prep/shared";
import { createAttempt, flagAttempt, getSet, routeAttempt, scoreDeterministicTask, type SetMeta } from "../../lib/api";
import { requestErrorMessage } from "../../lib/requestError";
import { taskTypeLabel } from "../../lib/taskTypes";
import {
  buildScoreRequests,
  flattenListeningModule,
  listeningItemCount,
  questionCountFor,
  reduceListeningSim,
  type ListeningSimEvent,
  type ListeningSimState,
} from "../listeningSimulation";
import { ListeningStimulusQuestions } from "../../components/StimulusQuestions";
import { useLeaveGuard } from "../../hooks/useLeaveGuard";
import ModulePathDisclosure from "../../components/ModulePathDisclosure";
import { Button } from "../../ui/Button";
import { Disclosure } from "../../ui/Disclosure";
import { ExamIntro, ExamSetLine } from "../../ui/ExamIntro";
import { ExamExit, ExamShell, StageHeading } from "../../ui/ExamShell";
import { formatDuration } from "../../ui/format";
import { IconArrowRight } from "../../ui/icons";
import { MODULE_LABEL, MODULE_PATH_LABEL } from "../../ui/labels";
import { Notice } from "../../ui/Notice";
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
// Listening Simulation: Router Module -> route -> path-reveal -> the routed Lower/Upper Module ->
// complete, driven by listeningSimulation.ts's pure reduceListeningSim. Unlike Reading it is
// lockstep: a Stimulus (who is speaking -> its audio, once -> its Question(s), one at a time) is the
// unit of progress, there is no Module clock (the audio sets the pace), and there is no going back.
//
// The Stimulus is rendered by StimulusQuestions.tsx's ListeningStimulusQuestions — the leak gate,
// shared with the Listening Drill — in its lockstep `one-at-a-time` reveal, with this screen's Next
// button passed in as the gate's `children`. A Stimulus whose audio will not play is reloaded on its
// own (LISTENING_AUDIO_AUTO_RETRIES), then waits on that gate's audio-failed phase until the User
// retries or skips it.
// ---------------------------------------------------------------------------

export default function ListeningSimulation({ fullTest }: { fullTest?: FullTestSectionContext }) {
  // Read out once so the hooks below depend on primitives, not an object the caller re-creates.
  const fullTestRunId = fullTest?.runId;
  const fullTestSetId = fullTest?.setId;
  const fullTestAttemptId = fullTest?.attemptId;
  const exitTo = fullTestRunId ? `/full-test/${fullTestRunId}` : "/";

  const [pageStage, setPageStage] = useState<"loading" | "error" | "ready">("loading");
  const [set, setSet] = useState<ServedListeningSet | null>(null);
  const [listing, setListing] = useState<SetMeta | null>(null);
  const [errorMsg, setErrorMsg] = useState<string | null>(null);
  const [attemptId, setAttemptId] = useState<string | null>(null);
  const [isStarting, setIsStarting] = useState(false);
  const [isRepeat, setIsRepeat] = useState(false);
  const [simState, setSimState] = useState<ListeningSimState>({ stage: "intro" });

  const mountedRef = useRef(true);
  const retryRef = useRef<(() => void) | null>(null);
  const startingRef = useRef(false);
  // The last answers seen while a Stimulus was open — what the submitting effect scores from.
  const answersRef = useRef<Map<string, string>>(new Map());
  // Which of the current Module's Task Types the server has already accepted (submitModule.ts).
  // Reset only where a new Module starts — never on a retry.
  const acceptedTaskTypesRef = useRef<Set<string>>(new Set());

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
    };
  }, []);

  useEffect(() => {
    if (simState.stage === "stimulus") answersRef.current = simState.answers;
  }, [simState]);

  // reduceListeningSim needs the Set as a third argument, which only exists once loaded, so this is
  // a plain setState with a wrapped dispatch rather than useReducer. Every event comes from UI that
  // renders only once the Set is loaded.
  const dispatch = useCallback(
    (ev: ListeningSimEvent) => {
      setSimState((prev) => (set ? reduceListeningSim(prev, ev, set) : prev));
    },
    [set],
  );

  const loadSet = useCallback(async () => {
    setPageStage("loading");
    setErrorMsg(null);
    try {
      // Inside a Full-Test Run the Set is the one the Run drew (the server refuses any other),
      // looked up in the bank only for its title and `attempted` flag; standalone, the automatic
      // pick. predictRepeat lets the intro disclose a Repeat before the User starts.
      const entry = fullTestSetId ? await findListedSet(fullTestSetId) : await pickSimulationSet("listening");
      const s = await getSet(fullTestSetId ?? entry!.id);
      const repeat = await predictRepeat(entry, fullTestAttemptId);
      if (!mountedRef.current) return;
      setSet(expectServedSet("listening", s));
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

  // A Stimulus stopped on the audio-failed gate is an interruption the Attempt's record should show,
  // the way leaving the tab does.
  const audioGated = simState.stage === "stimulus" && simState.phase === "audio-failed";
  useEffect(() => {
    if (audioGated && attemptId) void flagAttempt(attemptId).catch(() => {});
  }, [audioGated, attemptId]);

  // Terminal, once both Modules are scored: complete the Attempt, retrying, and show a failure
  // rather than pass over it.
  const completion = useAttemptCompletion(simState.stage === "complete", attemptId, "listening simulation");

  // From the first Stimulus until the Attempt is completed: leaving in that window leaves the
  // Attempt unfinished, with no way back into the section.
  const guard = useLeaveGuard(
    attemptId !== null && simState.stage !== "intro" && completion.status !== "completed",
    simState.stage === "complete" ? leaveBeforeCompletedMessage("Listening") : leaveRestartsSectionMessage("Listening"),
  );

  const beginAttempt = useCallback(async () => {
    if (!set || startingRef.current) return;
    startingRef.current = true;
    setIsStarting(true);
    setErrorMsg(null);
    try {
      const res = await createAttempt({
        kind: "listening",
        mode: "simulation",
        setId: set.id,
        ...(fullTestRunId ? { fullTestRunId } : {}),
      });
      if (!mountedRef.current) return;
      setAttemptId(res.attemptId);
      setIsRepeat(res.isRepeat);
      acceptedTaskTypesRef.current = new Set();
      setSimState({ stage: "intro" });
      dispatch({ type: "begin" });
    } catch (e) {
      if (!mountedRef.current) return;
      setErrorMsg(requestErrorMessage(e));
    } finally {
      startingRef.current = false;
      if (mountedRef.current) setIsStarting(false);
    }
  }, [set, dispatch, fullTestRunId]);

  // A fresh Module 2 (Lower/Upper) is a genuinely new Module, so the accepted Task Types reset here
  // (acceptedTaskTypesRef's comment above).
  const continueToModule2 = useCallback(() => {
    acceptedTaskTypesRef.current = new Set();
    dispatch({ type: "continue-to-module2" });
  }, [dispatch]);

  // The Module submit itself is submitModule.ts, shared with the Reading Simulation; this is its
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
        section: "listening",
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
    // Keyed on `simState.stage`: every entry into "submitting" comes from a different stage
    // ("stimulus", or "submit-failed" on a retry), so this fires once per submit attempt; answers
    // are read from answersRef.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [simState.stage, attemptId, set]);

  // Only a completed Attempt hands off: to the report, or inside a Run to the Run.
  useHandOffOnceCompleted(
    simState.stage === "complete" && completion.status === "completed",
    attemptId,
    guard.leave,
    "listening",
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
  const repeatNotice = isRepeat ? <Notice tone="caution">{repeatNoticeText("Listening")}</Notice> : null;

  if (simState.stage === "intro") {
    const setTitle = listing?.title ?? fallbackSetTitle("Listening", set.createdAt);
    return (
      <ExamShell
        section="Listening"
        part={fullTestRunId ? "Full-Test Run" : "Simulation"}
        exit={<ExamExit to={exitTo} asks={false} />}
      >
        <ExamIntro
          // Inside a Full-Test Run the section leads and its Set follows; on its own, the Set leads.
          kicker={fullTestRunId ? "Full-Test Run · Section 2 of 4" : "Listening Simulation"}
          title={fullTestRunId ? "Listening section" : setTitle}
          meta={
            <>
              {fullTestRunId && <span className="font-medium text-ink-soft">{setTitle}</span>}
              <ExamSetLine source={set.source} createdAt={set.createdAt} setId={set.id} />
            </>
          }
          notice={repeatNotice}
          facts={[
            { term: "Time", detail: `${sectionLength(set)}, paced by the audio. There is no Module clock.` },
            {
              term: "Items",
              detail: `${listeningItemCount(set.router)} Items in the Router Module, then ${listeningItemCount(set.lowerModule)} in the Lower Module or ${listeningItemCount(set.upperModule)} in the Upper Module.`,
            },
            {
              term: "Listening",
              detail: "Each Stimulus plays once, then its questions follow one at a time. There is no replay and no going back.",
            },
            {
              term: "If audio fails",
              detail: "A Stimulus that won't play waits for you to retry it, and nothing is timed while it waits.",
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
              Start Listening Simulation
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

  if (simState.stage === "stimulus") {
    const moduleLabel = MODULE_LABEL[simState.module];
    const stimuli = flattenListeningModule(routedModule(set, simState.module));
    const stimulus = stimuli[simState.idx];
    // Unreachable for a Set that passed generation (LISTENING_MODULE_COMPOSITION), but a blank page
    // with no way forward would be worse than saying so.
    if (!stimulus) return <ErrorMain message="This Module has no Stimuli to show." onRetry={null} fullTestRunId={fullTestRunId} />;

    // Which Item the lockstep beat is on — the Simulation's own bookkeeping (`questionIdx` is its
    // state), read here only to decide whether "Next" is allowed yet. A listen_choose Stimulus is
    // its one Item, exactly as listeningSimulation.ts's own questionCountFor reads it.
    const currentItemId =
      stimulus.taskType === "listen_choose" ? stimulus.id : stimulus.questions[simState.questionIdx].id;
    const lastOfModule = simState.idx === stimuli.length - 1 && simState.questionIdx === questionCountFor(stimulus) - 1;

    return (
      <ExamShell
        section="Listening"
        part={
          <>
            <span>{moduleLabel}</span> · <span>{taskTypeLabel(stimulus.taskType)}</span>
          </>
        }
        exit={exitButton}
        progress={{ current: simState.idx + 1, total: stimuli.length, label: `Stimulus ${simState.idx + 1} of ${stimuli.length}` }}
      >
        <div className="mx-auto max-w-measure space-y-6">
          <StageHeading key={`heading-${stimulus.id}`}>{taskTypeLabel(stimulus.taskType)}</StageHeading>
          <ListeningStimulusQuestions
            key={stimulus.id}
            stimulus={stimulus}
            phase={simState.phase}
            // Lockstep: one Question at a time, no going back. The Drills reveal all at once.
            reveal={{ policy: "one-at-a-time", questionIdx: simState.questionIdx }}
            answers={simState.answers}
            onAvatarSettled={() => dispatch({ type: "avatar-settled" })}
            onAudioEnded={() => dispatch({ type: "audio-ended" })}
            onAudioError={() => dispatch({ type: "audio-error" })}
            audioTry={simState.audioTry}
            onAudioRetry={() => dispatch({ type: "retry-audio" })}
            onAudioSkip={() => dispatch({ type: "skip-stimulus" })}
            audioFailedNote={
              <>
                <p>Its questions stay hidden until it plays. Nothing is timed while this is up, and the Attempt is marked as interrupted.</p>
                <p className="mt-1">Skipping scores this Stimulus's questions as unanswered.</p>
              </>
            }
            onAnswer={(itemId, optionId) => dispatch({ type: "answer", itemId, optionId })}
            autoFocus
            // No `results`: a Simulation's feedback (the key and the Explanation) is deferred to the
            // report.
          >
            <div className="flex flex-wrap items-center justify-end gap-x-4 gap-y-2 border-t border-rule pt-4">
              {lastOfModule && <p className="text-meta text-graphite">Next submits the {moduleLabel}.</p>}
              <Button
                variant="primary"
                iconEnd={<IconArrowRight size={16} />}
                onClick={() => dispatch({ type: "next-question" })}
                disabled={!simState.answers.has(currentItemId)}
              >
                Next
              </Button>
            </div>
          </ListeningStimulusQuestions>
        </div>
      </ExamShell>
    );
  }

  if (simState.stage === "submitting") {
    const moduleLabel = MODULE_LABEL[simState.module];
    return (
      <ExamShell section="Listening" part={moduleLabel} exit={null}>
        <SimulationStatus busy title={`Scoring the ${moduleLabel}…`}>
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
    return (
      <ExamShell section="Listening" part={moduleLabel} exit={null}>
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
      <ExamShell section="Listening" part="Router Module submitted" exit={exitButton}>
        <SimulationStatus
          title={`Module Path: ${pathLabel}`}
          actions={
            <Button variant="primary" iconEnd={<IconArrowRight size={16} />} onClick={continueToModule2}>
              Start the {pathLabel}
            </Button>
          }
        >
          <p>
            Your Router Module routed you to the {pathLabel}: {listeningItemCount(nextModule)} Items. Its first Stimulus plays
            as soon as you start.
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
    <ExamShell section="Listening" part="Both Modules submitted" exit={null}>
      <CompletionWrapUp
        completion={completion}
        fullTestRunId={fullTestRunId}
        onOpenReport={() => attemptId && guard.leave(`/attempts/${attemptId}`)}
        notice={repeatNotice}
      />
    </ExamShell>
  );
}

/**
 * How long the section takes, from the Modules' served budgets: there is no clock, so this is only
 * what to expect ("About 25 to 29 min").
 */
function sectionLength(set: ServedListeningSet): string {
  const lower = formatDuration(set.router.timeLimitSec + set.lowerModule.timeLimitSec);
  const upper = formatDuration(set.router.timeLimitSec + set.upperModule.timeLimitSec);
  return lower === upper ? `About ${lower}` : `About ${lower.replace(/ min$/, "")} to ${upper}`;
}
