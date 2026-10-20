import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { unusedDb } from '../../test/helpers/env';
import type { Bindings } from './env';
import { app } from './index';

const devEnv: Bindings = { DB: unusedDb, ACCESS_TEAM_DOMAIN: '', ACCESS_AUD: '', AUTH_MODE: 'dev' };

// 本番と同じ設定（AUTH_MODE なし）。JWT のヘッダーを付けないので、鍵を取りに行く前に拒否される。
const prodEnv: Bindings = {
  DB: unusedDb,
  ACCESS_TEAM_DOMAIN: 'example-team.cloudflareaccess.com',
  ACCESS_AUD: 'test-audience',
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
