# Practice/Progress 與 Listening D1 遷移

## 不再重做原專案的 UI、評分與題目格式

- `cloudflare/src/statsD1.ts` 只將 Cloudflare D1 的資料提供給**原版** `server/src/routes/stats.ts`（Hono Router），完全沿用既有 Overall、每科 Band、Targets、Skill Accuracy 及 Trends 演算法；不可憑空補上未考過科目的分數。
- 原 `/api/stats/summary`、`/api/stats/settings`、`/api/stats/trends` 從 Worker 回應，不再是 501。資料尚未完整時自然顯示 `No band yet`。
- Listening 同樣使用 **原本** `ListeningSetSchema`、`stripAnswers`、`prepareDeterministicScore`、`censusRouterItems`、`decidePath`、`computeSectionEstimate`，以及原 React Listening Drill/Simulation，完全共用 Reading 的 D1 Attempt 轉接層。
- 新增 `0007_listening_sets.sql` 建立 Listening 題組儲存及答案階段保護；繼續使用同一個 `attempts`、`item_results`、`section_estimates`，沒有第二套分數。

## 聽力音檔是必要依賴

GitHub 原有 14 份 Listening JSON 及每套數十份 MP3。**光匯入 JSON 不會有聲音**。本方案使用既有 Cloudflare Worker Static Assets 而不是另購/設定 R2：

1. 在本機 repo 根目錄跑 `npm.cmd run build -w client`。
2. 再執行 `node scripts/stage-cloudflare-listening-audio.mjs`。此程式只複製 `data/audio/stimuli/lsn-*/` 的 `.mp3` 到 `client/dist/listening-audio/`，**不複製 JSON、audio-manifest.json、文字稿、答案**。
3. 再執行 `npx.cmd wrangler deploy --config cloudflare/wrangler.jsonc`，將聲音與更新後 Worker 一次部署。**不要**在 stage 之後重新跑 Vite build，否則 dist 會被清空，必須重跑 stage。
4. 部署後使用私人匯入頁：`/api/cloud/listening-sets/import`，選擇 `data/question-sets/listening/*.json`，貼上 `TOEFL_MANUAL_TEST_TOKEN`。
5. 每份 Listening Set 匯入時會核對其 JSON 的所有 MP3 路徑均已可從 Asset Binding 讀到；若有任何聲音缺失，返回 409，**不會將無聲題組發布**。同一 Set ID 不覆寫。

實際播放路由為 `/api/audio/stimuli/<setId>/<file>.mp3`；Worker 僅允許安全的 setId/檔名及 `.mp3`，且只轉送 Content-Type `audio/mpeg` 的已部署資產。Cloudflare Access 應保護整個 Worker 網域，包括音訊路徑。

## 一次完成更新

```powershell
cd C:\Users\isaac\toefl-prep-tool
git status --short
git pull --ff-only origin cloudflare-migration
npx.cmd wrangler d1 migrations apply toefl-prep-private --remote --config cloudflare/wrangler.jsonc
npm.cmd run build -w client
node scripts/stage-cloudflare-listening-audio.mjs
npx.cmd wrangler deploy --config cloudflare/wrangler.jsonc
```

新 Migration 是 `0007_listening_sets.sql`；若前一階段的 `0006_reading_refill.sql` 尚未套用，Wrangler 會依序補齊。沒有破壞已存在的 Reading 題庫。

匯入完成後在 `/sets?section=listening` 選一份 Listening Drill 作答，並在 `/simulate/listening` 測試適性分流；Practice／Progress 頁面現在應能讀取統計資料。

## 已知限制與驗收

- Listening 目前只**移植既有** 14 套題組及其原始音檔；**沒有**自動產生新的 Listening Set／TTS。現有的 Gemini Reading 自動補庫也不會產生 Listening。
- 非官方 Listening Band 要完成一份 Router + Routed module、且全部必要題目成功計分才有；單純匯入 14 套或做部分 Drill 不會自動顯示分數。
- 沒有 Listening 跨裝置續答或 Full Test、Speaking、Writing 的完整雲端遷移。
- 原本的 TTS 聲音若已有可用性／口音問題，音檔原樣搬運不會替你重新生成。
- CI 應確認 HTML Bundle、安全音檔路徑、完整原 Listening Set D1 適性作答，以及 Stats Summary／Targets，不等於已完成手機瀏覽器真實聲音播放驗收。
- **不要將 Listening JSON 或 audio-manifest.json 放進任何公開 Assets 目錄**。
