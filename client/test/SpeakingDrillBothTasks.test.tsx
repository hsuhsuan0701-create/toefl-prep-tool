import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { renderRoutes } from "./dataRouter";
import SpeakingDrill from "../src/pages/SpeakingDrill";

// A Speaking Drill of both Task Types scores each Task Type exactly once. Listen and Repeat's result
// slot is drawn as one status line while the Interview runs and again in full on the results screen
// — a different place in the tree, so the slot mounts twice. Its scoring job must not: a second
// POST /score for the same Task Type would supersede the first job and overwrite its scores.

vi.mock("../src/lib/api", () => ({
  getSet: vi.fn(),
  createAttempt: vi.fn(),
  completeAttempt: vi.fn(async () => ({})),
  scoreTask: vi.fn(async () => ({ jobId: "job-1" })),
  uploadItemAudio: vi.fn(async () => ({ ok: true, data: { transcript: "a transcript" } })),
}));

// Fires `start` once per mount, as the real hook does, so a remounted slot shows up as a second
// POST — exactly what this file is watching for.
vi.mock("../src/hooks/useScoringJob", async () => {
  const { useEffect, useRef } = await import("react");
  return {
    useScoringJob: (_attemptId: string, args?: { start?: () => Promise<{ jobId: string }> }) => {
      const begun = useRef(false);
      const startRef = useRef(args?.start);
      startRef.current = args?.start;
      useEffect(() => {
        if (begun.current) return;
        begun.current = true;
        void startRef.current?.();
      }, []);
      return {
        status: "running",
        stage: null,
        judgesDone: [],
        judgesFailed: [],
        openaiJudgeProvider: null,
        arbiterProvider: null,
        fallbackFrom: null,
        queuePosition: null,
        elapsedMs: 0,
        result: null,
        error: null,
        cancellationRequestedAt: null,
        terminalAt: null,
        cancellationReason: null,
        retry: () => {},
      };
    },
  };
});

vi.mock("../src/components/MicCheck", () => ({
  default: ({ onPass }: { onPass: () => void }) => (
    <button type="button" onClick={onPass}>
      mic ok
    </button>
  ),
}));

vi.mock("../src/components/ItemRecorder", () => ({
  default: ({ item, onFinished }: { item: { id: string }; onFinished: (blob: Blob) => void }) => (
    <button type="button" onClick={() => onFinished(new Blob([item.id]))}>
      finish {item.id}
    </button>
  ),
}));

class FakeAudioElement {
  static instances: FakeAudioElement[] = [];
  private listeners: Record<string, Array<() => void>> = {};
  src: string;
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

async function endAudio(file: string) {
  const audio = await waitFor(() => {
    const found = FakeAudioElement.instances.filter((a) => a.src.endsWith(file)).at(-1);
    if (!found) throw new Error(`no audio element for ${file} yet`);
    return found;
  });
  await act(async () => {
    audio.dispatch("ended");
  });
}

const speakingSet = {
  id: "spk-both",
  kind: "speaking",
  source: "generated",
  createdAt: "2026-01-01T00:00:00Z",
  listenAndRepeat: {
    scenarioTitle: "At the campus café",
    scenarioDescription: "You are ordering coffee.",
    introAudio: "stimuli/spk-both/briefing.mp3",
    items: [
      { id: "lr-1", audio: "stimuli/spk-both/lr-1.mp3", responseWindowSec: 8 },
      { id: "lr-2", audio: "stimuli/spk-both/lr-2.mp3", responseWindowSec: 8 },
    ],
  },
  interview: {
    scenarioTitle: "Student services interview",
    intro: "A few questions about campus life.",
    introAudio: "stimuli/spk-both/int-intro.mp3",
    questions: [
      { id: "iv-1", audio: "stimuli/spk-both/iv-1.mp3", responseWindowSec: 45 },
      { id: "iv-2", audio: "stimuli/spk-both/iv-2.mp3", responseWindowSec: 45 },
    ],
  },
};

beforeEach(async () => {
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
  const api = await import("../src/lib/api");
  (api.getSet as ReturnType<typeof vi.fn>).mockResolvedValue(speakingSet);
  // Its own Attempt id: the one-job-per-Task-Type registry (lib/scoringJobOnce.ts) is module-level
  // and keyed by Attempt.
  (api.createAttempt as ReturnType<typeof vi.fn>).mockResolvedValue({ attemptId: "att-both-tasks", isRepeat: false });
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.clearAllMocks();
});

describe("a Speaking Drill of both Task Types", () => {
  it("scores Listen and Repeat once and the Interview once, though the first slot is drawn twice", async () => {
    const api = await import("../src/lib/api");
    const user = userEvent.setup();
    renderRoutes([{ path: "/speaking/:setId", element: <SpeakingDrill /> }], "/speaking/spk-both");

    await user.click(await screen.findByText("Both Task Types"));
    await user.click(await screen.findByRole("button", { name: "mic ok" }));
    await user.click(await screen.findByRole("button", { name: "Start Speaking Drill" }));
    await endAudio("spk-both/briefing.mp3");
    await user.click(await screen.findByRole("button", { name: "finish lr-1" }));
    await user.click(await screen.findByRole("button", { name: "finish lr-2" }));

    // Listen and Repeat's slot is on screen as one line while the Interview runs.
    await endAudio("spk-both/int-intro.mp3");
    expect(await screen.findByText(/being scored while you go on/)).toBeInTheDocument();
    await user.click(await screen.findByRole("button", { name: "finish iv-1" }));
    await user.click(await screen.findByRole("button", { name: "finish iv-2" }));

    await screen.findByRole("heading", { name: "Results" });
    const scored = (api.scoreTask as ReturnType<typeof vi.fn>).mock.calls.map(([, body]) => body.taskType);
    expect(scored.filter((t: string) => t === "listen_repeat")).toHaveLength(1);
    expect(scored.filter((t: string) => t === "interview")).toHaveLength(1);
  });
});
