# Listen and Repeat scene illustrations: one generated WebP per Set, committed with it

## Status

Accepted.

## Context

The real Listen and Repeat task shows an illustrated scene of the setting while the sentences play,
and ETS's blueprint says progress through the sentences corresponds to movement through parts of the
illustration. A highlight moves to the object each sentence names. Of the 2026 test's visuals, only
Listen and Repeat is illustrated; the others are photographs. For a learner whose bottleneck is
holding a long sentence in memory, the scene is real support, and a Set without one loses it.

## Decision

- **One image per Speaking Set**, generated after audio rendering by OpenAI's image model
  (`SCENE_IMAGE_MODEL` in `server/src/services/sceneImage.ts`), from the scenario and the seven
  sentences, wrapped in a fixed style prompt. The style prompt was written against ETS's reference
  illustration and validated by live generation: an elevated three-quarter map view, a strictly
  grayscale environment, one teal accent behind the key objects, faceless figures, no text. It is a
  verbatim fixture. `server/test/sceneImage.test.ts` compares the composed prompt with a golden file,
  `server/test/fixtures/scene-prompt-spk-e5b2b735.txt`, so any rewording fails the suite; no test can
  tell whether a reworded prompt still draws the validated style.
- **One focus region per sentence**, located by one Gemini vision call against the generated image.
  A sentence whose object the scene does not show gets no region, and the client draws no ring for
  it.
- **Neither call can fail a Set.** An image failure publishes the Set without a scene; a vision
  failure keeps the image and omits only the rings. A schema-valid answer of "not depicted" for every
  sentence is accepted as it is, with no retry that would pressure the model into inventing a box;
  one repair retry is reserved for structurally invalid output. In live runs an all-null answer
  happened about once in five, so generation logs how many regions it located.
- **Stored as WebP and committed with the Set**, like its stimulus audio: a Set is unusable without
  its media. Measured on the same prompt, WebP at quality 80 was 145,650 bytes against PNG's
  1,290,790 (about 9×) and JPEG's 193,881, with no visible loss on flat vector art.
- **The image prompt is never served.** It embeds all seven target sentences, so `stripAnswers`
  serves only the image file and model.

## Consequences

Each Speaking Set adds about 130 KB of image to the repository and one paid image call plus one paid
vision call to its generation. Composition varies between generations of the same prompt while the style
holds, which is fine: each Set has one image.

Pinned by `server/test/sceneImage.test.ts` (the request shape, WebP validation, region parsing) and
`server/test/servedSet.test.ts` (the prompt is stripped).
