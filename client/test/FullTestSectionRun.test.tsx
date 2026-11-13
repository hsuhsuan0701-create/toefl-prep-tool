import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { fireEvent, screen, waitFor } from "@testing-library/react";
import { renderRoutes, unload } from "./dataRouter";
import type { FullTestRunVM, FullTestSection, FullTestSectionVM } from "@toefl-prep/shared";
import FullTestSectionRun from "../src/pages/FullTestSectionRun";

// The section route is the seam between a Full-Test Run and the section's own Simulation. What it
// must get right is small and load-bearing: the right Simulation is mounted for the section, it is
// handed the Set the Run drew (never one it picks for itself), and the Attempt it creates names the
// Run. Everything else about each Simulation is the same as when it runs on its own, so nothing else
// is asserted here; each section's behaviour over real Items has its own test
// ({Reading,Listening,Writing,Speaking}Simulation.test.tsx), which drives the standalone path.

// The Speaking section's mic check needs a real microphone; this file only needs its gate to open,
// with the same stand-in SpeakingSimulation.test.tsx uses.
vi.mock("../src/components/MicCheck", async () => {
  const { createElement } = await import("react");
  return {
    default: ({ onPass }: { onPass: () => void }) =>
      createElement("button", { type: "button", onClick: onPass }, "pass mic check"),
  };
});

const RUN_ID = "run-78";
const SET_IDS: Record<FullTestSection, string> = {
  reading: "rd-run78",
  listening: "lsn-run78",
  writing: "wri-run78",
  speaking: "spk-run78",
};

function section(over: Partial<FullTestSectionVM> & Pick<FullTestSectionVM, "section" | "order">): FullTestSectionVM {
  // The band status the server derives for a fixture like this one: a band when it has one, still
  // scoring when finished without one, otherwise not finished.
  const bandStatus: FullTestSectionVM["bandStatus"] = over.estimate
    ? { status: "estimated" }
    : over.state === "completed"
      ? { status: "scoring", outstanding: [] }
      : { status: "not-finished" };
  return {
    setId: SET_IDS[over.section],
    attemptId: null,
    state: "pending",
    runnable: true,
    // Only the first section is startable by default: the Run's order rule, as the server states it.
    launchable: over.section === "reading",
    estimate: null,
    modulePath: null,
    bandStatus,
    ...over,
  };
}

function runBody(readingOver: Partial<FullTestSectionVM> = {}, rest: Partial<FullTestRunVM> = {}): FullTestRunVM {
  return {
    id: RUN_ID,
    status: "in-progress",
    currentSection: "reading",
    createdAt: "2026-08-23T02:00:00.000Z",
    completedAt: null,
    sections: [
      section({ section: "reading", order: 1, ...readingOver }),
      section({ section: "listening", order: 2 }),
      section({ section: "writing", order: 3 }),
      section({ section: "speaking", order: 4 }),
    ],
    // What the server derives for a Run with no section band yet (deriveFullTestOverall).
    overall: {
      band: null,
      method: "mean-of-sections-v1",
      scoredSections: 0,
      pendingSections: ["reading", "listening", "writing", "speaking"],
    },
    ...rest,
  };
}

/** A Run sitting at `section`: everything before it complete, everything after it pending. */
function runAt(at: FullTestSection): FullTestRunVM {
  const order: FullTestSection[] = ["reading", "listening", "writing", "speaking"];
  const idx = order.indexOf(at);
  return {
    ...runBody(),
    currentSection: at,
    sections: order.map((s, i) =>
      section({
        section: s,
        order: i + 1,
        state: i < idx ? "completed" : "pending",
        attemptId: i < idx ? `att-${s}` : null,
        launchable: i === idx,
      }),
    ),
  };
}

