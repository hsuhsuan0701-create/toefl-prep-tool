import crypto from "node:crypto";
import { Hono } from "hono";
import { z } from "zod";
import {
  FULL_TEST_SECTION_ORDER,
  type FullTestRunStatus,
  type FullTestRunVM,
  type FullTestSection,
  type FullTestSectionState,
  type FullTestSectionVM,
  type TranscriptionJobStatus,
} from "@toefl-prep/shared";
import { config } from "../lib/config.js";
import { sqliteTimestamp, sqliteTimestampToIso, type SqliteTimestamp } from "../db/timestamps.js";
import type { FullTestRunRow } from "../db/rows.js";
import type { AttemptReadStore } from "../services/attemptStore.js";
import { listSets } from "./sets.js";
import { supersededSetIds as currentSupersededSetIds } from "../services/supersession.js";
import {
  RUNNABLE_FULL_TEST_SECTIONS,
  deriveFullTestOverall,
  fullTestSectionBand,
  fullTestSectionState,
  isTerminalSectionState,
  launchableFullTestSection,
  pickFullTestSets,
  type SelectableSet,
} from "../services/fullTestRun.js";
import { computeSectionEstimate, readPersistedEstimate, type EstimateReadStore } from "../services/sectionEstimates.js";
import { pageParam, toScoringJobVM } from "./attemptViewModels.js";
import type { ScoringJobStore } from "../services/scoringJobs.js";
import type { TranscriptionJobStore } from "../services/transcriptionRecovery.js";

// Full-Test Runs: four linked Simulation Attempts in ETS order under one report.
//
// What this route deliberately does not do:
//   - It never creates an Attempt. Each section's own Simulation does that through POST
//     /api/attempts, naming the Run in the body (checked by checkFullTestLink); this route only
//     reads the link back. A Simulation's start path is therefore the same request inside a Run as
//     outside one, plus one field.
//   - It never scores anything and stores no band. Each section's band is the one its own Attempt
//     persisted. The Run's Overall is derived on every read (deriveFullTestOverall), because a Run
//     completes at Speaking's capture-finished marker with that section's Judges (and often
//     Writing's) still running, so a band stored at completion would come from an unscored Run.

/**
 * The `full_test_runs` aggregate, declared as exactly the members this route uses. Its one adapter
 * is db/stores/fullTests.ts, and the route's tests run against it, because what they check is SQL:
 * the completion guard, the pacing flag, the ordering Set selection relies on.
 *
 * `completeFullTestRun` is a one-way writer: `WHERE status='in-progress'` with
 * `COALESCE(completed_at, ?)`, so a repeated hand-off can neither move a finished Run's timestamp
 * nor revive an abandoned one, and it reports whether this call completed the Run.
 * `lastAttemptStartedAtBySetId` returns space-form UTC strings that Set selection sorts, so the
 * `attempts.started_at` convention must hold for that order to be chronological.
 */
export type FullTestRunStore = {
  createFullTestRun(r: {
    id: string;
    currentSection: FullTestSection;
    setIds: Partial<Record<FullTestSection, string | null>>;
    createdAt?: SqliteTimestamp;
  }): void;
  getFullTestRun(id: string): FullTestRunRow | undefined;
  listFullTestRuns(q?: { limit?: number; status?: FullTestRunStatus }): FullTestRunRow[];
  listFullTestSetIds(): string[];
  linkFullTestAttempt(runId: string, section: FullTestSection, attemptId: string): boolean;
  setFullTestCurrentSection(runId: string, section: FullTestSection | null): boolean;
  completeFullTestRun(runId: string, now?: SqliteTimestamp): boolean;
  lastAttemptStartedAtBySetId(): Map<string, string>;
};

/**
 * What this route needs in full: its own aggregate, plus the four reads a section's state and band
 * status are derived from (the Attempt sitting it, that Attempt's active scoring jobs and current
 * transcription jobs, its persisted Band Estimate), each borrowed from the port of the module that
 * owns it. The estimate half is `EstimateReadStore`, so this route cannot write an estimate.
 */
