import { afterEach, describe, expect, it, vi } from "vitest";
import { render, screen, waitFor, within } from "@testing-library/react";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import type { AttemptDetailVM, BandShortfallVM, FullTestRunVM, FullTestSection, FullTestSectionBandVM, FullTestSectionVM, ItemVM } from "@toefl-prep/shared";
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

/**
 * A section's Attempt as its review loads it: the page reads it to decide, Item by Item and by the
 * review's own rule, whether a band can still come.
 */
function sectionAttempt(name: FullTestSection, shortfall: BandShortfallVM, items: Partial<ItemVM>[]): AttemptDetailVM {
  return {
    attempt: {
      id: `att-${name}`, kind: name, mode: "simulation", setId: `set-${name}`, setTitle: null, isRepeat: false, status: "completed",
      startedAt: "2026-08-23T02:00:00.000Z", completedAt: "2026-08-23T03:00:00.000Z", captureFinishedAt: null, flagged: false,
    },
    items: items.map((over, i) => ({
      attemptId: `att-${name}`, itemId: `item-${i + 1}`, taskType: "email", responseText: null, responseAudioPath: null, transcript: null,
      score: null, scoreJson: null, scoringStatus: "pending", deliveryReport: null, createdAt: "2026-08-23T02:10:00.000Z", ...over,
    })),
    judgeReports: [],
    estimate: null,
    bandStatus: { status: "incomplete", ...shortfall },
    activeJobs: [],
  };
}

