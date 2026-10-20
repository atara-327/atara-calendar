import { Hono } from 'hono';
import { describe, expect, it } from 'vitest';
import { apiSecurityHeaders, guardRequests } from './security';

function buildApp() {
  const app = new Hono();
  app.use('/api/*', apiSecurityHeaders, guardRequests);
  app.all('/api/echo', (c) => c.json({ ok: true }));
  return app;
}

const json = (value: unknown) => new TextEncoder().encode(JSON.stringify(value));

const sameOrigin = { 'Sec-Fetch-Site': 'same-origin' };
const readMethods = ['GET', 'HEAD'];
const writeMethods = ['PUT', 'POST', 'PATCH', 'DELETE'];
const allMethods = [...readMethods, ...writeMethods, 'OPTIONS'];

describe('API の応答ヘッダー（NF-2）', () => {
  const expected = {
    'x-content-type-options': 'nosniff',
    'cache-control': 'no-store',
    'referrer-policy': 'no-referrer',
  };

  function pick(res: Response) {
    return Object.fromEntries(
      Object.keys(expected).map((name) => [name, res.headers.get(name)] as const),
    );
  }

  it('成功した応答に、nosniff・no-store・no-referrer を付ける', async () => {
    const res = await buildApp().request('/api/echo', { headers: sameOrigin });

    expect(res.status).toBe(200);
    expect(pick(res)).toEqual(expected);
  });

  it('見つからない（404）応答にも付ける', async () => {
    const res = await buildApp().request('/api/missing', { headers: sameOrigin });

    expect(res.status).toBe(404);
    expect(pick(res)).toEqual(expected);
  });

  it('拒否した（403）応答にも付ける', async () => {
    const res = await buildApp().request('/api/echo', {
      method: 'PUT',
      headers: { 'Sec-Fetch-Site': 'cross-site' },
    });

    expect(res.status).toBe(403);
    expect(pick(res)).toEqual(expected);
  });

  it('JSON でない（415）応答にも付ける', async () => {
    const res = await buildApp().request('/api/echo', { method: 'PUT', headers: sameOrigin });

    expect(res.status).toBe(415);
    expect(pick(res)).toEqual(expected);
  });
});

describe('他のサイトからのリクエストの拒否（NF-2。設計書 10.3）', () => {
  describe('Sec-Fetch-Site', () => {
    it.each(readMethods)('%s で same-origin なら通す', async (method) => {
      const res = await buildApp().request('/api/echo', { method, headers: sameOrigin });

      expect(res.status).toBe(200);
    });

    it.each(writeMethods)('%s で same-origin で JSON なら通す', async (method) => {
      const res = await buildApp().request('/api/echo', {
        method,
        headers: { ...sameOrigin, 'Content-Type': 'application/json' },
        body: json({ title: 'x' }),
      });

      expect(res.status).toBe(200);
    });

    it.each(
      allMethods.flatMap((method) =>
        ['cross-site', 'same-site', 'none'].map((site) => [method, site] as const),
      ),
    )('%s で Sec-Fetch-Site が %s なら 403（読み取りも拒否する）', async (method, site) => {
      const res = await buildApp().request('/api/echo', {
        method,
        headers: { 'Sec-Fetch-Site': site, 'Content-Type': 'application/json' },
      });

      expect(res.status).toBe(403);
    });

    it.each(allMethods)(
      'Sec-Fetch-Site がなければ（ブラウザ以外でも）%s は 403',
      async (method) => {
        const res = await buildApp().request('/api/echo', {
          method,
          headers: { 'Content-Type': 'application/json' },
        });

        expect(res.status).toBe(403);
      },
    );

    it('他のサイトからで、JSON でもない書き込みは、415 ではなく 403', async () => {
      const res = await buildApp().request('/api/echo', {
        method: 'POST',
        headers: { 'Sec-Fetch-Site': 'cross-site', 'Content-Type': 'text/plain' },
        body: 'x',
      });

      expect(res.status).toBe(403);
    });
  });

  describe('Content-Type', () => {
    it.each(['application/json', 'application/json; charset=utf-8', 'Application/JSON'])(
      '書き込みで Content-Type が %s なら通す',
      async (contentType) => {
        const res = await buildApp().request('/api/echo', {
          method: 'PUT',
          headers: { ...sameOrigin, 'Content-Type': contentType },
          body: json({ title: 'x' }),
        });

        expect(res.status).toBe(200);
      },
    );

    it.each([
      'text/plain',
      'text/plain;charset=UTF-8',
      'application/x-www-form-urlencoded',
      'multipart/form-data; boundary=x',
      'application/jsonp',
      'text/json',
    ])('書き込みで Content-Type が %s なら 415', async (contentType) => {
      const res = await buildApp().request('/api/echo', {
        method: 'PUT',
        headers: { ...sameOrigin, 'Content-Type': contentType },
        body: json({ title: 'x' }),
      });

      expect(res.status).toBe(415);
    });

    it('本文があって Content-Type がなければ 415', async () => {
      const res = await buildApp().request('/api/echo', {
        method: 'PUT',
        headers: sameOrigin,
        body: json({ title: 'x' }),
      });

      expect(res.status).toBe(415);
    });

    it.each(writeMethods)(
      '本文がなくても、Content-Type が JSON でなければ、%s は 415',
      async (method) => {
        const res = await buildApp().request('/api/echo', { method, headers: sameOrigin });

        expect(res.status).toBe(415);
      },
    );

    it('本文がなくても、Content-Type が JSON なら通す（本文の有無は見ない）', async () => {
      const res = await buildApp().request('/api/echo', {
        method: 'PUT',
        headers: { ...sameOrigin, 'Content-Type': 'application/json' },
      });

      expect(res.status).toBe(200);
    });

    it.each(readMethods)('%s は、Content-Type の確認の対象にならない', async (method) => {
      const res = await buildApp().request('/api/echo', {
        method,
        headers: { ...sameOrigin, 'Content-Type': 'text/plain' },
      });

      expect(res.status).toBe(200);
    });
  });
});