export type FullTestStore =
  FullTestRunStore & Pick<AttemptReadStore, "getAttempt"> & Pick<ScoringJobStore, "listActiveJobs">
  & Pick<TranscriptionJobStore, "getCurrentTranscriptionJobs"> & EstimateReadStore;

/**
 * What `checkFullTestLink` alone reads. Separate from `FullTestStore` because POST /api/attempts
 * calls it with its own store, which should not have to carry the Run's writers for one link check.
 */
export type FullTestLinkCheckStore =
  Pick<FullTestRunStore, "getFullTestRun"> & Pick<AttemptReadStore, "getAttempt">;

type Repo = FullTestStore;

export type FullTestsDeps = {
  repo: Repo;
  /**
   * The Set bank a new Run draws its four Sets from; defaults to the practice-set listing, which
   * already drops superseded Sets. Injectable so tests can assert the selection rules against a
   * known bank rather than the shared test data directory.
   */
  listSetBank?: () => readonly SelectableSet[];
};

const SectionOverridesSchema = z
  .object({
    reading: z.string().min(1).optional(),
    listening: z.string().min(1).optional(),
    writing: z.string().min(1).optional(),
    speaking: z.string().min(1).optional(),
  })
  .strict();

const CreateFullTestSchema = z
  .object({
    // Optional per-section Set choices. Each named Set is validated against the bank and the
    // section's kind below; anything unnamed is drawn from the bank by pickFullTestSets.
    sets: SectionOverridesSchema.optional(),
  })
  .strict();

// Column accessors keyed by section, so the four sections stay one loop rather than four hand-copied
// blocks that can drift.
const ATTEMPT_ID_COLUMN = {
  reading: "reading_attempt_id",
  listening: "listening_attempt_id",
  writing: "writing_attempt_id",
  speaking: "speaking_attempt_id",
} as const satisfies Record<FullTestSection, keyof FullTestRunRow>;

const SET_ID_COLUMN = {
  reading: "reading_set_id",
  listening: "listening_set_id",
  writing: "writing_set_id",
  speaking: "speaking_set_id",
} as const satisfies Record<FullTestSection, keyof FullTestRunRow>;

type SectionAttempt = NonNullable<ReturnType<Repo["getAttempt"]>>;

/**
 * The Attempt sitting each section, or undefined where none has been created yet. One read of all
 * four, because the section states are decided together and the view model needs more off each row
 * than its state (`module_path`, for the report's Module Path disclosure).
 */
function sectionAttempts(
  repo: Pick<FullTestLinkCheckStore, "getAttempt">,
  row: FullTestRunRow,
): Record<FullTestSection, SectionAttempt | undefined> {
  return Object.fromEntries(
    FULL_TEST_SECTION_ORDER.map((section) => {
      const attemptId = row[ATTEMPT_ID_COLUMN[section]] as string | null;
      return [section, attemptId ? repo.getAttempt(attemptId) : undefined];
    }),
  ) as Record<FullTestSection, SectionAttempt | undefined>;
}

/** Every section's state, derived from the Attempt sitting it (fullTestSectionState). */
function statesOf(
  attempts: Record<FullTestSection, SectionAttempt | undefined>,
): Record<FullTestSection, FullTestSectionState> {
  return Object.fromEntries(
    FULL_TEST_SECTION_ORDER.map((section) => [section, fullTestSectionState(attempts[section])]),
  ) as Record<FullTestSection, FullTestSectionState>;
}

function sectionStates(
  repo: FullTestLinkCheckStore,
  row: FullTestRunRow,
): Record<FullTestSection, FullTestSectionState> {
  return statesOf(sectionAttempts(repo, row));
}

/**
 * The status of each Item's current transcription job: the newest one not superseded (the rows come
 * oldest first), as the Attempt review's transcription snapshot reads it.
 */
