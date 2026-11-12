import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";
import { useFakeTimersInTest } from "./fakeTimers";
import { act, render, screen, waitFor } from "@testing-library/react";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import type { AttemptDetailVM, ServedSpeakingSet } from "@toefl-prep/shared";
import AttemptReview from "../src/pages/AttemptReview";
import { getAttempt, getSet } from "../src/lib/api";

// Every timestamp the server hands this page is an unambiguous ISO instant (see
// server/src/db/timestamps.ts), so the page converts it exactly once, with a bare `new Date(...)`.
// Getting that count wrong in either direction shows the User the wrong time: no conversion of a raw
// space-form value reads UTC as local (eight hours early here), and a second conversion of an
// instant shifts it again.
//
// Pinned to a non-UTC zone because on a UTC machine every one of those variants renders the same
// string and the test would be a false green. Restored afterwards so no other suite inherits it.
//
// Set before any import runs (vi.hoisted): the page formats through ui/format.ts, whose Intl
// formatters take the zone in force when the module loads.
const ORIGINAL_TZ = vi.hoisted(() => {
  const original = process.env.TZ;
  process.env.TZ = "Asia/Taipei";
  return original;
});
afterAll(() => {
  if (ORIGINAL_TZ === undefined) delete process.env.TZ;
  else process.env.TZ = ORIGINAL_TZ;
});

vi.mock("../src/lib/api", () => ({
  getAttempt: vi.fn(),
  getSet: vi.fn(),
  retryTranscription: vi.fn(),
  scoreTask: vi.fn(),
  HttpError: class HttpError extends Error {
    status: number;
    constructor(status: number, message: string) {
      super(message);
      this.status = status;
    }
  },
}));

// 12:50:10 UTC, which is 20:50 local here.
const STARTED = "2026-08-22T12:50:10.000Z";
const COMPLETED = "2026-08-22T13:05:10.000Z";
const NEXT_RETRY = "2026-08-22T12:50:25.000Z";

function detail(overrides: Partial<AttemptDetailVM["items"][number]> = {}): AttemptDetailVM {
  return {
    attempt: {
      id: "att-1",
      kind: "speaking",
      mode: "drill",
      setId: "spk-1",
      setTitle: null,
      isRepeat: false,
      status: "completed",
      startedAt: STARTED,
      completedAt: COMPLETED,
      captureFinishedAt: null,
      flagged: false,
    },
    items: [
      {
        attemptId: "att-1",
        itemId: "lr-1",
        taskType: "listen_repeat",
        responseText: null,
        responseAudioPath: null,
        transcript: null,
        score: null,
        scoreJson: null,
        scoringStatus: "transcription_pending",
        deliveryReport: null,
        createdAt: STARTED,
        ...overrides,
      },
    ],
    judgeReports: [],
    estimate: null,
    bandStatus: { status: "incomplete", unscored: [], absent: [] },
    activeJobs: [],
  };
}

async function renderSettled() {
  render(
    <MemoryRouter initialEntries={["/attempts/att-1"]}>
      <Routes>
        <Route path="/attempts/:id" element={<AttemptReview />} />
      </Routes>
    </MemoryRouter>,
  );
  await waitFor(() => expect(vi.mocked(getSet)).toHaveBeenCalledWith("spk-1"));
  await act(async () => {});
}

// A whole served speaking Set, as GET /api/sets/:id sends it.
const servedSpeakingSet: ServedSpeakingSet = {
  id: "spk-1",
  kind: "speaking",
  source: "generated",
  createdAt: STARTED,
  listenAndRepeat: {
    scenarioTitle: "At the campus café",
    scenarioDescription: "You are ordering coffee.",
    items: [{ id: "lr-1", audio: "stimuli/spk-1/lr-1.mp3", responseWindowSec: 10 }],
  },
  interview: {
    scenarioTitle: "Student services interview",
    intro: "A few questions about campus life.",
    introAudio: "stimuli/spk-1/int-intro.mp3",
    questions: [{ id: "iv-1", type: "experience", audio: "stimuli/spk-1/iv-1.mp3", responseWindowSec: 45 }],
  },
};

beforeEach(() => {
  // "Today"/"Yesterday" are relative to now; the day after the Attempt keeps the words fixed.
  useFakeTimersInTest({ toFake: ["Date"] });
  vi.setSystemTime(new Date("2026-08-23T04:00:00.000Z"));
  vi.mocked(getAttempt).mockReset();
  vi.mocked(getSet).mockReset();
  vi.mocked(getSet).mockResolvedValue(servedSpeakingSet);
});

describe("Attempt review renders instants as local wall-clock time", () => {
  it("the test machine is on a non-UTC timezone, so a mis-converted value would differ", () => {
    expect(new Date(STARTED).getTimezoneOffset()).toBe(-480);
  });

  it("shows the started and completed times converted exactly once", async () => {
    vi.mocked(getAttempt).mockResolvedValue(detail());
    await renderSettled();

    // 12:50 UTC is 8:50 PM here and the Attempt ran until 9:05 PM. Read as local time it would
    // say 12:50 PM; converted twice, 4:50 AM.
    const range = screen.getByText(/8:50 PM – 9:05 PM/);
    expect(range.textContent).toBe("Yesterday, 8:50 PM – 9:05 PM");
    expect(new Date(STARTED).getHours()).toBe(20);
  });

  it("shows a scheduled transcription retry converted exactly once", async () => {
    vi.mocked(getAttempt).mockResolvedValue(
      detail({
        transcriptionJob: {
          jobId: "job-1",
          status: "retry_wait",
          automaticAttempts: 1,
          nextRetryAt: NEXT_RETRY,
          failureKind: "provider",
          error: "provider unavailable (HTTP 503)",
          scoreJobId: null,
        },
      }),
    );
    await renderSettled();

    const line = await screen.findByText(/next attempt around/i);
    expect(line.textContent).toContain("next attempt around 8:50 PM");
  });
});
