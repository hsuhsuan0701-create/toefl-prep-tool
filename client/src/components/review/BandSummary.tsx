import type { AttemptBandStatusVM, AttemptVM, ItemVM, SectionEstimateVM } from "@toefl-prep/shared";
import { totalSkipped } from "../../lib/coverage";
import { BandFigure } from "../../ui/BandFigure";
import { Card } from "../../ui/Card";
import { Disclosure, InternalName } from "../../ui/Disclosure";
import { Kicker } from "../../ui/Heading";
import { coverageText } from "../../ui/format";
import { SECTION_LABEL, estimateMethod } from "../../ui/labels";
import ModulePathDisclosure from "../ModulePathDisclosure";
import { bandExplanation } from "./reviewText";

export type BandSummaryProps = {
  attempt: AttemptVM;
  estimate: SectionEstimateVM | null;
  bandStatus: AttemptBandStatusVM;
  items: readonly ItemVM[];
  /** A scoring job is running, so a band on screen may still change. */
  rescoring: boolean;
};

/**
 * The Attempt's Band Estimate: the pencilled figure with its CEFR level, the method in plain words
 * and what it was computed over — or, with no band, why not and what can be done, in the User's
 * terms. The internal method name and the raw score sit behind the disclosure.
 */
export default function BandSummary({ attempt, estimate, bandStatus, items, rescoring }: BandSummaryProps) {
  const section = SECTION_LABEL[attempt.kind];

  if (!estimate) {
    const why = bandExplanation(bandStatus, attempt.kind, items);
    return (
      <Card data-testid="band-summary">
        <Kicker as="h2">{section} band</Kicker>
        <BandFigure
          band={null}
          emptyLabel={why?.final ? "No band" : "No band yet"}
          className="mt-1"
          missing={
            why && (
              <span data-testid="band-missing">
                {why.reason}
                {why.action && " "}
                {why.action && <span className="mt-1 block font-medium text-ink-soft">{why.action}</span>}
              </span>
            )
          }
        />
      </Card>
    );
  }

  const method = estimateMethod(estimate.method);
  const skipped = totalSkipped(estimate.coverage);
  return (
    <Card data-testid="band-summary" className="grid gap-5 md:grid-cols-[auto_minmax(0,1fr)] md:gap-8">
      <div>
        <Kicker as="h2">{section} band</Kicker>
        <BandFigure band={estimate.band} className="mt-1" />
      </div>
      <div className="min-w-0 space-y-2 md:border-l md:border-rule md:pl-8">
        <p className="text-ui text-ink">{method.label}, over:</p>
        <ul className="space-y-0.5 text-meta text-ink-soft">
          {estimate.coverage.map((c) => (
            <li key={c.taskType}>{coverageText(c)}</li>
          ))}
        </ul>
        {/* A skipped Item is a real 0 inside this band, as an unanswered question is on the test. */}
        {skipped > 0 && (
          <p className="text-meta text-ink-soft">
            Includes {skipped} skipped {skipped === 1 ? "Item" : "Items"} scored 0: an Item with no Response counts against the band, as it does on the test.
          </p>
        )}
        {rescoring && <p className="text-meta text-caution">A re-score is running; the band is recomputed when it finishes.</p>}
        {attempt.modulePath && (
          <div className="text-meta text-ink-soft">
            <ModulePathDisclosure modulePath={attempt.modulePath} />
          </div>
        )}
        <Disclosure summary="How this band is estimated">
          <p className="max-w-measure">{method.detail}</p>
          <p className="mt-1">
            Method <InternalName>{estimate.method}</InternalName> · raw <span className="figures">{estimate.raw.toFixed(2)}</span> · Set{" "}
            <InternalName>{attempt.setId}</InternalName>
          </p>
        </Disclosure>
      </div>
    </Card>
  );
}
