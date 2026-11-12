# Adaptive protected admission for CLI reasoning

## Status

Accepted; supersedes ADR 0003's concurrency-one queue, fixed circuit, and Claude scoring-budget decisions. ADR 0003's route matrix and subscription-first intent remain in force.

## Context

ADR 0003 serialized each CLI provider because concurrent subscription calls had not been measured. That protected an assumed quota constraint but created head-of-line blocking: one observed Listening generation job occupied Claude for about 30.5 minutes across 15 calls, including nine remediation calls. Priority cannot help a scoring request while a long generation call is already running.

Issue #7 measured each family safely through concurrency eight, but did not test a mixed load of eight scoring plus eight generation calls. Issue #8 also found asymmetric evidence: Anthropic exposes structured pressure events and supports concurrent CLI workflows, while OpenAI documents serialized use of a shared ChatGPT-managed `auth.json` as credential guidance rather than a request quota. Neither finding justifies sixteen calls per provider or a permanent concurrency-one cap.

## Decision

Claude and Codex receive independent provider-wide adaptive schedulers. Each defaults to initial capacity 4, floor 2, and ceiling 8. One token is a non-borrowable scoring reservation: generation may use at most seven slots while scoring can use the reservation and shared slots. The ceiling is provider-wide, not per family.

Shared admission chooses the family whose eligible head waited longest. Within a family it round-robins jobs and preserves FIFO order within each job. A job here is one durable generation or scoring job — each child of a batch is its own job — identified by the ambient model-call correlation its runner installs, never by the task being performed; keying on the task instead collapses every concurrent child onto one bucket and silently degrades admission to a single flat FIFO. Queue position is reported only for a request that cannot start at once, and counts the requests of its family queued ahead of it, not those already running beside it; it is a family-local best-effort count, never an ETA. A route deadline begins only after admission and includes its initial attempt plus one repair; recorder latency and queue wait are excluded.

Capacity rises by one after a pressure-free wave of the current capacity's terminal calls. The first provider-pressure strike reduces capacity by one, the second within 60 seconds halves it, and the third opens the provider circuit. Cancellation, invalid output, and an isolated timeout do not penalize capacity. Authentication, hard quota, and a missing CLI open immediately; rate-limit and generic provider failures use the strike policy.

Claude's structured stream is the pressure source, read on failed calls as well as successful ones. Each `rate_limit_event` carries the server's `status` for the limiting window (`allowed`, `allowed_warning` or `rejected`), its `resetsAt` in epoch seconds, and per-window utilization; `overageStatus` concerns paid extra usage and is never read as a refusal. A window below 90% is telemetry. A window at or above 90%, a call the CLI retried after a 429 or an overload, and a refusal that paid overage is covering each contribute one capacity strike per window (per call, for a retry). Because the call that reported them was served, these strikes never open the circuit; every call made while a window runs hot reports it, so striking per report would open the circuit after three completions. They do count toward the strikes a later failed call is judged against. A `rejected` status means requests are being refused: it opens the circuit until that window's reset, a trustworthy timestamp honored with a five-second margin and persisted across restarts (ADR 0008). Otherwise cooldowns are 1, 2, 5, and 10 minutes, capped at 10 minutes.

Queued work present when a circuit opens may be held for at most 10 minutes. Work submitted during the cooldown receives a typed provider-unavailable result immediately, so it falls back. After cooldown, the next request owns the recovery probe whether or not anything was held, which is what lets a single user's provider recover without a restart; a live held request goes first (scoring before generation, then oldest), and wins the probe even when the longest cooldown has used up its hold. A cancelled holder leaves the candidate set. A probe that ends without evidence about the provider (cancellation, or a local configuration or application fault) relinquishes ownership without escalating the cooldown. A probe the provider answered closes the circuit and resumes at capacity 2, including one whose output failed validation, because the provider was reachable. Evidence from a request admitted before the circuit's current opening (its failure, or a `rejected` window its stream reports) is older than the evidence that opened it: it neither reopens the circuit nor disturbs a probe in flight, and the probe's own outcome decides. A request the circuit holds after dequeue is reported as waiting, never as running, and its provider time starts only when its call does. A startup or Setup preflight that does not answer within its bound is no evidence and opens nothing; the next real call decides. Only trustworthy hard-quota reset state is durable; other adaptive state is process-local.

The route budgets are:

| Provider | Scoring | Generation |
|---|---:|---:|
| Claude | 750 seconds | 750 seconds |
| Codex | 300 seconds | 900 seconds |

Configuration validates each provider independently. Normal settings satisfy `1 <= reserve < floor <= initial <= ceiling <= 8`. Setting a provider ceiling to 1 activates the emergency serialized profile (`reserve=0`, `floor=initial=1`). This is the operational rollback; cancellation and schema safety are not rolled back.

## Consequences

Scoring can start while generation is busy, without allowing untested mixed `8+8` occupancy. Capacity reacts to observed provider pressure instead of a permanent assumption. The policy adds explicit scheduler, capacity, and circuit state, which must be observable through active/queued counts, effective capacity, queue latency, strikes, circuit/probe state, held age, cancellation/forced kills, fallback, and recorder-loss metrics.

The application still owns orchestration because locally authenticated CLIs, post-dequeue budgets, repair sharing, diagnostic recording, and no-paid-work recovery do not match a general job framework's semantics.
