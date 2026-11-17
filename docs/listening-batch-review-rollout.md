# Listening batch staging + consolidated human review (opt-in)

## Behavior
- The draft remains **unpublished**. Existing approved R2 MP3s, 14 banked Listening Sets, answers, attempts and history remain unchanged.
- The operator checks **the exact Google API project** in AI Studio after the Pacific reset: Free Tier/no Billing, both models' actual RPD/RPM/TPM, and other clients' usage. Google billing/usage is NOT readable by the Worker.
- Operator sets **Lite dailyLimit = 3; Flash dailyLimit = 3** in the protected Listening admin page, after inspecting the quota. These are **per-Pacific-day ceilings**, not automatically reset into a new authorization. If the model has fewer than 3 free requests available, set a smaller cap or keep it at zero.
- The newly gated daily GitHub schedule is 10:07 UTC (18:07 Taiwan), with delays possible. Each job sends no more than **3 attempts per model / 6 total**, paced 65 seconds apart. At most one TTS invocation per clip claim. It never retries a failed/uncertain call.
- A generated and validated MP3 lands **only in private staging R2**. Durable staging rows can await review together; incomplete claims block any later Gemini request.
- The admin page now has inline transcript + audio + per-clip approve/reject. It uses the **same in-page Bearer token field** and existing Cloudflare Access authentication. No browser localStorage, sessionStorage, persistent cookie, or token-in-URL. Navigating away requires re-entering the token.
- Every review decision remains per clip; rejection blocks publication and requires human reconciliation. Neither staging nor approval publishes the 36-clip draft. Only the separate explicit publish operation may do so.

## Safe deployment sequence
1. **Do not deploy automatically.** This is a development branch based on the exact known production source commit `7467227`, distinct from current `main`. Review/merge the correct source lineage and CI before production changes.
2. Verify `node --import tsx --test cloudflare/test/listening-staging.test.mjs`, `node scripts/listening-cloud-tts-batch.mjs --self-test`, `npm run typecheck`, and existing Cloudflare tests. Confirm D1/R2 backup and Access rules.
3. Ensure existing `listening_auto_review_staged` migration 0011 is present; no new migration is introduced. Deploy Worker code from the reviewed source only after explicit approval. Check D1 status and that existing uploaded audio remains intact.
4. GitHub scheduled workflow must exist on **default branch** to run. Disable the **old** schedule first: `LISTENING_DAILY_TTS_SCHEDULE_ENABLED=false`. For the new workflow, set both `LISTENING_CLOUD_TTS_ENABLED=true` and `LISTENING_BATCH_TTS_ENABLED=true` only after all verification. They default to absent/false.
5. The Worker `listening_refill_enabled` switch must also be true, and daily model policies must be manually reconfirmed **after** each Pacific reset. Without attestation, scheduled batch **must not run Gemini**.
6. First conduct one bounded, human-approved manual pilot. Check R2/D1 staging, claim counts, two staged clips with no intermediate approval, and the combined inline review. Only then opt in to scheduled production batches.

## Important limits
- The batch script is intentionally **capped at three attempts per model** even if Google's actual RPD limit is ten.
- The batch stops on a failed/ambiguous claim, audio failure, reconciliation mismatch, time-zone rollover, model cap mismatch, or missing secret.
- No auto-retry, no failover between models for long clips, no automatic quality approval, no auto publication.
- No second long-lived login session has been implemented. Consolidation avoids a second password entry **while using one browser page**; it does not eliminate the second-factor Bearer token.
- If legacy one-take scheduling and batch scheduling are both enabled, batch's GitHub job is gated OFF. Do not use two scheduling jobs for the same queue.
