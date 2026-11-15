# Gemini Listening 文字草稿 HTTP 400：相容性修正與離線驗收

**狀態：工程修正已在開發分支；尚未證實舊的 HTTP 400 已被真人 API 試跑排除，也沒有為此重送 Gemini 請求。**

## 已知事實

1. 先前 `--pilot --structured --execute` 曾回傳 HTTP 400，沒有產生可供驗證的內容；當時未保存完整 Google 錯誤正文，無法回溯證明確切根因。
2. 另一輪非 structured 文字生成曾回傳 JSON，但未通過本專案嚴格的原版 Listening Zod 驗證；**兩類失敗是不同問題**。
3. Google 支援 `generationConfig.responseMimeType="application/json"` + `responseJsonSchema`，但官方說明大型、巢狀或帶過多陣列上下限的 Schema 可能被服務端的 constrained decoder 拒絕，回傳 400。2026-10 Google 官方開發者論壇已承認有 `maxItems` 造成 400 的重現案例。
4. 既有 Schema 已移除 `audio: { enum:[""] }`；本次另外移除**所有傳給 Google 的巢狀 `minItems/maxItems` 及 `minimum/maximum`**，並保留必要物件屬性、型別與非空 enum，降低服務端 Schema 複雜度。
5. **不變更原版 `ListeningGenerationInputSchema`、`ListeningSetSchema`、題型數量、音訊路徑、正解唯一性或發布條件**。原版 Zod、重複檢查與獨立答案審核仍保留；即使 Gemini 生成不符合規格，也不進入 D1、R2 或 TTS。
6. 對 `maxItems`、`branching`、`too many states` 等 Google 回報增補脫敏錯誤分類，不打印未公開題目、API Key 或完整 provider error。

參考：
- Google Gemini API [Structured outputs](https://ai.google.dev/gemini-api/docs/structured-output)
- Google Gemini API [generateContent API](https://ai.google.dev/api/generate-content)
- Google [開發者論壇 2026-10：maxItems HTTP 400 案例](https://discuss.ai.google.dev/t/gemini-3-8-flash-interactions-v1beta-http-400-invalid-request-with-stateless-structured-output/184654)

## 0 次 API 的本機測試

在 Node 24 的儲存庫根目錄執行：

```powershell
node --import tsx scripts/generate-listening-draft.mjs --pilot --structured --inspect-schema
node --import tsx --test cloudflare/test/listening-text-pilot.test.mjs
```

`--inspect-schema` 只顯示 Schema 的陣列數、上限 constraint 數、是否存在空值 enum 和 JSON bytes；即使誤帶 `--execute`，仍在任何 Gemini、Worker 或 D1 網路操作之前直接結束。測試另確認原版 Zod 會拒絕少一題的 Router，不會因為 Gemini Schema 放寬而接受壞題。

## 下一個受控真人 Pilot（尚未執行）

只有在確認 Google AI Studio **當前** Free Tier、正確專案 API Key、Gemini 3.1 Flash-Lite **文字模型的** RPD/RPM/TPM 仍有空額，且願意主動消耗**最多 1 次文字請求**時才進行：

```powershell
# 先將 GEMINI_API_KEY 放在本機當次 PowerShell 工作階段（不要貼在對話或 Git）
$env:LISTENING_DRAFT_GENERATION_ENABLED="true"
node --import tsx scripts/generate-listening-draft.mjs --pilot --structured --execute
Remove-Item Env:LISTENING_DRAFT_GENERATION_ENABLED -ErrorAction SilentlyContinue
Remove-Item Env:GEMINI_API_KEY -ErrorAction SilentlyContinue
```

這個 Pilot 只驗證 Router 模組（17 段刺激題文字），**不會生成 TTS、寫入 D1 或公開發布**。如再度失敗，請讀取忽略 Git 的 `tmp/listening-draft-pilots/gemini-http-error-*.json` 的脫敏資訊；若回傳 JSON 但 Zod 不通過，使用 `--inspect=...` 完全離線檢查既有內容，**不要自動重試**。

**重要：本修正只是降低一個合理的 HTTP 400 風險；直到真人受控 Pilot 成功為止，不能宣稱已完全排除 HTTP 400，也不能開始 36 段配音。**

## 部署限制

- 修正僅涉及本機/Actions 的草稿產生程式、相容性 Schema 與離線測試，**不需要 Cloudflare D1 migration**。
- 文字草稿的驗收與雙模型 TTS 配額是兩件獨立工作。先讓草稿成功且經人工作答內容審閱，再驗證 TTS 品質。
- `cloudflare-migration` 不是預設 `main`，不能因為本次修正而直接啟動每日 TTS workflow。
