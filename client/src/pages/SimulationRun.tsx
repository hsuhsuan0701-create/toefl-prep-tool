import { useParams } from "react-router-dom";
import { ListeningSimulation, ReadingSimulation, SpeakingSimulation, WritingSimulation } from "./simulation/sectionSimulations";
import { ErrorMain } from "./simulation/SimulationScreens";

// `/simulate/:kind`: the counterpart to the Drills under exam constraints (continuous, play-once
// audio, deferred feedback). This page only dispatches: it reads `kind` off the route and mounts
// that section's own Simulation module (./simulation/, each its own chunk), which owns its state
// machine, screens and finishing sequence over the shared shell (simulation/simulationShell.ts and
// SimulationScreens.tsx). Each Simulation ends on its Attempt review (/attempts/:id), which renders
// the deferred report from what the server stored.

export default function SimulationRun() {
  const { kind } = useParams<{ kind: string }>();
  if (kind === "speaking") return <SpeakingSimulation />;
  if (kind === "writing") return <WritingSimulation />;
  if (kind === "reading") return <ReadingSimulation />;
  if (kind === "listening") return <ListeningSimulation />;
  return <ErrorMain message={`Unknown simulation kind "${kind}".`} />;
}
