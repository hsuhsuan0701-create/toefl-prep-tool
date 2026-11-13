import type { ScoreCaution } from "../ui/labels";
import type { JudgeSummary, ScoreReportItem } from "./ScoreCard";

/**
 * Which cautions this Score Report carries. A no-speech 0, and an essay's no-words 0, carry none: no
 * Judge was asked, so there is nothing about the Judges to qualify.
 */
export function scoreCautions(item: ScoreReportItem, judges: readonly JudgeSummary[]): ScoreCaution[] {
  if (item.noSpeechDetected || item.noWordsWritten) return [];
  const out: ScoreCaution[] = [];
  if (item.singleJudge || judges.length === 1) out.push("single-judge");
  if (item.lowConfidence) out.push("disagreement");
  if (judges.some((j) => j.mode === "text-fallback")) out.push("text-fallback");
  if (item.selfArbitrated) out.push("self-arbitrated");
  return out;
}
