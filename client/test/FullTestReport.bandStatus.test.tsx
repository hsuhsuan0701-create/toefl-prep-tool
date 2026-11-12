import { afterEach, describe, expect, it, vi } from "vitest";
import { render, screen, within } from "@testing-library/react";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import type { FullTestRunVM, FullTestSection, FullTestSectionBandVM, FullTestSectionVM } from "@toefl-prep/shared";
import FullTestRun from "../src/pages/FullTestRun";

// A Full-Test Run's report renders each section from the server's band status: a section still
// being scored shows no band and says what is outstanding; a section whose scoring settled without
// every Task Type says which are missing and why; and the Overall is never shown while any section
// lacks a band.

const RUN_ID = "run-a4";
const ORDER: FullTestSection[] = ["reading", "listening", "writing", "speaking"];

function sectionVM(name: FullTestSection, bandStatus: FullTestSectionBandVM, band?: number): FullTestSectionVM {
  return {
    section: name,
    order: ORDER.indexOf(name) + 1,
    setId: `set-${name}`,
    attemptId: `att-${name}`,
    state: "completed",
    runnable: true,
    launchable: false,
    bandStatus,
    estimate:
      band === undefined
        ? null
        : { section: name, band, raw: 0.8, method: name === "reading" || name === "listening" ? "table3-v1" : "linear-v2", coverage: [] },
    modulePath: name === "reading" || name === "listening" ? "upper" : null,
  };
}

function completedRun(writing: FullTestSectionVM, speaking: FullTestSectionVM = sectionVM("speaking", { status: "estimated" }, 4.5)): FullTestRunVM {
  const sections = [
    sectionVM("reading", { status: "estimated" }, 6),
    sectionVM("listening", { status: "estimated" }, 6),
    writing,
    speaking,
  ];
  const pendingSections = sections.filter((s) => !s.estimate).map((s) => s.section);
  return {
    id: RUN_ID,
    status: "completed",
    currentSection: null,
    createdAt: "2026-08-23T02:00:00.000Z",
    completedAt: "2026-08-23T03:30:00.000Z",
    sections,
    overall: { band: null, method: "mean-of-sections-v1", scoredSections: 4 - pendingSections.length, pendingSections },
  };
}

function renderRun(body: FullTestRunVM) {
  vi.stubGlobal(
    "fetch",
    vi.fn(() =>
      Promise.resolve(new Response(JSON.stringify(body), { status: 200, headers: { "Content-Type": "application/json" } })),
    ) as unknown as typeof fetch,
  );
  render(
    <MemoryRouter initialEntries={[`/full-test/${RUN_ID}`]}>
      <Routes>
        <Route path="/full-test/:runId" element={<FullTestRun />} />
      </Routes>
    </MemoryRouter>,
  );
}

afterEach(() => vi.unstubAllGlobals());

/** The four section rows, in order. The page's navigation has list items of its own. */
async function sectionRows(): Promise<HTMLElement[]> {
  return within(await screen.findByRole("list", { name: "Sections, in test order" })).getAllByRole("listitem");
}
function sectionRowsNow(): HTMLElement[] {
  return within(screen.getByRole("list", { name: "Sections, in test order" })).getAllByRole("listitem");
}


describe("a Writing section whose essays are still being scored", () => {
  it("shows no band and says which Items are outstanding", async () => {
    renderRun(completedRun(sectionVM("writing", {
      status: "scoring",
      outstanding: [{ taskType: "email", itemCount: 1 }, { taskType: "discussion", itemCount: 1 }],
    })));

    const writing = (await sectionRows())[2];
    expect(within(writing).getByTestId("section-scoring-writing")).toHaveTextContent(
      /Still scoring 1 Write an Email Item and 1 Academic Discussion Item\./,
    );
    expect(within(writing).queryByTestId("section-band-writing")).toBeNull();
    expect(within(writing).queryByTestId("cefr-level")).toBeNull();

    const pending = screen.getByTestId("overall-pending");
    expect(pending).toHaveTextContent(/Writing is still scoring/);
    expect(screen.queryByTestId("overall-band")).toBeNull();
  });
});

describe("a Writing section whose essay scoring failed for good", () => {
  it("says scoring failed instead of showing a Build-a-Sentence-only band", async () => {
    renderRun(completedRun(sectionVM("writing", {
      status: "no-band",
      unscored: [
        { taskType: "email", failed: 1, pending: 0, notCaptured: 0 },
        { taskType: "discussion", failed: 1, pending: 0, notCaptured: 0 },
      ],
      absent: [],
    })));

    const writing = (await sectionRows())[2];
    expect(within(writing).getByTestId("section-no-band-writing")).toHaveTextContent(
      "1 Write an Email Item and 1 Academic Discussion Item failed scoring. A band needs every Item of the section scored.",
    );
    expect(within(writing).queryByTestId("section-band-writing")).toBeNull();

    // The Overall will never come, so the report must not ask the User to wait for it.
    const pending = screen.getByTestId("overall-pending");
    expect(pending).toHaveTextContent(/No Overall for this sitting: Writing has no band and will not get one/);
    expect(pending).not.toHaveTextContent(/still scoring/);
  });

  it("names a Task Type with no Item at all as never recorded rather than failed", async () => {
    renderRun(completedRun(sectionVM("writing", { status: "no-band", unscored: [], absent: ["email"] })));
    const writing = (await sectionRows())[2];
    expect(within(writing).getByTestId("section-no-band-writing")).toHaveTextContent(/No Write an Email Response was recorded/);
  });
});

describe("a Reading section routed and finished before its second Module", () => {
  it("names the Module it never sat, and why that leaves no band", async () => {
    const run = completedRun(sectionVM("writing", { status: "estimated" }, 5));
    run.sections[0] = sectionVM("reading", {
      status: "no-band",
      unscored: [],
      absent: [],
      moduleShortfalls: [{ module: "upper", sat: false, absent: ["complete_words", "academic_passage"] }],
    });
    renderRun(run);

    const reading = (await sectionRows())[0];
    expect(within(reading).getByTestId("section-no-band-reading")).toHaveTextContent(
      "This Simulation was routed to the Upper Module and ended before any of it was answered. A band needs both Modules the section was routed through.",
    );
    expect(within(reading).queryByTestId("section-band-reading")).toBeNull();
  });
});

describe("a sitting with one section never getting a band and another still scoring", () => {
  it("says there will be no whole-test band, naming only the section that will never have one", async () => {
    renderRun(completedRun(
      sectionVM("writing", { status: "no-band", unscored: [{ taskType: "email", failed: 1, pending: 0, notCaptured: 0 }], absent: [] }),
      sectionVM("speaking", { status: "scoring", outstanding: [] }),
    ));
    const pending = await screen.findByTestId("overall-pending");
    expect(pending).toHaveTextContent(/No Overall for this sitting: Writing has no band/);
    expect(pending).not.toHaveTextContent(/Speaking has/);
    const speaking = sectionRowsNow()[3];
    expect(within(speaking).getByTestId("section-scoring-speaking")).toHaveTextContent(/Still scoring: the last scores are being recorded/);
  });
});
