import { createMiddleware } from 'hono/factory';

/**
 * API の応答に付けるヘッダー。next() のあとに付けるのは、認証が返す 403 などにも付けるため。
 * Cache-Control: no-store は、予定のデータが共有のキャッシュや端末の履歴に残らないようにする。
 */
export const apiSecurityHeaders = createMiddleware(async (c, next) => {
  await next();
  c.header('X-Content-Type-Options', 'nosniff');
  c.header('Cache-Control', 'no-store');
  c.header('Referrer-Policy', 'no-referrer');
});

const READ_METHODS = new Set(['GET', 'HEAD']);

function isJson(contentType: string | undefined): boolean {
  return contentType?.split(';')[0]?.trim().toLowerCase() === 'application/json';
}

/**
 * 他のサイトから、ログイン状態を悪用して書き込まれるのを防ぐ（設計書 10.3）。
 *
 * Sec-Fetch-Site がないときに拒否しないのは、ブラウザ以外（将来の MCP など）は付けないため。
 * 今のブラウザは必ず付けるので、ブラウザ経由の攻撃はここで止まる。ブラウザ以外からは、
 * そもそもログインの Cookie を悪用されない。
 */
export const guardWrites = createMiddleware(async (c, next) => {
  if (READ_METHODS.has(c.req.method)) {
    await next();
    return;
  }

  const site = c.req.header('Sec-Fetch-Site');
  if (site !== undefined && site !== 'same-origin') {
    return c.json({ error: 'forbidden' }, 403);
  }

  // 本文の有無は Content-Length ではなく body で見る。chunked のように、長さを書かない送り方があるため。
  if (c.req.raw.body !== null && !isJson(c.req.header('Content-Type'))) {
    return c.json({ error: 'unsupported_media_type' }, 415);
  }

  await next();
});
