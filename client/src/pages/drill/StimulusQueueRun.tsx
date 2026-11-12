import { useCallback, useState } from "react";
import StimulusQuestions, {
  ListeningStimulusQuestions,
  type QuestionedStimulus,
  type StimulusItemResult,
} from "../../components/StimulusQuestions";
import DrillBandEstimateNotice from "../../components/DrillBandEstimateNotice";
import { DeterministicAlreadyScoredError, getAttempt, scoreDeterministicTask } from "../../lib/api";
import { requestErrorMessage } from "../../lib/requestError";
import { TASK_TYPES } from "../../lib/taskTypes";
import { Button } from "../../ui/Button";
import { ExamExit, ExamShell, StageHeading } from "../../ui/ExamShell";
import { formatPercent } from "../../ui/format";
import { Kicker } from "../../ui/Heading";
import { IconArrowRight } from "../../ui/icons";
import { Notice } from "../../ui/Notice";
import { DrillCompletionFailed } from "./DrillScreens";
import type { DrillCompletion } from "./drillShell";
import { deterministicScoreRequest, isListeningStimulus } from "./stimulusQueue";

// ---------------------------------------------------------------------------
// The deterministic Stimulus-queue run body, for both the Reading and the Listening Drill. Hand it
// the Stimuli, get the scored Items back.
//
// There is no mode axis here: the gate is chosen per Stimulus from its own `taskType`
// (stimulusQueue.ts's `isListeningStimulus`), so a caller cannot ask for a Listening Stimulus with
// the gate off.
//
// The leak gate is not reimplemented here. This module goes through StimulusQuestions.tsx's
// `ListeningStimulusQuestions`, including the check/next footer, passed as its `children` so it is
// mounted inside the gate: nothing the User could act on may exist before the audio ends either.
// This queue's own state (`audioDone`) only chooses which `phase` to hand the gate.
// ---------------------------------------------------------------------------

export type StimulusQueueRunProps = {
  /**
   * The queue, in the order it is worked through — the Router Module's Stimuli of the picked Task
   * Type(s). A Drill never routes and only ever takes the Router Module (ADR 0005), so a caller
   * never has a second module to hand over.
   */
  stimuli: readonly QuestionedStimulus[];
  attemptId: string | null;
  /**
   * Every scored Item of the run, in the order it was checked, handed over once — from the
   * interaction that ends the queue, so the caller may move its own stage on synchronously.
   */
  onComplete: (results: readonly StimulusItemResult[]) => void;
  /**
   * Where the screen's Exit goes. The Drill page's leave guard asks before it does (drillShell.ts),
   * so this only names the destination. Omitted, the screen has no Exit.
   */
  exitTo?: string;
};

