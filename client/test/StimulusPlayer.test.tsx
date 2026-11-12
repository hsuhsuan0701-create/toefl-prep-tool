import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { FakeAudioElement } from "./fakeAudio";
import { useFakeTimersInTest } from "./fakeTimers";
import { StrictMode } from "react";
import { act, render, screen } from "@testing-library/react";
import StimulusPlayer, { START_TIMEOUT_MS } from "../src/components/StimulusPlayer";

// StimulusPlayer's play-once contract, which every Listening Stimulus and Speaking prompt relies on:
// it plays `src` exactly once on mount, never replays for a `src`-only change on the same instance
// (advancing requires a new `key` from the parent), and both the StrictMode double-invoke guard
// (`playedRef`) and the multi-listener one-shot guard (`finishedRef`) must hold, or a Stimulus
// could double-play or a callback could double-fire.
//
// window.Audio is stubbed in this file only (not in client/test/setup.ts, which would silently
// change every other test's global), with fakeAudio.ts's FakeAudioElement: the tests fire
// "ended"/"error" themselves through its dispatch().

function totalPlayCalls() {
  return FakeAudioElement.instances.reduce((sum, a) => sum + a.playCalls, 0);
}

beforeEach(() => {
  FakeAudioElement.instances = [];
  FakeAudioElement.nextPlayResult = "resolve";
  vi.stubGlobal("Audio", FakeAudioElement);
});
afterEach(() => {
  vi.unstubAllGlobals();
});

