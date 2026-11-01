import { createMiddleware } from 'hono/factory';
import type { AppEnv } from './env';

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
 * 他のサイトから、ログイン状態を悪用してリクエストされるのを防ぐ（設計書 10.3）。
 *
 * Sec-Fetch-Site は、GET・HEAD を含むすべてのメソッドで、same-origin だけを通す。ヘッダーがないものも拒否する。
 * ただし、サービストークン（MCP）で入ってきたリクエストは確かめない（設計書 13.2）。防ぐのは、ブラウザの
 * ログイン状態を悪用する攻撃で、サービストークンはブラウザのログイン状態とは別の鍵だから。
 * Why not MCP にヘッダーを付けさせる: ブラウザ以外は自由に付けられ、守りにならない。
 *
 * GET・HEAD 以外は、本文の有無に関係なく Content-Type: application/json を必須にする。
 * 本文があるときだけ確かめる形にしないのは、環境で結果が変わるため。ブラウザは本文のない PUT にも
 * Content-Length: 0 を付け、workerd ではそのとき body が null にならない。書き込みの API はすべて
 * JSON の本文を持つ（設計書 5.1）ので、正しいリクエストは必ず満たす。
 */
export const guardRequests = createMiddleware<AppEnv>(async (c, next) => {
  if (c.get('actor').kind !== 'service' && c.req.header('Sec-Fetch-Site') !== 'same-origin') {
    return c.json({ error: 'forbidden' }, 403);
  }

  if (!READ_METHODS.has(c.req.method) && !isJson(c.req.header('Content-Type'))) {
    return c.json({ error: 'unsupported_media_type' }, 415);
  }

  await next();
});
