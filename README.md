# Barbara AI Assistant (PWA 版本)

Barbara AI Assistant (PWA) 是一款漸進式網頁應用程式 (Progressive Web App)，旨在提供一個獨立、可安裝的介面，讓使用者可以方便地與自訂的大型語言模型 (LLM) API 進行互動。它核心功能包括 AI 聊天、對話管理以及 API 設定管理。

此 PWA 版本脫離了 Chrome 擴充功能的限制，可以在支援 PWA 的現代瀏覽器中獨立運行，並可「安裝」到桌面或行動裝置主畫面，提供更接近原生應用的體驗。

## 網址

*   **線上版（GitHub Pages）：** https://pondahai.github.io/barbara-pwa/
*   **原始碼：** https://github.com/pondahai/barbara-pwa
*   **上游的 Chrome 擴充功能：** https://github.com/pondahai/barbara
*   **擴充功能的 Chrome 線上應用程式商店：** https://chromewebstore.google.com/detail/barbara-local-ai-assistan/ccpdgcdldfgcdnfgigmnlimbnojamghi

> 線上版可以直接安裝使用，但 **AI 功能需要一個 https 的 LLM API**。
> 原因與解法見下方「部署 PWA」。


## 與 Chrome 擴充功能版的關係

功能以擴充功能版 [pondahai/barbara](https://github.com/pondahai/barbara) 為上游。判斷一項功能能不能搬過來的準則很簡單：**它需不需要當前分頁**。

*   純 LLM + 儲存的功能（聊天、思考過程顯示、Agent 迴圈、「所以呢？」）完整移植。
*   需要 `chrome.tabs` / `chrome.scripting` / `chrome.contextMenus` 的能力（讀當前網頁、注入 JS、切分頁、截圖、右鍵選單）PWA 做不到，改用等價的入口與工具。

完整的對照表與移植決策見 [`PWA_PORTING_NOTES.md`](PWA_PORTING_NOTES.md)。

## 主要功能

*   **AI 聊天介面:**
    *   與使用者設定的 LLM 模型進行即時對話。
    *   支援 Markdown 格式渲染 AI 的回覆。
    *   **處理 AI 思考過程:** 如果 LLM 回應中包含由 `<think>...</think>` 標籤包裹的思考過程，這些內容會被提取並顯示為一個獨立的、可折疊的對話項，預設收起。
    *   串流回覆：AI 的回覆會以串流方式即時顯示。
    *   程式碼塊一鍵複製。
*   **對話管理:**
    *   複製單則對話內容（包括普通回應和思考過程）。
    *   刪除單則對話（包括普通回應和思考過程）。
    *   一鍵刪除當前選定設定檔下的所有對話記錄。
*   **API 設定管理:**
    *   支援儲存和管理多組 LLM API 的連線設定。
    *   每組設定包含 API 網址 (API URL) 和 API 金鑰 (API Key)。
    *   設定 API 後，可從該 API 獲取可用的模型列表並進行選擇。
*   **PWA 特性:**
    *   **分享目標 (Web Share Target)：** 安裝後，Barbara 會出現在系統的分享選單裡。從別的 app 分享一段文字過來，內容會直接填進輸入框，並可一鍵接「所以呢？」——分享時附帶的網址與標題會記進卡片的來源（`webpage` 來源與 `evidence_hash`）。**iOS Safari 不支援這個 API**，iPhone 上請用「複製 → 開啟 Barbara → 按所以呢？」。
    *   **可安裝：** 可以被「新增到主畫面」(行動裝置) 或「安裝」(桌面瀏覽器)，像獨立應用程式一樣啟動。
    *   **離線 UI 存取：** 應用程式介面 (HTML, CSS, JS, 圖示) 被快取，即使在離線狀態下，使用者仍可開啟應用並查看已有的設定和對話記錄 (核心 AI 功能仍需網路)。
    *   **響應式設計：** 盡力適應不同螢幕尺寸 (雖然主要優化目標可能是桌面/平板)。
*   **剪貼簿輔助功能:**
    *   **剪貼簿摘要:** 快速將剪貼簿中的文字內容填入輸入框並生成摘要提示詞。
    *   **剪貼簿翻譯:** 快速將剪貼簿中的文字內容填入輸入框並生成翻譯提示詞 (會根據內容語言自動判斷目標語言，或翻譯成英文)。

*   **智慧代理 (AI Agent):**
    *   內建工具註冊表 (ToolRegistry)，AI 能自行判斷需求並呼叫工具，結果會回饋進下一輪推理，直到任務完成。
    *   **目前實作技能:**
        *   🕒 `get_current_datetime`: 讀取裝置的本地日期與時間。
        *   📋 `read_clipboard_text`: 讀取剪貼簿中的純文字。
        *   🌐 `fetch_url_text`: 抓取指定網址的純文字內容（會受瀏覽器跨來源限制 CORS 影響，失敗時會回報並建議改用剪貼簿）。
    *   **人類回圈確認 (Human-in-the-loop):** 所有工具執行都必須由使用者按下「允許執行」才會進行；也可選「本次對話都允許」讓同類動作自動放行，連續自動執行 5 輪後會強制回來確認一次。
    *   **安全上限:** 連續工具輪數上限 8 輪，避免代理暴衝或無限迴圈。
    *   **相容本地模型:** 除了原生 `tool_calls`，若模型只把呼叫意圖寫在文字裡，會先請同一顆模型做一次「反芻抽取」轉成結構化 JSON，再降級到文字樣式解析。
    *   **稽核軌跡:** 每一次授權決策與工具執行結果都會存進對話紀錄，可事後展開檢視。
*   **推理過程顯示:**
    *   支援 `<think>`、Gemma 4 的 `<|channel>thought` 與 `<thought>` 三種思考標籤。
    *   也支援把思考放在獨立欄位的伺服器：llama.cpp 的 `reasoning_content` 與 vLLM 的 `reasoning`。
    *   思考內容顯示為可折疊區塊，偵測到結束時自動收起。

*   **「所以呢？」對話式知識內化:**
    *   把一段文字貼進輸入框（或複製到剪貼簿）後按「所以呢？」，AI 會用 2–4 輪簡短對話，幫你逼出「這段東西對我意味著什麼、我要留下什麼」，而不是摘要它。
    *   **能點選就不要打字:** 每一輪給 2–4 個選項，也可以自由打字；每一輪都有「夠了，直接收尾」的出口。
    *   **引用句字面驗證:** 收尾卡片的引用句由程式對原文做字元比對，抄寫失真會自動修正並標示，原文中找不到的引用直接丟掉，不留假引用。
    *   **卡片資料表:** 收尾後存成結構化卡片（結論、引用、開放問題、標籤、認知是否改變），可勾選後「插入對話歷史」讓模型看到，或刪除。
    *   **中斷可續:** 每一輪都寫進 localStorage，關掉頁面再打開會接回未完成的對話（24 小時後過期自動丟棄）。
    *   **思考即時顯示:** 推理模型每輪會思考上千個 token，所以這裡用串流，思考過程邊想邊顯示，結束後自動摺起並解析 JSON。
    *   行為定義全在 `so-what-prompt.md`，改追問策略只要改那個檔案，不用動程式。

## 技術棧

*   **前端：** HTML, CSS, Vanilla JavaScript（無建構步驟）
*   **Markdown 渲染：** `marked.js`
*   **PWA 核心：**
    *   Web App Manifest (`manifest.webmanifest`)
    *   Service Worker (`sw.js`) - 用於快取應用程式外殼和靜態資源。
*   **本地儲存：** 使用瀏覽器的 `localStorage`。主要鍵值：
    *   `pwa_configs` / `pwa_selectedConfigIndex` —— API 設定
    *   `pwa_conv_<apiUrl>_<modelId>` —— 對話歷史（每組設定各自一份）
    *   `pwa_soWhatSession` / `pwa_soWhatCards` —— 「所以呢？」的未完成對話與卡片

### 檔案結構

| 檔案 | 職責 |
|---|---|
| `js/app.js` | 主邏輯：設定、對話儲存與渲染、SSE 串流解析、思考標籤狀態機、Agent 迴圈與工具註冊表 |
| `js/sowhat.js` | 「所以呢？」的多輪 JSON 協定、引用句驗證、卡片資料表 |
| `so-what-prompt.md` | 「所以呢？」的行為定義（執行時 fetch 進來）。改追問策略改這裡，不用動程式 |
| `js/settings_pwa.js` | 設定頁邏輯 |
| `sw.js` | Service Worker。改了前端檔案要升 `CACHE_NAME` |
| `PWA_PORTING_NOTES.md` | 移植決策與踩到的坑（哪些功能搬不動、串流的坑、部署限制） |

`js/sowhat.js` 是獨立的 script，透過 `app.js` 掛出的 `window.BarbaraApp` 取用主邏輯的函式。理由見 `PWA_PORTING_NOTES.md`。

## 如何部署與使用

### 部署 PWA

1.  **準備環境：** 確保您的開發環境已安裝 Node.js 和 npm (用於本地測試伺服器，可選)。
2.  **獲取程式碼：** 下載或克隆本 PWA 專案的原始碼。
3.  **檢查資源路徑：**
    *   確保 `manifest.webmanifest` 中的 `start_url`, `icons[].src` 路徑正確。
    *   確保 `sw.js` 中的 `urlsToCache` 數組包含所有需要快取的資源 (HTML, CSS, JS, 圖片)，且路徑正確。
    *   確保 `index.html` 和 `settings.html` 中對 CSS, JS, Manifest 的連結路徑正確。
    *   **特別注意：** 如果部署到子目錄 (例如 GitHub Pages 的 `https://<username>.github.io/<repository>/`)，所有這些路徑都需要是相對於該子目錄的，或者使用正確的絕對路徑。
4.  **圖示：** `images/` 已包含 128 / 144 / 192 / 512 與一張 512 的 maskable 版（Android 會把圖示裁成圓形或圓角方形，內容落在中央 72% 內才不會被切到）。192 與 512 是由 144 放大而成，若日後找到原始素材，重新輸出取代會更銳利。
5.  **選擇部署平台（必須支援 HTTPS）：**
    *   **GitHub Pages：** 免費、與 Git 集成。這個專案的線上版就是這樣部署的（Settings → Pages → Source 選 `main` 分支、路徑 `/`）。manifest 與 HTML 全用相對路徑，放在子目錄不會壞。
    *   **Netlify / Vercel / Cloudflare Pages：** 免費方案，自動 HTTPS。
    *   **自有伺服器：** 確保已配置 HTTPS。

6.  **讓 LLM API 也是 https（這一步不能跳）：**

    靜態檔案放哪裡都行，真正的門檻在這裡：**https 頁面不能呼叫 http 的 API**（瀏覽器的 mixed content 規則）。API 若是 `http://內網IP:埠`，從 GitHub Pages 開啟的 PWA 會裝得起來、但一送出訊息就失敗。

    而「把 PWA 也放在 http 上」不是退路：http 不是安全上下文，Service Worker 不會註冊、瀏覽器不給安裝選項、`navigator.clipboard` 也讀不到。

    常見的幾種做法：

    | 方法 | 做法 | 代價 |
    |---|---|---|
    | **Tailscale Serve** | 在 tailnet 的任一節點跑 `tailscale serve --bg http://<API位址>:<埠>`，得到 `https://<node>.<tailnet>.ts.net/` | 真憑證、不公開。裝置需加入 tailnet。代理目標不限本機，所以可以用別的節點避開已被佔用的設定 |
    | **Cloudflare Tunnel** | `cloudflared tunnel --url http://localhost:<埠>` | 手機不用加入內網，但 API 會公開（建議再加 Cloudflare Access） |
    | **ngrok** | `ngrok http <埠>` | 最快。免費方案網址每次會變 |
    | **自己的反向代理** | Caddy / nginx 加 ACME 憑證，代理 `/v1` 到 API | 完全自主，但要有域名 |

    **最乾淨的形狀**是把 PWA 與 API 放在同一個 https 來源（PWA 在 `/`、API 反向代理在 `/v1`）——同源就連 CORS 都不用管。

    設定完成後，在 PWA 的設定頁把 API 網址填成那個 https 位址加 `/v1`，例如 `https://<node>.<tailnet>.ts.net/v1`。

    > **只在桌機用的話可以跳過這一步：** `http://localhost` 本身就是安全上下文。在桌機把這份程式用本機伺服器跑起來（例如 `python -m http.server 8932`），Service Worker 正常、可以安裝，而且頁面是 http、呼叫 http API 不算降級，不會被擋。手機沒有這個後門（iOS Safari 的加入主畫面與 Service Worker 都要求 https）。

7.  **部署檔案：** 把專案所有檔案上傳到選定的平台（GitHub Pages 就是 push 到分支）。


### 本地測試

1.  在專案根目錄下，使用一個本地 HTTP 伺服器。例如，使用 `http-server`：
    ```bash
    npm install -g http-server # 如果尚未安裝
    cd path/to/barbara-pwa
    http-server -c-1
    ```
2.  在瀏覽器中打開伺服器提供的本地網址 (例如 `http://localhost:8080`)。
3.  使用瀏覽器開發者工具 (F12) 的 "Application" 標籤頁檢查：
    *   Manifest 是否正確載入且無錯誤。
    *   Service Worker 是否已註冊、激活並正在運行。
    *   Cache Storage 是否已快取指定的資源。
    *   嘗試模擬離線並重新整理頁面，看 UI 是否仍能顯示。

### 安裝 PWA

1.  使用現代瀏覽器 (如 Chrome, Edge, Safari) 透過 **HTTPS** 訪問已部署的 PWA URL。
2.  與 PWA 頁面進行一些互動 (例如點擊)。
3.  **桌面瀏覽器：** 通常會在網址列右側出現一個「安裝」圖示。點擊該圖示並確認安裝。
4.  **行動裝置瀏覽器：**
    *   **Android (Chrome)：** 可能會自動彈出「新增到主畫面」的提示，或在瀏覽器選單中找到「安裝應用程式」/「新增到主畫面」選項。
    *   **iOS (Safari)：** 點擊分享按鈕，然後選擇「加入主畫面」。
5.  安裝完成後，PWA 會像一個獨立應用程式一樣出現在您的桌面或主畫面上。

## 使用 PWA

1.  **首次設定：**
    *   打開已安裝的 Barbara PWA 或直接訪問其 URL。
    *   導航到「設定」頁面。
    *   輸入您的 LLM API 的「API 網址」和「API 金鑰」。
    *   點擊「取得模型列表」以載入可用模型。
    *   從下拉選單中「選擇模型」。
    *   點擊「儲存此設定」。您可以儲存多組設定。
2.  **聊天：**
    *   返回「聊天」主頁面。
    *   從「選擇設定」下拉選單中選擇一個已儲存的 API 設定。
    *   在底部的輸入框中輸入您想與 AI 對話的內容。
    *   點擊「送出」或按下 `Ctrl + Enter`。
    *   AI 的回覆（包括可能的思考過程）將顯示在對話列表中。
3.  **其他操作：**
    *   使用對話項目旁邊的按鈕複製或刪除單則訊息。
    *   使用對話列表右上角的「X」按鈕刪除當前設定下的所有對話。
    *   使用「剪貼簿摘要/翻譯」按鈕快速處理剪貼簿內容。

## 注意事項

*   **❗ https 頁面不能連 http API：** 這是最容易踩到的一件事。從 GitHub Pages（https）開啟的 PWA，去 `fetch('http://...')` 會被瀏覽器的 mixed content 規則直接封鎖，**裝得起來但一送出就失敗**。而把 PWA 放在 http 上也不是退路：http 不是安全上下文，Service Worker 不會註冊、不能安裝、剪貼簿也讀不到。解法是給 API 掛 https（反向代理、Tailscale Serve、Cloudflare Tunnel），或把 PWA 與 API 放在同一個 https 來源（同源就連 CORS 都不用管）。本機用 `http://localhost` 測試不受此限。
*   **❗ 改了前端檔案要升 `CACHE_NAME`：** `sw.js` 的 `CACHE_NAME` 是寫死的字串，不升版號的話已安裝的 PWA 會一直吃舊快取，看不到新程式碼。新增檔案也要加進 `urlsToCache`（`so-what-prompt.md` 是執行時 fetch 進來的，所以它必須在清單裡）。
*   **API 金鑰安全：** API 金鑰儲存在瀏覽器的 `localStorage` 中。請確保您的裝置和瀏覽器環境安全。
*   **API 網址要帶 `/v1`：** 程式會自己接 `/chat/completions` 與 `/models`，所以設定裡填的是例如 `http://host:8000/v1`。
*   **CORS：** 確保 LLM API 伺服器允許來自 PWA 部署網域的跨來源請求。llama.cpp 與 vLLM 預設都會回 CORS 標頭。
*   **推理模型的等待時間：** 本機推理模型可能為了一句短回覆思考上千個 token。所有路徑都改成串流並即時顯示思考過程，但整輪的總時間仍然取決於模型。
*   **圖示：** 目前只有 128 與 144。144 剛好過 Chrome 的最低可安裝門檻，但建議補 192×192 與 512×512（其中一張標 `"purpose": "maskable"`），不然 Android 主畫面圖示會模糊或被硬裁。

---

