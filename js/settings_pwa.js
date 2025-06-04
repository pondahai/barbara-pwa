// js/settings_pwa.js

document.addEventListener('DOMContentLoaded', () => {
    // 元素獲取
    const apiUrlInput = document.getElementById('apiUrl');
    const apiKeyInput = document.getElementById('apiKey');
    const fetchModelsButton = document.getElementById('fetchModelsButton');
    const modelSelect = document.getElementById('modelSelect');
    const saveConfigButton = document.getElementById('saveConfigButton');
    const configListDiv = document.getElementById('configList');
    const loadingIndicator = document.getElementById('loadingIndicator');

    // 初始化操作
    loadPwaConfigs(); // 載入已儲存的設定到列表中
    registerServiceWorkerForSettings(); // 註冊 Service Worker

    // 事件監聽器
    if (fetchModelsButton) {
        fetchModelsButton.addEventListener('click', fetchPwaModels);
    }
    if (saveConfigButton) {
        saveConfigButton.addEventListener('click', savePwaConfig);
    }
    if (configListDiv) {
        configListDiv.addEventListener('click', handleConfigListClick);
    }

    // --- Service Worker 註冊 (與 app.js 中的類似，確保設定頁也能觸發) ---
    function registerServiceWorkerForSettings() {
        if ('serviceWorker' in navigator) {
            window.addEventListener('load', () => {
                navigator.serviceWorker.register('/barbara-pwa/sw.js') // 假設 sw.js 在根目錄
                    .then(registration => {
                        console.log('[Settings.js] ServiceWorker registration successful with scope: ', registration.scope);
                    })
                    .catch(error => {
                        console.log('[Settings.js] ServiceWorker registration failed: ', error);
                    });
            });
        }
    }

    // --- PWA 設定管理 (使用 localStorage) ---
    function getStoredPwaConfigs() {
        const configsString = localStorage.getItem('pwa_configs');
        return configsString ? JSON.parse(configsString) : [];
    }

    function saveStoredPwaConfigs(configs) {
        localStorage.setItem('pwa_configs', JSON.stringify(configs));
        // 通知聊天頁面更新設定下拉選單 (如果聊天頁面也打開著，但PWA通常是單頁面)
        // 在PWA中，如果設定和聊天是不同HTML頁面，重新導向或提示用戶刷新聊天頁可能是必要的
        // 或者，如果它們共享某種狀態管理機制（這裡沒有），則可以自動更新。
        // 目前，用戶需要手動切換回聊天頁才能看到更新的下拉選單。
    }

    async function fetchPwaModels() {
        const apiUrl = apiUrlInput ? apiUrlInput.value.trim() : "";
        const apiKey = apiKeyInput ? apiKeyInput.value.trim() : "";

        if (!apiUrl || !apiKey) {
            alert('請填寫 API 網址和金鑰。');
            return;
        }

        try {
            setSettingsInterfaceLoading(true);
            const response = await fetch(`${apiUrl}/v1/models`, {
                method: 'GET', // 通常獲取模型列表是 GET 請求
                headers: {
                    'Authorization': `Bearer ${apiKey}`,
                    'ngrok-skip-browser-warning': 'true' // PWA 通常不需要
                }
            });

            if (!response.ok) {
                const errorData = await response.json().catch(() => ({ message: response.statusText }));
                throw new Error(`無法取得模型列表: ${response.status} ${errorData.message || ''}`);
            }

            const data = await response.json();
            populatePwaModelSelect(data.data || []); // OpenAI API 回應在 data.data 中

        } catch (error) {
            console.error('取得模型列表失敗:', error);
            alert(`取得模型列表失敗: ${error.message}`);
            if (modelSelect) modelSelect.innerHTML = '<option value="">無法載入模型</option>';
        } finally {
            setSettingsInterfaceLoading(false);
        }
    }

    function populatePwaModelSelect(models) {
        if (!modelSelect) return;
        modelSelect.innerHTML = ''; // 清空
        if (!models || models.length === 0) {
            modelSelect.innerHTML = '<option value="">無可用模型</option>';
            return;
        }
        models.forEach(model => {
            if (model && model.id) { // 確保模型對象和 id 存在
                const option = document.createElement('option');
                option.value = model.id;
                option.textContent = model.id;
                modelSelect.appendChild(option);
            }
        });
    }

    function savePwaConfig() {
        const apiUrl = apiUrlInput ? apiUrlInput.value.trim() : "";
        const apiKey = apiKeyInput ? apiKeyInput.value.trim() : "";
        const modelId = modelSelect ? modelSelect.value : "";

        if (!apiUrl || !apiKey) { // 模型 ID 可以為空，讓使用者之後在聊天頁選
            alert('請填寫 API 網址和金鑰。');
            return;
        }
        if (!modelId && modelSelect && modelSelect.options.length > 0 && modelSelect.selectedIndex === -1) {
             alert('請選擇一個模型，或者如果模型列表為空，請先獲取模型。');
             return;
        }
         if (!modelId && (!modelSelect || modelSelect.options.length === 0 || modelSelect.options[0].value === "")){
            // 如果模型列表是空的或者顯示"無法載入模型"等，也允許儲存，但提示用戶
            console.warn("模型 ID 為空，但仍儲存設定。使用者之後需要選擇模型。");
        }


        const newConfig = { apiUrl, apiKey, modelId };
        const configs = getStoredPwaConfigs();

        // 檢查是否已存在相同的 API URL 和 Key (可選，避免完全重複)
        const existingConfigIndex = configs.findIndex(c => c.apiUrl === apiUrl && c.apiKey === apiKey);
        if (existingConfigIndex !== -1) {
            // 更新現有設定的模型 ID (如果模型ID變了)
            if (configs[existingConfigIndex].modelId !== modelId) {
                configs[existingConfigIndex].modelId = modelId;
                alert('偵測到相同的 API 設定，已更新其模型。');
            } else {
                alert('此 API 設定已存在。');
                // return; // 如果不想重複儲存，可以取消註解
            }
        } else {
            configs.push(newConfig);
        }

        saveStoredPwaConfigs(configs);
        loadPwaConfigs(); // 重新載入列表
        alert('設定已儲存！');

        // 清空表單 (可選)
        // apiUrlInput.value = '';
        // apiKeyInput.value = '';
        // if (modelSelect) modelSelect.innerHTML = '';
    }

    function loadPwaConfigs() {
        if (!configListDiv) return;
        const configs = getStoredPwaConfigs();
        configListDiv.innerHTML = ''; // 清空

        if (configs.length === 0) {
            configListDiv.innerHTML = '<p>尚無已儲存的設定。</p>';
            return;
        }

        configs.forEach((config, index) => {
            const itemDiv = document.createElement('div');
            itemDiv.className = 'config-item';
            itemDiv.dataset.index = index; // 用於點擊載入和刪除

            const detailsSpan = document.createElement('span');
            detailsSpan.className = 'config-item-details';
            detailsSpan.textContent = `${config.apiUrl} - ${config.modelId || '(未選擇模型)'}`;
            detailsSpan.title = "點擊以載入此設定";

            const deleteButton = document.createElement('button');
            deleteButton.className = 'delete-config-btn';
            deleteButton.textContent = 'X';
            deleteButton.title = '刪除此設定';
            // deleteButton.dataset.index = index; // 另一種傳遞索引的方式

            itemDiv.appendChild(detailsSpan);
            itemDiv.appendChild(deleteButton);
            configListDiv.appendChild(itemDiv);
        });
    }

    function handleConfigListClick(event) {
        const target = event.target;
        const configItemDiv = target.closest('.config-item');
        if (!configItemDiv) return;

        const index = parseInt(configItemDiv.dataset.index, 10);
        const configs = getStoredPwaConfigs();

        if (target.classList.contains('delete-config-btn')) {
            // 刪除設定
            if (confirm(`確定要刪除設定 "${configs[index].apiUrl} - ${configs[index].modelId || ''}" 嗎？`)) {
                configs.splice(index, 1);
                saveStoredPwaConfigs(configs);
                loadPwaConfigs(); // 重新載入列表
                 // 如果刪除的是聊天頁面當前選擇的設定，需要更新聊天頁面的 selectedConfigIndex
                const chatPageSelectedConfigIndex = localStorage.getItem('pwa_selectedConfigIndex');
                if (chatPageSelectedConfigIndex && parseInt(chatPageSelectedConfigIndex, 10) === index) {
                    localStorage.setItem('pwa_selectedConfigIndex', '0'); // 重置為第一個，或提示用戶重新選擇
                } else if (chatPageSelectedConfigIndex && parseInt(chatPageSelectedConfigIndex, 10) > index) {
                    localStorage.setItem('pwa_selectedConfigIndex', (parseInt(chatPageSelectedConfigIndex, 10) - 1).toString()); // 調整索引
                }
            }
        } else if (target.classList.contains('config-item-details') || target === configItemDiv) {
            // 載入設定到表單
            if (index >= 0 && index < configs.length) {
                const selected = configs[index];
                if (apiUrlInput) apiUrlInput.value = selected.apiUrl;
                if (apiKeyInput) apiKeyInput.value = selected.apiKey;

                // 載入模型列表並選中已儲存的模型
                if (modelSelect) {
                    modelSelect.innerHTML = ''; // 清空舊的選項
                    if (selected.modelId) {
                        // 先添加已儲存的模型作為一個選項，並設為選中
                        const defaultOption = document.createElement('option');
                        defaultOption.value = selected.modelId;
                        defaultOption.textContent = selected.modelId;
                        defaultOption.selected = true;
                        modelSelect.appendChild(defaultOption);
                        // 然後嘗試獲取完整的模型列表，如果成功會覆蓋
                        fetchPwaModels().then(() => {
                            // fetchPwaModels 會填充 select，如果裡面有相同的 modelId，瀏覽器會自動選中
                            // 如果 fetchPwaModels 後，原來的 modelId 不存在了，則會是列表的第一個被選中
                            // 這裡可以再做一次檢查，確保選中的還是原來的 modelId (如果它還在列表中的話)
                            const stillExists = Array.from(modelSelect.options).some(opt => opt.value === selected.modelId);
                            if (stillExists) {
                                modelSelect.value = selected.modelId;
                            } else if (modelSelect.options.length > 0) {
                                // modelSelect.selectedIndex = 0; // 如果原模型不在了，選第一個
                            }
                        });
                    } else {
                        // 如果沒有儲存 modelId，就正常獲取模型列表
                        fetchPwaModels();
                    }
                }
            }
        }
    }

    function setSettingsInterfaceLoading(isLoading) {
        const elementsToDisable = [
            apiUrlInput, apiKeyInput, fetchModelsButton,
            modelSelect, saveConfigButton, configListDiv
        ];
        if (loadingIndicator) {
            loadingIndicator.classList.toggle('show', isLoading);
        }
        elementsToDisable.forEach(element => {
            if (element) {
                element.disabled = isLoading;
                element.classList.toggle('loading', isLoading);
            }
        });
    }

});