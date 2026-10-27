import { readFileSync } from 'node:fs';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { TEST_APP_ORIGIN, unusedDb } from '../../test/helpers/env';
import { apiErrorBodySchema } from '../shared/api';
import type { Bindings } from './env';
import { scheduled } from './cron';
import worker, { app } from './index';

const devEnv: Bindings = {
  DB: unusedDb,
  ACCESS_TEAM_DOMAIN: '',
  ACCESS_AUD: '',
  APP_ORIGIN: TEST_APP_ORIGIN,
  AUTH_MODE: 'dev',
};

// 本番と同じ設定（AUTH_MODE なし）。JWT のヘッダーを付けないので、鍵を取りに行く前に拒否される。
const prodEnv: Bindings = {
  DB: unusedDb,
  ACCESS_TEAM_DOMAIN: 'example-team.cloudflareaccess.com',
  ACCESS_AUD: 'test-audience',
  APP_ORIGIN: TEST_APP_ORIGIN,
  ALLOWED_EMAIL: 'me@example.com',
};

const sameOrigin = { 'Sec-Fetch-Site': 'same-origin' };

beforeEach(() => {
  vi.spyOn(console, 'warn').mockImplementation(() => undefined);
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe('GET /api/health', () => {
  it('200 と { ok: true } を返す', async () => {
    const res = await app.request('/api/health', { headers: sameOrigin }, devEnv);

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true });
  });
});

describe('/api/* の保護（AU-1・NF-2）', () => {
  it('JWT がなければ、/api/health も 403', async () => {
    const res = await app.request('/api/health', { headers: sameOrigin }, prodEnv);

    expect(res.status).toBe(403);
  });

  it('JWT がなければ、存在しない API の URL も 404 ではなく 403（存在を教えない）', async () => {
    const res = await app.request('/api/nothing', { headers: sameOrigin }, prodEnv);

    expect(res.status).toBe(403);
  });

  it('JWT がなければ、末尾のスラッシュのない /api も 403', async () => {
    const res = await app.request('/api', { headers: sameOrigin }, prodEnv);

    expect(res.status).toBe(403);
  });

  it('認証の 403 にも、セキュリティヘッダーを付ける', async () => {
    const res = await app.request('/api/health', { headers: sameOrigin }, prodEnv);

    expect(res.headers.get('X-Content-Type-Options')).toBe('nosniff');
    expect(res.headers.get('Cache-Control')).toBe('no-store');
    expect(res.headers.get('Referrer-Policy')).toBe('no-referrer');
  });

  it('認証が先で、リクエストの確認はそのあと（JWT のない JSON でない書き込みは、415 ではなく 403）', async () => {
    const res = await app.request(
      '/api/health',
      { method: 'PUT', headers: { ...sameOrigin, 'Content-Type': 'text/plain' }, body: 'x' },
      prodEnv,
    );

    expect(res.status).toBe(403);
  });

  it('認証を通ったあとは、リクエストの確認をする（他のサイトからの書き込みは 403）', async () => {
    const res = await app.request(
      '/api/nothing',
      { method: 'PUT', headers: { 'Sec-Fetch-Site': 'cross-site' } },
      devEnv,
    );

    expect(res.status).toBe(403);
  });

  it('認証を通ったあとは、リクエストの確認をする（Sec-Fetch-Site がなければ、読み取りも 403）', async () => {
    const res = await app.request('/api/health', {}, devEnv);

    expect(res.status).toBe(403);
  });

  it('認証を通ったあとは、リクエストの確認をする（JSON でない本文は 415）', async () => {
    const res = await app.request(
      '/api/nothing',
      { method: 'PUT', headers: { ...sameOrigin, 'Content-Type': 'text/plain' }, body: 'x' },
      devEnv,
    );

    expect(res.status).toBe(415);
  });

  it('通った応答にも、セキュリティヘッダーを付ける', async () => {
    const res = await app.request('/api/health', { headers: sameOrigin }, devEnv);

    expect(res.headers.get('X-Content-Type-Options')).toBe('nosniff');
    expect(res.headers.get('Cache-Control')).toBe('no-store');
    expect(res.headers.get('Referrer-Policy')).toBe('no-referrer');
  });
});

