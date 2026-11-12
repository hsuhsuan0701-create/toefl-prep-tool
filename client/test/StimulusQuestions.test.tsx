import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen } from "@testing-library/react";
import type { ServedListeningStimulus, ServedReadingStimulus, ServedSpeaker } from "@toefl-prep/shared";
import StimulusQuestions, {
  ListeningStimulusQuestions,
  type ListeningStimulusPhase,
  type QuestionReveal,
} from "../src/components/StimulusQuestions";

// The Listening leak gate. No option text and no answer control may reach the DOM before a Listening
// Stimulus's audio ends, or the User could read the answers while still listening. The one gate is
// components/StimulusQuestions.tsx's ListeningStimulusQuestions, which both the Listening Drill and
// the Listening Simulation render, so this one table covers all four Listening Task Types in both
// Attempt modes.
//
// It reads the raw DOM tree (container.querySelectorAll / container.textContent) rather than the
// accessibility tree on purpose: a `hidden` attribute, a `display:none` class or an opacity-0
// implementation of the same rule would still be found here, and must still fail. A state-only
// assertion would pass regardless of how (or whether) the component honors the phase at all.

// A file-local Audio stub, never in client/test/setup.ts, since a shared stub would silently change
// every other test's global. `play()` never settles, which parks the component in the "playing"
// phase for the duration of the check.
class FakeAudioElement {
  addEventListener() {}
  play(): Promise<void> {
    return new Promise(() => {});
  }
  pause() {}
}

function opts(prefix: string, n: number) {
  return Array.from({ length: n }, (_, i) => ({ id: `o${i + 1}`, text: `${prefix} option ${i + 1}` }));
}

function questionsOf(prefix: string, n: number) {
  return Array.from({ length: n }, (_, i) => ({
    id: `${prefix}-q${i + 1}`,
    stem: `${prefix} stem ${i + 1}?`,
    options: opts(`${prefix}-q${i + 1}`, 4),
  }));
}

const speaker: ServedSpeaker = { id: "sp-1", role: "student", gender: "male", accent: "north-american" };
const speakerPair: ServedSpeaker[] = [
  { id: "sp-1", role: "student", gender: "female", accent: "british" },
  { id: "sp-2", role: "clerk", gender: "male", accent: "australian" },
];

// Listen and Choose a Response carries no stem of its own — StimulusQuestions.tsx's own generic
// instruction copy stands in for one. Duplicated as a literal here deliberately: this test is what
// pins that copy reaching (and not reaching) the DOM, so it must not read the very constant it is
// checking.
const LISTEN_CHOOSE_STEM = "Choose the best response.";

// All four Listening Task Types, at their real Question counts (CONVERSATION/ANNOUNCEMENT/
// ACADEMIC_TALK_QUESTIONS_PER_STIMULUS = 2/2/4; a listen_choose Stimulus is its one Item).
const LISTENING_STIMULI: ServedListeningStimulus[] = [
  {
    id: "lc-1",
    taskType: "listen_choose",
    audio: "stimuli/lsn-test/lc-1.mp3",
    speaker,
    options: opts("lc-1", 4),
  },
  {
    id: "cv-1",
    taskType: "conversation",
    audio: "stimuli/lsn-test/cv-1.mp3",
    setting: "campus bookstore",
    speakers: speakerPair,
    questions: questionsOf("cv-1", 2),
  },
  {
    id: "an-1",
    taskType: "announcement",
    audio: "stimuli/lsn-test/an-1.mp3",
    setting: "student housing office",
    speaker,
    questions: questionsOf("an-1", 2),
  },
  {
    id: "at-1",
    taskType: "academic_talk",
    audio: "stimuli/lsn-test/at-1.mp3",
    discipline: "geology",
    speaker,
    questions: questionsOf("at-1", 4),
  },
];

/** Every Item a Stimulus owns, in the order it is answered — the whole surface the gate withholds. */
function itemsOf(stimulus: ServedListeningStimulus) {
  return stimulus.taskType === "listen_choose"
    ? [{ stem: LISTEN_CHOOSE_STEM, options: stimulus.options }]
    : stimulus.questions.map((q) => ({ stem: q.stem, options: q.options }));
}

// The two Attempt modes, as the module's one mode parameter expresses them.
const MODES: { mode: string; reveal: QuestionReveal }[] = [
  { mode: "Drill (all at once)", reveal: { policy: "all-at-once" } },
  { mode: "Simulation (one at a time)", reveal: { policy: "one-at-a-time", questionIdx: 0 } },
];

const noop = () => {};

function renderGate(stimulus: ServedListeningStimulus, reveal: QuestionReveal, phase: ListeningStimulusPhase) {
  return render(
    <ListeningStimulusQuestions
      stimulus={stimulus}
      phase={phase}
      reveal={reveal}
      answers={new Map()}
      onAnswer={noop}
      onAvatarSettled={noop}
      onAudioEnded={noop}
      onAudioError={noop}
    >
      {/* The call sites' own footer (a Drill's Submit, the Simulation's Next). Passed here so the
          gate is checked over answer controls too, not only over option text. */}
      <button type="button">Next</button>
    </ListeningStimulusQuestions>,
  );
}

