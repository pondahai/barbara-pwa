// sw.js

const CACHE_NAME = 'barbara-pwa-v1'; // 快取名稱，版本更新時可以修改此名稱以觸發更新
const urlsToCache = [
  // HTML 檔案
  '/barbara-pwa/', // 通常是 index.html 的別名，取決於伺服器設定
  '/barbara-pwa/index.html',
  '/barbara-pwa/settings.html',

  // CSS 檔案 (假設我們之後會將 CSS 提取到 style.css)
  // 如果您現在還沒有 style.css，可以暫時註解掉或之後添加
  '/barbara-pwa/css/style.css',

  // JavaScript 檔案
  '/barbara-pwa/js/marked.min.js',
  '/barbara-pwa/js/app.js',         // 之後會建立的 PWA 主要邏輯檔案
  '/barbara-pwa/js/settings_pwa.js',// 之後會建立的 PWA 設定頁邏輯檔案

  // 圖片資源 (確保路徑與 manifest 及 HTML 中的一致)
  '/barbara-pwa/images/icon-48.png',
  '/barbara-pwa/images/icon-72.png',
  '/barbara-pwa/images/icon-96.png',
  '/barbara-pwa/images/icon-128.png',
  '/barbara-pwa/images/icon-144.png',
  '/barbara-pwa/images/icon-152.png',
  '/barbara-pwa/images/icon-192.png',
  '/barbara-pwa/images/icon-384.png',
  '/barbara-pwa/images/icon-512.png',
  // 如果您擴充功能的 lang.gif 和 summary.gif 也想在 PWA 中使用，並希望它們被快取
  // 請確保它們存在於 PWA 專案的 images 資料夾下，並在此處添加路徑
  // '/barbara-pwa/images/lang.gif',
  // '/barbara-pwa/images/summary.gif',

  // (可選) 字體檔案等其他靜態資源
];

// 1. 安裝 Service Worker (install 事件)
//    - 此事件在 Service Worker 首次註冊或更新時觸發。
//    - 主要用於快取應用程式外殼 (App Shell) 和靜態資源。
self.addEventListener('install', event => {
  console.log('[Service Worker] Install event in progress.');
  event.waitUntil(
    caches.open(CACHE_NAME)
      .then(cache => {
        console.log('[Service Worker] Opened cache:', CACHE_NAME);
        // addAll 會發起請求並將回應快取。如果任何一個請求失敗，整個操作都會失敗。
        return cache.addAll(urlsToCache)
          .then(() => console.log('[Service Worker] All urls cached successfully.'))
          .catch(error => {
            console.error('[Service Worker] Failed to cache one or more urls:', error);
            // 如果有部分資源快取失敗，可能需要處理，或者讓安裝失敗以便下次重試
          });
      })
      .then(() => {
        console.log('[Service Worker] Skip waiting on install');
        // 強制新的 Service Worker 在安裝完成後立即激活，而不是等待舊的 Service Worker 停止控制頁面
        return self.skipWaiting();
      })
      .catch(error => {
        console.error('[Service Worker] Cache open/addAll failed during install:', error);
      })
  );
});

// 2. 激活 Service Worker (activate 事件)
//    - 此事件在 Service Worker 安裝完成且準備好控制頁面時觸發。
//    - 主要用於清理舊版本的快取。
self.addEventListener('activate', event => {
  console.log('[Service Worker] Activate event in progress.');
  event.waitUntil(
    caches.keys().then(cacheNames => {
      return Promise.all(
        cacheNames.map(cacheName => {
          // 如果快取名稱不是當前定義的 CACHE_NAME，則刪除它
          if (cacheName !== CACHE_NAME) {
            console.log('[Service Worker] Deleting old cache:', cacheName);
            return caches.delete(cacheName);
          }
        })
      );
    }).then(() => {
      console.log('[Service Worker] Claiming clients for current Service Worker');
      // 讓 Service Worker 立即控制所有符合其 scope 的客戶端 (打開的頁面)
      return self.clients.claim();
    })
  );
});

// 3. 攔截網路請求 (fetch 事件)
//    - 此事件在頁面向網路發起請求時觸發。
//    - 允許我們攔截請求並決定如何回應 (例如從快取提供，或從網路獲取)。
self.addEventListener('fetch', event => {
  // 我們只對 GET 請求進行快取優先策略
  if (event.request.method !== 'GET') {
    // 對於非 GET 請求 (例如 POST 到 LLM API)，直接執行網路請求
    // 因為我們不希望快取 API 的 POST 請求或其回應
    return;
  }

  // 快取優先策略 (Cache First, then Network)
  event.respondWith(
    caches.match(event.request)
      .then(cachedResponse => {
        // 情況 1: 在快取中找到了匹配的資源
        if (cachedResponse) {
          // console.log('[Service Worker] Serving from cache:', event.request.url);
          return cachedResponse;
        }

        // 情況 2: 快取中未找到，執行網路請求
        // console.log('[Service Worker] Fetching from network:', event.request.url);
        return fetch(event.request).then(networkResponse => {
          // (可選) 如果請求成功，可以考慮將新的回應放入快取以備將來使用
          // 但對於動態內容或第三方 API，需要謹慎，這裡我們先不對所有 fetch 的結果都快取
          // 只有在 install 事件中明確指定的 urlsToCache 會被預先快取
          return networkResponse;
        }).catch(error => {
          // 處理網路請求失敗的情況
          console.error('[Service Worker] Fetch failed; returning offline page or error for:', event.request.url, error);
          // 在這裡可以返回一個預先快取的「離線頁面」(如果有的話)
          // 或者對於圖片等資源，可以返回一個預設的佔位圖片
          // 目前我們先簡單地讓請求失敗
          // return new Response("Network error occurred", { status: 408, headers: { 'Content-Type': 'text/plain' }});
        });
      })
  );
});