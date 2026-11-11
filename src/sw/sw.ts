/// <reference lib="webworker" />
import {
  cacheName,
  decideFetch,
  isCacheable,
  isRuntimeCached,
  isStaleCache,
  missingFromPage,
  PAGE_URL,
  runtimeCacheName,
} from './rules';

declare const self: ServiceWorkerGlobalScope;
// vite-plugins/serviceWorker.ts が、ビルドのときに埋める。
declare const __BUILD_VERSION__: string;
declare const __CODE_HASH__: string;
declare const __PRECACHE_URLS__: readonly string[];

const CACHE = cacheName(__BUILD_VERSION__);
const RUNTIME_CACHE = runtimeCacheName(__CODE_HASH__);

// redirect: 'manual' にするのは、Access のログイン画面へ転送されたとき、その HTML を「アプリ」として保存しないため。
async function fetchForInstall(url: string): Promise<Response> {
  const response = await fetch(url, { redirect: 'manual' });
  if (!isCacheable(url, responseInfo(response))) {
    throw new Error(`${url} を保存できません（${String(response.status)}）`);
  }
  return response;
}

function responseInfo(response: Response) {
  return {
    ok: response.ok,
    type: response.type,
    redirected: response.redirected,
    contentType: response.headers.get('Content-Type'),
  };
}

async function install(): Promise<void> {
  const cache = await caches.open(CACHE);
  const page = await fetchForInstall(PAGE_URL);
  const missing = missingFromPage(await page.clone().text(), __PRECACHE_URLS__);
  if (missing.length > 0) throw new Error(`取ったページが、${missing.join('・')} を指していません`);
  await cache.put(PAGE_URL, page);
  await Promise.all(
    __PRECACHE_URLS__.map(async (url) => {
      await cache.put(url, await fetchForInstall(url));
    }),
  );
  await self.skipWaiting();
}

self.addEventListener('install', (event) => {
  event.waitUntil(install());
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    (async () => {
      const names = await caches.keys();
      await Promise.all(
        names
          .filter((name) => isStaleCache(name, [CACHE, RUNTIME_CACHE]))
          .map((name) => caches.delete(name)),
      );
      await self.clients.claim();
    })(),
  );
});

// ページは、ここでは保存しない（install でだけ保存する）。今の版の保存を、その版の中でそろえるため。
async function networkFirstPage(request: Request): Promise<Response> {
  try {
    return await fetch(request);
  } catch {
    // ネットワークの失敗のときだけ。ログイン画面への転送などの「応答」は、そのまま返す。
    const saved = await (await caches.open(CACHE)).match(PAGE_URL);
    if (saved !== undefined) return saved;
    throw new Error('保存したページがありません');
  }
}

async function cacheFirst(event: FetchEvent): Promise<Response> {
  const { request } = event;
  const saved = await caches.match(request);
  if (saved !== undefined) return saved;
  const response = await fetch(request);
  const { pathname } = new URL(request.url);
  if (isRuntimeCached(pathname) && isCacheable(pathname, responseInfo(response))) {
    // 保存の失敗（容量など）で、取れた応答まで止めない。
    const copy = response.clone();
    event.waitUntil(
      caches
        .open(RUNTIME_CACHE)
        .then((cache) => cache.put(request, copy))
        .catch(() => undefined),
    );
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
  else if (policy === 'cache-first') event.respondWith(cacheFirst(event));
});
