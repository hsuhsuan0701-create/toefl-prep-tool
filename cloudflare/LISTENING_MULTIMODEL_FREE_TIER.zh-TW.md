# TOEFL Listening：雙 TTS 模型 Free Tier 防護（開發版本）

這是 `cloudflare-migration` 的後續功能，尚未合併或部署。原有 14 套 Listening Set、504 個原版 MP3、答題/計分功能及所有已完成 R2 音訊都不會被更動。

## 模型與分流

| 模型 | API model id | 優先處理 | 預設 |
|---|---|---|---|
| Gemini 3.8 Flash-Lite TTS | `gemini-3.8-flash-lite-tts` | Listen and Choose a Response、Announcement | 停用 |
| Gemini 3.8 Flash TTS | `gemini-3.8-flash-tts` | Conversation、Academic Talk | 停用 |

兩者皆使用現有的 Gemini 3.8 TTS REST 請求格式與原生 Listening render plan。只有當該模型已取得**當天有效**的人工確認，且還有剩餘上限時，才會被選中。**Lite 不替 Conversation／Academic Talk 配音**；Flash 優先保留給這兩種長篇音訊，等長篇都已有處理狀態後，才可承接尚未完成的短篇 Stimulus。遇到 Google HTTP 錯誤、音訊品質不足、R2 上傳不確定時**立即停止，不換模型自動重試**。

Google 官方資料：
- [TTS 文件](https://ai.google.dev/gemini-api/docs/speech-generation)
- [價格與 Free Tier](https://ai.google.dev/gemini-api/docs/pricing)
- [配額限制](https://ai.google.dev/gemini-api/docs/rate-limits)

## 免費方案的重要限制

**Cloudflare Worker 無法直接核對 Google 專案的 Billing 設定或其他 API Key/應用程式已使用的額度。** 因此這是一套嚴格的「預設拒絕 + 每日人工確認 + 軟體內部計數」防護，而不是 Google 官方的計費保證。對於嚴格不希望付款者，應保持 Gemini API 所屬 Google 專案**未啟用付費帳務**，每天在 AI Studio 確認目前仍是 Free Tier。

- 兩個模型預設每日上限 **0**。同一天要啟用哪一款，就先查該模型在 **同一 Google 專案** 的 RPM、RPD、目前已用額度與 Billing。
- 在私人管理頁逐款輸入已確認的上限（整數 `0..10`）。只允許設定為不高於該模型**當日可用的免費請求數**；不要把第二個模型也當成固定 10 次。
- 手動確認只對**當前美國太平洋時區日期**有效。當地午夜後，系統強制視為 0，直到使用者再確認。這意味著每日定時排程在使用者尚未確認時會**不生成音訊**，是預期設計。
- 每個模型分別累積 D1 嘗試次數；一旦認領某段就計入，即使 API 出錯或中斷也不退還。相同日期、相同 Stimulus 在不同模型間無法重新認領。
- GitHub Actions Variable `LISTENING_DAILY_REFILL_ENABLED` 仍須是 `true`，Cloudflare 私人管理頁的總開關也仍須開啟。任何一個為 false 就不得排程生成。
- GitHub runner 對同一款模型的呼叫間隔保守限制至少 65 秒，且模型名稱必須出現在程式 allowlist。**不同系統或同專案的其他 API Key 仍可能消耗外部 RPM/RPD，無法由本程式量測**。
- 不進行自動付費重試、不執行付費音訊品質 AI 審核、不開啟付費備援模型。36 段皆已存入 R2 且經人工驗收後，仍需手動核准發布。

## 資料庫升級（尚未執行）

- `cloudflare/migrations/0009_listening_tts_models.sql` 新增 `listening_refill_model_attempts`，含模型名稱、日期、模型內 slot、音訊 ID、狀態。舊版 `listening_refill_daily_attempts` 不刪除，其歷史資料會匯入 Lite 模型當日紀錄。
- `cloudflare/src/listeningRefill.ts` 提供 `POST /api/cloud/listening-refill/model-policy`，必須使用既有的 Cloudflare Access + Bearer 管理授權：
  - 當日確認：`{"model":"gemini-3.8-flash-lite-tts","dailyLimit":2,"confirm":"I_VERIFIED_FREE_TIER_TODAY"}`
  - 停用模型：`{"model":"gemini-3.8-flash-lite-tts","dailyLimit":0,"confirm":"DISABLE_TTS_MODEL"}`
- `GET /api/cloud/listening-refill/status` 增加 `models`，分別回傳 `dailyLimit`、`claimed`、`remaining`、`freeTierVerifiedToday`、`ready`。
- `POST /api/cloud/listening-refill/claim` 回傳核准的 `model`，GitHub runner 才可發出那一款請求，R2 另存 `customMetadata.ttsModel`。

部署前依序：確認 CI 全綠、檢視 migration 及私人 UI、確認 R2/D1 已存在、確認 Google 專案 Free Tier 與兩款實際配額；**本 PR 不執行 migration、部署或任何 Gemini API 請求。**

## 離線檢驗

```powershell
# Windows / Node 24，專案根目錄
node --import tsx --test cloudflare/test/listening-refill.test.mjs
npm test
npm run typecheck
npm run build -w client
npm run lint -w client
```

上述測試使用虛擬 D1/R2 與本機 fixture，不使用 Gemini Key，也不消耗任何 TTS 配額。