export default function StimulusQueueRun({ stimuli, attemptId, onComplete, exitTo }: StimulusQueueRunProps) {
  const [index, setIndex] = useState(0);
  // One map for gaps and options: an Item id is unique inside a Stimulus and the map is emptied at
  // every advance, so the two Response kinds cannot collide.
  const [answers, setAnswers] = useState<Map<string, string>>(new Map());
  const [results, setResults] = useState<StimulusItemResult[] | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const [errorMsg, setErrorMsg] = useState<string | null>(null);
  const [allResults, setAllResults] = useState<StimulusItemResult[]>([]);
  // Which side of the leak gate the current Stimulus is on — this component's whole share of it. The
  // gate itself (nothing answerable exists in the DOM until this is true) is structural and lives in
  // ListeningStimulusQuestions.
  const [audioDone, setAudioDone] = useState(false);
  // Distinct from audioDone: in a Drill a failed load still reveals the Question(s) — feedback is
  // instant and nothing is at stake for a Band Estimate — but with a note saying the audio failed.
  const [audioFailed, setAudioFailed] = useState(false);

  const current: QuestionedStimulus | undefined = stimuli[index];

  const handleSubmit = useCallback(async () => {
    if (!attemptId || !current) return;
    setSubmitting(true);
    setErrorMsg(null);
    const request = deterministicScoreRequest(current, answers);
    try {
      const res = await scoreDeterministicTask(attemptId, request);
      setResults(res.items);
      setAllResults((prev) => [...prev, ...res.items]);
    } catch (e) {
      if (e instanceof DeterministicAlreadyScoredError) {
        // An earlier check landed and only its response was lost: the server already has this
        // Stimulus's Responses. That is success (as in a Simulation's Module submit), so show what
        // the server recorded and move on. The key and the Explanation then wait for the report.
        const recorded = await recordedResults(attemptId, request.items.map((item) => item.itemId));
        setResults(recorded);
        setAllResults((prev) => [...prev, ...recorded]);
      } else {
        setErrorMsg(requestErrorMessage(e));
      }
    } finally {
      setSubmitting(false);
    }
  }, [attemptId, current, answers]);

  const handleNext = useCallback(() => {
    setResults(null);
    setAnswers(new Map());
    setAudioDone(false);
    setAudioFailed(false);
    const nextIndex = index + 1;
    if (nextIndex < stimuli.length) setIndex(nextIndex);
    else onComplete(allResults);
  }, [index, stimuli.length, allResults, onComplete]);

  const onAnswer = useCallback((itemId: string, value: string) => {
    setAnswers((prev) => new Map(prev).set(itemId, value));
  }, []);

  if (!current) return null;

  const listening = isListeningStimulus(current);
  const taskLabel = TASK_TYPES[current.taskType].label;
  const itemCount = deterministicScoreRequest(current, answers).items.length;
  const correctCount = results?.filter((r) => r.correct).length ?? 0;

  // The Drill's own controls: one button that checks the Stimulus, then moves on. Both branches are
  // a Button in the same place, so React keeps one element and changes only its label: keyboard
  // focus stays on it when the feedback arrives. Rendered inside the gate for a Listening Stimulus
  // (as `children`) and in ExamShell's footer for a Reading one.
  const action = !results ? (
    <Button variant="primary" onClick={() => void handleSubmit()} loading={submitting}>
      {itemCount === 1 ? "Check Response" : "Check Responses"}
    </Button>
  ) : (
    <Button variant="primary" iconEnd={<IconArrowRight size={16} />} onClick={handleNext}>
      {index + 1 < stimuli.length ? "Next Stimulus" : "See results"}
    </Button>
  );
  const error = errorMsg && (
    <Notice tone="critical" live="assertive" title="This Stimulus wasn't checked">
      {errorMsg}
    </Notice>
  );
  // Said once when the feedback arrives, for a User who is not looking at the marks.
  const scoredAnnouncement = (
    <p role="status" className="sr-only">
      {results ? `${correctCount} of ${results.length} correct.` : ""}
    </p>
  );

  return (
    <ExamShell
      section={listening ? "Listening" : "Reading"}
      part={
        <>
          <span>Drill</span> · <span>{taskLabel}</span>
        </>
      }
      exit={exitTo ? <ExamExit to={exitTo} asks /> : null}
      progress={{ current: index + 1, total: stimuli.length, label: `Stimulus ${index + 1} of ${stimuli.length}` }}
      footer={listening ? undefined : <div className="ml-auto flex items-center gap-3">{action}</div>}
    >
      {listening ? (
        <div className="mx-auto max-w-measure space-y-6">
          <StageHeading key={`heading-${current.id}`}>{taskLabel}</StageHeading>
          <ListeningStimulusQuestions
            key={current.id}
            stimulus={current}
            // A Drill has no avatar beat of its own — it enters the gate straight at "playing" and
            // leaves it at "questions" once the audio ends (or fails, `audioFailed` below).
            phase={audioDone ? "questions" : "playing"}
            // A Drill shows every Question the current Stimulus owns and submits them together,
            // unlike the lockstep Listening Simulation.
            reveal={{ policy: "all-at-once" }}
            answers={answers}
            results={results}
            audioFailed={audioFailed}
            onAudioEnded={() => setAudioDone(true)}
            onAudioError={() => {
              setAudioDone(true);
              setAudioFailed(true);
            }}
            onAnswer={onAnswer}
            autoFocus
          >
            {error}
            <div className="flex justify-end border-t border-rule pt-4">{action}</div>
          </ListeningStimulusQuestions>
        </div>
      ) : (
        <div className="space-y-6">
          {/* The shared Stimulus-questions module, which also owns the "hidden until the Item is
              scored" rule for the key and the Explanation. Keyed per Stimulus, so the next one
              mounts fresh and takes focus. */}
          <StimulusQuestions
            key={current.id}
            stimulus={current}
            reveal={{ policy: "all-at-once" }}
            answers={answers}
            results={results}
            submitting={submitting}
            onAnswer={onAnswer}
            autoFocus
          />
          {error}
        </div>
      )}
      {scoredAnnouncement}
    </ExamShell>
  );
}


/** Whether each of `itemIds` was scored right, as the server recorded it. Empty if that can't be read. */
async function recordedResults(attemptId: string, itemIds: string[]): Promise<StimulusItemResult[]> {
  try {
    const detail = await getAttempt(attemptId);
    return itemIds.flatMap((itemId) => {
      const item = detail.items.find((candidate) => candidate.itemId === itemId);
      return item && item.score !== null ? [{ itemId, correct: item.score === 1 }] : [];
    });
  } catch {
    return [];
  }
}

