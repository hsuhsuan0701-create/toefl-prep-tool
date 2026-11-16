# TOEFL Listening 雲端配音＋網頁人工驗收（尚未部署）

這個 Draft PR 開發的目標：
Cloudflare D1 原子 claim（先記錄配額）→ GitHub Actions Node Runner 最多一次 Gemini TTS →
離線 WAV sanity check → ffmpeg MP3 → 私有 R2 staging/ → 私人網頁試聽 →
人工核准後才一次性匯入 stimuli/ R2 與 D1。
這不是每天自動發布題庫，也不會自動重試任何失敗或不明確的 API 呼叫。

## 既有資料，務必保留

- Draft Set lsn-a97620b2c800 共 36 段。先前 8 段已人工驗收、匯入 R2/D1。
- pilot-r0-lc7、pilot-r0-lc8 已在 Windows 本機生成且有人工驗收紀錄，
  但尚未匯入 Cloudflare。匯入之前不得啟用新的雲端 TTS Runner，
  否則可能把同一段誤認為遠端 pending，重複配音。
- 保留原本 14 套 Listening 與所有已存在 MP3；不覆寫、不自動發佈。
- 禁止把 tmp/、私人 MP3、題目 JSON、任何 .env 或金鑰 commit 到 GitHub。

## 已加入 GitHub 草稿分支

- .github/workflows/listening-daily-preflight.yml：每日台灣 17:45 進行只讀檢查。
- scripts/listening-daily-preflight.mjs：最多一個遠端 GET，無付費 API。
- .github/workflows/listening-cloud-tts-once.yml：每日台灣 18:07 最多一個 TTS take。
  只有 Repository Variable LISTENING_CLOUD_TTS_ENABLED=true 才執行；預設停用。
- scripts/listening-cloud-tts-once.mjs：使用原本 buildRenderPlan、deliveryNotes、
  Gemini 3.8 speechMetadata request shape、ffmpeg 與 WAV sanity 檢查。
  本機 listening-tts-batch-safe.mjs 並未上傳，這是可在 GitHub Actions 執行的等效單次 Runner。
- cloudflare/migrations/0011_listening_auto_review_staged.sql：新增未審核音訊 ledger。
- cloudflare/src/listeningStaging.ts：暫存、取回私有音檔、核准/拒絕；R2 寫入條件限定物件不存在。
- cloudflare/src/listeningStagingPage.ts：私人試聽與 transcript 對照頁。
- cloudflare/src/listeningRefill.ts：新 API 掛載、未結案 claimed clip 阻止新 TTS claim。
- cloudflare/src/listeningRefillPage.ts：每日管理頁加上試聽審核連結。
- cloudflare/test/listening-staging.test.mjs：鑑權、一次性匯入、拒絕封鎖及不發布測試。

## 部署前必要檢查

1. 先確認 GitHub CI、Cloudflare foundation checks 完整綠燈，不得跳過任何失敗測試。
2. 你的 Windows 本機有 0010_listening_reviewed_audio_imports.sql、
   listeningReviewedImport.ts、以及修改後的 index.ts。
   目前遠端 cloudflare-migration 分支沒有這些已部署的本機修正。
   **必須先安全整合**本機 0010 與 Reviewed MP3 Import route，
   避免從 GitHub 部署時覆寫成功運作的匯入機制。
3. 先備份遠端 Cloudflare D1。確認 0010 已執行，檢查 0011 migration SQL，
   再做 Wrangler dry-run、本機回歸測試與新 Worker 的受保護測試。
4. GitHub Repository Secrets 需設定：GEMINI_API_KEY、TOEFL_MANUAL_TEST_TOKEN、
   CF_ACCESS_CLIENT_ID、CF_ACCESS_CLIENT_SECRET。禁止寫到原始碼、聊天或 PR。
5. GitHub Actions schedule **僅在預設分支**執行。本 PR 合併到非預設分支不會啟用每日排程。
6. 所有已驗收的本機 MP3（包含 lc7/lc8）都正式入庫且雲端驗證後，
   才能逐項啟用 GitHub variable LISTENING_CLOUD_TTS_ENABLED=true、
   Cloudflare Listening refill 開關及當日 TTS model policy。
7. 每個 Pacific 日都要手動在 Google AI Studio 確認 Free Tier 與剩餘 RPD。
   Worker 不能自動確認 Google 帳務，所以未簽核時自動停止；即使排程存在也不會付費呼叫。
8. 錯誤或逾時時不重新執行 TTS。D1 claim 永久保留，人工查明 R2／D1 狀態後再處理。

## 管理頁（部署本 PR 後才會出現新功能）

- 配額管理：https://toefl-prep-private.ihsuan0701.workers.dev/api/cloud/listening-refill
- 音檔人工驗收：https://toefl-prep-private.ihsuan0701.workers.dev/api/cloud/listening-refill/review

兩個頁面需受 Cloudflare Access 保護，API 再使用獨立 Bearer 管理密碼。
審核者可在瀏覽器試聽、對照文字與核准或拒絕。
核准才匯入 canonical R2 與 D1；整套題庫仍保留 draft，直到另外人工發布。

## 本機無網路測試指令

    node --check .\scripts\listening-cloud-tts-once.mjs
    node --import tsx .\scripts\listening-cloud-tts-once.mjs --self-test
    node --import tsx .\scripts\listening-cloud-tts-once.mjs --dry-run
    node --import tsx --test .\cloudflare\test\listening-staging.test.mjs

測試期間不要執行 --once、不要開啟 GitHub TTS 變數，也不要開啟 Cloudflare refill。

## 限制

本 PR 只累積正在等待完成的 Listening Set 的音檔，**尚未提供每天生成新的一套 36 段題目**。
完整自動增加新題庫仍須加入題目起草、原創與難度審查、重複檢查、完整 36 MP3 驗收及發布管理。
