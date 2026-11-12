/**
 * The Build a Sentence task module's public surface.
 *
 * A caller hands in the Task's Items and receives the Responses. Everything else in this directory
 * (the pure run reducer and its pooled budget in `buildSentenceRun.ts`, the Frame slot-fill algebra
 * in `sentenceSlotFill.ts`, the tiles in `SentenceTiles.tsx` and the Item overview in
 * `SentenceItemOverview.tsx`) is internal and deliberately not re-exported: `BuildSentenceTask`
 * wires them together, so the Writing Drill and the Writing Simulation mount one implementation.
 *
 * The budget constants are public because both call sites describe the pooled budget in their own
 * chrome (the Drill's Task picker and the Simulation's intro screen) before the module is mounted.
 * `BUILD_A_SENTENCE_BUDGET_CLOCK` is the copy those screens print: the budget is not a whole number
 * of minutes, so its formatting sits next to the constant rather than being rounded in each page.
 *
 * The module's own unit tests import the internals directly by path; nothing else may.
 */
export { default as BuildSentenceTask } from "./BuildSentenceTask";
export type { BuildSentenceTaskMode, BuildSentenceTaskProps } from "./BuildSentenceTask";
export { BUILD_A_SENTENCE_BUDGET_CLOCK, BUILD_A_SENTENCE_BUDGET_SEC } from "./buildSentenceRun";
export type { BuildSentenceResponse, BuildSentenceRunEnd } from "./buildSentenceRun";
export type { BuildSentenceItem } from "./SentenceTiles";
