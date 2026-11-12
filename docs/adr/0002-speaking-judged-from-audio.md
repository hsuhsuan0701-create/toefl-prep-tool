# Speaking is judged from the audio itself, not a transcript

ETS scores intelligibility, pace, and prosody — dimensions a transcript cannot carry, and ASR actively hides (it silently corrects mispronunciations). Both Judges therefore receive the user's actual recording (Gemini and OpenAI audio-capable models), while a separate Gemini "ears" call produces a verbatim transcript (disfluencies preserved) plus a structured Delivery Report for the UI diff view and the text-only Arbiter.

## Consequences

Pronunciation-adjacent feedback is still an approximation (LLM audio perception is not a validated pronunciation assessor) and the UI says so where it summarises Deductions (Progress lists the category as "Pronunciation (judged indirectly)"). If OpenAI audio input proves unreliable at M4, its Judge falls back to transcript + Delivery Report — a documented degradation, not a redesign.
