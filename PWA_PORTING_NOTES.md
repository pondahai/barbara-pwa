# PWA 移植筆記

這份筆記記錄 barbara-pwa 從 Chrome 擴充功能（[pondahai/barbara](https://github.com/pondahai/barbara)）移植功能時的決策與踩到的坑。行為定義類的文件（追問策略、Agent 安全設計）以擴充功能那邊的筆記為準，這裡只記「PWA 為什麼不一樣」以及「只有在這邊才會遇到的問題」。

## 一、哪些功能搬得動，哪些搬不動

判準只有一個：**那個功能需不需要當前分頁**。

| 擴充功能的能力 | PWA | 原因 |
|---|---|---|
| 聊天、思考過程顯示、Agent 迴圈 | ✅ 完整移植 | 純 API + DOM |
| 「所以呢？」對話式知識內化 | ✅ 完整移植 | 純 LLM + 儲存，連引用句驗證都不打折 |
| 剪貼簿摘要／翻譯 | ✅ 原本就有 | |
| `read_current_webpage` | ❌ | 需要 `chrome.tabs` + `chrome.scripting` |
| `execute_javascript_on_page` | ❌ | 同上 |
| `open_new_tab` / `switch_to_tab` / `switch_to_previous_tab` | ❌ | 需要 `chrome.tabs` |
| `see_current_screen` | ❌ | 需要 `chrome.tabs.captureVisibleTab` |
| `list_page_images` / `look_at_page_image` | ❌ | 需要注入腳本讀 DOM |
| `get_youtube_transcript` | ❌ | 需要注入腳本 |
| 右鍵選單入口 | ❌ | 需要 `chrome.contextMenus` |

PWA 端改用能做到的等價工具：`get_current_datetime`、`read_clipboard_text`、`fetch_url_text`。

`fetch_url_text` 是「看起來能取代 `read_current_webpage`，實際上不能」的一項：多數網站不允許瀏覽器跨來源讀取（CORS），抓取會直接失敗。工具的 description 與失敗訊息都明講這個限制，並要求模型改請使用者複製內容——**讓模型知道怎麼轉圜，比讓它反覆重試有用**。

### 入口的替代方案

擴充功能靠右鍵選單取得「使用者選取的那段文字」。PWA 沒有選取，改成：輸入框有字就用輸入框的字，沒字就讀剪貼簿。這也是既有的「剪貼簿摘要／翻譯」一直在用的模式。

更好的入口是 PWA 特有的 **Web Share Target**（在 manifest 註冊後，手機的「分享」選單會出現 Barbara），還沒實作。那個做法連來源網址都能一起帶進來，可以把卡片的 `webpage` 來源與 `evidence_hash` 補回去。

## 二、思考過程的三種來源

這是移植過程中最意外的發現：**同一件事有三種送法，而且擴充功能只處理了其中一種。**

| 來源 | 伺服器 |
|---|---|
| `content` 裡的 `<think>` / `<\|channel>thought` / `<thought>` 標籤 | LM Studio、未開推理解析的 llama.cpp |
| `delta.reasoning_content` | llama.cpp（b9596 實測） |
| `delta.reasoning` | vLLM（實測 Qwen3.8） |

只讀 `delta.content` 的話，後兩種伺服器上推理過程會整批被丟棄：畫面空白數十秒，然後正式回覆一次跳出來。`parseStreamChunk` 現在三種都收，獨立欄位的部分由 `buildTaggedText()` 轉寫成 `<think>...</think>` 再餵進既有的標籤狀態機——這樣串流渲染、摺疊、最終存檔三條路都不必分來源處理。

標籤解析也補齊了三種格式，並吃掉 Gemma 起始標籤後的換行，避免思考區塊開頭出現空行。

## 三、串流的兩個「切在中間」問題

推理模型讓這兩個問題從「理論上會發生」變成「每次都發生」。

### 1. SSE 行被切斷

`read()` 回傳的 chunk 邊界與 SSE 的行邊界無關，可能切在某一行 JSON 中間。原本逐 chunk `split('\n')` 解析，切斷的那行 `JSON.parse` 失敗被 `catch` 吞掉，**整則 delta 消失**。實測把同一段 SSE 以不同大小餵入：

```
chunkSize=1000 -> "開場。想一下答案。"
chunkSize=64   -> "開場。"          ← 掉兩則
chunkSize=17   -> ""                ← 全掉
```

解法是把不完整的尾行留在緩衝，下次接起來再解析。`createStreamParser()` 是工廠而不是共用變數，因為聊天與「所以呢？」會各自開串流，共用一份緩衝會互相污染。

### 2. 思考標籤被切斷

同理，一個 chunk 結尾是 `<thi`、下一個才送來 `nk>`，逐 chunk `indexOf` 會整個漏掉，標籤就變成裸文字顯示在回覆裡。`splitAtPossibleTag()` 把結尾「有可能是某個標籤的前綴」的字元留到下一個 chunk，最多留 `MAX_THINK_TAG_LENGTH - 1` 個字元，不會無限累積。串流結束時緩衝裡剩下的是不完整標籤，當普通文字輸出。

候選清單裡多收一個 `'<|channel>thought\n'`，這樣剛好切在 Gemma 起始標籤與其後換行之間時也會等下一個 chunk。

## 四、「所以呢？」為什麼改成串流

擴充功能原本刻意不串流，理由寫在註解裡：「回應只有三句話 + 選項，不需要串流」。那個判斷在不長篇思考的模型上成立。

但推理模型會為了問一句三句話以內的問題思考上千個 token。實測 vLLM / Qwen3.8：prompt 1939 tokens、completion 1681 tokens（其中 reasoning 3472 個字元），整輪 31 秒——非串流就是 31 秒的空白轉圈。

改成串流後：**第一次有字是 1.1 秒**，之後 261 次回呼逐步更新。思考量、提示詞、`SOWHAT_MAX_TURNS`、收尾判準、JSON 協定一律不動，JSON 仍然等串流結束才解析。這個改動也回饋給擴充功能了（分支 `claude/sowhat-streaming`）。

即時思考區塊在串流中用 `textContent` 而不是 `marked.parse()`：markdown 還沒寫完，每個 token 重新 parse 不只浪費，未閉合的語法還會讓畫面跳動。串流結束後把臨時區塊拆掉，改由既有的 `soWhatRenderThinking` 畫正式的（含 markdown），所以 `uiLog` 重畫路徑一行都不用改。拆除放在 `finally`，失敗時帶游標的區塊也不會留在畫面上。

## 五、部署：https 頁面不能連 http API

**這不是靜態網頁的問題，看的是頁面的協議。** GitHub Pages 一律用 https 送出頁面，頁面裡的 JS 去 `fetch('http://100.x.x.x:8002/...')` 會被瀏覽器的 mixed content 規則直接封鎖。

而「把 PWA 也放在 http 上」不是退路：http 來源不是安全上下文，service worker 不會註冊，瀏覽器也不會給安裝選項，`navigator.clipboard.readText()` 同樣不可用。

所以實際可行的只有三種形狀：

| 方案 | PWA 放哪 | API | 可用範圍 |
|---|---|---|---|
| 同源（最乾淨） | https 主機的 `/` | 同一台的 `/v1` | 同源，連 CORS 都不用管 |
| Pages + https API | GitHub Pages | 反向代理給 https（Tailscale Serve、Cloudflare Tunnel） | 需能連到 API 主機 |
| Pages 純展示 | GitHub Pages | 無 | 只能看介面，不能對話 |

本機開發用 `http://localhost` 沒有這個問題——localhost 被視為安全上下文，而且 http → http 不算降級。

## 六、Service Worker 快取版本要手動升

`sw.js` 的 `CACHE_NAME` 是寫死的字串。**改了任何前端檔案就要升版號**，否則已安裝的 PWA 會一直吃舊的快取，看不到新程式碼。目前是手動維護（v1 → v2 → v3），這是個遲早要自動化的地方（build 時帶時間戳或 git hash）。

新增檔案也要加進 `urlsToCache`，不然離線時抓不到。`so-what-prompt.md` 是執行時 `fetch` 進來的，所以它也必須在快取清單裡。

## 七、app.js 與 sowhat.js 之間的橋接

`app.js` 的內部函式全部包在 `DOMContentLoaded` 的閉包裡，`sowhat.js` 是獨立的 `<script>`，看不到那些函式。與其把 1000 行搬進同一個閉包，改成由 `app.js` 明確掛出 `window.BarbaraApp`，只暴露 `sowhat.js` 真正需要的幾個接口（設定、儲存、重畫、loading、escapeHtml、JSON 抽取器、語言名稱、串流解析器工廠）。

這是折衷，不是終點。`app.js` 已經超過 1400 行，之後要繼續從擴充功能搬功能，應該把「串流解析 / 工具迴圈 / 渲染 / 儲存」拆成 ES modules，否則每次搬程式碼都得手動對 diff。

## 八、測試方式

沒有測試框架，但有兩個可重複的做法：

1. **假的 OpenAI 相容伺服器**。用 Python 起一個 SSE 伺服器，故意把回覆切成 1–4 字元或逐字元的 chunk，保證切在標籤與 JSON 行中間；並依模型名稱模擬不同行為（原生 `tool_calls`、只在文字裡寫 JSON、只輸出思考、永遠要求工具以測遞迴上限、「所以呢？」的多輪 JSON 協定）。這是唯一能穩定重現「切在中間」與「無限迴圈」的方法。
2. **把純函式抽出來用 node 跑**。標籤解析、引用句驗證、SSE 解析這些不碰 DOM 的部分，可以直接用 `vm` 載入檔案、餵假資料、比對輸出，不需要瀏覽器。

UI 行為（即時區塊、游標、摺疊、捲動跟隨）則是在瀏覽器裡用定時取樣檢查狀態變化。

真 API 該測什麼：**不同伺服器的 delta 欄位長什麼樣**。這是最容易踩到而且最難從程式碼看出來的事。
