import type { AnySet } from "@toefl-prep/shared";
import { deterministicItemEntries } from "./deterministicScoring.js";

/**
 * Every Item id of a Set in the order the exam presents them: Task Types in section order, and each
 * Task Type's Items in the Set's own order.
 *
 *   Speaking   Listen and Repeat, then Interview
 *   Writing    Build a Sentence, then Email, then Academic Discussion
 *   Reading    per Module (Router, Lower, Upper): Complete the Words, Daily Life, Academic Passage
 *   Listening  per Module: Listen and Choose, Conversation, Announcement, Academic Talk
 *
 * Item results are persisted in the order they land, which a Writing Simulation scrambles (the
 * Email is submitted while Build a Sentence is still being scored), so the review reorders by this.
 */
export function setItemOrder(set: AnySet): string[] {
  switch (set.kind) {
    case "speaking":
      return [...set.listenAndRepeat.items.map((item) => item.id), ...set.interview.questions.map((q) => q.id)];
    case "writing":
      return [...set.buildASentence.items.map((item) => item.id), set.email.id, set.academicDiscussion.id];
    case "reading":
    case "listening":
      // The walk, not the id lookup: ordering a review is display only, so a Set with a duplicate id
      // is still ordered rather than refused.
      return [...deterministicItemEntries(set)].map(([id]) => id);
  }
}

/**
 * `items` sorted into the Set's order. Items the Set does not carry keep their relative order and
 * follow every Item it does, so nothing an Attempt recorded is hidden. Without a Set, `items` is
 * returned as given.
 */
export function orderBySet<T extends { itemId: string }>(items: T[], set: AnySet | undefined): T[] {
  if (!set) return items;
  const position = new Map(setItemOrder(set).map((id, index) => [id, index]));
  return items
    .map((item, index) => ({ item, index, rank: position.get(item.itemId) ?? Number.MAX_SAFE_INTEGER }))
    .sort((a, b) => a.rank - b.rank || a.index - b.index)
    .map(({ item }) => item);
}
