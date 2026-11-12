import { describe, expect, it, vi, beforeAll, beforeEach, afterEach } from "vitest";
import { FakeAudioElement, audioBySrc } from "./fakeAudio";
import { act, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { renderRoutes } from "./dataRouter";
import { RESPONSE_WINDOW_RAMP, SpeakingSetSchema, stripAnswers } from "@toefl-prep/shared";
import SpeakingDrill from "../src/pages/SpeakingDrill";
import SimulationRun from "../src/pages/SimulationRun";

// The interview's scenario introduction appears as on-screen text alongside its audio during the
// interview-intro beat (ETS Blueprint: "delivered both aurally and in print"), in both the Drill and
// the Simulation, while the interview `question` text, which stripAnswers removes, stays hidden
// before scoring. The served Set below is built by running a full SpeakingSet through the real
// stripAnswers, so these tests exercise the actual serving contract rather than a hand-stripped
// fixture that could drift from it.

vi.mock("../src/lib/api", () => ({
  listSets: vi.fn(async () => [{ id: "spk-int-1" }]),
  listAttempts: vi.fn(async () => []),
  getSet: vi.fn(),
  createAttempt: vi.fn(async () => ({ attemptId: "att-1", isRepeat: false })),
  completeAttempt: vi.fn(async () => ({})),
  flagAttempt: vi.fn(async () => ({})),
  scoreTask: vi.fn(async () => ({ jobId: "job-1" })),
  getScoreJob: vi.fn(async () => ({ status: "done" })),
  scoreDeterministicTask: vi.fn(async () => ({ items: [] })),
  routeAttempt: vi.fn(async () => ({ path: "lower" })),
  finishSpeakingCapture: vi.fn(async () => ({})),
  uploadItemAudio: vi.fn(async () => ({ ok: true, data: { transcript: "a transcript" } })),
  DeterministicAlreadyScoredError: class DeterministicAlreadyScoredError extends Error {},
}));

// The mic check needs a real microphone; these tests only need its gate to open.
vi.mock("../src/components/MicCheck", async () => {
  const { createElement } = await import("react");
  return {
    default: ({ onPass }: { onPass: () => void }) =>
      createElement("button", { type: "button", onClick: onPass }, "pass mic check"),
  };
});

// ItemRecorder owns stimulus playback + recording mechanics, all covered elsewhere. Here it is a
// click-through so the simulation can reach the L&R -> interview transition without a recorder,
// and so "the intro beat ended" is observable as the first question's recorder appearing.
vi.mock("../src/components/ItemRecorder", async () => {
  const { createElement } = await import("react");
  return {
    default: ({ item, onFinished }: { item: { id: string }; onFinished: (blob: Blob) => void }) =>
      createElement(
        "button",
        { type: "button", onClick: () => onFinished(new Blob(["audio"], { type: "audio/webm" })) },
        `finish item ${item.id}`,
      ),
  };
});

// window.Audio is stubbed per file with fakeAudio.ts (never in setup.ts): play() resolves, and the
// test itself dispatches "ended" to end the intro beat.

const INTRO_TEXT =
  "Thanks for joining us. A local reporter is writing a story about the community garden and wants to hear about your volunteering there.";
const QUESTION_TEXTS = [
  "How often do you volunteer at the community garden?",
  "Tell me about a time the garden work surprised you.",
  "Some people say gardens should be replaced with housing. What do you think?",
  "Should the city fund more community gardens? Why or why not?",
];

const fullSet = SpeakingSetSchema.parse({
  id: "spk-int-1",
  kind: "speaking",
  source: "generated",
  createdAt: "2026-01-01T00:00:00Z",
  listenAndRepeat: {
    scenarioTitle: "Garden tour",
    scenarioDescription: "A coordinator walks new volunteers through the community garden.",
    introAudio: "stimuli/spk-int-1/lr-intro.mp3",
    items: RESPONSE_WINDOW_RAMP.map((responseWindowSec, i) => ({
      id: `lr-${i + 1}`,
      sentence: `Secret target sentence number ${i + 1}.`,
      audio: `stimuli/spk-int-1/lr-${i + 1}.mp3`,
      responseWindowSec,
    })),
  },
  interview: {
    scenarioTitle: "Community garden interview",
    intro: INTRO_TEXT,
    introAudio: "stimuli/spk-int-1/int-intro.mp3",
    questions: QUESTION_TEXTS.map((question, i) => ({
      id: `q-${i + 1}`,
      type: (["factual", "experience", "opinion", "opinion"] as const)[i],
      question,
      audio: `stimuli/spk-int-1/q-${i + 1}.mp3`,
      responseWindowSec: 45,
    })),
  },
});
// What GET /api/sets/:id actually serves pre-scoring — the pages under test only ever see this.
const servedSet = stripAnswers(fullSet);

function expectNoHiddenText() {
  for (const question of QUESTION_TEXTS) expect(screen.queryByText(question)).toBeNull();
  expect(screen.queryByText(/Secret target sentence/)).toBeNull();
}

// The route loads its section Simulation as a lazy chunk. Loading it once up front keeps that
// first import out of the first test's findBy timeout.
beforeAll(async () => {
  await import("../src/pages/simulation/SpeakingSimulation");
});

beforeEach(async () => {
  const api = await import("../src/lib/api");
  (api.getSet as unknown as ReturnType<typeof vi.fn>).mockResolvedValue(servedSet);
  FakeAudioElement.instances = [];
  vi.stubGlobal("Audio", FakeAudioElement);
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.clearAllMocks();
});

describe("stripAnswers serving contract the intro-in-print feature relies on", () => {
  it("keeps the interview intro text but removes every question and L&R sentence", () => {
    const served = servedSet as unknown as {
      interview: { scenarioTitle: string; intro: string; introAudio: string };
    };
    expect(served.interview.intro).toBe(INTRO_TEXT);
    expect(served.interview.scenarioTitle).toBe("Community garden interview");
    const json = JSON.stringify(servedSet);
    for (const question of QUESTION_TEXTS) expect(json).not.toContain(question);
    expect(json).not.toContain("Secret target sentence");
  });
});

describe("SpeakingDrill interview intro beat", () => {
  function renderDrill() {
    return renderRoutes([{ path: "/speaking/:setId", element: <SpeakingDrill /> }], "/speaking/spk-int-1");
  }

  it("shows the scenario introduction in print alongside its audio, never any question text", async () => {
    const user = userEvent.setup();
    renderDrill();

    await user.click(await screen.findByRole("button", { name: /^Interview 4 Items/ }));
    await user.click(screen.getByRole("button", { name: "pass mic check" }));
    await user.click(screen.getByRole("button", { name: /^Start Speaking (Drill|Simulation)$/ }));

    // The intro beat: title + intro text visible in print while the intro audio plays.
    expect(await screen.findByText(INTRO_TEXT)).toBeInTheDocument();
    expect(screen.getByText("Community garden interview")).toBeInTheDocument();
    const introAudio = audioBySrc("int-intro");
    expectNoHiddenText();

    // Intro audio ends -> the first question's recorder; the intro text leaves with its beat and
    // question text still never appears pre-scoring.
    await act(async () => {
      introAudio.dispatch("ended");
    });
    expect(await screen.findByRole("button", { name: "finish item q-1" })).toBeInTheDocument();
    expect(screen.queryByText(INTRO_TEXT)).toBeNull();
    expectNoHiddenText();
  });
});

describe("Speaking simulation interview intro beat", () => {
  function renderSimulation() {
    return renderRoutes(
      [
        { path: "/simulate/:kind", element: <SimulationRun /> },
        { path: "/attempts/:id", element: <p>attempt report</p> },
      ],
      "/simulate/speaking",
    );
  }

  it("shows the scenario introduction in print at the L&R -> interview transition, never any question text", async () => {
    const user = userEvent.setup();
    renderSimulation();

    await user.click(await screen.findByRole("button", { name: "Check your microphone" }));
    await user.click(screen.getByRole("button", { name: "pass mic check" }));
    await user.click(screen.getByRole("button", { name: /^Start Speaking (Drill|Simulation)$/ }));

    // L&R scenario briefing plays its own intro audio first.
    await screen.findByText("Garden tour");
    await act(async () => {
      audioBySrc("lr-intro").dispatch("ended");
    });

    // Click through all seven L&R Items (mocked recorder) to reach the interview.
    for (let i = 1; i <= 7; i += 1) {
      await user.click(await screen.findByRole("button", { name: `finish item lr-${i}` }));
    }

    // Interview intro beat: title + intro text in print while its audio plays.
    expect(await screen.findByText(INTRO_TEXT)).toBeInTheDocument();
    expect(screen.getByText("Community garden interview")).toBeInTheDocument();
    const introAudio = audioBySrc("int-intro");
    expectNoHiddenText();

    // Intro ends -> first interview question's recorder; intro text leaves with its beat.
    await act(async () => {
      introAudio.dispatch("ended");
    });
    expect(await screen.findByRole("button", { name: "finish item q-1" })).toBeInTheDocument();
    expect(screen.queryByText(INTRO_TEXT)).toBeNull();
    expectNoHiddenText();
  });
});
