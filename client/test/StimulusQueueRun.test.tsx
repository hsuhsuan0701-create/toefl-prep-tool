import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { FakeAudioElement, dispatchAudio, endAudio } from "./fakeAudio";
import { afterFeedbackHold } from "./feedbackHold";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { ServedListeningStimulus, ServedReadingStimulus } from "@toefl-prep/shared";
import StimulusQueueRun from "../src/pages/drill/StimulusQueueRun";
import { deterministicScoreRequest, isListeningStimulus, stimulusCountLabel } from "../src/pages/drill/stimulusQueue";

// The deterministic Stimulus-queue run body, one module shared by the Reading Drill and the
// Listening Drill.
//
// This file covers everything between the leak gate and the Drill shell: that the queue advances in
// order, that each Stimulus is submitted with its own Items and nobody else's, that an untouched
// Item still goes to the scorer as a "no Response" rather than being silently dropped, and that the
// key and the 錯題解析 are absent from the DOM until the Item is scored.
//
// The gate itself is not re-asserted here in miniature: StimulusQuestions.test.tsx owns it for all
// four Listening Task Types in both Attempt modes. What this file checks is that the queue goes
// through it rather than around it: in a Drill, the Submit button is inside the gate too.

vi.mock("../src/lib/api", () => ({
  scoreDeterministicTask: vi.fn(),
  getAttempt: vi.fn(),
  DeterministicAlreadyScoredError: class DeterministicAlreadyScoredError extends Error {},
}));

// window.Audio is stubbed per file with fakeAudio.ts, never in client/test/setup.ts, which would
// silently change every other test's global. Nothing plays on its own: a test dispatches
// "ended"/"error" itself, on the clip it names, once that clip's player has created it.

const ctwStimulus = {
  id: "ctw-1",
  taskType: "complete_words",
  topic: "Bicycles",
  segments: [
    { type: "text", text: "The " },
    { type: "gap", gapId: "g1" },
    { type: "text", text: " was locked." },
  ],
  gaps: [{ id: "g1", prefix: "bi", blankLength: 3 }],
} as unknown as ServedReadingStimulus;

const dailyLifeStimulus = {
  id: "dl-1",
  taskType: "daily_life",
  genre: "notice",
  text: "The library closes at six.",
  questions: [
    {
      id: "dl-1-q1",
      stem: "When does the library close?",
      options: [
        { id: "o1", text: "At five" },
        { id: "o2", text: "At six" },
      ],
    },
    {
      id: "dl-1-q2",
      stem: "Who wrote the notice?",
      options: [
        { id: "o1", text: "A student" },
        { id: "o2", text: "The librarian" },
      ],
    },
  ],
} as unknown as ServedReadingStimulus;

const speaker = { id: "sp-1", role: "student", gender: "female", accent: "north-american" };

const listenChooseStimulus = {
  id: "lc-1",
  taskType: "listen_choose",
  audio: "stimuli/lsn-1/lc-1.mp3",
  speaker,
  options: [
    { id: "o1", text: "Sorry, I am late." },
    { id: "o2", text: "The bus was early." },
  ],
} as unknown as ServedListeningStimulus;

const conversationStimulus = {
  id: "cv-1",
  taskType: "conversation",
  audio: "stimuli/lsn-1/cv-1.mp3",
  setting: "campus bookstore",
  speakers: [speaker],
  questions: [
    {
      id: "cv-1-q1",
      stem: "What does the student want?",
      options: [
        { id: "o1", text: "A refund" },
        { id: "o2", text: "A replacement" },
      ],
    },
  ],
} as unknown as ServedListeningStimulus;

/** Echoes the request back as a scored response, so a test can read what was actually submitted. */
function scoredEcho(correct = true) {
  return async (_attemptId: string, req: any) => ({
    taskType: req.taskType,
    items: req.items.map((i: any) => ({
      itemId: i.itemId,
      correct,
      key: "o2",
      explanationZh: `${i.itemId} 的解析`,
    })),
  });
}

beforeEach(() => {
  FakeAudioElement.instances = [];
  vi.stubGlobal("Audio", FakeAudioElement);
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.clearAllMocks();
});

