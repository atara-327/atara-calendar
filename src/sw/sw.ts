/// <reference lib="webworker" />
import { cacheName, decideFetch, isCacheable, isStaleCache, PAGE_URL } from './rules';

declare const self: ServiceWorkerGlobalScope;
// vite-plugins/serviceWorker.ts が、ビルドのときに埋める。
declare const __BUILD_VERSION__: string;
declare const __PRECACHE_URLS__: readonly string[];

const CACHE = cacheName(__BUILD_VERSION__);

// redirect: 'manual' にするのは、Access のログイン画面へ転送されたとき、その HTML を「アプリ」として保存しないため。
async function precache(cache: Cache, url: string): Promise<void> {
  const response = await fetch(url, { redirect: 'manual' });
  if (!isCacheable(response))
    throw new Error(`${url} を保存できません（${String(response.status)}）`);
  await cache.put(url, response);
}

self.addEventListener('install', (event) => {
  event.waitUntil(
    (async () => {
      const cache = await caches.open(CACHE);
      // ページも入れるのは、新しい版の activate で古いキャッシュを消すとき、開いたばかりのページも消えて、
      // 次に電波がない間に開けなくなるのを防ぐため。
      await Promise.all([PAGE_URL, ...__PRECACHE_URLS__].map((url) => precache(cache, url)));
      await self.skipWaiting();
    })(),
  );
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    (async () => {
      const names = await caches.keys();
      await Promise.all(
        names
          .filter((name) => isStaleCache(name, __BUILD_VERSION__))
          .map((name) => caches.delete(name)),
      );
      await self.clients.claim();
    })(),
  );
});

async function networkFirstPage(request: Request): Promise<Response> {
  try {
    const response = await fetch(request);
    if (isCacheable(response)) {
      const cache = await caches.open(CACHE);
      await cache.put(PAGE_URL, response.clone());
    }
    return response;
  } catch {
    // ネットワークの失敗のときだけ。ログイン画面への転送などの「応答」は、そのまま返す。
    const saved = await caches.match(PAGE_URL);
    if (saved !== undefined) return saved;
    throw new Error('保存したページがありません');
  }
}

async function cacheFirst(request: Request): Promise<Response> {
  const saved = await caches.match(request);
  if (saved !== undefined) return saved;
  const response = await fetch(request);
  if (isCacheable(response)) {
    const cache = await caches.open(CACHE);
    await cache.put(request, response.clone());
  }
  return response;
}

self.addEventListener('fetch', (event) => {
  const { request } = event;
  const policy = decideFetch({
    method: request.method,
    mode: request.mode,
    url: request.url,
    origin: self.location.origin,
  });
  if (policy === 'page') event.respondWith(networkFirstPage(request));
  else if (policy === 'cache-first') event.respondWith(cacheFirst(request));
});
