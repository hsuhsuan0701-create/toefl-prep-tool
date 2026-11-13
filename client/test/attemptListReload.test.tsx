import { afterEach, expect, it, vi } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { AttemptListItemVM } from "@toefl-prep/shared";
import * as api from "../src/lib/api";
import App from "../src/App";

// A reload of the list page reopens the same history entry, which the router reports as a "POP"
// just like a Back. It is a fresh visit all the same (issue #44): the list starts at the top with
// its first page, whatever row was opened from that entry before. A Back to the entry later in the
// same page load still brings its row back. The app itself is mounted, with its browser router, on
// a history entry that already carries a remembered row, as a reload of it would find it.

vi.mock("../src/lib/api", async (importOriginal) => {
  const real = await importOriginal<typeof import("../src/lib/api")>();
  return {
    ...real,
    getStatsSummary: vi.fn(() => new Promise(() => {})),
    getSetupStatus: vi.fn(() => new Promise(() => {})),
    getTrends: vi.fn(async () => new Map()),
    listAttempts: vi.fn(),
    getAttempt: vi.fn(() => new Promise(() => {})),
    getSet: vi.fn(() => new Promise(() => {})),
  };
});

const mocked = vi.mocked(api);

function listItem(n: number): AttemptListItemVM {
  return {
    id: `att-${n}`,
    kind: "reading",
    mode: "drill",
    setId: `rd-${n}`,
    setTitle: `Reading Set ${n}`,
    isRepeat: false,
    status: "completed",
    startedAt: "2026-11-10T09:30:00.000Z",
    completedAt: "2026-11-10T10:00:00.000Z",
    captureFinishedAt: null,
    flagged: false,
    estimate: null,
    missingBand: null,
    fullTestRun: null,
  };
}
const LOG = Array.from({ length: 30 }, (_, i) => listItem(i + 1));

const realScrollTo = window.scrollTo;
afterEach(() => {
  window.scrollTo = realScrollTo;
  window.sessionStorage.clear();
});

const rowLinks = () => document.querySelectorAll("main li a[href^='/attempts/']");

it("starts a reloaded list at the top, and still brings a row back on a later Back", async () => {
  mocked.listAttempts.mockImplementation(async (opts = {}) => {
    const offset = opts.offset ?? 0;
    return { items: LOG.slice(offset, offset + (opts.limit ?? 25)), total: LOG.length };
  });
  const scrollTo = vi.fn();
  window.scrollTo = scrollTo as unknown as typeof window.scrollTo;
  // The entry a reload lands on, as the router left it: its key, and the row opened from it.
  window.sessionStorage.setItem("toefl-prep:attempt-list-places", JSON.stringify([["entry-1", { attemptId: "att-27", top: 300, rows: 30 }]]));
  window.history.replaceState({ usr: null, key: "entry-1", idx: 0 }, "", "/progress");

  render(<App />);
  await waitFor(() => expect(rowLinks()).toHaveLength(25));
  expect(mocked.listAttempts).toHaveBeenCalledWith({ limit: 25, offset: 0 });
  expect(scrollTo).not.toHaveBeenCalled();

  await userEvent.click(document.querySelector<HTMLElement>("main li a[href='/attempts/att-3']")!);
  await screen.findByLabelText("Loading the Attempt");
  window.history.back();
  await waitFor(() => expect(rowLinks()).toHaveLength(25));
  await waitFor(() => expect(scrollTo).toHaveBeenCalledWith({ top: 0, behavior: "instant" }));
});
