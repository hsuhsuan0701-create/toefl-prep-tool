import {
  NOT_CAPTURED_ITEM_ERROR,
  isSkippedItemScoreJson,
  type AttemptBandStatusVM,
  type BandShortfallVM,
  type ItemVM,
  type ModuleShortfallVM,
  type Section,
} from "@toefl-prep/shared";
import { taskTypeLabel } from "../../lib/taskTypes";
import { isTerminalTranscriptionFailure } from "../../lib/transcriptionFailure";
import { joinAnd } from "../../ui/format";
import {
  MODULE_LABEL,
  MODULE_PATH_LABEL,
  NOT_TRANSCRIBED,
  SCORING_JOB_STATUS,
  SECTION_LABEL,
  TRANSCRIPTION_JOB_STATUS,
  itemScoringStatus,
  type StatusPresentation,
} from "../../ui/labels";
import type { ScoringJobState } from "../../hooks/useScoringJob";
import {
  isBuildSentenceScoreJson,
  isDeterministicScoreJson,
  isFailedScoreJson,
  isManualRescoreItem,
  isPersistedScoreItem,
} from "./reviewItems";

// The words Attempt review puts on screen for states that need a sentence rather than a label:
// why there is no band and what can be done about it, why an Item failed, and what each group of
// Items adds up to. Pure, so each sentence is tested once and every renderer says it the same way.

export function itemsWord(n: number): string {
  return `${n} ${n === 1 ? "Item" : "Items"}`;
}

/** "First letter up": Set fields such as a genre or a setting are stored in lower case. */
export function capitalise(text: string): string {
  return text.charAt(0).toUpperCase() + text.slice(1);
}

/** "a", "a or b", "a, b or c". */
export function joinOr(parts: readonly string[]): string {
  return parts.length <= 1 ? (parts[0] ?? "") : `${parts.slice(0, -1).join(", ")} or ${parts[parts.length - 1]}`;
}

/**
 * `final`: nothing on this page can bring a band to this Attempt as it stands, so "yet" would be a
 * promise.
 */
export type BandExplanation = { reason: string; action: string | null; final: boolean };

/** What Attempt review says, in place of a Re-score, on an Attempt the User discarded. */
export const DISCARDED_NOT_SCORABLE = "This Attempt was discarded, so it cannot be scored.";

function counted(n: number, taskType: string, noun: string): string {
  return `${n} ${taskTypeLabel(taskType)} ${n === 1 ? noun : `${noun}s`}`;
}

/**
 * Why a routed Reading or Listening Attempt has no band for want of a Module's Items: the Module it
 * was routed to and never answered, or the Task Types a Module it did answer has no Response of.
 */
function moduleShortfallReason({ module, sat, absent }: ModuleShortfallVM): string {
  if (!sat && module !== "router") return `This Simulation was routed to the ${MODULE_LABEL[module]} and ended before any of it was answered.`;
  if (!sat) return "No Router Module Response was recorded.";
  return `No ${joinOr(absent.map(taskTypeLabel))} Response was recorded in the ${MODULE_LABEL[module]}.`;
}

/**
 * Why a settled Attempt (or Full-Test section) has no band, one sentence per kind of shortfall:
 * "6 Listen and Repeat Items failed scoring." Empty when nothing is short.
 */
export function shortfallReasons({ unscored, absent, moduleShortfalls = [] }: BandShortfallVM): string[] {
  const reasons: string[] = [];
  const failed = unscored.filter((u) => u.failed > 0);
  if (failed.length > 0) reasons.push(`${joinAnd(failed.map((u) => counted(u.failed, u.taskType, "Item")))} failed scoring.`);
  const notCaptured = unscored.filter((u) => u.notCaptured > 0);
  if (notCaptured.length > 0) {
    reasons.push(`${joinAnd(notCaptured.map((u) => counted(u.notCaptured, u.taskType, "recording")))} never reached the server.`);
  }
  const pending = unscored.filter((u) => u.pending > 0);
  if (pending.length > 0) {
    const total = pending.reduce((sum, u) => sum + u.pending, 0);
    reasons.push(`${joinAnd(pending.map((u) => counted(u.pending, u.taskType, "Response")))} ${total === 1 ? "was" : "were"} never scored.`);
  }
  if (absent.length > 0) reasons.push(`No ${joinOr(absent.map(taskTypeLabel))} Response was recorded.`);
  for (const shortfall of moduleShortfalls) reasons.push(moduleShortfallReason(shortfall));
  return reasons;
}