describe("deterministicScoreRequest: three shapes for seven Task Types", () => {
  it("carries typed letters for a Complete the Words gap, empty for an untouched one", () => {
    expect(deterministicScoreRequest(ctwStimulus, new Map([["g1", "ke"]]))).toEqual({
      taskType: "complete_words",
      items: [{ itemId: "g1", typed: "ke" }],
    });
    expect(deterministicScoreRequest(ctwStimulus, new Map())).toEqual({
      taskType: "complete_words",
      items: [{ itemId: "g1", typed: "" }],
    });
  });

  it("makes a Listen and Choose a Response Stimulus its own single Item", () => {
    // The Stimulus is the Item (no stem, no separate question), so the Item id is the Stimulus id,
    // not a question id that does not exist.
    expect(deterministicScoreRequest(listenChooseStimulus, new Map([["lc-1", "o2"]]))).toEqual({
      taskType: "listen_choose",
      items: [{ itemId: "lc-1", selectedOptionId: "o2" }],
    });
  });

  it("sends one Item per Question for every other Task Type, unanswered ones included", () => {
    expect(deterministicScoreRequest(dailyLifeStimulus, new Map([["dl-1-q1", "o2"]]))).toEqual({
      taskType: "daily_life",
      items: [
        { itemId: "dl-1-q1", selectedOptionId: "o2" },
        // Skipped, not dropped: a Drill submits the whole Stimulus at once, so an Item nobody
        // answered must still be scored (as wrong) rather than vanishing from the Attempt.
        { itemId: "dl-1-q2", selectedOptionId: "__none__" },
      ],
    });
  });

  it("reads the leak gate off the Stimulus, not off the page asking", () => {
    expect(isListeningStimulus(listenChooseStimulus)).toBe(true);
    expect(isListeningStimulus(conversationStimulus)).toBe(true);
    expect(isListeningStimulus(ctwStimulus)).toBe(false);
    expect(isListeningStimulus(dailyLifeStimulus)).toBe(false);
  });

  it("pluralizes Stimulus irregularly", () => {
    expect(stimulusCountLabel(1)).toBe("1 Stimulus");
    expect(stimulusCountLabel(3)).toBe("3 Stimuli");
  });
});