describe("the Stimulus-questions leak gate: all four Listening Task Types, both Attempt modes", () => {
  beforeEach(() => {
    vi.stubGlobal("Audio", FakeAudioElement);
  });
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  for (const { mode, reveal } of MODES) {
    for (const stimulus of LISTENING_STIMULI) {
      it(`${stimulus.taskType} · ${mode}: nothing answerable exists until the audio ends`, () => {
        const items = itemsOf(stimulus);

        // Every phase before the audio has ended — the Simulation's avatar beat and the play-once
        // beat both Attempt modes share.
        for (const phase of ["avatar", "playing"] as const) {
          const { container, unmount } = renderGate(stimulus, reveal, phase);

          // The Stimulus itself is on screen: this is a gate, not a blank page.
          expect(container.querySelector('[data-testid="avatar-card"]')).not.toBeNull();

          // ...and nothing the User could read an option off, or act on, is in the DOM at all.
          expect(container.querySelectorAll('input[type="radio"]')).toHaveLength(0);
          expect(container.querySelectorAll("button")).toHaveLength(0);
          for (const item of items) {
            expect(container.textContent).not.toContain(item.stem);
            for (const option of item.options) expect(container.textContent).not.toContain(option.text);
          }

          unmount();
        }

        // Once the audio has ended, exactly the Items this Attempt mode reveals appear — which is
        // also what keeps the assertions above from passing vacuously.
        const { container } = renderGate(stimulus, reveal, "questions");
        const revealed = reveal.policy === "all-at-once" ? items : [items[reveal.questionIdx]];
        const withheld = items.filter((item) => !revealed.includes(item));

        expect(container.querySelectorAll('input[type="radio"]')).toHaveLength(
          revealed.reduce((n, item) => n + item.options.length, 0),
        );
        for (const item of revealed) {
          expect(container.textContent).toContain(item.stem);
          for (const option of item.options) expect(container.textContent).toContain(option.text);
        }
        // The lockstep mode reveals one Item; the rest of the Stimulus stays out of the DOM too.
        for (const item of withheld) {
          expect(container.textContent).not.toContain(item.stem);
          for (const option of item.options) expect(container.textContent).not.toContain(option.text);
        }
        expect(screen.getByRole("button", { name: "Next" })).toBeInTheDocument();
      });
    }
  }

  // The Simulation's audio-failed gate goes through the same structure: a Stimulus whose audio would
  // not play shows who is speaking and a way to play it again — and still nothing answerable.
  for (const stimulus of LISTENING_STIMULI) {
    it(`${stimulus.taskType}: the audio-failed gate offers Retry and nothing answerable`, () => {
      const onAudioRetry = vi.fn();
      const { container } = render(
        <ListeningStimulusQuestions
          stimulus={stimulus}
          phase="audio-failed"
          reveal={{ policy: "one-at-a-time", questionIdx: 0 }}
          answers={new Map()}
          onAnswer={noop}
          onAudioEnded={noop}
          onAudioError={noop}
          onAudioRetry={onAudioRetry}
          onAudioSkip={noop}
        >
          <button type="button">Next</button>
        </ListeningStimulusQuestions>,
      );

      expect(container.querySelector('[data-testid="avatar-card"]')).not.toBeNull();
      expect(container.querySelectorAll('input[type="radio"]')).toHaveLength(0);
      expect(screen.queryByRole("button", { name: "Next" })).toBeNull();
      for (const item of itemsOf(stimulus)) {
        expect(container.textContent).not.toContain(item.stem);
        for (const option of item.options) expect(container.textContent).not.toContain(option.text);
      }
      fireEvent.click(screen.getByRole("button", { name: "Retry" }));
      expect(onAudioRetry).toHaveBeenCalledTimes(1);
      expect(screen.getByRole("button", { name: "Skip this Stimulus" })).toBeInTheDocument();
    });
  }
});