/**
 * Why an Attempt has no band, and the one thing the User can do about it (or that there is nothing
 * to do). Never says "insufficient coverage": it names the Task Types, as the User would.
 */
export function bandExplanation(status: AttemptBandStatusVM, section: Section, items: readonly ItemVM[]): BandExplanation | null {
  const sectionName = SECTION_LABEL[section];
  switch (status.status) {
    case "estimated":
      return null;
    case "discarded":
      return { reason: "This Attempt was discarded, so it counts toward nothing.", action: null, final: true };
    case "not-applicable":
      return status.reason === "drill"
        ? { reason: `${sectionName} Drills do not produce a band.`, action: `Take a ${sectionName} Simulation for one.`, final: true }
        : { reason: "This Simulation ended before its Router Module was scored, so it was never routed and has no band.", action: null, final: true };
    case "unfinished":
      return { reason: "This Attempt was never finished, so it has no band.", action: null, final: false };
    case "scoring": {
      const parts = status.outstanding.map((o) => `${itemsWord(o.itemCount)} of ${taskTypeLabel(o.taskType)}`);
      return {
        reason: parts.length > 0 ? `Still scoring ${joinAnd(parts)}.` : "Still scoring: the last scores are being recorded.",
        action: "The band appears when scoring finishes.",
        final: false,
      };
    }
    case "incomplete": {
      const reasons = shortfallReasons(status);
      if (reasons.length === 0) return { reason: "No Band Estimate was recorded for this Attempt.", action: null, final: true };
      return { reason: reasons.join(" "), ...shortfallAction(shortfallRemedy(status, items)) };
    }
  }
}

/**
 * What an Attempt review can do about a settled shortfall, decided once for every page that words it
 * (Attempt review says "below", the Full-Test Run report "from this section's report"):
 *
 *   can-still-come  every unscored Item can be scored from the review: `rescore` Items by a Re-score,
 *                   and, when `retry`, recordings by retrying their transcription;
 *   lost            only a new Attempt can have a band: a Task Type or Module with no Item, a failed
 *                   Item nothing can re-score (a recording that never arrived), or a transcription
 *                   that failed for good. `rescorable` says whether a Re-score still shows Score
 *                   Reports;
 *   unknown         an unscored Item has nothing working on it and nothing on the review to start it
 *                   (a recording or an essay with no job), so the review promises nothing either way.
 */
export type ShortfallRemedy =
  | { outlook: "can-still-come"; rescore: number; retry: boolean }
  | { outlook: "lost"; rescorable: boolean }
  | { outlook: "unknown" };

/**
 * The review's decision for a shortfall, Item by Item. Without `items` (an Attempt not loaded) it
 * decides only what the shortfall alone settles, a Task Type or Module with no Item at all, and
 * otherwise says `unknown`: counts cannot tell a retryable transcription from a lost one.
 */
