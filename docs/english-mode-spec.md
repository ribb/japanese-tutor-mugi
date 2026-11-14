# 雙語家教改版規格書：保留中日教學並新增中英教學（含免費 Edge TTS）

> **適用專案**：[brian901106/japanese-tutor-mugi](https://github.com/brian901106/japanese-tutor-mugi)（React + Vite + TypeScript + Node.js 本地開發伺服器）  
> **目標**：完整保留現有的「中日語言教學」功能與資料相容性，新增「中英語言教學」模式，並整合免費且免金鑰的 [`msedge-tts`](https://www.npmjs.com/package/msedge-tts) 作為優先語音合成引擎。

---

## 一、改版核心原則

1. **向後相容**：現有 `localStorage` 內的聊天紀錄、小提醒本、速查紀錄與預設角色（むぎ、結衣、悠真）不應被破壞；舊資料未指定語言時一律預設為日語（`ja`）。
2. **維持快取優勢**：不破壞原本的 Anthropic 5 分鐘 Prompt 快取結構（靜態系統提示詞 + 穩定歷史紀錄 + 僅附於最新訊息的動態提醒），以及 `.tts-cache/` SHA-256 磁碟快取。
3. **免費 TTS 優先**：伺服器端整合 `msedge-tts` 作為免金鑰、高品質的免費優先選項，並保留瀏覽器內建語音（Web Speech API）作為離線或斷線時的最後備援。

---

## 二、資料模型與狀態擴充

### 1. 新增語言型別
在共用的型別定義中新增目標語言型別：
```ts
export type TargetLanguage = 'ja' | 'en';
```

### 2. 角色（人物）設定擴充
- 在角色資料結構中加入 `targetLanguage: TargetLanguage`（舊資料讀取時若缺少此欄位，自動補為 `'ja'`）。
- 在「人物」設定頁面新增「教學語言（日語 / 英語）」選擇器。
- **新增預設英語角色**：保留原有的 1～3 號日語角色（むぎ、結衣、悠真），新增一位預設英語家教角色（例如使用美式日常會話人設、`targetLanguage: 'en'`），讓使用者開箱即可切換體驗。

---

## 三、LLM 協定、提示詞與結構化輸出

### 1. 系統提示詞分流（`src/game/claudeProtocol.ts` 及對應 OpenAI 模組）
依 `targetLanguage` 載入對應的靜態系統提示詞（確保同語言對話期間位元組完全一致以命中 Prompt 快取）：
- **`ja` 模式**：完全沿用現有日語教學提示詞與漢字讀音規則。
- **`en` 模式**：
  - 指示模型以自然的美式（或依角色設定的英式）英文回覆，每段英文附上繁體中文意思。
  - 若需要發音輔助，可在 `segments` 中選擇性輸出 IPA 音標（而非日文振假名）。
  - 小提醒（`tip`）以繁體中文說明文法或道地用法，英文例句／片語保留於 `<en>...</en>` 標籤內。

### 2. 小提醒背景改寫
- 將背景改寫（Haiku）邏輯從寫死的日文判斷與 `<ja>` 標籤，改為依角色 `targetLanguage` 判斷：
  - `ja`：維持保留 `<ja>`，其餘改寫為繁體中文。
  - `en`：若小提醒誤以全英文輸出，改寫為繁體中文說明，僅將英文片語保留於 `<en>` 標籤內。

### 3. 「速查」功能分流
- **UI 切換**：依角色語言顯示「中日切換」或「中英切換」。
- **Prompt 與 JSON Schema 調整**：
  - `ja` 模式：維持讀音（假名）、中文意思、JLPT 級數、例句。
  - `en` 模式：回傳 **IPA／KK 音標**、詞性、中文意思、**CEFR 等級（A1–C2）** 與例句。

---

## 四、伺服器端後處理分流

### `kuromoji` 漢字讀音補標
- 僅在 `targetLanguage === 'ja'` 時呼叫 `kuromoji` 進行漢字振假名補標。
- 當 `targetLanguage === 'en'` 時，**完全跳過 `kuromoji` 管線**，直接將模型的結構化分段回傳給前端，降低延遲與伺服器負擔。

---

## 五、免費 TTS 整合（優先使用 `msedge-tts`）

### 1. 安裝與伺服器端實作
- 安裝套件：`npm install msedge-tts`
- 在伺服器端 TTS 模組新增 `edge`（Edge TTS）Provider，負責呼叫 Microsoft Edge Read Aloud 介面合成音訊（免 Azure 帳號、免 API 金鑰）。
- **快取整合**：將 `provider: 'edge'`、文字內容、語音名稱（`voice`）與語速納入現有的 SHA-256 快取鍵計算，複用 `.tts-cache/` 200 MB 磁碟快取與記憶體快取。
- **安全性**：所有對外語音請求僅由本機開發伺服器端執行，不暴露給前端或繞過現有的 `Origin` / `Host` / 配對碼安全檢查。

### 2. 推薦預設聲線與降級順序
- **英語（`en`）預設優先順序**：
  1. `msedge-tts`（推薦聲線：`en-US-JennyNeural`、`en-US-AriaNeural`、`en-US-GuyNeural`、`en-GB-SoniaNeural`）
  2. 已設定的雲端 TTS（[Google Cloud TTS](https://cloud.google.com/text-to-speech/pricing)／[Azure AI Speech](https://azure.microsoft.com/en-us/pricing/details/speech/) 免費額度，若 `.env.local` 有填入金鑰）
  3. 瀏覽器內建語音（Web Speech API，`en-US`）作為最終備援
- **日語（`ja`）可選引擎**：
  - 保留 VOICEVOX、雲端與瀏覽器語音，並可同步支援 `msedge-tts` 日語聲線（如 `ja-JP-NanamiNeural`、`ja-JP-KeitaNeural`）。

### 3. 「設定 > 聲音」介面調整
- 在外語語音引擎選項加入 **`Edge TTS（免費，免金鑰）`**，並設為英語模式的預設選項。
- 依角色語言動態顯示對應聲線清單；**VOICEVOX 選項僅在日語角色時顯示**。
- 保留嘴型同步（音節／音訊振幅驅動）與語速調整功能。

---

## 六、語音辨識（STT）、題庫與前端介面

1. **語音辨識（STT）**：依目前角色的 `targetLanguage` 動態設定 `SpeechRecognition.lang`（英語模式支援 `en-US`／`en-GB` 與 `zh-TW` 切換）。
2. **開話題題庫**：保留原本 100 句日語題庫，另外新增 **100 句英語開話題題庫**（涵蓋日常寒暄、旅遊點餐、職場會議、興趣文化等），不呼叫 LLM API 即可主動開話題。
3. **介面文案動態化**：檢查畫面中寫死的「日文」、「漢字讀音」、「JLPT」等字串，改為依角色語言動態切換為「英文」、「音標／發音」、「CEFR」。

---

## 七、給 Claude Code CLI 的執行指令建議

你可以直接將本規格書存放在專案根目錄（例如 `docs/english-mode-spec.md`），然後在終端機啟動 Claude Code 並貼上以下指令：

```text
請先閱讀 docs/english-mode-spec.md 規格書，並盤點目前專案的 package.json、src/ 與 server/ 檔案結構。
確認現有架構後，請依規格書分階段實作：
1. 擴充角色資料結構與雙語狀態（向後相容舊資料）。
2. 抽離並新增英語模式的系統提示詞、JSON Schema、速查（CEFR）與小提醒改寫（<en>）。
3. 讓伺服器端僅在日語模式執行 kuromoji，並整合 npm 套件 msedge-tts 作為免費優先 TTS（共用 .tts-cache/ 快取與瀏覽器語音備援）。
4. 擴充 100 句英語開話題題庫與更新前端設定／人物／速查介面文案。
完成後請執行 npm test 與 npm run build 確認無錯誤，再列出修改摘要供我檢查與 commit。
```

### 驗收檢查清單
- [ ] `npm test` 全部通過（含雙語與模擬 TTS 測試，不呼叫真實付費 API）
- [ ] `npm run build`（`tsc -b && vite build`）無型別或建置錯誤
- [ ] 日語角色對話、振假名與 VOICEVOX／原本語音功能無回歸問題
- [ ] 英語角色可正常對話、跳過 `kuromoji`、速查顯示 CEFR、且優先透過 `msedge-tts` 朗讀並寫入 `.tts-cache/`
