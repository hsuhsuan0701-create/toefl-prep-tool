import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";
import { act, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import MicCheck from "../src/components/MicCheck";

// MicCheck gates every Speaking Drill and the Speaking Simulation: a check that stops offering Try
// again after a failure leaves the User no way to start the run.
function denyMicrophone(name: string, message: string) {
  // Browsers reject getUserMedia with a DOMException, and readableMediaError switches on
  // `err instanceof DOMException` — a plain Error falls through to the generic message.
  const error = new DOMException(message, name);
  Object.defineProperty(navigator, "mediaDevices", {
    configurable: true,
    writable: true,
    value: { getUserMedia: vi.fn().mockRejectedValue(error) },
  });
}

beforeEach(() => {
  vi.stubGlobal("MediaRecorder", class {
    static isTypeSupported() { return true; }
  });
});
afterEach(() => vi.unstubAllGlobals());

describe("MicCheck recovery", () => {
  it("still offers a way out after a SECOND consecutive failure", async () => {
    const user = userEvent.setup();
    denyMicrophone("NotAllowedError", "Permission denied");
    render(<MicCheck onPass={vi.fn()} />);

    await user.click(screen.getByRole("button", { name: /start mic check/i }));
    // The first failure offers Try again.
    expect(await screen.findByRole("button", { name: /try again/i })).toBeInTheDocument();

    // Deny a second time. `useRecorder` sets state "error" while it is already "error", so React
    // bails out of the update and the [state] effect does not re-run. The screen must still leave
    // "Requesting microphone permission…" for the error and its Try again.
    await user.click(screen.getByRole("button", { name: /try again/i }));

    expect(await screen.findByRole("button", { name: /try again/i })).toBeInTheDocument();
    expect(screen.queryByText(/Requesting microphone permission/i)).not.toBeInTheDocument();
  });

  it("surfaces a different error message on the second failure rather than keeping the first", async () => {
    const user = userEvent.setup();
    denyMicrophone("NotAllowedError", "Permission denied");
    render(<MicCheck onPass={vi.fn()} />);

    await user.click(screen.getByRole("button", { name: /start mic check/i }));
    await screen.findByRole("button", { name: /try again/i });

    // Permission granted, but now the device is held by another app — a different failure.
    denyMicrophone("NotReadableError", "Device in use");
    await user.click(screen.getByRole("button", { name: /try again/i }));

    expect(await screen.findByText(/already in use/i)).toBeInTheDocument();
  });
});

describe("MicCheck when it goes away mid-check", () => {
  // Leaving the mic check during its 2 s test recording (Back, a link) must not leave the microphone
  // on: the recording indicator stays lit with nothing on screen to turn it off.
  it("stops the recording and ends the microphone's tracks on unmount", async () => {
    const tracks = [{ stop: vi.fn() }];
    Object.defineProperty(navigator, "mediaDevices", {
      configurable: true,
      writable: true,
      value: { getUserMedia: vi.fn(async () => ({ getTracks: () => tracks })) },
    });
    const recorders: Array<{ state: string; stop: () => void }> = [];
    vi.stubGlobal(
      "MediaRecorder",
      class {
        static isTypeSupported() {
          return true;
        }
        state = "inactive";
        ondataavailable: ((event: { data: Blob }) => void) | null = null;
        onstop: (() => void) | null = null;
        mimeType = "audio/webm";
        constructor() {
          recorders.push(this);
        }
        start() {
          this.state = "recording";
        }
        stop() {
          this.state = "inactive";
          this.onstop?.();
        }
      },
    );
    const user = userEvent.setup();
    const view = render(<MicCheck onPass={vi.fn()} />);

    await user.click(screen.getByRole("button", { name: /start mic check/i }));
    await screen.findByText(/Recording — say a sentence or two/);
    expect(recorders[0].state).toBe("recording");

    view.unmount();
    expect(recorders[0].state).toBe("inactive");
    expect(tracks[0].stop).toHaveBeenCalled();
  });

  // Start pressed, the browser's permission prompt left open, the User navigates away and then
  // clicks Allow: the microphone the browser hands over belongs to no page.
  it("ends a microphone granted after it has gone, and records nothing with it", async () => {
    const tracks = [{ stop: vi.fn() }];
    let grant: (stream: unknown) => void = () => {};
    Object.defineProperty(navigator, "mediaDevices", {
      configurable: true,
      writable: true,
      value: {
        getUserMedia: vi.fn(
          () =>
            new Promise((resolve) => {
              grant = resolve;
            }),
        ),
      },
    });
    const recorders: unknown[] = [];
    vi.stubGlobal(
      "MediaRecorder",
      class {
        static isTypeSupported() {
          return true;
        }
        state = "inactive";
        constructor() {
          recorders.push(this);
        }
        start() {
          this.state = "recording";
        }
        stop() {
          this.state = "inactive";
        }
      },
    );
    const user = userEvent.setup();
    const view = render(<MicCheck onPass={vi.fn()} />);

    await user.click(screen.getByRole("button", { name: /start mic check/i }));
    view.unmount();
    await act(async () => {
      grant({ getTracks: () => tracks });
    });

    expect(tracks[0].stop).toHaveBeenCalled();
    expect(recorders).toHaveLength(0);
  });
});