/**
 * The end of a deterministic Drill: how many Items were right, by Task Type when there were several,
 * whether this was a Repeat, and the buttons that complete the Attempt, with the line that says
 * when completing it failed.
 *
 * Shared by the Reading and Listening Drills, so it lives with the queue that produced the numbers.
 * `DrillBandEstimateNotice` is on it for the same reason it is on those two pickers — CONTEXT.md's
 * Simulation entry: for Reading and Listening a Simulation is the only source of a Band Estimate, so
 * the results screen is exactly where a User might otherwise expect one.
 */
export function StimulusQueueResults({
  results,
  isRepeat,
  onFinish,
  completion,
  stimuli,
  onReview,
}: {
  results: readonly StimulusItemResult[];
  isRepeat: boolean;
  /** Completes the Attempt and goes back to Practice. */
  onFinish: () => void;
  /** Where the finish's completion stands (drillShell.ts). */
  completion: DrillCompletion;
  /** The queue the results came from, for the per-Task-Type lines. */
  stimuli?: readonly QuestionedStimulus[];
  /** Completes the Attempt and opens its report, where every Item can be reviewed. */
  onReview?: () => void;
}) {
  // Which of the two buttons started the finish, so that one shows it is busy and the other waits.
  const [pressed, setPressed] = useState<"finish" | "review" | null>(null);
  const finishing = completion.status === "finishing";
  const correctCount = results.filter((r) => r.correct).length;
  const section = stimuli?.[0] && isListeningStimulus(stimuli[0]) ? "Listening" : "Reading";
  const byTaskType = stimuli ? tallyByTaskType(stimuli, results) : [];
  return (
    <ExamShell
      section={section}
      part={
        <>
          <span>Drill</span> · <span>Results</span>
        </>
      }
      exit={null}
    >
      <div className="mx-auto max-w-measure">
        <Kicker as="p">{section} Drill</Kicker>
        <h1 className="mt-1 font-serif text-title font-semibold text-ink">Results</h1>
        <p className="mt-5 flex flex-wrap items-baseline gap-x-3 gap-y-1">
          <span className="figures font-serif text-figure font-semibold text-ink">
            {correctCount}
            <span className="text-figure-sm text-graphite"> / {results.length}</span>
          </span>
          <span className="text-body text-ink-soft">
            Items correct{results.length > 0 && <> · {formatPercent(correctCount / results.length)}</>}
          </span>
        </p>
        {byTaskType.length > 1 && (
          <ul className="mt-5 divide-y divide-rule border-y border-rule">
            {byTaskType.map((row) => (
              <li key={row.label} className="flex items-baseline justify-between gap-4 py-2.5 text-body">
                <span className="text-ink">{row.label}</span>
                <span className="figures text-ink-soft">
                  {row.correct} of {row.total} correct
                </span>
              </li>
            ))}
          </ul>
        )}
        <div className="mt-6 space-y-3">
          {isRepeat && <Notice tone="caution">This Attempt is a Repeat: you have practised this Set before.</Notice>}
          <DrillBandEstimateNotice />
        </div>
        <div className="mt-8 space-y-4">
          <DrillCompletionFailed completion={completion} />
          <div className="flex flex-wrap items-center gap-3">
            <Button
              variant="primary"
              loading={finishing && pressed === "finish"}
              disabled={finishing && pressed !== "finish"}
              onClick={() => {
                setPressed("finish");
                onFinish();
              }}
            >
              Back to Practice
            </Button>
            {onReview && (
              <Button
                loading={finishing && pressed === "review"}
                disabled={finishing && pressed !== "review"}
                onClick={() => {
                  setPressed("review");
                  onReview();
                }}
              >
                Review every Item
              </Button>
            )}
          </div>
        </div>
      </div>
    </ExamShell>
  );
}

/** Correct out of scored, per Task Type, in queue order. */
function tallyByTaskType(stimuli: readonly QuestionedStimulus[], results: readonly StimulusItemResult[]) {
  const rows: { label: string; correct: number; total: number }[] = [];
  for (const stimulus of stimuli) {
    const ids = new Set(deterministicScoreRequest(stimulus, new Map()).items.map((i) => i.itemId));
    const mine = results.filter((r) => ids.has(r.itemId));
    if (mine.length === 0) continue;
    const label = TASK_TYPES[stimulus.taskType].label;
    const row = rows.find((r) => r.label === label) ?? rows[rows.push({ label, correct: 0, total: 0 }) - 1];
    row.total += mine.length;
    row.correct += mine.filter((r) => r.correct).length;
  }
  return rows;
}
