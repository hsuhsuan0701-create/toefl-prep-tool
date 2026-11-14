# Academic Reading Practice MVP（Cloudflare）

這是獨立的學術閱讀練習（Academic Passage），**不是**原專案完整適性 Reading simulation。

## 已實作

- `/api/cloud/academic-practice`：手機、平板、電腦可用的練習頁。
- `GET /api/cloud/academic`：只列出人工核准的草稿；不傳送答題金鑰。
- `GET /api/cloud/academic/:id`：文章 + 五題，伺服器剝除正解、skill、解釋。
- `POST /api/cloud/academic/:id/submit`：五題全答後伺服器計分，寫入獨立 D1 歷史表；成功寫入才回傳分數及解析。
- `GET /api/cloud/academic/attempts` / `GET /api/cloud/academic/attempts/:id`：完成紀錄與單次檢討。
- `/api/cloud/gemini-review`：私人草稿檢視、新增人工「核准／退回」表單（再次驗證管理 token）。
- `POST /api/cloud/academic/review/decision`：需 Access 登入、另外的 `TOEFL_MANUAL_TEST_TOKEN`、同源 JSON 請求、書面原因；核准須逐項勾選事實／答案／原創性檢查。狀態僅可由 `pending_review` 轉換一次。
- 完成練習僅提供 raw 5 題正確數（非 ETS 量尺或適性成績）。
- Gemini Cron 維持 `AI_GENERATION_ENABLED=false`；未經審核的文章絕不開放作答。

## Windows 部署（在 repo 根目錄）

```powershell
cd C:\Users\isaac\toefl-prep-tool
git status --short
git pull --ff-only origin cloudflare-migration
npx.cmd wrangler d1 migrations apply toefl-prep-private --remote --config cloudflare/wrangler.jsonc
npx.cmd wrangler deploy --config cloudflare/wrangler.jsonc
```

Cloudflare Access 必須先確定**所有 Worker 路徑**都受到私人登入保護。執行 migration 前可先用 Wrangler D1 export 備份。請確認 `0004_academic_practice.sql` 套用成功，才部署新 API。

部署後開啟：

- 練習：https://toefl-prep-private.ihsuan0701.workers.dev/api/cloud/academic-practice
- 草稿審閱：https://toefl-prep-private.ihsuan0701.workers.dev/api/cloud/gemini-review

若尚無 approved 文章，練習題庫顯示空白。**2026-11-14 的 mycorrhizal networks 草稿先前被判定內容科學敘述待修，請勿直接勾選「已查核」核准**。必須先修正並重新核實文獻、答案與重複性，或改用一篇已驗證的草稿。現有編輯功能尚未支援直接修改 draft。

## 限制與下一步

- 這個 MVP 是獨立 Academic Passage；尚不支援 Complete the Words、Daily Life Reading、適性分流與完整 TOEFL Set。
- 目前只採用 Cloudflare Access 的私人單使用者部署前提；尚無多使用者資料隔離與權限管理。
- 完成紀錄可跨裝置讀取，但不提供未完成作答跨裝置繼續。
- 核准的 editor checklist 是人工聲明，不等於外部文獻自動查核。
- 尚未建立來源導向生成、重新編修草稿 UI、正式難度校準或標準化 TOEFL 分數。
- 草稿審閱目前一次顯示最新 pending，不支援完整審稿清單。

## 2026-11-14 共用核心整合（避免重工）

- **唯一 MCQ 評分器**：既有 `server/src/services/mcqScorer.ts` 改為 re-export `shared/src/mcqScorer.ts`。原 Node 版與 Cloudflare Academic Practice 都呼叫同一個 `scoreMcq`；不再維護兩份判分比較。
- **唯一 MCQ 答案遮罩**：Cloudflare 改用原 `shared/src/servedSet.ts` 的 `stripMcqQuestion`（現公開匯出）；正解、skill、解析都由共用程式移除。
- **原 Reading 題目 Schema**：Gemini 草稿用 `mcqQuestionSchema(ReadingSkillCategory)` 驗證問題欄位及 skill；既有草稿額外限制（五題、四選項、中文解析下限、選項與題目不重複）仍額外執行。
- 沒有新的 D1 migration，也沒有修改已保存的草稿、審閱狀態或練習紀錄。
- **尚未移植**：原 Reading Set 的完整多題型生成、五輪 Verifier／remediation、Module routing、整體評分與舊前端流程。原 `generationCheckPolicy` 仍按原專案定義，**不是每項警告都阻擋發布**，也不是已實現外部來源的事實查核。請勿將簡化 Academic 草稿的通過誤認為原完整 Set 驗證通過。

正式架構方向：單一原專案共享的 Schema／答案隱藏／評分；Cloudflare Worker 僅負責 Web API、D1 持久化與 Gemini 供應者整合，避免長期維護平行系統。
