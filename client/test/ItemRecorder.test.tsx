import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { FakeAudioElement } from "./fakeAudio";
import { useFakeTimersInTest } from "./fakeTimers";
import { act, fireEvent, render, screen } from "@testing-library/react";
import ItemRecorder from "../src/components/ItemRecorder";
import { useRecorder } from "../src/hooks/useRecorder";

// ItemRecorder for real: its own StimulusPlayer, the real beep (jsdom has no AudioContext, so the
// beep resolves at once, as it does when a browser cannot make one), the real useRecorder and the
// real ResponseCountdown — with only the device boundary faked: the Audio element, getUserMedia and
// MediaRecorder. Every page suite that runs a Speaking Item mocks this component out, so this is
// where the choreography itself is pinned.

class FakeMediaRecorder {
  static instances: FakeMediaRecorder[] = [];
  static isTypeSupported() {
    return true;
  }
  state: "inactive" | "recording" = "inactive";
  mimeType = "audio/webm;codecs=opus";
  ondataavailable: ((event: { data: Blob }) => void) | null = null;
  onstop: (() => void) | null = null;
  onerror: ((event: { error: unknown }) => void) | null = null;
  stream: MediaStream;
  constructor(stream: MediaStream) {
    this.stream = stream;
    FakeMediaRecorder.instances.push(this);
  }
  start() {
    this.state = "recording";
  }
  stop() {
    this.state = "inactive";
    this.ondataavailable?.({ data: new Blob(["spoken answer"]) });
    this.onstop?.();
  }
}

type FakeTrack = { stop: ReturnType<typeof vi.fn>; onended?: (() => void) | null };
let tracks: FakeTrack[];

const item = { id: "lr-1", audio: "stimuli/s/lr-1.mp3", responseWindowSec: 8 };

function lastAudio(): FakeAudioElement {
  return FakeAudioElement.instances[FakeAudioElement.instances.length - 1];
}

function Harness(props: {
  onFinished: (blob: Blob) => void;
  stimulusAutoRetries?: number;
  onStimulusGate?: () => void;
  onSkip?: () => void;
}) {
  const recorder = useRecorder();
  return <ItemRecorder item={item} recorder={recorder} {...props} />;
}

/** Lets the beep resolve and the recorder start. */
async function settle() {
  await act(async () => {
    for (let i = 0; i < 10; i += 1) await Promise.resolve();
  });
}

