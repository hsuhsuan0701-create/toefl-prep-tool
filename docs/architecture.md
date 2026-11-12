# Architecture

How the app is put together, at the level you need before changing it. Domain terms (Set, Item,
Attempt, Judge, Arbiter, Score Report, Band Estimate…) are defined in [`CONTEXT.md`](../CONTEXT.md);
decisions and their reasons are in [`docs/adr/`](adr/).

## The three workspaces

One npm workspace repo, one process per side:

- **`shared/`** holds the zod schemas and view-model types both sides use, imported as
  `@toefl-prep/shared`. A Set file, a request body, a Judge Report and a response shape are each
  defined once here.
- **`server/`** is a Hono API on Node, bound to `127.0.0.1` (port 8787 by default). It owns the
  SQLite database (better-sqlite3), the files under `data/`, every model call, and every durable
  job.
- **`client/`** is a React app built by Vite (port 5173), which proxies `/api` to the server. It
  holds no state that matters beyond a page: everything durable goes through the API.

```text
 browser ── /api ──► localRequestGuard ──► routes ──► services ──► SQLite (data/db.sqlite)
 (client)            (local Host only)       │            │    └─► files (data/…)
                                             │            ├─► Gemini / OpenAI HTTP (Judges, Ears,
                                             │            │   TTS, images, vision)
                                             │            └─► reasoning route ─► claude -p / codex exec
                                             └─ 202 + job id for slow work; the client polls it
```

## Two kinds of Attempt

### Deterministic: Reading, Listening, Build a Sentence

1. The client creates the Attempt (`POST /api/attempts`) and loads the Set through
   `GET /api/sets/:id`, the one route Set content reaches the client through. It strips every answer
   key, target sentence, interview question and generation plan (`stripAnswers` in
   `shared/src/servedSet.ts`), and serves Build a Sentence tiles in a freshly drawn order.
2. The client posts a Task Type's Responses to `POST /api/attempts/:id/score`. The server scores them
   against the Set on disk and commits them as one unit, inline. A Drill gets the key and the
   Explanation back. A Simulation gets bare correctness; keys and Explanations appear only in the
   Attempt review after the Attempt is complete.
3. A Reading or Listening Simulation calls `POST /api/attempts/:id/route` once the Router Module is
   scored. The server computes the Module Path from the Router raw score, stores it, and refuses any
   later write to the Router or to the other module.
4. `POST /api/attempts/:id/complete` computes the Band Estimate (`table3-v1`). Only a routed
   Simulation gets one; a Drill never does (ADR 0005).

### Judged: Speaking, Email, Academic Discussion

```text
 recording ─► upload ─► Ears ─► Judges (Gemini, OpenAI) ─► Arbiter ─► Score Report ─► Band Estimate
 essay ──────────────────────►┘
```

1. **Capture.** A Speaking recording is uploaded per Item. The server stores it, transcodes it with
   ffmpeg, and hands it to a durable transcription job, which calls **Ears** (Gemini) for a verbatim
   transcript and a Delivery Report. A transient Ears failure retries on a growing delay; once the
   automatic budget is spent, the Item offers the User a Retry that re-uses the stored recording. An
   essay is sent in the score request and stored before anything else happens.
2. **Scoring job.** When a Task Type's Responses are ready, the client posts them to `/score`, which
   answers `202` with a job id. When a transcription recovers after the client has moved on, the
   server enqueues the job itself. The job runs in the server, not in the request:
   - Both **Judges** score each Response independently against the rubric. Speaking Judges hear the
     recording itself (ADR 0002).
   - If one Judge fails, scoring continues single-Judge and says so. If both fail, the Items are left
     rescorable.
   - The **Arbiter** commits its own rubric-anchored score before it reads the Judges' numbers, then
     reconciles them (ADR 0001).
   - The Score Report commits together with the Judge Reports, in one transaction.
