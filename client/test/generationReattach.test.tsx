import { afterEach, describe, expect, it, vi } from "vitest";
import { render as renderRaw, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { ReactElement } from "react";
import { MemoryRouter } from "react-router-dom";
import SetGeneration from "../src/components/generation/SetGeneration";

// Generation survives a page refresh: the jobs are durable server-side, and SetGeneration
// re-attaches its progress UI on mount from GET /api/generate's active listing, polling the
// still-running work without POSTing anything (a POST here would queue a duplicate paid run).

const render = (ui: ReactElement) => renderRaw(<MemoryRouter>{ui}</MemoryRouter>);
const control = (onGenerated: () => void = () => {}) => (
  <SetGeneration dialogOpen={false} onDialogClose={() => {}} onGenerated={onGenerated} setup={null} />
);

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
}

function stubFetch(handler: (url: string, method: string) => Response | undefined): string[] {
  const posts: string[] = [];
  vi.stubGlobal(
    "fetch",
    vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
      const url = typeof input === "string" ? input : input.toString();
      const method = init?.method ?? "GET";
      if (method === "POST") posts.push(url);
      const res = handler(url, method);
      if (!res) return Promise.reject(new Error(`unhandled ${method} ${url}`));
      return Promise.resolve(res);
    }),
  );
  return posts;
}

const runningJob = {
  jobId: "job-1",
  kind: "writing",
  status: "running",
  stage: "generating",
  progress: null,
  cancellationRequestedAt: null,
  terminalAt: null,
  cancellationReason: null,
};

const runningBatch = {
  jobId: "batch-1",
  kind: "batch",
  status: "running",
  total: 3,
  queued: 1,
  activeCount: 1,
  completed: 1,
  failed: 0,
  cancelled: 0,
  cancelRequested: false,
  cancellationRequestedAt: null,
  terminalAt: null,
  cancellationReason: null,
  active: [{ jobId: "c2", setIndex: 1, kind: "writing", stage: "generating", progress: null }],
  activeChildIds: ["c2"],
  current: { jobId: "c2", setIndex: 1, kind: "writing", stage: "generating", progress: null },
  children: [
    { jobId: "c1", setIndex: 0, kind: "writing", status: "done", stage: "saving", progress: null, setId: "set-1" },
    { jobId: "c2", setIndex: 1, kind: "writing", status: "running", stage: "generating", progress: null },
    { jobId: "c3", setIndex: 2, kind: "speaking", status: "queued", stage: null, progress: null },
  ],
};

afterEach(() => vi.unstubAllGlobals());