// The Explanation (錯題解析) rule the module also owns: pre-authored 繁體中文, hidden until the Item is
// scored. A Drill hands over the result it just got back; a Simulation hands over nothing, which is
// what defers its feedback to the report.
describe("feedback is hidden until the Item is scored", () => {
  const dailyLife: ServedReadingStimulus = {
    id: "dl-1",
    taskType: "daily_life",
    genre: "notice",
    text: "The library closes at six.",
    questions: [
      {
        id: "dl-1-q1",
        stem: "When does the library close?",
        options: [
          { id: "a", text: "At five" },
          { id: "b", text: "At six" },
        ],
      },
    ],
  };

  const ctw: ServedReadingStimulus = {
    id: "ctw-1",
    taskType: "complete_words",
    topic: "Router passage",
    segments: [
      { type: "text", text: "The " },
      { type: "gap", gapId: "ctw-1-g1" },
      { type: "text", text: " sat." },
    ],
    gaps: [{ id: "ctw-1-g1", prefix: "ca", blankLength: 1 }],
  };

  it("a Drill shows the key and the 錯題解析 once the Item is scored, and locks the Item", () => {
    render(
      <StimulusQuestions
        stimulus={dailyLife}
        reveal={{ policy: "all-at-once" }}
        answers={new Map([["dl-1-q1", "a"]])}
        results={[{ itemId: "dl-1-q1", correct: false, key: "b", explanationZh: "正確答案是 B。" }]}
        onAnswer={noop}
      />,
    );
    expect(screen.getByText("Correct answer")).toBeInTheDocument();
    expect(screen.getByText("Your Response")).toBeInTheDocument();
    expect(screen.getByText("正確答案是 B。")).toBeInTheDocument();
    expect((screen.getAllByRole("radio") as HTMLInputElement[]).every((r) => r.disabled)).toBe(true);
  });

  it("a Simulation, given no results, shows neither — its feedback is deferred to the report", () => {
    const { container } = render(
      <StimulusQuestions
        stimulus={dailyLife}
        reveal={{ policy: "all-at-once" }}
        answers={new Map([["dl-1-q1", "a"]])}
        onAnswer={noop}
      />,
    );
    expect(screen.queryByText("Correct answer")).toBeNull();
    expect(container.textContent).not.toContain("正確答案是 B。");
    expect((screen.getAllByRole("radio") as HTMLInputElement[]).some((r) => r.disabled)).toBe(false);
  });

  it("a Complete the Words gap's 錯題解析 belongs to the passage, and appears only once scored", () => {
    const { container, rerender } = render(
      <StimulusQuestions stimulus={ctw} reveal={{ policy: "all-at-once" }} answers={new Map()} onAnswer={noop} />,
    );
    expect(container.textContent).not.toContain("這裡缺的是 cat。");
    expect((screen.getByLabelText('Gap starting with "ca"') as HTMLInputElement).disabled).toBe(false);

    rerender(
      <StimulusQuestions
        stimulus={ctw}
        reveal={{ policy: "all-at-once" }}
        answers={new Map()}
        results={[{ itemId: "ctw-1-g1", correct: false, key: "t", explanationZh: "這裡缺的是 cat。" }]}
        onAnswer={noop}
      />,
    );
    expect(container.textContent).toContain("這裡缺的是 cat。");
    expect(screen.getByTestId("ctw-gap-result-ctw-1-g1").textContent).toBe("No Response. The word is cat");
    expect((screen.getByLabelText('Gap starting with "ca"') as HTMLInputElement).disabled).toBe(true);
  });
});

// A Reading text the User has not read yet opens at its top. At phone width ExamSplit stacks the
// question under the whole text, so the question head, which takes focus when the screen opens, must
// take it without scrolling itself into view (issue #23). A further question on the same text is
// focused, and brought into view, as before.
describe("a new Reading text opens at its top", () => {
  const passage: ServedReadingStimulus = {
    id: "ap-1",
    taskType: "academic_passage",
    title: "The Passage",
    discipline: "life science",
    text: "First paragraph of the passage.\n\nSecond paragraph of the passage.",
    questions: questionsOf("ap", 2),
  };

  afterEach(() => vi.restoreAllMocks());

  function renderScreen(reveal: QuestionReveal) {
    const scrollTo = vi.spyOn(window, "scrollTo");
    const focus = vi.spyOn(HTMLElement.prototype, "focus");
    render(<StimulusQuestions stimulus={passage} reveal={reveal} answers={new Map()} onAnswer={noop} autoFocus />);
    return { scrollTo, focus };
  }

  const opening: { mode: string; reveal: QuestionReveal }[] = [
    { mode: "a Drill's screen", reveal: { policy: "all-at-once" } },
    { mode: "a Simulation's first question", reveal: { policy: "one-at-a-time", questionIdx: 0 } },
  ];
  for (const { mode, reveal } of opening) {
    it(`${mode}: the page starts at the top and the question head takes focus in place`, () => {
      const { scrollTo, focus } = renderScreen(reveal);
      expect(scrollTo).toHaveBeenCalledWith(expect.objectContaining({ top: 0 }));
      expect(focus).toHaveBeenCalledWith({ preventScroll: true });
      expect(document.activeElement?.textContent).toContain("ap stem 1?");
    });
  }

  it("a further question on the same text is focused as before, and the page is left alone", () => {
    const { scrollTo, focus } = renderScreen({ policy: "one-at-a-time", questionIdx: 1 });
    expect(scrollTo).not.toHaveBeenCalled();
    expect(focus).toHaveBeenCalledWith(undefined);
    expect(document.activeElement?.textContent).toContain("ap stem 2?");
  });
});
