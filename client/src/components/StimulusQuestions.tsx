import { useEffect, useRef, type ReactNode } from "react";
import type { ServedListeningStimulus, ServedReadingStimulus, ServedSpeaker } from "@toefl-prep/shared";
import { Button } from "../ui/Button";
import { Notice } from "../ui/Notice";
import { ExamSplit, PassagePane } from "../ui/PassagePane";
import { Prose } from "../ui/Prose";
import AvatarCard from "./AvatarCard";
import CtwGapInput from "./CtwGapInput";
import McqQuestion, { ResultVerdict, type McqOption } from "./McqQuestion";
import StimulusPlayer from "./StimulusPlayer";

// The one place a Reading or Listening Stimulus's own Items are turned into DOM, for both Attempt
// modes, with the Listening leak gate inside it.
//
// One axis varies between the two modes, and it is the only mode parameter here: `QuestionReveal`.
// A Drill reveals every Question a Stimulus owns at once; a Simulation reveals them one at a time
// (Reading screen by screen, Listening in lockstep). Everything else is data:
//   * `results`: feedback exists once the Item is scored, and never before (CONTEXT.md's
//     Explanation: "hidden until the Item is scored"). A Drill hands over the score response it
//     just got back; a Simulation hands over nothing, because its feedback waits for the report.
//   * `audioFailed`: a Drill whose audio failed reveals the Questions with a note.
//   * `phase`: how far the Stimulus's own audio has got: the Simulation's avatar beat, playing, the
//     Simulation's audio-failed gate, then the Questions. A Drill only ever visits "playing" and
//     "questions".
//
// The exam layout lives here and the spacing around it does not: a Reading text and its questions
// sit side by side (ui/PassagePane's ExamSplit), a Complete the Words passage reads at the measure,
// and a Listening Stimulus's questions follow its stage. Both components render a fragment, so the
// vertical rhythm between them and the call site's own controls stays with the call site.

/** Every Stimulus shape whose Items this module renders — the Reading three and the Listening four. */
export type QuestionedStimulus = ServedReadingStimulus | ServedListeningStimulus;

/**
 * One scored Item as the deterministic scorer returns it (`scoreDeterministicTask`'s `items`).
 * Present only once the Item is scored; that is what makes the key and the Explanation appear.
 */
export type StimulusItemResult = {
  itemId: string;
  correct: boolean;
  key?: string;
  explanationZh?: string;
};

/**
 * The one axis that varies between the two Attempt modes.
 *
 * `all-at-once`: every Question the Stimulus owns, together, in both Drills (the Listening one
 * first holds them behind the play-once audio, then shows them all).
 * `one-at-a-time`: only `questionIdx`, a Simulation's question-by-question screen. The Reading
 * Simulation lets the User move freely between them; the Listening Simulation answers them in order
 * with no going back (point 1 of pages/listeningSimulation.ts's header).
 *
 * A discriminated union rather than a string plus an optional index, so "one at a time" without an
 * index cannot be written.
 */
export type QuestionReveal =
  | { policy: "all-at-once" }
  | { policy: "one-at-a-time"; questionIdx: number };

export type StimulusQuestionsProps = {
  stimulus: QuestionedStimulus;
  reveal: QuestionReveal;
  /** Item id -> the User's current Response (a selected option id, or a Complete-the-Words gap's typed letters). */
  answers: ReadonlyMap<string, string>;
  onAnswer: (itemId: string, value: string) => void;
  /** Absent or null until the Item is scored; see StimulusItemResult. */
  results?: readonly StimulusItemResult[] | null;
  /**
   * A Drill's submit is in flight: locks the Complete-the-Words boxes for that window (McqQuestion
   * locks on its own `result`). Unused by the Simulations, which never re-render a Module while
   * submitting it.
   */
  submitting?: boolean;
  /**
   * Move focus to the first question (or the Complete the Words instructions) when it mounts. The
   * call site keys this component per Stimulus and per question, so a keyboard or screen-reader User
   * lands on whatever just came into view.
   */
  autoFocus?: boolean;
};

/** What McqQuestion needs for one Item, however the owning Stimulus happens to name it. */
type RenderableQuestion = { itemId: string; stem: string; options: McqOption[] };

