import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { renderRoutes } from "./dataRouter";
import { RESPONSE_WINDOW_RAMP, SpeakingSetSchema, stripAnswers } from "@toefl-prep/shared";
import SpeakingSimulation from "../src/pages/simulation/SpeakingSimulation";

// An exam screen has no navigation, so its Exit is the one way out. It only navigates: the running
// section's leave guard holds the navigation and LeaveGuardHost asks, once, the same question the
// browser's Back gets. Stay must leave the section exactly where it was.

vi.mock("../src/lib/api", () => ({
  advanceFullTest: vi.fn(async () => ({})),
  listSets: vi.fn(async () => [{ id: "spk-exit-1" }]),
  listAttempts: vi.fn(async () => []),
  getSet: vi.fn(),
  createAttempt: vi.fn(async () => ({ attemptId: "att-exit", isRepeat: false })),
  completeAttempt: vi.fn(async () => ({})),
  flagAttempt: vi.fn(async () => ({})),
  scoreTask: vi.fn(async () => ({ jobId: "job-1" })),
  getScoreJob: vi.fn(async () => ({ status: "done" })),
  scoreDeterministicTask: vi.fn(async () => ({ items: [] })),
  routeAttempt: vi.fn(async () => ({ path: "lower" })),
  finishSpeakingCapture: vi.fn(async () => ({})),
  uploadItemAudio: vi.fn(async () => ({ ok: true, data: { transcript: "a transcript" } })),
  DeterministicAlreadyScoredError: class DeterministicAlreadyScoredError extends Error {},
  HttpError: class HttpError extends Error {
    status: number;
    constructor(status: number, message: string) {
      super(message);
      this.status = status;
    }
  },
}));

vi.mock("../src/components/MicCheck", async () => {
  const { createElement } = await import("react");
  return { default: ({ onPass }: { onPass: () => void }) => createElement("button", { type: "button", onClick: onPass }, "pass mic check") };
});

vi.mock("../src/components/ItemRecorder", async () => {
  const { createElement } = await import("react");
  return {
    default: ({ item, onFinished }: { item: { id: string }; onFinished: (blob: Blob) => void }) =>
      createElement("button", { type: "button", onClick: () => onFinished(new Blob(["audio"])) }, `finish item ${item.id}`),
  };
});

class FakeAudioElement {
  static instances: FakeAudioElement[] = [];
  src: string;
  private listeners: Record<string, Array<() => void>> = {};
  constructor(src: string) {
    this.src = src;
    FakeAudioElement.instances.push(this);
  }
  addEventListener(type: string, listener: () => void) {
    (this.listeners[type] ??= []).push(listener);
  }
  removeEventListener() {}
  play(): Promise<void> {
    return Promise.resolve();
  }
  pause() {}
  dispatch(type: string) {
    for (const listener of this.listeners[type] ?? []) listener();
  }
}

const servedSet = stripAnswers(
  SpeakingSetSchema.parse({
    id: "spk-exit-1",
    kind: "speaking",
    source: "generated",
    createdAt: "2026-01-01T00:00:00Z",
    listenAndRepeat: {
      scenarioTitle: "Garden tour",
      scenarioDescription: "A coordinator walks new volunteers through the community garden.",
      introAudio: "stimuli/spk-exit-1/lr-intro.mp3",
      items: RESPONSE_WINDOW_RAMP.map((responseWindowSec, i) => ({
        id: `lr-${i + 1}`,
        sentence: `Target sentence ${i + 1}.`,
        audio: `stimuli/spk-exit-1/lr-${i + 1}.mp3`,
        responseWindowSec,
      })),
    },
    interview: {
      scenarioTitle: "Community garden interview",
      intro: "A local reporter wants to hear about your volunteering.",
      introAudio: "stimuli/spk-exit-1/int-intro.mp3",
      questions: (["factual", "experience", "opinion", "opinion"] as const).map((type, i) => ({
        id: `q-${i + 1}`,
        type,
        question: `Interview question ${i + 1}?`,
        audio: `stimuli/spk-exit-1/q-${i + 1}.mp3`,
        responseWindowSec: 45,
      })),
    },
  }),
);

