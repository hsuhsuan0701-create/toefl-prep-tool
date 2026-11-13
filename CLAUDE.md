# TOEFL Prep Tool

A local practice app for the TOEFL iBT 2026 format: Drills, Simulations and Full-Test Runs for all
four sections. Speaking and Writing are scored by two model Judges and an Arbiter; Reading and
Listening are scored from the answer key. Every band is an unofficial estimate.

- Vocabulary: `CONTEXT.md`. Use its terms exactly, in code, tests, comments and issues.
- Map: `docs/architecture.md`. Decisions: `docs/adr/`. UI rules: `docs/design-system.md`.
  Contributor conventions: `.github/CONTRIBUTING.md`.
- Workspaces: `shared` (zod schemas, the single source of truth for every shape; imported as
  `@toefl-prep/shared`), `server` (Hono, :8787), `client` (Vite + React, :5173, proxies `/api`).
- Node 24 (`.nvmrc`). `npm start`, `dev`, `test` and `demo` refuse another major version.

## Commands

- `npm start`: build the client and serve both sides; use it for practice. `npm run dev`: watch
  mode, which restarts the server on every save.
- Done means `npm test && npm run typecheck && npm run build -w client && npm run lint -w client`,
  the four steps CI runs. `npm test` runs both workspaces, and the client suite is the only coverage
  of the browser layer.
- One server test: `npx vitest run test/<file>.test.ts` from `server/`.
- A job's model calls: `sqlite3 data/db.sqlite "select ri.operation,pe.provider,pe.outcome,ri.context_detail from route_invocations ri join provider_executions pe on pe.route_invocation_id=ri.id where ri.context_id='<jobId>' order by ri.queued_at_ms,pe.sequence"`.

## Invariants

Each is a rule, its reason, and what enforces it. Changing one means changing its test, and its ADR
when it records a decision.

### Scoring and estimates

- A Band Estimate exists only when every Item of the Attempt is scored (a skip is a scored 0) and
  every Task Type its section needs has an Item. For Reading and Listening, each Module the Attempt
  took (the Router Module and the one its Module Path names) needs an Item, tagged with that Module
  in `score_json`, of every Task Type its composition carries, and the band counts those Modules'
  Items only. A failed, pending, untranscribed or never-captured Item means no band, and nothing is
  spread or left out. The read side decides from the Attempt's current Items, so rows persisted
  under an older rule stop surfacing (`bandShortfall`, ADR 0010). `bandWholeSitting.test.ts`,
  `sectionEstimates.test.ts`, `estimatesStore.coverage.test.ts`, `bankedRoutedSittings.test.ts`.
- The Overall is ETS's mean-then-round over four real Band Estimates, and absent otherwise: a mean of
  fewer is a different number. Every section has a Target, and a Target never stands in for a
  missing band (ADR 0015). `routes.stats.honesty.test.ts`, `routes.fullTests.bandStatus.test.ts`.
- Estimate methods are versioned strings (`linear-v2`, `table3-v1`, `mean-of-sections-v1`). A
  persisted estimate keeps its method; a formula change is a new method. `routes.stats.test.ts`.
- Only a routed Simulation produces a Reading or Listening band (ADR 0005).
  `routes.attempts.reading.test.ts`.
- A Repeat is an Attempt on a Set that already has an Attempt with a scored Item, or a completed
  Attempt holding at least one Item. It never becomes a headline band. A restarted Full-Test section
  keeps the tag of the Attempt it replaces, and discards that Attempt in the same transaction
  (`openFullTestSectionAttempt` in `db/stores/fullTests.ts`). `routes.attempts.repeat.test.ts`,
  `routes.fullTests.test.ts`.
- A recording with no speech scores a deterministic 0 and never reaches a Judge.
  `noSpeechScoring.test.ts`.
- An Email or Academic Discussion with no words (empty once whitespace is trimmed,
  `essayHasNoWords` in `shared/src/schemas/scoring.ts`) scores a deterministic 0 marked
  `noWordsWritten` and never reaches a Judge or the Arbiter, on a first scoring and a Re-score
  alike; a single word is an essay and is judged. The editor (`TimedEditor`) asks before Submit
  hands one in; the clock running out never asks (ADR 0018). `noWordsEssayScoring.test.ts`,
  `WritingDrill.test.tsx`, `WritingSimulation.test.tsx`, `AttemptReviewStates.test.tsx`.