// Sets with no Stimuli/Items at all: this file asserts the wiring around each Simulation, not the
// Simulation's own behaviour over real content. Only the fields each intro screen actually reads
// need to be here.
const PUBLIC_SETS: Record<FullTestSection, Record<string, unknown>> = {
  reading: {
    id: SET_IDS.reading,
    kind: "reading",
    router: { timeLimitSec: 1200, ctwPassages: [], dailyLife: [], academic: [] },
    lowerModule: { timeLimitSec: 540, ctwPassages: [], dailyLife: [], academic: [] },
    upperModule: { timeLimitSec: 540, ctwPassages: [], dailyLife: [], academic: [] },
  },
  listening: {
    id: SET_IDS.listening,
    kind: "listening",
    router: { timeLimitSec: 600, listenChoose: [], conversations: [], announcements: [], academicTalks: [] },
    lowerModule: { timeLimitSec: 600, listenChoose: [], conversations: [], announcements: [], academicTalks: [] },
    upperModule: { timeLimitSec: 600, listenChoose: [], conversations: [], announcements: [], academicTalks: [] },
  },
  writing: {
    id: SET_IDS.writing,
    kind: "writing",
    // One Item, because the Writing Simulation's first running stage renders the Item at the
    // pooled run's index — an empty Task would be a state its own reducer never produces.
    buildASentence: {
      items: [{ id: "bs-1", prompt: "Describe the museum visit.", frame: "The ___ ___ wonderful.", tiles: ["volunteers", "was"] }],
    },
    email: { id: "email-1", timeLimitSec: 420 },
    academicDiscussion: { id: "disc-1", timeLimitSec: 600 },
  },
  speaking: {
    id: SET_IDS.speaking,
    kind: "speaking",
    listenAndRepeat: { scenarioTitle: "A clinic", scenarioDescription: "Checking in", items: [] },
    interview: { scenarioTitle: "An interview", intro: "Hello", questions: [] },
  },
};

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
}

function renderSection(run: FullTestRunVM, sectionPath = "reading", respond?: (url: string) => Response | undefined) {
  const calls: { url: string; init?: RequestInit }[] = [];
  const fetchMock = vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === "string" ? input : input.toString();
    calls.push({ url, init });
    const answer = respond?.(url);
    if (answer) return Promise.resolve(answer);
    if (url.includes(`/api/full-tests/${RUN_ID}`)) return Promise.resolve(jsonResponse(run));
    const served = Object.values(PUBLIC_SETS).find((s) => url.includes(`/api/sets/${String(s.id)}`));
    if (served) return Promise.resolve(jsonResponse(served));
    if (url.includes("/api/attempts?")) return Promise.resolve(jsonResponse([]));
    if (url.includes("/api/attempts")) return Promise.resolve(jsonResponse({ attemptId: "att-1", isRepeat: false }, 201));
    throw new Error(`unhandled fetch in test: ${url}`);
  });
  vi.stubGlobal("fetch", fetchMock as unknown as typeof fetch);

  renderRoutes(
    [
      { path: "/full-test/:runId/:section", element: <FullTestSectionRun /> },
      { path: "/full-test/:runId", element: <p>run page</p> },
    ],
    `/full-test/${RUN_ID}/${sectionPath}`,
  );
  return { calls, fetchMock };
}

afterEach(() => vi.unstubAllGlobals());

// The route loads its section Simulation as a lazy chunk. Loading it once up front keeps that
// first import out of the first test's findBy timeout.
beforeAll(async () => {
  await import("../src/pages/simulation/ReadingSimulation");
  await import("../src/pages/simulation/ListeningSimulation");
  await import("../src/pages/simulation/WritingSimulation");
  await import("../src/pages/simulation/SpeakingSimulation");
});

