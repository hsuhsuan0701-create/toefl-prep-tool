# Listening 雙模型 Free Tier：D1 Migration 與 Cloudflare 上線操作書

**狀態：僅計畫；尚未執行遠端 D1 遷移、Cloudflare 部署、Gemini 配音或 GitHub 正式排程。**

## 上線前阻擋條件（任何一項未通過就停止）

1. PR #1 測試修正已合併至 `cloudflare-migration`；PR #2 Cloudflare 與完整 CI 均通過，完成程式碼審查。
2. Google AI Studio 當前 **同一 API 專案**為 Free Tier、**未連結任何付費 Billing**。確認 `gemini-3.8-flash-lite-tts`、`gemini-3.8-flash-tts` 的模型狀態、各自 RPM / RPD、目前同一 Pacific 日已用次數，以及是否存在 TPM/TPD 或其他限制。不假設各 10 次。檢查 GitHub Actions Secret 的 Gemini Key **確實屬於該專案**；不要讀出或貼出金鑰。
3. Google 官方 Free Tier 並非可在 Worker 偵測的帳務狀態。本地每日模型許可只是一份人工聲明，**不能保證不會有任何外部費用**；嚴格零 Google 費用需同時讓 Google 專案保持未啟用付費帳務。
4. 先比較 Flash/Lite 各一段代表性 WAV（Lite 短篇、Flash 雙人 Conversation）。檢查聲線、角色不串音、疊字/漏字、語速，並人工完整試聽。Gemini 3.8 Flash TTS 曾有 2026-11 公開的多講者聲線偏移回報，不應僅憑數位 WAV 檢查就發布。
5. Cloudflare D1 和 R2 的現有 binding、私有 Bucket、Access 與相關額度/帳單已確認；勿建立公有 R2 Bucket。確認原本題庫/Attempts 可以正常查詢，並預先安排回復程序。
6. GitHub Actions Variable `LISTENING_DAILY_REFILL_ENABLED=false`，私人管理頁將 `listening_refill_enabled=false`。**先停，再遷移**。確認 GitHub Actions 中沒有正在執行的 Listening runner，也沒有未完成的 claim。不要在遷移和部署中途開啟舊 runner。

## 階段 A：僅讀取與備份（尚不改正式資料）

在 Node 24、Wrangler 已登入的專案根目錄，確認指向正確 Cloudflare 帳號及 `cloudflare/wrangler.jsonc`。

```powershell
git status --short
git switch cloudflare-migration
git pull --ff-only origin cloudflare-migration
# 只在 PR #2 通過審查並整合至此分支後進行以下指令
npx wrangler d1 migrations list toefl-prep-private --remote --config cloudflare/wrangler.jsonc
npx wrangler r2 bucket list --config cloudflare/wrangler.jsonc
```

確認要套用的僅有已審核的 `0009_listening_tts_models.sql`，且 0001–0008 已套用。若有其他未知 migration 或不一致版本，先停止。

導出私有 D1 備份，保存在本機私有且 **git ignored** 的目錄，包含題庫、用戶作答與鑑別資訊，不可上傳 GitHub：

```powershell
New-Item -ItemType Directory -Force .\tmp\d1-backups | Out-Null
npx wrangler d1 export toefl-prep-private --remote --config cloudflare/wrangler.jsonc --output=./tmp/d1-backups/before-listening-multimodel.sql
```

Cloudflare 官方文件：
- https://developers.cloudflare.com/d1/wrangler-commands/
- https://developers.cloudflare.com/d1/best-practices/import-export-data/

## 階段 B：遠端遷移（須在停止狀態）

```powershell
npx wrangler d1 migrations apply toefl-prep-private --remote --config cloudflare/wrangler.jsonc
```

