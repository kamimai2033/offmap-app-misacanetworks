// グローバル変数
let map;
const statusDiv = document.getElementById('status');
const downloadBtn = document.getElementById('download-btn');
const deleteBtn = document.getElementById('delete-btn');
const locateBtn = document.getElementById('locate-btn');
const minZoomInput = document.getElementById('min-zoom');
const maxZoomInput = document.getElementById('max-zoom');

const TILE_LAYER_URL = 'https://tile.openstreetmap.org/{z}/{x}/{y}.png';
const TILE_LAYER_ATTRIBUTION = '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors';

// --- 初期化 ---
document.addEventListener('DOMContentLoaded', () => {
    registerServiceWorker();
    initMap();
    setupEventListeners();
});

// --- Service Worker 登録 ---
function registerServiceWorker() {
    if ('serviceWorker' in navigator) {
        navigator.serviceWorker.register('sw.js')
            .then(registration => {
                console.log('Service Worker registered with scope:', registration.scope);
                // SWからのメッセージを受信
                 navigator.serviceWorker.addEventListener('message', event => {
                    if (event.data && event.data.status === 'cacheDeleted') {
                        updateStatus('オフライン地図のキャッシュが削除されました。');
                        downloadBtn.disabled = false;
                        deleteBtn.disabled = true; // 削除後は再度削除できないように
                    } else if (event.data && event.data.status === 'cacheDeleteFailed') {
                         updateStatus(`キャッシュ削除エラー: ${event.data.error}`);
                         deleteBtn.disabled = false; // エラーなら再試行可能に
                    }
                });
            })
            .catch(error => {
                console.error('Service Worker registration failed:', error);
                updateStatus('Service Workerの登録に失敗しました。オフライン機能は利用できません。');
            });
    } else {
        updateStatus('Service Workerがサポートされていません。オフライン機能は利用できません。');
        downloadBtn.disabled = true;
        deleteBtn.disabled = true;
    }
}

// --- 地図の初期化 ---
function initMap() {
    // 地図の中心とズームレベルを適当に設定（例：東京駅）
    map = L.map('map').setView([35.6812, 139.7671], 13);

    // タイルレイヤーを追加 (Service Workerがこれを傍受する)
    L.tileLayer(TILE_LAYER_URL, {
        attribution: TILE_LAYER_ATTRIBUTION,
        maxZoom: 19, // OpenStreetMap の最大ズームに合わせる
    }).addTo(map);

    // 初回読み込み時にキャッシュがあるか確認し、削除ボタンの状態を更新
    checkCacheExists().then(exists => {
        deleteBtn.disabled = !exists;
    });
}

// --- イベントリスナー設定 ---
function setupEventListeners() {
    downloadBtn.addEventListener('click', () => {
        const bounds = map.getBounds(); // 現在表示している地図範囲を取得
        const minZoom = parseInt(minZoomInput.value, 10);
        const maxZoom = parseInt(maxZoomInput.value, 10);

        if (isNaN(minZoom) || isNaN(maxZoom) || minZoom < 1 || maxZoom > 18 || minZoom > maxZoom) {
             updateStatus('ズームレベルの指定が無効です。1から18の間で、最小 <= 最大となるように設定してください。');
             return;
        }

        if (confirm(`現在の表示範囲 (ズーム ${minZoom} ～ ${maxZoom}) のタイルをダウンロードしますか？\n多くのタイルをダウンロードすると時間がかかり、ストレージを消費します。`)) {
            downloadTiles(bounds, minZoom, maxZoom);
        }
    });

    deleteBtn.addEventListener('click', () => {
         if (confirm('ダウンロード済みのオフライン地図を削除しますか？')) {
            deleteTiles();
         }
    });

    locateBtn.addEventListener('click', () => {
        locateUser();
    });
}

// --- 地図タイルのダウンロード ---
async function downloadTiles(bounds, minZoom, maxZoom) {
    if (!('serviceWorker' in navigator && navigator.serviceWorker.controller)) {
        updateStatus('Service Workerが有効ではありません。ダウンロードできません。');
        return;
    }

    updateStatus('タイルのダウンロードを開始します...');
    downloadBtn.disabled = true;
    deleteBtn.disabled = true; // ダウンロード中は削除不可

    const tileUrls = [];
    for (let z = minZoom; z <= maxZoom; z++) {
        const topLeftTile = getTileCoordinates(bounds.getNorthWest(), z);
        const bottomRightTile = getTileCoordinates(bounds.getSouthEast(), z);

        for (let x = topLeftTile.x; x <= bottomRightTile.x; x++) {
            for (let y = topLeftTile.y; y <= bottomRightTile.y; y++) {
                const url = TILE_LAYER_URL.replace('{z}', z).replace('{x}', x).replace('{y}', y);
                tileUrls.push(url);
            }
        }
    }

    updateStatus(`タイル数: ${tileUrls.length} 枚をダウンロード中... (0%)`);

    let downloadedCount = 0;
    const totalTiles = tileUrls.length;
    const batchSize = 10; // 一度にフェッチする数（サーバー負荷軽減のため）

    try {
        for (let i = 0; i < totalTiles; i += batchSize) {
             const batch = tileUrls.slice(i, i + batchSize);
             await Promise.all(batch.map(url =>
                 fetch(url) // fetchを実行するとService Workerが傍受してキャッシュする
                    .then(response => {
                        if (!response.ok) {
                             console.warn(`Failed to fetch tile: ${url}, Status: ${response.status}`);
                             // エラーがあっても続行する（一部タイルが欠ける可能性）
                        }
                        downloadedCount++;
                    })
                    .catch(error => {
                         console.warn(`Error fetching tile: ${url}`, error);
                         // ネットワークエラーでも続行
                         downloadedCount++; // エラーでもカウントを進めてUI表示を更新
                    })
             ));
            const progress = Math.round((downloadedCount / totalTiles) * 100);
            updateStatus(`タイル数: ${totalTiles} 枚をダウンロード中... (${progress}%)`);
        }

        updateStatus(`ダウンロード完了: ${downloadedCount} / ${totalTiles} 枚のタイルを処理しました。`);
        deleteBtn.disabled = false; // 完了したら削除可能に

    } catch (error) {
        console.error('Download error:', error);
        updateStatus(`ダウンロード中にエラーが発生しました: ${error.message}`);
    } finally {
        downloadBtn.disabled = false; // 完了またはエラーで再度DL可能に
        // 再度キャッシュ存在確認して削除ボタンの状態を最終決定
         checkCacheExists().then(exists => {
            deleteBtn.disabled = !exists;
        });
    }
}

