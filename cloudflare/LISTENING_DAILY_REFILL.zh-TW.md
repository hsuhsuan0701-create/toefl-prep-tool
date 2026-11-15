# Listening 每日累積 3 段 MP3：部署狀態與啟用條件

**目前是已提交 GitHub 的封閉測試版本，尚未部署、尚未啟用每日自動產生音訊。**

原版網站及 14 套 Listening Set 的呈現、作答、計分和路由完全保留。
新功能只利用與原版相同的 ListeningSetSchema、buildRenderPlan、deliveryNotes，為一個完整 **36 clips** 的候選 Listening Set 持續增加音檔。

## 如何停止、恢復（不刪任何已完成的音檔）

**正式部署後，管理頁是 `https://toefl-prep-private.ihsuan0701.workers.dev/api/cloud/listening-refill`。**

1. 開啟上面的私人管理頁，輸入 `TOEFL_MANUAL_TEST_TOKEN`（不是 Gemini API Key）。
2. 點「停止每日 Listening 生成」，確認後畫面會顯示「已停止」；後端每次 `claim` 都會重新檢查 D1 `settings.listening_refill_enabled=false`。**新的 Gemini 語音請求不再領取**，但停用瞬間已發出的請求可能仍完成。
3. 若想更徹底停用每日排程，到 GitHub repository **Settings → Secrets and variables → Actions → Variables**，將 `LISTENING_DAILY_REFILL_ENABLED` 設為 `false`。此開關控制整個 GitHub Actions job 是否執行；既有題庫、R2 MP3、D1 進度都保留。
4. 日後需要恢復，先確認實際 Google Free Tier／R2／排程，再在私人管理頁選「恢復」，並將 GitHub variable 設為 `true`。**兩個開關都啟用才有可能開始新的 TTS 請求**。

最安全的停止方式是**兩個開關都關閉**。即使 GitHub Actions 在關閉後仍執行了一次，後端的停止開關也會拒絕新的 claim。若要永久停用，可以到 GitHub 的 **Actions → Daily Listening MP3 refill (opt-in) → Disable workflow**；不要刪除 R2 或 D1，否則會遺失已完成的累積內容。

> 注意：停止的是 Listening 每日生成，不會關閉 TOEFL 網站、原本的 Reading 題庫或 Listening 練習。

## 每日生成規則

