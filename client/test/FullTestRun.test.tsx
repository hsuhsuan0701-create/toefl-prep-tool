import { afterEach, describe, expect, it, vi } from "vitest";
import { act, render, screen, waitFor, within } from "@testing-library/react";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import type {
  AttemptDetailVM,
  BandShortfallVM,
  FullTestOverallVM,
  FullTestRunVM,
  FullTestSectionVM,
  ItemVM,
  SectionEstimateVM,
  TranscriptionJobVM,
} from "@toefl-prep/shared";
import FullTestRun from "../src/pages/FullTestRun";

// The Run page is all a User sees of a Full-Test Run between sections: four sections in ETS order,
// exactly one of them startable, the finished ones locked with their bands read back from the
// server, and, once a sitting is abandoned and reopened, a way back into whichever section is still
// outstanding.
//
// Fetch is stubbed rather than mocked per-function so these exercise the page's own fetch call and
// its rendering together, as unloadableSets.test.tsx does.

const RUN_ID = "run-78";

function section(over: Partial<FullTestSectionVM> & Pick<FullTestSectionVM, "section" | "order">): FullTestSectionVM {
  // The band status the server derives for a fixture like this one: a band when it has one, still
  // scoring when finished without one, otherwise not finished.
  const bandStatus: FullTestSectionVM["bandStatus"] = over.estimate
    ? { status: "estimated" }
    : over.state === "completed"
      ? { status: "scoring", outstanding: [] }
      : { status: "not-finished" };
  return {
    setId: `set-${over.section}`,
    attemptId: null,
    state: "pending",
    runnable: true,
    launchable: over.section === "reading",
    estimate: null,
    modulePath: null,
    bandStatus,
    ...over,
  };
}

/** A section estimate in the shape the server sends one: the whole SectionEstimateVM. */
function estimate(over: Partial<SectionEstimateVM> & Pick<SectionEstimateVM, "section" | "band" | "method">): SectionEstimateVM {
  return {
    raw: 0.6,
    coverage: [{ taskType: "email", itemCount: 2, skippedCount: 0 }],
    ...over,
  };
}

/**
 * The overall, derived exactly as the server derives it (services/fullTestRun.ts) so a fixture
 * cannot claim a band the sections in the same fixture do not support.
 */
function overallFor(sections: FullTestSectionVM[]): FullTestOverallVM {
  const pendingSections = sections.filter((s) => !s.estimate).map((s) => s.section);
  const bands = sections.map((s) => s.estimate?.band).filter((b): b is number => b !== undefined);
  return {
    band: pendingSections.length === 0 ? Math.round((bands.reduce((a, b) => a + b, 0) / bands.length) * 2) / 2 : null,
    method: "mean-of-sections-v1",
    scoredSections: bands.length,
    pendingSections,
  };
}

function run(over: Partial<FullTestRunVM> = {}): FullTestRunVM {
  const sections = over.sections ?? [
    section({ section: "reading", order: 1 }),
    section({ section: "listening", order: 2 }),
    section({ section: "writing", order: 3 }),
    section({ section: "speaking", order: 4 }),
  ];
  return {
    id: RUN_ID,
    status: "in-progress",
    currentSection: "reading",
    createdAt: "2026-08-23T02:00:00.000Z",
    completedAt: null,
    overall: overallFor(sections),
    ...over,
    sections,
  };
}

/** The four sections of a finished sitting, each with whatever band it has (null = still scoring). */
function completedSections(bands: {
  reading: number | null;
  listening: number | null;
  writing: number | null;
  speaking: number | null;
}): FullTestSectionVM[] {
  const methods = {
    reading: "table3-v1",
    listening: "table3-v1",
    writing: "linear-v2",
    speaking: "linear-v2",
  } as const;
  const taskTypes = {
    reading: "academic_passage",
    listening: "academic_talk",
    writing: "email",
    speaking: "interview",
  } as const;
  return (["reading", "listening", "writing", "speaking"] as const).map((name, i) =>
    section({
      section: name,
      order: i + 1,
      state: "completed",
      attemptId: `att-${name}`,
      launchable: false,
      modulePath: name === "reading" ? "lower" : name === "listening" ? "upper" : null,
      estimate:
        bands[name] === null
          ? null
          : estimate({
              section: name,
              band: bands[name] as number,
              method: methods[name],
              coverage: [{ taskType: taskTypes[name], itemCount: 3, skippedCount: name === "speaking" ? 1 : 0 }],
            }),
    }),
  );
}

