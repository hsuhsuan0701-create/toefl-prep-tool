// Word counting, for the essay editor (EssayEditor.tsx) and a Score Report's Response
// (components/ScoreCard.tsx). Kept out of the component file so that file exports components only
// (react/only-export-components).

/** Words counted as runs of non-space characters. */
export function countWords(text: string): number {
  return text.trim().split(/\s+/).filter(Boolean).length;
}

/**
 * A Task's word guidance: Write an Email gives a range (`min`–`max`), Academic Discussion a floor
 * (`min`, no `max`).
 */
export type WordGuide = { min: number; max?: number };

export type WordGuideStatus = "below" | "within" | "over";

/** Where a count sits against its guide. A floor-only guide is never "over". */
export function wordGuideStatus(count: number, guide: WordGuide): WordGuideStatus {
  if (count < guide.min) return "below";
  if (guide.max !== undefined && count > guide.max) return "over";
  return "within";
}

/** The guide in words: "80–120 words", "100+ words". */
export function wordGuideText(guide: WordGuide): string {
  return guide.max === undefined ? `${guide.min}+ words` : `${guide.min}–${guide.max} words`;
}