describe("StimulusPlayer play-once contract", () => {
  it("calls play() exactly once per mounted key, tolerating React StrictMode's dev double-invoke", () => {
    const onEnded = vi.fn();
    render(
      <StrictMode>
        <StimulusPlayer key="item-1" src="/api/audio/item-1.mp3" onEnded={onEnded} />
      </StrictMode>,
    );

    // StrictMode double-invokes the mount effect (mount -> cleanup -> mount) in dev. Without the
    // playedRef guard this creates a second `new Audio(src)` and calls play() on it too.
    expect(FakeAudioElement.instances).toHaveLength(1);
    expect(totalPlayCalls()).toBe(1);
  });

  it("does NOT replay when src changes without a key change, but DOES play once for a genuinely new key", () => {
    const onEnded = vi.fn();
    const { rerender } = render(
      <StimulusPlayer key="item-1" src="/api/audio/a.mp3" onEnded={onEnded} />,
    );
    expect(FakeAudioElement.instances).toHaveLength(1);
    expect(totalPlayCalls()).toBe(1);

    // Same React key, new src — must not create a new Audio or call play() again. Advancing to a
    // new stimulus is the parent's job, done by passing a new `key`, never by changing `src` alone.
    rerender(<StimulusPlayer key="item-1" src="/api/audio/b.mp3" onEnded={onEnded} />);
    expect(FakeAudioElement.instances).toHaveLength(1);
    expect(totalPlayCalls()).toBe(1);

    // A genuinely new key unmounts the old instance and mounts a fresh one, which plays.
    rerender(<StimulusPlayer key="item-2" src="/api/audio/b.mp3" onEnded={onEnded} />);
    expect(FakeAudioElement.instances).toHaveLength(2);
    expect(totalPlayCalls()).toBe(2);
  });

  it("fires onEnded exactly once for 'ended', even if 'error' also fires for the same load and StrictMode double-mounts", () => {
    const onEnded = vi.fn();
    render(
      <StrictMode>
        <StimulusPlayer key="item-1" src="/api/audio/item-1.mp3" onEnded={onEnded} />
      </StrictMode>,
    );
    const audio = FakeAudioElement.instances[0];

    act(() => {
      audio.dispatch("ended");
    });
    expect(onEnded).toHaveBeenCalledTimes(1);

    // Browsers commonly fire both `error` and reject `play()` for one failed load — `finish` is
    // reachable from ended/error/play()-rejection and is guarded independently of playedRef
    // (finishedRef) so a second listener firing after the first must not double-call the callback.
    act(() => {
      audio.dispatch("error");
      audio.dispatch("ended");
    });
    expect(onEnded).toHaveBeenCalledTimes(1);
  });

  it("falls back to onEnded on a play() rejection when no onError is supplied (legacy single-callback behavior)", async () => {
    FakeAudioElement.nextPlayResult = "reject";
    const onEnded = vi.fn();
    render(<StimulusPlayer key="item-1" src="/api/audio/a.mp3" onEnded={onEnded} />);

    expect(await screen.findByText(/couldn't play the audio/i)).toBeInTheDocument();
    expect(onEnded).toHaveBeenCalledTimes(1);
  });

  it("calls onError instead of onEnded on a play() rejection when onError IS supplied", async () => {
    FakeAudioElement.nextPlayResult = "reject";
    const onEnded = vi.fn();
    const onError = vi.fn();
    render(<StimulusPlayer key="item-1" src="/api/audio/a.mp3" onEnded={onEnded} onError={onError} />);

    expect(await screen.findByText(/couldn't play the audio/i)).toBeInTheDocument();
    expect(onError).toHaveBeenCalledTimes(1);
    expect(onEnded).not.toHaveBeenCalled();
  });

  it("does not call onEnded for a late 'ended' event that arrives after the component has unmounted", () => {
    const onEnded = vi.fn();
    const { unmount } = render(
      <StimulusPlayer key="item-1" src="/api/audio/a.mp3" onEnded={onEnded} />,
    );
    const audio = FakeAudioElement.instances[0];

    unmount();
    // The cleanup deliberately does not tear down the Audio element or its listeners, so a late
    // event from the orphaned element is still deliverable — `finish` must recognize mountedRef is
    // false and skip the callback so it can't advance a stage the User already left.
    act(() => {
      audio.dispatch("ended");
    });
    expect(onEnded).not.toHaveBeenCalled();
  });
});

// A request that is neither answered nor failed fires no `error` and never settles `play()`. The
// start bound turns that into a failed load; once playback has begun it no longer counts.
describe("StimulusPlayer's start bound", () => {
  it("calls onError once a clip has not started within START_TIMEOUT_MS, and gives its load up", async () => {
    const clock = useFakeTimersInTest();
    FakeAudioElement.nextPlayResult = "pending";
    const onEnded = vi.fn();
    const onError = vi.fn();
    render(<StimulusPlayer src="/api/audio/a.mp3" onEnded={onEnded} onError={onError} />);
    const audio = FakeAudioElement.instances[0];

    await act(() => clock.advanceBy(START_TIMEOUT_MS - 1));
    expect(onError).not.toHaveBeenCalled();
    expect(screen.getByText("Listen…")).toBeInTheDocument();

    await act(() => clock.advanceBy(1));
    expect(onError).toHaveBeenCalledTimes(1);
    expect(onEnded).not.toHaveBeenCalled();
    expect(audio.sourceDropped).toBe(true);
    expect(audio.paused).toBe(true);
    expect(screen.getByText(/couldn't play the audio/i)).toBeInTheDocument();

    // A late event from the abandoned load changes nothing.
    act(() => audio.dispatch("ended"));
    expect(onEnded).not.toHaveBeenCalled();
  });

  it("plays a clip that starts late but within the bound through to its end", async () => {
    const clock = useFakeTimersInTest();
    FakeAudioElement.nextPlayResult = "pending";
    const onEnded = vi.fn();
    const onError = vi.fn();
    render(<StimulusPlayer src="/api/audio/a.mp3" onEnded={onEnded} onError={onError} />);
    const audio = FakeAudioElement.instances[0];

    await act(() => clock.advanceBy(START_TIMEOUT_MS - 1_000));
    act(() => audio.dispatch("playing"));
    await act(() => clock.advanceBy(10 * START_TIMEOUT_MS));
    act(() => audio.dispatch("ended"));

    expect(onError).not.toHaveBeenCalled();
    expect(onEnded).toHaveBeenCalledTimes(1);
    expect(audio.sourceDropped).toBe(false);
    expect(audio.pauseCalls).toBe(0);
  });

  it("never cuts short a clip that is playing, however long it runs", async () => {
    const clock = useFakeTimersInTest();
    const onEnded = vi.fn();
    const onError = vi.fn();
    render(<StimulusPlayer src="/api/audio/a.mp3" onEnded={onEnded} onError={onError} />);
    const audio = FakeAudioElement.instances[0];

    // play() resolved: playback has begun, with no `playing` event needed.
    await act(() => clock.advanceBy(10 * START_TIMEOUT_MS));
    expect(onError).not.toHaveBeenCalled();
    expect(audio.pauseCalls).toBe(0);
    expect(screen.getByText("Listen…")).toBeInTheDocument();
  });
});

describe("StimulusPlayer when its page goes away", () => {
  // Leaving a Listening Stimulus or a Speaking prompt mid-clip (the browser's Back, a confirmed leave)
  // must not leave the clip playing over whatever page comes next.
  it("stops playing when it unmounts for real", async () => {
    useFakeTimersInTest();
    const view = render(<StimulusPlayer src="/a.mp3" onEnded={vi.fn()} />);
    const audio = FakeAudioElement.instances[0];

    view.unmount();
    await act(async () => {
      vi.runAllTimers();
    });
    expect(audio.pauseCalls).toBe(1);
  });

  it("keeps playing through StrictMode's simulated unmount", async () => {
    useFakeTimersInTest();
    render(
      <StrictMode>
        <StimulusPlayer src="/a.mp3" onEnded={vi.fn()} />
      </StrictMode>,
    );
    await act(async () => {
      // Lets play() resolve first, as it does long before the start bound in a browser: running every
      // timer at once would otherwise fire that bound on a clip that has not been allowed to start.
      await Promise.resolve();
      vi.runAllTimers();
    });
    expect(FakeAudioElement.instances).toHaveLength(1);
    expect(FakeAudioElement.instances[0].pauseCalls).toBe(0);
  });
});
