import type { StatsOverallVM } from "@toefl-prep/shared";
import { BandFigure } from "../../ui/BandFigure";
import { Kicker } from "../../ui/Heading";
import { ESTIMATE_METHOD, SECTION_LABEL } from "../../ui/labels";
import { joinAnd } from "../../ui/format";

/**
 * The Overall band: the mean-then-round of the four section Band Estimates. Until all four exist it
 * shows no number and names the sections still without one; a mean of fewer would be a different
 * number, not a rough Overall.
 */
export function OverallCard({ overall }: { overall: StatsOverallVM }) {
  const method = ESTIMATE_METHOD["mean-of-sections-v1"];
  const missing = overall.missingSections.map((section) => SECTION_LABEL[section]);
  return (
    <div>
      <Kicker as="h2">Overall</Kicker>
      {overall.band === null ? (
        <BandFigure
          band={null}
          size="lg"
          className="mt-2"
          missing={
            missing.length === 4
              ? "It appears once all four sections have a band."
              : `It appears once all four sections have a band; ${joinAnd(missing)} ${missing.length === 1 ? "has" : "have"} none yet.`
          }
        />
      ) : (
        <>
          <BandFigure band={overall.band} size="lg" className="mt-2" />
          <p className="mt-3 max-w-sm text-meta text-graphite">
            {method.label}, {method.detail.charAt(0).toLowerCase()}
            {method.detail.slice(1)}
          </p>
        </>
      )}
    </div>
  );
}