- **每日最多 3 次 Gemini Flash-Lite TTS 請求**：以 Google Pacific 當地日期計算；所有網站/金鑰共用的 Google 專案配額**無法由這個工具保證**，這只是本程式內部的上限。實際是否免費請查 Google AI Studio 的專案 Usage/Billing。
- **一旦領取了某次生成機會（claim）就永久記入 D1 的當日消耗紀錄**，即使 API 呼叫失敗、網路斷線、GitHub Actions 超時或本機關閉，也不會重新使用該次紀錄。遇到 429 立即停止，不做付費重試。
- **先有完整且通過原版 schema/題目 ID 驗證的 36-clips Listening 草稿**。不會一邊生成題目、一邊將未完成 Set 發布。新的文字題目自動生成 **尚未整合**；目前需先以可信任的外部流程準備原版格式候選 Set JSON，才有音訊可生成。
- **一次只有一套草稿**被執行，並依原本 Router → Lower → Upper 的順序領取每段；只有 pending clips 才可領取，成功上傳的 clips 不會重做。
- **WAV → 免費檢查（完整性／時長／異常靜音／概略語速）→ ffmpeg MP3 → R2**。不呼叫語音轉錄、不呼叫付費 AI 審核，不自動為語速偏離重配音。
- **人工聽到疊字／漏字的 clip 可「flag」阻止發布**，並且只能經由另一次明確管理員核准重排後續日的重做；不補發當日配額。
- **所有 36 個 MP3 上傳 R2 並存在確認後，才可由管理員帶指定確認字串發布**。未發布草稿的原文、答案與音訊不會出現在一般練習 API。MP3 播放位址保持原版的 \`/api/audio/stimuli/<setId>/<clip>.mp3\`。
- 對於「已上傳但 R2 儲存與 D1 狀態未同步」的異常，**禁止自動重做**，必須人工恢復，不得重複消耗 Gemini。

## 目前已完成的程式碼

- \`cloudflare/migrations/0008_listening_refill.sql\`：持久化 Listening 草稿、逐段完成狀態、每日 claim ledger。
- \`cloudflare/src/listeningRefill.ts\`：需私人管理 token 驗證的草稿匯入、每日領取、MP3 上傳、明確標記壞音、人工核准恢復、公開前 36 段檢查與發布。
- \`scripts/refill-listening-daily.mjs\`：Node 24 腳本，一天最多 3 次；沿用原版聲線、講者、語速提示；原生 WAV 作為轉檔來源，使用 ffmpeg 產生 MP3。
- \`.github/workflows/listening-daily.yml\`：預設沒有啟用的每日排程，09:00 UTC（台灣約 17:00）。**GitHub schedule 只在預設分支運行，因此 cloudflare-migration 分支內不會自動排程。**
- \`cloudflare/test/listening-refill.test.mjs\`：測試配額限制、重複上傳拒絕、沒有 36 段不能發布，以及壞音修復仍保留已消耗的請求紀錄。

## 尚未完成的部署與前提

1. **需要在你自己的 Cloudflare 帳戶操作一次**（不能從 GitHub 原始碼直接替你建立）：
   ```powershell
   cd C:\Users\isaac\toefl-prep-tool
   git pull --ff-only origin cloudflare-migration
   npx wrangler login
   npx wrangler r2 bucket create toefl-listening-audio
   ```
   先確認帳戶已啟用 R2，並接受 Cloudflare 顯示的方案與費用條件。若已存在同名 bucket，請先用 `npx wrangler r2 bucket list` 確認，不要重複建立。
2. GitHub 的 `cloudflare/wrangler.jsonc` 已準備好私人 R2 binding `LISTENING_AUDIO`，指向 `toefl-listening-audio`。**bucket 建立前不要部署這版 Worker**。不要把 bucket 設為公開讀取。
3. **完成 R2 後**，才執行一次 D1 migration 及 Cloudflare deploy：
   ```powershell
   npx wrangler d1 migrations apply toefl-prep-private --remote --config cloudflare/wrangler.jsonc
   npm run deploy:cloudflare
   ```
   先檢查 Worker 與原版題庫仍正常，且新的管理頁在 Cloudflare Access 後能讀到 `r2Configured:true`。**這些是實際部署命令，目前尚未在你的 Cloudflare 帳戶執行。**
4. 匯入一個原版格式、已通過題目品質驗證的完整 36 clips Listening 草稿。建立草稿不呼叫 TTS；未建立草稿時每日 runner 不會生成音訊。
5. 將此工作流程合併至 GitHub **預設分支**後，於 GitHub repository Actions secrets 設定 \`GEMINI_API_KEY\`、\`TOEFL_MANUAL_TEST_TOKEN\`、若必要則 \`CF_ACCESS_CLIENT_ID\` / \`CF_ACCESS_CLIENT_SECRET\`，Actions variable \`TOEFL_WORKER_URL\` 設定正式網址；確認 Cloudflare 本身的 Private Access 與管理密碼已就緒。
6. **先人工測試一段**，確認 MP3 與 R2 都正常，再將 Actions variable \`LISTENING_DAILY_REFILL_ENABLED\` 設成 \`true\`。
7. 每日會保守消耗「最多 3 個 TTS 呼叫」。這不能防止 Google 因專案處於 Paid Tier 而計費。**如果嚴格要求零付費，必須確認 AI Studio 目前實際 Free Tier 狀態並另外設立預算／配額限制**。

## 管理 API（皆需 Cloudflare Access + Bearer 管理 token）

- \`GET /api/cloud/listening-refill/status\`：只顯示草稿和各音訊狀態，含當日 claim 次數。
- \`POST /api/cloud/listening-refill/draft\`：送原版 ListeningSetSchema JSON；拒絕重複 ID。
- \`POST /api/cloud/listening-refill/claim\`：\`{"confirm":"CLAIM_LISTENING_TTS_ONCE"}\`，需已設定 R2；含當日剩餘次數限制。
- \`POST /api/cloud/listening-refill/upload?setId=...&stimulusId=...\`：\`Content-Type: audio/mpeg\`，僅接受已 claim 的 clip。
- \`POST /api/cloud/listening-refill/flag\`：\`{"setId":"...","stimulusId":"...","confirm":"FLAG_BAD_AUDIO"}\`。
- \`POST /api/cloud/listening-refill/reset-flagged\`：\`{"setId":"...","stimulusId":"...","confirm":"RESET_FLAGGED_NEXT_DAY"}\`，需再次明確核准。
- \`POST /api/cloud/listening-refill/publish\`：\`{"setId":"...","confirm":"PUBLISH_REVIEWED_LISTENING_SET"}\`。此 API 不做 Gemini 請求，並會驗證 36 個 MP3 都已在 R2。

## 本地檢查／不消耗任何 API

\`\`\`powershell
cd C:\Users\isaac\toefl-prep-tool
git pull --ff-only origin cloudflare-migration

# 基本檢查：不需要任何 API Key
node --import tsx scripts/refill-listening-daily.mjs

# 將已有 WAV 檢查並轉為 MP3，不用 Gemini
node scripts/check-listening-wav.mjs ".\tmp\tts-trials\lsn-03948a55\conv-r1-gemini-3.8-flash-lite-tts.wav" --mp3
\`\`\`

**注意**：第一個 dry-run 如果本機沒有管理 token，只會列出停用訊息，不會讀取雲端的私人庫存資訊。現階段也**不要**執行 \`--execute\`，因為 R2 與 D1 尚未完成正式部署。
