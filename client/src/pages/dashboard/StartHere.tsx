import type { ReactNode } from "react";
import { Button, ButtonLink } from "../../ui/Button";
import { Card } from "../../ui/Card";
import { Kicker } from "../../ui/Heading";
import { IconArrowRight } from "../../ui/icons";
import { SIMULATION_HREF } from "./sectionCopy";
import type { Scorability } from "./suggestNext";

type StartHereProps = {
  /** Whether this machine can score Writing and Speaking, which decides the third step. */
  writing: Scorability;
  speaking: Scorability;
  onShowSetup: () => void;
};

/**
 * The first-run lead: what works right now with no keys (Reading and Listening), then what Speaking
 * and Writing need. Its first step is the page's one primary action.
 */
export function StartHere({ writing, speaking, onShowSetup }: StartHereProps) {
  const ready = (s: Scorability) => s.state === "ready" || s.state === "unknown";
  const checking = writing.state === "checking" || speaking.state === "checking";
  return (
    <Card as="section" padding="lg" aria-labelledby="start-heading">
      <Kicker as="h2">
        <span id="start-heading">Start here</span>
      </Kicker>
      <ol className="mt-4 space-y-6">
        <Step
          n={1}
          title="Take a Reading Simulation"
          body="About half an hour under exam timing, scored on this machine the moment you finish. It gives you your first Reading band."
          action={
            <ButtonLink to={SIMULATION_HREF.reading} variant="primary" iconEnd={<IconArrowRight size={16} />}>
              Start Reading Simulation
            </ButtonLink>
          }
        />
        <Step
          n={2}
          title="Or warm up with a Listening Drill"
          body="Shorter, with the key and an Explanation after every Stimulus. Drills never produce a band."
          action={<ButtonLink to="/sets">Choose a Listening Set</ButtonLink>}
        />
        {ready(writing) && ready(speaking) ? (
          <Step
            n={3}
            title="Then Writing and Speaking"
            body="Two Judges score each Response independently and an Arbiter reconciles them, so these bands arrive a few minutes after you finish."
            action={<ButtonLink to={SIMULATION_HREF.writing}>Start Writing Simulation</ButtonLink>}
          />
        ) : (
          <Step
            n={3}
            title="Set up scoring for Writing and Speaking"
            body={
              checking
                ? "Their Responses are scored by AI Judges and an Arbiter. The server is still checking whether this machine can run them."
                : "Their Responses are scored by AI Judges and an Arbiter, which need a key and a signed-in CLI on this machine. The Setup list says exactly what is missing."
            }
            action={
              <Button variant="secondary" onClick={onShowSetup}>
                See Setup
              </Button>
            }
          />
        )}
      </ol>
    </Card>
  );
}

function Step({ n, title, body, action }: { n: number; title: string; body: string; action: ReactNode }) {
  return (
    <li className="grid grid-cols-[2rem_minmax(0,1fr)] gap-x-3">
      <span className="figures font-serif text-figure-sm font-semibold text-graphite" aria-hidden="true">
        {n}
      </span>
      <div>
        <p className="text-heading font-semibold text-ink">{title}</p>
        <p className="mt-1 max-w-measure text-body text-ink-soft text-pretty">{body}</p>
        <div className="mt-3 flex flex-wrap gap-2">{action}</div>
      </div>
    </li>
  );
}
