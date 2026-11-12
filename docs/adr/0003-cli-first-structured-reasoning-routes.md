# CLI-first structured reasoning routes

## Status

Partially superseded by [ADR 0007](0007-adaptive-protected-reasoning-admission.md). ADR 0007 replaces this decision's concurrency-one queues, fixed circuit policy, and Claude scoring budget. The route matrix, fallback boundaries, and subscription-first intent below remain in force.

## Context

Structured text reasoning currently depends on either Claude Code or direct OpenAI HTTP calls. Subscription quota and authentication failures can make either route unavailable, while sending all work through paid API endpoints defeats the goal of using the existing Claude and ChatGPT subscriptions first.

## Decision

The fixed route matrix is:

| Work | Primary | Automatic fallback | Terminal behavior |
|---|---|---|---|
| Set generation/import/Build-a-Sentence verification | Claude CLI | Codex CLI | Report the sanitized `Claude → Codex` failure chain; never call OpenAI HTTP |
| Score arbitration | Claude CLI | Codex CLI | Store and show the neutral "arbitration failed", which names no provider (score-bearing state); the chain goes to the server log and the diagnostic tables; never call OpenAI HTTP |
| Email/discussion OpenAI Judge | Codex CLI | Existing OpenAI HTTP text endpoint | Preserve Gemini single-Judge degradation if both OpenAI routes fail |
| OpenAI speaking Judge, audio mode | Existing OpenAI audio HTTP endpoint | Existing structural-audio Text Fallback only | Preserve the current retry and structural-failure rules |
| OpenAI speaking Judge, Text Fallback | Codex CLI | Existing OpenAI HTTP text endpoint | Report the OpenAI Judge as failed if both text routes fail |
| Gemini Judges and Ears | Existing Gemini HTTP endpoints | Existing behavior | Unchanged |
| TTS, scene image, and focus-region vision | Existing HTTP endpoints | Existing behavior | Unchanged |

- Codex uses explicit `CODEX_MODEL` and `CODEX_REASONING_EFFORT` settings, defaulting to `gpt-5.6-sol` and `high`. The runner ignores personal Codex configuration so it cannot silently change application behavior, and invalid application settings fail configuration rather than degrading silently. `xhigh` remains an explicit override, but is not the default because the full writing-generation request can exceed the five-minute route budget at that effort.
- `OPENAI_TEXT_PRIMARY` defaults to `codex`, meaning Codex followed by OpenAI HTTP fallback. Its `http` setting is HTTP-only for that role, providing a true server-side operational rollback without changing audio, TTS, image, or Claude-backed routing. There is no end-user provider toggle.
- Direct OpenAI HTTP is used routinely only for non-text modalities. Audio judging, text-to-speech, and image generation retain their existing API routes; existing text endpoints remain available as the automatic fallback for Codex-first OpenAI Judge calls.
- The OpenAI speaking Judge remains audio-first over HTTP. Only after the existing structural-audio-failure trigger enters Text Fallback does its transcript-and-Delivery-Report reasoning become Codex-first, with OpenAI HTTP text as fallback. Audio quota, rate, and provider failures do not trigger Text Fallback.
- A route falls back after a route-local failure: the CLI is missing or cannot start, authentication or quota rejects the call, retries exhaust a rate-limit or provider error, the call times out, or structured output remains malformed after one repair attempt. Invalid application input, an impossible contract, and local programming or configuration defects fail directly instead of being masked by another route.
- Clear availability failures open a ten-minute circuit for that CLI, so later work bypasses a route that is known to be unavailable. A malformed structured response falls back only for its own call and does not open the circuit.
- Claude and Codex each have a concurrency-one queue. The two queues may run at the same time, and a fallback joins the destination provider's queue rather than blocking unrelated work on the source provider.
- A route's deadline starts after it leaves that provider's queue and covers its initial attempt plus its one structured-output repair attempt: 180 seconds for Claude and 300 seconds for Codex. The two provider execution budgets can therefore total approximately eight minutes after their respective dequeues. Waiting in Codex's destination queue is outside its 300-second execution budget and can add elapsed wall time; an outer caller or job deadline may bound the overall workflow where applicable. Exhausting either route-level budget follows the normal fallback chain.
- CLI and authentication preflights are capability checks, not application startup gates. An unavailable provider opens its circuit, produces an actionable warning and UI status, and only causes a job failure when that job's complete route chain is unavailable.
- Job records and UI errors retain only the attempted provider chain, normalized failure classes, and actionable remediation. Server logs add provider, model, duration, and fallback/circuit transitions, but prompts, full model output, authentication data, and raw CLI event streams never reach logs, job records, or the UI. ADR 0004 persists each attempt's prompt and raw output, redacted and bounded, to the local diagnostic tables only.
- Codex runs with `--sandbox read-only` in a private temporary working directory, and its composed prompt names skill sources by relative path only. That sandbox blocks writes and network access, not reads: a shell command the model runs can read any file the server's user can, including the project's `.env` and the gate-only tolerances the Claude route's Read deny list hides. `codex exec --help` offers no narrower read scope (its sandbox modes are `read-only`, `workspace-write` and `danger-full-access`), so this asymmetry is accepted rather than closed: Codex's isolation from the project is that nothing points it there, not that it cannot read there.
- CLI artifacts live in private temporary directories with mode `0700`; structured-output files use mode `0600`. The directories and files are removed after success, failure, and timeout. Codex also runs with `--ephemeral`, and Claude runs with `--no-session-persistence`, so neither adapter retains a CLI session for application calls.
- OpenAI HTTP is not a tertiary fallback for Claude-backed work. If both Claude and Codex fail, that work stops and reports the failed route chain.
- Availability takes precedence over model-role independence: Codex may author the OpenAI Judge Report and then arbitrate the same Response.
- Each affected Score Report item produced through that Self-Arbitration mode records only the server-derived `selfArbitrated` state durably; other provider provenance stays operational and is not persisted in score or Judge history. Review history discloses the item's reduced model independence, and its score still contributes normally to Band Estimates.
- Provider recovery never triggers an autonomous re-score. The existing manual Re-score action replaces the result under normal semantics and omits `selfArbitrated` only when the replacement route restores model-role independence.
- Existing ETS calibration runs remain recommended evidence but are not a prerequisite for making Codex the default route; implementation tests and normal verification are the cutover gate.

## Consequences

Text reasoning can continue through either subscription outage and OpenAI Judge text work retains its paid API escape hatch. Claude-backed work still has a deliberate terminal failure when neither CLI is usable. Self-Arbitration improves continuity but is not an independent third-model opinion, so the product must keep that limitation visible after scoring. The default-route cutover accepts scoring-quality risk that the small live calibration suite could otherwise catch before release.