function currentTranscriptionStatuses(repo: Pick<Repo, "getCurrentTranscriptionJobs">, attemptId: string): TranscriptionJobStatus[] {
  const newest = new Map<string, TranscriptionJobStatus>();
  for (const job of repo.getCurrentTranscriptionJobs(attemptId)) newest.set(job.item_id, job.status as TranscriptionJobStatus);
  return [...newest.values()];
}

/**
 * The one place a Run row becomes a response. Every section's state is derived here from its linked
 * Attempt, and both timestamps leave through `sqliteTimestampToIso`.
 */
export function toFullTestRunVM(repo: Repo, row: FullTestRunRow): FullTestRunVM {
  const attempts = sectionAttempts(repo, row);
  const states = statesOf(attempts);
  // Exactly one section of an in-progress Run may be started, derived from the four Attempts rather
  // than from `current_section`: the cursor lags the sitting whenever a hand-off POST is lost, and
  // gating on it would refuse the section the User actually has to sit next.
  const launchable = row.status === "in-progress" ? launchableFullTestSection(states) : null;

  const sections: FullTestSectionVM[] = FULL_TEST_SECTION_ORDER.map((section, i) => {
    const attemptId = row[ATTEMPT_ID_COLUMN[section]] as string | null;
    const state = states[section];
    const attempt = attempts[section];
    // The band is the same read (readPersistedEstimate) the Attempt review and the finalization
    // responses use, so a section's band, method and coverage read identically here and on that
    // section's own report. Whether it is shown at all is the band status: withheld while scoring is
    // outstanding, and replaced by what is missing when there is none (fullTestSectionBand).
    const { bandStatus, estimate } = fullTestSectionBand({
      state,
      attempt,
      activeJobs: attempt ? repo.listActiveJobs(attempt.id).map(toScoringJobVM) : [],
      transcriptionStatuses: attempt ? currentTranscriptionStatuses(repo, attempt.id) : [],
      persisted: state === "completed" && attemptId ? readPersistedEstimate(repo, attemptId) : null,
      computed: attempt ? computeSectionEstimate(attempt) : { status: "not-applicable" },
    });
    const setId = (row[SET_ID_COLUMN[section]] as string | null) ?? null;
    return {
      section,
      order: i + 1,
      setId,
      attemptId,
      state,
      runnable: RUNNABLE_FULL_TEST_SECTIONS.has(section),
      // A section with no Set cannot be sat. Creation refuses a Run missing any section's Set, so
      // this only guards older rows that were allowed to lack one.
      launchable: section === launchable && RUNNABLE_FULL_TEST_SECTIONS.has(section) && setId !== null,
      bandStatus,
      estimate,
      modulePath: attempts[section]?.module_path ?? null,
    };
  });

  return {
    id: row.id,
    status: row.status as FullTestRunStatus,
    currentSection: row.current_section,
    createdAt: sqliteTimestampToIso(row.created_at),
    completedAt: sqliteTimestampToIso(row.completed_at),
    sections,
    // Derived from the four sections just read, never stored. Computed for every Run, not only
    // completed ones: a Run mid-sitting reports its unfinished sections as pending. Which Runs show
    // a report is the client's call.
    overall: deriveFullTestOverall(sections),
  };
}

/**
 * Whether an Attempt may be linked to `section` of this Run, and the status and error when it may
 * not. POST /api/attempts performs the link; the rule lives here, with the Run.
 */
