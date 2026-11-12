import { afterEach, describe, expect, it, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter } from "react-router-dom";
import type { SetAdvisoryNote } from "@toefl-prep/shared";
import Sets from "../src/pages/Sets";

function fetchStub(routes: Record<string, () => Response | Promise<Response>>) {
  return vi.fn((input: RequestInfo | URL) => {
    const url = typeof input === "string" ? input : input.toString();
    const handler = Object.entries(routes).find(([pattern]) => url.includes(pattern))?.[1];
    if (!handler) throw new Error(`unhandled fetch in test: ${url}`);
    return Promise.resolve(handler());
  }) as unknown as typeof fetch;
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
}

afterEach(() => vi.unstubAllGlobals());

const CATALOG_NOTE: SetAdvisoryNote = {
  check: "catalog-novelty",
  detail: "containment",
  taskType: "listen_choose",
  conflictingSetIds: ["lsn-14659f38"],
  score: 0.8,
};

describe("the practice-set picker discloses a Set's advisory notes", () => {
  function renderPicker(advisoryNotes?: SetAdvisoryNote[], kind: "listening" | "speaking" = "listening") {
    const id = kind === "listening" ? "lsn-03948a55" : "spk-03948a55";
    const entry = {
      id,
      kind,
      source: "generated",
      createdAt: "2026-08-12T00:00:00.000Z",
      title: "Neuroscience Talk",
      summary: null,
      attempted: false,
      ...(advisoryNotes ? { advisoryNotes } : {}),
    };
    vi.stubGlobal(
      "fetch",
      fetchStub({
        "sets?kind=writing": () => jsonResponse([]),
        "sets?kind=speaking": () => jsonResponse(kind === "speaking" ? [entry] : []),
        "sets?kind=reading": () => jsonResponse([]),
        "sets?kind=listening": () => jsonResponse(kind === "listening" ? [entry] : []),
        "/api/attempts": () => jsonResponse([]),
        // /sets also asks what on disk failed to load. Nothing has, here.
        "/api/sets/unloadable": () => jsonResponse({ count: 0, failures: [] }),
      }),
    );
    render(
      <MemoryRouter>
        <Sets />
      </MemoryRouter>,
    );
    return id;
  }

  const REPEATS = "One part of this Set repeats content from another Set in your bank.";

  // The notes are disclosed before the Set is practised, but behind a toggle rather than spilled
  // onto the row: a Listening Set can carry thirty of them. Collapsed means absent from the DOM,
  // not merely hidden, and what opens is plain sentences, never the check codes.
  it("offers a Set's notes behind a toggle, closed until asked for, in plain words", async () => {
    const id = renderPicker([CATALOG_NOTE]);
    expect(await screen.findByText(id)).toBeTruthy();
    const toggle = screen.getByRole("button", { name: "1 note on this Set" });
    expect(toggle.getAttribute("aria-expanded")).toBe("false");
    expect(screen.queryByText(REPEATS)).toBeNull();

    await userEvent.click(toggle);
    expect(toggle.getAttribute("aria-expanded")).toBe("true");
    expect(screen.getByText(REPEATS)).toBeTruthy();
    expect(screen.queryByText(/containment|catalog-novelty|lsn-14659f38/u)).toBeNull();

    await userEvent.click(toggle);
    expect(screen.queryByText(REPEATS)).toBeNull();
  });

  it("shows no toggle for a Set published before notes existed", async () => {
    const id = renderPicker(undefined);
    expect(await screen.findByText(id)).toBeTruthy();
    expect(screen.queryByText(/advisory|note/iu)).toBeNull();
  });

  it("shows no toggle when every note a Set carries is one the learner never sees", async () => {
    const id = renderPicker(
      [
        { check: "plan-conformance", detail: "plan-drift", taskType: "interview" },
        { check: "speech-rate", detail: "lr-briefing", measuredWpm: 120, minWpm: 140, maxWpm: 180, targetWpm: 160, take: "retake" },
      ],
      "speaking",
    );
    expect(await screen.findByText(id)).toBeTruthy();
    expect(screen.queryByRole("button", { name: /on this Set/u })).toBeNull();
  });
});
