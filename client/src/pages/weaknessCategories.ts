// The Reading and Listening skill accuracy behind WeaknessPanel, the Progress page's weakness
// breakdown. The server sends StatsSummaryVM.skillItems as a flat list of recently scored
// multiple-choice Items (section, skill, correct; computeSkillItems in server/src/routes/stats.ts),
// and this module does all of the aggregation: bucketing, the minimum sample size and the sort.
// Pure, so it is tested on its own.
//
// `skill` is never served with a Set (stripAnswers removes it); it reaches the client only from a
// scored Item's score_json, which Attempt review already receives per Attempt.
export type SkillItemResult = { section: "reading" | "listening"; skill: string; correct: boolean };
export type SkillAccuracy = { section: "reading" | "listening"; skill: string; correct: number; total: number; accuracy: number };

// Below this many samples, an accuracy figure is more likely to be noise than a real weakness.
const MIN_SAMPLE_SIZE = 5;

/**
 * Buckets `items` by section and skill together, never by skill alone: ReadingSkillCategory and
 * ListeningSkillCategory (shared/src/schemas/) share some names ("detail" and "inference"), and a
 * bucket on skill alone would merge a Reading weakness with an unrelated Listening one into one
 * meaningless figure. Drops any bucket with fewer than MIN_SAMPLE_SIZE samples, then sorts the rest
 * by ascending accuracy (the worst, most in need of practice, first), ties by skill name and then
 * section.
 */
export function computeSkillAccuracy(items: SkillItemResult[]): SkillAccuracy[] {
  const buckets = new Map<string, SkillAccuracy>();
  for (const item of items) {
    const key = `${item.section}:${item.skill}`;
    const existing = buckets.get(key);
    if (existing) {
      existing.total += 1;
      if (item.correct) existing.correct += 1;
    } else {
      buckets.set(key, { section: item.section, skill: item.skill, correct: item.correct ? 1 : 0, total: 1, accuracy: 0 });
    }
  }
  return [...buckets.values()]
    .filter((bucket) => bucket.total >= MIN_SAMPLE_SIZE)
    .map((bucket) => ({ ...bucket, accuracy: bucket.correct / bucket.total }))
    .sort((a, b) => a.accuracy - b.accuracy || a.skill.localeCompare(b.skill) || a.section.localeCompare(b.section));
}
