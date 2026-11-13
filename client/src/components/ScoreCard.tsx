import type { ReactNode } from "react";
import { ScoreFigure } from "../ui/BandFigure";
import { Card } from "../ui/Card";
import { Chip, StatusChip } from "../ui/Chip";
import { Disclosure } from "../ui/Disclosure";
import { Kicker } from "../ui/Heading";
import { Notice } from "../ui/Notice";
import { MarkedText, Prose } from "../ui/Prose";
import { markQuotes } from "../ui/markQuotes";
import { countWords } from "../ui/wordCount";
import { SCORE_CAUTION, deductionCategoryLabel, humanize, judgeLabel, type ScoreCaution } from "../ui/labels";
import { scoreCautions } from "./scoreCautions";

// A Score Report as the User reads it (docs/design-system.md, "Attempt review"): the summary, the
// Response marked in red pen beside the Model Rewrite, the numbered Deductions, the dimension notes,
// and the Arbiter's reasoning and Judge detail behind disclosures. Attempt review composes the
// parts into an Item card; the Drills render the whole thing as one card.

type Dimension = { name: string; note: string };
type Deduction = { quote: string; issue: string; fix: string; category: string };
type JudgeDimension = { name: string; score: number; evidence: string };

export type ScoreReportItem = {
  itemId: string;
  ownScore: number;
  finalScore: number;
  maxScore: number;
  dimensions: Dimension[];
  deductions: Deduction[];
  reconciliationNote: string;
  feedbackZh: string;
  modelRewrite?: string;
  singleJudge?: boolean;
  lowConfidence?: boolean;
  selfArbitrated?: boolean;
  /** A recording with no speech: scored 0 without any Judge. */
  noSpeechDetected?: boolean;
  /** An essay with no words: scored 0 without any Judge (docs/adr/0018). */
  noWordsWritten?: boolean;
};

export type JudgeSummary = {
  judge: "gemini" | "openai";
  score: number;
  dimensions: JudgeDimension[];
  deductions: Deduction[];
  /** Speaking only: whether this Judge heard the recording or fell back to the transcript. */
  mode?: "audio" | "text-fallback";
};

/** What a scoring job's result carries for one Task Type. `taskType` is informational only. */
export type EssayScoreResult = {
  taskType: "email" | "discussion" | "listen_repeat" | "interview";
  report: { taskType: string; items: ScoreReportItem[] };
  judges: JudgeSummary[];
  judgesFailed: string[];
};

/** The caution chips for a card header. Pair with ScoreCautionNotes, which says what each one means. */
export function ScoreCautionChips({ cautions }: { cautions: readonly ScoreCaution[] }) {
  return (
    <>
      {cautions.map((c) => (
        <StatusChip key={c} status={SCORE_CAUTION[c]} />
      ))}
    </>
  );
}

/** One plain sentence per caution, so a chip never has to be hovered to be understood. */
export function ScoreCautionNotes({ cautions }: { cautions: readonly ScoreCaution[] }) {
  if (cautions.length === 0) return null;
  return (
    <ul className="space-y-1 text-meta text-ink-soft" aria-label="How to read this score">
      {cautions.map((c) => (
        <li key={c} className="max-w-measure text-pretty">
          <span className="font-medium text-caution">{SCORE_CAUTION[c].label}.</span> {SCORE_CAUTION[c].hint}
        </li>
      ))}
    </ul>
  );
}

type HeadingLevel = "h3" | "h4";

function Section({ title, aside, level: Heading, children }: { title: ReactNode; aside?: ReactNode; level: HeadingLevel; children: ReactNode }) {
  return (
    <section className="min-w-0 space-y-2">
      <div className="flex flex-wrap items-baseline justify-between gap-x-3">
        <Heading className="text-body font-semibold text-ink">{title}</Heading>
        {aside && <span className="text-meta text-graphite">{aside}</span>}
      </div>
      {children}
    </section>
  );
}

export type ScoreReportProps = {
  item: ScoreReportItem;
  judges: readonly JudgeSummary[];
  /** The Response the Deductions quote: essay text, or a spoken Response's transcript. */
  responseText: string;
  /** What the Response is called beside the Model Rewrite ("Your Response", "Your transcript"). */
  responseLabel?: string;
  /** Shown under the marked Response, e.g. a Listen and Repeat word diff against the target. */
  responseExtra?: ReactNode;
  /** One level under the heading of whatever holds the report. */
  headingLevel?: HeadingLevel;
};

