import { useCallback, useRef, useState } from "react";

export type RecorderState = "idle" | "recording" | "error";

const PREFERRED_MIME_TYPE = "audio/webm;codecs=opus";

/** The one home for the capture constraints: held-mode `acquire()` and the self-acquiring `start()`
 * must open the same kind of stream.
 *
 * echoCancellation stays false, neither true nor the browser default (pinned by
 * client/test/useRecorder.test.ts). Echo cancellation only helps when audio plays while recording,
 * and nothing in this app does: ItemRecorder sequences stimulus -> beep -> record, the Drill Lab's
 * blind reps listen and record on separate clicks, and MicCheck plays its clip back only after
 * stop(). Requesting it engages macOS's Voice Processing I/O unit, which takes over the output side
 * of the device too, and whose deferred teardown (about 1 s after the tracks stop) cuts into the
 * next Item's stimulus clip. */
const CAPTURE_CONSTRAINTS: MediaStreamConstraints = {
  audio: { echoCancellation: false },
};

// How long stop() waits for the final data of a take the device or an error cut short. A browser
// delivers it within a task; this bound only keeps a recorder that never does from hanging the Item.
const CUT_SHORT_DELIVERY_MS = 1000;

const MIC_LOST_MESSAGE =
  "The microphone stopped — it was disconnected, switched, or its permission was revoked. What was recorded so far is kept.";

/** Maps getUserMedia/MediaRecorder failures to a message the User can act on, rather than a raw
 * DOMException name. */
function readableMediaError(err: unknown): string {
  if (err instanceof DOMException) {
    switch (err.name) {
      case "NotAllowedError":
        return "Microphone access was denied. Allow microphone permission for this site in your browser settings, then try again.";
      case "NotFoundError":
        return "No microphone was found. Connect a microphone and try again.";
      case "NotReadableError":
        return "The microphone is already in use by another app. Close it and try again.";
      default:
        break;
    }
  }
  return err instanceof Error && err.message ? err.message : "Could not access the microphone.";
}

/**
 * Records mic audio as `audio/webm;codecs=opus` via getUserMedia + MediaRecorder, in one of two
 * modes:
 *
 * **Self-acquiring mode** (the default): `start()` requests permission and begins recording;
 * `stop()` resolves once the recorder's final `dataavailable`+`stop` sequence has fired, composing
 * every chunk into one Blob and ending the media tracks (so the browser's recording indicator turns
 * off).
 *
 * **Held mode**: `acquire()` opens the device once and holds the live stream; every later `start()`
 * reuses it, and `stop()` stops only the MediaRecorder — the tracks stay live for the next
 * `start()` until `release()` ends them. Closing the mic between Items engages macOS's deferred
 * Voice Processing I/O teardown, which glitches the output side about 1 s into the next Item's
 * stimulus. Any failure drops the hold, so the next `start()` self-acquires afresh and no failure
 * can leave the mic silently held.
 *
 * If the device goes away mid-take (unplugged, a Bluetooth drop, a device switch, permission
 * revoked), the tracks end under the recorder: what was captured so far is kept and handed over by
 * the next `stop()` (which waits for it when the recorder has not delivered it yet), `state` becomes
 * "error" with a message saying so, and the dead hold is dropped.
 *
 * `stream` is exposed so callers that need a live level meter (MicCheck) can attach their own
 * AnalyserNode without a second getUserMedia call.
 */