3. **Completion.** A Drill or Writing Attempt completes through `/complete`. A Speaking Simulation
   ends with `POST /api/attempts/:id/capture-finished`: the server records which Items never arrived,
   and completes the Attempt itself once all its work has ended, so closing the tab during the
   wrap-up loses nothing.
4. **Band Estimate** (`linear-v2`): each Task Type weighted by its share of the section's ETS raw
   points, and only when every Item of the Attempt is scored and every Task Type has one (ADR 0010).
   An Item that failed, is still unscored or never arrived leaves the Attempt without a band until
   it is re-scored.
5. **Review.** A completed Speaking Attempt's detail (`GET /api/attempts/:id`) carries each Item's
   sentence or question as text, re-read from the Set, so an Item with no Score Report still says
   what was asked. Before completion it carries none (ADR 0017).

A recording with no speech in it scores a deterministic 0 with a "no speech detected" marker; it is
never sent to the Judges.

### Durability guarantees

- **A Response is stored before any paid work on it starts.** The recording is written to disk and
  its Item row exists before Ears runs. An essay is recorded before its scoring job is created.
- **Slow work is a durable job row, not a request.** Scoring and generation keep running when the tab
  closes; a page reopened later re-attaches by polling the job. Progress moves only at real
  checkpoints, never on a timer.
- **A re-score keeps the committed score** until the new one commits.
- **One server per data directory.** A database-level execution lease lets only one process run jobs
  against `data/`. A second process waits for it and answers `GET /api/ready` with 503 until it holds
  the lease.
- **Boot recovery spends nothing.** Once the lease is held, the boot passes run in a declared order
  (`server/src/services/bootRecoveryRegistry.ts`):
  - a scoring job left running is marked failed, and its Items become rescorable;
  - an unscored silent recording gets its 0;
  - an interrupted generation job is failed, and its half-written files are removed;
  - an unfinished transcription is failed, so the User's Retry accepts it;
  - every Attempt those passes touched, and every captured Speaking Simulation, is reconciled and its
    Band Estimate recomputed.

  Nothing is re-scored or re-generated automatically.
- **Shutdown drains.** On SIGINT/SIGTERM the server stops admitting jobs and starts no new Ears call
  (the transcription retry timer included), waits a bounded time for running scoring, generation and
  transcription work, records the rest as cancelled (their Items stay rescorable) or, for a
  transcription, as interrupted (its Retry stays open), and flushes the diagnostic recorder.

Practise with `npm start`, not `npm run dev`. `npm run dev` restarts the server on every file change,
which is a restart in the middle of your Attempt. The guarantees above make that recoverable, not
free.

## A generated Set

`POST /api/generate` takes one kind, or a batch of at most 10 Sets, and answers with a job id. A
batch runs up to seven children at once, and each child is its own job.

1. **Plan.** The model proposes a Plan: per Task Type, a domain and the concepts to use. The server
   admits it with deterministic checks, no model call (`generationNovelty.ts`). A Plan that
   contradicts its own declared domain, or whose Listen and Repeat setting names no place, is asked
   for again. Overlap with the **Catalog** (the prior Sets, each as its stored Plan where it has one)
   and Build a Sentence's spread over too few domains become advisory notes; they never stop a
   Plan.
