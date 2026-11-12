import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import type { ServedListeningStimulus } from "@toefl-prep/shared";
import { ListeningStimulusQuestions, type ListeningStimulusPhase } from "../src/components/StimulusQuestions";

// The Listening Simulation's audio-failed stop, as a keyboard or screen-reader User meets it. The
// clip's own player is gone by the time the stop appears, so the stop has to announce itself and
// take focus on its Retry — otherwise the User is left on a heading above a gate they cannot see.
// What the stop withholds (anything answerable) is pinned in StimulusQuestions.test.tsx.

// A clip that never starts or ends, so only the `phase` prop moves the gate.
class FakeAudioElement {
  addEventListener() {}
  play(): Promise<void> {
    return new Promise(() => {});
  }
  pause() {}
}

const stimulus: ServedListeningStimulus = {
  id: "lc-1",
  taskType: "listen_choose",
  audio: "stimuli/lsn/lc-1.mp3",
  speaker: { id: "sp", role: "librarian", gender: "female", accent: "british" },
  options: [
    { id: "a", text: "Option A" },
    { id: "b", text: "Option B" },
  ],
};

function gate(phase: ListeningStimulusPhase) {
  return (
    <ListeningStimulusQuestions
      stimulus={stimulus}
      phase={phase}
      reveal={{ policy: "one-at-a-time", questionIdx: 0 }}
      answers={new Map()}
      onAnswer={() => {}}
      onAudioEnded={() => {}}
      onAudioError={() => {}}
      onAudioRetry={() => {}}
      onAudioSkip={() => {}}
    />
  );
}

describe("the audio-failed stop", () => {
  beforeEach(() => vi.stubGlobal("Audio", FakeAudioElement));
  afterEach(() => vi.unstubAllGlobals());

  it("takes focus on Retry and announces itself when playback gives up", () => {
    const { rerender } = render(gate("playing"));
    expect(screen.queryByRole("button", { name: "Retry" })).toBeNull();

    rerender(gate("audio-failed"));
    expect(screen.getByRole("button", { name: "Retry" })).toHaveFocus();
    expect(screen.getByRole("status")).toHaveTextContent("Couldn't play the audio for this Stimulus");
  });
});