export function shortfallRemedy(shortfall: BandShortfallVM, items: readonly ItemVM[] | null): ShortfallRemedy {
  const short = new Set(shortfall.unscored.map((u) => u.taskType));
  const unscored = (items ?? []).filter((item) => short.has(item.taskType) && item.scoringStatus !== "scored");
  const rescorable = unscored.filter((item) => isManualRescoreItem(item));
  // A Module short of Items is as final as an absent Task Type: nothing on the review can add them.
  // With no unscored Item either, every Item is scored and there is still no band: nothing to score.
  if (shortfall.absent.length > 0 || (shortfall.moduleShortfalls?.length ?? 0) > 0 || shortfall.unscored.length === 0) {
    return { outlook: "lost", rescorable: rescorable.length > 0 };
  }
  if (items === null) return { outlook: "unknown" };

  const retryable = unscored.filter(
    (item) => item.transcriptionJob?.status === "failed" && !isTerminalTranscriptionFailure(item.transcriptionJob),
  );
  const stuck = unscored.filter((item) => !rescorable.includes(item) && !retryable.includes(item));
  // A failed Item nothing can re-score, or a recording whose transcription failed for good (the
  // review offers no Retry for it and says only a new Attempt can score it), is lost.
  const lost = stuck.some(
    (item) => item.scoringStatus === "failed" || (item.transcriptionJob !== undefined && isTerminalTranscriptionFailure(item.transcriptionJob)),
  );
  if (lost) return { outlook: "lost", rescorable: rescorable.length > 0 };
  if (stuck.length > 0) return { outlook: "unknown" };
  return { outlook: "can-still-come", rescore: rescorable.length, retry: retryable.length > 0 };
}

/** The remedy in Attempt review's words, which point at the Items "below". */
function shortfallAction(remedy: ShortfallRemedy): Omit<BandExplanation, "reason"> {
  switch (remedy.outlook) {
    case "lost":
      return {
        action: remedy.rescorable
          ? "Re-scoring the failed Items below still shows their Score Reports, but only a new Attempt can have a band."
          : "Only a new Attempt can have a band.",
        final: true,
      };
    // Nothing here can start what the Item waits on, so "yet" would be a promise this page cannot keep.
    case "unknown":
      return { action: null, final: true };
    case "can-still-come":
      if (!remedy.retry) return { action: `Re-score ${remedy.rescore === 1 ? "it" : "them"} below to get a band.`, final: false };
      if (remedy.rescore === 0) return { action: "Retry the transcription below; the band follows once it is scored.", final: false };
      return { action: "Re-score the failed Items and retry the transcription below to get a band.", final: false };
  }
}

const KNOWN_FAILURES: Record<string, string> = {
  [NOT_CAPTURED_ITEM_ERROR]: "The recording never reached the server.",
  "scoring request did not arrive": "The recording arrived, but it was never sent for scoring.",
  "scoring interrupted": "Scoring was interrupted when the server stopped.",
  "arbiter omitted item": "The Arbiter returned no score for this Item.",
};

/**
 * Why an Item failed, in the User's terms. The server's own words go behind a disclosure: they are
 * written for debugging and may name the service that failed.
 */
export function failureText(scoreJson: unknown): { summary: string; detail: string | null } {
  const raw = isFailedScoreJson(scoreJson) ? scoreJson.error : null;
  if (raw === null) return { summary: "Nothing was scored for this Item.", detail: null };
  const known = KNOWN_FAILURES[raw.trim().toLowerCase()];
  return known ? { summary: known, detail: null } : { summary: "Scoring did not finish.", detail: raw };
}

/** One Item with its position in the Attempt (1-based), which the cards print as "Item n of N". */
export type IndexedItem = { item: ItemVM; position: number };

/**
 * A run of consecutive Items that the review shows together, in test order:
 *   build_sentence  a Writing Attempt's Build a Sentence Items, as one collapsible list;
 *   judged          one judged Task Type (Email, Academic Discussion, Listen and Repeat, Interview);
 *   module          a Reading or Listening Module's Items, grouped further by Stimulus.
 */
export type ReviewGroup =
  | { kind: "build_sentence"; key: string; taskType: string; items: IndexedItem[] }
  | { kind: "judged"; key: string; taskType: string; items: IndexedItem[] }
  | { kind: "module"; key: string; module: string; items: IndexedItem[] };

