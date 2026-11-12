# Audio-input judging APIs — research for Plan 3 (speaking)

Researched 2026-07-28 from official docs (developers.openai.com, ai.google.dev). Informs the speaking-judge design.

## OpenAI

- Audio input lives ONLY in the audio model family — **`gpt-audio-1.5`** (GA, recommended; 128K ctx). GPT-5.x text flagships have NO audio input. So "flagship audio-capable OpenAI judge" = gpt-audio-1.5 by definition.
- **Chat Completions only** (Responses API rejects `input_audio`). Content part: `{type:"input_audio", input_audio:{data:"<base64>", format:"wav"|"mp3"}}`; set `modalities:["text"]`.
- **Formats: wav/mp3 ONLY** — our MediaRecorder webm/opus recordings must be transcoded (ffmpeg, present on machine) before the OpenAI judge call.
- **Structured outputs do NOT combine with audio input.** Pattern: strict JSON-shaped prompt → lenient first-{...last-} parse → one repair retry (same as the writing judges' text pattern).
- Cost ≈ $0.048/audio-input-minute → $0.006–0.036 per 8–45s clip. Negligible at practice volumes.
- No published max duration for chat audio; 25MB practical bound. Our clips are seconds long.

## Gemini

- Current family: Gemini 3.x; **`gemini-3.6-flash`** is the audio-understanding default in official examples; a 3.x pro-tier preview exists for higher quality. (`gemini-2.5-flash` = cheap stable fallback.)
- **Accepts `audio/webm` inline directly** (no transcode; opus-codec nuance untested — verify in the ears task) and **supports structured JSON output in the same audio-in call**.
- Audio tokenized at 32 tok/s; ≈$0.002–0.003/min. Inline cap 20MB.

## Architectural implications for Plan 3

1. Ears (transcript + Delivery Report) = one Gemini call from the raw webm, structured output.
2. Gemini speaking judge: single call, webm in, JSON out.
3. OpenAI speaking judge: ffmpeg webm→mp3 once per recording (cache next to the webm), gpt-audio-1.5 via chat completions, prompt-JSON + repair retry. Env: `OPENAI_AUDIO_JUDGE_MODEL` (default gpt-audio-1.5).
4. Documented fallback if gpt-audio judging proves unreliable: OpenAI judges from transcript + Delivery Report (text flagship), per the spec's degradation clause.