/**
 * The body of one Score Report, in the order the User reads it. Each Deduction's quote is marked
 * in the Response and numbered to the list; a quote that cannot be found is listed with its number
 * and a note, and never dropped. A quote that is in the Response but shares words with another
 * Deduction's mark is not called missing: its note names the mark it overlaps.
 */
export function ScoreReport({ item, judges, responseText, responseLabel = "Your Response", responseExtra, headingLevel = "h3" }: ScoreReportProps) {
  const marks = item.deductions.map((d, i) => ({ id: i + 1, quote: d.quote }));
  const placement = markQuotes(responseText, marks);
  const unmatched = new Set(placement.unmatched);
  const overlapsMark = new Map(placement.overlapping.map((o) => [o.id, o.overlaps]));
  const markedCount = marks.length - unmatched.size - overlapsMark.size;
  const words = countWords(responseText);

  return (
    <div className="space-y-8">
      {item.feedbackZh && (
        <Section title="Summary" level={headingLevel}>
          <Prose lang="zh-Hant">{item.feedbackZh}</Prose>
        </Section>
      )}

      <div className={item.modelRewrite ? "grid gap-6 lg:grid-cols-2" : "grid gap-6"}>
        <Section
          level={headingLevel}
          title={responseLabel}
          aside={
            words > 0
              ? `${words} ${words === 1 ? "word" : "words"}${markedCount > 0 ? " · numbers mark Deductions" : ""}`
              : undefined
          }
        >
          <Card tone="well">
            {responseText.trim() === "" ? (
              <p className="text-body text-graphite">No words were recorded.</p>
            ) : (
              <MarkedText text={responseText} marks={marks} />
            )}
          </Card>
          {responseExtra}
        </Section>
        {item.modelRewrite && (
          <Section title="Model Rewrite" aside="A 5-level version, in your ideas" level={headingLevel}>
            <Card tone="plain">
              <Prose preserveLines>{item.modelRewrite}</Prose>
            </Card>
          </Section>
        )}
      </div>

      <Section title={<>Deductions <span className="font-normal text-graphite">· {item.deductions.length}</span></>} level={headingLevel}>
        {item.deductions.length === 0 ? (
          <p className="text-ui text-ink-soft">No Deductions.</p>
        ) : (
          <ol className="space-y-3">
            {item.deductions.map((d, i) => (
              <li key={i} className="grid grid-cols-[1.75rem_minmax(0,1fr)] gap-x-3">
                <span
                  className="figures flex h-6 w-6 items-center justify-center rounded-full border border-correction-rule bg-correction-wash text-meta font-semibold text-correction"
                  aria-label={`Deduction ${i + 1}`}
                >
                  {i + 1}
                </span>
                <div className="min-w-0 space-y-1.5 border-b border-rule pb-3">
                  <div className="flex flex-wrap items-center gap-2">
                    <Chip>{deductionCategoryLabel(d.category)}</Chip>
                    {unmatched.has(i + 1) && <span className="text-meta text-graphite">Not marked: these words are not in your Response</span>}
                    {overlapsMark.has(i + 1) && (
                      <span className="text-meta text-graphite">Not marked separately: these words overlap the mark of Deduction {overlapsMark.get(i + 1)}</span>
                    )}
                  </div>
                  <p className="text-body text-ink">
                    <span className="underline decoration-correction decoration-[1.5px] underline-offset-[0.22em]">{d.quote}</span>
                  </p>
                  <p className="max-w-measure text-ui text-ink-soft">{d.issue}</p>
                  <p className="text-ui text-ink">
                    <span className="mr-1.5 font-semibold text-positive">Fix</span>
                    {d.fix}
                  </p>
                </div>
              </li>
            ))}
          </ol>
        )}
      </Section>

      {item.dimensions.length > 0 && (
        <Section title="By dimension" level={headingLevel}>
          <dl className="grid gap-x-8 gap-y-4 md:grid-cols-2">
            {item.dimensions.map((d) => (
              <div key={d.name} className="min-w-0">
                <dt className="text-ui font-medium text-ink">{humanize(d.name)}</dt>
                <dd className="mt-0.5 text-ui text-ink-soft text-pretty">{d.note}</dd>
              </div>
            ))}
          </dl>
        </Section>
      )}

      {(item.reconciliationNote || judges.length > 0) && (
        <div className="space-y-1 border-t border-rule pt-4">
          {item.reconciliationNote && (
            <Disclosure summary={`How the Arbiter reached ${item.finalScore}`}>
              <p className="max-w-measure text-pretty">{item.reconciliationNote}</p>
              {item.ownScore !== item.finalScore && (
                <p className="mt-1">
                  Read on its own, the Arbiter first scored this <span className="figures">{item.ownScore} / {item.maxScore}</span>.
                </p>
              )}
            </Disclosure>
          )}
          {judges.length > 0 && <JudgeDetail judges={judges} lowConfidence={item.lowConfidence} />}
        </div>
      )}
    </div>
  );
}

