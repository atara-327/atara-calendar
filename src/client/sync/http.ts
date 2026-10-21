import type { z } from 'zod';
import { apiErrorBodySchema, writeResponseSchema, type ChangesResponse } from '../../shared/api';
import { structuralChangesResponseSchema } from '../../shared/structure';
import { toHttpRequest, type PendingRequest } from './requests';

// サーバーとの通信（設計書 5.1・6.2・6.3）。fetch を差し替えられるようにしてあるのは、テストで、
// Miniflare の Worker（本物の API）につなぐため。画面は、ブラウザの fetch をそのまま渡す。

export interface FetchInit {
  method: string;
  headers?: Record<string, string>;
  body?: string;
  redirect: 'manual';
  keepalive?: boolean;
}

/** 応答のうち、同期が読む部分だけ。ブラウザの Response が、そのまま満たす。 */
export interface FetchResponse {
  readonly type: string;
  readonly status: number;
  json(): Promise<unknown>;
}

export type FetchFn = (url: string, init: FetchInit) => Promise<FetchResponse>;

/**
 * 認証が通っていない応答か。401・403 と、Access のログイン画面への転送。
 * fetch に redirect: 'manual' を付けているので、転送は、type が 'opaqueredirect' の応答（status は 0）になる。
 * 付けないと、ログイン画面（別のオリジン）への転送を、ブラウザが追いかけて、CORS で失敗する。
 * 通信の失敗と区別がつかなくなり、ログインが切れたことを知らせられない。
 */
function isAuthFailure(response: FetchResponse): boolean {
  return response.type === 'opaqueredirect' || response.status === 401 || response.status === 403;
}

export type WriteOutcome =
  /** 200（applied: true も false も）。列から外して、次へ。 */
  | { kind: 'done' }
  /** API のエラー（4xx）。直らないので、列から外す。clockSkew は、端末の時計が進んでいる（edited_at_in_future）。 */
  | { kind: 'rejected'; clockSkew: boolean }
  /** ログインが切れている、または許可されていない。依頼は捨てずに、送信を止める。 */
  | { kind: 'auth' }
  /** 5xx・通信の失敗・API のエラーの形でない 4xx など。外さずに止めて、次のきっかけで再び試す。 */
  | { kind: 'retry' };

// 4xx は、依頼の中身が原因なので、何度送っても同じ結果になり、捨てる（設計書 6.2）。ただし、次の 2 つは捨てない。
// - 408（タイムアウト）と 429（回数の制限）。時間がたてば通る。Worker は返さないが、Cloudflare の前段が返しうる。
//   再び試すのは、次のきっかけ（編集・online・前面に戻る・60 秒ごと）でだけで、続けて繰り返さない（engine.ts の sendLoop）。
//   429 を、短い間に叩き続けることはない。
// - 本文が、API のエラーの形（apiErrorBodySchema）でない 4xx。Worker は、必ずその形で返す。
//   それ以外は、Cloudflare の前段の 400 や、配信の設定ミスの 404 など、依頼の中身ではなく、経路が原因なので、
//   捨てると、送信待ちが全部消える。再び試し続けても、「未送信 N件」で気づける。
const TRANSIENT_CLIENT_ERRORS: ReadonlySet<number> = new Set([408, 429]);

/** 書き込みの応答を、端末の次の動きに直す。 */
export async function classifyWriteResponse(response: FetchResponse): Promise<WriteOutcome> {
  if (isAuthFailure(response)) return { kind: 'auth' };
  if (response.status === 200) {
    // 200 でも、書き込みの応答の形でなければ、外さない。ログイン前の案内ページや、通信業者の中継ページが、
    // 200 の HTML を返すことがあり、それを成功として扱うと、送れていない変更が消える。
    return (await readJson(response, writeResponseSchema)) === undefined
      ? { kind: 'retry' }
      : { kind: 'done' };
  }
  if (
    response.status >= 400 &&
    response.status < 500 &&
    !TRANSIENT_CLIENT_ERRORS.has(response.status)
  ) {
    const body = await readJson(response, apiErrorBodySchema);
    if (body === undefined) return { kind: 'retry' };
    return { kind: 'rejected', clockSkew: body.error === 'edited_at_in_future' };
  }
  return { kind: 'retry' };
}

/** 応答の本文を、スキーマで確かめて返す。JSON として読めない、または形が合わなければ undefined。 */
async function readJson<S extends z.ZodType>(
  response: FetchResponse,
  schema: S,
): Promise<z.infer<S> | undefined> {
  try {
    const result = schema.safeParse(await response.json());
    return result.success ? result.data : undefined;
  } catch {
    return undefined;
  }
}

/** 依頼を 1 つ送る。keepalive は、タブが裏に回る・閉じるときの送信に付ける（設計書 6.6）。 */
export async function sendRequest(
  fetchFn: FetchFn,
  request: PendingRequest,
  { keepalive }: { keepalive: boolean },
): Promise<WriteOutcome> {
  const { method, url, body } = toHttpRequest(request);
  let response: FetchResponse;
  try {
    response = await fetchFn(url, {
      method,
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
      redirect: 'manual',
      ...(keepalive ? { keepalive: true } : {}),
    });
  } catch {
    // 電波がない・タイムアウトなど。送れたかどうかは分からないが、同じ依頼を何度送っても結果は変わらない
    // （サーバーが、2 回目を反映済みとして捨てる。設計書 6.2）ので、そのまま再送してよい。
    return { kind: 'retry' };
  }
  return classifyWriteResponse(response);
}

export type ReadOutcome =
  | { kind: 'ok'; changes: ChangesResponse }
  | { kind: 'auth' }
  /** 200 だが、応答が、読める形でない。当てずに、同期のエラーとして知らせる（設計書 6.3）。 */
  | { kind: 'invalid' }
  /** 5xx・通信の失敗など。次のきっかけで再び試す。 */
  | { kind: 'failed' };

/**
 * GET /api/changes。応答は、構造だけを見るスキーマで確かめる（shared/structure.ts）。
 * 入力のルール（15 分刻みなど）で弾くと、ルールを後で厳しくしたとき、すでにある行のために、全端末の
 * 受け取りが止まる（設計書 6.3）。
 */
export async function fetchChanges(fetchFn: FetchFn, since: number): Promise<ReadOutcome> {
  let response: FetchResponse;
  try {
    response = await fetchFn(`/api/changes?since=${String(since)}`, {
      method: 'GET',
      redirect: 'manual',
    });
  } catch {
    return { kind: 'failed' };
  }
  if (isAuthFailure(response)) return { kind: 'auth' };
  if (response.status !== 200) return { kind: 'failed' };
  const changes = await readJson(response, structuralChangesResponseSchema);
  return changes === undefined ? { kind: 'invalid' } : { kind: 'ok', changes };
}
