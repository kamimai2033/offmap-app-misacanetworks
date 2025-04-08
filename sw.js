// --- 設定 ---
const APP_SHELL_CACHE_NAME = 'offline-map-appshell-v1'; // アプリシェル用キャッシュ
const TILE_CACHE_NAME = 'offline-map-tiles-v1';       // 地図タイル用キャッシュ
const TILE_URL_PATTERN = 'https://tile.openstreetmap.org/'; // タイルURL

// アプリシェルとしてキャッシュするファイルリスト
// 注意: LeafletのファイルはCDNから取得するため、オフライン時の完全動作には
// これらもキャッシュするか、ローカルに配置してリストに追加する必要があります。
// ここでは主要なファイルのみリストアップします。
const APP_SHELL_FILES = [
    '/', // ルート (index.html)
    '/index.html',
    '/style.css',
    '/script.js',
    '/manifest.json',
    '/icons/icon-192x192.png', // アイコンもキャッシュ
    '/icons/icon-512x512.png',
    // Leaflet のファイルもキャッシュする場合（推奨）:
    'https://unpkg.com/leaflet@1.9.4/dist/leaflet.css',
    'https://unpkg.com/leaflet@1.9.4/dist/leaflet.js'
    // Leafletの画像ファイル (marker-icon.pngなど) も必要に応じて追加
];

// --- イベントリスナー ---

// Service Worker インストール時: アプリシェルをキャッシュ
self.addEventListener('install', event => {
    console.log('Service Worker: Install');
    event.waitUntil(
        caches.open(APP_SHELL_CACHE_NAME)
            .then(cache => {
                console.log('Service Worker: Caching App Shell');
                // APP_SHELL_FILES のうち、取得に失敗したものがあっても処理を続行する（一部キャッシュ）
                // 厳密に全てキャッシュしたい場合は Promise.all を使う
                const cachePromises = APP_SHELL_FILES.map(urlToCache => {
                    return cache.add(urlToCache).catch(err => {
                        console.warn(`Failed to cache ${urlToCache}:`, err);
                    });
                });
                return Promise.all(cachePromises);
            })
            .then(() => self.skipWaiting()) // 新しいSWをすぐに有効化
    );
});

// Service Worker アクティベート時: 古いキャッシュを削除
self.addEventListener('activate', event => {
    console.log('Service Worker: Activate');
    event.waitUntil(
        caches.keys().then(cacheNames => {
            return Promise.all(
                cacheNames.map(cacheName => {
                    // このSWが管理するキャッシュで、かつ現在のバージョンと異なるものを削除
                    if ((cacheName.startsWith('offline-map-appshell-') && cacheName !== APP_SHELL_CACHE_NAME) ||
                        (cacheName.startsWith('offline-map-tiles-') && cacheName !== TILE_CACHE_NAME)) {
                        console.log('Service Worker: Deleting old cache', cacheName);
                        return caches.delete(cacheName);
                    }
                })
            );
        }).then(() => {
            return self.clients.claim(); // 現在のページをすぐに制御下に置く
        })
    );
});

// Fetch イベント: リクエストを傍受し、キャッシュ戦略を適用
self.addEventListener('fetch', event => {
    const requestUrl = event.request.url;

    // 1. 地図タイルリクエストの場合 (Cache First, then Network)
    if (requestUrl.startsWith(TILE_URL_PATTERN)) {
        event.respondWith(cacheFirstThenNetwork(event.request, TILE_CACHE_NAME));
    }
    // 2. アプリシェルリクエストの場合 (Cache First, then Network)
    //    APP_SHELL_FILES に含まれるURLか、同じオリジンのリクエストを対象にするなど調整可能
    else if (isAppShellRequest(event.request)) {
         event.respondWith(cacheFirstThenNetwork(event.request, APP_SHELL_CACHE_NAME));
    }
    // 3. その他のリクエスト (Network Only - または状況に応じて変更)
    else {
        // デフォルトはネットワークから取得
         event.respondWith(fetch(event.request));
    }
});

// --- キャッシュ戦略関数 ---

// Cache First, then Network
function cacheFirstThenNetwork(request, cacheName) {
    return caches.open(cacheName).then(cache => {
        return cache.match(request).then(cachedResponse => {
            // Cache Hit: キャッシュから返す
            if (cachedResponse) {
                // console.log('Serving from cache:', request.url);
                return cachedResponse;
            }
            // Cache Miss: ネットワークから取得し、キャッシュに保存
            // console.log('Fetching from network and caching:', request.url);
            return fetch(request).then(networkResponse => {
                // 正常なレスポンスのみキャッシュ
                if (networkResponse && networkResponse.status === 200 && networkResponse.type === 'basic') { // 他のオリジンからの不透明なレスポンスはキャッシュしない方が安全な場合も
                    // レスポンスは一度しか読めないので複製
                    const responseToCache = networkResponse.clone();
                    cache.put(request, responseToCache);
                }
                 return networkResponse;
             }).catch(error => {
                 console.warn('Fetch failed; network error or offline:', error);
                 // オフライン時の代替レスポンスを返すことも可能
                 // if (request.destination === 'document') return caches.match('/offline.html'); // 例
                 throw error;
             });
        });
    });
}

// --- ヘルパー関数 ---

// リクエストがアプリシェル関連か判定する関数（簡易版）
// 必要に応じて、より厳密な判定ロジックを実装してください
function isAppShellRequest(request) {
    // 同じオリジンからのリクエストか？ (CDNなどは除く)
    const isSameOrigin = request.url.startsWith(self.location.origin);
    // APP_SHELL_FILES に直接含まれるURLか？
    const isListedFile = APP_SHELL_FILES.some(fileUrl => request.url.endsWith(fileUrl)); // URL全体で比較する方が確実

    // ナビゲーションリクエスト (HTML文書) は常にキャッシュ対象とする
    const isNavigation = request.mode === 'navigate';

    // Leaflet CDN のファイルもキャッシュ対象とする場合
    const isLeafletResource = request.url.startsWith('https://unpkg.com/leaflet');

    return isNavigation || isListedFile || isLeafletResource || (isSameOrigin && request.destination !== ''); // 画像なども含める場合
}


// --- メッセージリスナー (変更なし) ---
// メインスクリプトからのメッセージ受信 (タイルキャッシュ削除など)
self.addEventListener('message', event => {
    if (event.data && event.data.action === 'deleteCache') {
        console.log('Service Worker: Received delete TILE cache message');
        event.waitUntil(
            caches.delete(TILE_CACHE_NAME) // タイルキャッシュのみ削除
                .then(() => {
                    console.log('Service Worker: Tile cache deleted successfully.');
                    if (event.source) { // クライアントが存在する場合のみ送信
                         event.source.postMessage({ status: 'cacheDeleted' });
                    }
                })
                .catch(error => {
                    console.error('Service Worker: Failed to delete tile cache:', error);
                    if (event.source) {
                        event.source.postMessage({ status: 'cacheDeleteFailed', error: error.message });
                    }
                })
        );
    }
    // 他のメッセージ（例：アプリシェルキャッシュの強制更新など）もここに追加可能
});