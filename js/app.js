// js/app.js

document.addEventListener('DOMContentLoaded', () => {
    // 元素獲取
    const configSelect = document.getElementById('configSelect');
    const sendMessageButton = document.getElementById('sendMessageButton');
    const summaryButton = document.getElementById('summaryButton');
    const translateButton = document.getElementById('translateButton');
    const userInput = document.getElementById('userInput');
    const conversationList = document.getElementById('conversationList');
    const deleteAllConversationsButton = document.getElementById('deleteAllConversationsButton');
    const loadingIndicator = document.getElementById('loadingIndicator');
    const soWhatButton = document.getElementById('soWhatButton');
    const cardTableButton = document.getElementById('cardTableButton');

    // 全局變數
    let selectedConfig = null;
    let accumulatedResponse = ''; // 累積的、已提取 content 的回應文本
    
    // 新增: 用於串流時精確更新 DOM 的變數
    let streamingDOMs = {
        main: null, // 指向當前主要 (非思考) 回應的 .conversation-content div
        think: null // 指向當前思考塊的 <details> 元素內的 .thinking-content-inner div
    };
    // 從 Web Share Target 進來的來源資訊（標題與網址），給「所以呢？」的卡片用
    let pendingShareSource = null;
    let pendingStreamText = ''; // 尚未處理的串流尾巴（可能是被切一半的標籤）
    let reasoningFieldOpen = false; // 獨立 reasoning 欄位的思考區塊是否還沒收尾
    let streamingThinkDetails = null; // 指向當前串流中的思考 <details> 元素，結束時用來摺疊
    let currentStreamIsThinking = false; // 標記當前串流的內容是否在思考塊內

    // 各家推理模型的思考標籤：DeepSeek <think>、Gemma 4 <|channel>thought、其他 <thought>
    const THINK_START_TAGS = ['<think>', '<|channel>thought', '<thought>'];
    const THINK_END_TAGS = ['</think>', '<channel|>', '</thought>'];
    // 判斷 chunk 結尾是否為某個標籤的開頭時用的候選清單。
    // 多收一個 '<|channel>thought' + 換行的版本，這樣剛好切在換行之前時也會等下一個 chunk。
    // 把思考內容放在獨立欄位的伺服器：llama.cpp 用 reasoning_content、vLLM 用 reasoning
    const REASONING_DELTA_FIELDS = ['reasoning_content', 'reasoning'];
    const THINK_PARTIAL_TAGS = THINK_START_TAGS.concat(THINK_END_TAGS, ['<|channel>thought\n']);
    const MAX_THINK_TAG_LENGTH = THINK_PARTIAL_TAGS.reduce((max, tag) => Math.max(max, tag.length), 0);

    // 智慧型跟隨捲動：使用者往上看前文時暫停自動跟隨，回到底部時自動恢復
    let autoFollowScroll = true;          // 是否處於「跟隨」狀態
    let userScrollIntent = false;         // 使用者是否正在用滑鼠/觸控操作捲動
    const FOLLOW_BOTTOM_THRESHOLD = 100;  // 距離底部多少 px 內視為「在底部」

    // 初始化操作
    loadConfigsForSelection();
    registerServiceWorker();
    registerFollowScrollListeners();
    exposeAppBridge();
    handleShareTarget();
    if (window.SoWhat) window.SoWhat.restoreIfAny();

    // 事件監聽器
    if (configSelect) {
        configSelect.addEventListener('change', handleConfigChange);
    }
    if (sendMessageButton) {
        sendMessageButton.addEventListener('click', sendMessage);
    }
    if (summaryButton) {
        summaryButton.addEventListener('click', summarizeTextFromClipboard);
    }
    if (translateButton) {
        translateButton.addEventListener('click', translateTextFromClipboard);
    }
    if (soWhatButton) {
        soWhatButton.addEventListener('click', () => {
            if (window.SoWhat) window.SoWhat.start();
        });
    }
    if (cardTableButton) {
        cardTableButton.addEventListener('click', () => {
            if (window.SoWhat) window.SoWhat.openCardTable();
        });
    }
    if (userInput) {
        userInput.addEventListener('keydown', (event) => {
            if (event.ctrlKey && event.key === 'Enter') {
                sendMessage();
            }
        });
    }
    // 使用事件委託處理 deleteAllConversationsButton 的點擊
    if (conversationList) {
        conversationList.addEventListener('click', function(event) {
            const targetButton = event.target.closest('#deleteAllConversationsButton'); // 確保點擊的是按鈕或其子元素
            if (targetButton) {
                confirmDeleteAllConversations();
            }
        });
    }	
    // if (deleteAllConversationsButton) {
        // deleteAllConversationsButton.addEventListener('click', confirmDeleteAllConversations);
    // }

    // sowhat.js 是獨立的 script，看不到這個閉包裡的函式。
    // 與其把它整個搬進來，明確掛出它需要的少數幾個接口。
    function exposeAppBridge() {
        window.BarbaraApp = {
            getSelectedConfig: () => selectedConfig,
            getConversationStorageKey: getConversationStorageKey,
            addConversationToStorage: addConversationToStorage,
            loadConversationsUI: loadConversationsUI,
            setInterfaceLoading: setInterfaceLoading,
            escapeHtml: escapeHtml,
            scrollToBottom: scrollToBottom,
            extractFirstJsonObject: extractFirstJsonObject,
            getLanguageName: getLanguageName,
            createStreamParser: createStreamParser,
            // 「所以呢？」開始新對話時取用並清掉，避免下一次沿用舊來源
            takeShareSource: () => {
                const source = pendingShareSource;
                pendingShareSource = null;
                return source;
            }
        };
    }

    // Web Share Target：安裝後從別的 app 分享文字進來，會以
    // ./index.html?title=..&text=..&url=.. 開啟。把內容填進輸入框，
    // 來源留給「所以呢？」的卡片用，並清掉網址上的查詢字串（否則重新整理會再觸發一次）。
    //
    // 注意：iOS Safari 不支援 Web Share Target，所以這條路在 iPhone 上不會被走到，
    // iPhone 維持「複製 → 開啟 → 按所以呢？」的剪貼簿流程。
    function handleShareTarget() {
        if (!window.location.search) return;
        const params = new URLSearchParams(window.location.search);
        const sharedText = (params.get('text') || '').trim();
        const sharedUrl = (params.get('url') || '').trim();
        const sharedTitle = (params.get('title') || '').trim();
        if (!sharedText && !sharedUrl && !sharedTitle) return;

        // 分享網頁時多數 app 會把選取的文字放在 text、網址放在 url。
        // 只有網址沒有文字時，就把網址本身當內容，讓使用者能接著請代理去抓。
        const content = sharedText || sharedUrl;
        if (userInput && content) userInput.value = content;

        if (sharedUrl || sharedTitle) {
            pendingShareSource = { title: sharedTitle, url: sharedUrl };
        }

        renderShareBanner(sharedTitle, sharedUrl);

        // 清掉查詢字串，避免重新整理或之後的導覽重複帶入同一筆分享
        window.history.replaceState({}, '', window.location.pathname);
    }

    function renderShareBanner(title, url) {
        const inputArea = document.querySelector('.input-area');
        if (!inputArea || !inputArea.parentElement) return;
        const existing = document.getElementById('shareBanner');
        if (existing) existing.remove();

        const banner = document.createElement('div');
        banner.id = 'shareBanner';
        banner.className = 'share-banner';

        const info = document.createElement('div');
        info.className = 'share-banner-info';
        const source = title || url;
        info.textContent = source ? `已接收分享內容 — ${source}` : '已接收分享內容';
        if (url) info.title = url;
        banner.appendChild(info);

        const actions = document.createElement('div');
        actions.className = 'share-banner-actions';

        const soWhatBtn = document.createElement('button');
        soWhatBtn.textContent = '所以呢？';
        soWhatBtn.onclick = () => {
            banner.remove();
            if (window.SoWhat) window.SoWhat.start();
        };

        const dismiss = document.createElement('button');
        dismiss.className = 'share-banner-dismiss';
        dismiss.textContent = '關閉';
        dismiss.onclick = () => {
            banner.remove();
            pendingShareSource = null;
        };

        actions.appendChild(soWhatBtn);
        actions.appendChild(dismiss);
        banner.appendChild(actions);
        // 插在輸入區之前而不是裡面：.input-area 是 flex row，塞進去會把輸入框與
        // 按鈕擠成奇怪的排版；.chat-page 是 column，放這裡就自己佔一整行。
        inputArea.parentElement.insertBefore(banner, inputArea);
    }

    function registerServiceWorker() {
        if ('serviceWorker' in navigator) {
            window.addEventListener('load', () => {
                navigator.serviceWorker.register('./sw.js')
                    .then(registration => {
                        console.log('[App.js] ServiceWorker registration successful with scope: ', registration.scope);
                    })
                    .catch(error => {
                        console.log('[App.js] ServiceWorker registration failed: ', error);
                    });
            });
        }
    }

    function getStoredConfigs() {
        const configsString = localStorage.getItem('pwa_configs');
        return configsString ? JSON.parse(configsString) : [];
    }

    function getSelectedConfigIndex() {
        const index = localStorage.getItem('pwa_selectedConfigIndex');
        return index ? parseInt(index, 10) : 0;
    }

    function saveSelectedConfigIndex(index) {
        localStorage.setItem('pwa_selectedConfigIndex', index.toString());
    }

    async function loadConfigsForSelection() {
        const configs = getStoredConfigs();
        if (configSelect) {
            configSelect.innerHTML = '';
            if (configs.length === 0) {
                const option = document.createElement('option');
                option.textContent = "請先前往設定頁面新增設定";
                option.disabled = true;
                configSelect.appendChild(option);
                selectedConfig = null;
                loadConversationsUI();
                return;
            }

            configs.forEach((config, index) => {
                const option = document.createElement('option');
                option.value = index;
                option.textContent = `${config.apiUrl.substring(0,30)}... - ${config.modelId || '(未選模型)'}`;
                configSelect.appendChild(option);
            });

            const savedIndex = getSelectedConfigIndex();
            if (savedIndex >= 0 && savedIndex < configs.length) {
                configSelect.selectedIndex = savedIndex;
            } else if (configs.length > 0) {
                configSelect.selectedIndex = 0;
                saveSelectedConfigIndex(0);
            }
            handleConfigChange();
        }
    }

    function handleConfigChange() {
        const configs = getStoredConfigs();
        const selectedIndex = configSelect ? parseInt(configSelect.value, 10) : 0;

        if (configs.length > 0 && selectedIndex >= 0 && selectedIndex < configs.length) {
            selectedConfig = configs[selectedIndex];
            saveSelectedConfigIndex(selectedIndex);
        } else {
            selectedConfig = null;
        }
        loadConversationsUI();
    }

    function getConversationStorageKey() {
        if (!selectedConfig || !selectedConfig.apiUrl || !selectedConfig.modelId) {
            return `pwa_conv_default`;
        }
        const apiUrlKey = selectedConfig.apiUrl.replace(/[^a-zA-Z0-9_-]/g, '');
        const modelIdKey = selectedConfig.modelId.replace(/[^a-zA-Z0-9_-]/g, '');
        return `pwa_conv_${apiUrlKey}_${modelIdKey}`;
    }

    function getConversations() {
        const convKey = getConversationStorageKey();
        const conversationsString = localStorage.getItem(convKey);
        return conversationsString ? JSON.parse(conversationsString) : [];
    }

    function saveConversations(conversations) {
        const convKey = getConversationStorageKey();
        localStorage.setItem(convKey, JSON.stringify(conversations));
    }

    function addConversationToStorage(messageObject) {
        const conversations = getConversations();
        conversations.push({
            role: messageObject.role,
            content: messageObject.content,
            isThinking: messageObject.isThinking || false,
            isStep: messageObject.isStep || false,
            timestamp: new Date().toISOString()
        });
        saveConversations(conversations);
    }

    function loadConversationsUI() {
        if (!conversationList) return;
        const currentScrollTop = conversationList.scrollTop; // 保存滾動位置

        // 創建 "全部刪除" 按鈕的 HTML 字符串 (或 DOM 元素)
        const deleteAllButtonHTML = `
            <div class="delete-all-conversations">
                <button id="deleteAllConversationsButton" title="刪除所有對話">X</button>
            </div>
        `;		
        conversationList.innerHTML = deleteAllButtonHTML;
        if (!selectedConfig) {
             const placeholder = document.createElement('div');
             placeholder.textContent = "請選擇或新增一個設定以開始對話。";
             placeholder.style.textAlign = "center";
             placeholder.style.padding = "20px";
             conversationList.appendChild(placeholder);
            return;
        }

        const conversations = getConversations();
        if (conversations.length === 0 && selectedConfig) {
            const placeholder = document.createElement('div');
            placeholder.textContent = "尚無對話，開始輸入吧！";
            placeholder.style.textAlign = "center";
            placeholder.style.padding = "20px";
            conversationList.appendChild(placeholder);
        }
        conversations.forEach((conv, index) => {
            appendConversationToDOM(conv, index, false); // isStreaming is false for stored conversations
        });
        // 「所以呢？」那段對話不在 conversations 裡，重畫時會被清掉，這裡把節點接回去
        if (window.SoWhat) window.SoWhat.reattachThread(conversationList);
        scrollToBottom();
    }

    function appendConversationToDOM(message, index, isStreaming = false) {
        if (!conversationList) return null; // 返回 null 如果列表不存在
        const div = document.createElement('div');
        div.className = 'conversation-item';
        if (message.role === 'user') div.classList.add('user-message');
        if (message.role === 'assistant') div.classList.add('assistant-message');
        if (message.isThinking) div.classList.add('thinking-process');
        if (message.isStep) div.classList.add('agent-step');

        const contentDiv = document.createElement('div');
        contentDiv.className = 'conversation-content';
        let thinkingContentInnerDiv = null; // 用於返回思考內容的內部 div

        if (message.isStep) {
            // 工具執行紀錄：第一行當標題，其餘收在摺疊區塊裡
            const details = document.createElement('details');
            const summary = document.createElement('summary');
            const firstLine = String(message.content || '').split('\n')[0];
            summary.textContent = firstLine.replace(/\*\*/g, '');
            details.appendChild(summary);

            const stepInner = document.createElement('div');
            stepInner.className = 'thinking-content-inner';
            stepInner.innerHTML = typeof marked !== 'undefined'
                ? marked.parse(message.content)
                : escapeHtml(message.content);
            if (!isStreaming) {
                addCopyButtonToCodeBlocks(stepInner);
            }
            details.appendChild(stepInner);
            contentDiv.appendChild(details);
        } else if (message.isThinking) {
            const details = document.createElement('details');
            // details.open = isStreaming; // 串流時可以考慮預設展開思考過程
            const summary = document.createElement('summary');
            summary.textContent = '顯示/隱藏 AI 思考過程';
            details.appendChild(summary);

            thinkingContentInnerDiv = document.createElement('div');
            thinkingContentInnerDiv.className = 'thinking-content-inner';
            thinkingContentInnerDiv.innerHTML = typeof marked !== 'undefined' ? marked.parse(message.content) : escapeHtml(message.content);
            // 在串流結束後，或從存儲加載時，才對思考內容添加複製按鈕
            if (!isStreaming) {
                addCopyButtonToCodeBlocks(thinkingContentInnerDiv);
            }
            details.appendChild(thinkingContentInnerDiv);
            contentDiv.appendChild(details);
        } else {
            contentDiv.innerHTML = typeof marked !== 'undefined' ? marked.parse(message.content) : escapeHtml(message.content);
            if (!isStreaming) {
                addCopyButtonToCodeBlocks(contentDiv);
            }
        }
        div.appendChild(contentDiv);

        if (!isStreaming) { // 只有非串流（已儲存或串流完畢）的訊息才添加永久按鈕
            const deleteButton = document.createElement('button');
            deleteButton.className = 'delete-button';
            deleteButton.textContent = 'X';
            deleteButton.title = '刪除此訊息';
            deleteButton.onclick = () => confirmDeleteSingleConversation(index);

            const copyButton = document.createElement('button');
            copyButton.className = 'copy-button';
            copyButton.innerHTML = '&#128203;';
            copyButton.title = '複製此訊息';
            copyButton.onclick = () => copyConversationContent(message.content);

            div.appendChild(deleteButton);
            div.appendChild(copyButton);
        }
        conversationList.appendChild(div);
        if (isStreaming) {
            smartFollowScroll();
        } else {
            scrollToBottom();
        }

        // 返回用於串流更新的相關 DOM 元素
        if (isStreaming) {
            if (message.isThinking) {
                return { parentItem: div, contentContainer: thinkingContentInnerDiv };
            } else {
                return { parentItem: div, contentContainer: contentDiv };
            }
        }
        return div; // 對於非串流，返回整個 conversation-item div
    }


    // 在文字中找出最早出現的思考標籤，回傳 { index, length }；找不到時 index 為 -1。
    // Gemma 4 的 <|channel>thought 後面通常緊跟一個換行，一併吃掉避免思考區塊開頭空行。
    function findEarliestThinkTag(text, tags) {
        let found = { index: -1, length: 0 };
        tags.forEach(tag => {
            const idx = text.indexOf(tag);
            if (idx === -1) return;
            if (found.index !== -1 && idx >= found.index) return;
            const eatNewline = (tag === '<|channel>thought' && text.startsWith('\n', idx + tag.length)) ? 1 : 0;
            found = { index: idx, length: tag.length + eatNewline };
        });
        return found;
    }

    // 串流可能把標籤切成兩半（例如一個 chunk 結尾是 '<thi'、下一個 chunk 才送來 'nk>'）。
    // 把結尾「有可能是標籤開頭」的字元留在 buffer 裡，等下一個 chunk 到齊再一起判斷；
    // 最多只會留 MAX_THINK_TAG_LENGTH - 1 個字元，不會無限累積。
    function splitAtPossibleTag(text) {
        const maxHold = Math.min(text.length, MAX_THINK_TAG_LENGTH - 1);
        for (let hold = maxHold; hold > 0; hold--) { // 由長到短，優先採用較長的候選
            const suffix = text.slice(text.length - hold);
            const isPartialTag = THINK_PARTIAL_TAGS.some(tag => tag.length > suffix.length && tag.startsWith(suffix));
            if (isPartialTag) {
                return { ready: text.slice(0, text.length - hold), held: suffix };
            }
        }
        return { ready: text, held: '' };
    }

    // 把獨立的 reasoning 欄位轉寫成 <think>...</think>，之後就能沿用同一套標籤狀態機，
    // 串流渲染與最終儲存都不必再分兩種來源處理。
    function buildTaggedText(parsed) {
        let text = '';
        if (parsed.reasoning) {
            if (!reasoningFieldOpen) {
                text += '<think>';
                reasoningFieldOpen = true;
            }
            text += parsed.reasoning;
        }
        if (parsed.content) {
            if (reasoningFieldOpen) { // 正式回覆開始，思考區塊收尾
                text += '</think>';
                reasoningFieldOpen = false;
            }
            text += parsed.content;
        }
        return text;
    }

    function escapeHtml(unsafe) {
        if (typeof unsafe !== 'string') return '';
        return unsafe
             .replace(/&/g, "&amp;")
             .replace(/</g, "&lt;")
             .replace(/>/g, "&gt;")
             .replace(/"/g, "&quot;")
             .replace(/'/g, "&#039;");
    }

    function confirmDeleteSingleConversation(index) {
        if (confirm('確定要刪除這則對話嗎？')) {
            const conversations = getConversations();
            if (index >= 0 && index < conversations.length) {
                conversations.splice(index, 1);
                saveConversations(conversations);
                loadConversationsUI();
            }
        }
    }

    function copyConversationContent(content) {
        if (navigator.clipboard && navigator.clipboard.writeText) {
            navigator.clipboard.writeText(content)
                .then(() => alert('內容已複製到剪貼簿！'))
                .catch(err => console.error('無法複製內容: ', err));
        } else {
            const textArea = document.createElement("textarea");
            textArea.value = content;
            textArea.style.position = "fixed";
            textArea.style.left = "-9999px";
            document.body.appendChild(textArea);
            textArea.focus();
            textArea.select();
            try {
                document.execCommand('copy');
                alert('內容已複製到剪貼簿！');
            } catch (err) {
                console.error('備用複製方法失敗: ', err);
            }
            document.body.removeChild(textArea);
        }
    }

    function confirmDeleteAllConversations() {
        if (!selectedConfig) {
            alert("請先選擇一個設定檔。");
            return;
        }
        if (confirm('確定要刪除此設定檔下的所有對話嗎？')) {
            saveConversations([]);
            loadConversationsUI();
        }
    }

    function addCopyButtonToCodeBlocks(container) {
        if (typeof marked === 'undefined' || !container) return;
        const codeElements = container.querySelectorAll('pre > code, code[class*="language-"]');
        codeElements.forEach(codeElement => {
            const parentPre = codeElement.closest('pre');
            if (parentPre && !parentPre.querySelector('button.copy-code-button')) {
                const copyCodeButton = document.createElement('button');
                copyCodeButton.className = 'copy-button copy-code-button';
                copyCodeButton.innerHTML = '&#128203;';
                copyCodeButton.title = '複製程式碼';
                parentPre.style.position = 'relative';
                parentPre.appendChild(copyCodeButton);

                copyCodeButton.onclick = (event) => {
                    event.stopPropagation();
                    const codeToCopy = codeElement.innerText;
                    copyConversationContent(codeToCopy);
                };
            }
        });
    }

    // 強制捲到底（載入對話、送出訊息、結束串流時使用）
    function scrollToBottom() {
        if (conversationList) {
            conversationList.scrollTop = conversationList.scrollHeight;
        }
    }

    function isNearBottom() {
        if (!conversationList) return true;
        return conversationList.scrollHeight - conversationList.scrollTop
            - conversationList.clientHeight < FOLLOW_BOTTOM_THRESHOLD;
    }

    // 只在「跟隨」狀態下才捲到底（串流期間使用），使用者往上看前文時不打斷他
    function smartFollowScroll() {
        if (!autoFollowScroll) return;
        scrollToBottom();
    }

    // 滾輪往上 = 使用者想看前文，立即暫停跟隨
    function registerFollowScrollListeners() {
        if (!conversationList) return;

        conversationList.addEventListener('wheel', (event) => {
            if (event.deltaY < 0) autoFollowScroll = false;
        }, { passive: true });

        // 觸控 / 拖曳捲軸期間，若離開底部就暫停跟隨
        conversationList.addEventListener('touchstart', () => { userScrollIntent = true; }, { passive: true });
        conversationList.addEventListener('touchend', () => { userScrollIntent = false; }, { passive: true });
        conversationList.addEventListener('mousedown', () => { userScrollIntent = true; });
        window.addEventListener('mouseup', () => { userScrollIntent = false; });

        window.addEventListener('keydown', (event) => {
            const activeTag = document.activeElement ? document.activeElement.tagName : '';
            if (activeTag === 'TEXTAREA' || activeTag === 'INPUT') return;
            if (['PageUp', 'ArrowUp', 'Home'].includes(event.key)) autoFollowScroll = false;
        });

        // 捲回接近底部時恢復跟隨；使用者操作中離開底部則暫停
        conversationList.addEventListener('scroll', () => {
            if (isNearBottom()) {
                autoFollowScroll = true;
            } else if (userScrollIntent) {
                autoFollowScroll = false;
            }
        }, { passive: true });
    }

    // --- API 請求與處理 ---
    // ===== Agent：工具註冊表與迴圈設定 =====

    const AGENT_MAX_RECURSION_DEPTH = 8;         // 連續工具輪數上限，擋住無限迴圈
    const AGENT_MAX_FORCE_CONTINUE_DEPTH = 3;    // 「只思考不回答」最多強制接續幾次
    const AUTO_APPROVE_CHECKPOINT_ROUNDS = 5;    // 自動放行幾輪後強制回來確認一次
    const AGENT_ROUND_DELAY_MS = 800;            // 每輪之間的停頓，避免觸發速率限制
    const TOOL_RESULT_TOKEN_BUDGET = 6000;       // 單次工具結果塞回對話的 token 上限
    const EXTRACTION_MAX_ATTEMPTS = 2;           // 反芻抽取的重試次數

    const AGENT_SYSTEM_PROMPT = '你是一個有用的 AI 助理，並且可以使用工具 (functions)。'
        + '如果使用者的要求需要用到工具（例如需要知道現在時間、需要讀取剪貼簿內容、需要抓取某個網址的文字），'
        + '你必須實際呼叫該工具，而不是只用文字描述你需要呼叫它。'
        + '呼叫工具時請輸出正確的 function call。若不需要工具，就直接回答。';

    const FORCE_CONTINUE_PROMPT = '系統提示: 你剛剛輸出了思考過程，但沒有實際呼叫工具，也沒有給出正式回覆。'
        + '請根據你的思考計畫，現在立刻執行下一個步驟，一次只做一步。'
        + '若要呼叫工具，請嚴格只輸出一個 JSON 物件，例如 {"name": "工具名稱", "arguments": {"參數名": "參數值"}}。'
        + '若已經可以回答，請直接給出最終回覆，不要再輸出思考過程。';

    // 「本次對話都允許」的授權清單，以對話儲存 key 為單位（重新載入頁面即失效）
    const grantedToolsByConversation = {};

    function getGrantedTools() {
        const key = getConversationStorageKey();
        if (!grantedToolsByConversation[key]) grantedToolsByConversation[key] = {};
        return grantedToolsByConversation[key];
    }

    // 粗估 token 數：中日韓字元約 1 個字 1 token，其餘約 4 字元 1 token
    function estimateTokens(text) {
        const cjkMatches = text.match(/[　-鿿豈-﫿＀-￯]/g);
        const cjk = cjkMatches ? cjkMatches.length : 0;
        return cjk + Math.ceil(Math.max(0, text.length - cjk) / 4);
    }

    // 依 token 預算截斷文字。用二分逼近，避免對長文逐字計算。
    function truncateToTokenBudget(text, maxTokens) {
        if (estimateTokens(text) <= maxTokens) return { text: text, truncated: false };
        let low = 0;
        let high = text.length;
        while (low < high) {
            const mid = Math.floor((low + high + 1) / 2);
            if (estimateTokens(text.slice(0, mid)) <= maxTokens) low = mid;
            else high = mid - 1;
        }
        return { text: text.slice(0, low), truncated: true };
    }

    // 把 HTML 轉成純文字。用 DOMParser 而不是 regex，標籤嵌套與實體才不會出錯。
    function htmlToPlainText(html) {
        const doc = new DOMParser().parseFromString(html, 'text/html');
        doc.querySelectorAll('script, style, noscript, svg, iframe').forEach(el => el.remove());
        const body = doc.body ? (doc.body.textContent || '') : '';
        return {
            title: (doc.title || '').trim(),
            text: body.replace(/[ \t]+/g, ' ').replace(/\n\s*\n\s*\n+/g, '\n\n').trim()
        };
    }

    // PWA 能做到的工具。瀏覽器分頁類的技能（讀當前網頁、注入 JS、切分頁）
    // 依賴 chrome.tabs / chrome.scripting，PWA 沒有，所以這裡不提供。
    const ToolRegistry = {
        get_current_datetime: {
            getDisplayName: () => '🕒 查詢當前時間',
            getUiDescription: () => '代理想要讀取你裝置上的目前日期與時間。',
            schema: {
                type: 'function',
                function: {
                    name: 'get_current_datetime',
                    description: '當需要知道現在的日期或時間（例如計算天數、判斷星期、加上時間戳記）時呼叫此工具。回傳使用者裝置的本地時間。'
                }
            },
            execute: async () => {
                const now = new Date();
                let zone = '未知';
                try { zone = Intl.DateTimeFormat().resolvedOptions().timeZone || '未知'; } catch (e) { }
                return '本地時間: ' + now.toLocaleString() + '（ISO: ' + now.toISOString() + '，時區: ' + zone + '）';
            }
        },

        read_clipboard_text: {
            getDisplayName: () => '📋 讀取剪貼簿文字',
            getUiDescription: () => '代理想要讀取你剪貼簿裡的文字內容，用來完成摘要、翻譯或分析。',
            schema: {
                type: 'function',
                function: {
                    name: 'read_clipboard_text',
                    description: '當使用者提到「剪貼簿」、「我剛複製的內容」、「幫我摘要我複製的東西」，或需要取得使用者手上那段文字才能回答時，呼叫此工具讀取剪貼簿中的純文字。'
                }
            },
            execute: async () => {
                if (!navigator.clipboard || !navigator.clipboard.readText) {
                    return '工具執行失敗: 此瀏覽器不支援讀取剪貼簿。請改請使用者直接把文字貼進輸入框。';
                }
                try {
                    const text = await navigator.clipboard.readText();
                    if (!text || !text.trim()) return '剪貼簿是空的，或只包含空白字元。';
                    const result = truncateToTokenBudget(text.trim(), TOOL_RESULT_TOKEN_BUDGET);
                    const note = result.truncated ? '（內容過長，已截斷）' : '';
                    return '剪貼簿內容' + note + ':\n' + result.text;
                } catch (error) {
                    return '工具執行失敗: 無法讀取剪貼簿（' + error.message + '）。'
                        + '瀏覽器要求安全來源與使用者授權，請改請使用者直接把文字貼進輸入框。';
                }
            }
        },

        fetch_url_text: {
            getDisplayName: () => '🌐 抓取網址文字',
            getUiDescription: (args) => {
                const url = args && args.url ? String(args.url) : '(未提供網址)';
                return '代理想要抓取以下網址的文字內容:<br><code>' + escapeHtml(url) + '</code>';
            },
            schema: {
                type: 'function',
                function: {
                    name: 'fetch_url_text',
                    description: '當使用者給了一個網址並要求摘要、翻譯或分析該頁內容時，呼叫此工具抓取該網址的純文字。注意: 瀏覽器的跨來源限制 (CORS) 會讓多數網站抓取失敗，失敗時請改請使用者自行複製內容。',
                    parameters: {
                        type: 'object',
                        properties: {
                            url: {
                                type: 'string',
                                description: '要抓取的完整網址，需包含 http:// 或 https://。例如: https://example.com/article'
                            }
                        },
                        required: ['url']
                    }
                }
            },
            execute: async (args) => {
                const url = args && args.url ? String(args.url).trim() : '';
                if (!/^https?:\/\//i.test(url)) {
                    return '工具執行失敗: 網址必須以 http:// 或 https:// 開頭。';
                }
                try {
                    const response = await fetch(url, { redirect: 'follow' });
                    if (!response.ok) {
                        return '工具執行失敗: 伺服器回應 ' + response.status + ' ' + response.statusText + '。';
                    }
                    const raw = await response.text();
                    const parsed = htmlToPlainText(raw);
                    if (!parsed.text) return '抓取成功但頁面沒有可讀的文字內容（可能整頁由 JavaScript 動態產生）。';
                    const result = truncateToTokenBudget(parsed.text, TOOL_RESULT_TOKEN_BUDGET);
                    const note = result.truncated ? '（內容過長，已依 token 預算截斷）' : '';
                    return '網頁標題: ' + (parsed.title || '(無標題)') + '\n網頁內文' + note + ':\n' + result.text;
                } catch (error) {
                    return '工具執行失敗: 無法抓取此網址（' + error.message + '）。'
                        + '最常見的原因是該網站不允許瀏覽器跨來源讀取 (CORS)。'
                        + '請告知使用者這個限制，並請他自行複製內容後貼上，或改用剪貼簿工具。';
                }
            }
        }
    };

    // ===== 工具呼叫的解析 =====

    // 串流回來的 tool_calls 是逐片段的，依 index 合併成完整的呼叫
    function mergeToolCallDeltas(target, deltas) {
        if (!deltas || !deltas.length) return;
        deltas.forEach(delta => {
            const index = typeof delta.index === 'number' ? delta.index : 0;
            if (!target[index]) {
                target[index] = {
                    id: delta.id || ('call_' + Math.random().toString(36).substring(2, 9)),
                    type: 'function',
                    function: { name: '', arguments: '' }
                };
            }
            if (delta.id) target[index].id = delta.id;
            if (delta.function) {
                if (delta.function.name) target[index].function.name += delta.function.name;
                if (delta.function.arguments) target[index].function.arguments += delta.function.arguments;
            }
        });
    }

    // 從文字中抓出第一個括號平衡且可解析的 JSON 物件。
    // 用括號配對而不是非貪婪 regex，巢狀 JSON 才不會被截斷。
    function extractFirstJsonObject(text) {
        let searchFrom = 0;
        while (searchFrom < text.length) {
            const start = text.indexOf('{', searchFrom);
            if (start === -1) return null;
            let depth = 0;
            let inString = false;
            let escaped = false;
            let end = -1;
            for (let i = start; i < text.length; i++) {
                const ch = text[i];
                if (inString) {
                    if (escaped) escaped = false;
                    else if (ch === '\\') escaped = true;
                    else if (ch === '"') inString = false;
                } else if (ch === '"') {
                    inString = true;
                } else if (ch === '{') {
                    depth++;
                } else if (ch === '}') {
                    depth--;
                    if (depth === 0) { end = i; break; }
                }
            }
            if (end === -1) return null; // 括號不平衡，可能是被截斷的輸出
            const candidate = text.slice(start, end + 1);
            try {
                JSON.parse(candidate);
                return candidate;
            } catch (error) {
                searchFrom = start + 1; // 這段不是合法 JSON，從下一個 { 繼續找
            }
        }
        return null;
    }

    // 便宜的前置過濾：全文完全沒提到任何工具名，就不花一次 API 呼叫去反芻抽取
    function textMentionsAnyTool(text) {
        return Object.keys(ToolRegistry).some(name => text.indexOf(name) !== -1);
    }

    // 驗證抽取結果。schema 驗證放在我們這邊做，不信任模型輸出。
    // 回傳 { noTool: true } / tool_call 物件 / null(驗證失敗)
    function validateExtractedToolCall(parsed) {
        if (!parsed || typeof parsed !== 'object') return null;
        if (parsed.name === null) return { noTool: true };
        if (typeof parsed.name !== 'string' || !ToolRegistry[parsed.name]) return null;
        const args = (parsed.arguments && typeof parsed.arguments === 'object') ? parsed.arguments : {};
        const fnSchema = ToolRegistry[parsed.name].schema.function;
        const required = (fnSchema.parameters && fnSchema.parameters.required) || [];
        for (let i = 0; i < required.length; i++) {
            const key = required[i];
            if (args[key] === undefined || args[key] === null || args[key] === '') return null;
        }
        return {
            id: 'call_' + Math.random().toString(36).substring(2, 9),
            type: 'function',
            function: { name: parsed.name, arguments: JSON.stringify(args) }
        };
    }

    // 第二階段「反芻抽取」：第一階段讓模型自由推理，若沒觸發原生 tool_calls，
    // 就讓同一顆模型對自己的輸出做一次非串流的純抽取，把呼叫意圖轉成結構化 JSON。
    async function extractToolCallViaModel(config, phase1Text) {
        const toolList = Object.values(ToolRegistry).map(tool => {
            const fn = tool.schema.function;
            const paramNames = fn.parameters ? Object.keys(fn.parameters.properties || {}).join(', ') : '';
            return '- ' + fn.name + (paramNames ? '（參數: ' + paramNames + '）' : '（無參數）');
        }).join('\n');

        const extractionMessages = [
            {
                role: 'system',
                content: '你是一個純抽取器。閱讀使用者提供的 AI 助理輸出文本，判斷其中是否嘗試呼叫工具。'
                    + '只從文本中抽取，不得新增、改寫或自行推理。只輸出一個 JSON 物件，不要輸出任何其他文字。'
            },
            {
                role: 'user',
                content: '可用工具:\n' + toolList + '\n\n助理輸出文本:\n"""\n' + phase1Text + '\n"""\n\n'
                    + '若文本中嘗試呼叫上述工具，輸出 {"name": "工具名", "arguments": {參數物件}}；'
                    + '參數值必須來自文本本身，不得自行編造。若文本沒有嘗試呼叫任何工具，輸出 {"name": null}。'
            }
        ];

        for (let attempt = 1; attempt <= EXTRACTION_MAX_ATTEMPTS; attempt++) {
            try {
                const response = await fetch(`${config.apiUrl}/chat/completions`, {
                    method: 'POST',
                    headers: {
                        'Content-Type': 'application/json',
                        'Authorization': `Bearer ${config.apiKey}`,
                    },
                    body: JSON.stringify({
                        model: config.modelId,
                        messages: extractionMessages,
                        stream: false,
                        temperature: 0,
                        max_tokens: 1024
                    })
                });
                if (!response.ok) throw new Error('HTTP ' + response.status);
                const data = await response.json();
                const message = data.choices && data.choices[0] && data.choices[0].message;
                const rawText = message ? (message.content || '') : '';
                const jsonStr = extractFirstJsonObject(rawText);
                if (!jsonStr) throw new Error('回應中沒有可解析的 JSON');
                const result = validateExtractedToolCall(JSON.parse(jsonStr));
                if (result) return result;
                throw new Error('抽取結果未通過 schema 驗證');
            } catch (error) {
                console.warn(`[Extractor] 抽取失敗 (${attempt}/${EXTRACTION_MAX_ATTEMPTS}): ${error.message}`);
            }
        }
        return null; // 徹底失敗，降級到文字備援解析
    }

    // 文字備援解析：反芻抽取也失敗時，用幾種常見的輸出樣式硬掃一次
    function parseToolCallFromText(text) {
        let toolName = null;
        let argsString = '{}';

        // 樣式 1: `<|tool_call>call:func{...}` 這類 Gemma / Llama 的呼叫標籤
        const tagMatch = text.match(/(?:<\|tool_call>|<tool_call>)\s*call:([a-zA-Z_0-9]+)\{([\s\S]*?)\}/);
        // 樣式 2: markdown 的 json 區塊
        const jsonBlockMatch = text.match(/```json\s*(\{[\s\S]*?"name"\s*:\s*"([a-zA-Z_0-9]+)"[\s\S]*?\})\s*```/);
        // 樣式 3: Gemma 常用的引導語
        const phraseMatch = text.match(/Therefore,\s*I\s*should\s*call\s*`?([a-zA-Z_0-9]+)`?/i);

        if (tagMatch && ToolRegistry[tagMatch[1]]) {
            toolName = tagMatch[1];
            argsString = '{' + tagMatch[2] + '}';
        } else if (jsonBlockMatch && ToolRegistry[jsonBlockMatch[2]]) {
            toolName = jsonBlockMatch[2];
            try {
                const parsedObj = JSON.parse(jsonBlockMatch[1]);
                if (parsedObj.parameters) argsString = JSON.stringify(parsedObj.parameters);
                else if (parsedObj.arguments) argsString = JSON.stringify(parsedObj.arguments);
            } catch (error) { }
        } else if (phraseMatch && ToolRegistry[phraseMatch[1]]) {
            toolName = phraseMatch[1];
            const jsonStr = extractFirstJsonObject(text);
            if (jsonStr) argsString = jsonStr;
        } else {
            // 樣式 4: 掃描工具名稱是否被當成指令直接提及
            const names = Object.keys(ToolRegistry);
            for (let i = 0; i < names.length; i++) {
                const name = names[i];
                const actionRegex = new RegExp('(?:call|use|execute|run|呼叫|使用|執行)\\s*(?:the\\s+)?(?:tool\\s+)?(?:function\\s+)?`?' + name + '`?', 'i');
                if (actionRegex.test(text) || new RegExp('^\\s*' + name + '\\s*$', 'm').test(text)) {
                    toolName = name;
                    const jsonStr = extractFirstJsonObject(text);
                    if (jsonStr) argsString = jsonStr;
                    break;
                }
            }
        }

        if (!toolName) return [];

        // 需要參數卻只抓到空物件，通常代表模型只講了工具名沒給 JSON，這時放棄攔截
        const fnSchema = ToolRegistry[toolName].schema.function;
        const required = (fnSchema.parameters && fnSchema.parameters.required) || [];
        let parsedArgs = {};
        try { parsedArgs = JSON.parse(argsString); } catch (error) { }
        if (required.length > 0 && Object.keys(parsedArgs).length === 0) {
            console.log(`[Fallback] 攔截到 ${toolName} 但缺少必要參數，放棄攔截。`);
            return [];
        }

        console.log(`[Fallback] 從文字中攔截到工具呼叫: ${toolName}`);
        return [{
            id: 'call_' + Math.random().toString(36).substring(2, 9),
            type: 'function',
            function: { name: toolName, arguments: argsString }
        }];
    }

    // 決定這一輪到底要不要呼叫工具：原生 tool_calls → 反芻抽取 → 文字備援
    async function resolveToolCalls(config, nativeToolCalls, responseText) {
        const validNative = nativeToolCalls
            .filter(tc => tc && tc.function && tc.function.name && ToolRegistry[tc.function.name]);
        if (validNative.length > 0) return validNative;

        if (!responseText || !textMentionsAnyTool(responseText)) return [];

        const extracted = await extractToolCallViaModel(config, responseText);
        if (extracted && extracted.noTool) return [];
        if (extracted) return [extracted];

        return parseToolCallFromText(responseText);
    }

    // 判斷模型是不是只輸出思考、沒給正式回覆
    function isThoughtOnlyResponse(text) {
        if (!text) return false;
        const thinkRegexGlobal = /(?:<think>|<\|channel>thought\n?|<thought>)([\s\S]*?)(?:<\/think>|<channel\|>|<\/thought>)/g;
        const hasThoughts = thinkRegexGlobal.test(text);
        thinkRegexGlobal.lastIndex = 0;
        const withoutThoughts = text.replace(thinkRegexGlobal, '').trim();
        return hasThoughts && withoutThoughts === '';
    }

    // ===== 授權與執行 =====

    // 把一筆稽核紀錄存進對話並重畫。存起來才不會被後續的重繪洗掉。
    function addStepRecord(content) {
        addConversationToStorage({ role: 'assistant', content: content, isStep: true });
        loadConversationsUI();
    }

    function buildToolSummaryHtml(toolCalls) {
        return toolCalls.map(tc => {
            const name = tc.function.name;
            let args = {};
            try { args = JSON.parse(tc.function.arguments || '{}'); } catch (error) { }
            const tool = ToolRegistry[name];
            if (tool && tool.getDisplayName && tool.getUiDescription) {
                return '<strong>' + tool.getDisplayName() + '</strong><br>' + tool.getUiDescription(args);
            }
            return '<strong>⚙️ ' + escapeHtml(name) + '</strong><br><code>'
                + escapeHtml(tc.function.arguments || '{}') + '</code>';
        }).join('<br><br>');
    }

    function toolDisplayNames(toolCalls) {
        return toolCalls.map(tc => {
            const tool = ToolRegistry[tc.function.name];
            return (tool && tool.getDisplayName) ? tool.getDisplayName() : ('⚙️ ' + tc.function.name);
        }).join('、');
    }

    // 人類回圈：所有工具執行都要使用者按下按鈕才會進行。
    // 已按過「本次對話都允許」的工具會自動放行，但每 AUTO_APPROVE_CHECKPOINT_ROUNDS 輪強制確認一次。
    async function requestToolApproval(toolCalls, recursionDepth) {
        const granted = getGrantedTools();
        const toolNames = toolCalls.map(tc => tc.function.name);
        const uniqueNames = toolNames.filter((name, i) => toolNames.indexOf(name) === i);
        const allGranted = uniqueNames.every(name => granted[name]);
        const checkpointReached = recursionDepth > 0 && recursionDepth % AUTO_APPROVE_CHECKPOINT_ROUNDS === 0;
        const toolsHtml = buildToolSummaryHtml(toolCalls);

        if (allGranted && !checkpointReached) {
            addStepRecord('✅ 已依「本次對話都允許」自動放行: ' + toolDisplayNames(toolCalls));
            return 'approve';
        }

        const dialog = document.createElement('div');
        dialog.className = 'conversation-item assistant-message tool-approval';
        const checkpointNote = checkpointReached
            ? '<div class="tool-approval-note">⚠️ 已連續自動執行 ' + AUTO_APPROVE_CHECKPOINT_ROUNDS + ' 輪，請確認是否繼續。</div>'
            : '';
        dialog.innerHTML = '<div class="tool-approval-body"><strong>⚠️ 代理請求執行以下操作:</strong><br><br>'
            + toolsHtml + '<br><br>請確認是否允許執行？</div>' + checkpointNote;

        const buttons = document.createElement('div');
        buttons.className = 'tool-approval-buttons';
        const approveBtn = document.createElement('button');
        approveBtn.className = 'tool-approve';
        approveBtn.textContent = '允許執行';
        const alwaysBtn = document.createElement('button');
        alwaysBtn.className = 'tool-always';
        alwaysBtn.textContent = '本次對話都允許';
        const stopBtn = document.createElement('button');
        stopBtn.className = 'tool-stop';
        stopBtn.textContent = '到此為止';
        const denyBtn = document.createElement('button');
        denyBtn.className = 'tool-deny';
        denyBtn.textContent = '拒絕執行';
        buttons.appendChild(approveBtn);
        buttons.appendChild(alwaysBtn);
        buttons.appendChild(stopBtn);
        buttons.appendChild(denyBtn);
        dialog.appendChild(buttons);
        conversationList.appendChild(dialog);
        dialog.scrollIntoView({ behavior: 'smooth', block: 'start' }); // 需要人工決策，強制聚焦

        let grantedThisRound = false;
        const decision = await new Promise(resolve => {
            const lock = () => {
                dialog.style.opacity = '0.5';
                [approveBtn, alwaysBtn, stopBtn, denyBtn].forEach(btn => { btn.disabled = true; });
            };
            approveBtn.onclick = () => { lock(); resolve('approve'); };
            alwaysBtn.onclick = () => {
                uniqueNames.forEach(name => { granted[name] = true; });
                grantedThisRound = true;
                lock();
                resolve('approve');
            };
            stopBtn.onclick = () => { lock(); resolve('stop'); };
            denyBtn.onclick = () => { lock(); resolve('deny'); };
        });

        let statusText;
        if (decision === 'approve') {
            statusText = grantedThisRound
                ? '✅ 使用者已授權（本次對話此類動作不再詢問）: '
                : '✅ 使用者已授權執行: ';
        } else if (decision === 'stop') {
            statusText = '⚠️ 使用者要求到此為止，不再執行: ';
        } else {
            statusText = '❌ 使用者拒絕執行: ';
        }
        addStepRecord(statusText + toolDisplayNames(toolCalls));
        return decision;
    }

    // 依序執行工具，把每一步的結果既寫進畫面稽核紀錄，也以 role:tool 餵回模型
    async function executeToolCalls(toolCalls, currentMessages) {
        for (let i = 0; i < toolCalls.length; i++) {
            const toolCall = toolCalls[i];
            const toolName = toolCall.function.name;
            const argsString = toolCall.function.arguments || '{}';
            const tool = ToolRegistry[toolName];
            const displayName = (tool && tool.getDisplayName) ? tool.getDisplayName() : toolName;

            let args = {};
            try { args = JSON.parse(argsString); } catch (error) { }

            let resultString = `工具 ${toolName} 未找到或尚未註冊。`;
            if (tool) {
                try {
                    resultString = await tool.execute(args);
                } catch (error) {
                    resultString = `執行錯誤: ${error.message}`;
                }
            }

            const preview = resultString.length > 300 ? resultString.slice(0, 300) + '…' : resultString;
            addStepRecord(`**執行工具:** ${displayName}\n\n**參數:** \`${argsString}\`\n\n**結果:**\n${preview}`);

            currentMessages.push({
                role: 'tool',
                tool_call_id: toolCall.id,
                name: toolName,
                content: resultString
            });
        }
    }

    async function sendMessage() {
        const inputText = userInput ? userInput.value.trim() : "";
        if (!inputText) return;

        if (!selectedConfig) {
            alert("請先選擇一個有效的 API 設定。");
            return;
        }
        if (!selectedConfig.apiUrl || !selectedConfig.apiKey || !selectedConfig.modelId) {
            alert("選擇的 API 設定不完整 (缺少網址、金鑰或模型 ID)。請前往設定頁面檢查。");
            return;
        }

        const userMessage = { role: 'user', content: inputText };
        addConversationToStorage(userMessage);
        appendConversationToDOM(userMessage, getConversations().length - 1, false);
        if (userInput) userInput.value = '';

        await runAgentStreamLoop(selectedConfig, buildMessagesForAPI(), 0);
    }

    // 把儲存的對話轉成 API 要的 messages。
    // 思考過程與工具紀錄只是畫面上的稽核軌跡，不回送給模型。
    function buildMessagesForAPI() {
        return getConversations()
            .filter(conv => !conv.isThinking && !conv.isStep)
            .map(conv => ({ role: conv.role, content: conv.content }));
    }

    function delay(ms) {
        return new Promise(resolve => setTimeout(resolve, ms));
    }

    // Agent 迴圈：串流一輪 → 看模型是否要呼叫工具 → 請使用者授權 → 執行 → 把結果餵回去再跑一輪。
    // recursionDepth 是連續工具輪數，用來擋住無限迴圈。
    async function runAgentStreamLoop(config, messages, recursionDepth) {
        const currentMessages = messages.slice();
        if (currentMessages.length > 0 && currentMessages[0].role !== 'system') {
            currentMessages.unshift({ role: 'system', content: AGENT_SYSTEM_PROMPT });
        }

        accumulatedResponse = ''; // 累積已解析的文本內容 (不含 data: 前綴)
        streamingDOMs.main = null;
        streamingDOMs.think = null;
        streamingThinkDetails = null;
        currentStreamIsThinking = false;
        pendingStreamText = '';
        reasoningFieldOpen = false;
        if (recursionDepth === 0) autoFollowScroll = true; // 新回答開始時重置為跟隨模式
        let currentAccumulatedTextForDOM = ""; // 用於當前 DOM 塊的文本
        const responseToolCalls = []; // 原生 tool_calls 的累積結果
        const parseChunk = createStreamParser();

        try {
            setInterfaceLoading(true);

            const payload = {
                model: config.modelId,
                messages: currentMessages,
                stream: true
            };
            const availableTools = Object.values(ToolRegistry).map(tool => tool.schema);
            if (availableTools.length > 0) {
                payload.tools = availableTools;
                payload.tool_choice = "auto";
            }

            const response = await fetch(`${config.apiUrl}/chat/completions`, {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                    'Authorization': `Bearer ${config.apiKey}`,
                },
                body: JSON.stringify(payload)
            });

            if (!response.ok) {
                const errorData = await response.json().catch(() => ({ message: response.statusText }));
                throw new Error(`API 請求失敗: ${response.status} ${errorData.message || ''}`);
            }

            const reader = response.body.getReader();
            const decoder = new TextDecoder('utf-8');

            while (true) {
                const { done, value } = await reader.read();

                let contentTokens;
                if (done) {
                    // 收尾：buffer 裡剩下的是不完整的標籤，當成普通文字輸出
                    contentTokens = pendingStreamText;
                    pendingStreamText = '';
                    if (reasoningFieldOpen) { // 回應在思考中就結束，補上收尾標籤
                        contentTokens += '</think>';
                        reasoningFieldOpen = false;
                    }
                } else {
                    const rawChunk = decoder.decode(value, { stream: true });
                    const parsedChunk = parseChunk(rawChunk);
                    mergeToolCallDeltas(responseToolCalls, parsedChunk.toolCalls);
                    pendingStreamText += buildTaggedText(parsedChunk); // 從原始 chunk 中提取實際內容
                    const split = splitAtPossibleTag(pendingStreamText);
                    pendingStreamText = split.held;
                    contentTokens = split.ready;
                }

                if (contentTokens) {
                    accumulatedResponse += contentTokens; // 累積所有解析後的文本

                    let processableTokenStream = contentTokens;
                    while (processableTokenStream.length > 0) {
                        if (!currentStreamIsThinking) { // 當前在處理主要回應內容
                            const thinkStart = findEarliestThinkTag(processableTokenStream, THINK_START_TAGS);
                            const thinkStartIndex = thinkStart.index;
                            if (thinkStartIndex !== -1) { // 在當前 token 中找到了思考起始標籤
                                // 1. 起始標籤之前的部分，添加到主要回應
                                const beforeThinkText = processableTokenStream.substring(0, thinkStartIndex);
                                if (beforeThinkText) {
                                    currentAccumulatedTextForDOM += beforeThinkText;
                                    if (!streamingDOMs.main) {
                                        const domRefs = appendConversationToDOM({ role: 'assistant', content: currentAccumulatedTextForDOM, isThinking: false }, -1, true); // index -1 表示是臨時串流DOM
                                        streamingDOMs.main = domRefs.contentContainer;
                                    }
                                    if (streamingDOMs.main) {
                                        streamingDOMs.main.innerHTML = typeof marked !== 'undefined' ? marked.parse(currentAccumulatedTextForDOM + "▍") : escapeHtml(currentAccumulatedTextForDOM + "▍");
                                    }
                                }
                                // 2. 切換到思考模式
                                currentStreamIsThinking = true;
                                currentAccumulatedTextForDOM = ""; // 重置累積文本給新的塊
                                streamingDOMs.main = null; // 主要回應的當前 DOM 塊結束
                                processableTokenStream = processableTokenStream.substring(thinkStartIndex + thinkStart.length);
                            } else { // 當前 token 中沒有思考起始標籤，全部是主要回應
                                currentAccumulatedTextForDOM += processableTokenStream;
                                if (!streamingDOMs.main) {
                                     const domRefs = appendConversationToDOM({ role: 'assistant', content: currentAccumulatedTextForDOM, isThinking: false }, -1, true);
                                     streamingDOMs.main = domRefs.contentContainer;
                                }
                                if (streamingDOMs.main) {
                                     streamingDOMs.main.innerHTML = typeof marked !== 'undefined' ? marked.parse(currentAccumulatedTextForDOM + "▍") : escapeHtml(currentAccumulatedTextForDOM + "▍");
                                }
                                processableTokenStream = ""; // 當前 token 處理完畢
                            }
                        } else { // currentStreamIsThinking is true，當前在處理 <think> 內部內容
                            const thinkEnd = findEarliestThinkTag(processableTokenStream, THINK_END_TAGS);
                            const thinkEndIndex = thinkEnd.index;
                            if (thinkEndIndex !== -1) { // 在當前 token 中找到了思考結束標籤
                                // 1. 結束標籤之前的部分，添加到思考內容
                                const inThinkText = processableTokenStream.substring(0, thinkEndIndex);
                                if (inThinkText) {
                                    currentAccumulatedTextForDOM += inThinkText;
                                    if (!streamingDOMs.think) {
                                        const domRefs = appendConversationToDOM({ role: 'assistant', content: currentAccumulatedTextForDOM, isThinking: true }, -1, true);
                                        streamingDOMs.think = domRefs.contentContainer;
                                        streamingThinkDetails = domRefs.parentItem.querySelector('details');
                                        if (streamingThinkDetails) {
                                            streamingThinkDetails.open = true; // 串流時展開
                                            const summary = streamingThinkDetails.querySelector('summary');
                                            if (summary) summary.textContent = 'AI 思考中...';
                                        }
                                    }
                                    if (streamingDOMs.think) {
                                        streamingDOMs.think.innerHTML = typeof marked !== 'undefined' ? marked.parse(currentAccumulatedTextForDOM + "▍") : escapeHtml(currentAccumulatedTextForDOM + "▍");
                                    }
                                }
                                // 2. 思考結束：移除游標並自動摺疊，避免長篇思考擠掉正式回覆
                                if (streamingDOMs.think && streamingDOMs.think.innerHTML.endsWith("▍")) {
                                    streamingDOMs.think.innerHTML = streamingDOMs.think.innerHTML.slice(0, -1);
                                }
                                if (streamingThinkDetails) {
                                    streamingThinkDetails.open = false;
                                    const summary = streamingThinkDetails.querySelector('summary');
                                    if (summary) summary.textContent = '顯示/隱藏 AI 思考過程';
                                    streamingThinkDetails = null;
                                }

                                // 3. 切換回主要回應模式
                                currentStreamIsThinking = false;
                                currentAccumulatedTextForDOM = ""; // 重置累積文本給新的塊
                                streamingDOMs.think = null; // 思考塊的當前 DOM 結束
                                processableTokenStream = processableTokenStream.substring(thinkEndIndex + thinkEnd.length);
                            } else { // 當前 token 中沒有思考結束標籤，全部是思考內容
                                currentAccumulatedTextForDOM += processableTokenStream;
                                if (!streamingDOMs.think) {
                                    const domRefs = appendConversationToDOM({ role: 'assistant', content: currentAccumulatedTextForDOM, isThinking: true }, -1, true);
                                    streamingDOMs.think = domRefs.contentContainer;
                                    streamingThinkDetails = domRefs.parentItem.querySelector('details');
                                    if (streamingThinkDetails) {
                                        streamingThinkDetails.open = true;
                                        const summary = streamingThinkDetails.querySelector('summary');
                                        if (summary) summary.textContent = 'AI 思考中...';
                                    }
                                }
                                if (streamingDOMs.think) {
                                     streamingDOMs.think.innerHTML = typeof marked !== 'undefined' ? marked.parse(currentAccumulatedTextForDOM + "▍") : escapeHtml(currentAccumulatedTextForDOM + "▍");
                                }
                                processableTokenStream = ""; // 當前 token 處理完畢
                            }
                        }
                    } // end while (processableTokenStream.length > 0)
                } // end if (contentTokens)
                smartFollowScroll();
                if (done) break;
            } // end while(true) reader.read()

            // 串流結束，移除最後的游標並儲存
            if (streamingDOMs.main && streamingDOMs.main.innerHTML.endsWith("▍")) {
                streamingDOMs.main.innerHTML = streamingDOMs.main.innerHTML.slice(0, -1);
            }
            if (streamingDOMs.think && streamingDOMs.think.innerHTML.endsWith("▍")) {
                streamingDOMs.think.innerHTML = streamingDOMs.think.innerHTML.slice(0, -1);
            }

            // 移除之前所有串流中創建的臨時 DOM 元素
            const tempStreamingItems = conversationList.querySelectorAll('.conversation-item:has(.conversation-content:empty)'); // 簡易判斷
            const streamingItemsPlaceholder = conversationList.querySelectorAll('.assistant-message'); //更寬泛的查找
            // 找到最後一個使用者訊息之後的所有 assistant 訊息並移除它們，然後重新渲染
            let lastUserMessageIndex = -1;
            const allItems = Array.from(conversationList.children);
            for (let i = allItems.length - 1; i >= 0; i--) {
                if (allItems[i].classList.contains('user-message')) {
                    lastUserMessageIndex = i;
                    break;
                }
            }
            for (let i = allItems.length - 1; i > lastUserMessageIndex; i--) {
                 if(allItems[i].classList.contains('assistant-message')) { //只刪除 assistant 的
                    conversationList.removeChild(allItems[i]);
                 }
            }



            // 本輪的文字先存檔再重畫，這樣工具輪的思考過程也不會在後續重繪中消失
            parseAndStoreFinalResponse(accumulatedResponse);
            loadConversationsUI();

            const toolCalls = await resolveToolCalls(config, responseToolCalls, accumulatedResponse);

            if (toolCalls.length > 0) {
                if (recursionDepth >= AGENT_MAX_RECURSION_DEPTH) {
                    addStepRecord(`⛔ 已達連續工具執行上限 ${AGENT_MAX_RECURSION_DEPTH} 輪，停止代理迴圈。`);
                    return;
                }

                currentMessages.push({
                    role: "assistant",
                    content: accumulatedResponse || null,
                    tool_calls: toolCalls
                });

                const decision = await requestToolApproval(toolCalls, recursionDepth);

                if (decision === 'approve') {
                    await executeToolCalls(toolCalls, currentMessages);
                } else if (decision === 'stop') {
                    toolCalls.forEach(toolCall => {
                        currentMessages.push({
                            role: "tool",
                            tool_call_id: toolCall.id,
                            name: toolCall.function.name,
                            content: JSON.stringify({ status: "user_stopped", message: "系統提示: 使用者認為目前的資訊已經足夠，或提早中止了此工具的執行。請勿再呼叫任何工具，直接根據你目前已知的上下文來總結並回答使用者的問題。" })
                        });
                    });
                } else {
                    toolCalls.forEach(toolCall => {
                        currentMessages.push({
                            role: "tool",
                            tool_call_id: toolCall.id,
                            name: toolCall.function.name,
                            content: JSON.stringify({ status: "user_aborted", error_code: 403, message: "嚴重警告: 使用者已明確拒絕授權此動作。你絕對不可假設動作已完成，也請勿再嘗試呼叫此工具。請向使用者解釋任務因為權限被拒絕而無法繼續。" })
                        });
                    });
                }

                await delay(AGENT_ROUND_DELAY_MS); // 停頓一下，避免觸發 API 速率限制
                return await runAgentStreamLoop(config, currentMessages, recursionDepth + 1);
            }

            // 有些本地模型只輸出思考就停住，既沒給正式回覆也沒呼叫工具，這裡強制它接續
            if (isThoughtOnlyResponse(accumulatedResponse) && recursionDepth < AGENT_MAX_FORCE_CONTINUE_DEPTH) {
                currentMessages.push({ role: "assistant", content: accumulatedResponse });
                currentMessages.push({ role: "user", content: FORCE_CONTINUE_PROMPT });
                addStepRecord('⏭️ 代理僅完成思考，系統已自動要求其繼續執行後續動作。');
                await delay(AGENT_ROUND_DELAY_MS);
                return await runAgentStreamLoop(config, currentMessages, recursionDepth + 1);
            }

        } catch (error) {
            console.error('與 API 通訊時發生錯誤:', error);
            alert(`錯誤: ${error.message}`);
            addConversationToStorage({ role: 'assistant', content: `錯誤: ${error.message}` });
            loadConversationsUI(); // 顯示錯誤訊息
        } finally {
            setInterfaceLoading(false);
            accumulatedResponse = '';
            streamingDOMs.main = null;
            streamingDOMs.think = null;
            streamingThinkDetails = null;
            currentStreamIsThinking = false;
            pendingStreamText = '';
            reasoningFieldOpen = false;
            scrollToBottom();
        }
    }

    function parseAndStoreFinalResponse(finalRenderedText) {
        // 非全局，用於 iterative split；同時支援 <think>、Gemma 4 <|channel>thought 與 <thought>
        const thinkTagRegex = /(?:<think>|<\|channel>thought\n?|<thought>)([\s\S]*?)(?:<\/think>|<channel\|>|<\/thought>)/;
        let remainingText = finalRenderedText;
        let parts = [];

        while (remainingText.length > 0) {
            const match = remainingText.match(thinkTagRegex);
            if (match) {
                const beforeText = remainingText.substring(0, match.index);
                if (beforeText.trim()) {
                    parts.push({ type: 'text', content: beforeText.trim() });
                }
                if (match[1] && match[1].trim()) {
                    parts.push({ type: 'think', content: match[1].trim() });
                }
                remainingText = remainingText.substring(match.index + match[0].length);
            } else {
                if (remainingText.trim()) {
                    parts.push({ type: 'text', content: remainingText.trim() });
                }
                break;
            }
        }

        parts.forEach(part => {
            if (part.type === 'think') {
                addConversationToStorage({
                    role: 'assistant',
                    content: part.content,
                    isThinking: true
                });
            } else {
                addConversationToStorage({
                    role: 'assistant',
                    content: part.content,
                    isThinking: false
                });
            }
        });
    }


    // 從 SSE 數據中提取本次可用的 content / reasoning。
    // 兩種思考內容的來源：
    //   a) content 裡的 <think> 等標籤（LM Studio、未開推理解析的 llama.cpp）
    //   b) 獨立欄位 delta.reasoning_content（llama.cpp）或 delta.reasoning（vLLM）
    // 這裡只負責取值，標籤解析仍由呼叫端的狀態機處理。
    // 回傳一個解析器。每個串流各自一份行緩衝，
    // 聊天跟「所以呢？」同時用也不會互相污染。
    function createStreamParser() {
        let pendingSse = ''; // 尚未解析完的 SSE 行（read() 可能切在 JSON 中間）

        return function parseStreamChunk(rawChunk) {
        let content = '';
        let reasoning = '';
        const toolCalls = [];

        // 一次 read() 可能剛好切在某一行 JSON 中間，把不完整的尾行留到下一次再解析
        pendingSse += rawChunk;
        const lines = pendingSse.split('\n');
        pendingSse = lines.pop();

        lines.forEach(line => {
            line = line.trim();
            if (!line.startsWith('data: ')) return;
            const data = line.substring('data: '.length);
            if (data.trim().toUpperCase() === '[DONE]') { // 大小寫不敏感的 [DONE]
                return;
            }
            try {
                const parsedData = JSON.parse(data);
                const delta = parsedData.choices && parsedData.choices[0] && parsedData.choices[0].delta;
                if (!delta) return; // 有些 chunk 只有 role 沒有內容，是正常的
                if (delta.content) {
                    content += delta.content;
                }
                REASONING_DELTA_FIELDS.forEach(field => {
                    if (delta[field]) reasoning += delta[field];
                });
                if (delta.tool_calls && delta.tool_calls.length) {
                    delta.tool_calls.forEach(tc => toolCalls.push(tc));
                }
            } catch (error) {
                // console.warn('解析串流 JSON 錯誤:', data, error);
            }
        });

        return { content: content, reasoning: reasoning, toolCalls: toolCalls };
        };
    }

    async function getTextFromClipboard() {
        if (navigator.clipboard && navigator.clipboard.readText) {
            try {
                const text = await navigator.clipboard.readText();
                if (!text.trim()) {
                    alert("剪貼簿是空的或只包含空白。");
                    return null;
                }
                return text.trim();
            } catch (err) {
                console.error('讀取剪貼簿失敗:', err);
                alert("無法讀取剪貼簿，請確認瀏覽器設定並授予權限 (通常需要在 HTTPS 下)。");
                return null;
            }
        } else {
            alert("您的瀏覽器不支援直接讀取剪貼簿功能。");
            return null;
        }
    }

    async function summarizeTextFromClipboard() {
        const text = await getTextFromClipboard();
        if (!text) return;

        if (!selectedConfig) {
            alert("請先選擇一個 API 設定。");
            return;
        }
         const prompt = `請使用與原文相同的語言，對以下文字進行摘要：\n\n"${text}"`;
        if(userInput) userInput.value = prompt;
        sendMessage();
    }

    async function translateTextFromClipboard() {
        const text = await getTextFromClipboard();
        if (!text) return;

        if (!selectedConfig) {
            alert("請先選擇一個 API 設定。");
            return;
        }

        const localRatio = calculateLocalRatio(text);
        const browserLang = navigator.language || 'en';
        const targetLanguage = localRatio > 0.5 ? 'English' : getLanguageName(browserLang);

        const prompt = `請將以下文字翻譯成 ${targetLanguage}:\n\n"${text}"`;
        if(userInput) userInput.value = prompt;
        sendMessage();
    }

    const languageRegex = {
        'en': /\p{Script=Latin}|[A-Za-z]/gu, 'en-US': /\p{Script=Latin}|[A-Za-z]/gu, 'en-GB': /\p{Script=Latin}|[A-Za-z]/gu,
        'zh': /\p{Script=Han}/gu, 'zh-TW': /\p{Script=Han}/gu, 'zh-CN': /\p{Script=Han}/gu,
        'ja': /\p{Script=Hiragana}|\p{Script=Katakana}|\p{Script=Han}/gu, 'ja-JP': /\p{Script=Hiragana}|\p{Script=Katakana}|\p{Script=Han}/gu,
        'ko': /\p{Script=Hangul}|\p{Script=Han}/gu, 'ko-KR': /\p{Script=Hangul}|\p{Script=Han}/gu,
    };

    function calculateLocalRatio(text) {
        const lang = (navigator.language || 'en').split('-')[0];
        const localCharRegex = languageRegex[lang] || languageRegex['en'];
        if (!text || !localCharRegex) return 0;
        const matches = text.matchAll(localCharRegex);
        let localCharCount = 0;
        for (const match of matches) { localCharCount += match[0].length; }
        return text.length > 0 ? localCharCount / text.length : 0;
    }

    function getLanguageName(langCode) {
        const langMap = {
            'en': 'English', 'zh': 'Traditional Chinese (繁體中文)', 'ja': 'Japanese (日本語)', 'ko': 'Korean (한국어)',
            'fr': 'French (Français)', 'de': 'German (Deutsch)', 'es': 'Spanish (Español)',
        };
        const mainLang = langCode.split('-')[0];
        if (mainLang === 'zh' && (langCode.toLowerCase().includes('tw') || langCode.toLowerCase().includes('hk'))) {
            return 'Traditional Chinese (繁體中文)';
        } else if (mainLang === 'zh') { return 'Simplified Chinese (简体中文)'; }
        return langMap[mainLang] || langCode;
    }

    function setInterfaceLoading(isLoading) {
        const elementsToDisable = [
            userInput, sendMessageButton, summaryButton, translateButton,
            configSelect, deleteAllConversationsButton
        ];
        if (loadingIndicator) { loadingIndicator.classList.toggle('show', isLoading); }
        elementsToDisable.forEach(element => {
            if (element) {
                element.disabled = isLoading;
                element.classList.toggle('loading', isLoading);
            }
        });
    }

    if (configSelect && configSelect.options.length > 0 && configSelect.selectedIndex !== -1) {
        handleConfigChange();
    } else if (configSelect) { loadConversationsUI(); }
});