// Listen and Choose a Response carries no stem of its own: the Item is the Question. Generic
// instruction copy only, never a transcription or paraphrase of the utterance it responds to (which
// is never served), so there is nothing Item-specific in it to leak.
const LISTEN_CHOOSE_STEM = "Choose the best response.";

// Gives the User a moment to see who is about to speak before playback starts: the only timer in
// the Listening Simulation, which has no Module clock. A Listening Drill never enters the "avatar"
// phase, so this never runs there.
const AVATAR_SETTLE_MS = 1500;

/** The Question(s) a Stimulus owns, in the order they are answered. */
function questionsOf(stimulus: QuestionedStimulus): RenderableQuestion[] {
  if (stimulus.taskType === "complete_words") return [];
  if (stimulus.taskType === "listen_choose") {
    return [{ itemId: stimulus.id, stem: LISTEN_CHOOSE_STEM, options: stimulus.options }];
  }
  return stimulus.questions.map((q) => ({ itemId: q.id, stem: q.stem, options: q.options }));
}

function resultFor(
  results: readonly StimulusItemResult[] | null | undefined,
  itemId: string,
): StimulusItemResult | undefined {
  return results?.find((r) => r.itemId === itemId);
}

/**
 * One Stimulus's Items: the Complete the Words gaps, a Reading text or passage with its questions,
 * or a Listening Stimulus's questions. Renders a fragment (see the file header on spacing).
 *
 * It has no audio gate of its own: a Listening call site must reach this through
 * `ListeningStimulusQuestions` below, which is the gate.
 */
export default function StimulusQuestions({
  stimulus,
  reveal,
  answers,
  onAnswer,
  results,
  submitting,
  autoFocus,
}: StimulusQuestionsProps) {
  if (stimulus.taskType === "complete_words") {
    const gapResults = results
      ? new Map(results.map((r) => [r.itemId, { correct: r.correct, key: r.key }]))
      : undefined;

    return (
      <>
        <CtwInstructions autoFocus={autoFocus} />
        {/* The boxes show the caller's Responses, so letters typed into a passage are still there
            when the User comes back to it. */}
        <CtwGapInput
          segments={stimulus.segments}
          gaps={stimulus.gaps}
          values={answers}
          numbered={Boolean(results)}
          disabled={Boolean(results) || Boolean(submitting)}
          results={gapResults}
          onChange={(typed) => {
            for (const [itemId, value] of typed) onAnswer(itemId, value);
          }}
        />
        {/* A gap's Explanation belongs to the passage rather than to one letter box, so it is listed
            here, under it, numbered to match the gaps, and only once the Item is scored. */}
        {results && <CtwFeedback gaps={stimulus.gaps} answers={answers} results={results} />}
      </>
    );
  }

  const questions = questionsOf(stimulus);
  const shown =
    reveal.policy === "one-at-a-time"
      ? [{ q: questions[reveal.questionIdx], index: reveal.questionIdx }]
      : questions.map((q, index) => ({ q, index }));

  const renderQuestion = ({ q, index }: { q: RenderableQuestion; index: number }, position: number) => {
    const r = resultFor(results, q.itemId);
    return (
      <McqQuestion
        key={q.itemId}
        kicker={questions.length > 1 ? `Question ${index + 1} of ${questions.length}` : undefined}
        stem={q.stem}
        options={q.options}
        selected={answers.get(q.itemId)}
        result={r ? { correct: r.correct, key: r.key, explanationZh: r.explanationZh } : undefined}
        onSelect={(optionId) => onAnswer(q.itemId, optionId)}
        autoFocus={autoFocus && position === 0}
      />
    );
  };

  // One Question on its own is rendered bare; several are ruled apart.
  const body =
    shown.length === 1 ? (
      renderQuestion(shown[0], 0)
    ) : (
      <div className="divide-y divide-rule [&>*]:py-6 [&>*:first-child]:pt-0 [&>*:last-child]:pb-0">
        {shown.map(renderQuestion)}
      </div>
    );

  // Reading's two MCQ Task Types show the text they are answered against beside the question(s);
  // Listening's never do (the Stimulus is the audio, and its transcript is not served at all).
  if (stimulus.taskType === "daily_life") {
    return (
      <ExamSplit passage={<PassagePane label={sentenceCase(stimulus.genre)} text={stimulus.text} preserveLines />}>
        {body}
      </ExamSplit>
    );
  }
  if (stimulus.taskType === "academic_passage") {
    return (
      <ExamSplit passage={<PassagePane label={sentenceCase(stimulus.discipline)} title={stimulus.title} text={stimulus.text} />}>
        {body}
      </ExamSplit>
    );
  }
  return body;
}