export function reviewGroups(items: readonly ItemVM[], renderer: (taskType: string) => string | undefined): ReviewGroup[] {
  const groups: ReviewGroup[] = [];
  items.forEach((item, i) => {
    const entry: IndexedItem = { item, position: i + 1 };
    const kind = renderer(item.taskType);
    const last = groups[groups.length - 1];
    if (kind === "deterministic") {
      const module = isDeterministicScoreJson(item.scoreJson) ? item.scoreJson.module : "router";
      if (last?.kind === "module" && last.module === module) last.items.push(entry);
      else groups.push({ kind: "module", key: `module-${module}`, module, items: [entry] });
      return;
    }
    const groupKind = kind === "build_sentence" ? "build_sentence" : "judged";
    if (last && last.kind === groupKind && last.taskType === item.taskType) last.items.push(entry);
    else groups.push({ kind: groupKind, key: `type-${item.taskType}`, taskType: item.taskType, items: [entry] });
  });
  // A Task Type can come back after another, and keys must stay unique for anchors.
  const seen = new Map<string, number>();
  for (const group of groups) {
    const n = (seen.get(group.key) ?? 0) + 1;
    seen.set(group.key, n);
    if (n > 1) group.key = `${group.key}-${n}`;
  }
  return groups;
}

export function moduleName(module: string): string {
  if (module === "lower" || module === "upper") return MODULE_PATH_LABEL[module];
  return module === "router" ? "Router Module" : capitalise(module);
}

function correctCount(items: readonly IndexedItem[]): { correct: number; scored: number } {
  let correct = 0;
  let scored = 0;
  for (const { item } of items) {
    if (item.scoringStatus !== "scored") continue;
    const j = item.scoreJson;
    if (isDeterministicScoreJson(j) || isBuildSentenceScoreJson(j)) {
      scored += 1;
      if (j.correct) correct += 1;
    }
  }
  return { correct, scored };
}

/** "8 of 10 correct", with the Items not scored named when there are any. */
export function correctSummary(items: readonly IndexedItem[]): string {
  const { correct, scored } = correctCount(items);
  const base = `${correct} of ${scored} correct`;
  const unscored = items.length - scored;
  return unscored > 0 ? `${base} · ${unscored} not scored` : base;
}

/**
 * What a group adds up to while the Attempt's marks are withheld (AttemptDetailVM.marksWithheld): how
 * many Items, and how many are not scored, but never how many are correct.
 */
export function unmarkedSummary(items: readonly IndexedItem[]): string {
  const { scored } = correctCount(items);
  const unscored = items.length - scored;
  return unscored > 0 ? `${itemsWord(items.length)} · ${unscored} not scored` : itemsWord(items.length);
}

/** What one judged group adds up to, for the jump list: "4 / 5", "Scoring failed", "7 Items · 1 failed". */
export function judgedSummary(items: readonly IndexedItem[]): string {
  if (items.length === 1) {
    const { item } = items[0];
    if (item.scoringStatus === "scored" && isSkippedItemScoreJson(item.scoreJson)) return "skipped, 0 / 5";
    if (item.scoringStatus === "scored" && isPersistedScoreItem(item.scoreJson)) return `${item.scoreJson.finalScore} / ${item.scoreJson.maxScore}`;
    if (item.scoringStatus === "failed") return "Scoring failed";
    return "Not scored yet";
  }
  const failed = items.filter(({ item }) => item.scoringStatus === "failed").length;
  return failed > 0 ? `${itemsWord(items.length)} · ${failed} failed` : itemsWord(items.length);
}

/**
 * An Item's status chip: the live job's state while one covers it; for a recording waiting on Ears,
 * its transcription job's state (a failed one is not "Transcribing"), or "Not transcribed" once
 * nothing on the server is working on it; otherwise the Item's own scoring status.
 */
export function itemStatusChip(item: ItemVM, jobView: ScoringJobState | undefined, settled: boolean): StatusPresentation {
  if (jobView) return SCORING_JOB_STATUS[jobView.status === "starting" ? "queued" : jobView.status];
  if (item.scoringStatus === "transcription_pending") {
    if (item.transcriptionJob) return TRANSCRIPTION_JOB_STATUS[item.transcriptionJob.status];
    if (settled) return NOT_TRANSCRIBED;
  }
  return itemScoringStatus(item.scoringStatus);
}