**關鍵安全點**：`0009` 只會在執行 migration 時複製「當時」舊的 `listening_refill_daily_attempts` 到新的 `listening_refill_model_attempts`。如果舊 runner 在 migration 與切換新版 Worker 的空檔又寫入舊表，該次消耗不會自動反映在新表；因此不能省略「事先關閉排程與確認沒有執行中的任務」。不要同時跑兩版 Worker/runner。

遷移後只用讀取查詢核對模型資料表、歷史列數/狀態，確認當天已用的 Lite 次數不會遺失。**勿刪除舊表或舊資料**。

## 階段 C：Worker 部署與唯讀驗證（依然停止配音）

```powershell
npm run deploy:cloudflare
```

先確認 Cloudflare Access 和 Bearer 管理 token 有效、狀態頁顯示 `models` 陣列、兩款模型均 `ready:false` / `dailyLimit:0`，並確認 R2 binding 是私有的。重新抽查既有 Listening 題庫、音檔、作答、Reading、Dashboard 都不受影響。

此時網站可以上線展示管理 UI，但 `LISTENING_DAILY_REFILL_ENABLED` 與後端總開關仍保持 false；不要啟用任何配音工作。GitHub scheduled workflow 僅在預設分支運行：如果尚未整合到預設 `main`，每日任務仍然不會自動運行。不要為了啟用排程而匆忙合併未驗收的整套 Cloudflare migration 至正式 `main`。

## 階段 D：Google 實際數據確認與單段試音

請開啟 https://aistudio.google.com/rate-limit ，選相同 Gemini API Project、`All models`，取得兩款 TTS 的 RPM / RPD / 今日使用量；再開 Billing 確認該專案沒有付費連結。

把當日每個模型可用的 `remainingRPD` 視為上限，還須扣除你預計留給其他工具使用的緩衝。這個程式的 `dailyLimit` 是**本程式當日允許使用的總次數**，不是 Google 的官方配額；也要扣除 D1 中當日已消耗的該模型次數，寧可低估。若有任何不確定，維持 0。

先透過既有手動單段試音比較兩模型（需要明確主動啟用，會消耗 Google 免費 TTS 額度；不納入本次 PR 自動執行）。監聽新 Flash 的雙角色聲線是否串音；驗收完成前不要啟用 36 段排程。

## 階段 E：小量開啟而非立即 20 次

- 先將 **Lite 及 Flash 都維持 0**，確認私有草稿已通過完整文字與答案審核並存入 D1；缺完整 36 段草稿就不得配音。
- 確定免費限制、音質與 R2 上传均合格後，才可在私人管理頁人工確認當日模型上限；建議初次設 **每個模型至多 1 次**，不代表 Google 有 1 次可用，仍要先確認當日額度。
- 需要人工啟用 GitHub Actions 排程與後端總開關；兩者同時 true 才可能發出新請求。先人工執行一次 workflow，檢視 D1/R2、MP3 可讀取與模型標記。
- 36 段全部檢查過後，才可手動發布。壞音可人工 flag，但不會自動免費重試。

## 中止與回滾

發現任何不明配額、音檔疊字、R2 不一致、D1 偏移、400/429/5xx、CI 失敗或 Google Billing 不確定，就立即關閉 GitHub 及 Cloudflare 兩個開關。**已發出的請求可能仍會完成，切勿直接重試或跨模型重做同一段。**

只回滾 Worker 程式碼不能恢復**配額一致性**：舊 Worker 使用的 `listening_refill_daily_attempts` 不會自動記下新模型 ledger 的請求。因此回滾後必須保持所有 TTS 排程停用，直到確認當日所有嘗試均已人工核對，或待下一個 Pacific 配額週期後再重新審核。保留新增 D1 表與所有 R2 物件；不要以刪除資料表作為簡易回滾。

## 此次 PR 的界線

本 PR 的 CI 只驗證離線 mocks、原版資料結構與 TypeScript，未執行任何 Google TTS API、正式 Cloudflare 遷移、部署或使用者帳務查詢。
