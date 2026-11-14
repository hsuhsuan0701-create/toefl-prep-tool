# Reading Set → Attempt → Scoring → Routing → Results：Cloudflare D1

## 已完成（沿用原始專案）
- **沒有再做另一套 Reading UI**：直接使用原本 React `/sets?section=reading`、`/reading/:setId`、`/simulate/reading`、`/attempts/:id`。
- **題庫**：原本的 `ReadingSetSchema` 讀取整份 Complete the Words、Daily Life、Academic Passage / Router、Lower、Upper；`GET /api/sets` 列出 Reading；`GET /api/sets/:id` 呼叫原本 `stripAnswers`，不洩漏答案。
- **評分**：原 `deterministicScoring.ts` 先算好一整個 Task Type 的結果、再由本機 SQLite writer 或 D1.batch 一次提交。MCQ、CtW 仍使用原本 scorer，沒有兩套分數。
- **分流**：原 `censusRouterItems` + `decidePath`、0.6 promotion threshold；只有 Router Module 全部計分才可分流，且結果持久保存，重送不會改變。
- **完成與成績**：原 `computeSectionEstimate` 及 `estimateBandTable3`；只有完整的 routed Simulation 才產生 Table 3 非官方 Band Estimate，Drill 沒有 Band；`GET /api/attempts/:id` 回傳原 React 需要的結果與錯題檢討結構。
- **隱私/可靠性**：答題前不傳 key 或 explanation；Simulation 完成前不透露正誤；D1.batch 整批計分，SQL trigger 防止在結束／錯誤 Module 寫入；首次成功送出的結果在 D1，跨裝置能讀到完成紀錄。Cloudflare Access 保護整個 Worker。
- **單獨的 Academic Practice 草稿功能仍保留作既有測試與資料**，但**不會**把其草稿自動轉為完整 Reading Set，也不作為未來主題型的第二套維護路線。

## 唯一新增的資料表
`cloudflare/migrations/0005_original_reading_sets.sql`：`reading_sets`，並為既有 `attempts` 增加 `flagged`，加上 Reading score stage DB trigger。**不刪除先前的 D1 資料**。原 `attempts`、`item_results`、`section_estimates` 重用，不另建一套。

## 私人一次性匯入既有 Set
原完整 JSON 題庫位於本機 `C:\Users\isaac\toefl-prep-tool\data\question-sets\reading\`（GitHub 倉庫中有八份）；**絕對不要**複製到 `client/public`。

升級 Worker 後，開啟：

`https://toefl-prep-private.ihsuan0701.workers.dev/api/cloud/reading-sets/import`

通過 Cloudflare Access，選擇上述資料夾的多個 `.json` 檔案，輸入 `TOEFL_MANUAL_TEST_TOKEN`，確認後批次匯入。每份原 Set 經 `ReadingSetSchema` 完整驗證（及 item ID 唯一性驗證）才寫入 D1；相同 ID 不覆寫。這是**一次性資料遷移**，不是每日生成題目。匯入後可以從 `/sets?section=reading` 開啟原版 Reading Drill、或 `/simulate/reading` 進入適性 Reading Simulation。

## Windows 部署（一次）
```powershell
cd C:\Users\isaac\toefl-prep-tool
git status --short
git pull --ff-only origin cloudflare-migration
npx.cmd wrangler d1 migrations apply toefl-prep-private --remote --config cloudflare/wrangler.jsonc
npx.cmd wrangler deploy --config cloudflare/wrangler.jsonc
```

確認遷移 `0005_original_reading_sets.sql` 已成功套用後，才部署。

## 目前沒有移植、不可誤稱完成
- 完整原版 **AI Reading Set 自動生成／多輪 Verifier 與 AI 修復**：仍依賴 Node / Claude/Codex CLI。新 Gemini 測試只生成單篇 Academic 草稿，不是完整 Reading Set。`AI_GENERATION_ENABLED` 維持 `false`。
- Listening、Speaking、Writing、Full-Test Run 及完整 Dashboard Stats/Progress API：尚未移植，這些端點仍回傳 501；不要在 Cloudflare 上對它們宣稱可以作答或給分。
- 未完成的 Attempt 不支援跨裝置接續；完整已完成的歷史紀錄可以跨裝置讀取。
- 閱讀題庫應用僅假設 **Cloudflare Access 單一私人使用者**；沒有多使用者紀錄隔離。
- `estimateBandTable3` 是原專案規則得出的**非官方**估計，並非 ETS 計分服務；輸入文章是否符合科學證據仍需要獨立評估。
- 匯入的是已存在的完整 Reading Set，不是 `generation_drafts` 的單篇草稿；拒絕將有爭議的單篇草稿冒充通過完整原版驗證。

## 驗收
`cloudflare/test/reading-d1-e2e.test.mjs` 會用倉庫真實完整 Reading Set 驗證：token 保護匯入、遮罩、Drill、重複提交、Router/Upper 路由、完成後 Table 3、D1 歷史與正確答案只在適當時機揭露。

本機或 GitHub CI：
```powershell
node --import tsx --test cloudflare/test/reading-d1-e2e.test.mjs
```
