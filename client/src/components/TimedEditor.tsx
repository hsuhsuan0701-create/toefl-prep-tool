import { useCallback, useRef, useState, type ReactNode } from "react";
import { useDeadlineCountdown } from "../hooks/useDeadlineCountdown";
import { TASK_TYPES } from "../lib/taskTypes";
import { Button } from "../ui/Button";
import { EssayField, WordCount } from "../ui/EssayEditor";
import { ExamClock, ExamShell } from "../ui/ExamShell";
import { formatDuration } from "../ui/format";
import { Kicker } from "../ui/Heading";
import { countWords } from "../ui/wordCount";

export type EmailMaterials = {
  id: string;
  scenario: string;
  to: string;
  subject: string;
  bullets: string[];
  timeLimitSec: number;
  wordGuidance: { min: number; max: number };
};

export type DiscussionMaterials = {
  id: string;
  courseTitle: string;
  professorName: string;
  professorPost: string;
  studentPosts: { name: string; post: string }[];
  timeLimitSec: number;
  minWords: number;
};

/** The exam screen an essay Task is drawn on; the editor supplies the clock, the count and Submit. */
export type EssayChrome = {
  /** The section: "Writing". */
  section: string;
  /** Where in it: "Simulation · Write an Email". */
  part?: ReactNode;
  /** The screen's one way out (ExamExit). */
  exit: ReactNode;
  /** How far through the run, in Tasks: the Simulation's "Task 2 of 3". */
  progress?: { current: number; total: number; label: string };
  /** Anything shown above the Task: earlier stages' results, an unsent-Response notice. */
  before?: ReactNode;
};

type TimedEditorCommon = {
  seconds: number;
  onSubmit: (text: string, secondsUsed: number) => void;
  /**
   * When this Task's clock reaches zero (epoch ms). A caller resuming a Task it already started
   * passes the deadline it stored; omitted, the clock starts now with `seconds` on it.
   */
  deadlineMs?: number;
  /** Text to open with — a draft restored after a reload. */
  initialText?: string;
  /** Every edit, for a caller that mirrors the draft somewhere that survives a reload. */
  onTextChange?: (text: string) => void;
  chrome: EssayChrome;
};

type TimedEditorProps =
  | (TimedEditorCommon & { task: "email"; materials: EmailMaterials })
  | (TimedEditorCommon & { task: "discussion"; materials: DiscussionMaterials });

/**
 * One essay Task — Write an Email or Academic Discussion — on the exam shell: the prompt beside the
 * editor on a laptop and above it on a phone, the Task clock in the shell's header, and the live word
 * count and Submit in its footer. Shared by the Writing Drill and the Writing Simulation.
 *
 * The clock is a wall-clock deadline fixed once per mount, so a laptop put to sleep mid-essay comes
 * back with that time gone rather than handed back. The Task is handed over exactly once — by Submit
 * or by the clock running out, whichever is first. A reload is asked about by the page's leave guard
 * (useLeaveGuard), which is up whenever this editor is. A caller that shows two Tasks in a row keys
 * each one, so the second starts with an empty field and a full clock.
 */