function renderRun(body: FullTestRunVM, attempts: AttemptDetailVM[] = []) {
  vi.stubGlobal(
    "fetch",
    vi.fn((input: RequestInfo | URL) => {
      const url = typeof input === "string" ? input : input.toString();
      const attempt = attempts.find((a) => url.endsWith(`/api/attempts/${a.attempt.id}`));
      const [status, payload] = url.includes("/api/full-tests/") ? [200, body] : attempt ? [200, attempt] : [404, { error: "not found" }];
      return Promise.resolve(new Response(JSON.stringify(payload), { status, headers: { "Content-Type": "application/json" } }));
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

describe("a Writing section whose essay scoring failed", () => {
  it("says scoring failed and that a Re-score can still give it a band, instead of showing a Build-a-Sentence-only band", async () => {
    const shortfall: BandShortfallVM = {
      unscored: [
        { taskType: "email", failed: 1, pending: 0, notCaptured: 0 },
        { taskType: "discussion", failed: 1, pending: 0, notCaptured: 0 },
      ],
      absent: [],
    };
    renderRun(completedRun(sectionVM("writing", { status: "no-band", ...shortfall })), [
      sectionAttempt("writing", shortfall, [
        { taskType: "email", responseText: "Dear Dr Lee,", scoringStatus: "failed", scoreJson: { error: "scoring interrupted" } },
        { taskType: "discussion", responseText: "I agree.", scoringStatus: "failed", scoreJson: { error: "scoring interrupted" } },
      ]),
    ]);

    const writing = (await sectionRows())[2];
    const noBand = within(writing).getByTestId("section-no-band-writing");
    await waitFor(() => expect(noBand).toHaveTextContent(
      "1 Write an Email Item and 1 Academic Discussion Item failed scoring. Re-score them from this section's report to get a band.",
    ));
    expect(noBand).toHaveTextContent(/No band yet/);
    expect(within(writing).queryByTestId("section-band-writing")).toBeNull();

    // A Re-score can still give Writing a band, so the Overall is not called lost; nor is the User
    // told to wait for scoring nothing is doing.
    const pending = screen.getByTestId("overall-pending");
    expect(pending).toHaveTextContent(/No Overall yet: Writing has no band until its unscored Items are scored/);
    expect(pending).toHaveTextContent(/No band yet/);
    expect(pending).not.toHaveTextContent(/will not get one/);
    expect(pending).not.toHaveTextContent(/still scoring/);
  });

  it("names a Task Type with no Item at all as never recorded rather than failed, and says no band will come", async () => {
    renderRun(completedRun(sectionVM("writing", { status: "no-band", unscored: [], absent: ["email"] })));
    const writing = (await sectionRows())[2];
    const noBand = within(writing).getByTestId("section-no-band-writing");
    expect(noBand).toHaveTextContent(/No Write an Email Response was recorded/);
    expect(noBand).toHaveTextContent(/No band(?! yet)/);
    expect(noBand).not.toHaveTextContent(/No band yet/);
    const pending = screen.getByTestId("overall-pending");
    expect(pending).toHaveTextContent(/No Overall for this sitting: Writing has no band and will not get one/);
    expect(pending).not.toHaveTextContent(/No band yet/);
    // The shortfall alone settles it, so the page neither reads the Attempt nor says it is checking.
    expect(noBand).not.toHaveTextContent(/Checking/);
    expect(vi.mocked(fetch).mock.calls.map(([input]) => String(input))).not.toContainEqual(expect.stringContaining("/api/attempts/"));
  });
});

describe("a Speaking section whose Attempt cannot be read", () => {
  it("keeps the reasons, says the report could not be read, and promises nothing", async () => {
    const shortfall: BandShortfallVM = { unscored: [{ taskType: "interview", failed: 0, pending: 4, notCaptured: 0 }], absent: [] };
    // No Attempt answers: GET /api/attempts/att-speaking is a 404.
    renderRun(completedRun(sectionVM("writing", { status: "estimated" }, 5), sectionVM("speaking", { status: "no-band", ...shortfall })));
    const speaking = (await sectionRows())[3];
    const noBand = within(speaking).getByTestId("section-no-band-speaking");
    await waitFor(() => expect(noBand).toHaveTextContent(/could not be read/));
    expect(noBand).toHaveTextContent(
      "4 Interview Responses were never scored. This section's report could not be read, so where each of them stands is not known here. " +
        "Not found. The link may be out of date, or what it points to has been removed. Refresh to try again.",
    );
    expect(noBand).not.toHaveTextContent(/No band yet|Retry|Re-score|Checking/);
    const pending = screen.getByTestId("overall-pending");
    expect(pending).toHaveTextContent(/The report of Speaking could not be read here; Refresh to try again/);
    expect(pending).not.toHaveTextContent(/No band yet|will not get one|Checking/);
  });
});

describe("a Speaking section whose recordings were never transcribed", () => {
  it("says the Responses were never scored and to retry the transcription, as the Attempt review does", async () => {
    const shortfall: BandShortfallVM = {
      unscored: [
        { taskType: "listen_repeat", failed: 0, pending: 7, notCaptured: 0 },
        { taskType: "interview", failed: 0, pending: 4, notCaptured: 0 },
      ],
      absent: [],
    };
    // Every transcription failed for want of a key: retryable, so the review offers Retry.
    const untranscribed = (taskType: string): Partial<ItemVM> => ({
      taskType,
      responseAudioPath: "recordings/take.webm",
      scoringStatus: "transcription_pending",
      transcriptionJob: { jobId: "tj", status: "failed", automaticAttempts: 0, nextRetryAt: null, failureKind: "configuration", error: "no key", scoreJobId: null },
    });
    renderRun(
      completedRun(sectionVM("writing", { status: "estimated" }, 5), sectionVM("speaking", { status: "no-band", ...shortfall })),
      [sectionAttempt("speaking", shortfall, [...Array(7).fill(untranscribed("listen_repeat")), ...Array(4).fill(untranscribed("interview"))])],
    );
    const speaking = (await sectionRows())[3];
    const noBand = within(speaking).getByTestId("section-no-band-speaking");
    await waitFor(() => expect(noBand).toHaveTextContent(/No band yet/));
    expect(noBand).toHaveTextContent(
      "7 Listen and Repeat Responses and 4 Interview Responses were never scored. Retry the transcription from this section's report; the band follows once it is scored.",
    );
    expect(noBand).toHaveTextContent(/No band yet/);
    expect(within(speaking).queryByTestId("section-scoring-speaking")).toBeNull();
    expect(screen.getByTestId("overall-pending")).toHaveTextContent(/No Overall yet: Speaking has no band until its unscored Items are scored/);
  });
});

describe("a section completed with no Items", () => {
  it("reads No band, not No band yet: it can never be sat again", async () => {
    renderRun(completedRun(sectionVM("writing", { status: "no-band", unscored: [], absent: ["build_sentence", "email", "discussion"] })));
    const noBand = within((await sectionRows())[2]).getByTestId("section-no-band-writing");
    expect(noBand).not.toHaveTextContent(/No band yet/);
    expect(noBand).toHaveTextContent(/No band/);
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
      sectionVM("writing", { status: "no-band", unscored: [], absent: ["email"] }),
      sectionVM("speaking", { status: "scoring", outstanding: [] }),
    ));
    const pending = await screen.findByTestId("overall-pending");
    expect(pending).toHaveTextContent(/No Overall for this sitting: Writing has no band/);
    expect(pending).not.toHaveTextContent(/Speaking has/);
    const speaking = sectionRowsNow()[3];
    expect(within(speaking).getByTestId("section-scoring-speaking")).toHaveTextContent(/Still scoring: the last scores are being recorded/);
  });
});