2. **Generate.** The model writes the Set content from the accepted Plan. Reading's Complete the Words
   gaps are derived in code (`server/src/services/ctest.ts`), so the key is correct by construction.
   A draft that fails a deterministic check (Build a Sentence's or Listen and Repeat's content gate,
   an Upper Module not harder than its Lower, Listening's item ids) is written again, three drafts in
   all (`generationCandidateLoop.ts`).
3. **Verify.** Deterministic content gates run first. Then a **Verifier** call checks the keys: for
   Reading and Listening, that each Item's key is the one right answer from its Stimulus; for Build
   a Sentence, that each Item's accepted answers are right, correcting them where they are not. A
   failing Item gets a bounded repair.
4. **Render.** For Speaking and Listening, Gemini text-to-speech renders every clip, and each clip's
   pace is measured from the audio file. A Speaking Set also gets a scene image and its focus regions
   (ADR 0014); either may fail without failing the Set.
5. **Publish.** The Set JSON is staged and renamed into `data/question-sets/<kind>/`, so the bank
   never holds a half-written Set. A generation that replaces an older Set retires it through the
   supersession manifest, after the replacement has published (ADR 0011).

**Check tiers** (ADR 0006, `server/src/services/generationCheckPolicy.ts`). Every check is exactly
one of:

- **fatal**: the Set would be unusable or would teach a wrong answer, so the job fails;
- **advisory**: recorded on the Set as an advisory note; the kinds that change what the User
  practises are shown before they start;
- **repair-then-accept**: one bounded repair, then a written-down ending.

Novelty and taste are never fatal.

Import (`scripts/import-set.ts`, Speaking and Writing) turns material the User supplies into a Set
with `source: "imported"`. It goes through the same schema validation but runs no novelty or Build
a Sentence gates.

## The reasoning route

Model calls go to one of three places:

| Work | First | Fallback | Never |
|---|---|---|---|
| Plan, generate, verify, import, and the Arbiter (skill-backed) | Claude CLI | Codex CLI | OpenAI HTTP |
| OpenAI text Judge (essays; Speaking Text Fallback) | Codex CLI | OpenAI HTTP | |
| OpenAI speaking Judge | OpenAI audio HTTP | Text Fallback, only on a structural audio failure | |
| Gemini Judges, Ears, TTS, image, vision | HTTP | (none) | |

`OPENAI_TEXT_PRIMARY=http` makes the OpenAI text Judge HTTP-only. When both CLIs are unavailable,
skill-backed work stops and reports both failures. Reading and Listening scoring needs no model at
all.

The CLI side (`server/src/services/reasoning/`, ADRs 0003 and 0007) owns three things:

- **Admission.** Each CLI provider runs a bounded number of calls at once, with capacity reserved
  for scoring, so an Arbiter call is never stuck behind a long generation call.
- **Circuit.** An authentication failure, an exhausted quota or a missing binary opens the
  provider's circuit, and later calls fall back at once. After a cooldown, the next request probes
  the provider. A hard-quota reset time is kept across restarts (ADR 0008).
- **Budgets.** A call's time budget starts after admission and covers one structured-output repair.

The spawned processes are locked down:

- **`claude -p`** gets only the `Read` and `Skill` tools, no MCP servers, none of the CLI's bundled
  skills, and a Read deny list that covers every top-level project entry except `.claude/skills/`
  and `CLAUDE.md`. Skills synced from the claude.ai account remain reachable: only an account
  setting turns those off. It keeps no session.
- **`codex exec`** runs `--ephemeral` in an empty temporary directory with a read-only sandbox.
  That sandbox blocks writes and network access but not reads (ADR 0003).

Every text model call writes a diagnostic row: prompt and response, redacted, capped at 1 MiB per
field. Rows older than `MODEL_CALL_RETENTION_DAYS` (30) are pruned at boot and once a day, and the
freed space is handed back to the file system while no job runs. No route or UI exposes these rows,
and scoring never reads them (ADR 0004).

## Where data lives

All under `data/`, or wherever `TOEFL_DATA_DIR` points:

| Path | Tracked | Holds |
|---|---|---|
| `question-sets/<kind>/<setId>.json` | yes | the Set bank. Published Sets are immutable |
| `question-sets/supersessions.json` | yes | which Sets are retired, and by what (ADR 0011) |
| `audio/stimuli/<setId>/` | yes | a Set's rendered clips and its `audio-manifest.json` |
| `images/scenarios/<setId>.webp` | yes | Speaking scene illustrations |
| `audio/responses/` | no | your recordings, including Drill Lab reps |
| `db.sqlite` (+ `-wal`, `-shm`) | no | Attempts, scores, estimates, settings, jobs, diagnostics |
| `backups/` | no | a snapshot of `db.sqlite` taken before each migration; the three most recent are kept |

The schema is created on first start (`server/src/db/schema.sql`). Its version is SQLite's
`PRAGMA user_version`, and an existing database is brought to the current version by the ordered
migrations in `server/src/db/migrations.ts` (ADR 0016). Before the first change, the server writes a
`VACUUM INTO` snapshot of it to `data/backups/`, and if that snapshot cannot be written it does not
migrate and does not start. A database written by a newer checkout, or one from before versioning
that is older than the oldest shape this code adopts, is refused at boot with a message saying what
to do. Every `*_at` column holds UTC as
`YYYY-MM-DD HH:MM:SS`, converted to ISO-8601 at the route boundary (`server/src/db/timestamps.ts`).
The one exception is `provider_quota_resets`, which stores ISO-8601 (ADR 0008).

## The request guard

`server/src/lib/localRequestGuard.ts` runs in front of every `/api` route (ADR 0012):

- the Host must be a loopback name;
- a state-changing request with an Origin must come from a loopback origin;
- a body must declare its real type;
- uploads are capped at 25 MB.

The app serves only the machine it runs on.

## Directory map

```text
shared/src/
  schemas.ts            the public list of zod schemas; a new public name needs a line here
  schemas/              the schemas themselves, one file per section, plus scoring and shared parts
  viewModels.ts         every response shape the client reads
  servedSet.ts          stripAnswers and the served Set types
  cefr.ts               band → CEFR level, the only mapping
  backwardBuildup.ts    Drill Lab chunking and steps (server and client both derive them)
server/src/
  index.ts              composition root: guard, routes, stores, lease, boot recovery, shutdown
  lib/                  config (every setting the server reads), request guard, path containment
  db/                   schema, migrations, one store per aggregate, the timestamp convention
  routes/               HTTP: sets, attempts, generate, stats, full-tests, drill-lab, media, setup-status
  routes/attempts.ts    Attempt lifecycle: create, upload, score, route, complete, review
  services/reasoning/   the CLI route: admission, circuit, process supervision, preflight
  services/judges/      Gemini and OpenAI Judges and their prompts
  services/             everything else, by area:
    scoring             judgeEnsemble, scoreItems, scoringJobs, arbiter, ears, deterministicScoring,
                        bandEstimator, sectionEstimates, moduleRouter, fullTestRun
    speaking capture    recordingIntake, transcode, transcriptionRecovery, speakingFinalization
    durability          durableJobRunner, bootRecoveryRegistry, executionOwner, shutdownCoordinator
    generation          generationJobs, generator, generationPlanner, plan admission (generationNovelty,
                        generationCatalog), the candidate and verify loops, generationCheckPolicy,
                        one generator per section, the content gates
    audio and images    tts, ttsQueue, speakingAudioRenderer, listeningAudioRenderer, audioPace*, sceneImage
    the bank            setStore, supersession, supersessionManifest, tileScramble, setTitle
    diagnostics         modelCallLog, modelCallRecorder, clipMeasurementLog
  services/listeningGenerator.ts, readingGenerator.ts
                        the two largest files: generation, gates and repairs for those sections
client/src/
  App.tsx               the route table
  pages/                one file per page
  pages/drill/          the shell all four Drills share
  pages/simulation/     one module per section Simulation, over a shared shell
  pages/AttemptReview.tsx  the review of one Attempt, every section
  components/           run-flow pieces: ItemRecorder, StimulusPlayer, StimulusQuestions, buildSentence/
  ui/                   design-system primitives (docs/design-system.md)
  hooks/                recorder, job polling, practice data, leave guards
  lib/                  API client, Task Type labels and chart scales
scripts/                generate and import Sets, calibrate and smoke-test scoring, audit the bank, check
                        the rubrics. Generation, calibration and smoke tests make paid calls, and
                        calibration needs ETS's material locally (docs/official-rubrics.md)
.claude/skills/         the four toefl-* skills: rubrics and generation guides the CLIs run
data/                   the Set bank and its media, plus your database and recordings
```
