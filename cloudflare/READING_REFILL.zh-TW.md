# Cloudflare：原版 Reading Set 自動補題（低庫存觸發）

## 核心行為

- **使用原本 Reading Sets**：新題存入現有 `reading_sets`，立即出現在原版 `/sets?section=reading`，不再開第二套 Reading 練習。
- **庫存門檻**：`unused < 3` 才嘗試。已作答認定同原版列表：任一 Attempt 有至少一題 `scored`。
- **最多每天一套／UTC 日**：同一天發生 503、驗證失敗等情況也不會一再扣 Gemini 額度；紀錄在 `reading_refill_runs`，不會清除任何舊題或 Attempt。
- **UTC 每天 01:00（台灣時間約 09:00）**由原本的 Cloudflare Cron 檢查。初次部署仍為 `AI_READING_REFILL_ENABLED=false`，且 D1 `settings` 的 `reading_refill_enabled` 可由私人管理頁面啟用或關閉，不必改環境變數或重新部署。
- **生成的完整題組**：沿用 `ReadingGenerationInputSchema` 的 Router、Lower、Upper 三模組，每套分別含 Complete the Words（2+1+1）、Daily Life（3+2+0）、Academic Passage（1+1+1）。
- **共用已存在的純函式**：`deriveCtwGaps`、`ReadingSetSchema`、`indexDeterministicItems`、`compareReadingModuleDifficulty`、`readingModuleBandVerdict`、`entriesFromSet`、`compareCatalogEntries`、`referencesOptionByPosition`；除此之外加一個嚴格的文字／答案驗證、5-gram 重複檢查及獨立 Gemini 審核。只有全部通過才一次寫入 `reading_sets`。
- **限制**：原本完整的 Claude/Codex `verifyReadingSet` **不能直接在 Worker 執行**，這版也尚未移植原先的五輪修復流程；獨立 Gemini 查核仍可能漏掉學術事實錯誤，尤其不等同查核引用文獻。若驗證失敗會直接拒絕，不會降低門檻強行發布。
- **額度注意**：一份完整 Reading 題組至少需 3 次模組內容生成、4 次 CtW 解析與 3 次模組審查，遇到暫時性 Google 503 還可能有 API 重試；費用及耗時可能明顯高於一篇短文。不可將模型可連線視為完整生成已測試成功。

## 一次部署

從 Windows PowerShell：

```powershell
cd C:\Users\isaac\toefl-prep-tool
git status --short
git pull --ff-only origin cloudflare-migration
npx.cmd wrangler d1 migrations apply toefl-prep-private --remote --config cloudflare/wrangler.jsonc
npx.cmd wrangler deploy --config cloudflare/wrangler.jsonc
```

**請先確認 migration `0006_reading_refill.sql` 套用成功，再部署**。不需要重設 Gemini Key、Cloudflare Access 或管理測試密碼，也不用重新匯入八套 Reading Sets。

## 如何使用

打開（需 Cloudflare Access）：

`https://toefl-prep-private.ihsuan0701.workers.dev/api/cloud/reading-refill`

頁面可查看庫存、最後執行時間、執行結果、是否啟用；可用已存在的 `TOEFL_MANUAL_TEST_TOKEN` 做一次手動補題，也可同頁開關每日補題。

**重要**：目前已有八套未作答 Reading Sets，因此按「手動補充」只會顯示 `skipped`，不會呼叫 Gemini。這是預期行為，不需要為了測試而把現有題組標記成完成或刪除。等未作答降到兩套以下再測試完整生成；成功後才建議在同頁開啟每日自動補題。

若測試出現 `failed`，請查看本頁的 `result` 或 `lastRun.error_code`；同一 UTC 日不能重試，避免繞過成本保護。次日才可重新嘗試。此機制不會刪題或改分。

## 現階段不可宣稱完成

- 尚未使用真實 Gemini 金鑰成功驗證**整套**新 Reading Set；GitHub Actions 只使用模擬 API／D1，確保安全邏輯與原版接口相容。
- 尚未達成「永遠至少 3 套」的保證：每天最多嘗試一套，模型失敗或題目不符合門檻時庫存不會補上。
- 目前仍無已核實外部資料來源的文章生成、完整 AI 修復、難度考生實測校準或多使用者隔離。
