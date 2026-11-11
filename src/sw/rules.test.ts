import { describe, expect, it } from 'vitest';
import {
  cacheName,
  decideFetch,
  isCacheable,
  isPrecached,
  isRuntimeCached,
  missingFromPage,
  runtimeCacheName,
  type ResponseInfo,
  isStaleCache,
  PAGE_URL,
  type FetchInfo,
} from './rules';

const origin = 'https://cal.example.com';
const info = (path: string, overrides: Partial<FetchInfo> = {}): FetchInfo => ({
  method: 'GET',
  mode: 'no-cors',
  url: `${origin}${path}`,
  origin,
  ...overrides,
});

describe('PW-2 URL ごとの扱い', () => {
  it('月表示と日表示のページ（ナビゲーション）は、ネットワークを先に使う', () => {
    expect(decideFetch(info('/', { mode: 'navigate' }))).toBe('page');
    expect(decideFetch(info('/day/2026-11-11', { mode: 'navigate' }))).toBe('page');
  });

  it('画面のファイル・絵文字・フォントは、保存を先に使う', () => {
    expect(decideFetch(info('/assets/index-abc.js'))).toBe('cache-first');
    expect(decideFetch(info('/assets/noto-sans-jp-400.woff2'))).toBe('cache-first');
    expect(decideFetch(info('/emoji/1.2.3/1f600.svg'))).toBe('cache-first');
  });

  it('/api/* は扱わない', () => {
    expect(decideFetch(info('/api/changes'))).toBe('passthrough');
    expect(decideFetch(info('/api/changes', { mode: 'navigate' }))).toBe('passthrough');
  });

  it('GET 以外・ほかの origin・それ以外のページは扱わない', () => {
    expect(decideFetch(info('/assets/a.js', { method: 'POST' }))).toBe('passthrough');
    expect(
      decideFetch(info('/assets/a.js', { url: 'https://other.example.com/assets/a.js' })),
    ).toBe('passthrough');
    expect(decideFetch(info('/manifest.webmanifest'))).toBe('passthrough');
    expect(decideFetch(info('/cdn-cgi/access/login', { mode: 'navigate' }))).toBe('passthrough');
  });
});

const response = (overrides: Partial<ResponseInfo> = {}): ResponseInfo => ({
  ok: true,
  type: 'basic',
  redirected: false,
  contentType: 'text/javascript',
  ...overrides,
});

describe('PW-2 保存してよい応答', () => {
  it('ok な同じ origin の応答だけを保存する', () => {
    expect(isCacheable('/assets/a.js', response())).toBe(true);
    expect(isCacheable('/', response({ contentType: 'text/html' }))).toBe(true);
  });

  it('Access のログイン画面への転送・エラー・転送された先の応答は保存しない', () => {
    expect(isCacheable('/', response({ ok: false, type: 'opaqueredirect' }))).toBe(false);
    expect(isCacheable('/', response({ ok: false }))).toBe(false);
    expect(isCacheable('/', response({ redirected: true }))).toBe(false);
    expect(isCacheable('/', response({ type: 'cors' }))).toBe(false);
  });

  it('画面のファイルと絵文字で、中身が HTML の応答は保存しない（存在しないファイルに index.html が返るため）', () => {
    expect(
      isCacheable('/assets/gone.js', response({ contentType: 'text/html; charset=utf-8' })),
    ).toBe(false);
    expect(isCacheable('/emoji/1.0/gone.svg', response({ contentType: 'text/html' }))).toBe(false);
    expect(isCacheable('/emoji/1.0/1f600.svg', response({ contentType: 'image/svg+xml' }))).toBe(
      true,
    );
  });
});

describe('PW-2 install で取ったページの確認', () => {
  const urls = ['/assets/index-a.js', '/assets/index-a.css', '/assets/logo.png'];

  it('一覧の JS・CSS をすべて指していれば、不足なし', () => {
    const html = '<script src="/assets/index-a.js"></script><link href="/assets/index-a.css">';
    expect(missingFromPage(html, urls)).toEqual([]);
  });

  it('別の版のページ（一覧の JS・CSS を指していない）なら、不足を返す', () => {
    const html = '<script src="/assets/index-b.js"></script><link href="/assets/index-a.css">';
    expect(missingFromPage(html, urls)).toEqual(['/assets/index-a.js']);
  });
});

describe('PW-2 install で保存するもの', () => {
  it('画面のファイルは保存するが、フォントは使ったときに保存する', () => {
    expect(isPrecached('/assets/index-abc.js')).toBe(true);
    expect(isPrecached('/assets/index-abc.css')).toBe(true);
    expect(isPrecached('/assets/noto-sans-jp-400.woff2')).toBe(false);
    expect(isPrecached('/emoji/1.2.3/1f600.svg')).toBe(false);
  });

  it('フォント・絵文字は、使ったときに、版とは別のキャッシュに保存する', () => {
    expect(isRuntimeCached('/assets/noto-sans-jp-400.woff2')).toBe(true);
    expect(isRuntimeCached('/emoji/1.2.3/1f600.svg')).toBe(true);
    expect(isRuntimeCached('/assets/index-abc.js')).toBe(false);
  });

  it('保存したページの URL は `/` の 1 つ', () => {
    expect(PAGE_URL).toBe('/');
  });
});

describe('PW-3 新しい版への切り替え', () => {
  const current = [cacheName('new'), runtimeCacheName('code')];

  it('古い版のキャッシュだけを消し、今の 2 つとほかのアプリのキャッシュは残す', () => {
    expect(isStaleCache(cacheName('old'), current)).toBe(true);
    expect(isStaleCache(runtimeCacheName('old-code'), current)).toBe(true);
    expect(isStaleCache(cacheName('new'), current)).toBe(false);
    expect(isStaleCache(runtimeCacheName('code'), current)).toBe(false);
    expect(isStaleCache('other-app', current)).toBe(false);
  });

  it('使ったときに保存するもののキャッシュ名は、アプリの版ではなく、コードの hash で決まる', () => {
    expect(runtimeCacheName('code')).not.toBe(cacheName('code'));
  });
});