beforeEach(() => {
  useFakeTimersInTest({ shouldAdvanceTime: true });
  FakeAudioElement.instances = [];
  FakeMediaRecorder.instances = [];
  tracks = [];
  vi.stubGlobal("Audio", FakeAudioElement);
  vi.stubGlobal("MediaRecorder", FakeMediaRecorder);
  Object.defineProperty(navigator, "mediaDevices", {
    configurable: true,
    writable: true,
    value: {
      getUserMedia: vi.fn(async () => {
        const opened: FakeTrack[] = [{ stop: vi.fn() }];
        tracks.push(...opened);
        return { getTracks: () => opened } as unknown as MediaStream;
      }),
    },
  });
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("ItemRecorder", () => {
  it("plays the prompt, beeps, records for the response window, and hands over the recording", async () => {
    const onFinished = vi.fn();
    render(<Harness onFinished={onFinished} />);

    // The prompt plays first; nothing records over it.
    expect(lastAudio().src).toBe("/api/audio/stimuli/s/lr-1.mp3");
    expect(screen.getByText("Listen…")).toBeInTheDocument();
    expect(FakeMediaRecorder.instances).toHaveLength(0);

    await act(async () => {
      lastAudio().dispatch("ended");
    });
    await settle();

    expect(screen.getByText("Recording")).toBeInTheDocument();
    expect(FakeMediaRecorder.instances).toHaveLength(1);
    expect(screen.getByRole("timer")).toHaveAccessibleName("8 seconds remaining");

    await act(async () => {
      vi.advanceTimersByTime(8_100);
    });
    await settle();

    expect(onFinished).toHaveBeenCalledTimes(1);
    const blob = onFinished.mock.calls[0][0] as Blob;
    expect(await blob.text()).toBe("spoken answer");
  });

  it("stops on a gate when the prompt will not play, and never records over a prompt nobody heard", async () => {
    const onStimulusGate = vi.fn();
    render(<Harness onFinished={vi.fn()} onStimulusGate={onStimulusGate} />);

    await act(async () => {
      lastAudio().dispatch("error");
    });

    expect(screen.getByText("Couldn't play the audio prompt for this Item.")).toBeInTheDocument();
    expect(onStimulusGate).toHaveBeenCalledTimes(1);
    expect(FakeMediaRecorder.instances).toHaveLength(0);
    expect(screen.queryByText("Recording")).toBeNull();

    // Retry plays the prompt again, from a fresh audio element.
    const before = FakeAudioElement.instances.length;
    fireEvent.click(screen.getByRole("button", { name: "Retry" }));
    expect(FakeAudioElement.instances).toHaveLength(before + 1);
    await act(async () => {
      lastAudio().dispatch("ended");
    });
    await settle();
    expect(screen.getByText("Recording")).toBeInTheDocument();
  });

  it("retries a prompt that fails on its own, a bounded number of times, before stopping on the gate", async () => {
    const onStimulusGate = vi.fn();
    render(<Harness onFinished={vi.fn()} stimulusAutoRetries={2} onStimulusGate={onStimulusGate} />);

    for (let attempt = 0; attempt < 2; attempt += 1) {
      await act(async () => {
        lastAudio().dispatch("error");
      });
      expect(screen.queryByRole("button", { name: "Retry" })).toBeNull();
    }
    expect(FakeAudioElement.instances).toHaveLength(3);

    await act(async () => {
      lastAudio().dispatch("error");
    });
    expect(screen.getByRole("button", { name: "Retry" })).toBeInTheDocument();
    expect(onStimulusGate).toHaveBeenCalledTimes(1);
  });

  it("offers a way past the gate when the caller allows skipping", async () => {
    const onSkip = vi.fn();
    render(<Harness onFinished={vi.fn()} onSkip={onSkip} />);
    await act(async () => {
      lastAudio().dispatch("error");
    });
    // A Simulation records the skip as never captured, which leaves the Attempt without a Band
    // Estimate, so the note says that and does not promise the Item is merely left out.
    expect(screen.getByText(/not counted as your miss/)).toHaveTextContent("the Attempt gets no Band Estimate");
    fireEvent.click(screen.getByRole("button", { name: "Skip this Item" }));
    expect(onSkip).toHaveBeenCalledTimes(1);
  });

  it("hands over what was recorded when the microphone goes away mid-take", async () => {
    const onFinished = vi.fn();
    render(<Harness onFinished={onFinished} />);
    await act(async () => {
      lastAudio().dispatch("ended");
    });
    await settle();
    expect(screen.getByText("Recording")).toBeInTheDocument();

    await act(async () => {
      tracks[0].onended?.();
    });
    await settle();

    expect(onFinished).toHaveBeenCalledTimes(1);
    expect(await (onFinished.mock.calls[0][0] as Blob).text()).toBe("spoken answer");
  });

  // A browser's MediaRecorder turns inactive the moment stop() is called and delivers the final
  // dataavailable and stop in a later task. ItemRecorder asks for the take as soon as it sees the
  // microphone gone, which is before that task runs.
  it("hands over the recording the browser delivers after the microphone has gone", async () => {
    class BrowserTimedMediaRecorder extends FakeMediaRecorder {
      stop() {
        this.state = "inactive";
        setTimeout(() => {
          this.ondataavailable?.({ data: new Blob(["spoken answer"]) });
          this.onstop?.();
        }, 0);
      }
    }
    vi.stubGlobal("MediaRecorder", BrowserTimedMediaRecorder);
    const onFinished = vi.fn();
    render(<Harness onFinished={onFinished} />);
    await act(async () => {
      lastAudio().dispatch("ended");
    });
    await settle();
    expect(screen.getByText("Recording")).toBeInTheDocument();

    await act(async () => {
      tracks[0].onended?.();
    });
    await settle();
    await act(async () => {
      vi.advanceTimersByTime(0);
    });
    await settle();

    expect(onFinished).toHaveBeenCalledTimes(1);
    expect(await (onFinished.mock.calls[0][0] as Blob).text()).toBe("spoken answer");
  });
});
