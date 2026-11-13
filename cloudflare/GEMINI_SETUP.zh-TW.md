# Gemini + Codex CLI: Cloudflare TOEFL 題庫增長規劃

## 已提交的功能（目前預設關閉）

- `cloudflare/src/geminiDraft.ts`：Gemini REST 生成單篇 Academic Reading 草稿及 5 選擇題。檢查 JSON、題數、四選項、答案 ID、篇幅和解析是否齊全。
- `cloudflare/src/scheduledGeneration.ts`：每日 UTC 01:00 排程，D1 限制每日最多一次嘗試。
- `cloudflare/migrations/0002_generation_drafts.sql`：儲存 `pending_review` 草稿及每日執行狀態。
- `AI_GENERATION_ENABLED=false`：預設不呼叫 Gemini、沒有模型費用。

## 使用 Gemini API

1. 在 https://aistudio.google.com/ 取得 Gemini API Key，先確認免費額度與模型是否可用。
2. 在儲存庫根目錄的 PowerShell 執行：

    npx wrangler secret put GEMINI_API_KEY --config cloudflare/wrangler.jsonc

3. 將 `GEMINI_MODEL` 調整為帳戶當下可用、適合生成 JSON 的模型（程式目前預設 `gemini-3.1-flash-lite`，需確認可用性）。
4. 建立 D1 資料庫，填入 `cloudflare/wrangler.jsonc` 的 database_id 並執行：

    npx wrangler d1 migrations apply toefl-prep-private --remote --config cloudflare/wrangler.jsonc

5. 先完成整體部署及測試。確認費用後才將 `AI_GENERATION_ENABLED` 設為 `true`，部署後每日最多產生一筆待審草稿。

## 品質與安全限制

- **尚未完成「正式 TOEFL 題組自動發布」**：原版需要 router/lowerModule/upperModule、Complete the Words、Daily Life、Academic Passage 及難度驗證。現階段只能生成單篇學術閱讀草稿。
- AI 的答案可能錯誤：格式檢查和重複比對不等同唯一正解及事實查核。所有新題先進入待審區，不供正式練習。
- 不會在公開靜態資產中放出正確答案；新增完整題庫端點時也應沿用原本 stripAnswers 邏輯。
- 不要將 Gemini Key 或其他服務憑證寫入 GitHub Repository。

## Codex CLI 的搭配方式

在自己的 Windows 電腦安裝並使用 `codex login`，透過 ChatGPT 帳號登入後，可以在本機批次生成題目、檢查 Gemini 草稿或協助改程式。不要把 CLI 登入憑證放到 Cloudflare 或 GitHub Actions；Codex CLI 不是 Cloudflare Workers 可直接啟動的程式。其是否支援無人值守的訂閱額度使用，應依官方最新規定。

## 後續開發順序

先完成 Reading 原生 Cloudflare API 與 D1 → 完整 Reading Set 生成與驗證 → 受控發布 → Listening 音檔生成 → Speaking / Writing AI 評分。

官方定價：https://ai.google.dev/gemini-api/docs/pricing