function JudgeDetail({ judges, lowConfidence }: { judges: readonly JudgeSummary[]; lowConfidence?: boolean }) {
  return (
    <Disclosure summary={`Judge detail · ${judges.length} ${judges.length === 1 ? "Judge" : "Judges"}`}>
      <div className="mt-2 space-y-4">
        {judges.map((j) => (
          <div key={j.judge} className="min-w-0 space-y-2">
            <p className="text-ui text-ink">
              <span className="font-semibold">{judgeLabel(j.judge)}</span>
              <span className="figures"> · {j.score} / 5</span>
              {j.mode && (
                <span className="text-graphite"> · {j.mode === "audio" ? "heard the recording" : "scored the transcript"}</span>
              )}
            </p>
            <ul className="space-y-2">
              {j.dimensions.map((d) => {
                const others = judges
                  .filter((o) => o.judge !== j.judge)
                  .flatMap((o) => o.dimensions.filter((od) => od.name === d.name).map((od) => od.score));
                const differs = Boolean(lowConfidence) && others.some((s) => s !== d.score);
                return (
                  <li key={d.name} className="max-w-measure">
                    <p className="text-meta font-medium text-ink">
                      {humanize(d.name)} <span className="figures font-normal text-graphite">· {d.score} / 5</span>
                      {differs && (
                        <Chip tone="caution" glyph="caution" className="ml-2 align-middle">
                          Judges differ
                        </Chip>
                      )}
                    </p>
                    <p className="text-meta text-ink-soft text-pretty">{d.evidence}</p>
                  </li>
                );
              })}
            </ul>
          </div>
        ))}
      </div>
    </Disclosure>
  );
}

type ScoreCardProps = { result: EssayScoreResult; userText: string };

/** A Score Report on its own card, for the Drills' results. Attempt review composes the parts instead. */
export default function ScoreCard({ result, userText }: ScoreCardProps) {
  const item = result.report.items[0];
  const cautions = scoreCautions(item, result.judges);
  return (
    <Card padding="none">
      <header className="flex flex-wrap items-start justify-between gap-4 border-b border-rule px-4 py-4 sm:px-6">
        <div className="min-w-0 space-y-2">
          <Kicker as="p">Score Report</Kicker>
          {cautions.length > 0 && (
            <div className="flex flex-wrap gap-2">
              <ScoreCautionChips cautions={cautions} />
            </div>
          )}
        </div>
        <ScoreFigure score={item.finalScore} max={item.maxScore} />
      </header>
      <div className="space-y-6 px-4 py-5 sm:px-6 sm:py-6">
        {item.noWordsWritten ? (
          // An essay with no words was scored 0 without a Judge or the Arbiter (docs/adr/0018): there
          // are no Deductions to mark and no reasoning to show, only why the score is 0.
          <>
            <div data-testid="no-words-note">
              <Notice tone="caution" title="No Response written">
                {item.reconciliationNote}
              </Notice>
            </div>
            {item.feedbackZh && (
              <Section title="Summary" level="h3">
                <Prose lang="zh-Hant">{item.feedbackZh}</Prose>
              </Section>
            )}
          </>
        ) : (
          <>
            <ScoreCautionNotes cautions={cautions} />
            <ScoreReport item={item} judges={result.judges} responseText={userText} />
          </>
        )}
      </div>
    </Card>
  );
}
