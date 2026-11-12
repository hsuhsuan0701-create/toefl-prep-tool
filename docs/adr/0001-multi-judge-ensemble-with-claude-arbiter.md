# Multi-judge ensemble with Claude as arbiter

Auto-scoring needs to be trustworthy enough to track real progress, but any single LLM scorer is noisy and hard to calibrate. We score every AI-scored Response with two independent Judges from different model families (Gemini and OpenAI, flagship audio-capable tiers, paid keys), then have Claude — running headlessly via `claude -p` with the project's rubric-bearing skills, free on the existing subscription — act as Arbiter using score-then-reconcile in a single call: it commits its own rubric-anchored score with cited evidence *before* the output section that reveals and reconciles the Judges' numbers, to mitigate anchoring on their average.

## Considered Options

- Single Claude scorer with median-of-3 reruns for simulations — rejected: same-model reruns share the same biases; cross-family disagreement carries more information.
- Full-information arbiter (Claude sees judge scores up front) — rejected: final scores collapse toward the judges' average, wasting the skills' rubric depth.
- Two-call blind arbiter (score call, then reconcile call) — deferred: kept as the documented escape hatch if M8 calibration shows the one-call variant still merely splitting judge differences. Note the one-call variant is output-order commitment, not true information blindness.

## Consequences

Calibration (`scripts/calibrate-writing.ts` and `scripts/calibrate-speaking.ts` against ETS's Calibration Samples, which ETS licenses and which therefore live only on a maintainer's machine; see `docs/official-rubrics.md`) must report per-judge and final accuracy separately. Adding a third judge family later is trivial (shared JudgeReport contract); removing Claude Code as a dependency is not.