export function checkFullTestLink(
  repo: FullTestLinkCheckStore,
  runId: string,
  section: FullTestSection,
  setId: string,
  mode: string,
): { ok: true; run: FullTestRunRow } | { ok: false; status: 404 | 409 | 400; error: string } {
  // Every section of a Run is a Simulation, sat under exam constraints. A Drill linked in would stand
  // in the Run for a sitting that never happened (a Reading or Listening Drill never has a band at
  // all), and once completed it could never be replaced.
  if (mode !== "simulation") return { ok: false, status: 400, error: "a full test run section must be a simulation" };
  const run = repo.getFullTestRun(runId);
  if (!run) return { ok: false, status: 404, error: "unknown full test run" };
  if (run.status !== "in-progress") return { ok: false, status: 409, error: "full test run is not in progress" };
  if (!RUNNABLE_FULL_TEST_SECTIONS.has(section)) {
    return { ok: false, status: 409, error: `the ${section} section cannot be sat inside a full test run yet` };
  }
  const expectedSetId = run[SET_ID_COLUMN[section]] as string | null;
  if (expectedSetId !== setId) {
    // The Run drew this section's Set at creation and it never changes; sitting a different one
    // would make the Run's record of what was sat false.
    return { ok: false, status: 400, error: `this full test run's ${section} section uses a different Set` };
  }
  const states = sectionStates(repo, run);
  if (states[section] === "completed") {
    return { ok: false, status: 409, error: `the ${section} section of this full test run is already complete` };
  }
  // The exam's order, enforced where an Attempt is created rather than only in the UI that offers
  // the button. Anything but the one launchable section (one whose predecessors are unfinished, or
  // one the Run has moved past) is refused.
  const launchable = launchableFullTestSection(states);
  if (launchable !== section) {
    return {
      ok: false,
      status: 409,
      error: launchable
        ? `this full test run is at the ${launchable} section`
        : "this full test run has no section left to sit",
    };
  }
  // An in-progress Attempt already linked to this section is replaced rather than refused: that is
  // a section restarted after a reload, and the Run follows the Attempt actually being sat. The old
  // Attempt keeps its row; it stops being the one this Run points at. An aborted one is never
  // replaced, because an aborted section is terminal and launchableFullTestSection has moved past it.
  return { ok: true, run };
}

function defaultSetBank(): readonly SelectableSet[] {
  return listSets(config.dataDir, currentSupersededSetIds());
}

const FULL_TEST_RUN_STATUSES: readonly FullTestRunStatus[] = ["in-progress", "completed", "abandoned"];

// The most Runs one GET / may ask for.
const FULL_TEST_PAGE_MAX = 50;