describe("the Reading queue: one Stimulus at a time, submitted whole", () => {
  it("advances in queue order and submits each Stimulus with its own Items only", async () => {
    const api = await import("../src/lib/api");
    (api.scoreDeterministicTask as any).mockImplementation(scoredEcho());
    const onComplete = vi.fn();
    const user = userEvent.setup();

    render(
      <StimulusQueueRun
        stimuli={[ctwStimulus, dailyLifeStimulus]}
        attemptId="att-1"
        onComplete={onComplete}
      />,
    );

    expect(screen.getByText("Complete the Words")).toBeInTheDocument();
    expect(screen.getByText("Stimulus 1 of 2")).toBeInTheDocument();
    await user.type(screen.getByLabelText(/starting with "bi"/i), "ke");
    await user.click(screen.getByRole("button", { name: "Check Response" }));

    // Still on Stimulus 1 with its feedback; the queue only moves when the User says so.
    await screen.findByRole("button", { name: "Next Stimulus" });
    expect(screen.getByText("Stimulus 1 of 2")).toBeInTheDocument();
    await afterFeedbackHold();
    await user.click(screen.getByRole("button", { name: "Next Stimulus" }));

    expect(await screen.findByText("Stimulus 2 of 2")).toBeInTheDocument();
    expect(screen.getByText("Read in Daily Life")).toBeInTheDocument();
    await user.click(screen.getByRole("radio", { name: "At six" }));
    await user.click(screen.getByRole("button", { name: "Check Responses" }));

    // The last Stimulus says so, rather than offering a Stimulus that is not there.
    const seeResults = await screen.findByRole("button", { name: "See results" });
    await afterFeedbackHold();
    await user.click(seeResults);

    const calls = (api.scoreDeterministicTask as any).mock.calls;
    expect(calls).toHaveLength(2);
    expect(calls[0]).toEqual(["att-1", { taskType: "complete_words", items: [{ itemId: "g1", typed: "ke" }] }]);
    expect(calls[1]).toEqual([
      "att-1",
      {
        taskType: "daily_life",
        items: [
          { itemId: "dl-1-q1", selectedOptionId: "o2" },
          { itemId: "dl-1-q2", selectedOptionId: "__none__" },
        ],
      },
    ]);

    // Every scored Item of the whole run, handed over once — the tally on the results screen is
    // computed from exactly this.
    expect(onComplete).toHaveBeenCalledTimes(1);
    expect(onComplete.mock.calls[0][0].map((r: any) => r.itemId)).toEqual(["g1", "dl-1-q1", "dl-1-q2"]);
  });

  it("keeps a middle Stimulus's feedback through a double click, and moves on at a separate press", async () => {
    const api = await import("../src/lib/api");
    (api.scoreDeterministicTask as any).mockImplementation(scoredEcho(false));
    const onComplete = vi.fn();
    const user = userEvent.setup();

    render(<StimulusQueueRun stimuli={[dailyLifeStimulus, ctwStimulus]} attemptId="att-1" onComplete={onComplete} />);

    const check = screen.getByRole("button", { name: "Check Responses" });
    await user.click(check);
    // The second click of the double click lands on the same button, now "Next Stimulus".
    await user.click(await screen.findByRole("button", { name: "Next Stimulus" }));

    expect(screen.getByText("Stimulus 1 of 2")).toBeInTheDocument();
    expect(screen.getByText("dl-1-q1 的解析")).toBeInTheDocument();
    expect((api.scoreDeterministicTask as any).mock.calls).toHaveLength(1);

    await afterFeedbackHold();
    await user.click(screen.getByRole("button", { name: "Next Stimulus" }));
    expect(await screen.findByText("Stimulus 2 of 2")).toBeInTheDocument();
    expect(onComplete).not.toHaveBeenCalled();
  });

  it("keeps the key and the 錯題解析 out of the DOM until the Item is scored", async () => {
    const api = await import("../src/lib/api");
    (api.scoreDeterministicTask as any).mockImplementation(scoredEcho(false));
    const user = userEvent.setup();

    const { container } = render(
      <StimulusQueueRun stimuli={[dailyLifeStimulus]} attemptId="att-1" onComplete={vi.fn()} />,
    );

    // CONTEXT.md's Explanation entry: hidden until the Item is scored. Read off the raw DOM, so a
    // rendered-but-hidden explanation would still fail.
    expect(container.textContent).not.toContain("解析");
    expect(container.querySelectorAll("input[type='radio'][disabled]")).toHaveLength(0);

    await user.click(screen.getByRole("radio", { name: "At five" }));
    await user.click(screen.getByRole("button", { name: "Check Responses" }));

    expect(await screen.findByText("dl-1-q1 的解析")).toBeInTheDocument();
    expect(screen.getByText("dl-1-q2 的解析")).toBeInTheDocument();
    // …and the Responses lock once scored, so the feedback cannot be answered around.
    expect(container.querySelectorAll("input[type='radio']:not([disabled])")).toHaveLength(0);
  });

  it("shows a failed submit inline and leaves the User on the same Stimulus", async () => {
    const api = await import("../src/lib/api");
    (api.scoreDeterministicTask as any).mockRejectedValue(new Error("score 500"));
    const onComplete = vi.fn();
    const user = userEvent.setup();

    render(<StimulusQueueRun stimuli={[dailyLifeStimulus]} attemptId="att-1" onComplete={onComplete} />);

    await user.click(screen.getByRole("button", { name: "Check Responses" }));

    // Inline, not the shell's full-screen error surface: the Attempt is fine and the Response is
    // still on screen, so the only sensible next move is to submit it again.
    expect(await screen.findByText("score 500")).toBeInTheDocument();
    expect(screen.getByText("Stimulus 1 of 1")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Check Responses" })).toBeEnabled();
    expect(onComplete).not.toHaveBeenCalled();
  });
});

describe("the Listening queue: the same queue, through the leak gate", () => {
  it("puts nothing answerable — the Submit button included — in the DOM before the audio ends", async () => {
    const api = await import("../src/lib/api");
    (api.scoreDeterministicTask as any).mockImplementation(scoredEcho());
    const user = userEvent.setup();

    const { container } = render(
      <StimulusQueueRun stimuli={[listenChooseStimulus]} attemptId="att-1" onComplete={vi.fn()} />,
    );

    // The leak gate's rule: no option text and no answer control before the audio ends.
    // The Drill's own footer is passed as the gate's `children` precisely so the Submit button is
    // covered by it too — a queue that rendered the footer outside the gate would pass every
    // option-text assertion and still hand the User something to act on.
    expect(container.textContent).not.toContain("Sorry, I am late.");
    expect(container.querySelectorAll("input[type='radio']")).toHaveLength(0);
    expect(screen.queryByRole("button", { name: /^Check Response/ })).not.toBeInTheDocument();
    // The progress line is not answerable, so it sits outside the gate.
    expect(screen.getByText("Stimulus 1 of 1")).toBeInTheDocument();

    await endAudio("lc-1.mp3");

    expect(await screen.findByRole("radio", { name: "Sorry, I am late." })).toBeInTheDocument();
    await user.click(screen.getByRole("radio", { name: "The bus was early." }));
    await user.click(screen.getByRole("button", { name: "Check Response" }));

    expect((api.scoreDeterministicTask as any).mock.calls[0]).toEqual([
      "att-1",
      { taskType: "listen_choose", items: [{ itemId: "lc-1", selectedOptionId: "o2" }] },
    ]);
  });

  it("replays nothing at the next Stimulus but re-arms the gate for it", async () => {
    const api = await import("../src/lib/api");
    (api.scoreDeterministicTask as any).mockImplementation(scoredEcho());
    const user = userEvent.setup();

    const { container } = render(
      <StimulusQueueRun
        stimuli={[listenChooseStimulus, conversationStimulus]}
        attemptId="att-1"
        onComplete={vi.fn()}
      />,
    );

    await endAudio("lc-1.mp3");
    await user.click(await screen.findByRole("button", { name: "Check Response" }));
    const next = await screen.findByRole("button", { name: "Next Stimulus" });
    await afterFeedbackHold();
    await user.click(next);

    // The second Stimulus starts behind its own gate — advancing must not inherit the first one's
    // "audio already finished" state.
    expect(await screen.findByText("Stimulus 2 of 2")).toBeInTheDocument();
    expect(container.textContent).not.toContain("What does the student want?");
    expect(container.querySelectorAll("input[type='radio']")).toHaveLength(0);

    // Ends the second Stimulus's own clip: the first one's element is still in the list, and an
    // "ended" sent to it would reach a player that is no longer mounted.
    await endAudio("cv-1.mp3");
    expect(await screen.findByRole("radio", { name: "A refund" })).toBeInTheDocument();
  });

  it("never reveals the Question(s) of a Stimulus whose audio failed, and skipping it scores nothing", async () => {
    const api = await import("../src/lib/api");
    const onComplete = vi.fn();
    const user = userEvent.setup();
    const { container } = render(<StimulusQueueRun stimuli={[listenChooseStimulus]} attemptId="att-1" onComplete={onComplete} />);

    // The first load and the two automatic reloads, each on its own fresh element.
    for (let nth = 1; nth <= 3; nth++) await dispatchAudio("lc-1.mp3", "error", nth);

    expect(await screen.findByText(/Couldn't play the audio for this Stimulus/)).toBeInTheDocument();
    expect(container.textContent).not.toContain("Sorry, I am late.");
    expect(container.querySelectorAll("input[type='radio']")).toHaveLength(0);
    expect(screen.queryByRole("button", { name: /^Check Response/ })).not.toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: "Skip this Stimulus" }));
    expect(api.scoreDeterministicTask).not.toHaveBeenCalled();
    expect(onComplete).toHaveBeenCalledWith([]);
  });
});

