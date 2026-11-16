# TOEFL Listening — GitHub 每日安全作業手冊

此文件只記錄 **GitHub 排程**，不改動正式 Worker 的 D1/R2、既有題庫或私人音檔。
已上線的 Worker 使用版本 `7467227`；GitHub 單次 TTS runner 也固定 checkout 此版本，避免默默變更配音行為。
GitHub repository 預設分支為 `main`，兩項新排程均存在 `main`；原本 Draft PR #6 仍可獨立審查。

## A. 每日唯讀檢查：已排程

- GitHub workflow: `.github/workflows/listening-daily-audit-readonly.yml`
- 排程：**17:45 台灣時間**（UTC 09:45），亦可在 GitHub Actions 手動執行。
- 需要 GitHub Secrets：`TOEFL_MANUAL_TEST_TOKEN`、`CF_ACCESS_CLIENT_ID`、`CF_ACCESS_CLIENT_SECRET`。
- 不使用 `GEMINI_API_KEY`。
- 僅對私人 Worker 進行兩個 Access + Bearer 驗證的 GET：
  - `/api/cloud/listening-refill/status`：檢查待生成、已上傳、claimed/flagged、R2 **binding** 是否存在、每日配額與是否已人工確認。
  - `/api/cloud/listening-refill/staged`：檢查待人工驗收音檔筆數；不把逐字稿或音訊寫入 GitHub logs。
- R2 綁定存在不等於每個 R2 物件均已驗證音質／雜湊。
- 兩次 GET 均失敗不重試；身份驗證失敗或數量不一致時 Workflow 紅燈，需人工排查。
- **Gemini 呼叫、資料庫寫入、R2 寫入及發布：均為零。**

## B. 每日最多一段 TTS：已排程但預設停用

- GitHub workflow: `.github/workflows/listening-daily-one-tts-guarded.yml`
- 排程：**18:07 台灣時間**（UTC 10:07）；GitHub 不保證排程精確準時。
- 只保留排程觸發，避免誤觸手動執行。需要人工測試請使用既有的 `listening-manual-one-tts-safe.yml`。
- **雙重 GitHub Repository Variables 開關**：以下兩者都必須是字串 `true` 才會開始安全前置檢查（缺少任何一個都不會配音）：
  - `LISTENING_CLOUD_TTS_ENABLED`
  - `LISTENING_DAILY_TTS_SCHEDULE_ENABLED`
- 兩個變數初始可不存在或設為 `false`。**建立排程不等於已啟用。**
- 除了雙重開關外，正式 Worker 還必須符合：
  1. `listening_refill_enabled=true`（在私人每日管理頁啟用）。
  2. **當日**登入 Google AI Studio，人工確認 GitHub 使用的 API Key 對應同一個 Free Tier 專案、未啟用 Billing、該模型實際剩餘 RPD 足夠；沒有自動查證 Google 帳務的機制。
  3. 網頁模型配額政策：**恰好一款 TTS 模型人工驗證後設定每日上限 1，另一款上限 0**；伺服器使用 America/Los_Angeles 的當日日期判斷是否仍有效。
  4. D1 題庫仍有 pending 音訊，沒有 claimed/flagged 等未結案任務，沒有 R2 待人工驗收的 staged 音訊。
  5. 可讀取私人 Worker/R2 綁定與全部 Secrets。
- 所有檢查通過，才安裝相依套件並執行已實際成功驗證過的 `scripts/listening-cloud-tts-once.mjs --once`。
- D1 在呼叫 Gemini 之前，原子化記錄 **one-use quota claim**。即使出錯、逾時、未知結果，也**不自動重試**或退回當日次數。
- 音檔只進私人 R2 `staging/` 暫存；**不會自動核准、取代 MP3 或公開題庫**。人工試聽核准後才搬入 canonical R2 與更新 D1。
- GitHub Scheduled workflows 僅在預設分支 `main` 執行；這份 runner 固定 Git commit `7467227f3f3fcdc9e151ec4518d918976f4cf227`，要升級請另行審核。

## 每日人工操作

1. 先打開 Google AI Studio 該 API Key 的專案，查 Free Tier、Billing 與兩款模型各自剩餘 RPD。截圖請勿包含 API Key。
2. 在私人 Listening 管理頁，只將實際要用的模型 cap 設為 **1**，另一個設 **0**。按「恢復每日 Listening 生成」前，確認沒有待驗收或 claimed 音檔。
3. 如果希望當天 18:07 附近由 GitHub 排程自動執行，確認上述 **兩個 GitHub Variables** 都是 `true`。不願意每天自動執行，就保持 `false`。
4. GitHub 排程正常送出一段後，至私人驗收頁聽音檔、對照逐字稿，再人工「核准並匯入」或「拒絕」。未確認結果時，**不要再次執行生成**。
5. 若要立即停止，按私人管理頁「停止每日 Listening 生成」，並將任一個 GitHub Variables 改成 `false`；已開始的 Gemini 請求可能仍會完成。

## 現況及限制

- 2026-11-16 完成人工驗收後，`lsn-a97620b2c800` 為 **11 uploaded / 25 pending / 0 claimed**，整套題庫仍非 published。
- 當日 Lite TTS 已使用本程式額度 **1/1**，不能再次發送。隔天需重新確認免費額度。
- 這兩個排程只補齊**現有** Listening 草稿的音檔，不會每天新生成一整套 36 題或自動發布。
- 本 repository 為 public：GitHub Actions summary 可供外界查看，因此報告只列數量與模型狀態，不記錄密碼、逐字稿、音檔或私人金鑰。
- 若 Google Free Tier／Billing 未確認，**禁止假設 Gemini 請求免費**；當日未確認時，自動配音流程會被後端拒絕。
