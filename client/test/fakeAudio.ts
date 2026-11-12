import { act, waitFor } from "@testing-library/react";
import { expect } from "vitest";

/**
 * A stand-in for the browser's HTMLAudioElement, installed with `vi.stubGlobal("Audio",
 * FakeAudioElement)`. It plays nothing and fires no event by itself: a test drives every "ended" or
 * "error" through `dispatch`, so it decides exactly when a clip finishes. Every element constructed
 * is kept in `instances`, which a test resets in its `beforeEach` (with `nextPlayResult`, if it
 * changes that).
 */
export class FakeAudioElement {
  static instances: FakeAudioElement[] = [];
  /**
   * What `play()` does on the next element constructed: resolve (playback began), reject as a
   * blocked autoplay does, or stay pending, as it does while the clip's request is neither answered
   * nor failed.
   */
  static nextPlayResult: "resolve" | "reject" | "pending" = "resolve";

  src: string;
  paused = false;
  playCalls = 0;
  pauseCalls = 0;
  /**
   * Whether the element was told to drop its source (`removeAttribute("src")`, then `load()`), as a
   * player does to give up a load. `src` keeps its value, so a test still finds the element by it.
   */
  sourceDropped = false;
  loadCalls = 0;
  private readonly playResult: "resolve" | "reject" | "pending";
  private listeners: Record<string, Array<() => void>> = {};

  constructor(src: string) {
    this.src = src;
    this.playResult = FakeAudioElement.nextPlayResult;
    FakeAudioElement.instances.push(this);
  }

  addEventListener(type: string, listener: () => void) {
    (this.listeners[type] ??= []).push(listener);
  }

  // A real EventTarget has it; no component under test relies on it detaching anything.
  removeEventListener() {}

  play(): Promise<void> {
    this.playCalls += 1;
    if (this.playResult === "pending") return new Promise(() => {});
    return this.playResult === "resolve" ? Promise.resolve() : Promise.reject(new Error("play() failed"));
  }

  pause() {
    this.paused = true;
    this.pauseCalls += 1;
  }

  removeAttribute(name: string) {
    if (name === "src") this.sourceDropped = true;
  }

  load() {
    this.loadCalls += 1;
  }

  dispatch(type: string) {
    for (const listener of this.listeners[type] ?? []) listener();
  }
}

/** The most recent element whose src contains `fragment`: the one currently on screen. */
export function audioBySrc(fragment: string): FakeAudioElement {
  const matches = FakeAudioElement.instances.filter((a) => a.src.includes(fragment));
  expect(matches.length).toBeGreaterThan(0);
  return matches[matches.length - 1];
}

/**
 * Fires `type` on an audio element whose src ends with `file`, waiting first for the player to have
 * created it. A player creates its element in an effect, which can run after the click that started
 * its run has returned and after its screen is already in the DOM, so dispatching on whatever element
 * existed at that moment could send the event to the previous clip, or nowhere.
 *
 * `nth` (1-based) waits for that many elements with this src and fires on the nth: a clip reloaded
 * after a failure gets a fresh element each time, and the event belongs to the reload's element, not
 * to the one that already failed. Without it, the latest.
 */
export async function dispatchAudio(file: string, type: "ended" | "error", nth?: number): Promise<FakeAudioElement> {
  const audio = await waitFor(() => {
    const forFile = FakeAudioElement.instances.filter((a) => a.src.endsWith(file));
    const found = nth === undefined ? forFile.at(-1) : forFile[nth - 1];
    if (!found) throw new Error(`no audio element ${nth ?? "yet"} for ${file} (${forFile.length} so far)`);
    return found;
  });
  await act(async () => {
    audio.dispatch(type);
  });
  return audio;
}

/** Ends the latest audio whose src ends with `file`, once its player has created it. */
export async function endAudio(file: string): Promise<void> {
  await dispatchAudio(file, "ended");
}