describe("SetGeneration re-attach on mount", () => {
  it("resumes a still-running standalone job's progress UI without POSTing, with the elapsed clock backdated to the job's real start", async () => {
    const posts = stubFetch((url, method) => {
      if (method !== "GET") return undefined;
      if (url === "/api/generate") {
        return jsonResponse({
          active: [{ ...runningJob, createdAt: new Date(Date.now() - 600_000).toISOString() }],
        });
      }
      if (url === "/api/generate/job-1") return jsonResponse(runningJob);
      return undefined;
    });

    render(control());

    expect(await screen.findByText("Generating a Writing Set")).toBeInTheDocument();
    // Backdated to the durable row's createdAt (ten minutes ago), never this mount's own clock.
    expect(screen.getByText("10:00")).toBeInTheDocument();
    expect(posts).toEqual([]);
  });

  it("resumes a still-running batch, including the per-set breakdown, and cancels against the re-attached id", async () => {
    const posts = stubFetch((url, method) => {
      if (url === "/api/generate" && method === "GET") {
        return jsonResponse({ active: [{ ...runningBatch, createdAt: new Date(Date.now() - 60_000).toISOString() }] });
      }
      if (url === "/api/generate/batch-1" && method === "GET") return jsonResponse(runningBatch);
      if (url === "/api/generate/batch-1/cancel" && method === "POST") return jsonResponse(runningBatch);
      return undefined;
    });

    const onGenerated = vi.fn();
    render(control(onGenerated));

    expect(await screen.findByText("Generating 3 Sets")).toBeInTheDocument();
    expect(screen.getByText("1 ready · 1 in progress · 1 waiting")).toBeInTheDocument();
    expect(screen.getByRole("region", { name: "Set 2 of 3" })).toBeInTheDocument();
    // The Set that completed before this mount must not fire the landed-set refetch on re-attach:
    // the attach path seeds the notified-completed counter from the listing entry.
    expect(onGenerated).not.toHaveBeenCalled();

    await userEvent.click(screen.getByRole("button", { name: "Cancel batch" }));
    expect(posts).toEqual(["/api/generate/batch-1/cancel"]);
  });

  it("renders a sibling panel — with its own cancel affordance — for a second active standalone job the listing returns", async () => {
    const otherJob = {
      jobId: "job-2",
      kind: "speaking",
      status: "running",
      stage: "generating",
      progress: null,
      cancellationRequestedAt: null,
      terminalAt: null,
      cancellationReason: null,
    };
    const posts = stubFetch((url, method) => {
      if (url === "/api/generate" && method === "GET") {
        return jsonResponse({
          active: [
            { ...runningJob, createdAt: new Date(Date.now() - 600_000).toISOString() },
            { ...otherJob, createdAt: new Date(Date.now() - 120_000).toISOString() },
          ],
        });
      }
      if (url === "/api/generate/job-1" && method === "GET") return jsonResponse(runningJob);
      if (url === "/api/generate/job-2" && method === "GET") return jsonResponse(otherJob);
      if (url === "/api/generate/job-2/cancel" && method === "POST") return jsonResponse(otherJob);
      return undefined;
    });

    render(control());

    // Both the primary re-attached job and the second one the listing returned get their own panel.
    // waitFor (not findAllByText, which resolves as soon as one match exists) so this waits for both
    // panels' independent polls to land, not just the faster of the two.
    await waitFor(() => expect(screen.getByText("Generating a Writing Set")).toBeInTheDocument());
    await waitFor(() => expect(screen.getByText("Generating a Speaking Set")).toBeInTheDocument());
    expect(screen.getByText("Also running")).toBeInTheDocument();

    // Both panels are standalone jobs, so both carry their own Cancel: the primary job-1 (rendered
    // first) and the sibling job-2 (rendered second, under "Also running"). Clicking the sibling's
    // must hit job-2's id, not the primary's.
    const cancelButtons = screen.getAllByRole("button", { name: /^Cancel generating/ });
    expect(cancelButtons).toHaveLength(2);
    await userEvent.click(cancelButtons[1]);
    expect(posts).toEqual(["/api/generate/job-2/cancel"]);
  });

  it("renders a sibling panel for a second active batch the listing returns", async () => {
    const otherBatch = { ...runningBatch, jobId: "batch-2" };
    const posts = stubFetch((url, method) => {
      if (url === "/api/generate" && method === "GET") {
        return jsonResponse({
          active: [
            { ...runningBatch, createdAt: new Date(Date.now() - 60_000).toISOString() },
            { ...otherBatch, createdAt: new Date(Date.now() - 30_000).toISOString() },
          ],
        });
      }
      if (url === "/api/generate/batch-1" && method === "GET") return jsonResponse(runningBatch);
      if (url === "/api/generate/batch-2" && method === "GET") return jsonResponse(otherBatch);
      if (url === "/api/generate/batch-2/cancel" && method === "POST") return jsonResponse(otherBatch);
      return undefined;
    });

    render(control());

    await waitFor(() => expect(screen.getAllByText("Generating 3 Sets")).toHaveLength(2));
    expect(screen.getByText("Also running")).toBeInTheDocument();

    const cancelButtons = screen.getAllByRole("button", { name: "Cancel batch" });
    expect(cancelButtons).toHaveLength(2);
    await userEvent.click(cancelButtons[1]);
    expect(posts).toEqual(["/api/generate/batch-2/cancel"]);
  });
});
