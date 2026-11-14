# Gemini 3.8 Flash-Lite TTS 單段品質試聽（不影響正式題庫）

本方案**不是第二套 Listening 題庫生成器**。它直接匯入原 `server/src/services/listeningAudioRenderer.ts` 的 `buildRenderPlan` 和 `deliveryNotes`，並使用原 `audioPrompt.ts` 的口音、語速提示。只在與 Gemini 3.8 新版 API 不相容的請求組裝格式上新增一個試聽轉接。

## 目的／安全限制

- 先比較一段約 40–45 秒的 **Conversation**（原版 `lsn-03948a55`），確認 Gemini 3.8 Flash-Lite TTS 自然度、雙人聲線、語速和逐字稿一致性；後續再決定是否製作整套 36 段音訊。
- 預設 **dry-run**，不呼叫 Gemini、不收費。
- 只有帶 `--execute` 才會呼叫 **一次** Gemini TTS。遇到 429、503 直接回報，沒有自動重試，以免測試費用失控。
- 不改原版 14 套 MP3，也不寫入正式 D1／Cloudflare R2。新檔存在 git 忽略的 `tmp/tts-trials/`。
- 新模型的 REST 格式改成 `speechMetadata` 和 `voiceConfig.voice`；雙人對話以每個 turn 一個 Part 搭配 `speechMetadata.speaker`，不是舊模型內嵌的 `Speaker: ...` 字串。
- 本階段先保存 WAV（Gemini 3.8 unary 原生輸出）；正式系統**仍只接受 MP3**。使用本機 ffmpeg 轉 MP3 以便比較，轉檔不會額外呼叫 Gemini。
- 品質檢查限定**零額外 AI API**：WAV 格式、長度、異常靜音、概略語速。**不進行雲端語音轉錄／AI 聽感審核／自動付費重新生成**。此類檢查不能可靠找出疊字或漏字，遇到異常請人工試聽；未獲確認不要發布。

## Windows PowerShell

本機先更新（`git status --short` 應為空）：

```powershell
cd C:\Users\isaac\toefl-prep-tool
git status --short
git pull --ff-only origin cloudflare-migration
node --import tsx scripts/pilot-gemini38-tts.mjs --set lsn-03948a55 --role conversation
```

如 dry-run 成功，需要**另外**在本機配置 Gemini 金鑰（Cloudflare Worker Secret 不能反向讀取），不要把金鑰貼給 ChatGPT，也不要加入 Git：

```powershell
$secure = Read-Host "輸入 Gemini API Key（輸入不顯示）" -AsSecureString
$bstr = [System.Runtime.InteropServices.Marshal]::SecureStringToBSTR($secure)
try {
  $env:GEMINI_API_KEY = [System.Runtime.InteropServices.Marshal]::PtrToStringBSTR($bstr)
} finally {
  [System.Runtime.InteropServices.Marshal]::ZeroFreeBSTR($bstr)
}
try {
  node --import tsx scripts/pilot-gemini38-tts.mjs --set lsn-03948a55 --role conversation --execute
} finally {
  Remove-Item Env:GEMINI_API_KEY -ErrorAction SilentlyContinue
}
```

輸出在 `tmp/tts-trials/lsn-03948a55/`；用 Windows 播放器聽新 MP3，與既有 `data/audio/stimuli/lsn-03948a55/conv-r1.mp3` 比較。

如果 `ffmpeg`／`ffprobe` 尚未安裝，WAV 仍可能成功保存（可直接試聽），但 MP3 轉檔不會完成。**已有 WAV 請不要再用 `--execute` 重做**；請用下列不需要 API Key、完全不呼叫 Gemini 的指令：

```powershell
node scripts/check-listening-wav.mjs .\tmp\tts-trials\lsn-03948a55\conv-r1-gemini-3.8-flash-lite-tts.wav
# 安裝好 ffmpeg 後，直接轉檔（不重新生成）：
node scripts/check-listening-wav.mjs .\tmp\tts-trials\lsn-03948a55\conv-r1-gemini-3.8-flash-lite-tts.wav --mp3
```

曾觀察到這段範例最後約六秒疊字。**WAV 檢查不會宣稱已找出或修正此問題**，已知瑕疵的試聽檔不得直接成為正式 Listening 題目。若本機金鑰沒開通 TTS 模型或免費額度，會顯示 HTTP 狀態，**不要重複嘗試直到確認原因**。

## 驗收後才能進下一步

待實際音質通過後，才設 Cloudflare R2 bucket/binding、分批渲染、錄音後一致性與時長驗證、R2 音檔完整性檢查、D1 題庫發布開關。**目前未建立 R2 bucket、未產生付費音訊，也未啟用 Listening 每日自動補題。**

Google 官方：
- https://ai.google.dev/gemini-api/docs/speech-generation
- https://ai.google.dev/gemini-api/docs/pricing