export default function TimedEditor({
  task,
  materials,
  seconds,
  onSubmit,
  deadlineMs,
  initialText,
  onTextChange,
  chrome,
}: TimedEditorProps) {
  const [text, setText] = useState(initialText ?? "");
  const textRef = useRef(text);
  textRef.current = text;
  const deadlineRef = useRef<number | null>(null);
  if (deadlineRef.current === null) deadlineRef.current = deadlineMs ?? Date.now() + seconds * 1000;
  const deadline = deadlineRef.current;
  const submittedRef = useRef(false);

  const secondsUsedNow = useCallback(() => {
    const startMs = deadline - seconds * 1000;
    return Math.min(seconds, Math.max(0, Math.round((Date.now() - startMs) / 1000)));
  }, [deadline, seconds]);

  const submitOnce = useCallback(
    (usedSeconds: number) => {
      if (submittedRef.current) return;
      submittedRef.current = true;
      onSubmit(textRef.current, usedSeconds);
    },
    [onSubmit],
  );

  const handleExpire = useCallback(() => submitOnce(seconds), [submitOnce, seconds]);
  const secondsLeft = useDeadlineCountdown(deadline, handleExpire);

  const handleChange = (next: string) => {
    setText(next);
    onTextChange?.(next);
  };

  const isEmail = task === "email";
  const title = TASK_TYPES[task].label;
  const guide = isEmail ? materials.wordGuidance : { min: materials.minWords };

  return (
    <ExamShell
      section={chrome.section}
      part={chrome.part}
      clock={<ExamClock secondsLeft={secondsLeft} lowAt={60} criticalAt={30} label={`Time left for ${title}`} />}
      exit={chrome.exit}
      progress={chrome.progress}
      footer={
        <>
          <WordCount count={countWords(text)} guide={guide} />
          <Button variant="primary" className="shrink-0" onClick={() => submitOnce(secondsUsedNow())}>
            {isEmail ? "Submit Email" : "Submit post"}
          </Button>
        </>
      }
    >
      {chrome.before && <div className="mb-8 space-y-4">{chrome.before}</div>}
      <div className="grid gap-8 lg:grid-cols-[minmax(0,1fr)_minmax(0,1.15fr)] lg:gap-12">
        <section aria-labelledby="essay-task-title" className="min-w-0 space-y-4">
          <h1 id="essay-task-title" className="text-heading font-semibold text-ink">
            {title}
          </h1>
          {isEmail ? (
            <EmailPrompt materials={materials} seconds={seconds} />
          ) : (
            <DiscussionPrompt materials={materials} seconds={seconds} />
          )}
        </section>

        <section aria-label={isEmail ? "Your email" : "Your post"} className="min-w-0 space-y-3 lg:border-l lg:border-rule lg:pl-12">
          {isEmail && (
            <dl className="divide-y divide-rule rounded-control border border-rule bg-sheet text-ui">
              <div className="flex gap-3 px-4 py-2">
                <dt className="w-16 shrink-0 text-graphite">To</dt>
                <dd className="min-w-0 break-words text-ink">{materials.to}</dd>
              </div>
              <div className="flex gap-3 px-4 py-2">
                <dt className="w-16 shrink-0 text-graphite">Subject</dt>
                <dd className="min-w-0 break-words text-ink">{materials.subject}</dd>
              </div>
            </dl>
          )}
          <EssayField
            value={text}
            onChange={handleChange}
            aria-label={isEmail ? "Your email" : "Your post"}
            placeholder={isEmail ? "Write your email here." : "Write your post here."}
            className="lg:min-h-[26rem]"
          />
        </section>
      </div>
    </ExamShell>
  );
}

function EmailPrompt({ materials, seconds }: { materials: EmailMaterials; seconds: number }) {
  return (
    <div className="space-y-4 text-stimulus text-ink">
      <p className="text-ui text-graphite">
        Read the situation, then write the email it calls for. You have {formatDuration(seconds)}.
      </p>
      <p>{materials.scenario}</p>
      <div className="space-y-2">
        <p className="font-medium">Your email should:</p>
        <ul className="list-disc space-y-1 pl-5 marker:text-graphite">
          {materials.bullets.map((bullet, i) => (
            <li key={i}>{bullet}</li>
          ))}
        </ul>
      </div>
      <p className="text-ui text-graphite">Cover every point, in full sentences.</p>
    </div>
  );
}

function DiscussionPrompt({ materials, seconds }: { materials: DiscussionMaterials; seconds: number }) {
  return (
    <div className="space-y-5">
      <p className="text-ui text-graphite">
        A discussion board for a class on {materials.courseTitle}. Answer the professor&apos;s question
        with a post of your own: take a position and back it up, adding to what the other students
        say. Aim for {materials.minWords} words or more. You have {formatDuration(seconds)}.
      </p>
      <article className="space-y-1.5">
        <Kicker as="p">{materials.professorName} · Professor</Kicker>
        <p className="text-stimulus text-ink">{materials.professorPost}</p>
      </article>
      <div className="space-y-4 border-l-2 border-rule pl-4">
        {materials.studentPosts.map((sp, i) => (
          <article key={i} className="space-y-1">
            <p className="text-ui font-medium text-ink-soft">{sp.name}</p>
            <p className="text-stimulus text-ink">{sp.post}</p>
          </article>
        ))}
      </div>
    </div>
  );
}
