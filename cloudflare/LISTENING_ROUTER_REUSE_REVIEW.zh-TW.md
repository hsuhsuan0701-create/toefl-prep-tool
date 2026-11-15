# Listening 已驗證 Router 重用與人工內容審閱（Zero-call first）

> 本流程重用 2026-11-15 真人 Gemini 3.1 Flash-Lite Structured Pilot 成功產生的 Router。通過 Zod **僅代表結構合法**，仍須先檢查 17 段內容的語言品質、題目正解與原創性。所有命令從專案根目錄執行。

## A. 同步開發分支與核對私有檔（不發出 API）

```powershell
git switch cloudflare-migration
git pull --ff-only origin cloudflare-migration
$routerFile=(Resolve-Path ".\tmp\listening-draft-pilots\router-validated-73fab01f-592.json").Path
node --import tsx scripts/generate-listening-draft.mjs "--inspect=$routerFile"
```

`--inspect` 只做本機 Router Zod 驗證，不會寫入 D1/R2、觸發 TTS 或 Gemini。請勿將整個 `tmp/` 目錄提交到 GitHub。

## B. 產生人工審閱包（0 Gemini Calls）

```powershell
node --import tsx scripts/review-listening-router.mjs "--file=$routerFile"
```

這會在 `tmp/listening-draft-pilots/` 產生 `router-validated-73fab01f-592-manual-review.md`。文件含 **全部 17 段的英語逐字稿、正解、其他選項及中文解析**，以及簡易字數範圍、重複選項、與既有 14 套原題庫的**文字完全相同**檢查。檢查結果不代表符合 ETS 官方標準，也無法自動證明答案唯一、科學正確或語意沒有重複，仍要人工判讀。

逐項確認：
- Listen and Choose（10 段）：說話者 utterance 不提前顯示給使用者，選項自然、正解只有一個、其餘選項有鑑別力
- Conversation（3 段）：雙人一男一女、交替說話、真實校園語境、80–150 字、每篇兩題
- Announcement（3 段）：40–85 字、清楚的公告目的與兩題
- Academic Talk（1 段）：175–250 字、四題；學術事實不可憑空虛構
- 全部題目：與 14 套舊題庫**不能只靠逐字稿完全相同的偵測**；還要人工檢查語意與情境重複、正解與解說一致、避免不公平文化知識推論

如果審閱結果有錯誤，**不要用 `--reviewed-router`**。可以在保留原始檔的前提下另存一份修訂版，再重新執行本機 Zod 與報告產生器。修改檔案不會產生 Gemini API 請求。

## C. 下一階段「重用 Router」的零額度預演（新功能）

```powershell
node --import tsx scripts/generate-listening-draft.mjs "--router-file=$routerFile" --structured
```

預期 `routerReused:true`，`plannedTextRequests:5`，`ttsRequests:0`。此步驟完全不發出 API，且尚未寫入 D1。

**只有在人工確認 Router 內容真正可用**，且當天 AI Studio 的 Gemini 文字 Free Tier / RPM / TPM / RPD 都足夠，才可額外提供 `--reviewed-router` 和 `--execute`。這會最多消耗 **5 次**文字模型請求（Lower 1 + Upper 1 + 三個模組各一次獨立審核），每次都無自動重試。各模組先過原始 Zod，再用 deterministic checks、跨模組難度、重複檢查和獨立審核。**全部通過後會自動寫入私人 D1 草稿佇列**，但不產生 TTS、不發布；因此要事先確認 Cloudflare Access、私有管理 token 及服務驗收。任何一步失敗即停止，不因免費額度剩餘而重試。

重用 Router 是一個**節省額度功能，不是內容自動通過標誌**。如果使用者尚未人工檢查，程式拒絕執行而不消耗 API。

## D. 音訊試聽（與新文字草稿分開）

原有雙模型真人單段試音指南在 [TTS_DUAL_MODEL_PILOT.zh-TW.md](TTS_DUAL_MODEL_PILOT.zh-TW.md)。首次請使用現有 canonical Set 作為音訊來源，**不要假設 Router 已有完整 36 段配音**。Lite 做單人 Announcement，Flash 做 Conversation；兩段真人試音均由使用者個別 `--execute`，不得自動重試，也不寫入正式 R2。

在人工審閱通過以前，將 D1 `listening_refill_enabled=false` 並讓兩款模型 `dailyLimit=0`。同一天使用 Gemini 文字生成與 TTS 時，各模型自己的 RPD 是獨立限制，但 Token 與其他服務消耗仍需自行確認 Google AI Studio 當前 Free Tier 設定。
