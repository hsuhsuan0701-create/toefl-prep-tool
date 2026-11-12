import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, renderHook, waitFor } from "@testing-library/react";
import { useEffect, useRef } from "react";
import { useRecorder } from "../src/hooks/useRecorder";

// useRecorder's two lifecycles, asserted at the device boundary (getUserMedia calls and
// track.stop() calls). That is the observable that matters: on macOS a mic open/close can cycle the
// system Voice Processing I/O unit, whose deferred teardown glitches the next Item's stimulus.
//
//   - held mode (acquire()/release()): one getUserMedia for a whole run of start/stop cycles;
//     stop() yields the Blob but leaves the tracks live; only release() ends them.
//   - legacy mode (plain start()/stop()): self-acquire on every start, tracks released on every
//     stop. MicCheck's single 2-second take uses it, and a start() whose run never got a hold
//     falls back to it.
//
// The "audio constraints" describe checks the constraints both paths hand to getUserMedia.

type FakeTrack = { stop: ReturnType<typeof vi.fn>; onended?: (() => void) | null };
type FakeStream = MediaStream & { tracks: FakeTrack[] };

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
    // The real sequence the hook's stop() awaits: final dataavailable, then stop.
    this.state = "inactive";
    this.ondataavailable?.({ data: new Blob(["chunk"]) });
    this.onstop?.();
  }
}

let openedStreams: FakeStream[];
let getUserMedia: ReturnType<typeof vi.fn>;

beforeEach(() => {
  FakeMediaRecorder.instances = [];
  openedStreams = [];
  getUserMedia = vi.fn(async () => {
    const tracks: FakeTrack[] = [{ stop: vi.fn() }, { stop: vi.fn() }];
    const stream = { tracks, getTracks: () => tracks } as unknown as FakeStream;
    openedStreams.push(stream);
    return stream;
  });
  Object.defineProperty(navigator, "mediaDevices", {
    configurable: true,
    writable: true,
    value: { getUserMedia },
  });
  vi.stubGlobal("MediaRecorder", FakeMediaRecorder);
});

afterEach(() => vi.unstubAllGlobals());

describe("useRecorder held mode (acquire/release)", () => {
  it("opens the device ONCE for a whole run of start/stop cycles, and stop() keeps the tracks live", async () => {
    const { result } = renderHook(() => useRecorder());

    await act(async () => {
      await result.current.acquire();
    });
    expect(getUserMedia).toHaveBeenCalledTimes(1);
    const held = openedStreams[0];
    // The exposed stream is live as soon as the hold exists — before any recording starts.
    expect(result.current.stream).toBe(held);

    for (let cycle = 0; cycle < 3; cycle++) {
      await act(async () => {
        await result.current.start();
      });
      expect(result.current.state).toBe("recording");
      let blob: Blob | undefined;
      await act(async () => {
        blob = await result.current.stop();
      });
      // Each cycle still yields its own composed recording…
      expect(blob!.size).toBeGreaterThan(0);
      expect(result.current.state).toBe("idle");
      // …and the exposed stream survives the stop — the hold is still on.
      expect(result.current.stream).toBe(held);
    }

    // Three recordings, one device acquisition, zero track teardowns.
    expect(getUserMedia).toHaveBeenCalledTimes(1);
    for (const track of held.tracks) expect(track.stop).not.toHaveBeenCalled();
    // Every MediaRecorder recorded from the one held stream.
    expect(FakeMediaRecorder.instances.map((r) => r.stream)).toEqual([held, held, held]);
  });

  it("acquire() is idempotent while the hold is live", async () => {
    const { result } = renderHook(() => useRecorder());
    let first: MediaStream | undefined;
    let second: MediaStream | undefined;
    await act(async () => {
      first = await result.current.acquire();
      second = await result.current.acquire();
    });
    expect(second).toBe(first);
    expect(getUserMedia).toHaveBeenCalledTimes(1);
  });

  it("release() ends the tracks and clears the exposed stream", async () => {
    const { result } = renderHook(() => useRecorder());
    await act(async () => {
      await result.current.acquire();
    });

    act(() => result.current.release());

    for (const track of openedStreams[0].tracks) expect(track.stop).toHaveBeenCalledTimes(1);
    expect(result.current.stream).toBeNull();
  });

  it("release() while a recording is still active ends the tracks (mid-recording exit)", async () => {
    const { result } = renderHook(() => useRecorder());
    await act(async () => {
      await result.current.acquire();
      await result.current.start();
    });
    expect(result.current.state).toBe("recording");

    // A Drill's unmount cleanup path: stop whatever is recording, then drop the hold.
    await act(async () => {
      void result.current.stop();
      result.current.release();
    });

    for (const track of openedStreams[0].tracks) expect(track.stop).toHaveBeenCalledTimes(1);
    expect(result.current.stream).toBeNull();
  });
});

describe("useRecorder legacy mode (unchanged self-acquire path)", () => {
  it("acquires per start() and releases the tracks on every stop()", async () => {
    const { result } = renderHook(() => useRecorder());

    await act(async () => {
      await result.current.start();
    });
    expect(getUserMedia).toHaveBeenCalledTimes(1);
    expect(result.current.stream).toBe(openedStreams[0]);

    await act(async () => {
      await result.current.stop();
    });
    // Self-release on stop: tracks ended, exposed stream gone, so the recording indicator turns
    // off between recordings.
    for (const track of openedStreams[0].tracks) expect(track.stop).toHaveBeenCalledTimes(1);
    expect(result.current.stream).toBeNull();

    // A second recording opens the device again — no hold was ever created.
    await act(async () => {
      await result.current.start();
    });
    expect(getUserMedia).toHaveBeenCalledTimes(2);
    expect(FakeMediaRecorder.instances[1].stream).toBe(openedStreams[1]);
    await act(async () => {
      await result.current.stop();
    });
    for (const track of openedStreams[1].tracks) expect(track.stop).toHaveBeenCalledTimes(1);
  });
});

