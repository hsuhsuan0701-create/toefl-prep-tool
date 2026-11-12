# Is the app's Listen and Repeat audio too fast? A measured answer

Research note, 2026-08-23. Read-only audit; no source was modified.

> **Since then (2026-11-12).** ETS licenses its sample material, so the repository no longer holds
> ETS's sample Speaking Set (`spk-8d9ee619`), the `docs/ets/` seed transcriptions, or rubric files
> transcribed from ETS (the shipped rubrics are now in this project's own words; ADR 0013). The
> original design spec cited below has been retired too. ETS's sample sentences that earlier versions
> of this note quoted have been removed; their word counts and timings are kept. File and line
> references describe the repository as it stood on 2026-08-23.

**The question.** Listen and Repeat practice in this app feels much harder than the real TOEFL is
expected to be. Is the audio too fast? Is it the accent? What rate does the app actually produce,
and is it aligned with what ETS uses for the 2026 iBT Speaking "Listen and Repeat" task?

**The short answer.** Rate is mostly not the problem. The app's current pipeline delivers a raw
median of **181.5 WPM** against real ETS Listen and Repeat audio at **179.6 WPM** — on target, and
targeted correctly, since ETS publishes no rate standard and measured official audio is the only
anchor there is. The **sentence length** is the problem: from item 4 onward the app's sentences carry
roughly 1.4–1.7× the words ETS uses, topping out at 22 (current median 21 at item 7) where three
independent official ETS item sets top out at 13–15 (Part 4). In a verbatim-repeat task that is the
dominant load term, and ETS's own published difficulty control for audio is length rather than speed.

Two secondary findings. **Items 4–5 do have a real rate spike** — 195.9 and 198.5 WPM against ETS's
175.2 and 179.2 — putting them above the single-pass intelligibility ceiling in the literature, so
length and rate compound exactly where the ramp turns. And the **accent mix is wrong, not merely
skewed** (corrected 2026-08-23 by the verification pass in Part 4): both 2025/2026 ETS source
documents list **three** accent regions — North America, the U.K., Australia — and **New Zealand is
not among them**. The app authorises New Zealand for Speaking and has drawn it for three of the six
Sets carrying a profile, while drawing British zero times.

**And one reframe worth having.** ETS's published Listen and Repeat rubric scores *accurate
repetition* first and *intelligibility* second; accent and prosody appear in the band descriptors
nowhere. "I couldn't catch every word" is not the wrong thing to be worried about — it is the
band-defining criterion.

## Evidence markers

Every claim below is tagged:

- **MEASURED** — computed in this audit from files in this repo, with the command shown.
- **ETS-STATED** — what ETS's own published documents state, paraphrased in this note's words, with
  a source.
- **ETS-MEASURED** — measured from official ETS-released audio, but measured by *this project*, not
  published by ETS.
- **INFERRED** — my reasoning over the above. Not a fact from either source.

## Method

Durations come from `ffprobe -v error -show_entries format=duration -of csv=p=0 <file>`
(ffprobe 8.0, Homebrew). Word counts use this repo's *own* counting regex, ported verbatim from
`server/src/services/audioPace.ts:23`, so the numbers are directly comparable to what the renderer
itself recorded:

```
/[A-Za-z0-9]+(?:['’-][A-Za-z0-9]+)*/g
```

Leading/trailing silence was measured with `ffmpeg -af silencedetect=noise=-40dB:d=0.10`. Both a
**raw** rate (words ÷ full file duration) and a **speech-only** rate (words ÷ duration minus
leading and trailing silence) are reported, because the padding turns out to be material.

Two population notes. All 16 Speaking Sets were measured (112 items). `spk-8d9ee619` is separated
out wherever it matters: it carries `source: "ets-sample"`, so its *sentences* are ETS's, but its
*audio* is not — see [Provenance of the ETS sample set](#17-provenance-of-the-ets-sample-set).
Per-item-index statistics therefore use the 15 generated Sets (105 items).

---

# Part 1 — What the app actually does

## 1.1 The TTS path

All text-to-speech now runs on one Gemini model. The model id is configuration, defaulted in
`server/src/lib/config.ts:321`:

```ts
geminiTtsModel: readNonBlank(process.env, "GEMINI_TTS_MODEL", "gemini-3.1-flash-tts-preview"),
```

**MEASURED.** The synthesis call is `server/src/services/tts.ts:143-175`. The request body carries
`contents`, `responseModalities: ["AUDIO"]` and a `speechConfig` naming a prebuilt voice. **There is
no rate, speed, or `speakingRate` field anywhere in it.** The `speed` parameter that `TtsRequest`
still declares (`tts.ts:19`) is only ever forwarded on the legacy OpenAI path (`tts.ts:104`), which
no current Set uses.

This is stated outright in `server/src/services/audioPrompt.ts:57-58`:

> Gemini's speech API has no rate parameter, so a correction can only be PROMPTED — there is no
> actuator to dial.

**INFERRED.** Pace is therefore an *instruction*, not a setting. The app asks for a speed in words
and measures what comes back. It cannot command one.

## 1.2 The exact pacing instruction sent to the model

`server/src/services/audioPrompt.ts:45-53` — the whole of the pace direction, verbatim:

```ts
export function pacingDirection(band: PaceBand): string {
  if (band.targetWpm <= 150) {
    return "Speak at a measured, unhurried pace, like a lecturer who wants each point to land before moving on.";
  }
  if (band.targetWpm <= 170) {
    return "Speak at an easy, conversational pace — neither rushed nor slow.";
  }
  return "Speak in a brisk, fluent delivery, the way someone speaks comfortably and at ease.";
}
```

**MEASURED.** Listen and Repeat items target 180 WPM (next section), which is `> 170`, so **every
Listen and Repeat item rendered by the current pipeline is synthesized under the "brisk, fluent
delivery" instruction** — the fastest of the three buckets. It is not possible for a Listen and
Repeat item to be rendered under either of the slower two.

**Scope caveat, and it matters for reading every number below.** This prompt module landed in
`934222b` and Speaking adopted it in `e21a8bd` (2026-08-12). Only the four Gemini-era Sets —
`spk-29dc6236`, `spk-7ed36c39`, `spk-d58bb9d4`, `spk-f5506f40` — were rendered through it. The
other twelve Sets predate it (OpenAI-era, with a numeric `speed` parameter, or earlier still with a
single hardcoded voice). Aggregate statistics over all 112 items therefore describe *the bank*, not
*the pipeline*. Both cuts are reported in §1.8.

The numeric target is deliberately kept out of the prompt (`audioPrompt.ts:41-44`): "a numeric WPM
in a prompt invites the model to recite it". So the model receives the adjective, never the number.

The full clip prompt is assembled by `buildDeliveryPrompt` (`audioPrompt.ts:195-213`) as
Audio Profile → Scene → Director's Notes (Style / Accent / Pacing) → delimiter → transcript. For a
Listen and Repeat item the Style and Scene lines come from
`server/src/services/speakingAudioRenderer.ts:95-99`:

```ts
"lr-item": {
  audioProfile: "one sentence a test taker will hear once and repeat",
  scene: "a single clear model sentence",
  style: "natural and unforced, clearly articulated without sounding dictated",
},
```

**INFERRED.** Note the internal tension. The Style line asks for delivery that does *not* sound
dictated; the Pacing line asks for "brisk". Meanwhile the generation guide's own stale hint at
`.claude/skills/toefl-speaking/references/generation-guide.md:124-126` describes the intended
delivery as "warm, **unhurried** staff-briefing delivery". That hint is a dead comment — TTS reads
`ROLE_DELIVERY`, not the generation guide — but it records that the original design intent for this
role was *unhurried*, and the shipped instruction is its opposite.

## 1.3 The configured pace targets

`server/src/services/speakingAudioRenderer.ts:61-66`:

```ts
export const AUDIO_ROLE_POLICY: Record<Role, PaceBand> = {
  "lr-briefing":        { targetWpm: 165, minWpm: 145, maxWpm: 195 },
  "lr-item":            { targetWpm: 180, minWpm: 150, maxWpm: 225 },
  "interview-intro":    { targetWpm: 165, minWpm: 145, maxWpm: 195 },
  "interview-question": { targetWpm: 155, minWpm: 130, maxWpm: 180 },
};
```

For comparison, `server/src/services/listeningAudioRenderer.ts:46-72`:

```ts
export const LISTENING_ROLE_POLICY = {
  "lcr-utterance": { targetWpm: 160, minWpm: 150, maxWpm: 170 },
  conversation:    { targetWpm: 162, minWpm: 150, maxWpm: 175 },
  announcement:    { targetWpm: 150, minWpm: 140, maxWpm: 160 },
  "academic-talk": { targetWpm: 148, minWpm: 140, maxWpm: 155 },
};
```

**MEASURED.** `lr-item` at 180 WPM is the fastest target in the codebase — faster than every
Listening role, and 25 WPM faster than the Interview questions. Its acceptance band is also by far
the widest: a 75-WPM span (150–225) against Listening's 10–25 WPM spans. A Listen and Repeat clip
may publish at 225 WPM without any gate firing.

**How that band is enforced: it isn't.** A clip that misses its band gets exactly one corrective
re-render (`server/src/services/audioPaceCorrection.ts:62-148`), and is then published either way
with an advisory note. The only hard failure is a 0.3×–3.0× sanity window catching a truncated or
stuck synthesis (`audioPace.ts:42-43`, `speakingAudioRenderer.ts:316-336`). Pace is recorded, not
enforced — deliberately, and the reasoning is documented at `speakingAudioRenderer.ts:26-59`.

## 1.4 Where 180 came from

**ETS-MEASURED, and this is the important part.** The 180 target is not a guess. It was derived by
measuring official ETS-released audio. The 2026-07-30 Speaking readiness design (no longer in the
repo; quoted here) said:

> By comparison, the seven official ETS Teacher Practice Test 5 L&R clips measure about 167–220 WPM
> with a median near 180 WPM. The ETS lesson-plan sample supplied for this work has a similar median
> near 182 WPM. ETS publishes no single numeric WPM requirement, so this design treats official
> released audio as a versioned calibration corpus rather than claiming an invented formal standard.

And among its non-goals:

> Do not claim that ETS publishes a numeric speech-rate standard; all WPM bands in this design are
> measured implementation targets derived from named official samples.

The per-clip measurements survive in the repo as a checked-in fixture,
`server/test/fixtures/ets-speaking-audio-calibration.json`, sourced from
`https://www.ets.org/content/dam/ets-org/pdfs/toefl/teacher-practice-test-5-audio-files.zip`:

| ETS PT5 clip | words | duration (s) | WPM |
|---|---|---|---|
| Listen_Repeat_Directions (briefing) | 23 | 8.751 | 157.7 |
| Listen_Repeat_1 | 9 | 2.679 | 201.6 |
| Listen_Repeat_2 | 8 | 2.273 | 211.2 |
| Listen_Repeat_3 | 11 | 3.004 | 219.7 |
| Listen_Repeat_4 | 9 | 3.082 | 175.2 |
| Listen_Repeat_5 | 9 | 3.014 | 179.2 |
| Listen_Repeat_6 | 13 | 4.676 | 166.8 |
| Listen_Repeat_7 | 14 | 4.676 | 179.6 |

**Median 179.6 WPM, range 166.8–219.7.** Word counts: 8, 9, 9, 9, 11, 13, 14 — **median 9, max 14.**

Two caveats on this fixture, in fairness:

1. **Data-quality flag (MEASURED).** Clips 6 and 7 carry an *identical* `durationSec` of 4.675918
   with different word counts. That is almost certainly a transcription slip in building the
   fixture. It matters slightly, because clip 7's 179.6 WPM is also the reported median. If clip 7's
   true duration is longer, the real median is lower and the app's relative position improves.
2. **Not independently reproducible from this repo.** The official audio is deliberately not
   vendored (design doc line 235: "Do not copy the official audio into the repository"), and the
   ETS PDFs were dropped in commit `278436a`. The fixture is derived metadata that I could not
   re-derive here. `scripts/audit-ets-speaking-audio.ts` rebuilds it from a locally downloaded
   official archive.

## 1.5 Voices and accents

**MEASURED.** There *is* accent variety in the design. `server/src/services/speakingAudioProfile.ts:31-36`
declares four: `north-american`, `british`, `new-zealand`, `australian`. One is drawn per Set from
`sha256("<profileVersion>:<setId>")` (`speakingAudioProfile.ts:54-66`), constant across all seven
Listen and Repeat items, with the Interview always drawing a different one. Accent is rendered as a
named region rather than a bare label (`audioPrompt.ts:27-32`) — e.g. "General New Zealand English,
as heard in Wellington" — plus an anti-caricature instruction (`audioPrompt.ts:37-38`).

The draw is **uniform across all four accents**. The design doc states the policy at lines 240-258
and specifies no weighting toward North American.

What is actually on disk is more lopsided:

| Listen and Repeat accent | Sets |
|---|---|
| (no profile recorded — pre-v1 renderer) | 10 |
| new-zealand | 3 |
| australian | 2 |
| north-american | 1 |
| **british** | **0** |

**INFERRED.** Two things follow. First, ten of sixteen Sets predate the accent profile entirely; the
design doc notes at line 27-28 that the pre-v1 renderer "hardcodes the `alloy` voice with a neutral
accent", so those 70 items are one American voice. Second, of the six Sets that *do* carry an
accent, five are New Zealand or Australian — including three of the four newest (Gemini-era) Sets,
which are the ones most likely to have been practised recently. British, the non-North-American
accent a test-taker is most likely to actually meet, has never been drawn.

## 1.6 What the app's own spec says about the task

`.claude/skills/toefl-speaking/references/rubric-listen-and-repeat.md:11-21` then transcribed ETS's
task facts (from the *Updated TOEFL iBT Test Overview*, p. 17, and the *Test Blueprint and
Specifications Document*, p. 6). In summary: **seven sentences** in one academic or campus-life
scenario, each heard **once** and repeated after a pause; length and syntactic difficulty rise over
the course of the scenario; each response window is at most **8 to 12 seconds**; and the response is
judged on whether it **repeats the sentence accurately** and **can be understood clearly**.

**ETS-STATED.** Note the last line carefully, because it bears directly on the question. The task is
scored on accurate repetition **and** intelligibility — not on intelligibility alone. The 0–5 scoring
guide the same file then transcribed (lines 30-86) makes this concrete: a 5 reproduces the prompt
word for word; a 4 tolerates one or two function words being dropped or altered; a 3 gets more than
half of the content words back. So *catching the words is genuinely half the construct*. "I couldn't
hold the whole sentence" is not the wrong failure mode to worry about — it is precisely the one the
rubric penalises.

The response windows are an app convention, flagged as such at
`rubric-listen-and-repeat.md:23-26`, fixed at 8/8/10/10/10/12/12 s in `shared/src/schemas.ts:25`.

### The sentence-length spec

`.claude/skills/toefl-speaking/references/generation-guide.md:104-116`:

| Item | Length | Structure | `responseWindowSec` |
|---|---|---|---|
| 1 | ≤ 8 words | one independent clause, simple SVO | 8 |
| 2 | ~8–10 words | one clause, compound subject or object | 8 |
| 3 | ~10–13 words | compound verb, or a prepositional chain | 10 |
| 4 | ~12–15 words | coordination (two clauses joined by and/but/or) | 10 |
| 5 | ~14–17 words | a dependent clause (when/if/because/after) | 10 |
| 6 | ~16–19 words | complex nominal phrase, or coordination + subordination | 12 |
| 7 | ≤ 22 words | a relative clause (or reduced relative), embedded | 12 |

**And then, four lines later** (`generation-guide.md:118-122`), the guide quoted item 7 of ETS's
zoo sample as "the model for the top of the ramp": a 14-word sentence (by the guide's count) built
on an embedded reduced relative, in entirely ordinary vocabulary.

**INFERRED — this is the miscalibration, visible in the spec itself.** The guide names ETS's own
top-of-ramp item at 14 words and, in the table immediately above, authorises 22. That is 57% more
words than the exemplar it cites as "the model for the top of the ramp". The table also mandates a
**monotonic** ramp ("Never let item N be simpler than item N−1"), which ETS's own zoo set does not
obey — its item 5 (9 words) is shorter than its item 4 (12 words). The app's ramp is both longer at
the top and stricter in shape than the material it was modelled on.

## 1.7 Provenance of the ETS sample set

`spk-8d9ee619` carries `source: "ets-sample"` and is the slowest Set on disk. It is tempting to read
it as an ETS baseline. **It is not, and must not be used as one.** Three independent lines of
evidence:

1. **The seed file forbade it.** The seed transcription it was imported from
   (`docs/ets/seed-speaking-1.txt`, since removed) told the importer to leave `audio` and
   `introAudio` empty, because text-to-speech runs as a separate stage after import. The seed was
   transcribed *text* from an ETS PDF, nothing more.
2. **The commit says so.** `4d76c7d` ("feat: seed question bank with official ETS sample sets"):
   "spk-8d9ee619: 7 official Listen and Repeat sentences (pp. 17-18) … **12 real TTS renders** under
   `data/audio/stimuli/spk-8d9ee619/`."
3. **The encoder fingerprint says so (MEASURED).** Its mp3s are 24 kHz mono at 128 kbps CBR with no
   encoder tag — byte-profile-identical to the other OpenAI-era app renders (`spk-57f76698`,
   `spk-fbe10c5d` and every pre-profile Set), and distinct from the Gemini-era renders, which are
   ~32 kbps and carry `TAG:encoder=Lavf61.7.100` from `tts.ts`'s own ffmpeg step.

It is also **pre-calibration**: it was rendered 2026-07-28, two days before `d0e9d40` introduced the
180 WPM target, and the design spec of the time (since retired) said official `ets-sample` Sets
are audited but never revoiced. Its audio therefore reflects neither ETS nor the current renderer.

**INFERRED.** Its one legitimate use is as a *within-renderer* contrast: same era, same engine,
ETS's shorter sentences (median 11 words) → 137.5 median WPM, against the generated Sets' longer
sentences → 142–193. That is consistent with the length→rate coupling described in §1.9, and
nothing more.

## 1.8 Measured: Listen and Repeat

**MEASURED.** All 112 items, all 16 Sets. Full per-item table in the [appendix](#appendix--raw-measurements).

| population | n | min | median | max |
|---|---|---|---|---|
| **raw WPM**, all items | 112 | 94.7 | **162.8** | 223.7 |
| raw WPM, 15 generated Sets | 105 | 94.7 | 164.2 | 223.7 |
| **speech-only WPM**, 15 generated Sets | 105 | 99.8 | **185.3** | 284.4 |
| words per sentence | 112 | 5 | 13 | 22 |
| duration (s) | 112 | 2.26 | 4.50 | 8.45 |

**Padding is material.** Median leading+trailing silence is **0.51 s** per clip (range 0.00–1.20 s).
On a 4.5 s clip that is 11% of the file. The speech itself therefore runs at a median of **185.3
WPM**, about 21 WPM above the raw figure.

### The current pipeline is faster than the bank average

**MEASURED — and this is the cut that matters most.** Splitting by render era (see the scope caveat
in §1.2), the four Sets rendered through the current Gemini prompt behave differently from the
twelve older ones:

| cohort | n | raw WPM (min/med/max) | speech-only WPM (min/med/max) | words (min/med/max) |
|---|---|---|---|---|
| **v2 Gemini — current prompt** (4 Sets) | 28 | 143.7 / **181.5** / 218.0 | 169.7 / **212.6** / 284.4 | 6 / **14** / 22 |
| pre-v2 (11 generated Sets) | 77 | 94.7 / 161.3 / 223.7 | 99.8 / 178.8 / 260.9 | 5 / 13 / 20 |

**INFERRED.** The bank-wide median of 162.8 WPM is dragged down by twelve legacy Sets. The pipeline
that generates Sets *today* produces a **raw median of 181.5 WPM** — essentially exactly its 180
target, and essentially exactly ETS's measured 179.6. On the raw measure the current renderer is
well calibrated.

Its per-index profile, however, is not:

| item | v2 median words | v2 raw WPM | v2 speech WPM | v2 median dur | ETS PT5 words | ETS PT5 WPM |
|---|---|---|---|---|---|---|
| 1 | 6.5 | 159.6 | 224.0 | 2.26 s | 9 | 201.6 |
| 2 | 9 | 164.2 | 213.6 | 3.28 s | 8 | 211.2 |
| 3 | 11 | 168.7 | 199.0 | 4.14 s | 11 | 219.7 |
| 4 | 14 | **195.9** | 231.6 | 4.40 s | 9 | 175.2 |
| 5 | 15 | **198.5** | 233.8 | 4.70 s | 9 | 179.2 |
| 6 | 17 | 185.8 | 209.2 | 5.63 s | 13 | 166.8 |
| 7 | **21** | 182.2 | 201.9 | 6.76 s | 14 | 179.6 |

**INFERRED, and this is the sharpest result in the audit.** At items 4 and 5 the current pipeline
delivers **~55–67% more words than ETS at ~12% higher rate simultaneously**. ETS's item 5 is 9 words
in 3.01 s; the app's is 15 words in 4.70 s. The two load terms do not trade off — they compound. And
item 7 now sits at a median of **21 words**, one word under the 22-word cap the generation guide
allows, against ETS's 14.

Per-set medians (from the coordinator's independent run; my totals reproduce theirs exactly):

| Set | median WPM | max WPM | median words |
|---|---|---|---|
| spk-0d5886fd | 142.9 | 159.0 | 12 |
| spk-26132ac6 | 185.7 | 223.7 | 13 |
| spk-29dc6236 | 158.4 | 179.3 | 12 |
| spk-43ab8b09 | 168.1 | 214.3 | 14 |
| spk-57f76698 | 180.4 | 189.2 | 14 |
| spk-6ea06d6c | 166.7 | 177.4 | 14 |
| spk-70c8a41a | 142.0 | 182.3 | 14 |
| spk-7ed36c39 | 193.4 | 216.5 | 14 |
| spk-82a09237 | 157.0 | 166.1 | 12 |
| spk-89911631 | 153.4 | 181.0 | 13 |
| **spk-8d9ee619** (ETS text, app audio) | **137.5** | 173.4 | **11** |
| spk-d58bb9d4 | 183.4 | 215.1 | 15 |
| spk-e5b2b735 | 177.7 | 187.8 | 11 |
| spk-f22a5687 | 149.5 | 167.5 | 13 |
| spk-f5506f40 | 180.9 | 218.0 | 14 |
| spk-fbe10c5d | 176.6 | 199.0 | 15 |

## 1.9 Measured: the ramp, item by item

**MEASURED**, 15 generated Sets, against the two ETS references.

| item | app median words | app median WPM | app median dur | app speech WPM | ETS zoo words | ETS PT5 words | ETS PT5 WPM | ETS PT5 dur |
|---|---|---|---|---|---|---|---|---|
| 1 | 7 | 157.7 | 2.66 s | 168.2 | 6 | 9 | 201.6 | 2.68 s |
| 2 | 8 | 154.1 | 3.36 s | 177.1 | 9 | 8 | 211.2 | 2.27 s |
| 3 | 11 | 169.8 | 4.10 s | 188.0 | 11 | 11 | 219.7 | 3.00 s |
| 4 | 14 | 161.3 | 4.54 s | 180.6 | 12 | 9 | 175.2 | 3.08 s |
| 5 | **15** | 177.7 | 5.06 s | 188.9 | **9** | **9** | 179.2 | 3.01 s |
| 6 | **17** | 176.6 | 6.22 s | 191.7 | **11** | **13** | 166.8 | 4.68 s |
| 7 | **19** (max 22) | 174.0 | 6.77 s | 180.4 | **13** | **14** | 179.6 | 4.68 s |

**Three findings, all INFERRED from the rows above.**

1. **The length gap opens at item 4 and never closes.** Items 1–3 match ETS well. From item 5 the
   app carries 15 words where both ETS references carry 9 — **+67%**. At item 7 it carries 19
   (median) or 22 (max) against ETS's 13–14 — **+36% to +69%**.

2. **ETS's rate profile is the inverse of the app's.** ETS delivers its *short* early sentences
   fastest (201.6 / 211.2 / 219.7 WPM at 8–11 words) and *slows down* as sentences lengthen
   (166.8–179.6 WPM at 13–14 words). The app does the opposite: slow at item 1–2 (157.7 / 154.1),
   accelerating to its fastest at items 5–6 (177.7 / 176.6). ETS trades rate against length to keep
   memory load roughly flat. The app lets both rise together.

3. **The compounded result is clip duration.** ETS's hardest item is 4.68 s of speech. The app's is
   6.77 s at the median and 8.45 s at the maximum — **45% to 81% more continuous speech to hold in
   working memory before the recorder opens.** That, not WPM, is the number that tracks how hard a
   repeat-back item feels.

## 1.10 Measured: Listening stimuli, for comparison

**MEASURED.** All 324 Listening clips across 9 Sets, transcripts joined across speaker turns for
conversations.

| role | n | median words | median dur | min WPM | median WPM | max WPM | configured band |
|---|---|---|---|---|---|---|---|
| lcr-utterance | 180 | 6 | 2.8 s | 88.0 | 139.5 | 186.2 | 160 (150–170) |
| conversation | 63 | 102 | 38.3 s | 138.2 | 160.5 | 184.3 | 162 (150–175) |
| announcement | 45 | 63 | 26.1 s | 117.9 | 145.8 | 165.0 | 150 (140–160) |
| academic-talk | 36 | 173 | 73.0 s | 128.3 | 142.7 | 157.7 | 148 (140–155) |
| **all Listening** | **324** | | | 88.0 | **144.6** | 186.2 | |

**INFERRED.** The two sections are correctly separated: Listen and Repeat (162.8 raw / 185.3
speech-only) runs meaningfully faster than Listening (144.6), which is right — ETS's own Listen and
Repeat audio is faster than lecture or conversation speech. Listening's longer roles sit at or
slightly below their targets; `lcr-utterance` undershoots its 150–170 band badly at a 139.5 median,
which is a separate (and opposite-signed) calibration issue not pursued here.

**Followed up and CLOSED by issue #108.** It was not opposite-signed — it was the same finding, on
the role the padding hits hardest. On the speech scale those utterances run at a 170 WPM median, at
the old band's own ceiling; the 139.5 above is 0.68 s of silence being charged as speech to a 2.8 s
clip. Listening now measures speech duration like Speaking, and `lcr-utterance` is re-banded to
170 (135–205). Derivation and the decision for the other three roles:
`2026-08-23-listening-role-band-recentring.md`.

---

# Part 2 — What ETS publishes

Sources consulted, all fetched in full:

| Document | URL |
|---|---|
| *TOEFL iBT Test: 2026 Update — Test Blueprint and Specifications* | <https://www.ets.org/pdfs/toefl/toefl-ibt-test-specifications-2026.pdf> |
| *TOEFL iBT Technical Manual*, ETS RR-25-12 / TOEFL RR-106 (Manna et al., Oct 2025) | <https://rr.ets.org/index.php/etsrr/article/view/28> · full text <https://files.eric.ed.gov/fulltext/EJ1487502.pdf> |
| *Speaking Scoring Guide* (© 2025 ETS) | <https://www.ets.org/pdfs/toefl/speaking-rubrics.pdf> |
| ETS TOEFL iBT Speaking Section page | <https://www.ets.org/toefl/test-takers/ibt/about/content/speaking.html> |
| ETS TOEFL iBT Listening Section page | <https://www.ets.org/toefl/test-takers/ibt/about/content/listening.html> |

## 2.1 The task is official, and the app's shape matches

**ETS-STATED.** Listen and Repeat is one of exactly two Speaking task types, with **7 scored
questions** (Take an Interview has 4), 0–5 each, Speaking raw 0–55, section ≈ 8 minutes, Speaking
displayed 4th. The app's 7 + 4 structure and 0–5 scale are correct.

**ETS-STATED.** Per the *Technical Manual* (§II-6), each sentence is followed by a pause, after which
the test taker repeats it word for word, and the sentences grow in length and complexity over the
course of the scenario.

**ETS-STATED.** Speaking is **linear, not adaptive**: in both the Writing and the Speaking section,
everyone who takes a given form gets the identical tasks (*2026 Blueprint*, Blueprint Table Note 5).

So the within-task difficulty ramp is pre-authored and fixed — exactly as the app models it. Only
Reading and Listening are two-stage adaptive.

## 2.2 Sentence length — ETS's own numbers

**ETS-STATED**, qualitatively: Listen and Repeat uses **short sentences**
([Speaking Section page](https://www.ets.org/toefl/test-takers/ibt/about/content/speaking.html)).
The *2026 Blueprint*'s difficulty spec elaborates: the task is repetition of single sentences whose
length and syntactic complexity grow from item to item. An early item can be a short, simple sentence
with a single main clause; later items run longer and carry heavier grammar, such as verbs joined in
pairs, subordinate and relative clauses, and long noun phrases.

**ETS does not publish a word-count range.** The quantitative windows are ETS's complete worked
7-sentence examples.

> **Correction, 2026-08-23 (verification pass, Part 4).** This section originally attributed the
> *zoo* scenario to *Technical Manual* Figure 11 and gave its counts as 6–13 words, mean ≈ 10.1.
> That conflated two distinct official item sets. Figure 11 is the **campus gym** scenario; the zoo
> scenario is the separate ETS sample then transcribed into `docs/ets/seed-speaking-1.txt`. Both are
> genuine ETS material, so the conclusion is unchanged — but there are **three** official item sets,
> not two, and the true ceiling is 15, not 13.

Counted directly from the source documents:

| Official ETS item set | Word counts, items 1–7 | Max |
|---|---|---|
| *Technical Manual* (RR-25-12) Figure 11 — campus gym | 5, 6, 6, 11, 8, 10, 15 | **15** |
| ETS sample — zoo (then in `docs/ets/seed-speaking-1.txt`) | 6, 9, 11, 12, 9, 11, 13 | **13** |
| Teacher Practice Test 5 (`ets-speaking-audio-calibration.json`) | 9, 8, 11, 9, 9, 13, 14 | **14** |

**INFERRED.** Three independent official item sets put ETS's real ceiling at **13–15 words**. The app
authorises 22 and currently delivers a median of 19–21 at item 7.

**ETS-STATED, and relevant to the ramp shape:** ETS's own example is *not* monotonic in length — its
item 5 (9 words) is shorter than its item 4 (12 words), because progression is by syntactic
complexity as much as raw length. The app's strict monotonic requirement
(`generation-guide.md:100-102`) is stricter than ETS's own practice.

## 2.3 What the task is scored on

This is the crux, and the answer is **both, leaning hard toward verbatim accuracy.**

**ETS-STATED — construct.** *2026 Blueprint*, Speaking Section table: the subskill is reproducing
spoken sentences **accurately and intelligibly**. The *Technical Manual* gives the same two criteria
the repo then transcribed: the response must repeat the sentence accurately, and it must be easy to
understand.

Note what is **absent**: Take an Interview's subskill explicitly names **prosody**, which must be
intelligible; Listen and Repeat's does not.

**ETS-STATED — the published rubric** ([Speaking Scoring Guide](https://www.ets.org/pdfs/toefl/speaking-rubrics.pdf),
also *Technical Manual* Figure A3, which the repository's then-transcribed
`rubric-listen-and-repeat.md` matched verbatim; the shipped file is now in this project's own words,
ADR 0013). Every band
boundary is drawn on **completeness and fidelity of the repetition**; intelligibility enters only as
a secondary modifier from band 3 down. Band 5 is a word-for-word reproduction of the prompt.

**The rubric contains no mention of accent, intonation, rhythm, stress, or prosody.** By contrast
the Take an Interview rubric explicitly grades rhythm and intonation, and whether the pace of speech
is conversational. **INFERRED:** a test-taker with a strong L1 accent who reproduces the sentence
exactly and intelligibly scores 5. Accent is not penalised.

**ETS-STATED — what the engine actually measures.** *Technical Manual*, Table 5 (Speaking — Listen
and Repeat):

| Dimension | Feature examples |
|---|---|
| Fluency | how fast the test taker speaks; how long the stretches of speech without a break are; how many pauses; how many hesitations |
| Intelligibility | how accurate the pronunciation is; how natural the rhythm is; how natural the prosody is |
| Repeat accuracy | how many words come back correctly; how close the response is to the prompt |

So prosody and pronunciation *are* measured, under Intelligibility — but they never appear as band
descriptors. **ETS does not publish the weighting between these three dimensions.**

**INFERRED — the practical answer to the user's framing.** "I couldn't catch every word" is **not**
the wrong failure mode to optimise. It is the band-defining one. Prep-industry claims that Listen and
Repeat is scored on "pronunciation, intonation and fluency" invert ETS's actual emphasis. Recall
fidelity is the ladder; intelligibility is a gate.

**ETS-STATED — reliability.** Speaking α = 0.94, SEM = 0.22 (*Technical Manual* Table 11) — the
highest-reliability section of the four. Band 5–5.5 maps to CEFR C1 (Table 9).

## 2.4 Speech rate — what ETS publishes

### ETS does not publish this.

**ETS-STATED (absence verified).** Full-text search of the *2026 Blueprint*, the *Technical Manual*,
the *Speaking Scoring Guide* and the public Speaking/Listening pages for `rate | speed | tempo |
words per minute | wpm | syllables per second` returns **no figure for stimulus delivery speed**. In
the *Technical Manual* the only hits for "speaking rate" are as a feature of the **test-taker's own
scored speech** (Tables 5 and 6), not of the audio played to them.

The sole ETS characterisation of stimulus pace is qualitative: the *2026 Blueprint*'s Listening Audio
Difficulty spec says only that the audio is spoken at a **natural pace**.

**There is no ETS-published WPM target for Listen and Repeat, or for any TOEFL audio.** Any numeric
target — including this repo's 180 — is a measured implementation choice, not an ETS requirement.
The repo already stated this correctly in the Speaking readiness design's non-goals, quoted in §1.4.

**ETS-STATED — what ETS *does* specify is length, not rate.** *2026 Blueprint*, Listening Audio
Difficulty: the shortest audio input is a brief utterance capped at **six stressed syllables**, the
longest a monologue of as many as **250 words**, and mid-length input usually runs **35 to 100
words**. **INFERRED:** ETS's published control on listening difficulty is *how much material*, not
*how fast* — the same axis this audit finds the app miscalibrated on.

### The one measured TOEFL figure in the literature

**ACADEMIC.** Nishizawa, H. (2024), "Authenticity of academic lecture passages in high-stakes tests:
A temporal fluency perspective," *Language Testing*.
<https://doi.org/10.1177/02655322241262453>

| Source | Speech rate (syll/min) | Articulation rate (syll/min) |
|---|---|---|
| Authentic university lectures (FCAEL) | 215.51 | 287.81 |
| **TOEFL iBT lecture passages** | **231.54** | 278.61 |
| IELTS lecture passages | 205.24 | 259.83 |

TOEFL's lecture passages run *faster* than authentic lectures on overall speech rate (fewer, shorter
pauses). **INFERRED conversion** (mine, not the author's), at Tauroza & Allison's 240 spm ÷ 170 wpm
= 1.41 syllables/word: TOEFL iBT lectures ≈ **164 wpm**.

Caveats: three lecture passages only, from the **pre-2026** Listening section. Says nothing about
Listen and Repeat. No ETS Research Report, TOEFL Research Insight volume, or T2K-SWAL study reports
a measured WPM for TOEFL audio.

### Academic consensus on natural English speech rates

**ACADEMIC.** Tauroza, S. & Allison, D. (1990), "Speech Rates in British English," *Applied
Linguistics* 11(1), 90–105. <https://academic.oup.com/applij/article/11/1/90/255991>
Combined mean **170 wpm / 240 syllables per minute**. Proposed normative bands: <100 wpm slower than
normal, 100–125 moderately slow, **125–160 average**. Per genre (secondary reproductions of the
paywalled table): lectures ~125–160 wpm; interviews ~160–210; conversation ~190–230.

**The user's cited ranges need one correction.** "~150–190 conversational, ~100–150 lecture" is
close but slightly low on both. Tauroza & Allison put conversation at the *top* of the range
(190–230) and lectures at 125–160. A 2021 BBC-corpus replication (200 speakers, 78 hours) reports
conversation at **222 wpm** and academic lecture at **173 wpm**, claiming a ~17% upward drift over
30 years — though that appeared in a low-tier venue
(<https://francis-press.com/uploads/papers/pv7j7Z9uRgQyPUxnVTDTPecUAEP0HJcWWhGErVeD.pdf>) and should
be weighted accordingly.

**ACADEMIC — and this is the most decision-relevant citation in the whole note.**

- **Griffiths, R. (1992)** tested lower-intermediate Japanese EFL learners at **128 / 188 / 250 wpm**.
  Comprehension at the slow rate was significantly higher than at both the average and fast rates,
  and there was **no significant difference between 188 and 250 wpm** — i.e. by 188 wpm the listener
  has already saturated, and going faster costs little more because comprehension has already
  collapsed.
- **Rodero, E. (2012)**, *Text & Talk*,
  <https://www.degruyterbrill.com/document/doi/10.1515/text-2012-0019/html> — the recommended
  broadcast rate is **160–180 wpm**; faster rates with fewer pauses correlated with reduced
  intelligibility. Directly relevant because radio, like a test item, is single-pass with no visual
  support and no replay.

**INFERRED synthesis.** For a single-pass, no-replay listening task the literature converges on
~125–160 wpm comfortable, **160–180 wpm as the practical intelligibility ceiling**, and >190 wpm as
degraded for anyone below advanced proficiency.

## 2.5 Accents

**ETS-STATED — and it explicitly covers Speaking.** Both test-taker pages, the
[Speaking Section page](https://www.ets.org/toefl/test-takers/ibt/about/content/speaking.html) and
the [Listening Section page](https://www.ets.org/toefl/test-takers/ibt/about/content/listening.html),
give the same four regions for the native-speaker English accents a test taker may hear: North
America, the U.K., New Zealand, and Australia. Accent variety **did carry over** to the enhanced
format, and ETS applies the claim to Speaking.

~~The *Technical Manual* §II-4 repeats the four-region list for Listening.~~

> **Correction, 2026-08-23 (verification pass, Part 4).** This is **false**, and it inverted the
> conclusion of this section. *Technical Manual* (RR-25-12) §II-4 states **three** regions, and
> New Zealand is **absent**: the task audio uses speakers whose accents come from three regions,
> North America, the U.K. and Australia.
>
> This agrees with the *2026 Test Specifications* summarised below. Both 2025/2026 source documents
> exclude New Zealand; only the undated public test-taker web page includes it.

**Discrepancy worth recording.** The *2026 Blueprint* gives a **different, three-way** list, scoped
to Listening only, and adds a synthesis disclosure: ETS produces Listening stimuli with AI-generated
audio, plus human voice actors in some cases, and aims for a roughly even mix of regional accents and
of voice genders, giving **British, Australian and U.S./Canadian English** as example varieties.

New Zealand is **absent** there too, as it is from the *Technical Manual* (correction above); only
the public pages carry it. The Blueprint's Speaking Stimulus spec makes **no accent statement at all**.

**ETS does not publish** any weighting or proportion across accents. A roughly even mix is as
specific as it gets, and that statement is scoped to Listening.

**INFERRED.** The app's four-accent list matches only the public Speaking page. Against the two
specification documents it includes an accent the test does not use, New Zealand, so the *set* of
accents is wrong as well as the mix (§4.4). Nor does ETS license the app's **uniform 25% draw** —
the only ETS statement touching proportion is the roughly even mix, and that is about Listening. A
uniform draw across four accents is a defensible reading of an even mix, but it is an app decision,
not an ETS requirement.

## 2.6 What ETS does not publish

Stated explicitly rather than filled in. Verified by full-text search of the *2026 Blueprint*, the
*Technical Manual*, the *Speaking Scoring Guide*, and the public pages:

1. **Any speech rate for any TOEFL audio stimulus** — no wpm, no syllables/second, Listening or
   Speaking. Only that the delivery is natural.
2. **Word- or syllable-count range for Listen and Repeat sentences.** Only that the sentences are
   short, plus the complexity progression. ETS's three complete worked examples (§2.2, §4.2) are the
   only quantitative window.
3. **Per-item response time for Listen and Repeat.** Zero occurrences of "seconds" in the *Technical
   Manual*. See the conflict note below.
4. **Preparation time** for Listen and Repeat, in either direction.
5. **Whether the Listen and Repeat sentence plays once.** ETS says each recording is heard a single
   time, but says it of the **Listening** section only; no equivalent statement is scoped to Speaking.
6. **Accent policy for Speaking audio in the specification documents** — the Blueprint's accent
   statement is scoped to Listening.
7. **Reconciliation of the three-region vs four-region accent lists.**
8. **Weighting between Fluency / Intelligibility / Repeat accuracy.**
9. **Whether Listen and Repeat stimuli are AI-generated or human-voiced.** The Blueprint discloses
   AI-generated audio for *Listening*; it makes no such disclosure for Speaking.

### A sourcing conflict this repo should resolve

`rubric-listen-and-repeat.md:18` states, as an ETS fact, that test-takers get at most **8 to
12 seconds**, citing the *Updated TOEFL iBT Test Overview* p. 17. The independent search above
could **not** find any per-item timing in the *2026 Blueprint*, the *Technical Manual*, or the
*Speaking Scoring Guide*, and found that the leading secondary source repeating the 8/10/12 schedule
does not attribute it to ETS either.

These are not necessarily in conflict — the *Test Overview* is a different document, and it was
dropped from this repo in commit `278436a`, so the transcription cannot be checked here. **The
citation may well be correct.** But it is currently unverifiable in-repo and unconfirmed in the three
ETS documents that *are* reachable. Worth re-verifying against the Overview PDF before treating the
8–12 s range as settled ETS fact; if it cannot be confirmed, it should be relabelled the way the
response-window *ramp* already correctly is.

---

# Part 3 — Verdict

## Is the audio too fast?

**Overall, no — but with one real exception that has been missed.**

Bank-wide, the app's Listen and Repeat items run at a **median 162.8 WPM** raw against official ETS
Listen and Repeat audio at **179.6 WPM** — about 9% *slower*. The current pipeline (the four
Gemini-era Sets) runs at **181.5 WPM**, essentially exactly on both its 180 target and ETS's measured
179.6. As an aggregate, the rate is well calibrated, and it is calibrated the right way: against
measured ETS audio, with the repo correctly declining to claim ETS publishes a standard.
**ETS-STATED confirmation from Part 2: ETS publishes no speech-rate figure at all**, so measured
official audio is the only anchor available and the repo used it.

**The exception is items 4 and 5.** The current pipeline delivers them at **195.9 and 198.5 raw WPM**
against ETS's **175.2 and 179.2** for the same positions. Those two items sit:

- ~12% above ETS's own rate at that point in the ramp;
- above Rodero's 160–180 wpm single-pass broadcast intelligibility ceiling (ACADEMIC, §2.4);
- at or past Griffiths' 188 wpm saturation point, beyond which L2 comprehension had already
  collapsed for lower-intermediate learners (ACADEMIC, §2.4).

So "the audio is too fast" is wrong as a blanket claim and **right about the middle of the ramp**.
If practice feels like it falls apart around items 4–5, that is a real, locatable defect, not a
misperception.

Two honest qualifications:

- The app's *speech-only* rate (185.3 bank-wide, **212.6** for the current pipeline) is well above
  ETS's raw 179.6. That comparison is **not apples-to-apples** — the ETS clips almost certainly
  carry their own padding, and their audio is not in this repo, so I could not compute their
  speech-only rate. The defensible comparison is raw-to-raw. It is worth knowing that once the
  ~0.5 s of padding is removed, the speech itself is fast; it is not evidence that it is faster
  *than ETS*.
- The spread is much wider than ETS's, because the 225 WPM ceiling is advisory-only and never fails
  a render. Items publish from 94.7 to 223.7 WPM.

## Is it the accent?

**Partly — and both the app's accent *set* and its *mix* are off (§4.4).**

The app is not monotonously one accent. It draws from north-american / british / new-zealand /
australian, which matches the list on ETS's public Speaking page (§2.5) but not the three regions
both specification documents give: North America, the U.K. and Australia, without New Zealand
(§4.4). On the question "does the app expose me to the right accents," the answer is no for New
Zealand, and British has not been drawn at all.

The realised distribution is where it goes wrong. Of the six Sets carrying an accent profile: three
New Zealand, two Australian, one North American, **zero British**. Three of the four newest Sets are
New Zealand or Australian. The draw is uniform by design (25% each), so half of all future Sets will
be NZ or Australian.

**INFERRED.** ETS gives no proportion — the only statement touching it is that the accent mix is
roughly even, and that is scoped to Listening, not Speaking (§2.5, §2.6 item 6). A uniform draw
is a defensible reading of an even mix, but it is an app decision, and it plausibly over-weights the
two accents a Taiwanese test-taker has had least exposure to. If recent practice has been on the
newest Sets, accent is a specific and quite likely contributor to the difficulty jump.

Two counterweights, in fairness:

- The ten older Sets are a single hardcoded American voice, so accent robustness is *under*-trained
  across the bank as a whole. The two problems point opposite ways.
- **ETS-STATED, and it should be reassuring: accent is not scored.** The published Listen and Repeat
  rubric mentions accent, intonation, rhythm, stress and prosody **nowhere** (§2.3). An accent that
  makes the *stimulus* harder to decode costs real marks through failed recall; the test-taker's own
  accent does not.

## Is the sentence length beyond what ETS uses?

**Yes. This is the actual miscalibration, and it is now confirmed against three independent official
item sets.**

ETS's real ceiling is **13–15 words**: the *Technical Manual* Figure 11 campus-gym scenario runs 5–15
words, ETS's zoo sample 6–13 (mean 10.1), and Teacher Practice Test 5 8–14 (median 9) (§2.2, §4.2).
The app authorises **22** and the current pipeline delivers a **median of 21** at item 7. From item 4
onward its sentences run 1.4–1.7× ETS's word count.

The app's own spec contains the contradiction in plain sight: `generation-guide.md:118-120` names
ETS's 14-word item as "the model for the top of the ramp", and the table eight lines above it
permits 22.

**Two aggravating factors, both INFERRED.**

1. **ETS's published difficulty control is length, not rate.** The *2026 Blueprint* specifies audio
   input by amount (from a cap of six stressed syllables up to 250 words, with mid-length input
   usually 35 to 100 words) and says of pace only that it is natural (§2.4). The one dimension ETS
   actually specifies is the one the app overshoots.
2. **The load terms compound instead of trading off.** ETS delivers its short early items fast
   (201–220 WPM) and slows as sentences lengthen (167–180). The current pipeline does the reverse,
   peaking at items 4–5. ETS's hardest item is 4.68 s of speech; the app's is 6.77 s at the median
   and 8.45 s at the maximum — **45–81% more continuous speech to hold** before the recorder opens.

And it matters more here than it would in a comprehension task, because **ETS-STATED (§2.3), band 5
requires a word-for-word reproduction of the prompt.** Length is not a stylistic choice in a verbatim-repeat
task; it *is* the difficulty.

## Is this my fault or the tool's?

**Mostly the tool's, and specifically on length rather than rate.** A fair, non-flattering split:

- **The tool is miscalibrated on sentence length. This is the largest single term.** Not
  marginally — items 5, 6 and 7 are substantially longer than anything ETS has published for this
  task, confirmed against three independent official item sets. If Listen and Repeat practice feels
  harder than the real test, that perception is **correct**, and this is the main reason. That is
  not reassurance; it is what the numbers say.
- **The tool is miscalibrated on rate at items 4–5 specifically**, running ~196–199 WPM where ETS
  runs 175–179, above both the broadcast intelligibility ceiling and the L2 saturation point in the
  literature. Smaller than the length term, but real and easy to fix.
- **The tool is well calibrated on rate overall.** The 180 target came from measuring real ETS
  audio, ETS publishes no standard to check it against, and the current pipeline's 181.5 median
  lands on it. Do not lower the overall target — that would make practice *less* exam-faithful.
- **The tool draws New Zealand English, which the test does not use, and has never drawn British**
  (§4.4); its uniform draw also over-samples New Zealand and Australian accents.
- **Some of it is genuinely the test-taker's level, and should not be explained away.** ETS's real
  audio hits 201–220 WPM on items 1–3 — *faster than anything the app produces at those indices*
  (159.6 / 164.2 / 168.7). The app's early items are **too easy**, so a real gap at the start of the
  ramp is currently going untested. And the rubric is unambiguous that exact recall is the score-5
  criterion, so "I could not hold every word" is the right thing to be training, not a
  misdiagnosis.
- **One structural point in the tool's favour:** the drill is exam-faithful on replay. Even in Drill
  mode "Each item plays once; there are no replays" (`client/src/pages/SpeakingDrill.tsx:564`),
  matching ETS's rule that each sentence is repeated a single time. There is currently no easier practice mode to fall back to,
  which makes every practice run maximally hard.

**Net.** The length overshoot is the tool's fault and dominates. The items 4–5 rate spike is the
tool's fault and is second. The accent mix is the tool's fault and is third. The overall rate is not
a fault at all. And there is a genuine residual skill gap that the app's *early* items are currently
too slow to expose — so the honest summary is that the app is simultaneously **too hard in the
middle and at the top, and too easy at the bottom**.

One thing worth internalising from Part 2, because it reframes what to practise: **accent is not
scored, and prosody appears nowhere in the Listen and Repeat band descriptors.** The published
ladder is built on how much of the sentence comes back intact. Effort spent on sounding native is
worth less here than effort spent on holding longer spans — which is exactly the capacity the app is
currently over-taxing.

---

# Remediation options

Listed for a decision when this was written. Sets are immutable, so all of these affect newly
generated Sets only; the existing bank keeps its current audio.

**Status.** R1 landed as issue #59 (the retuned ramp table plus a `speakingConformance.ts` gate).
R2 and R3's duration ceiling landed together as issue #63: per-item targets 200/208/215/180/178/176/175,
recorded in a new `ets-2026-v4` audio profile, with the faster `pacingDirection` bucket R2 calls for
(issue #112 later added another, so `audioPrompt.ts` now has five) and a 5.0-second clip ceiling
enforced at generation. R3's proposed grouped targets were superseded by the per-item ramp; R4
landed separately as issue #60 (three-accent draw, `ets-2026-v3`). R5–R9 remain open. Getting the
benefit still means regenerating the Speaking bank.

**R1 — Retune the ramp table to ETS-observed lengths (highest value).**
`.claude/skills/toefl-speaking/references/generation-guide.md:104-112`. Target band, derived from the
two ETS references (zoo: 6/9/11/12/9/11/13; PT5: 9/8/11/9/9/13/14):

| Item | current | proposed |
|---|---|---|
| 1 | ≤ 8 | 6–9 |
| 2 | ~8–10 | 8–10 |
| 3 | ~10–13 | 9–12 |
| 4 | ~12–15 | 9–13 |
| 5 | ~14–17 | **10–13** |
| 6 | ~16–19 | **11–15** |
| 7 | ≤ 22 | **≤ 16** (ETS max observed 14; 16 allows headroom without a 57% overshoot) |

Add a hard cap in `shared/src/schemas.ts` alongside `RESPONSE_WINDOW_RAMP` so an over-long item is
rejected at generation rather than silently banked. Note this will collide with the current
monotonic-ramp requirement (`generation-guide.md:100-102`), which ETS's own zoo set violates —
relaxing "strictly monotonic" to "non-decreasing in difficulty, allowing a length dip" would match
the source material better.

**R2 — Make the pace target index-aware, mirroring ETS's own profile (second-highest value).** ETS
runs its short items fast and its long items slower; the current pipeline peaks at items 4–5, which
is where ETS is already slowing down. `AUDIO_ROLE_POLICY` (`speakingAudioRenderer.ts:61-66`) has one
`lr-item` band for all seven. Splitting it to reproduce ETS's observed shape:

| item | ETS PT5 measured | proposed target | current actual |
|---|---|---|---|
| 1–3 | 201.6 / 211.2 / 219.7 | **200** (band 180–225) | 159.6 / 164.2 / 168.7 |
| 4–5 | 175.2 / 179.2 | **178** (band 160–195) | **195.9 / 198.5** |
| 6–7 | 166.8 / 179.6 | **172** (band 155–190) | 185.8 / 182.2 |

This makes early items *harder* (correctly — they are currently well below ETS) and the middle and
top easier, stopping length and rate from compounding. Requires a fourth `pacingDirection` bucket
above ~190 to express "fast" distinctly from "brisk" (`audioPrompt.ts:45-53`), and a `Role`-plus-index
key or a per-clip band on `SpeakingClipSpec`, since `Role` alone cannot currently distinguish item 1
from item 7.

**R3 — Narrow the acceptance ceiling, and prefer a duration ceiling.** `lr-item`'s `maxWpm: 225` sits
45 WPM above target and admits outliers up to 223.7. ETS's observed max is 219.7 but at **11 words**,
not 22 — a fast rate on a short sentence is not the same load as a fast rate on a long one. Since
§1.9 shows clip *duration* is what actually tracks memory load, add a duration ceiling alongside the
WPM band: **no Listen and Repeat clip may exceed ~5.0 s** (ETS's longest is 4.68 s). That single
constraint would catch both the length and the rate defects, since it binds on their product.

**R4 — Weight the accent draw.** `server/src/services/speakingAudioProfile.ts:61-66` draws uniformly
from four accents. Weighting toward North American (say 55/20/15/10 across NA/British/Australian/NZ)
would better match the real test's mix while preserving exposure. Cheap: change `accentsFor` to index
a weighted table instead of `SPEAKING_ACCENTS` directly. Note this changes the accent of every future
set id, so it needs a profile version bump to `ets-2026-v3` per the existing convention
(`speakingAudioProfile.ts:14-20`).

**R5 — Add a Drill-only replay affordance.** `client/src/pages/SpeakingDrill.tsx:564` enforces
play-once even in Drill mode. A "hear it once more (marked as assisted)" control in Drill only,
excluded from Band Estimates, would give a training ladder without touching Simulation fidelity.

**R6 — Fix the calibration fixture's duplicate duration.**
`server/test/fixtures/ets-speaking-audio-calibration.json` gives clips 6 and 7 the identical
`durationSec` 4.675918. Re-derive from the official archive via
`scripts/audit-ets-speaking-audio.ts`. The reported median (179.6) depends on the suspect row.

**R7 — Resolve the stale delivery hint.** `generation-guide.md:124-126` still describes L&R delivery
as "warm, unhurried", which contradicts the shipped "brisk, fluent" instruction. Either delete the
dead comment or reconcile it with `ROLE_DELIVERY`.

**R8 — Re-verify the 8-to-12-second citation.** `rubric-listen-and-repeat.md:18` presents it as an
ETS fact citing the *Test Overview* p. 17, but that PDF was dropped from the repo in `278436a` and
the claim could not be confirmed in the *2026 Blueprint*, the *Technical Manual*, or the *Speaking
Scoring Guide* (§2.6). It may well be correct — different document — but it is currently
unverifiable in-repo. Either re-check it against the Overview and note that it is the sole source,
or relabel it the way the 8/8/10/10/10/12/12 *ramp* already correctly is.

**R9 — Trim the leading/trailing silence, or account for it.** Median padding is 0.51 s per clip
(up to 1.20 s), which is 11% of a typical clip and makes every recorded WPM understate the rate of
the speech itself by ~20 WPM. This matters because `assessPace` divides by **full file duration**
(`audioPace.ts:26-32`), so the pace band is measuring padding as if it were speech. Either trim
silence before probing, or measure speech-only duration in `probeDuration`. Until then, every
`clip_measurements` row and every advisory note in the bank is systematically low.

## Sequencing note

Sets are immutable (`data/question-sets/`), so none of the above changes existing practice material —
it only affects newly generated Sets. Getting the benefit therefore means **regenerating the Speaking
bank** after R1–R3 land. R4 additionally requires a profile version bump to `ets-2026-v3`, since
changing the accent draw changes the accent of every future set id
(`speakingAudioProfile.ts:14-20`).

Priority if only one thing gets done: **R1 (sentence length)**, then **R3's duration ceiling**, which
is a single constraint that binds on the product of the two defects.

---

# Appendix — raw measurements

Reproduce with:

```sh
ffprobe -v error -show_entries format=duration -of csv=p=0 data/audio/stimuli/<setId>/<itemId>.mp3
ffmpeg  -v info -i <file> -af silencedetect=noise=-40dB:d=0.10 -f null -
```

Word counts use `/[A-Za-z0-9]+(?:['’-][A-Za-z0-9]+)*/g` (`server/src/services/audioPace.ts:23`).
`pad` is leading + trailing silence; `speech WPM` is words ÷ (duration − pad). `src` is `ETS` for the
`ets-sample` Set (ETS *text*, app-rendered *audio* — see §1.7) and `gen` otherwise.

| Set | src | # | words | dur (s) | pad (s) | raw WPM | speech WPM | window (s) |
|---|---|---|---|---|---|---|---|---|
| spk-0d5886fd | gen | 1 | 7 | 3.26 | 0.31 | 128.7 | 142.3 | 8 |
| spk-0d5886fd | gen | 2 | 9 | 3.50 | 0.63 | 154.1 | 187.9 | 8 |
| spk-0d5886fd | gen | 3 | 11 | 4.15 | 0.64 | 159.0 | 188.0 | 10 |
| spk-0d5886fd | gen | 4 | 12 | 5.02 | 0.45 | 143.5 | 157.6 | 10 |
| spk-0d5886fd | gen | 5 | 15 | 6.72 | 0.55 | 133.9 | 145.9 | 10 |
| spk-0d5886fd | gen | 6 | 17 | 7.32 | 0.21 | 139.3 | 143.4 | 12 |
| spk-0d5886fd | gen | 7 | 18 | 7.56 | 0.12 | 142.9 | 145.1 | 12 |
| spk-26132ac6 | gen | 1 | 8 | 2.45 | 0.58 | 196.1 | 257.4 | 8 |
| spk-26132ac6 | gen | 2 | 9 | 3.86 | 0.38 | 139.8 | 155.0 | 8 |
| spk-26132ac6 | gen | 3 | 11 | 3.31 | 0.73 | 199.3 | 255.1 | 10 |
| spk-26132ac6 | gen | 4 | 13 | 4.20 | 0.16 | 185.7 | 193.0 | 10 |
| spk-26132ac6 | gen | 5 | 14 | 5.16 | 0.14 | 162.8 | 167.4 | 10 |
| spk-26132ac6 | gen | 6 | 17 | 4.56 | 0.65 | 223.7 | 260.9 | 12 |
| spk-26132ac6 | gen | 7 | 18 | 6.05 | 1.02 | 178.6 | 214.7 | 12 |
| spk-29dc6236 | gen | 1 | 6 | 2.26 | 0.62 | 159.6 | 219.5 | 8 |
| spk-29dc6236 | gen | 2 | 8 | 3.26 | 0.74 | 147.1 | 190.0 | 8 |
| spk-29dc6236 | gen | 3 | 10 | 4.18 | 0.70 | 143.7 | 172.6 | 10 |
| spk-29dc6236 | gen | 4 | 12 | 4.46 | 0.86 | 161.3 | 199.8 | 10 |
| spk-29dc6236 | gen | 5 | 14 | 5.30 | 0.70 | 158.4 | 182.6 | 10 |
| spk-29dc6236 | gen | 6 | 17 | 5.69 | 0.66 | 179.3 | 202.8 | 12 |
| spk-29dc6236 | gen | 7 | 20 | 7.85 | 0.78 | 152.9 | 169.7 | 12 |
| spk-43ab8b09 | gen | 1 | 7 | 2.81 | 0.16 | 149.6 | 158.7 | 8 |
| spk-43ab8b09 | gen | 2 | 8 | 2.86 | 0.32 | 168.1 | 189.0 | 8 |
| spk-43ab8b09 | gen | 3 | 12 | 3.36 | 0.52 | 214.3 | 253.7 | 10 |
| spk-43ab8b09 | gen | 4 | 14 | 5.21 | 0.20 | 161.3 | 167.6 | 10 |
| spk-43ab8b09 | gen | 5 | 15 | 5.45 | 0.68 | 165.2 | 188.9 | 10 |
| spk-43ab8b09 | gen | 6 | 18 | 5.62 | 0.19 | 192.3 | 198.9 | 12 |
| spk-43ab8b09 | gen | 7 | 19 | 6.55 | 0.23 | 174.0 | 180.4 | 12 |
| spk-57f76698 | gen | 1 | 7 | 2.33 | 0.48 | 180.4 | 227.3 | 8 |
| spk-57f76698 | gen | 2 | 9 | 3.36 | 0.31 | 160.7 | 177.1 | 8 |
| spk-57f76698 | gen | 3 | 11 | 3.89 | 0.30 | 169.8 | 183.8 | 10 |
| spk-57f76698 | gen | 4 | 14 | 4.44 | 0.52 | 189.2 | 214.5 | 10 |
| spk-57f76698 | gen | 5 | 15 | 4.94 | 0.26 | 182.0 | 192.2 | 10 |
| spk-57f76698 | gen | 6 | 17 | 6.79 | 1.20 | 150.2 | 182.4 | 12 |
| spk-57f76698 | gen | 7 | 19 | 6.07 | 0.63 | 187.7 | 209.5 | 12 |
| spk-6ea06d6c | gen | 1 | 6 | 2.95 | 0.20 | 122.0 | 130.8 | 8 |
| spk-6ea06d6c | gen | 2 | 8 | 3.65 | 0.41 | 131.6 | 148.4 | 8 |
| spk-6ea06d6c | gen | 3 | 11 | 3.72 | 0.61 | 177.4 | 212.0 | 10 |
| spk-6ea06d6c | gen | 4 | 14 | 5.62 | 0.93 | 149.6 | 179.4 | 10 |
| spk-6ea06d6c | gen | 5 | 15 | 5.40 | 0.37 | 166.7 | 178.8 | 10 |
| spk-6ea06d6c | gen | 6 | 18 | 6.22 | 0.18 | 173.7 | 178.9 | 12 |
| spk-6ea06d6c | gen | 7 | 19 | 6.77 | 0.43 | 168.4 | 179.9 | 12 |
| spk-70c8a41a | gen | 1 | 5 | 3.17 | 0.16 | 94.7 | 99.8 | 8 |
| spk-70c8a41a | gen | 2 | 8 | 4.97 | 0.71 | 96.6 | 112.8 | 8 |
| spk-70c8a41a | gen | 3 | 10 | 4.42 | 0.57 | 135.9 | 156.2 | 10 |
| spk-70c8a41a | gen | 4 | 14 | 4.61 | 0.11 | 182.3 | 186.8 | 10 |
| spk-70c8a41a | gen | 5 | 15 | 5.02 | 0.25 | 179.4 | 188.9 | 10 |
| spk-70c8a41a | gen | 6 | 19 | 7.46 | 0.13 | 152.7 | 155.4 | 12 |
| spk-70c8a41a | gen | 7 | 20 | 8.45 | 0.00 | 142.0 | 142.0 | 12 |
| spk-7ed36c39 | gen | 1 | 7 | 2.26 | 0.70 | 186.2 | 270.3 | 8 |
| spk-7ed36c39 | gen | 2 | 9 | 3.29 | 0.87 | 164.2 | 223.1 | 8 |
| spk-7ed36c39 | gen | 3 | 11 | 3.05 | 0.73 | 216.5 | 284.4 | 10 |
| spk-7ed36c39 | gen | 4 | 14 | 4.34 | 0.66 | 193.4 | 227.8 | 10 |
| spk-7ed36c39 | gen | 5 | 15 | 4.94 | 0.71 | 182.0 | 212.7 | 10 |
| spk-7ed36c39 | gen | 6 | 17 | 4.82 | 0.73 | 211.4 | 249.1 | 12 |
| spk-7ed36c39 | gen | 7 | 22 | 6.17 | 0.65 | 214.0 | 239.1 | 12 |
| spk-82a09237 | gen | 1 | 7 | 3.26 | 0.63 | 128.7 | 159.7 | 8 |
| spk-82a09237 | gen | 2 | 8 | 4.70 | 0.56 | 102.0 | 115.7 | 8 |
| spk-82a09237 | gen | 3 | 11 | 4.06 | 0.00 | 162.7 | 162.7 | 10 |
| spk-82a09237 | gen | 4 | 12 | 4.46 | 0.17 | 161.3 | 167.9 | 10 |
| spk-82a09237 | gen | 5 | 14 | 5.35 | 0.50 | 157.0 | 173.0 | 10 |
| spk-82a09237 | gen | 6 | 17 | 6.77 | 0.38 | 150.7 | 159.7 | 12 |
| spk-82a09237 | gen | 7 | 19 | 6.86 | 0.32 | 166.1 | 174.2 | 12 |
| spk-89911631 | gen | 1 | 6 | 2.62 | 0.18 | 137.6 | 148.0 | 8 |
| spk-89911631 | gen | 2 | 8 | 4.10 | 0.60 | 117.0 | 137.2 | 8 |
| spk-89911631 | gen | 3 | 11 | 4.10 | 0.32 | 160.8 | 174.5 | 10 |
| spk-89911631 | gen | 4 | 13 | 5.02 | 0.16 | 155.5 | 160.7 | 10 |
| spk-89911631 | gen | 5 | 16 | 5.30 | 0.30 | 181.0 | 191.8 | 10 |
| spk-89911631 | gen | 6 | 17 | 6.65 | 0.44 | 153.4 | 164.2 | 12 |
| spk-89911631 | gen | 7 | 18 | 7.15 | 0.23 | 151.0 | 156.0 | 12 |
| spk-8d9ee619 | ETS | 1 | 6 | 3.05 | 1.00 | 118.1 | 175.7 | 8 |
| spk-8d9ee619 | ETS | 2 | 9 | 4.06 | 0.17 | 133.1 | 139.0 | 8 |
| spk-8d9ee619 | ETS | 3 | 11 | 4.80 | 0.81 | 137.5 | 165.5 | 10 |
| spk-8d9ee619 | ETS | 4 | 12 | 4.15 | 0.13 | 173.4 | 179.2 | 10 |
| spk-8d9ee619 | ETS | 5 | 9 | 3.96 | 0.16 | 136.4 | 141.9 | 10 |
| spk-8d9ee619 | ETS | 6 | 11 | 4.75 | 0.12 | 138.9 | 142.4 | 12 |
| spk-8d9ee619 | ETS | 7 | 13 | 5.26 | 0.19 | 148.4 | 154.0 | 12 |
| spk-d58bb9d4 | gen | 1 | 7 | 2.66 | 0.69 | 157.7 | 212.5 | 8 |
| spk-d58bb9d4 | gen | 2 | 9 | 2.90 | 0.71 | 186.0 | 245.7 | 8 |
| spk-d58bb9d4 | gen | 3 | 11 | 4.10 | 0.67 | 160.8 | 192.3 | 10 |
| spk-d58bb9d4 | gen | 4 | 15 | 4.54 | 0.71 | 198.4 | 235.3 | 10 |
| spk-d58bb9d4 | gen | 5 | 16 | 4.46 | 0.70 | 215.1 | 254.9 | 10 |
| spk-d58bb9d4 | gen | 6 | 17 | 5.57 | 0.62 | 183.2 | 206.3 | 12 |
| spk-d58bb9d4 | gen | 7 | 19 | 6.22 | 0.66 | 183.4 | 205.3 | 12 |
| spk-e5b2b735 | gen | 1 | 7 | 2.62 | 0.12 | 160.6 | 168.2 | 8 |
| spk-e5b2b735 | gen | 2 | 8 | 2.95 | 0.24 | 162.6 | 176.9 | 8 |
| spk-e5b2b735 | gen | 3 | 11 | 3.65 | 0.11 | 180.9 | 186.5 | 10 |
| spk-e5b2b735 | gen | 4 | 11 | 4.37 | 0.69 | 151.1 | 179.4 | 10 |
| spk-e5b2b735 | gen | 5 | 15 | 5.06 | 0.10 | 177.7 | 181.5 | 10 |
| spk-e5b2b735 | gen | 6 | 16 | 5.11 | 0.30 | 187.8 | 199.4 | 12 |
| spk-e5b2b735 | gen | 7 | 18 | 5.86 | 0.65 | 184.4 | 207.6 | 12 |
| spk-f22a5687 | gen | 1 | 7 | 2.90 | 0.35 | 144.6 | 164.2 | 8 |
| spk-f22a5687 | gen | 2 | 8 | 4.01 | 0.23 | 119.8 | 127.0 | 8 |
| spk-f22a5687 | gen | 3 | 11 | 4.42 | 0.74 | 149.5 | 179.6 | 10 |
| spk-f22a5687 | gen | 4 | 13 | 5.62 | 0.12 | 138.9 | 141.9 | 10 |
| spk-f22a5687 | gen | 5 | 14 | 5.02 | 0.15 | 167.5 | 172.8 | 10 |
| spk-f22a5687 | gen | 6 | 17 | 6.55 | 0.52 | 155.7 | 169.1 | 12 |
| spk-f22a5687 | gen | 7 | 19 | 7.10 | 0.49 | 160.5 | 172.4 | 12 |
| spk-f5506f40 | gen | 1 | 6 | 2.26 | 0.68 | 159.6 | 228.4 | 8 |
| spk-f5506f40 | gen | 2 | 9 | 3.29 | 0.64 | 164.2 | 204.0 | 8 |
| spk-f5506f40 | gen | 3 | 13 | 4.42 | 0.62 | 176.6 | 205.7 | 10 |
| spk-f5506f40 | gen | 4 | 14 | 3.98 | 0.67 | 210.8 | 253.7 | 10 |
| spk-f5506f40 | gen | 5 | 15 | 4.13 | 0.66 | 218.0 | 259.2 | 10 |
| spk-f5506f40 | gen | 6 | 19 | 6.05 | 0.67 | 188.5 | 212.1 | 12 |
| spk-f5506f40 | gen | 7 | 22 | 7.30 | 0.65 | 180.9 | 198.5 | 12 |
| spk-fbe10c5d | gen | 1 | 8 | 2.88 | 0.29 | 166.7 | 185.3 | 8 |
| spk-fbe10c5d | gen | 2 | 9 | 3.10 | 0.38 | 174.4 | 198.5 | 8 |
| spk-fbe10c5d | gen | 3 | 13 | 4.37 | 0.32 | 178.6 | 192.5 | 10 |
| spk-fbe10c5d | gen | 4 | 15 | 5.18 | 0.20 | 173.6 | 180.6 | 10 |
| spk-fbe10c5d | gen | 5 | 16 | 4.82 | 0.21 | 199.0 | 208.2 | 10 |
| spk-fbe10c5d | gen | 6 | 19 | 6.46 | 0.51 | 176.6 | 191.7 | 12 |
| spk-fbe10c5d | gen | 7 | 20 | 6.58 | 0.71 | 182.5 | 204.6 | 12 |

---

# Part 4 — Primary-source verification pass (2026-08-23)

Parts 1–3 were researched without direct access to ETS's two authoritative 2025/2026 documents. Both
were subsequently supplied by the user and read in full. This part records what they confirm, what
they correct, and what they add. Corrections have been back-patched into §2.2 and §2.5 with inline
markers; nothing else in Parts 1–3 changed.

**Sources read (both ETS-published, both primary):**

- **RR-25-12** — *TOEFL iBT Technical Manual*, Manna, Li, Papageorgiou & Gu, ETS Research Report
  No. RR-25-12 / TOEFL-RR-106, October 2025. 68 pp.
- **`toefl-ibt-test-specifications-2026.pdf`** — *TOEFL iBT Test Specifications*, 2026. 18 pp.
  (Referred to in Parts 1–3 as the "2026 Blueprint".)

Text extracted with `pdftotext -layout`; page images were not needed.

## 4.1 CONFIRMED — difficulty is controlled by length and syntax, never by speed

**ETS-STATED.** *Test Specifications* 2026, p. 16, Speaking § "Difficulty": complexity differs across
the Speaking tasks so that the section reaches several oral proficiency levels and several
communicative functions. Sentence repetition sits at the base, and its items get **longer and
syntactically harder**: an early item can be a short, simple sentence with a single main clause, and
later items run longer and carry heavier grammar, such as verbs joined in pairs, subordinate and
relative clauses, and long noun phrases.

**ETS-STATED.** *Technical Manual* p. 21: across the scenario, the sentences **grow in length and
complexity**.

Speech rate is named as a difficulty lever **nowhere** in either document. Full-text search of both
PDFs for `words per minute`, `wpm`, `speech rate`, `speaking rate`, and `pace` returns exactly four
hits, none of which set a stimulus target:

- *Test Specifications* p. 10 (Listening Audio Difficulty): the stimuli are spoken at a **natural
  pace** — qualitative, and scoped to Listening.
- *Test Specifications* pp. 15–16 (CEFR descriptors): a B1 test taker keeps up a **conversational
  pace** — this describes the *test taker's own* output, not the stimulus.
- *Technical Manual* Tables 5 and 6: speaking rate as a **scored feature of the test taker's
  response**, under Fluency — again, not the stimulus.

**This closes §2.4 definitively.** ETS does not publish a stimulus speech rate in either
authoritative document. The repo's decision to calibrate 180 WPM against measured ETS audio rather
than claim a published standard was the correct methodology, and remains the only defensible one.

## 4.2 CONFIRMED and STRENGTHENED — the sentence-length ceiling

*Technical Manual* Figure 11 prints a complete official 7-sentence Listen and Repeat scenario, set
in a campus gym. Its word counts: **5, 6, 6, 11, 8, 10, 15**. This is a *third* independent official item set, and it
raises the observed ETS ceiling from 14 to **15** — see the corrected table in §2.2.

Consolidated: across three official ETS item sets the maximum sentence is **13, 14, and 15 words**.
The app's `maxWords` authorises **22** and currently delivers a median of **19** at item 7.

**Also confirmed: ETS's ramp is not monotonic.** Figure 11 goes 5 → 6 → 6 → 11 → **8** → 10 → 15:
item 5 is shorter than item 4, and two consecutive items tie at 6. §2.2's observation stands, now on
a second example. The app's strict monotonic requirement (`generation-guide.md:100-102`) is stricter
than ETS's own published practice, and it is a plausible driver of the over-long tail — a generator
forced to increase length at every step from a 7-word item 1 has nowhere to go but 20+ by item 7.

## 4.3 CONFIRMED — what the task is scored on

**ETS-STATED.** *Technical Manual* Figure A3 (rubric) matched
`.claude/skills/toefl-speaking/references/rubric-listen-and-repeat.md` **verbatim** as the repository
then held it, including band 5 (a word-for-word reproduction of the prompt) and band 4's tolerances.
No defect in the repo's rubric. (The shipped file is now this project's own description of the same
criteria; ADR 0013.)

**ETS-STATED.** *Technical Manual* Table 5 gives the three scoring dimensions and their machine
features:

| Dimension | Feature examples |
|---|---|
| Fluency | how fast the test taker speaks; how long the stretches of speech without a break are; how many pauses; how many hesitations |
| Intelligibility | how accurate the pronunciation is; how natural the rhythm is; how natural the prosody is (syllable stress, for example) |
| Repeat accuracy | how many words come back correctly; how close the response is to the prompt |

**Nuance worth stating precisely, since Parts 1–3 compressed it.** Prosody and pronunciation are not
scored *in the band descriptors*, but they are scored — under **Intelligibility**, as an independent
dimension of equal billing with Repeat accuracy. The correct reading is that Listen and Repeat is
scored on **three** dimensions, of which verbatim fidelity is one. "I couldn't catch every word" is a
real, band-defining failure mode; it is not the *only* one, and a fast garbled exact repetition can
lose on Fluency and Intelligibility what it wins on Repeat accuracy.

**Also confirmed:** the *Test Specifications* CEFR descriptors (pp. 15–17) describe repetition almost
entirely in pronunciation/stress/intonation terms at every level (at B1, the test taker can reproduce
longer utterances and gets pronunciation and stress mostly right), and the Claim 4 table explicitly
tolerates lossy recall at the lower bands (at A1–A2, dropped or swapped words are acceptable while
the core meaning survives; at B1–B2, small grammar or word changes are acceptable while the meaning
stays clear). Accent as such is graded nowhere.

**ETS-STATED.** *Test Specifications* p. 17 and *Technical Manual* p. 43: max **5 points per item**,
**7 items**, scale **0–5**. Matches the app.

## 4.4 CORRECTED — New Zealand is not a TOEFL accent

This is the one finding the verification pass reverses.

**ETS-STATED.** *Technical Manual* §II-4, p. 12: the accents heard in the tasks come from **three
regions, North America, the U.K. and Australia**.

**ETS-STATED.** *Test Specifications* p. 10, Listening Audio Difficulty: ETS produces Listening
stimuli with AI-generated audio, plus human voice actors in some cases, and aims for a roughly even
mix of regional accents and of voice genders. The varieties it gives as examples are
**British, Australian and U.S./Canadian English**.

Both 2025/2026 documents give **three** regions and both **exclude New Zealand**. §2.5 previously
recorded the *Technical Manual* as supporting the four-region list; it does not. The only source
carrying New Zealand is an undated public test-taker web page, which most plausibly predates the
enhanced format.

**INFERRED.** `DeliveryAccent` in `server/src/services/audioPrompt.ts:21` authorises `new-zealand`
for Speaking on the strength of that web page. Against the two authoritative documents this is an
accent the current test does not use, and the app has drawn it for **three of six** profiled Sets
while drawing British **zero** times. Unlike the length finding, this one is not a matter of degree:
practice time spent on New Zealand English is spent on a variety that will not appear on the test,
and British — one of ETS's three — has never been practised at all.

**Caveat kept honest.** Neither document scopes its accent statement to *Speaking* audio
specifically: the *Technical Manual*'s sentence sits in §II-4 (Listening task types) and the
*Test Specifications*' sits under Listening Audio Difficulty. The Speaking Stimulus spec makes no
accent statement at all. So the three-region list is ETS's stated policy for *listening input* and is
applied here to Speaking stimuli by inference. That inference is far better supported than the
four-region alternative, but it is an inference.

## 4.5 Still not published, after reading both documents

Re-verified by full-text search of both PDFs. §2.6's list stands, with these now conclusive:

1. **Any stimulus speech rate**, for any section. Only that the delivery is natural.
2. **Any word- or syllable-count range for Listen and Repeat.** The three worked examples remain the
   only quantitative window.
3. **Per-item response time for Listen and Repeat.** Zero timing figures in either document — so the
   sourcing conflict flagged at the end of §2.6 (`rubric-listen-and-repeat.md:18`'s 8 to 12
   seconds, cited to the *Updated TOEFL iBT Test Overview*) is **still unresolved**, and neither new
   document settles it.
4. **Whether the sentence plays once.** *Technical Manual* p. 21 says only that each sentence is
   followed by a pause, after which the test taker repeats it word for word.
5. **Weighting between Fluency / Intelligibility / Repeat accuracy.**
6. **Whether Speaking stimuli are AI-generated.** The AI-audio disclosure is scoped to Listening.

## 4.6 Net effect on the verdict

Part 3's verdict is unchanged in direction and strengthened in evidence:

- **Rate** — confirmed not the problem, and confirmed unpublishable-against. ETS controls difficulty
  by length and syntax; speed is not a lever it names anywhere.
- **Length** — the primary defect, now confirmed against a third official item set with the ceiling
  revised **up** to 15 words, against the app's 22.
- **Monotonicity** — newly implicated. ETS's own example is non-monotonic; the app's generator is
  required to be monotonic, which mechanically inflates the tail.
- **Accent** — upgraded from "skewed draw" to a **correctness defect**: New Zealand is not one of
  ETS's three regions, and British has never been drawn.
