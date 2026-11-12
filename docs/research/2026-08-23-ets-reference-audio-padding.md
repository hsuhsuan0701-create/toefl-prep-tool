# ETS reference audio carries almost no silence; ours carries 0.67 s of it

**Measured 2026-08-23.** Companion to `2026-08-23-listen-and-repeat-speech-rate.md`, which
predicted this in R9 but could not test it. This note closes **R9** and **R6**.

## The question this answers

`assessPace` divides word count by **full file duration**. If our clips carry leading and
trailing silence and ETS's do not, every rate this codebase has ever computed is biased low —
and the pace targets in `speakingConformance.ts`, derived from ETS *file* durations, are
calibrated against a different quantity than the one they are compared to.

That could not be settled from the repo. `server/test/fixtures/ets-speaking-audio-calibration.json`
stores ETS's **durations**, not ETS's **audio**, so the padding inside those durations was unknown.

## Method

ETS's audio is public. The fixture records its origin, and the zip was downloaded from it:

    https://www.ets.org/content/dam/ets-org/pdfs/toefl/teacher-practice-test-5-audio-files.zip
    Teacher Practice Test 5 Audio Files/Speaking/Listen and Repeat/Speaking_Listen_Repeat_{1..7}.ogg

**It is deliberately not vendored** — this note records the derived measurements so the finding
survives, and the URL so anyone can reproduce it.

Both banks were measured identically: decode to mono 16 kHz PCM, 10 ms RMS windows, speech
threshold −45 dB relative to **each clip's own peak**, take the first and last window above it.
Same script over both, so the comparison is like-for-like.

```python
raw = ffmpeg(path, "-ac","1","-ar","16000","-f","s16le")     # mono 16k PCM
peak = max(abs(x) for x in samples); thr = peak * 10**(-45/20)
frames = [rms(samples[i:i+160]) > thr for i in range(0, n-160, 160)]  # 10 ms
lead = frames.index(True) * 0.010
trail = duration - (len(frames) - frames[::-1].index(True)) * 0.010
```

`ffmpeg -af silencedetect=noise=-40dB` finds **zero** silence in any ETS clip, which is itself the
headline: at the threshold that flags our clips, theirs have none to flag.

## Result 1 — the padding gap

| | leading + trailing silence, median |
|---|---|
| ETS reference clips (n=7) | **0.136 s** |
| Our current bank (n=112, 16 v4 Sets) | **0.668 s** |

Ours carry ~0.53 s more. The overhead is roughly **constant**, so it is a larger fraction of a
short clip: ~27 % of a 2.5 s item-1 clip, ~14 % of a 4.9 s item-7 clip. That gradient is the whole
reason the apparent error looked position-dependent.

## Result 2 — what the two banks actually sound like

Mean over the 16 current (non-superseded) Sets per item position:

| item | ETS file WPM | ETS speech WPM | ours file WPM | ours speech WPM | ours − ETS (speech) |
|---|---|---|---|---|---|
| 1 | 201.6 | 233.8 | 170.1 | 234.4 | **+0.6** |
| 2 | 211.2 | 217.2 | 186.8 | 242.0 | +24.8 |
| 3 | 219.7 | 227.6 | 193.8 | 244.2 | +16.6 |
| 4 | 175.2 | 182.4 | 173.1 | 208.1 | **+25.6** |
| 5 | 179.2 | 195.7 | 175.8 | 212.0 | +16.4 |
| 6 | 166.8 | 171.8 | 166.8 | 191.8 | +20.0 |
| 7 | 179.6 | 186.7 | 164.3 | 191.4 | +4.8 |

**Our bank is faster than ETS by a median +16.6 WPM (~8–9 %)**, not slower. Items 1 and 7 are
effectively matched; items 2 and 4 are the widest.

## Result 3 — the correction loop has been chasing an artifact

Compare `ours file` against `ETS file` at items 1–3: **170 / 187 / 194 against 201.6 / 211.2 / 219.7.**
The system reads its own clips as far slower than the reference and buys a corrective re-render to
speed them up — while in speech terms they were **already faster**.

This is the mechanism behind a number the bank had already recorded without explaining: **13 of the
current bank's 26 Listen and Repeat advisory notes say `take: "first"`** — the retake came back no
better and was discarded. Half the corrective spend on this task bought nothing, because the deficit
being corrected was silence, and re-prompting for pace does not remove silence.

## R9 — CLOSED, and it is not cosmetic

R9 ("trim the leading/trailing silence, or account for it") was filed before #63 and never
implemented. #63 set the targets and #64 re-rendered the entire Speaking bank without it. The
consequence is not merely that a metric read low: it is that a whole bank was generated and accepted
against a measurement biased in a systematic direction, and that the corrective loop was aimed at
the wrong quantity.

## R6 — CLOSED, and the suspicion was wrong

R6 flags ETS items 6 and 7 sharing `durationSec` 4.675918 as "almost certainly a transcription slip".
**It is not a slip.** Both files were probed directly and genuinely are the same length (4.676 s
each), with different word counts (13 and 14). The fixture is accurate. Stop discounting those rows.

## Open: is the item 1–3 ramp real?

The configured ramp (200 / 208 / 215) was derived from ETS **file** WPM — 201.6 / 211.2 / 219.7, a
clean ascending line. ETS's **speech** rates are 233.8 / 217.2 / 227.6, which do **not** ascend.
ETS clip 1 carries 0.289 s of trailing silence, far more than its siblings, and that alone is what
deflates its file rate and manufactures the ramp.

So the ascending difficulty ramp at items 1–3 may be an artifact of ETS's own uneven padding rather
than a design.

**This is not settled.** n = 1 per item position, from a single practice form. That sample cannot
distinguish deliberate design from noise, and this note does not claim it can. Anyone retuning the
ramp should either find more ETS forms or state plainly that the choice is judgement.

## What must not be inferred from this

Trimming silence changes what the pipeline **measures**. It does not change what a learner
**hears**. If the delivered speech rate is wrong, only re-rendering fixes it — a trim does not.
Keep those two remedies distinct when reasoning about whether a bank needs redoing.