/**
 * `attempts` answers GET /api/attempts/:id, which the report reads for a section settled with no
 * band: a body, a promise the test resolves when it wants the Attempt to have loaded, or
 * "unavailable" for a 503.
 */
function renderRun(
  body: FullTestRunVM | { status: number; payload: unknown },
  attempts: Record<string, AttemptDetailVM | Promise<AttemptDetailVM> | "unavailable"> = {},
) {
  vi.stubGlobal(
    "fetch",
    vi.fn((input: RequestInfo | URL) => {
      const url = typeof input === "string" ? input : input.toString();
      const attemptId = /\/api\/attempts\/([^/?]+)$/.exec(url)?.[1];
      if (attemptId !== undefined && attemptId in attempts) {
        const answer = attempts[attemptId];
        if (answer === "unavailable") return Promise.resolve(new Response(JSON.stringify({ error: "unavailable" }), { status: 503 }));
        return Promise.resolve(answer).then(
          (detail) => new Response(JSON.stringify(detail), { status: 200, headers: { "Content-Type": "application/json" } }),
        );
      }
      if (!url.includes(`/api/full-tests/${RUN_ID}`)) throw new Error(`unhandled fetch in test: ${url}`);
      const isError = "status" in body && typeof body.status === "number";
      const payload = isError ? (body as { payload: unknown }).payload : body;
      return Promise.resolve(
        new Response(JSON.stringify(payload), {
          status: isError ? (body as { status: number }).status : 200,
          headers: { "Content-Type": "application/json" },
        }),
      );
    }) as unknown as typeof fetch,
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


describe("the full-test run page", () => {
  it("lists the four sections in ETS order, with only the first offering a way in", async () => {
    renderRun(run());

    const items = await sectionRows();
    expect(items.map((li) => li.querySelector("h3")?.textContent)).toEqual(["Reading", "Listening", "Writing", "Speaking"]);
    expect(within(items[0]).getByText("Section 1 of 4")).toBeInTheDocument();
    for (const li of items) expect(within(li).getByText("Not started")).toBeInTheDocument();

    // The one launchable section, pointed at its own section route.
    const start = screen.getByRole("link", { name: "Start Reading" });
    expect(start).toHaveAttribute("href", `/full-test/${RUN_ID}/reading`);
    expect(screen.queryByRole("link", { name: /Start (Listening|Writing|Speaking)/ })).toBeNull();

    // The other three say why they are not startable, rather than pretending to be.
    expect(screen.getAllByText(/Starts once the earlier sections are finished/i)).toHaveLength(3);
    // An unfinished sitting has no report yet, and says when it will.
    expect(screen.queryByTestId("full-test-report")).toBeNull();
    expect(screen.getByText(/whole-test band appears here once all four sections have one/i)).toBeInTheDocument();
  });

  // The whole-run time envelope is display only: nothing on this page times anything.
  it("shows how long the sitting has been open, against the published envelope", async () => {
    renderRun(run({ createdAt: new Date(Date.now() - 95 * 60_000).toISOString() }));
    expect(await screen.findByText(/Elapsed 1 h 35 min/)).toBeInTheDocument();
    expect(screen.getByText(/1 h 23 min – 1 h 29 min/)).toBeInTheDocument();
  });

  // Under a minute the elapsed time is in seconds, so it has to move every second, not sit frozen
  // between coarse ticks.
  it("counts a sitting's first minute second by second, then in minutes", async () => {
    // The fake clock also moves with real time, so findBy can wait for the page to load; the count is
    // read back rather than assumed for the same reason.
    vi.useFakeTimers({ shouldAdvanceTime: true });
    const shownSeconds = () => Number(/Elapsed (\d+) s/.exec(screen.getByText(/Elapsed \d+ s/).textContent ?? "")?.[1]);
    try {
      renderRun(run({ createdAt: new Date(Date.now() - 4_000).toISOString() }));
      await screen.findByText(/Elapsed \d+ s/);
      // Let the page's effects run, so its next tick is scheduled before the clock is moved.
      await act(async () => {});
      const first = shownSeconds();
      await act(async () => vi.advanceTimersByTime(1_000));
      expect(shownSeconds()).toBeGreaterThan(first);
      // A second at a time: each tick schedules the next once React has rendered it.
      for (let i = 0; i < 60; i += 1) await act(async () => vi.advanceTimersByTime(1_000));
      expect(screen.getByText(/Elapsed 1 min/)).toBeInTheDocument();
    } finally {
      vi.useRealTimers();
    }
  });

  // A browser that coarsens its clock (resist-fingerprinting modes round Date.now to 16.67 ms or
  // 100 ms) can answer a tick with the same time as the last one. The count must keep going and move
  // once the clock does, not wait for a remount.
  it("keeps counting when the clock reads the same time across a tick", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    const createdMs = Date.parse("2026-08-23T02:00:00.000Z");
    let clockMs = createdMs + 4_000;
    vi.spyOn(Date, "now").mockImplementation(() => clockMs);
    try {
      renderRun(run({ createdAt: new Date(createdMs).toISOString() }));
      await screen.findByText(/Elapsed 4 s/);
      await act(async () => {});
      // The tick at the half second comes and goes with the clock where it was.
      await act(async () => vi.advanceTimersByTime(1_000));
      expect(screen.getByText(/Elapsed 4 s/)).toBeInTheDocument();
      clockMs += 1_000;
      await act(async () => vi.advanceTimersByTime(1_000));
      expect(screen.getByText(/Elapsed 5 s/)).toBeInTheDocument();
    } finally {
      vi.useRealTimers();
    }
  });

  // A start time that does not parse has no elapsed time to count, and must not re-render the page
  // on a zero delay forever.
  it("shows no elapsed time and schedules no tick for a start time that does not parse", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    try {
      renderRun(run({ createdAt: "not a time" }));
      expect(await screen.findByText(/Elapsed 0 s/)).toBeInTheDocument();
      await act(async () => {});
      expect(vi.getTimerCount()).toBe(0);
    } finally {
      vi.useRealTimers();
    }
  });

  it("shows Reading complete with its Band Estimate and a link to its report after the section is sat", async () => {
    // Exactly what a reload after finishing Reading fetches: the Run, with Reading's state and band
    // derived server-side from the Attempt it recorded.
    renderRun(
      run({
        currentSection: "listening",
        sections: [
          section({
            section: "reading",
            order: 1,
            state: "completed",
            attemptId: "att-1",
            launchable: false,
            modulePath: "upper",
            estimate: estimate({ section: "reading", band: 4.5, method: "table3-v1" }),
          }),
          section({ section: "listening", order: 2, launchable: true }),
          section({ section: "writing", order: 3 }),
          section({ section: "speaking", order: 4 }),
        ],
      }),
    );

    const reading = (await sectionRows())[0];
    expect(within(reading).getByText("Complete")).toBeInTheDocument();
    expect(within(reading).getByText("4.5")).toBeInTheDocument();
    // Pencilled as an estimate, with the method in words (its internal name in the disclosure), and
    // the CEFR level attached to the band's own figure — the rule for every band-bearing surface.
    expect(within(reading).getByTestId("section-band-reading")).toHaveTextContent(/4\.5\/6 out of 6 · B2\s*estimate/);
    expect(within(reading).getByText("Percent correct, read off ETS's score table, over:")).toBeInTheDocument();
    expect(within(reading).getByText("table3-v1")).toBeInTheDocument();
    expect(within(reading).getByTestId("cefr-level")).toBeInTheDocument();
    expect(within(reading).getByRole("link", { name: /report/i })).toHaveAttribute("href", "/attempts/att-1");
    // A completed section is not re-startable from the Run page.
    expect(screen.queryByRole("link", { name: /Start Reading/ })).toBeNull();
  });

  // A Reading, Listening or Speaking section keeps nothing on the device, so one left part-way
  // starts again from its beginning — the page must not promise to resume it.
  it("says a section left part-way starts again from the beginning", async () => {
    renderRun(
      run({
        sections: [
          section({ section: "reading", order: 1, state: "in-progress", attemptId: "att-1" }),
          section({ section: "listening", order: 2 }),
          section({ section: "writing", order: 3 }),
          section({ section: "speaking", order: 4 }),
        ],
      }),
    );

    expect(await screen.findByRole("link", { name: "Start Reading again" })).toHaveAttribute(
      "href",
      `/full-test/${RUN_ID}/reading`,
    );
    expect(screen.getByText(/starts it again from the beginning/)).toBeInTheDocument();
    expect(screen.queryByText(/Leaving mid-test is safe/)).toBeNull();
    expect(screen.queryByRole("link", { name: /Resume/ })).toBeNull();
  });

  // Writing keeps its drafts in the tab, so a Writing section this tab was sitting does resume.
  it("offers to resume Writing when this tab still holds that section's work", async () => {
    window.sessionStorage.setItem(
      `toefl.writingSimulation.${RUN_ID}`,
      JSON.stringify({ attemptId: "att-w", setId: "wri-1", task: "email", deadlineMs: Date.now() + 60_000, accepted: [] }),
    );
    renderRun(
      run({
        currentSection: "writing",
        sections: [
          section({ section: "reading", order: 1, state: "completed", attemptId: "att-r", launchable: false }),
          section({ section: "listening", order: 2, state: "completed", attemptId: "att-l", launchable: false }),
          section({ section: "writing", order: 3, state: "in-progress", attemptId: "att-w", launchable: true }),
          section({ section: "speaking", order: 4 }),
        ],
      }),
    );

    expect(await screen.findByRole("link", { name: "Resume Writing" })).toHaveAttribute(
      "href",
      `/full-test/${RUN_ID}/writing`,
    );
    window.sessionStorage.clear();
  });

  // Abandoning mid-run is just leaving; reopening the Run must put the User back at the section that
  // is still outstanding, with everything before it locked.
  it("resumes an abandoned sitting at the section it was left on", async () => {
    renderRun(
      run({
        currentSection: "writing",
        sections: [
          section({ section: "reading", order: 1, state: "completed", attemptId: "att-r", launchable: false }),
          section({ section: "listening", order: 2, state: "completed", attemptId: "att-l", launchable: false }),
          section({ section: "writing", order: 3, launchable: true }),
          section({ section: "speaking", order: 4 }),
        ],
      }),
    );

    expect(await screen.findByRole("link", { name: "Start Writing" })).toHaveAttribute(
      "href",
      `/full-test/${RUN_ID}/writing`,
    );
    // The two finished sections are locked, and Speaking is still behind Writing.
    expect(screen.queryByRole("link", { name: /Start (Reading|Listening|Speaking)/ })).toBeNull();
    expect(screen.queryByRole("link", { name: /Resume/ })).toBeNull();
    expect(screen.getAllByText("Complete")).toHaveLength(2);
  });

  it("turns a completed run into its Score Report, and stops offering any section", async () => {
    renderRun(
      run({
        status: "completed",
        currentSection: null,
        completedAt: "2026-08-23T03:30:00.000Z",
        sections: completedSections({ reading: 4.5, listening: 5, writing: 5, speaking: 5 }),
      }),
    );

    expect(await screen.findByTestId("full-test-report")).toBeInTheDocument();
    expect(screen.queryByRole("link", { name: /^Start / })).toBeNull();
    // Finished sittings report the time they took, not a still-running clock.
    expect(screen.getByText(/Took 1 h 30 min/)).toBeInTheDocument();
  });

  // The Dashboard's Full-Test Run panel rounds a sitting to the nearest minute; the report says the
  // same length for the same sitting, not one that floors it a minute short.
  it("reports a sitting's length rounded as the Dashboard panel does", async () => {
    renderRun(
      run({
        status: "completed",
        currentSection: null,
        completedAt: "2026-08-23T03:27:59.000Z",
        sections: completedSections({ reading: 4.5, listening: 5, writing: 5, speaking: 5 }),
      }),
    );

    expect(await screen.findByText(/Took 1 h 28 min/)).toBeInTheDocument();
  });

  // The handoff POST each section fires as it ends is best-effort; when it is the one that goes
  // missing the Run is left pointing at a section that is already done. This is the way out.
  it("offers to finish a handoff the section's own runner failed to record", async () => {
    renderRun(
      run({
        currentSection: "reading",
        sections: [
          section({ section: "reading", order: 1, state: "completed", attemptId: "att-r", launchable: false }),
          section({ section: "listening", order: 2, launchable: true }),
          section({ section: "writing", order: 3 }),
          section({ section: "speaking", order: 4 }),
        ],
      }),
    );

    expect(await screen.findByText(/never recorded the handoff/i)).toBeInTheDocument();
    expect(screen.getByText(/The Reading section is finished, but/)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Continue to Listening" })).toBeInTheDocument();
  });

  // A discarded section ends the Run's wait on it too, but it was abandoned, not finished: the
  // notice must not contradict the "Abandoned" chip on the card below it.
  it("calls a section whose Attempt was discarded abandoned, not finished", async () => {
    renderRun(
      run({
        currentSection: "listening",
        sections: [
          section({ section: "reading", order: 1, state: "completed", attemptId: "att-r", launchable: false }),
          section({ section: "listening", order: 2, state: "aborted", attemptId: "att-l", launchable: false }),
          section({ section: "writing", order: 3, launchable: true }),
          section({ section: "speaking", order: 4 }),
        ],
      }),
    );

    expect(await screen.findByText(/The Listening section was abandoned, but this Full-Test Run never recorded the handoff/)).toBeInTheDocument();
    expect(screen.queryByText(/The Listening section is finished/)).toBeNull();
  });

  // More than one handoff can be the lost one, and the sitting moves on regardless (the launchable
  // section is derived from the Attempts, never from the stalled cursor). The server's advance
  // catches the cursor up to the first section still to sit, so the button names that section; a
  // label read off cursor+1 would say "Continue to Listening" for a section already finished.
  it("labels the recovery with the first section still to sit, skipping finished ones", async () => {
    renderRun(
      run({
        currentSection: "reading",
        sections: [
          section({ section: "reading", order: 1, state: "completed", attemptId: "att-r", launchable: false }),
          section({ section: "listening", order: 2, state: "completed", attemptId: "att-l", launchable: false }),
          section({ section: "writing", order: 3, launchable: true }),
          section({ section: "speaking", order: 4 }),
        ],
      }),
    );

    expect(await screen.findByText(/never recorded the handoff/i)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Continue to Writing" })).toBeInTheDocument();
  });

  // Both remaining handoffs lost: the cursor stalled on Writing while Speaking was sat anyway, so
  // no section's own advance is ever coming. The page records the finish itself, or a fully sat Run
  // reads "In progress" until the User finds the right button.
  it("records the finish itself when every section is done but the run never completed", async () => {
    const sections = completedSections({ reading: 4.5, listening: 5, writing: 5, speaking: null });
    const stale = run({ currentSection: "writing", sections });
    const finished = run({
      status: "completed",
      currentSection: null,
      completedAt: "2026-08-25T09:56:00.000Z",
      sections,
    });
    let advanced = false;
    vi.stubGlobal(
      "fetch",
      vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
        const url = typeof input === "string" ? input : input.toString();
        const body = (() => {
          if (url.includes(`/api/full-tests/${RUN_ID}/advance`) && init?.method === "POST") {
            advanced = true;
            return finished;
          }
          if (url.includes(`/api/full-tests/${RUN_ID}`)) return advanced ? finished : stale;
          throw new Error(`unhandled fetch in test: ${url}`);
        })();
        return Promise.resolve(
          new Response(JSON.stringify(body), { status: 200, headers: { "Content-Type": "application/json" } }),
        );
      }) as unknown as typeof fetch,
    );

    render(
      <MemoryRouter initialEntries={[`/full-test/${RUN_ID}`]}>
        <Routes>
          <Route path="/full-test/:runId" element={<FullTestRun />} />
        </Routes>
      </MemoryRouter>,
    );

    // No click anywhere: the page fires the finishing advance itself and reloads into the report.
    expect(await screen.findByTestId("full-test-report")).toBeInTheDocument();
    expect(advanced).toBe(true);
    expect(screen.queryByText(/never recorded the handoff/i)).toBeNull();
    expect(screen.queryByRole("button", { name: /Finish the Full-Test Run/i })).toBeNull();
  });

  it("does not offer that recovery on an ordinary in-progress run", async () => {
    renderRun(run());
    await sectionRows();
    expect(screen.queryByText(/never recorded the handoff/i)).toBeNull();
  });

  it("says so, rather than rendering an empty run, when the run cannot be loaded", async () => {
    renderRun({ status: 404, payload: { error: "unknown full test run" } });
    expect(await screen.findByText("This Full-Test Run could not be loaded.")).toBeInTheDocument();
    expect(screen.getByText(/^Not found\. The link may be out of date/)).toBeInTheDocument();
    expect(screen.queryByText(/unknown full test run/)).toBeNull();
    expect(screen.queryByRole("list", { name: "Sections, in test order" })).toBeNull();
  });
});

