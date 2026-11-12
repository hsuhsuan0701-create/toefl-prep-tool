import type { Section, StatsSectionVM } from "@toefl-prep/shared";
import { BandFigure, BandScale } from "../ui/BandFigure";
import { BandSelect } from "../ui/BandSelect";
import { TextLink } from "../ui/Button";
import { Card } from "../ui/Card";
import { formatWhen } from "../ui/format";
import { Kicker } from "../ui/Heading";
import { InlineEdit } from "../ui/InlineEdit";
import { ATTEMPT_MODE_LABEL, SECTION_LABEL } from "../ui/labels";
import { Skeleton } from "../ui/Skeleton";
import { rangeText } from "../pages/dashboard/sectionCopy";
import ModulePathDisclosure from "./ModulePathDisclosure";

type BandCardProps = {
  section: Section;
  /** The section's headline Band Estimate; undefined when it has none. */
  estimate: StatsSectionVM | undefined;
  /** True while the summary is still on its way, so "no band" is not claimed before it is known. */
  loading?: boolean;
  /** The section's Target; undefined while the settings load. */
  target: number | undefined;
  onTargetChange: (target: number) => Promise<void>;
  /** With no band: what to do to get one, in the User's terms. */
  missing: string;
};

/**
 * One section on the Dashboard: its Band Estimate (pencilled, with its CEFR level), where it came
 * from, the 1–6 ruler against the Target with the distance said in words, how far the last few
 * Simulations spread, and the Target itself with an Edit. With no band, it says what gets one.
 */
export default function BandCard({ section, estimate, loading = false, target, onTargetChange, missing }: BandCardProps) {
  const name = SECTION_LABEL[section];
  return (
    <Card as="section" aria-label={`${name} band`} aria-busy={loading || undefined} className="flex flex-col gap-4">
      <Kicker as="h3">{name}</Kicker>

      {loading ? (
        <div className="space-y-3">
          <Skeleton shape="block" className="h-10 w-28" />
          <Skeleton className="w-3/4" />
        </div>
      ) : (
        <div className="space-y-1.5">
          <BandFigure band={estimate?.band ?? null} missing={missing} />
          {estimate && (
            <>
              <p className="text-meta text-graphite">
                From{" "}
                <TextLink to={`/attempts/${estimate.attemptId}`}>
                  your {name} {ATTEMPT_MODE_LABEL[estimate.mode]}
                </TextLink>
                , {formatWhen(estimate.attemptedAt)}
              </p>
              <ModulePathDisclosure modulePath={estimate.modulePath} />
              {estimate.recentSimulationRange && (
                <p className="text-meta text-graphite">{rangeText(estimate.recentSimulationRange)}</p>
              )}
            </>
          )}
        </div>
      )}

      {estimate && <BandScale label={name} band={estimate.band} target={target} />}

      <div className="mt-auto border-t border-rule pt-3">
        {target === undefined ? (
          <Skeleton className="w-32" />
        ) : (
          <InlineEdit
            label={`${name} Target`}
            value={target}
            onSave={onTargetChange}
            display={
              <span className="flex flex-wrap items-baseline gap-x-2">
                <span className="text-meta text-graphite">Target</span>
                <BandFigure band={target} kind="target" size="sm" tag={false} />
              </span>
            }
            field={(draft, setDraft) => <BandSelect label={`${name} Target`} value={draft} onChange={setDraft} />}
          />
        )}
      </div>
    </Card>
  );
}
