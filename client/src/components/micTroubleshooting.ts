// What to do about a microphone that will not start, by what went wrong. Shared by the mic check and
// by a Speaking Item whose recording could not start, so the advice is the same wherever it shows.
// The messages being classified are useRecorder's own readable errors.

export type MicProblem = "permission" | "device" | "busy" | "unsupported" | "lost" | "other";

export function classifyMicError(message: string | undefined): MicProblem {
  if (!message) return "other";
  if (/denied/i.test(message)) return "permission";
  if (/no microphone was found/i.test(message)) return "device";
  if (/already in use/i.test(message)) return "busy";
  if (/isn't supported/i.test(message)) return "unsupported";
  if (/microphone stopped/i.test(message)) return "lost";
  return "other";
}

export const MIC_FIX_STEPS: Record<MicProblem, string[]> = {
  permission: [
    "Click the lock or site-settings icon in the address bar and allow the microphone for this site.",
    "Then reload this page, or press Try again.",
  ],
  device: [
    "Plug in a microphone or headset.",
    "In your system sound settings, check that it is selected as the input.",
  ],
  busy: [
    "Close other apps or tabs that may be using the microphone: video calls, other recorders.",
    "Then press Try again.",
  ],
  unsupported: [
    "Open this app on localhost or over HTTPS. Browsers only record on a secure origin.",
    "Use a recent Chrome, Edge, Firefox or Safari.",
  ],
  lost: [
    "Check the microphone is still plugged in, or that a Bluetooth headset is still connected.",
    "Then press Try again.",
  ],
  other: ["Reload the page and try again.", "If it keeps happening, try another browser."],
};
