import { useCallback, useState } from "react";
import { useParams } from "react-router-dom";
import type { ServedReadingSet, ServedReadingStimulus } from "@toefl-prep/shared";
import type { StimulusItemResult } from "../components/StimulusQuestions";
import DrillBandEstimateNotice from "../components/DrillBandEstimateNotice";
import { TASK_TYPES } from "../lib/taskTypes";
import { ExamSetLine } from "../ui/ExamIntro";
import { useDrillShell, useListedSet } from "./drill/drillShell";
import { fallbackSetTitle } from "./simulation/simulationShell";
import { DrillErrorScreen, DrillIntroScreen, DrillLoadingScreen, DrillPickerScreen } from "./drill/DrillScreens";
import StimulusQueueRun, { StimulusQueueResults } from "./drill/StimulusQueueRun";
import { deterministicScoreRequest, stimulusCountLabel } from "./drill/stimulusQueue";

// Reading Drill: pick a Task Type (or all three), then work through the Router Module's Stimuli of
// that Task Type one at a time, submitting each Stimulus's Items together and seeing feedback before
// moving on. A Drill only ever takes the Router Module (the Lower/Upper split exists only for a
// routed Simulation, ADR 0005), so this page never reads `lowerModule` or `upperModule`.
//
// Loading the Set, the error screen, the picker, the intro, creating the Attempt (and its Repeat
// tag) and the finish-and-navigate rule belong to the shared Drill shell (./drill/), and the run
// body, the queue itself, is ./drill/StimulusQueueRun.tsx, shared with the Listening Drill. What is
// left here is this section's own vocabulary: which Task Types it offers, which of the Router
// Module's fields hold their Stimuli, and what the intro says.

type ReadingTaskType = "complete_words" | "daily_life" | "academic_passage";

// The served Stimulus shapes come from `shared` (servedSet.ts), derived from the Set schemas by the
// same Omit stripAnswers performs; this page declares none of them itself.
type Stimulus = ServedReadingStimulus;

const TASK_OPTIONS: { label: string; kinds: ReadingTaskType[] }[] = [
  { label: TASK_TYPES.complete_words.label, kinds: ["complete_words"] },
  { label: TASK_TYPES.daily_life.label, kinds: ["daily_life"] },
  { label: TASK_TYPES.academic_passage.label, kinds: ["academic_passage"] },
  { label: "All three Task Types", kinds: ["complete_words", "daily_life", "academic_passage"] },
];

// A Reading Band Estimate comes only from a routed Simulation: a Drill sees only the Router Module,
// so there is nothing to route and nothing to look up in Table 3. `DrillBandEstimateNotice` says so
// where a User might expect a band from a Drill (the picker here, and the results screen).

function stimuliForKinds(router: ServedReadingSet["router"], kinds: ReadingTaskType[]): Stimulus[] {
  const out: Stimulus[] = [];
  for (const kind of kinds) {
    if (kind === "complete_words") out.push(...router.ctwPassages);
    else if (kind === "daily_life") out.push(...router.dailyLife);
    else out.push(...router.academic);
  }
  return out;
}

type Stage = "picker" | "intro" | "stimulus" | "drill-done";

export default function ReadingDrill() {
  const { setId } = useParams<{ setId: string }>();
  const drill = useDrillShell("reading", setId);
  const listed = useListedSet("reading", setId);
  const { beginAttempt, fail, finish } = drill;

  const [stage, setStage] = useState<Stage>("picker");
  const [queue, setQueue] = useState<Stimulus[]>([]);
  const [picked, setPicked] = useState<string>("");
  const [results, setResults] = useState<readonly StimulusItemResult[]>([]);

  const handlePick = useCallback(
    (label: string, kinds: ReadingTaskType[]) => {
      if (!drill.set) return;
      setQueue(stimuliForKinds(drill.set.router, kinds));
      setPicked(label);
      setStage("intro");
    },
    [drill.set],
  );

  const handleStart = useCallback(async () => {
    if (!setId || queue.length === 0) return;
    try {
      await beginAttempt();
      setResults([]);
      setStage("stimulus");
    } catch (e) {
      fail(e);
    }
  }, [setId, queue, beginAttempt, fail]);

  const handleComplete = useCallback((runResults: readonly StimulusItemResult[]) => {
    setResults(runResults);
    setStage("drill-done");
  }, []);

  if (drill.phase === "loading") return <DrillLoadingScreen />;
  // No `retry`: a failed submit shows inline on its Stimulus, so only a failed Set load or Attempt
  // start reaches this screen, and it offers only the way back.
  if (drill.phase === "error") return <DrillErrorScreen message={drill.errorMsg} />;

  const set = drill.set;
  if (!set) return null;

  const setLine = <ExamSetLine source={set.source} createdAt={set.createdAt} setId={set.id} />;
  const setTitle = listed?.title ?? fallbackSetTitle("Reading", set.createdAt);

  if (stage === "picker") {
    return (
      <DrillPickerScreen
        section="Reading"
        setTitle={setTitle}
        meta={setLine}
        subtitle="Choose what to practise. After each Stimulus you see what you got right, the key and the Explanation."
        notice={<DrillBandEstimateNotice />}
        options={TASK_OPTIONS.map((opt) => {
          const count = stimulusCountLabel(stimuliForKinds(set.router, opt.kinds).length);
          return {
            label: opt.label,
            detail: opt.kinds.length > 1 ? `${count}: Complete the Words, Read in Daily Life, then Read an Academic Passage` : count,
            onPick: () => handlePick(opt.label, opt.kinds),
          };
        })}
      />
    );
  }

  if (stage === "intro") {
    const items = queue.reduce((n, s) => n + deterministicScoreRequest(s, new Map()).items.length, 0);
    return (
      <DrillIntroScreen
        section="Reading"
        heading={picked}
        meta={setTitle}
        backLabel="Change Task Type"
        onBack={() => setStage("picker")}
        onStart={handleStart}
        facts={[
          { term: "Stimuli", detail: `${stimulusCountLabel(queue.length)} from the Router Module, ${items} Items in all.` },
          { term: "Time", detail: "Untimed. Take as long as you need." },
          {
            term: "Feedback",
            detail: "After each Stimulus: Correct or Incorrect for every Item, the key, and the Explanation.",
          },
        ]}
      />
    );
  }

  if (stage === "stimulus") {
    return (
      <StimulusQueueRun stimuli={queue} attemptId={drill.attemptId} onComplete={handleComplete} exitTo="/" />
    );
  }

  // stage === "drill-done"
  return (
    <StimulusQueueResults
      results={results}
      stimuli={queue}
      isRepeat={drill.isRepeat}
      onFinish={() => finish()}
      completion={drill.completion}
      onReview={drill.attemptId ? () => finish(`/attempts/${drill.attemptId}`) : undefined}
    />
  );
}