// A completed Run's page is its report, so these are assertions about the same component in its
// finished state: four section bands, the Overall above them, and the disclosures every surface that
// shows a band carries.
describe("the full-test score report", () => {
  const completedRun = (
    bands: { reading: number | null; listening: number | null; writing: number | null; speaking: number | null },
  ) =>
    run({
      status: "completed",
      currentSection: null,
      completedAt: "2026-08-23T03:30:00.000Z",
      sections: completedSections(bands),
    });

  it("shows the four section bands and the overall, each labelled an unofficial estimate", async () => {
    // (4.5 + 5 + 5 + 5) / 4 = 4.875 -> 5.
    renderRun(completedRun({ reading: 4.5, listening: 5, writing: 5, speaking: 5 }));

    const report = await screen.findByTestId("full-test-report");
    expect(within(report).getByTestId("overall-band")).toHaveTextContent(/^5\/6 out of 6 · C1\s*estimate$/);
    expect(within(report).getByText("mean-of-sections-v1")).toBeInTheDocument();
    // Said once for the page, not on every card.
    expect(screen.getByText(/Every band here is an unofficial estimate/)).toBeInTheDocument();
    // The overall's CEFR level rides on the overall's own figure — never as a standalone level.
    expect(within(report).getByTestId("cefr-level")).toHaveTextContent("C1");
    expect(within(report).queryByTestId("overall-pending")).toBeNull();

    // Every section's own band, with the method that produced it and its own CEFR level.
    const items = sectionRowsNow();
    expect(items.map((li) => within(li).getByTestId(/^section-band-/).textContent)).toEqual([
      expect.stringContaining("4.5"),
      expect.stringContaining("5"),
      expect.stringContaining("5"),
      expect.stringContaining("5"),
    ]);
    expect(within(items[0]).getByText("table3-v1")).toBeInTheDocument();
    expect(within(items[2]).getByText("linear-v2")).toBeInTheDocument();
    for (const li of items) expect(within(li).getByTestId("cefr-level")).toBeInTheDocument();
  });

  it("discloses each section's coverage, its skipped items, and the Module Path for Reading and Listening", async () => {
    renderRun(completedRun({ reading: 4.5, listening: 5, writing: 5, speaking: 5 }));

    const items = await sectionRows();
    expect(within(items[0]).getByText("Read an Academic Passage · 3 Items")).toBeInTheDocument();
    // A skipped Item is a real 0 in the band, so the surface showing the band says so.
    expect(within(items[3]).getByText("Interview · 3 Items (1 skipped)")).toBeInTheDocument();
    expect(within(items[3]).getByText(/Includes 1 skipped Item scored 0/)).toBeInTheDocument();

    // Reading routed to the Lower Module, so its cap caveat has to appear beside its band;
    // Listening's Upper path is disclosed too. Writing and Speaking never route, so neither says
    // anything about a Module.
    const disclosures = screen.getAllByTestId("module-path-disclosure");
    expect(disclosures).toHaveLength(2);
    expect(within(items[0]).getByTestId("module-path-disclosure")).toHaveTextContent(/Lower Module/);
    expect(within(items[0]).getByTestId("module-path-disclosure")).toHaveTextContent(/capped at 4\.5/);
    expect(within(items[1]).getByTestId("module-path-disclosure")).toHaveTextContent(/Upper Module/);
    expect(within(items[2]).queryByTestId("module-path-disclosure")).toBeNull();
    expect(within(items[3]).queryByTestId("module-path-disclosure")).toBeNull();
  });

  // The state every sitting passes through: a Run completes at Speaking's capture-finished marker,
  // with its Judges still running. The report must say so and show no band, never a mean of three.
  it("says the overall is pending, and shows no band, while Speaking is still scoring", async () => {
    renderRun(completedRun({ reading: 5, listening: 5, writing: 5, speaking: null }));

    const report = await screen.findByTestId("full-test-report");
    const pending = within(report).getByTestId("overall-pending");
    expect(pending).toHaveTextContent(/Speaking is still scoring/);
    expect(pending).toHaveTextContent(/mean of the 3 already scored would be a different number/);
    expect(within(report).queryByTestId("overall-band")).toBeNull();
    // A mean of the three would show 5 (C1); the Overall shows no figure and no level.
    expect(within(report).queryByTestId("cefr-level")).toBeNull();

    // The section itself says why it has no band, rather than showing an empty row.
    const speaking = sectionRowsNow()[3];
    expect(within(speaking).getByTestId("section-scoring-speaking")).toHaveTextContent(/Still scoring/);
    expect(within(speaking).queryByTestId("section-band-speaking")).toBeNull();
    // The three that are scored still report their own bands.
    expect(screen.getAllByTestId(/^section-band-/)).toHaveLength(3);
  });

  // A band that will never arrive must not be presented as one worth waiting for.
  it("says a sitting with an abandoned section has no whole-test band at all", async () => {
    const sections = completedSections({ reading: 5, listening: 5, writing: 5, speaking: null });
    sections[3] = { ...sections[3], state: "aborted", bandStatus: { status: "not-finished" } };
    renderRun(
      run({ status: "completed", currentSection: null, completedAt: "2026-08-23T03:30:00.000Z", sections }),
    );

    const pending = await screen.findByTestId("overall-pending");
    expect(pending).toHaveTextContent(/No Overall for this sitting: Speaking has no band/);
    expect(pending).toHaveTextContent(/will not get one/);
    expect(screen.queryByTestId("overall-band")).toBeNull();
  });
});

