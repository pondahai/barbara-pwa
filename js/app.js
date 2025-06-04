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

    // 全局變數
    let selectedConfig = null;
    let accumulatedResponse = ''; // 累積的、已提取 content 的回應文本
    
    // 新增: 用於串流時精確更新 DOM 的變數
    let streamingDOMs = {
        main: null, // 指向當前主要 (非思考) 回應的 .conversation-content div
        think: null // 指向當前思考塊的 <details> 元素內的 .thinking-content-inner div
    };
    let currentStreamIsThinking = false; // 標記當前串流的內容是否在 <think> 塊內

    // 初始化操作
    loadConfigsForSelection();
    registerServiceWorker();

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
    if (userInput) {
        userInput.addEventListener('keydown', (event) => {
            if (event.ctrlKey && event.key === 'Enter') {
                sendMessage();
            }
        });
    }
    if (deleteAllConversationsButton) {
        deleteAllConversationsButton.addEventListener('click', confirmDeleteAllConversations);
    }

    function registerServiceWorker() {
        if ('serviceWorker' in navigator) {
            window.addEventListener('load', () => {
                navigator.serviceWorker.register('/barbara-pwa/sw.js')
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
            timestamp: new Date().toISOString()
        });
        saveConversations(conversations);
    }

    function loadConversationsUI() {
        if (!conversationList) return;
        conversationList.innerHTML = '';
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
        scrollToBottom();
    }

    function appendConversationToDOM(message, index, isStreaming = false) {
        if (!conversationList) return null; // 返回 null 如果列表不存在
        const div = document.createElement('div');
        div.className = 'conversation-item';
        if (message.role === 'user') div.classList.add('user-message');
        if (message.role === 'assistant') div.classList.add('assistant-message');
        if (message.isThinking) div.classList.add('thinking-process');

        const contentDiv = document.createElement('div');
        contentDiv.className = 'conversation-content';
        let thinkingContentInnerDiv = null; // 用於返回思考內容的內部 div

        if (message.isThinking) {
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
        scrollToBottom();

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

    function scrollToBottom() {
        if (conversationList) {
            conversationList.scrollTop = conversationList.scrollHeight;
        }
    }

    // --- API 請求與處理 ---
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

        const history = getConversations();
        const messagesForAPI = history
            .filter(conv => !conv.isThinking)
            .map(conv => ({ role: conv.role, content: conv.content }));

        accumulatedResponse = ''; // 累積已解析的文本內容 (不含 data: 前綴)
        streamingDOMs.main = null;
        streamingDOMs.think = null;
        currentStreamIsThinking = false;
        let currentAccumulatedTextForDOM = ""; // 用於當前 DOM 塊的文本

        try {
            setInterfaceLoading(true);
            const response = await fetch(`${selectedConfig.apiUrl}/v1/chat/completions`, {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                    'Authorization': `Bearer ${selectedConfig.apiKey}`,
                },
                body: JSON.stringify({
                    model: selectedConfig.modelId,
                    messages: messagesForAPI,
                    stream: true
                })
            });

            if (!response.ok) {
                const errorData = await response.json().catch(() => ({ message: response.statusText }));
                throw new Error(`API 請求失敗: ${response.status} ${errorData.message || ''}`);
            }

            const reader = response.body.getReader();
            const decoder = new TextDecoder('utf-8');

            while (true) {
                const { done, value } = await reader.read();
                if (done) break;

                const rawChunk = decoder.decode(value, { stream: true });
                const contentTokens = parseStreamChunk(rawChunk); // 從原始 chunk 中提取實際內容

                if (contentTokens) {
                    accumulatedResponse += contentTokens; // 累積所有解析後的文本

                    let processableTokenStream = contentTokens;
                    while (processableTokenStream.length > 0) {
                        if (!currentStreamIsThinking) { // 當前在處理主要回應內容
                            const thinkStartIndex = processableTokenStream.indexOf('<think>');
                            if (thinkStartIndex !== -1) { // 在當前 token 中找到了 <think>
                                // 1. <think> 之前的部分，添加到主要回應
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
                                processableTokenStream = processableTokenStream.substring(thinkStartIndex + '<think>'.length);
                            } else { // 當前 token 中沒有 <think>，全部是主要回應
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
                            const thinkEndIndex = processableTokenStream.indexOf('</think>');
                            if (thinkEndIndex !== -1) { // 在當前 token 中找到了 </think>
                                // 1. </think> 之前的部分，添加到思考內容
                                const inThinkText = processableTokenStream.substring(0, thinkEndIndex);
                                if (inThinkText) {
                                    currentAccumulatedTextForDOM += inThinkText;
                                    if (!streamingDOMs.think) {
                                        const domRefs = appendConversationToDOM({ role: 'assistant', content: currentAccumulatedTextForDOM, isThinking: true }, -1, true);
                                        streamingDOMs.think = domRefs.contentContainer;
                                        if (domRefs.parentItem.querySelector('details')) domRefs.parentItem.querySelector('details').open = true; // 串流時展開
                                    }
                                    if (streamingDOMs.think) {
                                        streamingDOMs.think.innerHTML = typeof marked !== 'undefined' ? marked.parse(currentAccumulatedTextForDOM + "▍") : escapeHtml(currentAccumulatedTextForDOM + "▍");
                                    }
                                }
                                // 2. 切換回主要回應模式
                                currentStreamIsThinking = false;
                                currentAccumulatedTextForDOM = ""; // 重置累積文本給新的塊
                                streamingDOMs.think = null; // 思考塊的當前 DOM 結束
                                processableTokenStream = processableTokenStream.substring(thinkEndIndex + '</think>'.length);
                            } else { // 當前 token 中沒有 </think>，全部是思考內容
                                currentAccumulatedTextForDOM += processableTokenStream;
                                if (!streamingDOMs.think) {
                                    const domRefs = appendConversationToDOM({ role: 'assistant', content: currentAccumulatedTextForDOM, isThinking: true }, -1, true);
                                    streamingDOMs.think = domRefs.contentContainer;
                                    if (domRefs.parentItem.querySelector('details')) domRefs.parentItem.querySelector('details').open = true;
                                }
                                if (streamingDOMs.think) {
                                     streamingDOMs.think.innerHTML = typeof marked !== 'undefined' ? marked.parse(currentAccumulatedTextForDOM + "▍") : escapeHtml(currentAccumulatedTextForDOM + "▍");
                                }
                                processableTokenStream = ""; // 當前 token 處理完畢
                            }
                        }
                    } // end while (processableTokenStream.length > 0)
                } // end if (contentTokens)
                scrollToBottom();
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


            // 使用 accumulatedResponse (已解析的完整文本流) 進行最終的分割和儲存
            parseAndStoreFinalResponse(accumulatedResponse);
            loadConversationsUI(); // 重新從 localStorage 載入並渲染，確保所有內容正確

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
            currentStreamIsThinking = false;
            scrollToBottom();
        }
    }

    function parseAndStoreFinalResponse(finalRenderedText) {
        const thinkTagRegex = /(?:<think>([\s\S]*?)<\/think>)/; // 非全局，用於 iterative split
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


    function parseStreamChunk(rawChunk) { // 從原始 JSON Lines 數據中提取 content token
        let content = '';
        const lines = rawChunk.split('\n').filter(line => line.trim() !== '');
        lines.forEach(line => {
            if (line.startsWith('data: ')) {
                const data = line.substring('data: '.length);
                if (data.trim().toUpperCase() === '[DONE]') { // 大小寫不敏感的 [DONE]
                    return;
                }
                try {
                    const parsedData = JSON.parse(data);
                    if (parsedData.choices && parsedData.choices[0] && parsedData.choices[0].delta) {
                        if (parsedData.choices[0].delta.content) {
                             content += parsedData.choices[0].delta.content;
                        }
                        // 有些模型可能只在 delta 中包含 role 而沒有 content (例如開頭第一個 chunk)
                        // else if (parsedData.choices[0].delta.role && !parsedData.choices[0].delta.content) {
                        //    // 這是正常的，例如第一個 chunk 只有 role: assistant
                        // }
                    }
                } catch (error) {
                    // console.warn('解析串流 JSON 錯誤 (可忽略不完整部分):', data, error);
                }
            }
        });
        return content;
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