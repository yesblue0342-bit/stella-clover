// Stella Clover Service Worker
// ★ 회귀 방지: 앱 셸(HTML/네비게이션)은 network-first 로 항상 최신을 받는다.
//   과거 오래된 캐시가 계속 옛 프론트를 서빙해 이미 고친 버그(invalid_client 등)가 사용자에게 남던
//   문제를 막는다. 정적 자산(js/css/img)만 캐시 폴백. /api 는 캐시하지 않음.
const CACHE = 'stella-clover-v32';

self.addEventListener('install', e => self.skipWaiting());

self.addEventListener('activate', e => {
  e.waitUntil(
    caches.keys().then(keys =>
      Promise.all(keys.filter(k => k !== CACHE).map(k => caches.delete(k)))
    ).then(() => self.clients.claim())
  );
});

// HTML 네비게이션 요청 여부(= 앱 셸). 이것만 network-first 로 최신 강제.
function isHtmlRequest(req) {
  if (req.mode === 'navigate') return true;
  const a = req.headers.get('accept') || '';
  return a.includes('text/html');
}

self.addEventListener('fetch', e => {
  const req = e.request;
  const url = new URL(req.url);
  if (url.pathname.startsWith('/api/')) return; // API 는 SW 미개입(항상 네트워크)
  if (req.method !== 'GET') return;

  if (isHtmlRequest(req)) {
    // 앱 셸: 최신 네트워크 우선, 오프라인일 때만 캐시.
    e.respondWith(
      fetch(req)
        .then(res => { const c = res.clone(); caches.open(CACHE).then(x => x.put(req, c)).catch(() => {}); return res; })
        .catch(() => caches.match(req).then(m => m || caches.match('/index.html')))
    );
    return;
  }

  // 정적 자산: 네트워크 우선 + 캐시 갱신, 실패 시 캐시.
  e.respondWith(
    fetch(req)
      .then(res => { const c = res.clone(); caches.open(CACHE).then(x => x.put(req, c)).catch(() => {}); return res; })
      .catch(() => caches.match(req))
  );
});
