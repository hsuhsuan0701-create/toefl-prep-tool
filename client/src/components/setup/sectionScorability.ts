import { createContext, useContext, useEffect } from "react";
import type { Section } from "@toefl-prep/shared";
import type { SetupStatus } from "../../lib/api";
import { sectionScorability, type Scorability } from "../../pages/dashboard/suggestNext";

/**
 * The setup status as the screens outside the Dashboard read it: the last answer of
 * GET /api/setup-status, and a way to ask for a fresh one. SetupStatusProvider (App.tsx) supplies it.
 */
export type SetupStatusSource = { status: SetupStatus | null; request: () => void };

export const SetupStatusContext = createContext<SetupStatusSource | null>(null);

/**
 * Whether this machine can score `section`, for a screen that has to say so before the User sits
 * it or after a scoring failure. Each mount asks for a fresh status, so a machine set up since the
 * last screen stops being reported as unscorable; until it answers, the last answer stands. `null`
 * asks nothing (a caller with nothing to say yet, such as a scoring job that has not failed). With
 * no provider, or no answer, the result is `unknown`, and no caller warns on that.
 */
export function useSectionScorability(section: Section | null): Scorability {
  const source = useContext(SetupStatusContext);
  const request = source?.request;
  useEffect(() => {
    if (section && request) request();
  }, [section, request]);
  if (!section) return { state: "unknown" };
  return sectionScorability(section, source?.status ?? null);
}

/**
 * True when the setup status says this machine cannot score `section`: a scoring failure there then
 * says so (ScoringNotSetUpFailure) rather than repeating the server's error. Pass null until there is
 * a failure to explain, so nothing is requested before then.
 */
export function useScoringNotSetUp(section: Section | null): boolean {
  return useSectionScorability(section).state === "blocked";
}

/**
 * True when the setup status the provider already holds says this machine refuses every Speaking
 * upload (`speaking-uploads` is off: ffmpeg is missing, and intake transcodes each recording before
 * it stores anything). Asks for nothing itself: read it beside useSectionScorability("speaking"),
 * which does. With no answer yet it is false, so no caller claims more than it knows.
 */
export function useSpeakingUploadsOff(): boolean {
  const source = useContext(SetupStatusContext);
  return source?.status?.capabilities["speaking-uploads"] === false;
}