/** The one line of instructions over a Complete the Words passage; the focus target when it appears. */
function CtwInstructions({ autoFocus }: { autoFocus?: boolean }) {
  const ref = useRef<HTMLParagraphElement>(null);
  useEffect(() => {
    if (autoFocus) ref.current?.focus();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  return (
    <p ref={ref} tabIndex={-1} className="rounded-chip text-ui text-ink-soft">
      Type the missing letters to complete the words in the paragraph.
    </p>
  );
}

/**
 * A scored Complete the Words passage, gap by gap: the completed word, right or wrong in words and a
 * glyph, what the User typed when it was wrong, and the Explanation.
 */
function CtwFeedback({
  gaps,
  answers,
  results,
}: {
  gaps: { id: string; prefix: string }[];
  answers: ReadonlyMap<string, string>;
  results: readonly StimulusItemResult[];
}) {
  return (
    <ol aria-label="Feedback, gap by gap" className="max-w-measure divide-y divide-rule border-y border-rule">
      {gaps.map((gap, i) => {
        const r = resultFor(results, gap.id);
        if (!r) return null;
        const typed = (answers.get(gap.id) ?? "").trim();
        return (
          <li key={gap.id} className="grid grid-cols-[1.75rem_minmax(0,1fr)] gap-x-2 py-3">
            <span className="figures text-meta font-semibold text-graphite">{i + 1}</span>
            <div className="min-w-0 space-y-1">
              <p className="flex flex-wrap items-baseline gap-x-3 gap-y-1">
                {r.key !== undefined && (
                  <span className="text-body font-medium text-ink">
                    {gap.prefix}
                    {r.key}
                  </span>
                )}
                <ResultVerdict correct={r.correct} answered={typed !== ""} />
                {!r.correct && typed !== "" && (
                  <span className="text-meta text-graphite">
                    Your Response: {gap.prefix}
                    {typed}
                  </span>
                )}
              </p>
              {r.explanationZh && (
                <Prose lang="zh-Hant" size="body" className="text-ink-soft">
                  {r.explanationZh}
                </Prose>
              )}
            </div>
          </li>
        );
      })}
    </ol>
  );
}

function sentenceCase(text: string): string {
  const t = text.trim();
  return t.charAt(0).toUpperCase() + t.slice(1);
}

/**
 * How far a Listening Stimulus's own play-once audio has got. The gate reads exactly this.
 * "audio-failed" is the Simulation's stop when the audio would not play: who is speaking and a way
 * to play it again, and nothing answerable.
 */
export type ListeningStimulusPhase = "avatar" | "playing" | "audio-failed" | "questions";

export type ListeningStimulusQuestionsProps = Omit<StimulusQuestionsProps, "stimulus" | "submitting"> & {
  stimulus: ServedListeningStimulus;
  phase: ListeningStimulusPhase;
  /** Playback failed rather than finished. A Drill reveals the Questions anyway, with a note. */
  audioFailed?: boolean;
  /** Fired once the avatar beat has been seen. Only ever called from the "avatar" phase. */
  onAvatarSettled?: () => void;
  onAudioEnded: () => void;
  onAudioError: () => void;
  /**
   * How many times this Stimulus's audio has been reloaded. Keys the player, so each retry is a
   * fresh load of the clip.
   */
  audioTry?: number;
  /** From the "audio-failed" gate: play the Stimulus again. */
  onAudioRetry?: () => void;
  /** From the "audio-failed" gate: move on with the Stimulus's Questions unanswered. */
  onAudioSkip?: () => void;
  /**
   * The call site's own footer: a Drill's error line and Submit/Next buttons, the Simulation's Next
   * button. Rendered inside the gate on purpose: the leak rule covers answer controls as well as
   * option text, so nothing the User could act on may exist before the audio ends either.
   */
  children?: ReactNode;
};

function speakersOf(stimulus: ServedListeningStimulus): ServedSpeaker[] {
  return stimulus.taskType === "conversation" ? stimulus.speakers : [stimulus.speaker];
}

function settingOf(stimulus: ServedListeningStimulus): string | undefined {
  if (stimulus.taskType === "academic_talk") return stimulus.discipline;
  if (stimulus.taskType === "listen_choose") return undefined;
  return stimulus.setting;
}

/**
 * The Listening leak gate, for both Attempt modes. One Listening Stimulus: who is speaking
 * (AvatarCard, shown throughout), the play-once audio, and, strictly after that audio ends,
 * `StimulusQuestions` plus the call site's own footer.
 *
 * The rule: no option text and no answer control may reach the DOM before the Stimulus audio ends.
 * It is enforced structurally: McqQuestion (the only renderer of stem and option text and of
 * `input[type="radio"]`) and `children` are mounted only in the `phase === "questions"` branch, so
 * before that there is nothing to hide. Never re-implement this as a `hidden` attribute, a CSS class
 * or an opacity: client/test/StimulusQuestions.test.tsx reads the raw DOM tree.
 *
 * StimulusPlayer is keyed on the Stimulus and its `audioTry`, so a new Stimulus or a retry mounts a
 * fresh player and plays once; it unmounts again once the Questions appear, so there is nothing to
 * click to replay it.
 */
export function ListeningStimulusQuestions({
  stimulus,
  phase,
  audioFailed,
  onAvatarSettled,
  onAudioEnded,
  onAudioError,
  audioTry,
  onAudioRetry,
  onAudioSkip,
  children,
  ...questionProps
}: ListeningStimulusQuestionsProps) {
  // The audio-failed stop takes focus on its Retry, so a keyboard or screen-reader User is not left
  // on a heading above a gate they cannot see. The player that would have said "Couldn't play" is
  // already gone by then; the gate's Notice announces itself instead.
  const retryRef = useRef<HTMLButtonElement>(null);
  useEffect(() => {
    if (phase === "audio-failed") retryRef.current?.focus();
  }, [phase]);

  // Keyed on `stimulus.id` as well as `phase`: every Stimulus enters at "avatar", so `phase` alone
  // would not restart the timer for the next one. `onAvatarSettled` is not a dependency: it only
  // ever dispatches the parameterless `avatar-settled` event, so a stale closure does the same.
  useEffect(() => {
    if (phase !== "avatar" || !onAvatarSettled) return;
    const t = setTimeout(onAvatarSettled, AVATAR_SETTLE_MS);
    return () => clearTimeout(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [phase, stimulus.id]);

  return (
    <>
      <AvatarCard speakers={speakersOf(stimulus)} setting={settingOf(stimulus)} />
      {phase === "playing" && (
        <StimulusPlayer
          key={`${stimulus.id}:${audioTry ?? 0}`}
          src={`/api/audio/${stimulus.audio}`}
          onEnded={onAudioEnded}
          onError={onAudioError}
        />
      )}
      {phase === "audio-failed" && (
        <Notice
          tone="caution"
          live="polite"
          title="Couldn't play the audio for this Stimulus"
          action={
            <>
              {onAudioRetry && (
                <Button ref={retryRef} variant="primary" size="sm" onClick={onAudioRetry}>
                  Retry
                </Button>
              )}
              {onAudioSkip && (
                <Button variant="secondary" size="sm" onClick={onAudioSkip}>
                  Skip this Stimulus
                </Button>
              )}
            </>
          }
        >
          <p>Its questions stay hidden until it plays. Nothing is timed while this is up, and the Attempt is marked as interrupted.</p>
          {onAudioSkip && <p className="mt-1">Skipping scores this Stimulus's questions as unanswered.</p>}
        </Notice>
      )}
      {phase === "questions" && (
        <>
          {audioFailed && (
            <Notice tone="caution">Couldn't play the audio for this Stimulus. You can still respond, or move on.</Notice>
          )}
          <StimulusQuestions stimulus={stimulus} {...questionProps} />
          {children}
        </>
      )}
    </>
  );
}
