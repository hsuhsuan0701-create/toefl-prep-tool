import { GenerationDomainFamilySchema, type GenerationDomainFamily } from "@toefl-prep/shared";
import { rawTokens, suffixNormalize } from "./noveltySimilarity.js";

// =================================================================================================
// The generation domain taxonomy: the keyword table that decides which GenerationDomainFamily a
// piece of prose belongs to, the classifier built from it, the contradiction rule the plan and
// candidate checks both ask (`domainCompatible`), and the per-family counting types.
//
// It owns no Set, no Plan and no DiversityIssue: what to do about a drifting domain is
// generationNovelty.ts's (and its tier generationCheckPolicy.ts's), and tallying a Catalog is
// generationCatalog.ts's `domainCounts`.
//
// The classifier uses `noveltySimilarity`'s tokenizer and stemmer but not its stop-word filter — see
// `classifierTerm`.
// =================================================================================================

// The keyword table the domain classifier uses. It is also sent to the planner
// (generationPlanner.ts's plannerPrompt), because plan validation checks a Plan's own prose against
// it, and a classification the model cannot see is a rule it cannot satisfy.
export const DOMAIN_KEYWORDS: Readonly<
  Record<GenerationDomainFamily, readonly string[]>
> = Object.freeze({
  "science-environment": [
    "laboratory", "experiment", "climate", "habitat", "energy", "biology",
    "environment", "biodiversity",
  ],
  "technology-media": [
    "software", "device", "podcast", "digital", "media", "online",
  ],
  "arts-culture": [
    "gallery", "museum", "music", "theater", "theatre", "ceramic",
    "festival", "art",
  ],
  "health-wellbeing": [
    "health", "clinic", "exercise", "sleep", "nutrition", "stress",
    "wellbeing",
  ],
  "services-travel": [
    "travel", "train", "bus", "hotel", "ticket", "route", "station",
  ],
  "history-social-change": [
    "history", "heritage", "migration", "reform", "tradition", "historical",
  ],
  "community-civic": [
    "community", "city", "public", "neighborhood", "volunteer", "civic",
    "municipal",
  ],
  "workplace-business": [
    "office", "manager", "customer", "business", "workplace", "company",
    "employee",
  ],
  "campus-academics": [
    "campus", "course", "professor", "library", "student", "university",
    "academic",
  ],
  // The deliberate fallback: no keywords, never a positive classification.
  "everyday-life": [],
});

// Classification order is part of the contract: on a tie the earliest rule wins, so the table is
// evaluated most-specific first. `everyday-life` is absent — it is only ever reached as a fallback.
const DOMAIN_RULE_ORDER: readonly GenerationDomainFamily[] = [
  "science-environment",
  "technology-media",
  "arts-culture",
  "health-wellbeing",
  "services-travel",
  "history-social-change",
  "community-civic",
  "workplace-business",
  "campus-academics",
];

const DOMAIN_RULES: readonly {
  domain: GenerationDomainFamily;
  terms: readonly string[];
}[] = DOMAIN_RULE_ORDER.map((domain) => ({
  domain,
  // Terms are stemmed exactly as the text they are matched in, so "students" in a Set matches
  // "student" in the table.
  terms: DOMAIN_KEYWORDS[domain].map((term) => classifierTerm(term)),
}));

/**
 * A keyword in the form the classifier compares. Domain classification does not drop stop words:
 * STOP_WORDS keeps fixed task language out of novelty signals and so contains "student", which is
 * `campus-academics`' most discriminative keyword.
 */
export function classifierTerm(term: string): string {
  return rawTokens(term).map(suffixNormalize).join(" ");
}

/** The distinct stemmed tokens of raw text, stop words kept: what classifier terms match against. */
export function classifierTokens(value: string): Set<string> {
  return new Set(rawTokens(value).map(suffixNormalize).filter(Boolean));
}

/** Distinct keyword hits per family in one component's raw text; a family with none is absent. */
export function domainKeywordHits(
  text: string,
): Partial<Record<GenerationDomainFamily, number>> {
  const tokens = classifierTokens(text);
  const hits: Partial<Record<GenerationDomainFamily, number>> = {};
  for (const rule of DOMAIN_RULES) {
    const count = rule.terms.filter((term) => tokens.has(term)).length;
    if (count > 0) hits[rule.domain] = count;
  }
  return hits;
}

/**
 * The family with the most distinct keyword hits in `text`; on a tie the earlier rule wins, and with
 * no hit at all the answer is `everyday-life`.
 */
export function inferGenerationDomain(
  text: string,
): GenerationDomainFamily {
  const tokens = classifierTokens(text);
  let bestDomain: GenerationDomainFamily = "everyday-life";
  let bestCount = 0;
  for (const rule of DOMAIN_RULES) {
    const count = rule.terms.filter((term) => tokens.has(term)).length;
    if (count > bestCount) {
      bestCount = count;
      bestDomain = rule.domain;
    }
  }
  return bestDomain;
}

// A single stray keyword never contradicts a declared domain: suffix normalization alone turns
// "training" into "train" (services-travel), and a ten-word Build a Sentence answer carries little
// domain signal.
const CONTRADICTING_DOMAIN_HITS = 2;

/**
 * False when a component's text contradicts its declared domain: no keyword support at all for the
 * declared domain, and at least two keywords of some other one. A tie cannot contradict, because a
 * tie means the declared domain had support too. At plan stage a contradiction is fatal (the planner
 * is shown this table); at candidate stage it is recorded on the Set.
 */
export function domainCompatible(
  planned: GenerationDomainFamily,
  candidateText: string,
): boolean {
  const hits = domainKeywordHits(candidateText);
  if ((hits[planned] ?? 0) > 0) return true;
  const strongest = Math.max(0, ...Object.values(hits));
  return strongest < CONTRADICTING_DOMAIN_HITS;
}

export type DomainCount = Record<GenerationDomainFamily, number>;

export function emptyDomainCount(): DomainCount {
  return Object.fromEntries(
    GenerationDomainFamilySchema.options.map((domain) => [domain, 0]),
  ) as DomainCount;
}

/** The families used at most one more time than the least-used one: where new Plans should go. */
export function preferredDomains(
  counts: DomainCount,
): GenerationDomainFamily[] {
  const minimum = Math.min(...Object.values(counts));
  return GenerationDomainFamilySchema.options
    .filter((domain) => counts[domain] <= minimum + 1);
}