// The report says a band can still come, and how, only where the section's own Attempt review says
// so. It decides Item by Item from that Attempt, by the review's rule (shortfallRemedy): counts alone
// cannot tell a transcription Retry can restart from one that failed for good.
describe("a finished sitting's section with no band", () => {
  const LR_PENDING: BandShortfallVM = { unscored: [{ taskType: "listen_repeat", failed: 0, pending: 2, notCaptured: 0 }], absent: [] };
  const EMAIL_FAILED: BandShortfallVM = { unscored: [{ taskType: "email", failed: 1, pending: 0, notCaptured: 0 }], absent: [] };

  /** A completed Run whose Writing or Speaking section settled with `shortfall` and no band. */
  function runWithNoBand(name: "writing" | "speaking", shortfall: BandShortfallVM): FullTestRunVM {
    const sections = completedSections({ reading: 5, listening: 5, writing: name === "writing" ? null : 5, speaking: name === "speaking" ? null : 5 });
    const i = name === "writing" ? 2 : 3;
    sections[i] = { ...sections[i], bandStatus: { status: "no-band", ...shortfall } };
    return run({ status: "completed", currentSection: null, completedAt: "2026-08-23T03:30:00.000Z", sections });
  }

  function attemptDetail(name: "writing" | "speaking", shortfall: BandShortfallVM, items: Partial<ItemVM>[]): AttemptDetailVM {
    return {
      attempt: {
        id: `att-${name}`, kind: name, mode: "simulation", setId: `set-${name}`, setTitle: null, isRepeat: false, status: "completed",
        startedAt: "2026-08-23T02:00:00.000Z", completedAt: "2026-08-23T03:00:00.000Z", captureFinishedAt: null, flagged: false,
      },
      items: items.map((over, n) => ({
        attemptId: `att-${name}`, itemId: `item-${n + 1}`, taskType: "email", responseText: null, responseAudioPath: null, transcript: null,
        score: null, scoreJson: null, scoringStatus: "pending", deliveryReport: null, createdAt: "2026-08-23T02:10:00.000Z", ...over,
      })),
      judgeReports: [],
      estimate: null,
      bandStatus: { status: "incomplete", ...shortfall },
      activeJobs: [],
    };
  }

  /** A Listen and Repeat recording whose transcription failed with `failure`. */
  const untranscribed = (failure: Pick<TranscriptionJobVM, "failureKind" | "error">): Partial<ItemVM> => ({
    taskType: "listen_repeat",
    responseAudioPath: "recordings/take.webm",
    scoringStatus: "transcription_pending",
    transcriptionJob: { jobId: "tj-1", status: "failed", automaticAttempts: 3, nextRetryAt: null, scoreJobId: null, ...failure },
  });
  const TERMINAL = { failureKind: "unsupported-audio", error: "audio format not supported" } as const;
  const RETRYABLE = { failureKind: "configuration", error: "no API key" } as const;

  /** An Attempt the test lets load when it chooses. */
  function deferred(): { promise: Promise<AttemptDetailVM>; resolve: (detail: AttemptDetailVM) => void } {
    let resolve!: (detail: AttemptDetailVM) => void;
    const promise = new Promise<AttemptDetailVM>((r) => (resolve = r));
    return { promise, resolve };
  }

  it("does not promise a band or a Retry for a recording whose transcription failed for good", async () => {
    renderRun(runWithNoBand("speaking", LR_PENDING), {
      "att-speaking": attemptDetail("speaking", LR_PENDING, [untranscribed(TERMINAL), untranscribed(TERMINAL)]),
    });
    const noBand = within((await sectionRows())[3]).getByTestId("section-no-band-speaking");
    const overall = screen.getByTestId("overall-pending");
    await waitFor(() => expect(overall).toHaveTextContent(/No Overall for this sitting: Speaking has no band and will not get one/));
    expect(noBand).toHaveTextContent("2 Listen and Repeat Responses were never scored. A band needs every Item of the section scored.");
    expect(noBand).not.toHaveTextContent(/yet|Retry|can still/);
    expect(overall).not.toHaveTextContent(/yet|can still/);
  });

  it("promises nothing until the section's Attempt has loaded, then the Retry its review offers", async () => {
    const attempt = deferred();
    renderRun(runWithNoBand("speaking", LR_PENDING), { "att-speaking": attempt.promise });
    const noBand = within((await sectionRows())[3]).getByTestId("section-no-band-speaking");
    const overall = screen.getByTestId("overall-pending");
    expect(noBand).toHaveTextContent("2 Listen and Repeat Responses were never scored. This section's report shows where each of them stands.");
    expect(noBand).not.toHaveTextContent(/yet|Retry|Re-score|can still/);
    expect(overall).toHaveTextContent(/No Overall: Speaking has no band, and that section's report says where its unscored Items stand/);
    expect(overall).not.toHaveTextContent(/yet|can still|will not get one/);

    await act(async () => attempt.resolve(attemptDetail("speaking", LR_PENDING, [untranscribed(RETRYABLE), untranscribed(RETRYABLE)])));
    await waitFor(() =>
      expect(noBand).toHaveTextContent(
        "2 Listen and Repeat Responses were never scored. Retry the transcription from this section's report; the band follows once it is scored.",
      ),
    );
    expect(noBand).toHaveTextContent(/No band yet/);
    expect(overall).toHaveTextContent(/No Overall yet: Speaking has no band until its unscored Items are scored/);
  });

  it("promises the Re-score its review offers for a failed essay, once the Attempt has loaded", async () => {
    const attempt = deferred();
    renderRun(runWithNoBand("writing", EMAIL_FAILED), { "att-writing": attempt.promise });
    const noBand = within((await sectionRows())[2]).getByTestId("section-no-band-writing");
    expect(noBand).not.toHaveTextContent(/yet|Re-score/);

    await act(async () =>
      attempt.resolve(attemptDetail("writing", EMAIL_FAILED, [
        { taskType: "build_sentence", score: 1, scoringStatus: "scored", scoreJson: { correct: true } },
        { taskType: "email", responseText: "Dear Dr Lee,", scoringStatus: "failed", scoreJson: { error: "scoring interrupted" } },
      ])),
    );
    await waitFor(() => expect(noBand).toHaveTextContent("1 Write an Email Item failed scoring. Re-score it from this section's report to get a band."));
    expect(noBand).toHaveTextContent(/No band yet/);
    expect(screen.getByTestId("overall-pending")).toHaveTextContent(/No Overall yet: Writing has no band until its unscored Items are scored/);
  });

  it("promises nothing for a recording nothing is transcribing and its review offers no Retry for", async () => {
    renderRun(runWithNoBand("speaking", LR_PENDING), {
      "att-speaking": attemptDetail("speaking", LR_PENDING, [
        { taskType: "listen_repeat", responseAudioPath: "recordings/a.webm", scoringStatus: "transcription_pending" },
        untranscribed(RETRYABLE),
      ]),
    });
    const noBand = within((await sectionRows())[3]).getByTestId("section-no-band-speaking");
    // Let the Attempt load; what it decides must still be no promise.
    await act(async () => {});
    expect(noBand).toHaveTextContent(/This section's report shows where each of them stands/);
    expect(noBand).not.toHaveTextContent(/yet|Retry|can still/);
    expect(screen.getByTestId("overall-pending")).not.toHaveTextContent(/yet|can still|will not get one/);
  });

  it("promises nothing when the section's Attempt cannot be loaded", async () => {
    renderRun(runWithNoBand("writing", EMAIL_FAILED), { "att-writing": "unavailable" });
    const noBand = within((await sectionRows())[2]).getByTestId("section-no-band-writing");
    await act(async () => {});
    expect(noBand).toHaveTextContent("1 Write an Email Item failed scoring. This section's report shows where each of them stands.");
    expect(noBand).not.toHaveTextContent(/yet|Re-score|can still/);
  });
});