describe("the full-test section route", () => {
  it("runs Reading on the Set the run drew, never one it picks for itself", async () => {
    const { calls } = renderSection(runBody());

    expect(await screen.findByRole("heading", { name: "Reading section" })).toBeInTheDocument();
    expect(screen.getByText(SET_IDS.reading)).toBeInTheDocument();
    // The standalone Simulation's own automatic picker (`GET /api/sets?kind=reading`) must never
    // run here: it would choose a different Set from the one the Run recorded.
    expect(calls.some((c) => c.url.includes("kind=reading"))).toBe(false);
  });

  // One case per section, because the failure this guards against is a dispatch that mounts the
  // wrong Simulation, which no amount of Reading coverage can catch.
  it.each([
    ["listening", /Listening section/, "paced by the audio"],
    ["writing", /Writing section/, "for the academic discussion post"],
    ["speaking", /Speaking section/, "Listen and Repeat sentences, then an Interview"],
  ] as const)("mounts the %s Simulation on the Set the run drew", async (name, heading, marker) => {
    const { calls } = renderSection(runAt(name), name);

    expect(await screen.findByRole("heading", { name: heading })).toBeInTheDocument();
    // Its own intro copy, so this is genuinely that section's Simulation and not a lookalike.
    expect(screen.getByText(new RegExp(marker))).toBeInTheDocument();
    expect(screen.getByText(new RegExp(SET_IDS[name]))).toBeInTheDocument();
    expect(calls.some((c) => c.url.includes(`kind=${name}`))).toBe(false);
    expect(calls.some((c) => c.url.includes(`/api/sets/${SET_IDS[name]}`))).toBe(true);
  });

  // The section is the same Simulation as on its own, guard included: leaving a running section of
  // a Full-Test Run asks first, whether by reload or by the browser's Back.
  it("asks before leaving a running section of the Run", async () => {
    renderSection(runBody());
    expect(unload()).toBe(false);

    fireEvent.click(await screen.findByRole("button", { name: "Start Reading Simulation" }));
    await screen.findByText("Router Module");
    expect(unload()).toBe(true);
  });

  it("names the run on the Attempt it creates, and changes nothing else about the request", async () => {
    const { calls } = renderSection(runBody());

    fireEvent.click(await screen.findByRole("button", { name: "Start Reading Simulation" }));

    await waitFor(() => {
      const post = calls.find((c) => c.init?.method === "POST" && c.url.includes("/api/attempts"));
      expect(post).toBeDefined();
      expect(JSON.parse(String(post!.init!.body))).toEqual({
        kind: "reading",
        mode: "simulation",
        setId: SET_IDS.reading,
        fullTestRunId: RUN_ID,
      });
    });
  });

  // The same one field, from each of the other three sections' own start paths.
  it.each(["listening", "writing"] as const)(
    "names the run on the Attempt the %s Simulation creates",
    async (name) => {
      const { calls } = renderSection(runAt(name), name);

      fireEvent.click(
        await screen.findByRole("button", { name: name === "listening" ? "Start Listening Simulation" : "Start Writing Simulation" }),
      );

      await waitFor(() => {
        const post = calls.find((c) => c.init?.method === "POST" && c.url.includes("/api/attempts"));
        expect(post).toBeDefined();
        expect(JSON.parse(String(post!.init!.body))).toEqual({
          kind: name,
          mode: "simulation",
          setId: SET_IDS[name],
          fullTestRunId: RUN_ID,
        });
      });
    },
  );

  // Speaking's start path is behind its own mic check and Ready gate. They stay inside the Speaking
  // Simulation rather than moving up to the Run, so the section runs as it does on its own.
  it("names the run on the Attempt the speaking Simulation creates, behind its own mic check", async () => {
    const { calls } = renderSection(runAt("speaking"), "speaking");

    fireEvent.click(await screen.findByRole("button", { name: "Check your microphone" }));
    fireEvent.click(screen.getByRole("button", { name: "pass mic check" }));
    fireEvent.click(screen.getByRole("button", { name: "Start Speaking Simulation" }));

    await waitFor(() => {
      const post = calls.find((c) => c.init?.method === "POST" && c.url.includes("/api/attempts"));
      expect(post).toBeDefined();
      expect(JSON.parse(String(post!.init!.body))).toEqual({
        kind: "speaking",
        mode: "simulation",
        setId: SET_IDS.speaking,
        fullTestRunId: RUN_ID,
      });
    });
  });

  // A section left part-way and started again replaces the Attempt the Run records, and POST
  // /api/attempts gives the new one that Attempt's tag. The listing marks the Set attempted as soon
  // as the replaced Attempt holds a scored Item, so the intro's caution must follow the replaced
  // Attempt, as the server does, or a first sitting is announced as a Repeat.
  describe("a restarted section's Repeat notice follows the Attempt it replaces", () => {
    const START: Record<FullTestSection, RegExp> = {
      reading: /Reading section/,
      listening: /Listening section/,
      writing: /Writing section/,
      speaking: /Speaking section/,
    };

    function restartAt(at: FullTestSection): FullTestRunVM {
      const run = runAt(at);
      return {
        ...run,
        sections: run.sections.map((s) => (s.section === at ? { ...s, state: "in-progress", attemptId: `att-old-${at}` } : s)),
      };
    }

    /** The Set listing (which marks the Run's Set attempted) and the replaced Attempt, tagged `isRepeat`. */
    function responder(at: FullTestSection, isRepeat: boolean) {
      return (url: string): Response | undefined => {
        if (url === "/api/sets") {
          return jsonResponse([
            { id: SET_IDS[at], kind: at, source: "generated", createdAt: "2026-08-20T00:00:00.000Z", title: "The Run's Set", summary: null, attempted: true },
          ]);
        }
        if (url.endsWith(`/api/attempts/att-old-${at}`)) {
          return jsonResponse({
            attempt: {
              id: `att-old-${at}`, kind: at, mode: "simulation", setId: SET_IDS[at], setTitle: "The Run's Set", isRepeat,
              status: "in_progress", startedAt: "2026-08-23T02:00:00.000Z", completedAt: null, captureFinishedAt: null, flagged: false,
            },
            items: [], judgeReports: [], estimate: null, bandStatus: { status: "unfinished" }, activeJobs: [],
          });
        }
        return undefined;
      };
    }

    it.each(["reading", "listening", "writing", "speaking"] as const)(
      "%s: no Repeat caution when the replaced Attempt was a first sitting",
      async (name) => {
        renderSection(restartAt(name), name, responder(name, false));
        expect(await screen.findByRole("heading", { name: START[name] })).toBeInTheDocument();
        expect(screen.getByText(/The Run's Set/)).toBeInTheDocument();
        expect(screen.queryByText(/this Attempt is a Repeat/)).toBeNull();
      },
    );

    it.each(["reading", "listening", "writing", "speaking"] as const)(
      "%s: the Repeat caution stays when the replaced Attempt was a Repeat",
      async (name) => {
        renderSection(restartAt(name), name, responder(name, true));
        expect(await screen.findByRole("heading", { name: START[name] })).toBeInTheDocument();
        expect(screen.getByText(/this Attempt is a Repeat/)).toBeInTheDocument();
      },
    );

    it("a section sat for the first time in the Run still reads the listing", async () => {
      renderSection(runAt("listening"), "listening", responder("listening", false));
      expect(await screen.findByRole("heading", { name: START.listening })).toBeInTheDocument();
      expect(screen.getByText(/this Attempt is a Repeat/)).toBeInTheDocument();
    });
  });

  it("refuses to re-sit a section that is already finished", async () => {
    renderSection(runBody({ state: "completed", attemptId: "att-1", launchable: false }));

    expect(await screen.findByText(/already finished/i)).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Start Reading Simulation" })).toBeNull();
  });

  // Order enforcement, at the route rather than only at the button: a hand-typed URL for a later
  // section must not walk the User into the server's own refusal after an intro screen.
  it("refuses a section the run has not reached yet", async () => {
    renderSection(runBody(), "speaking");
    expect(await screen.findByText(/not at this section yet/i)).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Start Writing Simulation" })).toBeNull();
  });
});