- Score-bearing state (Item results, Score Reports, estimates, API responses, UI) names no provider.
  Two exceptions, and only these:
  - item-level `selfArbitrated`, set when Codex wrote both the OpenAI Judge Report and the
    arbitration: the UI discloses it and the score still counts;
  - a scoring job's progress while the job is queued or running (`GET
    /api/attempts/:id/score-jobs/:jobId`): `arbiterProvider`, `openaiJudgeProvider` and
    `fallbackFrom` let the UI say "Claude is arbitrating" or "Waiting for a slot with Claude". The
    write that ends the job removes them, and no progress write lands after it
    (`db/stores/scoring.ts`; migration 5 cleared the rows that ended earlier).

  Generation jobs carry no score and keep `provider` and `fallbackFrom` in their progress after they
  end, and no stage or progress write lands after a generation job ends (`db/stores/generation.ts`). Otherwise provider names live only in the diagnostic tables (ADR 0004).
  `routes.attempts.arbitration.test.ts`, `scoringJobs.terminalProgress.test.ts`.
- Band to CEFR is `cefrForBand` in `shared/src/cefr.ts`, derived where the band renders
  (`BandFigure`, `CefrLevelNote`) and never shipped as a second field, so a band and its level
  cannot disagree. `cefr.test.ts`.
- Rubric text lives only in `.claude/skills/*/references/`, in this project's own words. A local
  `references/official/<same name>` copy of ETS's text replaces a file when present and is never
  committed. The Judges and the Codex Arbiter resolve it in `skillReferences.ts`, the Claude Arbiter
  by its `SKILL.md` (ADR 0013). `skillReferences.test.ts`, `shippedRubrics.test.ts`; that no rubric
  text lives elsewhere is convention.

### Sets and answers

- `GET /api/sets/:id` is the only route Set content reaches the client through. It applies
  `stripAnswers` and re-draws the Build a Sentence tray per request (`tileScramble.ts`); scoring
  reads tile text from disk. A new served key path fails `servedSetTripwire.test.ts` until it is
  reviewed into its allow-list.
- A Simulation's score responses carry bare correctness; keys and Explanations reach the client
  only after the Attempt completes. Build a Sentence keeps its key in `score_json`, so
  `GET /api/attempts/:id` withholds it from a Simulation until then, and a Simulation scores each
  Build a Sentence Item once: an all-scored request is answered from the stored rows and writes
  nothing, a mixed one is refused. `routes.attempts.reading.test.ts`,
  `routes.attempts.listening.test.ts`, `routes.attempts.buildSentence.test.ts`.
- Until a Simulation is completed, its review shows each Response without a Correct or Incorrect
  mark or a correct-count tally (Reading, Listening and Build a Sentence alike), and the per-skill
  accuracy pane leaves out its Items. A Drill shows its marks as soon as an Item is scored, and a
  discarded Simulation shows its marks without the key. `AttemptReviewDeterministic.test.tsx`,
  `AttemptReview.test.tsx`, `routes.stats.test.ts`.
- A Simulation scores its Modules in order: Router Module Items only until it is routed, then only
  the Module it was routed to (409 otherwise). `routes.attempts.reading.test.ts`.
- A published Set is never edited: past Attempts are reviewed against the file. Publish a replacement
  and retire the old Set in `data/question-sets/supersessions.json` (ADR 0011). The one exception is
  an Explanation that names a different option than its Item's key: its text may be corrected in
  place, and nothing else with it. `supersessionManifest.test.ts`.
- An Explanation names an option only by what it says. One that names a slot, a label or a bare
  letter is repaired at generation, and if it is still flagged its Item keeps its option order
  (`referencesOptionByPosition`). `optionQuality.test.ts`, `positionReferenceTier.test.ts`.
- A Set file that fails `AnySetSchema` is skipped and reported (`GET /api/sets/unloadable`), and its
  Attempts lose their review. Narrowing a Set schema is a data-loss change; `schemas.test.ts`
  re-parses the banked Writing and Reading Sets.
- Outside `/drill-lab` (next), a spoken prompt reaches the client as text two ways only: in the
  Score Report of a scored Item (`scoreJson.meta`), whatever the Attempt's status, and as
  `spokenPrompts` on `GET /api/attempts/:id` for a completed Speaking Attempt, which covers every
  Item, scored or not (re-read from the Set, never stored). So an Item with no Score Report shows
  its sentence or question only once the Attempt is completed, never while it is in progress or
  after it is discarded (ADR 0017). `routes.attempts.spokenPrompts.test.ts`,
  `AttemptReviewGroups.test.tsx`.
- `/drill-lab` is the one other route that serves Listen and Repeat sentences in cleartext. Its
  bank, its practice queue and an Item's past scores count only an Item with a recorded take that
  was scored (`ANSWERED_LISTEN_REPEAT_ITEM_SQL` in `db/stores/drillLab.ts`). Its reps go to
  `backward_buildup_reps`, which nothing that scores reads. `routes.drillLab.test.ts`,
  `attemptedRule.test.ts`.
- A Set counts as attempted only through an Attempt that has a scored Item, or is completed and
  holds at least one Item (`ATTEMPT_COUNTS_AS_SITTING_SQL` in `db/stores/attempts.ts`), for Repeat
  tagging, the Set listing and Full-Test Set selection alike. A Full-Test Run in progress or
  completed claims its four Sets against later Runs; an abandoned Run claims only the Sets it sat
  by this rule (`listFullTestSetIds` in `db/stores/fullTests.ts`). `attemptedRule.test.ts`,
  `routes.fullTests.test.ts`.
- A Reading or Listening Set two of whose Items share an id is refused at scoring and its key review
  withheld (`DuplicateItemIdError` in `deterministicScoring.ts`); the Set schema does not check it.
  `deterministicItemIds.test.ts`, which also indexes every banked Set.
- Each generation check has one tier. Plan admission, the content gates, audio pace, the clip
  ceiling and module difficulty read theirs from `generationCheckPolicy.ts`; ADR 0006 names the
  checks that still decide in their own stage. A check is fatal only when the Set would be unusable
  or would teach a wrong answer. Change a tier in the policy and in `generationCheckPolicy.test.ts`
  together.

### Attempts and durability

- A Response is stored before any paid call on it starts: a recording is published before
  transcription is admitted, an essay is written before its scoring job exists.
  `recordingIntake.test.ts`, `routes.attempts.rescore.test.ts`.
- Scoring and generation run as durable job rows (`durableJobRunner.ts`): the route answers 202 with
  a job id and the client polls. A re-score keeps the committed score until the new one commits.
  `routes.attempts.rescore.test.ts`.
- Every `/api/*` route sits behind `localRequestGuard`: loopback Host, loopback Origin on writes, a
  declared body type, a 25 MB upload cap. The server binds `127.0.0.1` only (ADR 0012). A new upload
  route joins `UPLOAD_PATHS` there or is refused as non-JSON. `localRequestGuard.test.ts`.
- Boot recovery spends nothing and runs in declared phases (`bootRecoveryRegistry.ts`). A new pass
  declares its phase and rationale. `bootRecoveryRegistry.test.ts`.
- Shutdown closes job admissions, so no new Ears call starts (the transcription retry timer
  included). The drain waits for scoring, generation and transcription alike, and a transcription
  still running at its end is recorded failed (interrupted, retryable) before its call is aborted
  (`jobFamilyShutdown` in `index.ts`). `transcriptionShutdown.test.ts`.
- The same essay sent again while its scoring job is queued or running joins that job; different
  text replaces it, and a request after the job has ended starts a new one (a Re-score).
  `routes.attempts.rescore.test.ts`.
- `/complete` moves only an in-progress Attempt, and `/route` routes only an in-progress Simulation
  (409 otherwise) while still replaying a decision already stored.
  `routes.attempts.complete.test.ts`, `routes.attempts.reading.test.ts`.
- A Full-Test Run section is always a Simulation: `checkFullTestLink` refuses a `fullTestRunId`
  with any other mode. `routes.fullTests.test.ts`.
- A Full-Test Run in progress ends early only through `POST /api/full-tests/:id/abandon`. The Run
  and its live section's Attempt end in one transaction (`abandonFullTestRun`), finished sections
  keep their Attempts and bands, and there is no Overall. The route is idempotent and refuses a
  completed Run, and a Run in progress with no section left to sit, which its next advance
  completes; the client offers Abandon on neither (`nextSectionToSit`). The Attempt routes still
  refuse to discard or finish a Run's live section. `routes.fullTests.test.ts`,
  `FullTestPanel.test.tsx`, `FullTestRun.test.tsx`.
- A generation run whose publication intent has committed deletes nothing under its Set id until
  the intent is settled by its bytes (`reconcileGenerationPublicationIntent`), live and at boot
  alike. `generationJobs.test.ts`, `generationPublication.test.ts`.
- The end of an Attempt (the orphan heal, the completion and the Band Estimate) commits as one
  transaction (`settleAttempt` in `db/stores/attempts.ts`), for `/complete` and Speaking finalization
  alike. `attemptSettlement.test.ts`.

### Reasoning route and spawned CLIs

- Skill-backed work (plan, generate, verify, import, the Arbiter) runs Claude CLI, then Codex CLI,
  and never OpenAI HTTP. The OpenAI text Judge runs Codex, then OpenAI HTTP
  (`OPENAI_TEXT_PRIMARY=http`: HTTP only). The OpenAI speaking Judge is audio over HTTP and enters
  Text Fallback only on a 400, 415 or 422 whose error names the audio input, never on 404, 408, 429,
  5xx or auth. Gemini, TTS, images and vision are HTTP (ADR 0003). `reasoning.router.test.ts`, `judges.speaking.test.ts`.
- A queue position is reported only for a request that cannot start at once (queued in the
  scheduler, or held by an open circuit, which reports 0), and counts the requests of its family
  queued ahead of it, never those running. It is not an ETA. `running` is reported only when the
  provider call starts. `reasoning.queuePosition.test.ts`, `reasoning.circuitRecovery.test.ts`.
- Evidence from a request admitted before its circuit's current opening (a failure, or a refused
  window its stream reports) neither reopens the circuit nor disturbs a probe; the probe's outcome
  decides. A preflight that times out opens no circuit. `reasoning.circuitRecovery.test.ts`,
  `routes.providers.test.ts`.
- An Ears failure is terminal (`unsupported-audio`, no Retry) only for a 400 whose error names the
  audio, or a 413 or 415. A 400 naming the key, `FAILED_PRECONDITION`, or one not recognised is
  `configuration`: never retried automatically, retryable by the User. `ears.test.ts`.
- Each `claude -p` gets exactly the `Read` and `Skill` tools, `--strict-mcp-config`, and a Read deny
  list (`CLI_PERMISSIONS_SETTINGS` in `claudeRunner.ts`) naming every top-level entry except
  `.claude/skills/**`. A new top-level file or `.claude/` entry needs a deny line there or
  `claudeRunner.test.ts` fails. The spawn's environment (`CLAUDE_SPAWN_ISOLATION_ENV`) keeps out
  every `CLAUDE.md` (the person's own and this one), the project's auto memory and the CLI's
  bundled skills, so the model that scores or generates sees its prompt and its skill and nothing
  personal to the machine. A gate-only tolerance (such as `EXPLANATION_HARD_LIMIT_CODE_POINTS` in
  `generationVerifyRemediation.ts`) stays out of every prompt and skill: a model that learns a
  tolerance drifts toward it.
- Codex's read-only sandbox does not restrict reads. Its isolation is an empty temporary working
  directory and a prompt that names no absolute path (ADR 0003). `codexRunner.test.ts` pins the
  invocation; that the prompt names no absolute path has no test.
- `CLAUDE_CLI_MODEL` and `CLAUDE_CLI_EFFORT` pin the spawn's `--model` and `--effort`; unset, the
  spawn uses the interactive CLI's saved default. They are not named `CLAUDE_EFFORT` because Claude
  Code exports that into every shell, and `tsx --env-file` never overrides a variable the shell set.
  `claudeRunner.test.ts`, `config.test.ts`.
- Every text model call writes diagnostics (`route_invocations`, `provider_executions`,
  `model_attempts`; ADR 0004). A recording failure never fails the call, and no route exposes the
  rows. Rows older than `MODEL_CALL_RETENTION_DAYS` are pruned at boot and daily, and the freed
  space is reclaimed only while no job runs. Every stored `*_at_ms` is epoch milliseconds; the
  monotonic clock times only deadlines and durations. `diagnosticRetention.test.ts`,
  `reasoning.router.test.ts`.

### Database

- The schema version is SQLite's `PRAGMA user_version`. A schema change is a new last entry in
  `MIGRATIONS` (`server/src/db/migrations.ts`) and the same change in `schema.sql`, so a new
  database is born in the shape the migrations produce. `db.schemaVersion.test.ts`.
- Before the first change to an existing database the runner writes a snapshot to `backups/` beside
  it (the three newest are kept) and does not migrate without one. A database from a newer checkout,
  or from before versioning in a shape other than `schemaV1.sql`, is refused with a message, untouched.
  `migrationBackup.test.ts`, `db.schemaVersion.test.ts`.

### Timestamps

- SQLite `*_at` columns hold UTC as `YYYY-MM-DD HH:MM:SS` (`sqliteTimestamp()`), which `new Date()`
  misreads as local time. A view-model field carrying one goes through `sqliteTimestampToIso` at the
  route boundary, and client code never converts (`server/src/db/timestamps.ts`).
  `routes.timestamps.test.ts`. Exceptions: Set `createdAt` (ISO in the Set JSON) and
  `provider_quota_resets` (ISO by ADR 0008, `reasoning.providerQuotaPersistence.test.ts`).

### Client run flows

- `components/StimulusQuestions.tsx` is the one place a Stimulus's Items become DOM, in both modes.
  `ListeningStimulusQuestions` keeps every option and answer control out of the DOM until the audio
  ends, structurally, never by a `hidden` attribute or CSS. `StimulusQuestions.test.tsx` reads the
  raw DOM.
- A Stimulus or prompt whose audio fails is retried, then waits on a gate; it is never scored as the
  User's miss. `ItemRecorder.test.tsx`, `ListeningSimulation.test.tsx`.
- The Reading and Listening Module submit is one pure function, `pages/simulation/submitModule.ts`.
  Only a 409 marked `alreadyScored` counts as success; any other conflict stays an error, or unscored
  Attempts get marked complete. `submitModule.test.ts`.
- A section Simulation hands off, and inside a Full-Test Run advances it, only once its end has
  landed: `POST /complete` for Reading, Listening and Writing, the capture marker for Speaking. Each
  is retried within the Module submit's budget (`completeAttemptWithinBudget` in
  `pages/simulation/simulationShell.ts`), then shown with Retry and "Open the report as it stands"
  (`CompletionFailed`). Writing keeps its draft session and leave guard until then. A Drill's finish
  retries its completion the same way and, if it still fails, says so on the results screen with
  Retry; its finish button still leaves. `ReadingSimulation.test.tsx`,
  `ListeningSimulation.test.tsx`, `WritingSimulation.test.tsx`, `SpeakingSimulation.test.tsx`,
  `finishingSequence.test.ts`, `drillShell.test.tsx`.
- Each section Simulation is its own module under `pages/simulation/`, and each Drill its own page;
  a section module owns only its run body. Set loading, Attempt creation, the finishing sequence and
  the shared loading, error and status screens belong to the two shells (`pages/drill/`,
  `pages/simulation/`) and the exam primitives in `ui/`. Test a section by mounting the real
  component (`client/test/<Section>Simulation.test.tsx`); cross-Drill behaviour is asserted in
  `drillShell.test.tsx`. A running Drill or Simulation asks before the User leaves, in one dialog
  (`useLeaveGuard` and `LeaveGuardHost`, which need the data router in `App.tsx`).
- Build a Sentence's run lives in `components/buildSentence/`, and nothing outside it imports its
  internals (convention; no test).
- Drills, Simulations and Full-Test Runs render no `AppNav` (the route table in `App.tsx`;
  convention, no test).
- Trend axes are per Task Type (`lib/taskTypeScale.ts`): 0–1 accuracy for deterministic Task Types,
  0–5 for judged ones. `taskTypeScale.test.ts`.

### Design system

- UI uses the tokens in `client/src/index.css` and the primitives in `client/src/ui/`
  (`docs/design-system.md`). Every band renders through `BandFigure`; every status word comes from
  `ui/labels.ts`. `client/test/uiTokens.test.ts` rejects raw palette classes, default text sizes
  and hex colours anywhere under `client/src`.

### Tests

- A test goes through a real seam and fails without the change it covers.
- The server suite is hermetic. `setup-env.ts` scrubs every server setting
  (`helpers/hermeticEnv.ts`), the CLI binaries point at nothing, and an unmocked `fetch` fails its
  test (`helpers/fetchTripwire.ts`). Each run gets its own directory under the OS temp dir
  (`global-setup.ts`), which also holds the suite's `TMPDIR` and is removed at the end; each test
  file works in its own copy of the bank seeded there (`helpers/privateDataDir.ts`), and `config.ts`
  refuses a test data directory inside the repo's `data/`. Only `transcode.test.ts` runs real ffmpeg.
- A test that needs a store uses the real SQLite one (`helpers/sqliteStores.ts`). The shared
  hand-written job-store fakes are gone; do not add another.
- `composedApp.clientApi.test.ts` drives the composed app (`mountDatabaseRoutes` in `index.ts`)
  through the client's own `client/src/lib/api.ts`; a change to a route's wire format fails it.
- A new setting goes into `server/src/lib/config.ts`, `.env.example` and `hermeticEnv.ts`;
  `hermeticEnv.test.ts` fails when `server/src` reads a variable the policy does not cover.

## Agent skills

### Issue tracker

Issues live as GitHub issues on `jayin92/toefl-prep-tool`, driven by the `gh` CLI. See `docs/agents/issue-tracker.md`.

### Triage labels

The five canonical triage roles, each label string equal to its role name. See `docs/agents/triage-labels.md`.

### Domain docs

Single-context: `CONTEXT.md` + `docs/adr/` at the repo root. See `docs/agents/domain.md`.
