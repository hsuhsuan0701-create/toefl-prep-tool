import { afterEach, describe, expect, it, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import SetSection from "../src/components/SetSection";
import AttemptsFeed from "../src/components/AttemptsFeed";
import { PRACTICE_SECTIONS, SECTION_ROUTES, usePracticeData } from "../src/hooks/usePracticeData";
import Progress from "../src/pages/Progress";

// usePracticeData fetches the four Set lists and the recent-Attempts feed; the components below are
// how every page consumes it. This harness is the same wiring the real pages use, so the isolation
// guarantee is pinned to the code that implements it.
function PracticeHarness() {
  const practice = usePracticeData();
  return (
    <>
      {PRACTICE_SECTIONS.map((section) => (
        <SetSection
          key={section}
          title={`${SECTION_ROUTES[section].label} sets`}
          linkBase={SECTION_ROUTES[section].linkBase}
          simulateHref={SECTION_ROUTES[section].simulateHref}
          sets={practice.sets[section]}
          error={practice.errors[section]}
        />
      ))}
      <AttemptsFeed attempts={practice.attempts} error={practice.errors.attempts} onChanged={practice.reload} />
    </>
  );
}

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

function setMeta(id: string, kind: string) {
  return { id, kind, source: "generated", createdAt: "2026-01-01T00:00:00.000Z", title: `Title ${id}`, summary: null, attempted: false };
}

afterEach(() => vi.unstubAllGlobals());

// The four Set lists settle independently (`Promise.allSettled`) and the Attempt feed is a request
// of its own, so one failed request degrades only its own section; the others must not stay on
// "Loading…".
describe("usePracticeData — one failed listSets must not blank the other sections", () => {
  it("still renders Writing/Speaking/Reading sets and the recent-attempts feed when ONLY Listening's listSets rejects, and Listening reports its own failure", async () => {
    vi.stubGlobal(
      "fetch",
      fetchStub({
        "sets?kind=writing": () => jsonResponse([setMeta("wri-1", "writing")]),
        "sets?kind=speaking": () => jsonResponse([setMeta("spk-1", "speaking")]),
        "sets?kind=reading": () => jsonResponse([setMeta("rd-1", "reading")]),
        "sets?kind=listening": () => Promise.reject(new Error("network down")),
        "/api/attempts": () => jsonResponse({ items: [], total: 0 }),
      }),
    );

    render(
      <MemoryRouter>
        <PracticeHarness />
      </MemoryRouter>,
    );

    // The three healthy set sections load normally — none of them stayed stuck on "Loading…".
    expect(await screen.findByText("Title wri-1")).toBeInTheDocument();
    expect(await screen.findByText("Title spk-1")).toBeInTheDocument();
    expect(await screen.findByText("Title rd-1")).toBeInTheDocument();
    // The recent-Attempts feed settled too.
    expect(await screen.findByText("No Attempts yet")).toBeInTheDocument();

    // Only Listening's own section reports a failure: it never stays loading forever, and no other
    // section is dragged into an error state by Listening's rejection.
    expect(await screen.findByText("Couldn't load this list")).toBeInTheDocument();
    expect(screen.getAllByText("Couldn't load this list")).toHaveLength(1);
    expect(screen.getByText(/network down/)).toBeInTheDocument();
    expect(document.querySelector('[aria-busy="true"]')).toBeNull();
  });
});

describe("/progress renders no Sets, so it must not pull the Set banks", () => {
  // `listSets` is not a cheap read: routes/sets.ts parses every Set file in the bank on every call,
  // whatever `kind` asks for. Progress displays no Sets, so fetching the four lists there would cost
  // four full passes over the bank for data the page throws away. Asserted on the page, not on the
  // hook, because the failure is a page reaching for the wrong hook.
  it("requests only the attempt log, the summary and the trends", async () => {
    const fetchMock = fetchStub({
      "sets?kind=": () => jsonResponse([]),
      "/api/attempts": () => jsonResponse({ items: [], total: 0 }),
      "/api/stats/summary": () =>
        jsonResponse({
          overall: { band: 5 },
          sections: [],
          weaknesses: [],
          judgeAgreement: { avgDelta: null, sampleSize: 0 },
          skillItems: [],
          skillItemsLimit: 300,
        }),
      "/api/stats/trends": () => jsonResponse([]),
    });
    vi.stubGlobal("fetch", fetchMock);

    render(
      <MemoryRouter>
        <Progress />
      </MemoryRouter>,
    );

    expect(await screen.findByText("No Attempts yet")).toBeInTheDocument();
    const urls = (fetchMock as unknown as { mock: { calls: [string][] } }).mock.calls.map(([url]) => String(url));
    expect(urls.some((url) => url.includes("/api/attempts"))).toBe(true);
    expect(urls.filter((url) => url.includes("/api/sets"))).toEqual([]);
  });
});