// --- 地図タイルの削除 ---
function deleteTiles() {
     if ('serviceWorker' in navigator && navigator.serviceWorker.controller) {
        updateStatus('オフライン地図のキャッシュを削除中...');
        downloadBtn.disabled = true; // 削除中はダウンロード不可
        deleteBtn.disabled = true;   // 削除中は再度削除不可

        // Service Workerに削除を依頼するメッセージを送信
        navigator.serviceWorker.controller.postMessage({ action: 'deleteCache' });

     } else {
         updateStatus('Service Workerが有効ではありません。削除できません。');
     }
}

// --- キャッシュの存在確認 ---
async function checkCacheExists() {
    if (!('caches' in window)) return false;
    const cache = await caches.open('offline-map-tiles-v1'); // sw.js と同じキャッシュ名
    const keys = await cache.keys();
    return keys.length > 0;
}


// --- 現在地取得 ---
function locateUser() {
    updateStatus('現在地を取得中...');
    if ('geolocation' in navigator) {
        navigator.geolocation.getCurrentPosition(
            (position) => {
                const lat = position.coords.latitude;
                const lon = position.coords.longitude;
                const accuracy = position.coords.accuracy; // 精度(メートル)

                console.log(`Location found: Lat: ${lat}, Lon: ${lon}, Accuracy: ${accuracy}m`);

                // 地図の中心を現在地に移動
                map.setView([lat, lon], 16); // ズームレベル16で表示

                // マーカーを現在地に表示（古いマーカーがあれば削除）
                if (window.currentLocationMarker) {
                    map.removeLayer(window.currentLocationMarker);
                }
                if (window.accuracyCircle) {
                    map.removeLayer(window.accuracyCircle);
                }

                window.currentLocationMarker = L.marker([lat, lon]).addTo(map)
                    .bindPopup(`あなたの現在地 (精度: ${accuracy.toFixed(0)}m)`).openPopup();

                // 精度を示す円を表示
                window.accuracyCircle = L.circle([lat, lon], {
                    radius: accuracy, // 半径を精度に合わせる
                    color: 'blue',
                    fillColor: '#3af',
                    fillOpacity: 0.2,
                    weight: 1 // 線の太さ
                }).addTo(map);

                updateStatus(`現在地を表示しました (Lat: ${lat.toFixed(4)}, Lon: ${lon.toFixed(4)})`);
            },
            (error) => {
                console.error("Geolocation error:", error);
                let message = '現在地の取得に失敗しました。';
                switch (error.code) {
                    case error.PERMISSION_DENIED:
                        message += ' 位置情報の利用が許可されていません。';
                        break;
                    case error.POSITION_UNAVAILABLE:
                        message += ' 位置情報を取得できませんでした。';
                        break;
                    case error.TIMEOUT:
                        message += ' 位置情報の取得がタイムアウトしました。';
                        break;
                    default:
                        message += ' 不明なエラーです。';
                        break;
                }
                updateStatus(message);
            },
            {
                enableHighAccuracy: true, // 高精度を試みる
                timeout: 10000,          // 10秒でタイムアウト
                maximumAge: 0            // キャッシュされた位置情報を使わない
            }
        );
    } else {
        updateStatus('お使いのブラウザはGeolocationをサポートしていません。');
    }
}

// --- 緯度経度とズームレベルからタイル座標を計算 ---
// (Leaflet内部でも使われる標準的な計算式)
function getTileCoordinates(latLng, zoom) {
    const latRad = latLng.lat * Math.PI / 180;
    const n = Math.pow(2, zoom);
    const xtile = Math.floor((latLng.lng + 180) / 360 * n);
    const ytile = Math.floor((1 - Math.log(Math.tan(latRad) + 1 / Math.cos(latRad)) / Math.PI) / 2 * n);
    return { x: xtile, y: ytile, z: zoom };
}

// --- ステータス表示更新 ---
function updateStatus(message) {
    console.log("Status:", message);
    statusDiv.textContent = `ステータス: ${message}`;
}