describe("a resubmit the server already has", () => {
  // The first Submit landed but its response was lost (a dropped connection), so the User submits
  // again and the server answers 409 alreadyScored. That is success, as it is in a Simulation's
  // Module submit: the queue moves on, showing what the server recorded, instead of sticking on an
  // error that no number of retries can clear.
  it("counts as submitted and shows what the server recorded", async () => {
    const api = await import("../src/lib/api");
    (api.scoreDeterministicTask as any).mockRejectedValue(new (api as any).DeterministicAlreadyScoredError("already scored"));
    (api.getAttempt as any).mockResolvedValue({
      attempt: { id: "att-1", status: "in_progress" },
      items: [
        { itemId: "dl-1-q1", score: 1 },
        { itemId: "dl-1-q2", score: 0 },
        { itemId: "elsewhere", score: 1 },
      ],
    });
    const onComplete = vi.fn();
    const user = userEvent.setup();
    render(<StimulusQueueRun stimuli={[dailyLifeStimulus]} attemptId="att-1" onComplete={onComplete} />);

    await user.click(screen.getByRole("radio", { name: "At six" }));
    await user.click(screen.getByRole("button", { name: "Check Responses" }));

    const seeResults = await screen.findByRole("button", { name: "See results" });
    await afterFeedbackHold();
    await user.click(seeResults);
    expect(screen.queryByText(/already scored/)).toBeNull();
    expect(onComplete.mock.calls[0][0]).toEqual([
      { itemId: "dl-1-q1", correct: true },
      { itemId: "dl-1-q2", correct: false },
    ]);
  });
});
