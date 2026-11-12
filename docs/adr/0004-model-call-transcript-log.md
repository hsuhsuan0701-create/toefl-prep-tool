# Model call transcripts are persisted to the database

## Status

Accepted. Amends the retention half of ADR 0003's CLI artifact rule (see Consequences).

## Context

On 2026-08-04 a three-set speaking generation batch failed every one of its nine generation
attempts with `generated content did not follow its accepted plan after 3 attempts`. Diagnosis
stopped at the class of failure. It was possible to establish, from `generation_jobs` alone, that
the failures were conformance rather than topic collision — `planningAttempt: 1` proved each topic
plan was accepted first try — but not which check fired, and not what the model was actually sent
or actually returned. Three things had each independently destroyed the evidence:

- `generateDiverseCandidate` collapsed the rejecting `DiversityIssue[]` into a single sentence and
  discarded the issues.
- Each CLI call's private temp directory, holding the prompt and the rejected output, is removed in
  a `finally` the instant the call settles (ADR 0003's artifact rule).
- The reasoning router's `ReasoningRouteLogger` emitted provider, model, durations, and failure kind
  to `console.info` — never a prompt, never a response, and never anywhere durable.

Nine paid attempts produced no artifact that could explain them. The judges and Ears had the same
gap; nothing about it was specific to generation.

## Decision

Every **text** model call this server makes is recorded in the normalized `route_invocations`,
`provider_executions`, and `model_attempts` tables, prompt and raw response included, on success and
on failure alike. The original single `model_calls` table stopped receiving rows when these tables
replaced it, and schema migration 2 dropped it (ADR 0016). This normalization and the safeguards
below supersede the original single-table/body-only details of this ADR, per the confirmed #11 seam
design.

- **Coverage.** The CLI reasoning routes (Claude, Codex — generation planning, generation,
  verification, import, arbitration) plus the Gemini essay Judge, the Gemini speaking Judge, the
  OpenAI text Judge, the OpenAI audio Judge, and Gemini Ears. Scene image and focus-region vision
  stay out of scope: their payloads are not text and their failures have never been the
  undiagnosable kind.

  TTS was ALSO ruled out of scope here on the same reasoning, and that was wrong within the day.
  Four speaking renders then failed at `rendering-audio`, each on a different clip class, and the
  per-clip measurements existed only in a console nobody had captured — the identical failure this
  ADR was written to end. A second table, `clip_measurements`, records one row per synthesis
  ATTEMPT (discarded corrections included) under the same correlation, the same never-throws rule,
  and the same retention setting. It stores measurements only: never clip text, never a scenario or
  question, never a provider payload. The audio itself stays on disk and is referenced by path.

  **Two amendments from issue #107 (2026-08-23).** One row per attempt left the table unable to say
  which take SHIPPED — the pace-correction loop publishes the better take, not the newer one, so
  `max(correction_count)` and "the last row" both named the discarded take whenever a correction was
  bought and lost (13 of the bank's 26 advisory notes recorded exactly that). `take_disposition` now
  carries it, written by the renderer immediately after the rename that publishes a take. **Rows
  written before that column exists keep `take_disposition = NULL` permanently, and are not
  migrated**: which of two takes shipped is not derivable from the rows, and a guess would be
  indistinguishable from a measurement. Read the current bank with `take_disposition IS NOT NULL`.

  Separately, rows do not travel between checkouts and Sets do: a batch rendered in a git worktree
  wrote its measurements into that worktree's database while its Sets and audio were copied into the
  checkout that kept them, which is why not one row exists for the entire `ets-2026-v4` bank. Those
  measurements are lost. Going forward each render's `audio-manifest.json` — which lives INSIDE the
  audio directory and therefore cannot be separated from it — carries every take, and a boot pass
  replays them into whichever database is local, idempotently by row id. This does not widen what the
  table may hold: a manifest take carries the same measurement fields and deliberately omits the
  rendering checkout's own job correlation.
- **Correlation** travels through `AsyncLocalStorage`, established once per generation or scoring
  job by the durable job runner (`durableJobRunner.ts`) and refined in `callGenerationSkillTask`
  with the stage and which plan or generation attempt is running. Threading a context parameter
  instead would have put the owning job id into `generateSet`, `GenerationPlanner`,
  `SkillTaskRunner`, and the router's request, for no gain in fidelity. One stable route ID covers the logical route, all of its
  provider/fallback executions, and their initial/repair attempts. IDs are allocated before their
  corresponding lifecycle begins; explicit sequence numbers, not insertion timestamps, define order.
- **This correlation is no longer observation-only** (issue #28, 2026-08-15). When written, the
  store's sole consumer was this log, and the choice above was justified as keeping "an observational
  concern" out of production signatures. The reasoning router now reads the same store through
  `currentModelCallCorrelation()` to pick a call's admission bucket, so the id it carries decides
  SCHEDULING as well as attribution — see ADR 0007, whose per-job fairness had never engaged in
  production because no caller supplied a job id and admission fell back to the task name. Two
  consequences a reader of this ADR needs. First, the store is now load-bearing: a reasoning call
  made outside any `withModelCallContext` scope loses its fairness identity along with its diagnostic
  attribution, where before it lost only a row. Second, and unchanged, this does NOT widen what the
  diagnostic tables may hold: what crossed into behaviour is the ambient job id — which the scheduler
  already had a legitimate need for — not any provider provenance, and the local-only/never-read-by-
  scoring/pruned-by-age properties of the tables themselves are untouched.
- **The CLI transcript arrives on its own channel** (`onTranscript` on both runners), not on the
  provider result. It cannot ride the result: the provider executor rebuilds every result from its
  value or its failure kind alone, so a runner's extra fields never travel, and on `invalid-output`
  the raw text is exactly what never becomes a value. One row per CLI attempt, so the repair retry is visible as its own event, and the
  prompt recorded is the one that attempt actually sent — for Codex that is the skill-composed
  prompt, not the caller's. A failed attempt records what the CLI printed as its response: Claude's
  whole stream-json stdout, and for either CLI the last 64 KiB of stderr after a `[stderr]` marker
  (Codex's stderr is its session log). The failure kind is read from the end of that output — the
  stream's final `result` event for Claude, the session log's final error line for Codex — never
  from its head, which an `init` event or an echoed prompt fills.
- **One clock for stored times.** Every `*_at_ms` column holds epoch milliseconds, for the CLI
  routes and the HTTP calls alike, so ordering a job's calls by `queued_at_ms` follows when they
  ran, across restarts too. Durations and provider deadlines may still be measured on the monotonic
  clock. Rows written while CLI routes stamped milliseconds since process start are not rewritten;
  retention prunes them.
- **Central redaction and bounds.** Rows carry prompts and responses, never header bags or process
  environments. Every field passes through the recorder's central credential redaction before
  storage. Each prompt/response field is bounded to 1 MiB of UTF-8, preserving both its beginning
  and end and recording the exact omitted-byte count.
- **Large binaries stay on disk.** The speaking judges record the prompt plus a manifest of the
  attached clip paths; Ears records the prompt alone. The recordings already exist on disk under
  paths the attempt rows know.
- **Recording can never fail a call.** Writes use a bounded asynchronous recorder, the same
  containment rule the router applies to observers. Queue overflow and database failure never
  affect provider or fallback outcomes, but are not silent: both emit structured loss diagnostics
  with correlation IDs. Shutdown flush is bounded.
- **Retention** is age-based: `MODEL_CALL_RETENTION_DAYS`, default 30, covering these tables and
  `clip_measurements`. Boot recovery prunes once, and a running server prunes once a day after that.
  The space a prune frees is handed back to the file system a few pages at a time while no job is
  running, or by one `VACUUM` at boot when a large prune meets a database that cannot yet reclaim
  incrementally (`modelCallLog.ts`, pinned by `server/test/diagnosticRetention.test.ts`). `0`
  disables pruning rather than deleting everything.
- Separately, `generation_jobs.error` now carries the rejecting issues as JSON below its existing
  summary line, so the class of failure is readable without opening the transcripts at all.

## Consequences

ADR 0003 states that CLI artifacts live in private `0700` temp directories that are removed after
success, failure, and timeout. **That rule still holds in full for the CLI's own working files** —
schema files, structured-output files, the working directory — and neither adapter retains a CLI
session. What changes is that the prompt and the model's response are no longer *only* in that
directory: they are also written to `db.sqlite`, deliberately, because their destruction is what
made the 2026-08-04 failure undiagnosable. The `ClaudeFailure` doc comment's "contains no CLI
diagnostics" likewise still holds — that contract is about what a *failure result* may carry to
callers, and it is unchanged.

The practical costs, accepted:

- `db.sqlite` grows faster than before, and model diagnostics can be its largest data set. A generation
  prompt embeds a bounded slice of the novelty catalog and runs to tens of KB; a three-set batch
  adds roughly a megabyte. Retention bounds it.
- The database now contains the user's own responses and generated content in a second place. This
  is a single-user local tool and the data is the user's own, already stored in `item_results` and
  `data/question-sets/`. It is not encrypted, and `db.sqlite` was already not encrypted.
- Reading transcripts is a `sqlite3` query. No HTTP route and no UI expose this table; adding one
  would make an internal diagnostic surface into a supported contract.

## Alternatives considered

**Record only on failure.** Smallest database, and it was the tempting option. Rejected because a
call that *succeeds* while producing subtly wrong content is exactly the case where a transcript is
the only evidence — and generation's rejected candidates are, from the provider's perspective,
successful calls.

**Keep fields unbounded.** Rejected after the original ADR. A single pathological provider body can
grow the local database without limit. The 1 MiB head/tail representation retains both the request
setup and late plan/catalog/output evidence, while the omitted-byte count makes the loss explicit.
