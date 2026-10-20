import { Hono } from 'hono';
import { describe, expect, it } from 'vitest';
import { apiSecurityHeaders, guardWrites } from './security';

function buildApp() {
  const app = new Hono();
  app.use('/api/*', apiSecurityHeaders, guardWrites);
  app.all('/api/echo', (c) => c.json({ ok: true }));
  return app;
}

const json = (value: unknown) => new TextEncoder().encode(JSON.stringify(value));

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
    const res = await buildApp().request('/api/echo');

    expect(res.status).toBe(200);
    expect(pick(res)).toEqual(expected);
  });

  it('見つからない（404）応答にも付ける', async () => {
    const res = await buildApp().request('/api/missing');

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
});

describe('他のサイトからの書き込みの拒否（NF-2。設計書 10.3）', () => {
  describe('Sec-Fetch-Site', () => {
    it.each(['GET', 'HEAD'])(
      '%s は、他のサイトからでも拒否しない（読み取りは対象外）',
      async (method) => {
        const res = await buildApp().request('/api/echo', {
          method,
          headers: { 'Sec-Fetch-Site': 'cross-site' },
        });

        expect(res.status).toBe(200);
      },
    );

    it.each(['PUT', 'POST', 'PATCH', 'DELETE'])('%s で same-origin なら通す', async (method) => {
      const res = await buildApp().request('/api/echo', {
        method,
        headers: { 'Sec-Fetch-Site': 'same-origin' },
      });

      expect(res.status).toBe(200);
    });

    it.each(['cross-site', 'same-site', 'none'])(
      'Sec-Fetch-Site が %s の PUT は 403',
      async (site) => {
        const res = await buildApp().request('/api/echo', {
          method: 'PUT',
          headers: { 'Sec-Fetch-Site': site, 'Content-Type': 'application/json' },
          body: json({ title: 'x' }),
        });

        expect(res.status).toBe(403);
      },
    );

    it.each(['PUT', 'POST', 'PATCH', 'DELETE', 'OPTIONS'])(
      '本文がなくても、他のサイトからの %s は 403',
      async (method) => {
        const res = await buildApp().request('/api/echo', {
          method,
          headers: { 'Sec-Fetch-Site': 'cross-site' },
        });

        expect(res.status).toBe(403);
      },
    );

    it('Sec-Fetch-Site がなければ（ブラウザ以外。将来の MCP など）通す', async () => {
      const res = await buildApp().request('/api/echo', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: json({ title: 'x' }),
      });

      expect(res.status).toBe(200);
    });

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
      '本文があって Content-Type が %s なら通す',
      async (contentType) => {
        const res = await buildApp().request('/api/echo', {
          method: 'PUT',
          headers: { 'Sec-Fetch-Site': 'same-origin', 'Content-Type': contentType },
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
    ])('本文があって Content-Type が %s なら 415', async (contentType) => {
      const res = await buildApp().request('/api/echo', {
        method: 'PUT',
        headers: { 'Sec-Fetch-Site': 'same-origin', 'Content-Type': contentType },
        body: json({ title: 'x' }),
      });

      expect(res.status).toBe(415);
    });

    it('本文があって Content-Type がなければ 415', async () => {
      const res = await buildApp().request('/api/echo', {
        method: 'PUT',
        headers: { 'Sec-Fetch-Site': 'same-origin' },
        body: json({ title: 'x' }),
      });

      expect(res.status).toBe(415);
    });

    it('Sec-Fetch-Site がないときも、JSON でない本文は 415', async () => {
      const res = await buildApp().request('/api/echo', {
        method: 'POST',
        headers: { 'Content-Type': 'text/plain' },
        body: 'x',
      });

      expect(res.status).toBe(415);
    });

    it.each(['PUT', 'POST', 'PATCH', 'DELETE'])(
      '本文がない %s は、Content-Type がなくても通す',
      async (method) => {
        const res = await buildApp().request('/api/echo', {
          method,
          headers: { 'Sec-Fetch-Site': 'same-origin' },
        });

        expect(res.status).toBe(200);
      },
    );

    it('GET は、本文の確認の対象にならない', async () => {
      const res = await buildApp().request('/api/echo', {
        headers: { 'Content-Type': 'text/plain' },
      });

      expect(res.status).toBe(200);
    });
  });
});
