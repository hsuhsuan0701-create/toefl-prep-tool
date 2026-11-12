# Re-centring the four Listening role bands onto the speech scale

**Measured 2026-08-23.** Issue #108. Companion to
`2026-08-23-ets-reference-audio-padding.md`, which established the padding, and to
`2026-08-23-listen-and-repeat-speech-rate.md` §1.10, which recorded `lcr-utterance`'s miss and
explicitly did not pursue it.

Issue #105 switched Speaking's pace measurement from file duration to speech duration and left
Listening alone, because switching Listening's measurement under unmoved bands only reverses the
sign of the failure. This note is the evidence for moving them, and the record of what was decided
for each of the four roles.

## The evidence base, and what it cannot tell you

Three populations, all local, no paid call made for this work.

| population | n | what it is | what it is good for |
|---|---|---|---|
| **A — recorded first takes** | 140 `lcr-utterance` (+112 other roles) | `clip_measurements` rows with `correction_count = 0`, 7 Sets. Speech duration reconstructed by subtracting the measured constant padding from the recorded file duration | what the instruction delivers *unprompted* |
| **B — the published bank** | 288 clips, 8 Sets | every `data/audio/stimuli/lsn-*` manifest from the current Gemini pipeline, speech span probed directly off disk with `silencedetect=noise=-40dB:d=0.05` — `transcode.speechDurationFrom`'s own settings | what the bank on disk measures today |
| **C — issue #103's fresh Set** | 36 clips | `lsn-7c5cf3f6`, rendered by a different lane on a different day, extracted from its branch and measured identically | independent corroboration |

**A is the one the bands are derived from, and that choice is load-bearing.** B is contaminated:
60 of its 160 `lcr-utterance` clips are retakes that the pipeline prompted *"pick the pace up"* —
a nudge issued because of the very measurement error being fixed here. Fitting a band to B would be
fitting it to the error's own output. C is contaminated the same way and more strongly: its
`lcr-utterance` speech median is 212.5 WPM against B's 184.3, precisely because more of its clips
were pushed faster.

**A is also not a reference.** It says what this renderer does, not what is correct. There is **no
ETS-published WPM figure for TOEFL audio of any kind** — see
`2026-08-23-listen-and-repeat-speech-rate.md` §2.4; ETS's published control on this task is *length*
(a brief utterance is capped at six stressed syllables), not rate. The only measured external figure
in the literature (Nishizawa 2024, ≈164 WPM inferred) is for pre-2026 *lecture* passages and says
nothing about brief utterances. **Nothing below is a claim about what a Listen and Choose a Response
utterance ought to sound like.** Where this note says EVIDENCE it means "measured on population A";
where it says JUDGEMENT it means a choice made with no external reference to check it against.

Further limits worth stating plainly:

- A's speech durations are **reconstructed, not probed** — the discarded takes are deleted from
  disk. The reconstruction subtracts a flat 0.677 s. That is defensible (padding correlates with
  neither duration, r = 0.07, nor word count, r = 0.08, and this bank's per-Set medians span only
  0.654–0.695 s) and it checks out: on the 80 clips where both a reconstruction and a direct probe
  exist, the medians agree to about 3 WPM. It is still an estimate.
- Every one of the 75 corrective re-renders observed on `lcr-utterance` was a **"faster"** nudge.
  There is therefore **no evidence at all** about how this role responds to "slower", and the
  symmetry assumed in the band edges below is judgement.
- Populations A and B overlap (A's 7 Sets are 7 of B's 8). They are not independent samples.

## The padding, reproduced on Listening's own bank

Issue #105 measured 0.668 s across 112 Speaking clips. Measured here across all 288 clips of the 8
current-pipeline Listening Sets, per Set:

| Set | median leading + trailing silence | `lcr-utterance` median as a share of file |
|---|---|---|
| lsn-03948a55 | 0.655 s | 23.3 % |
| lsn-23b1b036 | 0.654 s | 24.0 % |
| lsn-24b8d4fa | 0.668 s | 26.4 % |
| lsn-2e77a970 | 0.675 s | 22.9 % |
| lsn-6de33148 | 0.691 s | 23.4 % |
| lsn-ac7788d4 | 0.669 s | 22.6 % |
| lsn-ed0a8e87 | 0.680 s | 25.2 % |
| lsn-fc96bdab | 0.695 s | 27.2 % |

Constant to within 0.04 s across eight independently rendered Sets, exactly as #105 found. On a 38 s
Conversation the same 0.68 s is ~1.8 % of the file. **That ratio — 24 % against 1.8 % — is the whole
of why one role broke and three did not.**

(`lsn-14659f38`, the retired Set, measures 0.510 s with a p10–p90 span of 0.074–0.904 s. It was
rendered by the old per-turn OpenAI pipeline with a damped speed loop and a fixed 350 ms inter-turn
gap. It is excluded from every number in this note except where explicitly labelled.)

## Why the correction loop could not win

`renderClipWithPaceCorrection` buys exactly one re-render for an out-of-band clip. The prompt is the
only actuator — Gemini has no rate parameter — so the question is how far one nudge can move a clip.
Measured on the 129 first-take/retake pairs in `clip_measurements`:

| role | pairs | moved in the commanded direction | median Δ WPM | s.d. |
|---|---|---|---|---|
| `lcr-utterance` | 75 | 60 (80 %) | +7.2 | 9.2 |
| `conversation` | 15 | 14 (93 %) | −5.3 | 12.5 |
| `announcement` | 19 | 19 (100 %) | +12.6 | 7.7 |
| `academic-talk` | 23 | 22 (96 %) | +12.0 | 5.8 |

**The nudge works.** It has an authority of roughly 7–14 WPM. Now the misses it was asked to close,
on first takes, file duration, old bands:

| role | first takes | in band | bought a re-render | median miss | of those, within 15 WPM of an edge | re-renders that landed in band |
|---|---|---|---|---|---|---|
| `lcr-utterance` | 140 | 15.0 % | 85 (61 %) | **29.0 WPM** | **4.7 %** | **2 / 75 (2.7 %)** |
| `conversation` | 49 | 65.3 % | 17 (35 %) | 7.7 WPM | 88 % | 6 / 15 (40 %) |
| `announcement` | 35 | 37.1 % | 22 (63 %) | 7.6 WPM | 73 % | 14 / 19 (74 %) |
| `academic-talk` | 28 | 7.1 % | 26 (93 %) | 10.7 WPM | 85 % | 13 / 23 (57 %) |

That is the mechanism, quantified: a 29 WPM gap against a 7 WPM actuator. The 2.7 % success rate is
not bad luck and it is not a prompt-engineering problem. The other three roles miss by about one
nudge and are repaired at 40–74 %.

## The re-derived `lcr-utterance` band

Population A, speech scale, n = 140:

    p10 131.8 · p25 148.8 · MEDIAN 170.0 · p75 197.9 · p90 212.3 WPM

The old band was 160 (150–170). **Its ceiling is this population's median.** The band was not so
much mis-centred as absurdly narrow — a ±10 half-width, the tightest in the codebase, applied to the
shortest clips in the app. On a 5–8 word utterance one beat before the last word is 10 % of the clip;
no re-rendering makes a ±10 WPM band reachable at that length.

**New: `{ targetWpm: 170, minWpm: 135, maxWpm: 205 }`.**

| number | evidence | judgement |
|---|---|---|
| `targetWpm` **170** | population A's median is 170.0 | that the target should *sit on* the delivered median rather than lead it. Also, and decisively, 170 is the top of `pacingDirection`'s "easy, conversational pace" bucket (151–170). The model never sees a number, only one of five prose lines chosen by `targetWpm`, so **every measurement in this note was produced under that line**. A target of 171 would silently move this role onto the next line up ("ordinary talk between two people … delivered as one continuous phrase"), and a target of 150 or below onto the one beneath ("measured, unhurried"); either would invalidate all of it. A future retune must stay within 151–170 or re-measure. Pinned by `listeningAudioRenderer.test.ts`. |
| `minWpm` **135** / `maxWpm` **205** | they bracket A's p10–p90 (131.8 / 212.3), rounded *inward* to the nearest 5 so the band is slightly tighter than the observed decile spread | the exact edges, the symmetry (see the "no 'slower' observations" caveat above), and the decision to use p10–p90 rather than a narrower quantile |

The check applied to the edges was the acceptance criterion itself — *a corrective re-render is only
bought where it can plausibly succeed*:

| | old band, file duration | new band, speech duration |
|---|---|---|
| first takes in band | 15.0 % | **72.9 %** |
| first takes buying a re-render | 60.7 % | **26.4 %** |
| median miss among those | 29.0 WPM | **13.4 WPM** |
| misses within one nudge (15 WPM) of an edge | 4.7 % | **56.8 %** |

56.8 % is in line with what the three healthy roles actually achieve (40–74 %). A wider band buys
more: ±40 (130–210) reaches 80 % in band. It was not taken, because a band that accepts four fifths
of everything the renderer emits has stopped being a check.

### One consequence worth knowing about

`ABSOLUTE_DURATION_TOLERANCE_SEC` (0.4 s) exists to stop a paid render being discarded over a few
tens of milliseconds on a short clip. A WPM band is a duration window whose width scales with clip
length, so widening the band pushed the crossover down rather than removing it: at **7–8 words** the
new band's own fast edge is now further than 0.4 s from target and the floor is inert; at **5–6
words** the floor is still the wider of the two on the fast side and still binds. Both regimes are
pinned in `listeningAudioRenderer.test.ts`.

The real measurement that motivated that tolerance — 7 words, 2.376 s, 176.8 WPM, which missed the
old band's fast edge by 94 ms and cost a ~45-minute paid render — now simply measures **in band**.

## The other three roles: unchanged, and why

**Decision: `conversation`, `announcement` and `academic-talk` keep their current bands.**

The measurement switch moves their medians by, at the median clip length of each role:

| role | median clip | file → speech WPM (population A) | shift |
|---|---|---|---|
| `conversation` | 38 s | 161.8 → 165.0 | +3.2 (+2.0 %) |
| `announcement` | 26 s | 134.1 → 137.5 | +3.4 (+2.5 %) |
| `academic-talk` | 73 s | 130.0 → 131.2 | +1.2 (+0.9 %) |
| *(`lcr-utterance`)* | *2.8 s* | *131.6 → 170.0* | *+38.4 (+29 %)* |

A 1–3 WPM shift is well inside each role's own spread. Their bands were never unreachable — their
correction loops repair 40–74 % of what they buy — and after the switch 76–100 % of their remaining
misses still sit within one nudge of an edge. Re-centring a band that is being hit is how a
calibration gets fitted to its own bank, which is the mistake `listeningAudioRenderer.ts`'s
`conversation` note already warns about at length, on the same role.

**One observation left on record rather than acted on.** `academic-talk` has the lowest first-take
in-band rate of the four (2 / 28) and the narrowest half-width (±7.5). Unlike `lcr-utterance` that is
a *reachable* band being missed — the repair lands 13 times in 23 — so it is a live calibration
question, not a broken one, and there is no reference to re-derive it against. Not #108's.

## Should the published bank be re-rendered?

**Recommendation: no. Zero paid calls. This is the user's money and the user's call; what follows is
the accounting.**

Under the change, the 8 current-pipeline Sets measured on the speech scale against the new bands:

| role | clips | in band | would buy a re-render if generated today |
|---|---|---|---|
| `lcr-utterance` | 160 | 114 (71 %) | 40 |
| `conversation` | 56 | 41 (73 %) | 15 |
| `announcement` | 40 | 30 (75 %) | 10 |
| `academic-talk` | 32 | 18 (56 %) | 14 |
| **total** | **288** | **203 (70 %)** | **79** |

Per Set: lsn-23b1b036 4 · lsn-fc96bdab 8 · lsn-24b8d4fa 9 · lsn-ac7788d4 10 · lsn-2e77a970 10 ·
lsn-6de33148 12 · lsn-ed0a8e87 12 · lsn-03948a55 14. (The retired lsn-14659f38 adds 13 more.)

Four reasons not to spend:

1. **Trimming silence changes what the pipeline measures, never what a learner hears.** The padding
   is still in every published mp3 and always will be; this ticket changed how the rate is computed,
   not the audio. `2026-08-23-ets-reference-audio-padding.md` closes with exactly this warning and it
   is the first thing that applies here.
2. **The bank is largely acceptable as it stands**: 71 % of `lcr-utterance` clips measure in band
   against 17.5 % before, and 75 % are inside tolerance.
3. **The remainder skews fast, and mostly for a reason that no longer exists**: of the 46 clips
   outside 135–205, 36 are *above* 205 and only 10 below 135 — and 60 of the bank's 160 clips are
   retakes that the broken measurement prompted "faster". A fixed pipeline will not repeat that. That
   argues for replacing Sets on the normal schedule, not for a corrective pass.
4. **The bank is already being replaced, and paid for, under issue #103.** Five of the eight live
   Listening Sets are authorised REPLACE in that lane (one, `lsn-2e77a970` → `lsn-7c5cf3f6`, has
   already shipped). Buying an overlapping #108 re-render is paying twice for the same clips.

If a re-render is wanted anyway, the two shapes and their cost:

- **Option B — targeted.** Re-render only the 79 clips still outside tolerance. At one take plus at
  most one correction that is **79–158 paid TTS calls**. It also needs a per-clip Listening
  re-render path that **does not exist today** — the only re-render script at the time
  (`upgrade-speaking-audio.ts`, since deleted) was Speaking-only — so it is a script to write as well
  as calls to buy.
- **Option C — full bank.** 8 live Sets × 36 clips = 288 base calls, plus a projected ~15 corrections
  per Set under the new bands (per-role projected buy rates: `lcr-utterance` 26 %, `conversation`
  43 %, `announcement` 60 %, `academic-talk` 89 %) — **≈ 405 paid TTS calls**, and that is only the
  audio, not the generation calls a Set replacement also spends. For comparison, the same 8 Sets
  under the old band would have bought ~21 corrections each.

**One timing note for whoever sequences this.** Issue #103's remaining Listening renders are running
against a branch that predates this change, so they will be paced and judged under the *old* band and
the *old* measurement. Only renders started after #108 reaches `main` and that lane re-baselines pick
up the new one.

## Reproducing this

Nothing here needs a paid call. Per-clip speech spans come from ffmpeg with the settings
`transcode.probeSpeechDurationSec` uses, over the manifests in `data/audio/stimuli/lsn-*`:

```sh
ffmpeg -v info -i CLIP.mp3 -af silencedetect=noise=-40dB:d=0.05 -f null -
```

parsed exactly as `transcode.speechDurationFrom` parses it (edges only — an interior pause is
delivery and stays in). Take counts and first-take durations come from `clip_measurements`:

```sh
sqlite3 -readonly data/db.sqlite \
  "select role, correction_count, count(*), round(avg(wpm),1) from clip_measurements group by 1,2;"
```