/** `/api/full-tests`: create, list, read and advance Full-Test Runs. */
export function buildFullTestRoutes(deps: FullTestsDeps) {
  return new Hono()
    .post("/", async (c) => {
      let body: unknown = {};
      if (c.req.header("content-type")?.includes("application/json")) {
        try {
          body = await c.req.json();
        } catch {
          return c.json({ error: "invalid JSON" }, 400);
        }
      }
      const parsed = CreateFullTestSchema.safeParse(body ?? {});
      if (!parsed.success) return c.json({ error: parsed.error.message }, 400);

      const bank = (deps.listSetBank ?? defaultSetBank)();

      // Overrides are validated against the BANK, not against the raw file on disk: a Set that has
      // been superseded has left the picker, and a Run must not be the one surface that can still
      // draw it.
      const overrides = parsed.data.sets ?? {};
      for (const section of FULL_TEST_SECTION_ORDER) {
        const overrideId = overrides[section];
        if (!overrideId) continue;
        const set = bank.find((s) => s.id === overrideId);
        if (!set) return c.json({ error: `unknown or unavailable set for the ${section} section` }, 400);
        if (set.kind !== section) return c.json({ error: `set kind mismatch for the ${section} section` }, 400);
      }

      const selection = pickFullTestSets({
        sets: bank,
        lastAttemptedAt: deps.repo.lastAttemptStartedAtBySetId(),
        claimedSetIds: new Set(deps.repo.listFullTestSetIds()),
        overrides,
      });

      // A Run missing any section's Set could never be finished: it would stop at that section with
      // no Attempt to create and no way to advance. Refused at creation, naming every kind that
      // needs generating, rather than discovered partway through the sitting.
      const missing = FULL_TEST_SECTION_ORDER.filter((section) => !selection[section]);
      if (missing.length > 0) {
        return c.json(
          { error: `no Set available for the ${missing.join(", ")} section${missing.length > 1 ? "s" : ""} — generate one first` },
          400,
        );
      }

      const id = crypto.randomUUID();
      deps.repo.createFullTestRun({
        id,
        currentSection: FULL_TEST_SECTION_ORDER[0],
        setIds: selection,
        createdAt: sqliteTimestamp(),
      });
      const row = deps.repo.getFullTestRun(id);
      if (!row) return c.json({ error: "internal error" }, 500);
      return c.json(toFullTestRunVM(deps.repo, row), 201);
    })
    .get("/", (c) => {
      // No usable `limit` leaves the page size to the store: 20 Runs, or every Run of a status.
      const limit = pageParam(c.req.query("limit"), undefined, 1, FULL_TEST_PAGE_MAX);
      // `?status=in-progress` is how the practice page finds every Run still waiting to be resumed,
      // however many newer Runs exist. An unrecognised value lists every status.
      const rawStatus = c.req.query("status");
      const status = FULL_TEST_RUN_STATUSES.find((s) => s === rawStatus);
      return c.json(deps.repo.listFullTestRuns({ limit, status }).map((row) => toFullTestRunVM(deps.repo, row)));
    })
    .get("/:id", (c) => {
      const row = deps.repo.getFullTestRun(c.req.param("id"));
      if (!row) return c.json({ error: "unknown full test run" }, 404);
      return c.json(toFullTestRunVM(deps.repo, row));
    })
    // The section hand-off. Called once the current section's Attempt is terminal; moves the Run's
    // cursor to wherever the four Attempts say the sitting is, or completes the Run when nothing is
    // left to sit. It does not create the next section's Attempt: that section's own Simulation
    // does, when the User starts it.
    //
    // The destination is launchableFullTestSection over the derived states, not current+1. Hand-off
    // POSTs are best-effort, so the cursor can lag the sitting by more than one section (Speaking is
    // still sat after Writing's hand-off is lost, because linking never reads the cursor). A one-step
    // advance would then spend Speaking's own hand-off catching up, and nothing would be left to
    // complete the Run, leaving a fully-sat Run in progress forever. Jumping to the derived position
    // lets any later advance, a section's own or the Run page's, repair the whole lag in one call.
    //
    // A repeated call finds the current section not yet finished (the Run has already moved on) and
    // answers 409 rather than skipping a second section; on a completed Run the status check refuses
    // it. A caller that only wants the state should GET the Run.
    //
    // It reads no body.
    .post("/:id/advance", (c) => {
      const row = deps.repo.getFullTestRun(c.req.param("id"));
      if (!row) return c.json({ error: "unknown full test run" }, 404);
      if (row.status !== "in-progress") return c.json({ error: "full test run is not in progress" }, 409);

      const current = row.current_section;
      if (!current) return c.json({ error: "full test run has no current section" }, 409);

      const states = sectionStates(deps.repo, row);
      const state = states[current];
      if (!isTerminalSectionState(state)) {
        return c.json({ error: `the ${current} section is not finished`, sectionState: state }, 409);
      }

      // The first section still to sit, in ETS order: the same derived answer that gates the start
      // button and the Attempt link, so the cursor lands where the Run actually is even when earlier
      // hand-offs were lost.
      const next = launchableFullTestSection(states);
      if (!next) {
        // Nothing left to sit: the Run completes, `current_section` is cleared and `completed_at`
        // stamped. No band is stored; the Overall is derived on every read.
        deps.repo.completeFullTestRun(row.id);
      } else {
        deps.repo.setFullTestCurrentSection(row.id, next);
      }

      const fresh = deps.repo.getFullTestRun(row.id);
      if (!fresh) return c.json({ error: "internal error" }, 500);
      return c.json(toFullTestRunVM(deps.repo, fresh));
    });
}
