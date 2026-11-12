import { useStartFullTest } from "../../hooks/useStartFullTest";
import { Button, ButtonLink } from "../../ui/Button";
import { targetGapText } from "../../ui/format";
import { Kicker } from "../../ui/Heading";
import { IconArrowRight } from "../../ui/icons";
import { SECTION_LABEL } from "../../ui/labels";
import { Notice } from "../../ui/Notice";
import { piecesPhrase } from "../../components/setup/setupChecklist";
import { SIMULATION_HREF } from "./sectionCopy";
import type { Suggestion } from "./suggestNext";

/**
 * The Dashboard's one primary action, chosen by suggestNext: why this, in a sentence, and the button
 * that does it. A run this machine could not score is never offered — the button then opens Setup.
 */
export function SuggestedNext({ suggestion, onShowSetup }: { suggestion: Suggestion; onShowSetup: () => void }) {
  return (
    <div className="space-y-3">
      <Kicker as="h2">Suggested next</Kicker>
      <SuggestionBody suggestion={suggestion} onShowSetup={onShowSetup} />
    </div>
  );
}

function SuggestionBody({ suggestion, onShowSetup }: { suggestion: Suggestion; onShowSetup: () => void }) {
  if (suggestion.kind === "full-test") return <FullTestSuggestion />;

  const name = SECTION_LABEL[suggestion.section];

  if (suggestion.kind === "unavailable") {
    const why =
      suggestion.reason === "full-test"
        ? `Every section is at or above its Target, so a Full-Test Run is next — but this machine can't score ${name} yet.`
        : suggestion.reason === "no-band"
          ? `${name} has no band yet, and this machine can't score it yet.`
          : `${name} is furthest from its Target, and this machine can't score it right now.`;
    return (
      <>
        <p className="text-body text-ink text-pretty">
          {why}{" "}
          {suggestion.missing.length > 0
            ? `Not set up: ${piecesPhrase(suggestion.missing)}.`
            : "The server is still checking what it can do."}
        </p>
        <Button variant="primary" onClick={onShowSetup}>
          {suggestion.missing.length > 0 ? "See what's missing" : "See Setup"}
        </Button>
      </>
    );
  }

  const why =
    suggestion.reason === "no-band"
      ? suggestion.section === "reading" || suggestion.section === "listening"
        ? `${name} has no band yet. A ${name} Simulation gives you one the moment you finish.`
        : `${name} has no band yet. A ${name} Simulation gives you one once its Responses are scored.`
      : `${name} is furthest from its Target: ${targetGapText(suggestion.band, suggestion.target).replace("your Target", "it")}. A ${name} Simulation on a new Set gives the most useful next estimate.`;
  return (
    <>
      <p className="text-body text-ink text-pretty">{why}</p>
      <ButtonLink to={SIMULATION_HREF[suggestion.section]} variant="primary" iconEnd={<IconArrowRight size={16} />}>
        Start {name} Simulation
      </ButtonLink>
    </>
  );
}

function FullTestSuggestion() {
  const { start, starting, error } = useStartFullTest();
  return (
    <>
      <p className="text-body text-ink text-pretty">
        Every section is at or above its Target. A Full-Test Run checks that it holds across a whole sitting.
      </p>
      <Button variant="primary" loading={starting} onClick={start} iconEnd={<IconArrowRight size={16} />}>
        Start a Full-Test Run
      </Button>
      {error && (
        <Notice tone="critical" live="polite">
          Couldn't start a Full-Test Run. {error}
        </Notice>
      )}
    </>
  );
}
