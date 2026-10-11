// =========================================
// sw.js - 서비스 워커 (앱 파일 받아오기 담당)
// =========================================
// 방식: '인터넷 먼저'
//   1) 인터넷이 되면 항상 서버에서 최신 파일을 받아옴 → 업데이트가 바로 반영됨
//   2) 받은 파일을 보관해 두었다가, 인터넷이 안 될 때는 보관한 파일로 앱을 엶
// ※ 할 일·기록 데이터는 여기가 아니라 IndexedDB(db.js)에 저장되므로 이 파일과 무관함

const CACHE_NAME = 'life-planner-files-v1';

// 처음 설치할 때 미리 보관해 둘 앱 파일
const APP_FILES = [
  './',
  './index.html',
  './styles.css',
  './app.js',
  './db.js',
  './manifest.webmanifest',
  './icon-192.png',
  './icon-512.png',
  './icon-maskable-512.png',
  './apple-touch-icon.png'
];

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(CACHE_NAME)
      // cache: 'reload' → 휴대폰이 기억한 예전 파일이 아니라 서버의 파일로 보관
      .then((cache) => cache.addAll(APP_FILES.map((url) => new Request(url, { cache: 'reload' }))))
      .then(() => self.skipWaiting())
  );
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys()
      .then((names) => Promise.all(
        names.filter((n) => n.startsWith('life-planner-files-') && n !== CACHE_NAME)
             .map((n) => caches.delete(n))
      ))
      .then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', (event) => {
  const req = event.request;
  // 이 앱의 파일을 읽어 올 때만 관여 (구글 글씨체 등 다른 사이트는 브라우저에 맡김)
  if (req.method !== 'GET' || new URL(req.url).origin !== self.location.origin) return;

  event.respondWith(
    // cache: 'no-cache' → 서버에 '바뀐 게 있나' 꼭 확인하고 받아옴 (그동안의 예전 파일 문제 해결)
    fetch(req, { cache: 'no-cache' })
      .then((res) => {
        if (res && res.ok) {
          const copy = res.clone();
          caches.open(CACHE_NAME).then((cache) => cache.put(req, copy));
        }
        return res;
      })
      .catch(() =>
        // 인터넷이 안 될 때: 보관한 파일 사용 (?v=숫자는 무시하고 찾음)
        caches.match(req, { ignoreSearch: true }).then((hit) =>
          hit || (req.mode === 'navigate' ? caches.match('./index.html') : undefined)
        ).then((hit) => hit || new Response('인터넷에 연결되어 있지 않아요.', {
          status: 503,
          headers: { 'Content-Type': 'text/plain; charset=utf-8' }
        }))
      )
  );
});
