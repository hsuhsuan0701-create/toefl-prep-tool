import { Suspense } from "react";
import { describe, expect, it, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import SimulationRun from "../src/pages/SimulationRun";

// `/simulate/:kind` only picks a section. Each section's own flow lives in its own module under
// src/pages/simulation/, with its own test that mounts the real component behind a mocked api
// client. So this file asserts only the fork itself, with the four section modules stubbed: which
// module a `kind` reaches, and what an unknown `kind` gets instead.

// Each factory is written out in full rather than sharing a helper: vi.mock is hoisted above every
// top-level binding in this file, so a shared `stub` would not exist yet when these run.
vi.mock("../src/pages/simulation/SpeakingSimulation", async () => {
  const { createElement } = await import("react");
  return { default: () => createElement("p", null, "speaking module") };
});
vi.mock("../src/pages/simulation/WritingSimulation", async () => {
  const { createElement } = await import("react");
  return { default: () => createElement("p", null, "writing module") };
});
vi.mock("../src/pages/simulation/ReadingSimulation", async () => {
  const { createElement } = await import("react");
  return { default: () => createElement("p", null, "reading module") };
});
vi.mock("../src/pages/simulation/ListeningSimulation", async () => {
  const { createElement } = await import("react");
  return { default: () => createElement("p", null, "listening module") };
});

// The section modules are lazy chunks, so the route sits under a Suspense boundary as in App.tsx.
function renderAt(kind: string) {
  return render(
    <MemoryRouter initialEntries={[`/simulate/${kind}`]}>
      <Suspense fallback={null}>
        <Routes>
          <Route path="/simulate/:kind" element={<SimulationRun />} />
        </Routes>
      </Suspense>
    </MemoryRouter>,
  );
}

describe("SimulationRun (the kind Router)", () => {
  it.each([
    ["speaking", "speaking module"],
    ["writing", "writing module"],
    ["reading", "reading module"],
    ["listening", "listening module"],
  ])("mounts the %s section module", async (kind, label) => {
    renderAt(kind);
    expect(await screen.findByText(label)).toBeInTheDocument();
  });

  it("names an unknown kind rather than rendering a blank page", () => {
    renderAt("grammar");
    expect(screen.getByText('Unknown simulation kind "grammar".')).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "Back to Practice" })).toHaveAttribute("href", "/");
  });
});
