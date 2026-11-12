import { afterEach, describe, expect, it, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import Sets from "../src/pages/Sets";

// The server skips a Set file that fails schema validation rather than throwing (one malformed file
// must never blank the bank), so from the browser's side the Set is indistinguishable from a Set
// that never existed. These check the disclosure that closes that gap on /sets: the healthy bank
// still renders, and the count and the reason are on screen.
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

function renderSets(unloadable: () => Response | Promise<Response>) {
  vi.stubGlobal(
    "fetch",
    fetchStub({
      // Ordered ahead of the listing patterns below only for readability — the URLs are disjoint.
      "/api/sets/unloadable": unloadable,
      "sets?kind=writing": () =>
        jsonResponse([{ id: "wri-healthy", kind: "writing", source: "generated", createdAt: "2026-01-01T00:00:00.000Z" }]),
      "sets?kind=speaking": () => jsonResponse([]),
      "sets?kind=reading": () => jsonResponse([]),
      "sets?kind=listening": () => jsonResponse([]),
      "/api/attempts": () => jsonResponse([]),
    }),
  );
  render(
    <MemoryRouter>
      <Sets />
    </MemoryRouter>,
  );
}

afterEach(() => vi.unstubAllGlobals());

describe("/sets discloses the Sets on disk that could not be loaded", () => {
  it("says how many failed and names each file and the field that broke, while the rest of the bank still lists", async () => {
    renderSets(() =>
      jsonResponse({
        count: 2,
        failures: [
          { kind: "writing", file: "wri-broken.json", error: "ZodError: 1 issue(s) — email.bullets: invalid_type (array)" },
          { kind: "speaking", file: "spk-broken.json", error: "SyntaxError" },
        ],
      }),
    );

    // The count, in words: a number the User can act on, not a stderr line.
    expect(await screen.findByText(/2 Sets on disk could not be loaded/)).toBeInTheDocument();
    // Enough detail to go fix it: which file, and which field failed which rule.
    expect(screen.getByText("data/question-sets/writing/wri-broken.json")).toBeInTheDocument();
    expect(screen.getByText(/email\.bullets: invalid_type/)).toBeInTheDocument();
    expect(screen.getByText("data/question-sets/speaking/spk-broken.json")).toBeInTheDocument();

    // And the whole point of skipping rather than throwing: everything that did load still lists.
    expect(screen.getByText("wri-healthy")).toBeInTheDocument();
  });

  it("says nothing at all when every Set on disk loads", async () => {
    renderSets(() => jsonResponse({ count: 0, failures: [] }));

    expect(await screen.findByText("wri-healthy")).toBeInTheDocument();
    expect(screen.queryByText(/could not be loaded/)).not.toBeInTheDocument();
  });

  it("stays silent — not alarming — when the diagnostic itself fails to load", async () => {
    // A probe that cannot answer must never put a warning banner over a bank that loaded perfectly
    // well. Same isolation rule usePracticeData applies per section, one level up.
    renderSets(() => jsonResponse({ error: "boom" }, 500));

    expect(await screen.findByText("wri-healthy")).toBeInTheDocument();
    expect(screen.queryByText(/could not be loaded/)).not.toBeInTheDocument();
  });
});
