# TOEFL Listening 每日自動化：安全起始階段

這個版本 **只做每日自動檢查**，不呼叫 Gemini、不生成音檔、不寫入 D1/R2，也不會發布題庫。它不能被誤認為已經啟用每日自動配音。

## 已建立

- GitHub Actions 排程：UTC 每日 09:45（台灣 17:45），落在太平洋配額日午夜後。
- 每次執行先執行 `--self-test` 與 `--dry-run`；均不使用網路。
- 若設定了三個私有密鑰，才會對 Cloudflare Worker 的 `/api/cloud/listening-refill/status` 發出 **一次 GET**；沒有 POST、重試或付費模型請求。
- 產生 GitHub Actions Job Summary：顯示當日配額日期、管理開關、模型人工確認狀態及草稿佇列。
- 不碰已完成的 8 段 MP3、原有 Listening 題庫或既存 D1/R2 資料。

## 憑證（只保存在 GitHub Repository Secrets）

儲存庫 `Settings → Secrets and variables → Actions` 下設定三項 Repository secrets：

- `TOEFL_MANUAL_TEST_TOKEN`：Cloudflare Worker 的管理 Bearer token。
- `CF_ACCESS_CLIENT_ID`：Cloudflare Access Service Token ID。
- `CF_ACCESS_CLIENT_SECRET`：Cloudflare Access Service Token Secret。

禁止把密鑰貼進 issue、PR、聊天、`.env`、程式碼或 Git。沒有憑證時會安全跳過檢查；即使有憑證，本版仍只讀取。

## 重要限制

GitHub Actions `schedule` 只會在**預設分支**執行；此 PR 所在功能分支不會自行啟用每日排程。不要在審核完成前合併或打開任何 Gemini 生成排程。

已測試的 `scripts/listening-tts-batch-safe.mjs`、`scripts/import-reviewed-listening-audio.mjs` 目前只存在於 Windows 本機，未出現在 GitHub `cloudflare-migration` 分支。不能在雲端排程直接引用它們，也不能把 `.gitignore` 排除的 `tmp/` 連同私有 JSON、MP3、API Key 推到 GitHub。

## 後續實作必要條件

1. 安全移植本機 TTS 腳本、TTS prompt 與必要 helper（不提交 private 音檔、私人題目、密鑰）。
2. 建立 GitHub Actions 無狀態 Runner：從 Cloudflare 領取具備 D1 原子去重的單次生成請求；Gemini TTS 發出一次後即記帳，不自動 retry。
3. 新增 **未審核雲端暫存** 與 Cloudflare Access 保護的網頁試聽／核准／拒絕介面；人工確認前不可自動標記已核准、不可發布。
4. 每個太平洋配額日人工在 Google AI Studio 確認 Free Tier 與剩餘額度，再於現有 `/api/cloud/listening-refill` 管理頁設定兩款模型的每日上限。程式無法證明 Google Billing 是否已啟用，必須 fail closed。
5. 在全套測試之前，維持 `listening_refill_enabled=false`。網頁開關本身不等於 TTS Runner 已準備就緒。

## 離線測試

```powershell
node --check .\scripts\listening-daily-preflight.mjs
node .\scripts\listening-daily-preflight.mjs --self-test
node .\scripts\listening-daily-preflight.mjs --dry-run
```

`pilot-r0-lc7`、`pilot-r0-lc8` 尚未產生：之前只有 `--plan` 配額查詢、沒有執行 `--execute`；本次新增的唯讀排程也**不會**生成這兩段。