describe('/api/ の下の、存在しないパスと、違うメソッド', () => {
  const notFound = { error: 'not_found', message: '存在しない API です' };

  it.each([
    { name: '存在しないパス', method: 'GET', path: '/api/nothing' },
    { name: '存在しないパス（深い）', method: 'GET', path: '/api/entries/e1/extra' },
    { name: '末尾のスラッシュのない /api', method: 'GET', path: '/api' },
    {
      name: '存在するパスへの違うメソッド（GET /api/entries/:id）',
      method: 'GET',
      path: '/api/entries/e1',
    },
    {
      name: '存在するパスへの違うメソッド（POST /api/entries/:id）',
      method: 'POST',
      path: '/api/entries/e1',
    },
    {
      name: '存在するパスへの違うメソッド（POST /api/changes）',
      method: 'POST',
      path: '/api/changes',
    },
    { name: '存在するパスへの違うメソッド（PUT /api/health）', method: 'PUT', path: '/api/health' },
  ])('$name は 404 で、本文は JSON（not_found）', async ({ method, path }) => {
    const res = await app.request(
      path,
      { method, headers: { ...sameOrigin, 'Content-Type': 'application/json' } },
      devEnv,
    );

    expect(res.status).toBe(404);
    expect(res.headers.get('Content-Type')).toContain('application/json');
    const body: unknown = await res.json();
    expect(body).toEqual(notFound);
    expect(apiErrorBodySchema.parse(body)).toEqual(notFound);
  });

  it('セキュリティヘッダーが付く', async () => {
    const res = await app.request('/api/nothing', { headers: sameOrigin }, devEnv);

    expect(res.headers.get('X-Content-Type-Options')).toBe('nosniff');
    expect(res.headers.get('Cache-Control')).toBe('no-store');
    expect(res.headers.get('Referrer-Policy')).toBe('no-referrer');
  });

  it('認証の前には出ない（JWT がなければ、存在しないパスも 403 のまま。存在を教えない）', async () => {
    const res = await app.request('/api/nothing', { headers: sameOrigin }, prodEnv);

    expect(res.status).toBe(403);
  });

  it('リクエストの確認の前にも出ない（他のサイトからの、存在しないパスへの書き込みは 403）', async () => {
    const res = await app.request(
      '/api/nothing',
      { method: 'PUT', headers: { 'Sec-Fetch-Site': 'cross-site' } },
      devEnv,
    );

    expect(res.status).toBe(403);
  });

  it('存在するエンドポイントは、404 にならない', async () => {
    const res = await app.request('/api/health', { headers: sameOrigin }, devEnv);

    expect(res.status).toBe(200);
  });

  it('/api/ の外のパスは、Hono の既定の 404（text/plain）のまま', async () => {
    const res = await app.request('/nothing', { headers: sameOrigin }, devEnv);

    expect(res.status).toBe(404);
    expect(res.headers.get('Content-Type')).toContain('text/plain');
    expect(await res.text()).toBe('404 Not Found');
  });
});

describe('Worker の入口（fetch と scheduled。設計書 1章）', () => {
  it('入口は、fetch（API と画面の応答）と、scheduled（定期実行）を持つ', () => {
    expect(worker.fetch).toBe(app.fetch);
    expect(worker.scheduled).toBe(scheduled);
  });

  it('入口の fetch は、これまでどおり、app の応答を返す', async () => {
    const res = await worker.fetch(
      new Request('http://localhost/api/health', { headers: sameOrigin }),
      devEnv,
    );

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true });
  });
});

describe('wrangler.jsonc の通知の設定', () => {
  // jsonc（コメントと、末尾のカンマがある JSON）を、JSON として読む。コメントは、行の先頭の // だけを消す
  // （値の中の https:// を消さないため）。
  const config = JSON.parse(
    readFileSync(new URL('../../wrangler.jsonc', import.meta.url), 'utf8')
      .replace(/^\s*\/\/.*$/gm, '')
      .replace(/,(\s*[}\]])/g, '$1'),
  ) as { triggers?: { crons?: string[] }; vars?: Record<string, string> };

  it('NT-5: 定期実行は、毎分（通知を、指定した時刻から 1 分以内に届けるため）', () => {
    expect(config.triggers?.crons).toEqual(['* * * * *']);
  });

  it('ENV-4: 通知のリンクの頭は、本番の URL（calendar.ataraman.com）', () => {
    expect(config.vars?.['APP_ORIGIN']).toBe('https://calendar.ataraman.com');
  });
});
