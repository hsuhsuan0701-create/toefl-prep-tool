# Gemini 3.8 雙模型 TTS：一次一段的免費額度試音

**此文件只準備人工試聽；PR 和 CI 不會呼叫 Gemini、D1 或 R2，也不會更動原本 14 套 Listening Set / 504 個 MP3。**

## 2026-11-15 AI Studio 截圖配額

同一個 Free Tier 專案的畫面顯示：
- `gemini-3.8-flash-lite-tts`：RPM 3、TPM 10,000、RPD `0/10`
- `gemini-3.8-flash-tts`：RPM 3、TPM 10,000、RPD `0/10`

**這是截圖的歷史瞬間值，不是永久可用的 10 次。** 每次真人試音前都應在 https://aistudio.google.com/rate-limit 核對相同專案、Free Tier / Billing、當天模型的實際剩餘額度。任何不明確時不要試音，不使用付費備援。若另一個程式/金鑰共用專案，會一同消耗配額。

## 先做完全不消耗額度的試跑

在 Node 24 的專案根目錄：

```powershell
node --import tsx scripts/pilot-gemini38-tts.mjs --set lsn-03948a55 --role announcement --model gemini-3.8-flash-lite-tts
node --import tsx scripts/pilot-gemini38-tts.mjs --set lsn-03948a55 --role conversation --model gemini-3.8-flash-tts
node --import tsx --test cloudflare/test/listening-dual-tts-pilot.test.mjs
```

先核對模型與角色：
- Flash-Lite：**Announcement（單一講者、短音訊）**
- Flash：**Conversation（雙人交替、多講者）**

先前 Lite 對話曾有疊字，因此**不要拿 Lite 生成 Conversation / Academic Talk 作為正式素材**。本階段都只選原本題庫的**既有逐字稿**，沒有新草稿，試音不會寫入題庫或公開。

## 真正的兩次 API 試音（由使用者在本機明確執行，尚未做）

檢查當前 Free Tier／RPD／TPM 並主動同意各消耗**至多一次**模型請求後，從本機 PowerShell 安全輸入 API Key（不要貼到 ChatGPT / Git / 日誌）：

```powershell
$secure = Read-Host "Gemini API Key（不顯示）" -AsSecureString
$bstr = [System.Runtime.InteropServices.Marshal]::SecureStringToBSTR($secure)
try {
  $env:GEMINI_API_KEY = [System.Runtime.InteropServices.Marshal]::PtrToStringBSTR($bstr)
} finally {
  [System.Runtime.InteropServices.Marshal]::ZeroFreeBSTR($bstr)
}
try {
  # 同一個模型／同一段有既有 WAV 就不要再生成
  node --import tsx scripts/pilot-gemini38-tts.mjs --set lsn-03948a55 --role announcement --model gemini-3.8-flash-lite-tts --execute
  # 先確認第一段輸出與當天剩餘 Flash RPD，再手動執行下一行
  node --import tsx scripts/pilot-gemini38-tts.mjs --set lsn-03948a55 --role conversation --model gemini-3.8-flash-tts --execute
} finally {
  Remove-Item Env:GEMINI_API_KEY -ErrorAction SilentlyContinue
}
```

其中 `--execute` 會真的傳出 Gemini API 請求。遇到 400 / 429 / 503 **立即停止，不重試、不自動切換模型**，不為填滿 10 RPD 而生成。

## 人工驗收重點

讀取本機 `tmp/tts-trials/lsn-03948a55/` 新產生的 `.wav` / `.mp3`，逐段比對原始逐字稿及既有音檔。記錄發音清晰度、朗讀語速、停頓、是否有跳詞/疊字；Flash Conversation 需另外檢查兩個講者聲線持續分離、角色是否在每個 Turn 都正確。WAV 自動檢查只能抓格式、異常靜音與粗略時長，**不能證明沒有錯字或聲線混淆**。

若先有 WAV 而 MP3 轉檔失敗，使用 `node scripts/check-listening-wav.mjs <WAV-path> --mp3` 在本機重轉，**不要再呼叫 Gemini**。所有試音檔留在 git 忽略的 `tmp/`，不會進 R2 或正式 D1。

下一步只有在文字草稿可用（HTTP 400 排除且答案正確）、遠端 D1/R2 安全切換、兩段試音人工通過後，才考慮手動開啟每日 1+1 的小流量 TTS。完整 36 段仍要逐段人工驗收後才發布。
