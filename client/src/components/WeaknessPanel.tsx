import { useId, type ReactNode } from "react";
import type { StatsSummaryVM } from "@toefl-prep/shared";
import type { SkillAccuracy } from "../pages/weaknessCategories";
import { Card } from "../ui/Card";
import { Chip } from "../ui/Chip";
import { EmptyState } from "../ui/EmptyState";
import { formatPercent } from "../ui/format";
import { SectionHeader } from "../ui/Heading";
import { deductionCategoryLabel, humanize, SECTION_LABEL } from "../ui/labels";

// ReadingSkillCategory/ListeningSkillCategory as words: "main_idea" → "Main idea". A formatter
// rather than a table, so a skill added to either enum reads correctly without an edit here.
function skillLabel(skill: string): string {
  return humanize(skill);
}

// Below this a skill is called out in words, not only by its bar.
const WEAK_ACCURACY = 0.6;

/**
 * One labelled bar. The bar is decoration: the label and the figure beside it carry the whole
 * reading, so nothing depends on its length or its colour.
 */
function BarRow({ label, figure, fraction, flag }: { label: ReactNode; figure: ReactNode; fraction: number; flag?: ReactNode }) {
  const width = Math.max(0, Math.min(1, fraction)) * 100;
  return (
    <li>
      <div className="flex flex-wrap items-baseline justify-between gap-x-3 gap-y-1">
        <span className="flex min-w-0 flex-wrap items-center gap-x-2 gap-y-1 text-ui text-ink">
          {label}
          {flag}
        </span>
        <span className="figures shrink-0 text-meta text-ink-soft">{figure}</span>
      </div>
      <div className="mt-1.5 h-2 overflow-hidden rounded-chip bg-well" aria-hidden="true">
        <div className="h-full rounded-chip bg-ink-soft" style={{ width: `${width}%` }} />
      </div>
    </li>
  );
}

/** The two Judges' average gap on one Response, as a sentence. */
function agreementSentence({ avgDelta, sampleSize }: StatsSummaryVM["judgeAgreement"]): string {
  if (avgDelta === null) return "Not enough Responses have been scored by both Judges yet to compare them.";
  const gap = avgDelta < 0.05 ? "less than 0.1 points" : `${avgDelta.toFixed(1)} points`;
  const reading =
    avgDelta < 0.5
      ? "They mostly agree."
      : avgDelta < 1
        ? "They often differ by about half a point; the Arbiter settles each one."
        : "They often disagree; the Arbiter settles each one, and a gap of 1.5 or more is flagged on the Item.";
  return `On the same Response, your two Judges' scores are ${gap} apart on average, out of 5, over ${sampleSize} ${sampleSize === 1 ? "Response" : "Responses"}. ${reading}`;
}

type WeaknessPanelProps = {
  weaknesses: StatsSummaryVM["weaknesses"];
  judgeAgreement: StatsSummaryVM["judgeAgreement"];
  /** Pre-computed by weaknessCategories.ts's computeSkillAccuracy; this component only renders. */
  skillAccuracy: SkillAccuracy[];
  /** How many of the latest Reading and Listening Items the skill pane covers, as the server sent it. */
  skillItemsLimit: StatsSummaryVM["skillItemsLimit"];
};

export default function WeaknessPanel({ weaknesses, judgeAgreement, skillAccuracy, skillItemsLimit }: WeaknessPanelProps) {
  const ids = useId();
  const max = weaknesses.length > 0 ? Math.max(...weaknesses.map((w) => w.count)) : 0;

  return (
    <div className="grid gap-4 lg:grid-cols-2">
      <Card as="section" aria-labelledby={`${ids}-deductions`} className="space-y-4">
        <SectionHeader
          as="h3"
          id={`${ids}-deductions`}
          title="Deductions by category"
          description="Where points went in your 20 most recently scored Speaking and Writing Responses."
        />
        {weaknesses.length === 0 ? (
          <EmptyState title="No Deductions yet">
            Once a Speaking or Writing Response is scored, the categories it lost points in are counted here.
          </EmptyState>
        ) : (
          <ul className="space-y-3">
            {weaknesses.map((w) => (
              <BarRow
                key={w.category}
                label={deductionCategoryLabel(w.category)}
                figure={`${w.count} ${w.count === 1 ? "Deduction" : "Deductions"}`}
                fraction={max > 0 ? w.count / max : 0}
              />
            ))}
          </ul>
        )}
      </Card>

      <Card as="section" aria-labelledby={`${ids}-skills`} className="space-y-4">
        <SectionHeader
          as="h3"
          id={`${ids}-skills`}
          title="Reading and Listening skills"
          description={`Percent correct on each skill in your ${skillItemsLimit} most recently scored Reading and Listening Items, weakest first. Drills and Simulations both count.`}
        />
        {skillAccuracy.length === 0 ? (
          <EmptyState title="Not enough scored Items yet">
            A skill appears here once at least 5 of its Items have been scored.
          </EmptyState>
        ) : (
          <ul className="space-y-3">
            {skillAccuracy.map((s) => (
              <BarRow
                key={`${s.section}:${s.skill}`}
                label={`${SECTION_LABEL[s.section]} · ${skillLabel(s.skill)}`}
                figure={`${formatPercent(s.accuracy)} · ${s.correct} of ${s.total}`}
                fraction={s.accuracy}
                flag={
                  s.accuracy < WEAK_ACCURACY ? (
                    <Chip tone="caution" glyph="caution">
                      Under 60%
                    </Chip>
                  ) : undefined
                }
              />
            ))}
          </ul>
        )}
      </Card>

      <Card as="section" aria-labelledby={`${ids}-judges`} className="space-y-2 lg:col-span-2">
        <SectionHeader as="h3" id={`${ids}-judges`} title="Judge agreement" />
        <p className="max-w-measure text-body text-ink-soft text-pretty">{agreementSentence(judgeAgreement)}</p>
      </Card>
    </div>
  );
}