export function useRecorder() {
  const [state, setState] = useState<RecorderState>("idle");
  const [error, setError] = useState<string | undefined>(undefined);
  const [stream, setStream] = useState<MediaStream | null>(null);

  const streamRef = useRef<MediaStream | null>(null);
  // True while streamRef holds a run-long stream from acquire(): stop() then leaves the tracks live
  // for the next start(), and only release() (or a failure) ends them.
  const heldRef = useRef(false);
  // The acquire() whose getUserMedia is still pending, tagged with the epoch it started in. A second
  // acquire() in the same epoch joins it instead of opening the device twice; one from an earlier
  // epoch is never handed out, because a release() since then has already condemned its stream.
  const acquiringRef = useRef<{ epoch: number; promise: Promise<MediaStream> } | null>(null);
  // Bumped by every releaseTracks(): an acquire() whose getUserMedia resolves after a release must
  // not resurrect the hold — it sees the epoch moved and stops the fresh tracks immediately.
  const acquireEpochRef = useRef(0);
  const recorderRef = useRef<MediaRecorder | null>(null);
  // The stop() waiting for a recorder's final data, tagged with that recorder, so a late stop event
  // from one take can never hand its Blob to another take's stop().
  const stopWaiterRef = useRef<{ recorder: MediaRecorder; resolve: (blob: Blob) => void } | null>(null);
  // A recorder the device going away (or a recorder error) stopped, whose final data has not arrived
  // yet: a browser's MediaRecorder turns inactive at once and delivers dataavailable and stop in a
  // later task. A stop() in between waits for that take instead of handing over nothing.
  const cutShortRef = useRef<MediaRecorder | null>(null);
  // A take the device cut short, waiting for the stop() that hands it over.
  const interruptedBlobRef = useRef<Blob | null>(null);

  const releaseTracks = useCallback(() => {
    acquireEpochRef.current += 1;
    acquiringRef.current = null;
    streamRef.current?.getTracks().forEach((track) => track.stop());
    streamRef.current = null;
    heldRef.current = false;
    setStream(null);
  }, []);

  // A track ending on its own is the device going away. Wind down whatever is recording (onstop keeps
  // the partial take) and drop the stream, so the next start() asks for a device afresh.
  const watchForDeviceLoss = useCallback(
    (mediaStream: MediaStream) => {
      for (const track of mediaStream.getTracks()) {
        track.onended = () => {
          if (streamRef.current !== mediaStream) return;
          setError(MIC_LOST_MESSAGE);
          setState("error");
          const recorder = recorderRef.current;
          if (recorder && recorder.state !== "inactive") {
            cutShortRef.current = recorder;
            try {
              recorder.stop();
            } catch {
              // Already winding down on its own; onstop still runs.
            }
          }
          releaseTracks();
        };
      }
    },
    [releaseTracks],
  );

  /** Held mode's entry point: open the mic once and hold the stream for a whole run. Idempotent
   * while a hold is live, and safe to call concurrently. Failures set the same readable error state
   * a failed start() would, and throw. */
  const acquire = useCallback(async (): Promise<MediaStream> => {
    if (heldRef.current && streamRef.current) return streamRef.current;
    const pending = acquiringRef.current;
    if (pending && pending.epoch === acquireEpochRef.current) return pending.promise;
    if (recorderRef.current && recorderRef.current.state !== "inactive" && streamRef.current) {
      // A self-acquired recording is mid-flight; opening a second stream here would stomp streamRef
      // out from under it. Hand back the live stream without marking it held, so that recording's
      // own stop() still releases it.
      return streamRef.current;
    }

    if (!navigator.mediaDevices?.getUserMedia || typeof MediaRecorder === "undefined") {
      const message = "Recording isn't supported in this browser (requires HTTPS or localhost).";
      setError(message);
      setState("error");
      throw new Error(message);
    }

    const epoch = acquireEpochRef.current;
    const promise = (async () => {
      const mediaStream = await navigator.mediaDevices.getUserMedia(CAPTURE_CONSTRAINTS);
      if (acquireEpochRef.current !== epoch) {
        // Released while the device was still opening: the caller is gone, so end the tracks right
        // away rather than holding a mic nobody will ever release.
        mediaStream.getTracks().forEach((track) => track.stop());
        return mediaStream;
      }
      streamRef.current = mediaStream;
      heldRef.current = true;
      watchForDeviceLoss(mediaStream);
      setStream(mediaStream);
      setError(undefined);
      setState("idle");
      return mediaStream;
    })();
    const entry = { epoch, promise };
    acquiringRef.current = entry;
    try {
      return await promise;
    } catch (err) {
      const message = readableMediaError(err);
      setError(message);
      setState("error");
      throw err;
    } finally {
      if (acquiringRef.current === entry) acquiringRef.current = null;
    }
  }, [watchForDeviceLoss]);

  const start = useCallback(async () => {
    // A second start() while already recording would overwrite streamRef/recorderRef and interleave
    // two recorders' chunks. Checked against the recorder's own state, not React's `state`, which a
    // stable callback would read stale.
    if (recorderRef.current && recorderRef.current.state !== "inactive") return;

    if (!navigator.mediaDevices?.getUserMedia || typeof MediaRecorder === "undefined") {
      const message = "Recording isn't supported in this browser (requires HTTPS or localhost).";
      setError(message);
      setState("error");
      throw new Error(message);
    }

    try {
      // Held mode reuses the run-long stream — including one whose getUserMedia is still in flight
      // in the current epoch — so starting a take never reopens the device.
      const epoch = acquireEpochRef.current;
      const pending = acquiringRef.current;
      const mediaStream =
        heldRef.current && streamRef.current
          ? streamRef.current
          : pending && pending.epoch === epoch
            ? await pending.promise
            : await navigator.mediaDevices.getUserMedia(CAPTURE_CONSTRAINTS);
      if (acquireEpochRef.current !== epoch) {
        // Released while the device was opening (the permission prompt still up when its page went
        // away): whoever asked is gone, so end these tracks and record nothing. Only this stream's
        // tracks: releaseTracks() would also end a hold opened since.
        mediaStream.getTracks().forEach((track) => track.stop());
        return;
      }
      if (streamRef.current !== mediaStream) watchForDeviceLoss(mediaStream);
      streamRef.current = mediaStream;
      interruptedBlobRef.current = null;

      const mimeType = MediaRecorder.isTypeSupported(PREFERRED_MIME_TYPE) ? PREFERRED_MIME_TYPE : undefined;
      const recorder = new MediaRecorder(mediaStream, mimeType ? { mimeType } : undefined);
      // This take's own chunks: a late event from an earlier recorder never lands in them.
      const chunks: BlobPart[] = [];

      recorder.ondataavailable = (event) => {
        if (event.data.size > 0) chunks.push(event.data);
      };
      recorder.onstop = () => {
        const cutShort = cutShortRef.current === recorder;
        if (cutShort) cutShortRef.current = null;
        // recorder.mimeType is the UA's actual negotiated type: Safari falls back to mp4/aac, and
        // labelling that Blob "audio/webm" would break its playback.
        const blob = new Blob(chunks, { type: recorder.mimeType || "audio/webm" });
        // A take cut short had its tracks released by whatever cut it short.
        if (!heldRef.current && !cutShort) releaseTracks();
        const waiter = stopWaiterRef.current;
        if (waiter?.recorder === recorder) {
          stopWaiterRef.current = null;
          // A take the caller ended goes back to idle; one cut short keeps the "error" that says why.
          if (!cutShort) setState("idle");
          waiter.resolve(blob);
          return;
        }
        // A newer take has started since: this one has nobody left to hand its data to.
        if (recorderRef.current !== null && recorderRef.current !== recorder) return;
        // Nobody asked for this stop: the device went away mid-take. Keep the take for the next
        // stop() rather than throwing the User's answer away.
        interruptedBlobRef.current = blob;
        setError((previous) => previous ?? MIC_LOST_MESSAGE);
        setState("error");
      };
      recorder.onerror = (event) => {
        // A recorder error drops the hold too, so the retry self-acquires a fresh stream and a broken
        // held stream cannot wedge every remaining Item. onstop still follows and keeps the partial.
        cutShortRef.current = recorder;
        releaseTracks();
        setError(readableMediaError(event.error));
        setState("error");
        // Don't rely on recorder.state settling to "inactive" across browsers after an error.
        recorderRef.current = null;
      };

      recorderRef.current = recorder;
      recorder.start();
      setStream(mediaStream);
      setError(undefined);
      setState("recording");
    } catch (err) {
      // No start() failure may leave a (possibly broken) stream silently held.
      releaseTracks();
      const message = readableMediaError(err);
      setError(message);
      setState("error");
      throw err;
    }
  }, [releaseTracks, watchForDeviceLoss]);

  /** Ends the take and hands it over. With nothing recording, hands over a take the device cut short
   * (see onstop), waiting for its final data if the recorder has not delivered it yet, or an empty
   * Blob. */
  const stop = useCallback((): Promise<Blob> => {
    const recorder = recorderRef.current;
    if (recorder && recorder.state !== "inactive") {
      return new Promise<Blob>((resolve) => {
        stopWaiterRef.current = { recorder, resolve };
        recorder.stop();
      });
    }
    const cutShort = cutShortRef.current;
    if (cutShort) {
      // Its stop event is still to come. A browser that never sent it would hang the Item, so after
      // a bound this hands over an empty Blob.
      return new Promise<Blob>((resolve) => {
        const fallback = setTimeout(() => {
          if (stopWaiterRef.current?.recorder !== cutShort) return;
          stopWaiterRef.current = null;
          if (cutShortRef.current === cutShort) cutShortRef.current = null;
          resolve(new Blob([], { type: "audio/webm" }));
        }, CUT_SHORT_DELIVERY_MS);
        stopWaiterRef.current = {
          recorder: cutShort,
          resolve: (blob) => {
            clearTimeout(fallback);
            resolve(blob);
          },
        };
      });
    }
    const interrupted = interruptedBlobRef.current;
    interruptedBlobRef.current = null;
    return Promise.resolve(interrupted ?? new Blob([], { type: "audio/webm" }));
  }, []);

  /** Ends the held stream's tracks (recording indicator off). Safe at any time — with nothing held it
   * is a no-op — and it invalidates any acquire() or start() still opening the device. */
  const release = releaseTracks;

  return { start, stop, acquire, release, state, error, stream };
}
