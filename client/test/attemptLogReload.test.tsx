import { beforeEach, describe, expect, it, vi } from "vitest";
import { act, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter } from "react-router-dom";
import type { AttemptListItemVM, AttemptListVM } from "@toefl-prep/shared";
import Progress from "../src/pages/Progress";
import { completeAttempt, getStatsSummary, getTrends, listAttempts } from "../src/lib/api";
import { deferred } from "./deferred";

// On /progress, finishing an Attempt re-reads the log while "Load more" can be fetching the next
// page. Neither may discard the other: whichever lands first, the finished row shows its new state
// and the next page stays loaded.

vi.mock("../src/lib/api", () => ({
  listAttempts: vi.fn(),
  completeAttempt: vi.fn(),
  abortAttempt: vi.fn(),
  getStatsSummary: vi.fn(),
  getTrends: vi.fn(),
}));

const TOTAL = 30;

function attempt(n: number, over: Partial<AttemptListItemVM> = {}): AttemptListItemVM {
  return {
    id: `att-${n}`,
    kind: "reading",
    mode: "simulation",
    setId: `rd-${n}`,
    setTitle: `Reading Set ${n}`,
    isRepeat: false,
    status: "completed",
    startedAt: "2026-08-01T10:00:00.000Z",
    completedAt: "2026-08-01T10:20:00.000Z",
    captureFinishedAt: null,
    flagged: false,
    modulePath: null,
    routerRaw: null,
    estimate: null,
    missingBand: null,
    fullTestRun: null,
    ...over,
  };
}

// The newest Attempt is a Writing Simulation left unfinished; the rest are finished Reading ones.
function page(offset: number, limit: number, finished: boolean): AttemptListVM {
  const items: AttemptListItemVM[] = [];
  for (let n = offset; n < Math.min(offset + limit, TOTAL); n++) {
    items.push(
      n === 0
        ? attempt(0, { kind: "writing", setTitle: "Protective gloves", ...(finished ? {} : { status: "in_progress", completedAt: null }) })
        : attempt(n),
    );
  }
  return { items, total: TOTAL };
}

beforeEach(() => {
  vi.mocked(listAttempts).mockReset();
  vi.mocked(completeAttempt).mockReset().mockResolvedValue({ status: "completed" });
  vi.mocked(getStatsSummary).mockReset().mockReturnValue(new Promise(() => {}));
  vi.mocked(getTrends).mockReset().mockReturnValue(new Promise(() => {}));
});

describe.each(["the reload lands first", "the next page lands first"])("Finish and score, then Load more, when %s", (order) => {
  it("shows the finished row as finished and keeps every loaded page", async () => {
    const reloaded = deferred<AttemptListVM>();
    const nextPage = deferred<AttemptListVM>();
    vi.mocked(listAttempts).mockImplementation(({ offset } = {}) => {
      const calls = vi.mocked(listAttempts).mock.calls.length;
      if (calls === 1) return Promise.resolve(page(0, 25, false));
      return offset === 0 ? reloaded.promise : nextPage.promise;
    });
    render(
      <MemoryRouter>
        <Progress />
      </MemoryRouter>,
    );

    const log = await screen.findByRole("list", { name: "Attempts" });
    await userEvent.click(within(log).getByRole("button", { name: "Finish and score…" }));
    await userEvent.click(screen.getByRole("button", { name: "Finish and score" }));
    await waitFor(() => expect(vi.mocked(listAttempts)).toHaveBeenCalledWith({ limit: 25, offset: 0 }));
    expect(vi.mocked(listAttempts)).toHaveBeenCalledTimes(2);

    await userEvent.click(screen.getByRole("button", { name: "Load more" }));
    expect(vi.mocked(listAttempts)).toHaveBeenLastCalledWith({ limit: 25, offset: 25 });

    const settle = order === "the reload lands first" ? [reloaded, nextPage] : [nextPage, reloaded];
    for (const request of settle) {
      await act(async () => {
        request.resolve(request === reloaded ? page(0, 25, true) : page(25, 25, true));
      });
    }

    await waitFor(() => expect(screen.getByText(`All ${TOTAL} Attempts`)).toBeInTheDocument());
    expect(screen.queryByRole("button", { name: "Finish and score…" })).toBeNull();
    expect(screen.getAllByRole("link", { name: /Simulation/ })).toHaveLength(TOTAL);
  });
});
