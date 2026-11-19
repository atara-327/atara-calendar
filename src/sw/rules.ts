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

/** 版のキャッシュ。`/` と画面のファイルを、同じ版のものだけでそろえて持つ。 */
export function cacheName(version: string): string {
  return `${CACHE_PREFIX}${version}`;
}

/**
 * 使ったときに保存するもの（フォント・絵文字）のキャッシュ。名前に Service Worker のコードの hash を使い、
 * アプリの版が変わっても消さない（フォントや絵文字は、版をまたいで同じ URL なら同じ中身のため）。
 */
export function runtimeCacheName(codeHash: string): string {
  return `${CACHE_PREFIX}runtime-${codeHash}`;
}

/** 消す対象のキャッシュか。今の 2 つ以外の、このアプリのキャッシュ。ほかのアプリのキャッシュは消さない。 */
export function isStaleCache(name: string, current: readonly string[]): boolean {
  return name.startsWith(CACHE_PREFIX) && !current.includes(name);
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

export type ResponseInfo = {
  ok: boolean;
  type: string;
  redirected: boolean;
  /** Content-Type ヘッダー。なければ null */
  contentType: string | null;
};

/**
 * 保存してよい応答か。Access のログイン画面への転送（opaqueredirect・redirected）や、エラーの応答を保存すると、
 * 電波がない間に、ログイン画面やエラーが「アプリ」として出てしまう。
 * 画面のファイルと絵文字（`/assets/*`・`/emoji/*`）で text/html のものも保存しない。存在しないファイルには、
 * SPA の index.html が 200 で返るため（保存すると、JS として HTML が返る）。
 */
export function isCacheable(
  path: string,
  { ok, type, redirected, contentType }: ResponseInfo,
): boolean {
  if (!ok || type !== 'basic' || redirected) return false;
  if (isCacheFirstPath(path) && (contentType ?? '').toLowerCase().startsWith('text/html')) {
    return false;
  }
  return true;
}

/** 使ったときに保存する（runtime のキャッシュに入れる）ものか。install で保存するもの以外の、保存先読みの URL。 */
export function isRuntimeCached(path: string): boolean {
  return isCacheFirstPath(path) && !isPrecached(path);
}

/**
 * install で取った `/` の HTML が、起動時に読む JS・CSS（index.html が指すもの）をすべて指しているか。指していないものを返す。
 * デプロイの途中で、別の版の HTML を取ってしまい、HTML と画面のファイルが食い違うのを防ぐ。
 * 後から読み込む chunk（フォームなど）は HTML が指さないので、ここには渡さない。
 */
export function missingFromPage(html: string, urls: readonly string[]): string[] {
  return urls.filter((url) => /\.(js|css)$/.test(url) && !html.includes(url));
}

/**
 * ビルドの出力の `/assets/` の JS・CSS のうち、保存の一覧に入っていないもの。後から読み込む chunk が一覧から漏れると、
 * 電波がない間にそれを開いた瞬間、画面が壊れる（設計書 6.5）。
 */
export function missingFromPrecache(files: readonly string[], urls: readonly string[]): string[] {
  return files.filter((file) => /^\/assets\/.*\.(js|css)$/.test(file) && !urls.includes(file));
}

/** 画面のファイルのうち、install で全部保存するもの。フォントは、数が多く重いので、使ったときに保存する。 */
export function isPrecached(path: string): boolean {
  return path.startsWith('/assets/') && !/\.(woff2?|ttf|otf)$/.test(path);
}

/** ページの取得を待つ上限（ミリ秒）。 */
export const PAGE_TIMEOUT_MS = 3000;

const TIMED_OUT = Symbol('timed out');

/**
 * ページは、ネットワークを先に使う。ただし、上限までに応答が来ず、保存したページがあれば、保存した方を返す。
 * 保存がなければ、ネットワークを待ち続ける。上限を過ぎてから届いた応答は、使わない（返した後なので）。
 * ネットワークの失敗（例外）のときは、保存を返す。応答（ログイン画面への転送を含む）は、そのまま返す。
 */
export async function pageWithTimeLimit<T>(
  network: Promise<T>,
  getSaved: () => Promise<T | undefined>,
  timeoutMs: number,
): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<typeof TIMED_OUT>((resolve) => {
    timer = setTimeout(() => {
      resolve(TIMED_OUT);
    }, timeoutMs);
  });
  try {
    const first = await Promise.race([network, timeout]);
    if (first !== TIMED_OUT) return first;
    const saved = await getSaved();
    if (saved !== undefined) {
      // 返した後に届く応答が失敗しても、未処理の拒否にしない。
      network.catch(() => undefined);
      return saved;
    }
    return await network;
  } catch (error) {
    const saved = await getSaved();
    if (saved !== undefined) return saved;
    throw error;
  } finally {
    clearTimeout(timer);
  }
}
