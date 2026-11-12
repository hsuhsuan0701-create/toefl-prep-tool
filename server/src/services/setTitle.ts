import { stripAnswers, type AnySet, type ServedSet } from "@toefl-prep/shared";

/**
 * A Set's display name for the practice lists, the Simulation picker and the Attempt log.
 *
 * Derived from the SERVED form of the Set — the output of `stripAnswers`, the same object
 * GET /api/sets/:id hands the client — so the type itself rules out every answer-bearing field: no
 * Listen and Repeat target sentence, interview question, Build a Sentence key, transcript,
 * utterance, completion, option key or explanation can be reached from here. What a title quotes is
 * text the learner is shown when they open the Set anyway.
 *
 * Per section, the most specific human-written label the Set carries:
 *   Speaking   the Listen and Repeat scenario; summary: the Interview scenario
 *   Writing    the email subject; summary: the Academic Discussion course
 *   Reading    the Router Module's academic passage title (every routed Attempt reads it);
 *              summary: the disciplines of all academic passages
 *   Listening  the Router Module's first conversation setting, cut at its first comma (the rest of
 *              a setting often names the conversation's premise); summary: the academic talk
 *              disciplines
 */
export type SetTitle = { title: string; summary: string | null };

export const SET_TITLE_MAX_LENGTH = 60;
const SUMMARY_MAX_LENGTH = 120;

const KIND_LABEL: Record<ServedSet["kind"], string> = {
  speaking: "Speaking",
  writing: "Writing",
  reading: "Reading",
  listening: "Listening",
};

/** The title of a stored Set, computed from its served form. */
export function setTitleFor(set: AnySet): SetTitle {
  return servedSetTitle(stripAnswers(set));
}

/**
 * A served Set's title and summary (see SetTitle), whitespace collapsed and cut at a word boundary
 * to SET_TITLE_MAX_LENGTH and 120 characters. An empty title becomes "Untitled <Section> Set", an
 * empty summary null.
 */
export function servedSetTitle(set: ServedSet): SetTitle {
  const { title, summary } = rawTitle(set);
  const cleanTitle = truncate(clean(title), SET_TITLE_MAX_LENGTH);
  const cleanSummary = truncate(clean(summary), SUMMARY_MAX_LENGTH);
  return {
    title: cleanTitle === "" ? `Untitled ${KIND_LABEL[set.kind]} Set` : cleanTitle,
    summary: cleanSummary === "" ? null : cleanSummary,
  };
}

function rawTitle(set: ServedSet): { title: string; summary: string } {
  switch (set.kind) {
    case "speaking":
      return {
        title: firstNonEmpty(set.listenAndRepeat.scenarioTitle, set.interview.scenarioTitle),
        summary: labelled("Interview", [set.interview.scenarioTitle]),
      };
    case "writing":
      return {
        title: firstNonEmpty(set.email.subject, set.academicDiscussion.courseTitle),
        summary: labelled("Academic Discussion", [set.academicDiscussion.courseTitle]),
      };
    case "reading": {
      const modules = [set.router, set.lowerModule, set.upperModule];
      return {
        title: firstNonEmpty(
          ...set.router.academic.map((passage) => passage.title),
          ...set.router.ctwPassages.map((passage) => sentenceCase(passage.topic)),
          ...modules.flatMap((module) => module.academic.map((passage) => passage.title)),
        ),
        summary: labelled("Academic passages", modules.flatMap((module) => module.academic.map((p) => p.discipline))),
      };
    }
    case "listening": {
      const modules = [set.router, set.lowerModule, set.upperModule];
      return {
        title: firstNonEmpty(
          ...set.router.conversations.map((conversation) => settingTitle(conversation.setting)),
          ...set.router.announcements.map((announcement) => settingTitle(announcement.setting)),
          ...modules.flatMap((module) => module.academicTalks.map((talk) => sentenceCase(talk.discipline))),
        ),
        summary: labelled("Academic talks", modules.flatMap((module) => module.academicTalks.map((t) => t.discipline))),
      };
    }
  }
}

/** "Label · a, b" over the distinct non-empty values, or "" when there are none. */
function labelled(label: string, values: string[]): string {
  const distinct = [...new Set(values.map(clean).filter((value) => value !== ""))];
  return distinct.length === 0 ? "" : `${label} · ${distinct.join(", ")}`;
}

function firstNonEmpty(...candidates: string[]): string {
  return candidates.map(clean).find((candidate) => candidate !== "") ?? "";
}

function settingTitle(setting: string): string {
  const place = clean(setting).split(",")[0] ?? "";
  return sentenceCase(place.replace(/^(a|an|the)\s+/i, ""));
}

function sentenceCase(text: string): string {
  const trimmed = clean(text);
  return trimmed.charAt(0).toUpperCase() + trimmed.slice(1);
}

function clean(text: string): string {
  return text.replace(/\s+/g, " ").trim();
}

/** Cuts at the last word boundary that leaves room for the ellipsis; never mid-word unless forced. */
function truncate(text: string, max: number): string {
  if (text.length <= max) return text;
  const room = text.slice(0, max - 1);
  const boundary = room.lastIndexOf(" ");
  const cut = (boundary > 0 ? room.slice(0, boundary) : room).replace(/[\s,;:–—-]+$/, "");
  return `${cut}…`;
}
