// 「所以呢？」— 對話式知識內化（PWA 版）
//
// 從擴充功能的 sowhat.js 移植。與聊天最大的不同：這是多輪對話，而且模型必須回傳 JSON。
// 因此它不走 runAgentStreamLoop（那條路會強制注入 tool-use system prompt 並掛上所有工具），
// 改用本檔的 soWhatRunSingleTurn：無工具、非串流、system prompt 由 so-what-prompt.md 載入。
//
// 行為定義全部在 so-what-prompt.md，改追問策略請改那個檔案，不要動這裡。
//
// 與擴充版的差異：
//   1. 儲存改用 localStorage（擴充是 chrome.storage.local）。保留 async 介面，流程邏輯不動。
//   2. 沒有當前分頁，所以沒有 pageTitle / pageUrl，來源只記 kind: 'self'。
//   3. 入口從右鍵選單改成畫面上的按鈕：輸入框有字就用輸入框，沒字就讀剪貼簿。
//   4. app.js 的內部函式包在 DOMContentLoaded 閉包裡，這裡透過 window.BarbaraApp 取用。

(function () {
    'use strict';

    const app = () => window.BarbaraApp || {};

    // ---------------------------------------------------------------------------
    // 狀態
    // ---------------------------------------------------------------------------

    const SOWHAT_SESSION_KEY = 'pwa_soWhatSession';
    const SOWHAT_CARDS_KEY = 'pwa_soWhatCards';
    const SOWHAT_SESSION_TTL_MS = 24 * 60 * 60 * 1000;

    // 第一輪的五個方向由程式端固定給，不花一次 API 呼叫，也保證選項不會被模型改寫。
    const SOWHAT_DIRECTIONS = [
        { id: 'overturn', label: '這推翻了我原本的想法' },
        { id: 'applicable', label: '這是一個我可以用的做法' },
        { id: 'unclear', label: '這裡我沒看懂，幫我拆' },
        { id: 'doubt', label: '我懷疑這是錯的' },
        { id: 'unknown', label: '不知道，你問我' }
    ];

    // 收尾輪數上限。見 so-what-prompt.md「收尾判準」：正常情況應該更早收，
    // 這只是防止模型原地打轉的下限。
    const SOWHAT_MAX_TURNS = 4;

    let soWhatSession = null;
    let soWhatThreadEl = null;

    function soWhatNewSession(text) {
        return {
            active: true,
            selectedText: text,
            pageTitle: '',
            pageUrl: '',
            direction: null,
            turnCount: 0,
            messages: [],   // 送給模型的 user/assistant 往返（不含 system）
            uiLog: []       // 重畫用：{kind:'intro'|'user'|'ask'|'close'|'think'|'raw', ...}
        };
    }

    async function soWhatSaveSession() {
        if (!soWhatSession) return;
        soWhatSession.updatedAt = Date.now();
        try {
            localStorage.setItem(SOWHAT_SESSION_KEY, JSON.stringify(soWhatSession));
        } catch (error) {
            console.error('[所以呢？] 寫入 session 失敗:', error);
        }
    }

    async function soWhatLoadSession() {
        try {
            const raw = localStorage.getItem(SOWHAT_SESSION_KEY);
            return raw ? JSON.parse(raw) : null;
        } catch (error) {
            return null;
        }
    }

    async function soWhatClearSession() {
        soWhatSession = null;
        localStorage.removeItem(SOWHAT_SESSION_KEY);
    }

    // ---------------------------------------------------------------------------
    // 提示詞載入
    // ---------------------------------------------------------------------------

    let soWhatPromptTemplateCache = null;

    // so-what-prompt.md 前半是給人看的說明，真正要送給模型的是 `## SYSTEM PROMPT`
    // 之後的全部內容（含回傳格式與對話狀態兩節）。
    async function soWhatLoadPromptTemplate() {
        if (soWhatPromptTemplateCache) return soWhatPromptTemplateCache;
        const response = await fetch('./so-what-prompt.md');
        if (!response.ok) {
            throw new Error(`無法載入 so-what-prompt.md (${response.status})`);
        }
        const raw = await response.text();
        const marker = raw.indexOf('## SYSTEM PROMPT');
        soWhatPromptTemplateCache = marker === -1 ? raw : raw.slice(marker);
        return soWhatPromptTemplateCache;
    }

    function soWhatRenderPrompt(template, session) {
        const getLanguageName = app().getLanguageName;
        const language = typeof getLanguageName === 'function'
            ? getLanguageName(navigator.language || 'zh-TW')
            : (navigator.language || 'zh-TW');
        return template
            .replace(/\{\{SELECTED_TEXT\}\}/g, session.selectedText)
            .replace(/\{\{PAGE_TITLE\}\}/g, session.pageTitle || '(無標題)')
            .replace(/\{\{PAGE_URL\}\}/g, session.pageUrl || '(無網址)')
            .replace(/\{\{DIRECTION\}\}/g, session.direction === null ? 'null' : session.direction)
            .replace(/\{\{TURN_COUNT\}\}/g, String(session.turnCount))
            .replace(/\{\{REPLY_LANGUAGE\}\}/g, language);
    }

    // ---------------------------------------------------------------------------
    // 單輪呼叫：無工具、非串流
    // ---------------------------------------------------------------------------

    // 刻意不共用 runAgentStreamLoop：
    //   1. 那個 loop 會硬插一段「你有工具，請使用工具」的 system prompt，會蓋掉角色設定。
    //   2. 它無條件掛上 ToolRegistry 全部工具並設 tool_choice:"auto"，本機小模型很容易
    //      改去呼叫工具而不是回 JSON。
    //   3. 回應只有三句話 + 選項，不需要串流。
    async function soWhatRunSingleTurn(config, messages) {
        const response = await fetch(`${config.apiUrl}/chat/completions`, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'Authorization': `Bearer ${config.apiKey}`
            },
            body: JSON.stringify({
                model: config.modelId,
                messages: messages,
                stream: false
            })
        });

        if (!response.ok) {
            const errorData = await response.json().catch(() => ({ message: response.statusText }));
            throw new Error(`API 請求失敗: ${response.status} ${errorData.message || ''}`);
        }

        const data = await response.json();
        const message = (data.choices && data.choices[0] && data.choices[0].message) || {};
        let content = message.content || '';

        // 思考過程有兩種來源，都要在解析 JSON 之前剝掉，但要留下來顯示：
        //   a) 獨立欄位（llama.cpp 的 reasoning_content、vLLM 的 reasoning）
        //   b) content 裡的 <think> 等標籤（非串流時會整段留在 content）
        const thinking = [];
        ['reasoning_content', 'reasoning'].forEach(field => {
            if (message[field]) thinking.push(String(message[field]).trim());
        });

        const thinkRegex = /(?:<think>|<\|channel>thought\n?|<thought>)([\s\S]*?)(?:<\/think>|<channel\|>|<\/thought>)/g;
        let match;
        while ((match = thinkRegex.exec(content)) !== null) {
            if (match[1] && match[1].trim()) thinking.push(match[1].trim());
        }
        content = content.replace(thinkRegex, '');

        return { content: content.trim(), thinking: thinking.join('\n\n') };
    }

    // ---------------------------------------------------------------------------
    // 回傳解析
    // ---------------------------------------------------------------------------

    // 先直接 parse，失敗再用括號配對抽取器把 JSON 從閒聊裡挖出來。
    // 兩者都失敗回 null，由呼叫端降級成「顯示原始文字 + 手動收尾」。
    function soWhatParseResponse(text) {
        if (!text) return null;
        let candidate = text.trim();
        // 有些模型還是會包 code fence
        const fenceMatch = candidate.match(/```(?:json)?\s*([\s\S]*?)```/);
        if (fenceMatch) candidate = fenceMatch[1].trim();

        try {
            const parsed = JSON.parse(candidate);
            if (parsed && (parsed.phase === 'ask' || parsed.phase === 'close')) return parsed;
        } catch (error) { /* 往下用抽取器 */ }

        const extractor = app().extractFirstJsonObject;
        const extracted = typeof extractor === 'function' ? extractor(text) : null;
        if (extracted) {
            try {
                const parsed = JSON.parse(extracted);
                if (parsed && (parsed.phase === 'ask' || parsed.phase === 'close')) return parsed;
            } catch (error) { /* 落到 null */ }
        }
        return null;
    }

    // ---------------------------------------------------------------------------
    // 引用句字面驗證
    // ---------------------------------------------------------------------------
    //
    // 模型「抄」字串時會掉字或換成形近字（羅馬混凝土 → 羅馬元紐土）。查核搜錯關鍵字
    // 馬上看得出來，引用抄錯字卻會安靜地留在卡片裡。原文我們手上有完整一份，
    // 所以字面由程式保證，不交給模型。

    function soWhatNormalize(text) {
        // NFKC 收掉全半形差異，再去掉所有空白；同時記錄每個正規化字元對應的原文索引
        const chars = [];
        const indexMap = [];
        for (let i = 0; i < text.length; i++) {
            const normalized = text[i].normalize('NFKC');
            if (/\s/.test(normalized)) continue;
            for (const ch of normalized) {
                chars.push(ch);
                indexMap.push(i);
            }
        }
        return { text: chars.join(''), indexMap: indexMap };
    }

    // 回傳 { quotes: [...], corrections: [{from, to}], dropped: [...] }
    function soWhatVerifyQuotes(quotes, sourceText) {
        const result = { quotes: [], corrections: [], dropped: [] };
        if (!Array.isArray(quotes) || quotes.length === 0) return result;

        const source = soWhatNormalize(sourceText);

        for (const quote of quotes.slice(0, 3)) {
            if (typeof quote !== 'string' || !quote.trim()) continue;
            const q = soWhatNormalize(quote).text;
            if (!q) continue;

            // 情況一：逐字相符（正規化後），直接取原文對應片段，保留原文的空白與標點樣貌
            const exactAt = source.text.indexOf(q);
            if (exactAt !== -1) {
                const start = source.indexMap[exactAt];
                const end = source.indexMap[exactAt + q.length - 1];
                result.quotes.push(sourceText.slice(start, end + 1));
                continue;
            }

            // 情況二：不相符 → 在原文裡找最接近的等長片段。不問模型，純字串比對。
            const best = soWhatFindClosestSpan(q, source);
            if (best && best.score >= 0.6) {
                const start = source.indexMap[best.at];
                const end = source.indexMap[best.at + q.length - 1];
                const corrected = sourceText.slice(start, end + 1);
                result.quotes.push(corrected);
                result.corrections.push({ from: quote, to: corrected });
            } else {
                // 找不到夠像的片段，代表這句話根本不在原文裡 —— 寧可丟掉也不要留假引用
                result.dropped.push(quote);
            }
        }
        return result;
    }

    // 等長滑動視窗的逐位字元比對。錯字多半是等長替換，這個粗糙的分數就夠用，
    // 而且不需要引進編輯距離的實作。
    function soWhatFindClosestSpan(needle, source) {
        const hay = source.text;
        if (needle.length === 0 || hay.length < needle.length) return null;
        // 原文過長時放棄模糊比對（O(n*m)），直接讓呼叫端丟掉該句
        if (hay.length * needle.length > 4000000) return null;

        let best = null;
        for (let i = 0; i + needle.length <= hay.length; i++) {
            let matches = 0;
            for (let j = 0; j < needle.length; j++) {
                if (hay[i + j] === needle[j]) matches++;
            }
            const score = matches / needle.length;
            if (!best || score > best.score) best = { at: i, score: score };
        }
        return best;
    }

    // ---------------------------------------------------------------------------
    // UI
    // ---------------------------------------------------------------------------

    function soWhatConversationList() {
        return document.getElementById('conversationList');
    }

    function soWhatRemovePlaceholder() {
        const list = soWhatConversationList();
        if (!list) return;
        const placeholder = list.querySelector('div[style*="text-align: center"]');
        if (placeholder) placeholder.remove();
    }

    // 整段「所以呢？」對話放在同一個容器裡，而不是散成一堆兄弟節點。這讓兩件事變簡單：
    //   1. 收尾後要整段摺疊，只要把內容搬進一個 <details>。
    //   2. loadConversationsUI 重畫清單時（清空 → 從儲存重建），這段對話不在儲存裡、
    //      會被一起抹掉；有容器就只要把同一個節點接回去，不用從 uiLog 逐則重建。
    function soWhatEnsureThread() {
        const list = soWhatConversationList();
        if (!list) return null;
        if (!soWhatThreadEl) {
            soWhatThreadEl = document.createElement('div');
            soWhatThreadEl.className = 'sowhat-thread';
            soWhatThreadEl.appendChild(soWhatBuildThreadDeleteButton());
        }
        if (soWhatThreadEl.parentElement !== list) list.appendChild(soWhatThreadEl);
        return soWhatThreadEl;
    }

    // 這段對話不在對話儲存裡（只活在 DOM 與 session），所以一般的刪除鈕對它無效。
    // 這裡給整段 thread 一個自己的刪除鈕：移除節點、丟掉未完成的 session。
    function soWhatBuildThreadDeleteButton() {
        const button = document.createElement('button');
        button.className = 'delete-button sowhat-thread-delete';
        button.textContent = 'X';
        button.title = '刪除整段「所以呢？」對話';
        button.onclick = async () => {
            if (!confirm('確定要刪除整段「所以呢？」對話嗎？（已存成的卡片不受影響）')) return;
            await soWhatClearSession();
            if (soWhatThreadEl) soWhatThreadEl.remove();
            soWhatThreadEl = null;
            soWhatSession = null;
        };
        return button;
    }

    // 給 loadConversationsUI 在重畫後呼叫：把這段對話接回清單尾端
    function soWhatReattachThread(list) {
        if (!soWhatThreadEl || !list) return;
        list.appendChild(soWhatThreadEl);
    }

    // 收尾後整段摺起來：過程看得到，但不再佔畫面
    function soWhatCollapseThread(title) {
        const thread = soWhatThreadEl;
        if (!thread || thread.dataset.collapsed === '1') return;
        const details = document.createElement('details');
        details.className = 'sowhat-thread-details';
        const summary = document.createElement('summary');
        summary.textContent = `所以呢？ — ${title}`;
        details.appendChild(summary);
        // 刪除鈕要留在 thread 上（摺疊後仍要看得到、按得到），只搬其他內容進 details
        Array.from(thread.childNodes).forEach(node => {
            if (node.nodeType === Node.ELEMENT_NODE && node.classList.contains('sowhat-thread-delete')) return;
            details.appendChild(node);
        });
        thread.appendChild(details);
        thread.dataset.collapsed = '1';
    }

    function soWhatAppendItem(extraClass) {
        const thread = soWhatEnsureThread();
        if (!thread) return null;
        soWhatRemovePlaceholder();
        const div = document.createElement('div');
        div.className = 'conversation-item sowhat-item' + (extraClass ? ' ' + extraClass : '');
        const content = document.createElement('div');
        content.className = 'conversation-content';
        div.appendChild(content);
        thread.appendChild(div);
        div.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
        return content;
    }

    function soWhatMarkdown(text) {
        return typeof marked !== 'undefined' ? marked.parse(text) : escapeHtmlSafe(text);
    }

    function escapeHtmlSafe(text) {
        const escape = app().escapeHtml;
        if (typeof escape === 'function') return escape(text);
        return String(text === undefined || text === null ? '' : text)
            .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
    }

    // 把目前這一輪的選項鈕畫出來。按過之後整組鈕會被停用，避免使用者回頭亂按舊選項。
    function soWhatRenderOptions(container, options, allowFreeText) {
        const optionBox = document.createElement('div');
        optionBox.className = 'sowhat-options';

        const disableAll = () => {
            optionBox.querySelectorAll('button, input').forEach(el => { el.disabled = true; });
            optionBox.classList.add('answered');
        };

        (options || []).forEach(option => {
            const button = document.createElement('button');
            button.className = 'sowhat-option';
            if (option.id === 'done' || option.id === 'save') button.classList.add('sowhat-option-exit');
            button.textContent = option.label;
            button.onclick = () => {
                disableAll();
                soWhatHandleChoice(option);
            };
            optionBox.appendChild(button);
        });

        if (allowFreeText) {
            const row = document.createElement('div');
            row.className = 'sowhat-freetext';
            const input = document.createElement('input');
            input.type = 'text';
            input.placeholder = '或直接打字回答…';
            const send = document.createElement('button');
            send.className = 'sowhat-option';
            send.textContent = '送出';
            const submit = () => {
                const value = input.value.trim();
                if (!value) return;
                input.value = ''; // 清空，否則殘值會留在畫面上看起來像訊息重複了一次
                disableAll();
                soWhatHandleChoice({ id: 'freetext', label: value });
            };
            send.onclick = submit;
            input.addEventListener('keydown', (event) => {
                if (event.key === 'Enter') submit();
            });
            row.appendChild(input);
            row.appendChild(send);
            optionBox.appendChild(row);
        }

        container.appendChild(optionBox);
    }

    function soWhatRenderIntro(session) {
        const content = soWhatAppendItem('sowhat-intro');
        if (!content) return;
        const quoted = document.createElement('blockquote');
        quoted.className = 'sowhat-source';
        quoted.textContent = session.selectedText.length > 300
            ? session.selectedText.slice(0, 300) + '…'
            : session.selectedText;
        content.appendChild(quoted);

        const source = document.createElement('div');
        source.className = 'sowhat-source-meta';
        source.textContent = session.pageTitle ? `所以呢？ — ${session.pageTitle}` : '所以呢？';
        content.appendChild(source);
    }

    // 沿用既有的 .thinking-process / <details> 樣式，跟聊天的思考區塊長一樣
    function soWhatRenderThinking(text) {
        const content = soWhatAppendItem('assistant-message thinking-process');
        if (!content) return;
        const details = document.createElement('details');
        const summary = document.createElement('summary');
        summary.textContent = '顯示/隱藏 AI 思考過程';
        details.appendChild(summary);
        const inner = document.createElement('div');
        inner.className = 'thinking-content-inner';
        inner.innerHTML = soWhatMarkdown(text);
        details.appendChild(inner);
        content.appendChild(details);
    }

    function soWhatRenderUserChoice(label) {
        const content = soWhatAppendItem('user-message');
        if (!content) return;
        content.textContent = label;
    }

    function soWhatRenderAsk(payload, isReplay) {
        const content = soWhatAppendItem('assistant-message');
        if (!content) return;
        const message = document.createElement('div');
        message.textContent = payload.message || '';
        content.appendChild(message);

        if (isReplay) return; // 重畫歷史時不要讓舊選項可以再按

        const options = Array.isArray(payload.options) ? payload.options.slice() : [];
        // 約束：每一輪都要有出口。模型忘了給就由程式補上。
        if (!options.some(option => option.id === 'done')) {
            options.push({ id: 'done', label: '夠了，直接收尾' });
        }
        soWhatRenderOptions(content, options, true);
    }

    function soWhatRenderClose(payload, isReplay) {
        const content = soWhatAppendItem('assistant-message sowhat-close');
        if (!content) return;

        const title = document.createElement('div');
        title.className = 'sowhat-title';
        title.textContent = payload.title || '(未命名)';
        content.appendChild(title);

        const takeaway = document.createElement('div');
        takeaway.className = 'sowhat-takeaway';
        takeaway.textContent = payload.final_takeaway || '';
        content.appendChild(takeaway);

        if (Array.isArray(payload.evidence_quotes) && payload.evidence_quotes.length > 0) {
            const quotes = document.createElement('div');
            quotes.className = 'sowhat-quotes';
            payload.evidence_quotes.forEach(quote => {
                const line = document.createElement('blockquote');
                line.className = 'sowhat-source';
                line.textContent = quote;
                quotes.appendChild(line);
            });
            content.appendChild(quotes);
        }

        // 程式改過引用句時要讓使用者看得到發生過什麼
        if (payload._quoteCorrections && payload._quoteCorrections.length > 0) {
            payload._quoteCorrections.forEach(correction => {
                const note = document.createElement('div');
                note.className = 'sowhat-note';
                note.textContent = `已修正引用（模型抄寫失真）：${correction.from} → ${correction.to}`;
                content.appendChild(note);
            });
        }
        if (payload._quotesDropped && payload._quotesDropped.length > 0) {
            const note = document.createElement('div');
            note.className = 'sowhat-note';
            note.textContent = `已捨棄 ${payload._quotesDropped.length} 句在原文中找不到的引用。`;
            content.appendChild(note);
        }

        if (Array.isArray(payload.open_questions) && payload.open_questions.length > 0) {
            const questions = document.createElement('ul');
            questions.className = 'sowhat-open-questions';
            payload.open_questions.forEach(question => {
                const item = document.createElement('li');
                item.textContent = question;
                questions.appendChild(item);
            });
            content.appendChild(questions);
        }

        if (Array.isArray(payload.tags) && payload.tags.length > 0) {
            const tags = document.createElement('div');
            tags.className = 'sowhat-tags';
            tags.textContent = payload.tags.map(tag => `#${tag}`).join('  ');
            content.appendChild(tags);
        }

        if (isReplay) return;

        let options = Array.isArray(payload.options) ? payload.options.slice() : [];
        if (options.length === 0) {
            options = [
                { id: 'save', label: '就這樣，存起來' },
                { id: 'edit', label: '我改一下' },
                { id: 'more', label: '再問我一輪' }
            ];
        }
        soWhatRenderOptions(content, options, false);
    }

    // JSON 解析失敗的降級路徑：不要讓一次格式錯誤把整段對話炸掉
    function soWhatRenderRaw(rawText, isReplay) {
        const content = soWhatAppendItem('assistant-message sowhat-raw');
        if (!content) return;

        const note = document.createElement('div');
        note.className = 'sowhat-note';
        note.textContent = '模型這一輪沒有回出可解析的格式，以下為原始輸出：';
        content.appendChild(note);

        const pre = document.createElement('pre');
        pre.className = 'sowhat-raw-text';
        pre.textContent = rawText;
        content.appendChild(pre);

        if (isReplay) return;

        soWhatRenderOptions(content, [
            { id: 'retry', label: '再試一次' },
            { id: 'done', label: '夠了，我自己收尾' }
        ], false);
    }

    // 「我改一下」：把 takeaway 變成可編輯的文字框
    function soWhatRenderEdit(payload) {
        const content = soWhatAppendItem('assistant-message sowhat-edit');
        if (!content) return;

        const label = document.createElement('div');
        label.className = 'sowhat-note';
        label.textContent = '改成你自己的話：';
        content.appendChild(label);

        const textarea = document.createElement('textarea');
        textarea.className = 'sowhat-edit-input';
        textarea.value = payload.final_takeaway || '';
        content.appendChild(textarea);

        const confirmButton = document.createElement('button');
        confirmButton.className = 'sowhat-option sowhat-option-exit';
        confirmButton.textContent = '確認，存起來';
        confirmButton.onclick = () => {
            confirmButton.disabled = true;
            textarea.disabled = true;
            const edited = Object.assign({}, payload, { final_takeaway: textarea.value.trim() });
            soWhatFinish(edited);
        };
        content.appendChild(confirmButton);
    }

    // ---------------------------------------------------------------------------
    // 流程
    // ---------------------------------------------------------------------------

    // 入口：輸入框有字就用輸入框的字，沒字就讀剪貼簿
    async function soWhatStart() {
        const config = app().getSelectedConfig ? app().getSelectedConfig() : null;
        if (!config || !config.apiUrl || !config.modelId) {
            alert('請先完整設定 API (網址、金鑰、模型)。');
            return;
        }

        const inputEl = document.getElementById('userInput');
        let text = inputEl ? inputEl.value.trim() : '';
        if (text) {
            if (inputEl) inputEl.value = '';
        } else if (navigator.clipboard && navigator.clipboard.readText) {
            try {
                text = (await navigator.clipboard.readText()).trim();
            } catch (error) {
                alert('無法讀取剪貼簿，請把想討論的文字直接貼進輸入框再按「所以呢？」。');
                return;
            }
        }
        if (!text) {
            alert('請先把想討論的文字貼進輸入框，或複製到剪貼簿。');
            return;
        }

        await soWhatFromText(text);
    }

    async function soWhatFromText(text) {
        soWhatThreadEl = null; // 每次新對話都用全新的容器，不要接在上一段後面
        soWhatSession = soWhatNewSession(text);
        soWhatSession.uiLog.push({ kind: 'intro' });
        await soWhatSaveSession();

        soWhatRenderIntro(soWhatSession);

        // 第一輪固定由程式端出五個方向，不呼叫模型
        const content = soWhatAppendItem('assistant-message');
        if (content) {
            const message = document.createElement('div');
            message.textContent = '這段東西對你來說是哪一種？';
            content.appendChild(message);
            soWhatRenderOptions(content, SOWHAT_DIRECTIONS.concat([{ id: 'done', label: '夠了，直接收尾' }]), false);
        }
        const firstAsk = { phase: 'ask', message: '這段東西對你來說是哪一種？', options: SOWHAT_DIRECTIONS };
        soWhatSession.uiLog.push({ kind: 'ask', payload: firstAsk });
        // 第一輪雖然是程式端畫的，仍要寫進對話歷史。少了這一則，模型收到的第一句使用者
        // 發言（例如「不知道，你問我」）前面沒有任何它自己問過的話，很容易在後面幾輪
        // 重複問同一件事。
        soWhatSession.messages.push({ role: 'assistant', content: JSON.stringify(firstAsk) });
        await soWhatSaveSession();
    }

    async function soWhatHandleChoice(option) {
        if (!soWhatSession) return;

        // 收尾階段的三個選項
        if (option.id === 'save') {
            await soWhatFinish(soWhatLastClosePayload());
            return;
        }
        if (option.id === 'edit') {
            soWhatRenderEdit(soWhatLastClosePayload() || {});
            return;
        }

        soWhatRenderUserChoice(option.label);
        soWhatSession.uiLog.push({ kind: 'user', label: option.label });

        // 第一輪點的是方向
        if (soWhatSession.direction === null && SOWHAT_DIRECTIONS.some(d => d.id === option.id)) {
            soWhatSession.direction = option.id;
        }

        let userContent;
        if (option.id === 'done') {
            userContent = '夠了，不用再問了。請用目前已有的內容直接收尾，回傳 phase: "close"。';
        } else if (option.id === 'more') {
            userContent = '再問我一輪。';
        } else if (option.id === 'retry') {
            userContent = '你上一則回應不是合法的 JSON。請只回傳單一 JSON 物件，不要包在 code block 裡，也不要加任何說明文字。';
        } else {
            userContent = option.label;
        }

        soWhatSession.turnCount += 1;

        // 提示詞寫了「第四輪仍在談文本就直接收尾」，但小模型不會自己數輪數，
        // 所以由程式端補一句明確指令。這是收尾判準的下限，不是取代它——
        // 使用者只要講出一句關於自己的話，模型本來就應該提早收。
        if (soWhatSession.turnCount >= SOWHAT_MAX_TURNS && option.id !== 'done' && option.id !== 'more') {
            userContent += `\n\n（系統提示：已進行第 ${soWhatSession.turnCount} 輪，請依規則直接收尾，回傳 phase: "close"，不要再追問。若使用者始終只在談文本、沒有談自己，cognitive_shift 設為 false。）`;
        }

        soWhatSession.messages.push({ role: 'user', content: userContent });
        await soWhatSaveSession();

        await soWhatRequestTurn();
    }

    function soWhatLastClosePayload() {
        if (!soWhatSession) return null;
        for (let i = soWhatSession.uiLog.length - 1; i >= 0; i--) {
            if (soWhatSession.uiLog[i].kind === 'close') return soWhatSession.uiLog[i].payload;
        }
        return null;
    }

    async function soWhatRequestTurn() {
        const setLoading = app().setInterfaceLoading;
        if (typeof setLoading === 'function') setLoading(true);
        try {
            const config = app().getSelectedConfig();
            const template = await soWhatLoadPromptTemplate();
            const systemPrompt = soWhatRenderPrompt(template, soWhatSession);
            const messages = [{ role: 'system', content: systemPrompt }].concat(soWhatSession.messages);

            const turn = await soWhatRunSingleTurn(config, messages);
            soWhatSession.messages.push({ role: 'assistant', content: turn.content });

            if (turn.thinking) {
                soWhatSession.uiLog.push({ kind: 'think', text: turn.thinking });
                soWhatRenderThinking(turn.thinking);
            }

            const parsed = soWhatParseResponse(turn.content);
            if (!parsed) {
                soWhatSession.uiLog.push({ kind: 'raw', text: turn.content });
                await soWhatSaveSession();
                soWhatRenderRaw(turn.content, false);
                return;
            }

            if (parsed.phase === 'close') {
                // 引用句在顯示之前先過字面驗證
                const verified = soWhatVerifyQuotes(parsed.evidence_quotes, soWhatSession.selectedText);
                parsed.evidence_quotes = verified.quotes;
                parsed._quoteCorrections = verified.corrections;
                parsed._quotesDropped = verified.dropped;
                soWhatSession.uiLog.push({ kind: 'close', payload: parsed });
                await soWhatSaveSession();
                soWhatRenderClose(parsed, false);
            } else {
                soWhatSession.uiLog.push({ kind: 'ask', payload: parsed });
                await soWhatSaveSession();
                soWhatRenderAsk(parsed, false);
            }
        } catch (error) {
            console.error('[所以呢？] 這一輪失敗:', error);
            soWhatSession.uiLog.push({ kind: 'raw', text: `錯誤: ${error.message}` });
            await soWhatSaveSession();
            soWhatRenderRaw(`錯誤: ${error.message}`, false);
        } finally {
            if (typeof setLoading === 'function') setLoading(false);
        }
    }

    // 收尾只寫進卡片資料表，不自動塞進聊天記錄——要讓模型看到某張卡片時，
    // 再從資料表用「插入對話歷史」明確放進去。這樣卡片不會無限累積在每次發問的
    // 上下文裡，「插入」這個動作也才有意義。
    async function soWhatFinish(payload) {
        const card = await soWhatBuildCard(payload || {}, soWhatSession);
        await soWhatAddCard(card);

        // 先摺疊，再加提示——提示要留在摺疊區塊外面才看得到
        soWhatCollapseThread(card.title);

        const done = soWhatAppendItem('assistant-message sowhat-saved');
        if (done) {
            const note = document.createElement('div');
            note.className = 'sowhat-note';
            note.textContent = `已存成卡片：${card.title}`;
            done.appendChild(note);
            const open = document.createElement('button');
            open.className = 'sowhat-option';
            open.textContent = '打開卡片資料表';
            open.onclick = () => soWhatOpenCardTable();
            done.appendChild(open);
        }

        await soWhatClearSession();
    }

    // ---------------------------------------------------------------------------
    // 重載後接回未完成的對話
    // ---------------------------------------------------------------------------

    async function soWhatRestoreIfAny() {
        const saved = await soWhatLoadSession();
        if (!saved || !saved.active) return;

        // 沒收尾就關掉頁面的 session 會一直留在儲存裡。沒有這道過期檢查，
        // 它會在之後每一次開啟時被重畫出來，變成永遠清不掉的殘影。
        if (!saved.updatedAt || Date.now() - saved.updatedAt > SOWHAT_SESSION_TTL_MS) {
            console.log('[所以呢？] 捨棄過期的未完成對話');
            await soWhatClearSession();
            return;
        }

        soWhatSession = saved;
        soWhatThreadEl = null;

        for (let i = 0; i < saved.uiLog.length; i++) {
            const entry = saved.uiLog[i];
            const isLast = i === saved.uiLog.length - 1;
            if (entry.kind === 'intro') {
                soWhatRenderIntro(saved);
            } else if (entry.kind === 'user') {
                soWhatRenderUserChoice(entry.label);
            } else if (entry.kind === 'ask') {
                soWhatRenderAsk(entry.payload, !isLast);
            } else if (entry.kind === 'close') {
                soWhatRenderClose(entry.payload, !isLast);
            } else if (entry.kind === 'think') {
                soWhatRenderThinking(entry.text);
            } else if (entry.kind === 'raw') {
                soWhatRenderRaw(entry.text, !isLast);
            }
        }
    }

    // ---------------------------------------------------------------------------
    // 卡片資料表
    // ---------------------------------------------------------------------------
    //
    // 卡片的 id 與 sources 結構定下來就別再改，其他欄位可以之後再長。所以即使目前
    // 用不到的欄位（thread_id、initial_intent）也先留著位置，不要之後再回頭改結構。

    async function soWhatLoadCards() {
        try {
            const raw = localStorage.getItem(SOWHAT_CARDS_KEY);
            return raw ? JSON.parse(raw) : [];
        } catch (error) {
            return [];
        }
    }

    async function soWhatSaveCards(cards) {
        localStorage.setItem(SOWHAT_CARDS_KEY, JSON.stringify(cards));
    }

    async function soWhatAddCard(card) {
        const cards = await soWhatLoadCards();
        cards.push(card);
        await soWhatSaveCards(cards);
        return card;
    }

    async function soWhatDeleteCards(ids) {
        const cards = await soWhatLoadCards();
        const kept = cards.filter(card => ids.indexOf(card.id) === -1);
        await soWhatSaveCards(kept);
        return cards.length - kept.length;
    }

    // card_YYYYMMDD_xxxx
    function soWhatMakeCardId(date) {
        const pad = (n) => String(n).padStart(2, '0');
        const stamp = `${date.getFullYear()}${pad(date.getMonth() + 1)}${pad(date.getDate())}`;
        const rand = Array.from(crypto.getRandomValues(new Uint8Array(2)))
            .map(b => b.toString(16).padStart(2, '0')).join('');
        return `card_${stamp}_${rand}`;
    }

    // 帶時區的 ISO 字串（toISOString() 會轉成 UTC，看卡片時容易誤判日期）
    function soWhatLocalIso(date) {
        const pad = (n) => String(n).padStart(2, '0');
        const offset = -date.getTimezoneOffset();
        const sign = offset >= 0 ? '+' : '-';
        const abs = Math.abs(offset);
        return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}` +
            `T${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}` +
            `${sign}${pad(Math.floor(abs / 60))}:${pad(abs % 60)}`;
    }

    // 只雜湊「引用到的證據句」，不要雜湊整段來源——每次抓到的雜訊都不同，
    // 雜湊整段會天天誤報「來源已變更」。
    async function soWhatHashEvidence(quotes) {
        if (!Array.isArray(quotes) || quotes.length === 0) return null;
        if (!crypto.subtle) return null; // 非安全來源時沒有 SubtleCrypto
        const data = new TextEncoder().encode(quotes.join('\n'));
        const digest = await crypto.subtle.digest('SHA-256', data);
        const hex = Array.from(new Uint8Array(digest))
            .map(b => b.toString(16).padStart(2, '0')).join('');
        return `sha256:${hex}`;
    }

    async function soWhatBuildCard(payload, session) {
        const now = new Date();
        const quotes = Array.isArray(payload.evidence_quotes) ? payload.evidence_quotes : [];

        const sources = [];
        if (session && session.pageUrl) {
            sources.push({
                kind: 'webpage',
                url: session.pageUrl,
                site_title: session.pageTitle || '',
                captured_at: soWhatLocalIso(now),
                evidence_hash: await soWhatHashEvidence(quotes)
            });
        }
        // PWA 沒有當前分頁，文字是使用者自己給的，所以 sources 只留 kind: self
        sources.push({ kind: 'self', via: '對話式知識內化' });

        return {
            id: soWhatMakeCardId(now),
            type: 'internalization',
            created_at: soWhatLocalIso(now),
            title: payload.title || '(未命名)',
            sources: sources,
            direction: session ? session.direction : null,
            initial_intent: null,   // 一開始說不出來時為 null；目前沒有單獨收集這欄
            final_takeaway: payload.final_takeaway || '',
            cognitive_shift: !!payload.cognitive_shift,
            evidence_quotes: quotes,
            open_questions: Array.isArray(payload.open_questions) ? payload.open_questions : [],
            thread_id: null,        // 訊息本體放另一個 store，目前不存
            insight_summary: payload.insight_summary || '',
            tags: Array.isArray(payload.tags) ? payload.tags : []
        };
    }

    // 插入對話歷史時的內容：標題 + 結論 + 來源網址
    function soWhatCardToMessage(card) {
        const lines = [`**${card.title}**`];
        if (card.final_takeaway) lines.push('', card.final_takeaway);
        const webpage = (card.sources || []).find(source => source.kind === 'webpage');
        if (webpage && webpage.url) lines.push('', `來源：${webpage.url}`);
        return lines.join('\n');
    }

    async function soWhatOpenCardTable() {
        const existing = document.getElementById('soWhatCardOverlay');
        if (existing) existing.remove();

        const cards = await soWhatLoadCards();

        const overlay = document.createElement('div');
        overlay.id = 'soWhatCardOverlay';
        overlay.className = 'sowhat-overlay';

        const panel = document.createElement('div');
        panel.className = 'sowhat-card-panel';

        const header = document.createElement('div');
        header.className = 'sowhat-card-header';
        const heading = document.createElement('strong');
        heading.textContent = `卡片資料表（${cards.length}）`;
        const closeButton = document.createElement('button');
        closeButton.className = 'sowhat-option';
        closeButton.textContent = '關閉';
        closeButton.onclick = () => overlay.remove();
        header.appendChild(heading);
        header.appendChild(closeButton);
        panel.appendChild(header);

        const list = document.createElement('div');
        list.className = 'sowhat-card-list';

        if (cards.length === 0) {
            const empty = document.createElement('div');
            empty.className = 'sowhat-note';
            empty.textContent = '還沒有卡片。把一段文字貼進輸入框後按「所以呢？」，完成一次對話並按「存起來」就會出現在這裡。';
            list.appendChild(empty);
        } else {
            // 新的排前面
            cards.slice().reverse().forEach(card => {
                const row = document.createElement('label');
                row.className = 'sowhat-card-row';

                const checkbox = document.createElement('input');
                checkbox.type = 'checkbox';
                checkbox.value = card.id;
                checkbox.className = 'sowhat-card-check';
                row.appendChild(checkbox);

                const body = document.createElement('div');
                body.className = 'sowhat-card-body';

                const title = document.createElement('div');
                title.className = 'sowhat-card-title';
                title.textContent = card.title;
                body.appendChild(title);

                const meta = document.createElement('div');
                meta.className = 'sowhat-card-meta';
                const parts = [(card.created_at || '').slice(0, 10)];
                if (card.cognitive_shift) parts.push('認知有改變');
                if (card.tags && card.tags.length) parts.push(card.tags.map(t => `#${t}`).join(' '));
                meta.textContent = parts.join('　');
                body.appendChild(meta);

                row.appendChild(body);
                list.appendChild(row);
            });
        }
        panel.appendChild(list);

        const actions = document.createElement('div');
        actions.className = 'sowhat-card-actions';

        const selectedIds = () => Array.from(panel.querySelectorAll('.sowhat-card-check:checked')).map(c => c.value);

        const insert = document.createElement('button');
        insert.className = 'sowhat-option';
        insert.textContent = '插入對話歷史';
        insert.onclick = async () => {
            const ids = selectedIds();
            if (ids.length === 0) { alert('請先勾選要插入的卡片。'); return; }
            const config = app().getSelectedConfig ? app().getSelectedConfig() : null;
            if (!config || !config.apiUrl || !config.modelId) {
                alert('請先完整設定 API (網址、金鑰、模型)。');
                return;
            }
            const all = await soWhatLoadCards();
            ids.forEach(id => {
                const card = all.find(c => c.id === id);
                if (card) {
                    app().addConversationToStorage({ role: 'assistant', content: soWhatCardToMessage(card) });
                }
            });
            overlay.remove();
            app().loadConversationsUI(); // 重畫，讓插入的卡片立刻出現
        };

        const remove = document.createElement('button');
        remove.className = 'sowhat-option sowhat-option-exit';
        remove.textContent = '刪除';
        remove.onclick = async () => {
            const ids = selectedIds();
            if (ids.length === 0) { alert('請先勾選要刪除的卡片。'); return; }
            if (!confirm(`確定要刪除 ${ids.length} 張卡片嗎？此動作無法復原。`)) return;
            await soWhatDeleteCards(ids);
            soWhatOpenCardTable(); // 重開以刷新清單
        };

        actions.appendChild(insert);
        actions.appendChild(remove);
        panel.appendChild(actions);

        overlay.appendChild(panel);
        // 點擊面板外面關閉
        overlay.addEventListener('click', (event) => {
            if (event.target === overlay) overlay.remove();
        });
        document.body.appendChild(overlay);
    }

    // ---------------------------------------------------------------------------
    // 對外接口（app.js 與按鈕使用）
    // ---------------------------------------------------------------------------

    window.SoWhat = {
        start: soWhatStart,
        fromText: soWhatFromText,
        openCardTable: soWhatOpenCardTable,
        restoreIfAny: soWhatRestoreIfAny,
        reattachThread: soWhatReattachThread,
        // 給測試用：純函式，不碰 DOM
        _verifyQuotes: soWhatVerifyQuotes,
        _parseResponse: soWhatParseResponse,
        _buildCard: soWhatBuildCard,
        _loadCards: soWhatLoadCards
    };
})();