async function toFirstItem(user: ReturnType<typeof userEvent.setup>) {
  renderRoutes(
    [
      { path: "/", element: <p>home</p> },
      { path: "/simulate/speaking", element: <SpeakingSimulation /> },
    ],
    ["/", "/simulate/speaking"],
  );
  await user.click(await screen.findByRole("button", { name: "Check your microphone" }));
  await user.click(screen.getByRole("button", { name: "pass mic check" }));
  await user.click(screen.getByRole("button", { name: "Start Speaking Simulation" }));
  await screen.findByText("Garden tour");
  await act(async () => {
    FakeAudioElement.instances.filter((a) => a.src.includes("lr-intro")).at(-1)!.dispatch("ended");
  });
  await screen.findByRole("button", { name: "finish item lr-1" });
}

const openDialog = () => screen.getAllByRole("dialog", { hidden: true }).find((d) => d.hasAttribute("open")) ?? null;

describe("leaving a running Speaking Simulation by its Exit", () => {
  beforeEach(async () => {
    const api = await import("../src/lib/api");
    (api.getSet as unknown as ReturnType<typeof vi.fn>).mockResolvedValue(servedSet);
    FakeAudioElement.instances = [];
    vi.stubGlobal("Audio", FakeAudioElement);
    Object.defineProperty(navigator, "mediaDevices", {
      configurable: true,
      writable: true,
      value: { getUserMedia: vi.fn(async () => ({ getTracks: () => [{ stop: vi.fn() }] }) as unknown as MediaStream) },
    });
    vi.stubGlobal("MediaRecorder", class {
      static isTypeSupported() {
        return true;
      }
    });
  });
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.clearAllMocks();
    vi.restoreAllMocks();
  });

  it("asks once, in the leave guard's dialog, and leaves on Leave", async () => {
    const user = userEvent.setup();
    await toFirstItem(user);

    await user.click(screen.getByRole("button", { name: "Exit…" }));
    const dialog = await screen.findByRole("dialog", { name: "Leave the Speaking section?" });
    expect(screen.getAllByRole("dialog").filter((d) => d.hasAttribute("open"))).toHaveLength(1);
    expect(dialog).toHaveTextContent(/starts the Speaking section again from the beginning/);
    await user.click(within(dialog).getByRole("button", { name: "Leave" }));

    expect(await screen.findByText("home")).toBeInTheDocument();
    expect(openDialog()).toBeNull();
  });

  it("stays on the Item, section untouched, when the User stays", async () => {
    const user = userEvent.setup();
    await toFirstItem(user);

    await user.click(screen.getByRole("button", { name: "Exit…" }));
    await user.click(within(openDialog()!).getByRole("button", { name: "Stay", hidden: true }));

    expect(openDialog()).toBeNull();
    expect(screen.getByRole("button", { name: "finish item lr-1" })).toBeInTheDocument();
    expect(screen.queryByText("home")).not.toBeInTheDocument();
  });
});

// A section that fails inside a Full-Test Run sends the User back to the Run, which waits at this
// section, rather than to Practice.
describe("a Speaking section that cannot load inside a Full-Test Run", () => {
  afterEach(() => {
    vi.clearAllMocks();
    vi.restoreAllMocks();
  });

  it("offers the way back to the Run, not to Practice", async () => {
    const api = await import("../src/lib/api");
    (api.getSet as unknown as ReturnType<typeof vi.fn>).mockRejectedValue(new Error("The Set could not be read."));
    renderRoutes(
      [{ path: "/full-test/:runId/speaking", element: <SpeakingSimulation fullTest={{ runId: "run-1", setId: "spk-exit-1" }} /> }],
      "/full-test/run-1/speaking",
    );

    expect(await screen.findByText("The Set could not be read.")).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "Back to the Full-Test Run" })).toHaveAttribute("href", "/full-test/run-1");
    expect(screen.queryByRole("link", { name: "Back to Practice" })).toBeNull();
  });
});
