import { isDeterministicTaskType } from "@toefl-prep/shared";
import { formatPercent } from "../ui/format";

// What a Task Type's score is out of. Every Task Type reports its per-Item score through the same
// `item_results.score` column and the same TrendPointVM.avgScore field, but two different scales
// live there:
//
//   accuracy (0-1)  Build a Sentence and every Reading and Listening Task Type. Marked right or
//                   wrong from the key, so an Attempt's average is a proportion correct.
//   rubric   (0-5)  Email, Academic Discussion, Listen and Repeat, Interview. Scored by the
//                   Judges and Arbiter against the rubric.
//
// A chart that assumes one scale for all twelve squashes every accuracy series into the bottom
// fifth of a 0-5 axis.
//
// The membership test is not restated here: `isDeterministicTaskType`
// (shared/src/schemas/primitives.ts) is derived from the Reading and Listening Task Type enums plus
// build_sentence, and is the predicate scoring itself uses, so a new Task Type lands on the right
// scale without a change here. The registry (taskTypes.ts) gets each row's `scale` by calling
// scaleFor.
export type TaskTypeScale = {
  max: 1 | 5;
  kind: "accuracy" | "rubric";
};

export function scaleFor(taskType: string): TaskTypeScale {
  return isDeterministicTaskType(taskType) ? { max: 1, kind: "accuracy" } : { max: 5, kind: "rubric" };
}

// Human-facing score for one Attempt: a proportion reads as a whole percent, rounded down so only a
// perfect score reads 100% (formatPercent, as the skill-accuracy pane in WeaknessPanel.tsx uses); a
// rubric average keeps its denominator visible so a 4.2 is never mistaken for a band.
export function formatScore(taskType: string, value: number): string {
  const scale = scaleFor(taskType);
  return scale.kind === "accuracy" ? formatPercent(value) : `${value.toFixed(2)} / 5`;
}

// Axis ticks for the scale, in data units: recharts plots the raw 0-1 or 0-5 value, and only the
// tick label is formatted. Quarters for accuracy, whole points for a rubric.
export function axisTicks(taskType: string): number[] {
  return scaleFor(taskType).max === 1 ? [0, 0.25, 0.5, 0.75, 1] : [0, 1, 2, 3, 4, 5];
}

export function formatAxisTick(taskType: string, value: number): string {
  return scaleFor(taskType).kind === "accuracy" ? `${Math.round(value * 100)}%` : String(value);
}
