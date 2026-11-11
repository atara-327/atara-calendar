// Service Worker の判断（設計書 14.2）。イベントや Cache API から切り離してあるのは、テストで仕様を確かめるため。

/** URL ごとの扱い。passthrough は、Service Worker が関わらない（respondWith しない）。 */
export type FetchPolicy = 'page' | 'cache-first' | 'passthrough';

export type FetchInfo = {
  method: string;
  /** Request.mode */
  mode: string;
  url: string;
  /** Service Worker 自身の origin */
  origin: string;
};

/** 保存したページ（`/` の HTML）の URL。`/day/...` も同じ HTML なので、これ 1 つだけ持つ。 */
export const PAGE_URL = '/';

const CACHE_PREFIX = 'atara-calendar-';

export function cacheName(version: string): string {
  return `${CACHE_PREFIX}${version}`;
}

/** 古い版のキャッシュ（消す対象）か。ほかのアプリのキャッシュは消さない。 */
export function isStaleCache(name: string, version: string): boolean {
  return name.startsWith(CACHE_PREFIX) && name !== cacheName(version);
}

function isPagePath(path: string): boolean {
  return path === '/' || path.startsWith('/day/');
}

function isCacheFirstPath(path: string): boolean {
  // 絵文字の画像は URL に版が入り、/assets/ は名前に hash が入る。どちらも同じ URL なら中身が変わらない。
  return path.startsWith('/assets/') || path.startsWith('/emoji/');
}

export function decideFetch({ method, mode, url, origin }: FetchInfo): FetchPolicy {
  if (method !== 'GET') return 'passthrough';
  const parsed = new URL(url);
  if (parsed.origin !== origin) return 'passthrough';
  // /api/* は、データを持つ同期の仕組み（IndexedDB）と二重にならないよう、扱わない。
  if (mode === 'navigate' && isPagePath(parsed.pathname)) return 'page';
  if (isCacheFirstPath(parsed.pathname)) return 'cache-first';
  return 'passthrough';
}

export type ResponseInfo = { ok: boolean; type: string; redirected: boolean };

/**
 * 保存してよい応答か。Access のログイン画面への転送（opaqueredirect・redirected）や、エラーの応答を保存すると、
 * 電波がない間に、ログイン画面やエラーが「アプリ」として出てしまう。
 */
export function isCacheable({ ok, type, redirected }: ResponseInfo): boolean {
  return ok && type === 'basic' && !redirected;
}

/** 画面のファイルのうち、install で全部保存するもの。フォントは、数が多く重いので、使ったときに保存する。 */
export function isPrecached(path: string): boolean {
  return path.startsWith('/assets/') && !/\.(woff2?|ttf|otf)$/.test(path);
}
