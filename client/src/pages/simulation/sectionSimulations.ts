import { lazy } from "react";

// The four section Simulations, each in its own chunk. `/simulate/:kind` and a Full-Test Run's
// section gate mount exactly one of them, so a Reading Simulation never downloads Build a Sentence's
// drag-and-drop or the Speaking recorder. The route's Suspense boundary (App.tsx) covers the load.

export const ReadingSimulation = lazy(() => import("./ReadingSimulation"));
export const ListeningSimulation = lazy(() => import("./ListeningSimulation"));
export const WritingSimulation = lazy(() => import("./WritingSimulation"));
export const SpeakingSimulation = lazy(() => import("./SpeakingSimulation"));
