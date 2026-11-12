import { useCallback, useState } from "react";
import { useParams } from "react-router-dom";
import type { ServedListeningSet, ServedListeningStimulus } from "@toefl-prep/shared";
import type { StimulusItemResult } from "../components/StimulusQuestions";
import DrillBandEstimateNotice from "../components/DrillBandEstimateNotice";
import { TASK_TYPES } from "../lib/taskTypes";
import { ExamSetLine } from "../ui/ExamIntro";
import { useStageEntry } from "../hooks/useStageEntry";
import { useDrillShell, useListedSet } from "./drill/drillShell";
import { fallbackSetTitle } from "./simulation/simulationShell";
import { DrillErrorScreen, DrillIntroScreen, DrillLoadingScreen, DrillPickerScreen } from "./drill/DrillScreens";
import StimulusQueueRun, { StimulusQueueResults } from "./drill/StimulusQueueRun";
import { deterministicScoreRequest, stimulusCountLabel } from "./drill/stimulusQueue";

// Listening Drill, the Listening counterpart to ReadingDrill.tsx: pick a Task Type (or all four),
// then work through the Router Module's Stimuli of that Task Type one at a time, submitting each
// Stimulus's Items together and seeing feedback before moving on. A Drill only ever takes the Router
// Module (the Lower/Upper split exists only for a routed Simulation, ADR 0005), so this page never
// reads `lowerModule` or `upperModule`.
//
// The one real difference from Reading: each Stimulus plays its audio once before its questions
// exist in the page. That gate is not written here or in the run body: it is
// ListeningStimulusQuestions in components/StimulusQuestions.tsx, the one gate both Attempt modes go
// through, reached through ./drill/StimulusQueueRun.tsx, the queue this page shares with the Reading
// Drill, which picks the gate per Stimulus from the Stimulus's own Task Type.
//
// What is left here is this section's own vocabulary: which Task Types it offers, which of the
// Router Module's fields hold their Stimuli, and what the intro says. Everything else — loading the
// Set, the error screen, the picker, the intro chrome, creating the Attempt (and its Repeat tag) and
// the finish-and-navigate rule — belongs to the shared Drill shell (./drill/).

type ListeningTaskType = "listen_choose" | "conversation" | "announcement" | "academic_talk";

// The served Stimulus shapes come from `shared` (servedSet.ts), derived from the Set schemas by the
// same Omit stripAnswers performs; this page declares none of them itself.
type Stimulus = ServedListeningStimulus;

const TASK_OPTIONS: { label: string; kinds: ListeningTaskType[] }[] = [
  { label: TASK_TYPES.listen_choose.label, kinds: ["listen_choose"] },
  { label: TASK_TYPES.conversation.label, kinds: ["conversation"] },
  { label: TASK_TYPES.announcement.label, kinds: ["announcement"] },
  { label: TASK_TYPES.academic_talk.label, kinds: ["academic_talk"] },
  { label: "All four Task Types", kinds: ["listen_choose", "conversation", "announcement", "academic_talk"] },
];

function stimuliForKinds(router: ServedListeningSet["router"], kinds: ListeningTaskType[]): Stimulus[] {
  const out: Stimulus[] = [];
  for (const kind of kinds) {
    if (kind === "listen_choose") out.push(...router.listenChoose);
    else if (kind === "conversation") out.push(...router.conversations);
    else if (kind === "announcement") out.push(...router.announcements);
    else out.push(...router.academicTalks);
  }
  return out;
}

type Stage = "picker" | "intro" | "stimulus" | "drill-done";

export default function ListeningDrill() {
  const { setId } = useParams<{ setId: string }>();
  const drill = useDrillShell("listening", setId);
  const listed = useListedSet("listening", setId);
  const { beginAttempt, fail, finish } = drill;

  const [stage, setStage] = useState<Stage>("picker");
  const [queue, setQueue] = useState<Stimulus[]>([]);
  const [picked, setPicked] = useState<string>("");
  const [results, setResults] = useState<readonly StimulusItemResult[]>([]);
  useStageEntry(drill.phase === "ready" ? stage : null);

  const handlePick = useCallback(
    (label: string, kinds: ListeningTaskType[]) => {
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
  const setTitle = listed?.title ?? fallbackSetTitle("Listening", set.createdAt);

  if (stage === "picker") {
    return (
      <DrillPickerScreen
        section="Listening"
        setTitle={setTitle}
        meta={setLine}
        subtitle="Choose what to practise. After each Stimulus you see what you got right, the key and the Explanation."
        notice={<DrillBandEstimateNotice />}
        options={TASK_OPTIONS.map((opt) => {
          const count = stimulusCountLabel(stimuliForKinds(set.router, opt.kinds).length);
          return {
            label: opt.label,
            detail:
              opt.kinds.length > 1
                ? `${count}: Listen and Choose a Response, Conversation, Announcement, then Academic Talk`
                : count,
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
        section="Listening"
        heading={picked}
        meta={setTitle}
        backLabel="Change Task Type"
        onBack={() => setStage("picker")}
        onStart={handleStart}
        facts={[
          { term: "Stimuli", detail: `${stimulusCountLabel(queue.length)} from the Router Module, ${items} Items in all.` },
          {
            term: "Listening",
            detail: "Each Stimulus plays once. Its questions appear, all together, when the audio ends.",
          },
          {
            term: "If audio fails",
            detail: "A Stimulus that won't play waits for you to retry it, or to skip it unscored.",
          },
          { term: "Time", detail: "Untimed, apart from the audio itself." },
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