describe("useRecorder audio constraints", () => {
  // Pins the exact audio constraints the recording path hands to getUserMedia. `echoCancellation`
  // must stay false: nothing in this app plays audio while recording (a clip finishes before
  // start(), in the Drill, the Simulation and the Drill Lab alike), so AEC cancels nothing. But
  // requesting it engages macOS's Voice Processing I/O unit, which takes over the output side of the
  // audio device and whose deferred teardown cuts out the next stimulus clip mid-play. Flipping it
  // back to true must fail this suite.
  it("legacy start() requests the microphone with echo cancellation explicitly OFF, and nothing else", async () => {
    const { result } = renderHook(() => useRecorder());

    await act(async () => {
      await result.current.start();
    });

    expect(getUserMedia).toHaveBeenCalledTimes(1);
    // Deep-equality on the whole constraints object, deliberately: re-enabling AEC fails here,
    // and so does any new constraint slipped in without updating this pin.
    expect(getUserMedia).toHaveBeenCalledWith({ audio: { echoCancellation: false } });
    expect(result.current.state).toBe("recording");
  });

  it("held-mode acquire() opens the device with the same pinned constraints", async () => {
    const { result } = renderHook(() => useRecorder());

    await act(async () => {
      await result.current.acquire();
    });

    expect(getUserMedia).toHaveBeenCalledTimes(1);
    expect(getUserMedia).toHaveBeenCalledWith({ audio: { echoCancellation: false } });
  });
});

describe("useRecorder under StrictMode's simulated unmount", () => {
  // The Drill Lab holds the mic for a whole run: acquire() on mount, release() on unmount. StrictMode
  // mounts, unmounts and mounts again in one go, so the first mount's acquire() is still waiting on
  // getUserMedia when its own cleanup releases it — and the second mount's acquire() must not be
  // handed that stale, about-to-be-stopped request, or no hold ever forms and every rep re-opens the
  // device (the glitch the hold exists to prevent).
  function useHeldForRun() {
    const recorder = useRecorder();
    const ref = useRef(recorder);
    ref.current = recorder;
    useEffect(() => {
      void ref.current.acquire().catch(() => {});
      return () => ref.current.release();
    }, []);
    return recorder;
  }

  it("ends up holding a live stream that later recordings reuse", async () => {
    getUserMedia.mockImplementation(
      () =>
        new Promise((resolve) => {
          setTimeout(() => {
            const tracks: FakeTrack[] = [{ stop: vi.fn() }];
            const stream = { tracks, getTracks: () => tracks } as unknown as FakeStream;
            openedStreams.push(stream);
            resolve(stream);
          }, 5);
        }),
    );
    const { result } = renderHook(() => useHeldForRun(), { reactStrictMode: true });

    await waitFor(() => expect(result.current.stream).not.toBeNull());
    const held = result.current.stream as FakeStream;
    expect(held.tracks[0].stop).not.toHaveBeenCalled();
    const opens = getUserMedia.mock.calls.length;

    for (let rep = 0; rep < 2; rep++) {
      await act(async () => {
        await result.current.start();
      });
      await act(async () => {
        await result.current.stop();
      });
    }
    expect(getUserMedia).toHaveBeenCalledTimes(opens);
    expect(FakeMediaRecorder.instances.map((r) => r.stream)).toEqual([held, held]);
    expect(held.tracks[0].stop).not.toHaveBeenCalled();
  });
});

describe("useRecorder when the microphone goes away mid-take", () => {
  // A Bluetooth headset dropping, a device switch, a revoked permission: the track ends under a
  // running MediaRecorder. What was captured up to then is the User's answer and must be kept.
  it("keeps the partial recording, says what happened, and drops the dead hold", async () => {
    const { result } = renderHook(() => useRecorder());
    await act(async () => {
      await result.current.acquire();
      await result.current.start();
    });
    const held = openedStreams[0];

    act(() => {
      held.tracks[0].onended?.();
    });

    expect(result.current.state).toBe("error");
    expect(result.current.error).toMatch(/microphone stopped/i);
    let blob: Blob | undefined;
    await act(async () => {
      blob = await result.current.stop();
    });
    expect(blob!.size).toBeGreaterThan(0);

    // The hold is gone, so the next take asks for a device afresh instead of recording silence.
    await act(async () => {
      await result.current.start();
    });
    expect(getUserMedia).toHaveBeenCalledTimes(2);
  });

  // A browser fires a recorder's final dataavailable and stop in a later task than the error that
  // ended it, so the stop() asking for the take can come first.
  it("hands over a take a recorder error cut short, even when its data arrives after stop()", async () => {
    const { result } = renderHook(() => useRecorder());
    await act(async () => {
      await result.current.start();
    });
    const recorder = FakeMediaRecorder.instances[0];
    act(() => {
      recorder.onerror?.({ error: new DOMException("The recorder failed.", "UnknownError") });
    });
    expect(result.current.state).toBe("error");

    let blob: Blob | undefined;
    const handedOver = result.current.stop().then((b) => {
      blob = b;
    });
    await act(async () => {
      recorder.state = "inactive";
      recorder.ondataavailable?.({ data: new Blob(["partial take"]) });
      recorder.onstop?.();
      await handedOver;
    });

    expect(await blob!.text()).toBe("partial take");
    expect(result.current.state).toBe("error");
  });
});
