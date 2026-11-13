# TOEFL Cloudflare 私人版：Phase 0（基礎架構）

這是原始 TOEFL Prep Tool 的 **Cloudflare 開發分支**，非完整可用的 TOEFL 練習網站。保留原本 React / Vite 前端，另加 Cloudflare Worker API 與 D1 schema。目標是私人使用、多裝置共用完成的練習紀錄、不使用 Gemini 或 OpenAI 等 AI API。**不做測驗做到一半換裝置接續**。

## 現有功能與限制

- 已提供 Worker 靜態資產設定、`GET /api/health`、`GET /api/cloud/status`、D1 migration。
- **Reading、Listening、評分、Progress、題庫讀取仍未移植**：`/api/*` 未實作端點明確回傳 HTTP 501，避免產生假成績、遺失答案。
- Cloudflare Access 及 D1 尚須使用者在 Cloudflare 帳號建立並設定。
- 注意：原始 repo 會用 `better-sqlite3`、本機檔案系統、Node.js 程序（Claude/Codex、ffmpeg），不能直接作為 Cloudflare Workers API。
- **保護答題資訊**：含解答的 `data/question-sets/` **不可**複製到 `client/public/` 或其他公開 assets。

## 在 Windows PowerShell 上部署基礎版

需求：Node.js 24、Git、Cloudflare 帳號。

```powershell
git clone --branch cloudflare-migration https://github.com/hsuhsuan0701-create/toefl-prep-tool.git
cd toefl-prep-tool
npm ci
npm run build -w client
npx wrangler login
npx wrangler d1 create toefl-prep-private --location apac
```

把 `d1 create` 回傳的 `database_id` 寫入 `cloudflare/wrangler.jsonc` 中 `REPLACE_WITH_YOUR_D1_DATABASE_ID` 欄位，再執行：

```powershell
npx wrangler d1 migrations apply toefl-prep-private --remote --config cloudflare/wrangler.jsonc
npx wrangler deploy --config cloudflare/wrangler.jsonc
```

**重要：在 Cloudflare 控制台啟用 Access 並確認私人登入保護生效後，才能輸入真實學習資料。** 這個 Phase 0 只有架構檢查，不會寫入真實學習資料。

健康檢查：
- `/api/health` 應回傳 `ok: true`
- `/api/cloud/status` 在 migration 成功後應回傳 `dbConnected: true` 與 `crossDeviceReady: false`
- `/api/attempts` 應回傳 HTTP 501（尚未可用），不是 200。

## 本地測試

```powershell
node --experimental-strip-types --test cloudflare/test/worker.test.mjs
```

也可在 D1 本機模式檢查 migration：

```powershell
npx wrangler d1 migrations apply toefl-prep-private --local --config cloudflare/wrangler.jsonc
```

## 下一階段驗收標準

優先完整移植 Reading（包含 Server-side stripAnswers、適性分流、計分、解答檢討與 D1 持久化），然後才開啟正式練習路由。其後再處理 Listening、響應式布局、跨裝置已完成紀錄。即使已部署 Phase 0，不能宣稱「TOEFL 練習網站可用」或「跨裝置同步已完成」。

`main` 分支維持原樣。
