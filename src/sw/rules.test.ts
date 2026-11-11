import { describe, expect, it } from 'vitest';
import {
  cacheName,
  decideFetch,
  isCacheable,
  isPrecached,
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

describe('PW-2 保存してよい応答', () => {
  it('ok な同じ origin の応答だけを保存する', () => {
    expect(isCacheable({ ok: true, type: 'basic', redirected: false })).toBe(true);
  });

  it('Access のログイン画面への転送・エラー・転送された先の応答は保存しない', () => {
    expect(isCacheable({ ok: false, type: 'opaqueredirect', redirected: false })).toBe(false);
    expect(isCacheable({ ok: false, type: 'basic', redirected: false })).toBe(false);
    expect(isCacheable({ ok: true, type: 'basic', redirected: true })).toBe(false);
    expect(isCacheable({ ok: true, type: 'cors', redirected: false })).toBe(false);
  });
});

describe('PW-2 install で保存するもの', () => {
  it('画面のファイルは保存するが、フォントは使ったときに保存する', () => {
    expect(isPrecached('/assets/index-abc.js')).toBe(true);
    expect(isPrecached('/assets/index-abc.css')).toBe(true);
    expect(isPrecached('/assets/noto-sans-jp-400.woff2')).toBe(false);
    expect(isPrecached('/emoji/1.2.3/1f600.svg')).toBe(false);
  });

  it('保存したページの URL は `/` の 1 つ', () => {
    expect(PAGE_URL).toBe('/');
  });
});

describe('PW-3 新しい版への切り替え', () => {
  it('古い版のキャッシュだけを消し、今の版とほかのアプリのキャッシュは残す', () => {
    expect(isStaleCache(cacheName('old'), 'new')).toBe(true);
    expect(isStaleCache(cacheName('new'), 'new')).toBe(false);
    expect(isStaleCache('other-app', 'new')).toBe(false);
  });
});
