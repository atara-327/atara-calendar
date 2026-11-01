import {
  apiErrorBodySchema,
  writeResponseSchema,
  type ApiErrorKind,
  type WriteDropReason,
} from '../src/shared/api';

// Worker の API（設計書 5章）を呼ぶ部分。fetch・ログ・待ち時間は、引数の env で受け取る（設計書 3章）。

export interface ApiEnv {
  fetch: typeof fetch;
  /** 末尾のスラッシュを除いた URL。 */
  baseUrl: string;
  clientId: string;
  clientSecret: string;
  /** 1 回の呼び出しを待つ上限（ミリ秒）。超えたら通信の失敗として扱う。 */
  timeoutMs: number;
  /** 標準エラー出力へ。標準出力は MCP のやり取り専用（設計書 13.2）。 */
  log: (message: string) => void;
}

/** 呼び出しが失敗した理由。応答の本文や、ヘッダー（トークン）は持たない。 */
export type ApiFailure =
  /** 応答が返らなかった（接続できない・時間切れ）。 */
  | { kind: 'network' }
  | { kind: 'server'; status: number }
  /** Access に断られた（401・403・ログイン画面への転送）。 */
  | { kind: 'auth'; status: number }
  | { kind: 'client'; status: number; error: ApiErrorKind | null };

export type ApiResult = { ok: true; body: unknown } | { ok: false; failure: ApiFailure };

function classify(status: number): ApiFailure['kind'] | null {
  if (status >= 200 && status < 300) return null;
  if (status >= 500) return 'server';
  if (status === 401 || status === 403 || (status >= 300 && status < 400)) return 'auth';
  return 'client';
}

export async function callApi(
  env: ApiEnv,
  method: 'GET' | 'PUT' | 'PATCH' | 'DELETE',
  path: string,
  body?: unknown,
): Promise<ApiResult> {
  const headers: Record<string, string> = {
    'CF-Access-Client-Id': env.clientId,
    'CF-Access-Client-Secret': env.clientSecret,
    Accept: 'application/json',
  };
  if (body !== undefined) headers['Content-Type'] = 'application/json';

  let response: Response;
  try {
    response = await env.fetch(`${env.baseUrl}${path}`, {
      method,
      headers,
      body: body === undefined ? undefined : JSON.stringify(body),
      // Why 転送を追わないのか: トークンのヘッダーを、転送先に送らないため。Access が断ると、ログイン画面へ
      // 転送される。追うと、ログイン画面の HTML が 200 で返り、認証の失敗と分からない。
      redirect: 'manual',
      signal: AbortSignal.timeout(env.timeoutMs),
    });
  } catch {
    // 例外の中身は見ない。接続先の URL などが入りうるうえ、利用者に伝える内容が変わらない。
    env.log(`${method} ${path}: 通信に失敗しました`);
    return { ok: false, failure: { kind: 'network' } };
  }

  const kind = classify(response.status);
  if (kind === null) {
    try {
      return { ok: true, body: await response.json() };
    } catch {
      // 応答の本文が途中で切れたとき。書き込みが保存されたかは分からないので、通信の失敗と同じ扱いにする。
      env.log(`${method} ${path}: 応答を読めませんでした`);
      return { ok: false, failure: { kind: 'network' } };
    }
  }

  env.log(`${method} ${path}: HTTP ${String(response.status)}`);
  if (kind === 'server' || kind === 'auth') {
    return { ok: false, failure: { kind, status: response.status } };
  }
  const parsed = apiErrorBodySchema.safeParse(await response.json().catch(() => null));
  return {
    ok: false,
    failure: {
      kind: 'client',
      status: response.status,
      error: parsed.success ? parsed.data.error : null,
    },
  };
}

export type WriteOutcome =
  | { kind: 'applied' }
  | { kind: 'dropped'; reason: WriteDropReason; retried: boolean }
  | { kind: 'failed'; failure: ApiFailure; retried: boolean };

function isTransportFailure(failure: ApiFailure): boolean {
  return failure.kind === 'network' || failure.kind === 'server';
}

/**
 * 書き込みを送る。通信の失敗（応答がない・5xx）のときは、同じ依頼（同じ本文）で 1 回だけ送り直す（設計書 13.4）。
 * Why 同じ本文で送り直すのか: 1 回目が保存されたのに応答だけが失われたとき、新しい依頼として作り直すと、予定が
 * 2 つできる。同じ id・editedAt なら、2 回目はサーバーが stale で捨てる（設計書 5.1）。
 * Why 2 回までなのか: 何度も送り直すと、Claude への返事が長く止まる。それでも失敗なら、確かめるのは利用者に任せる。
 * 4xx と 200（applied: false）は、直らない（または結果が決まっている）ので送り直さない。
 */
export async function sendWrite(
  env: ApiEnv,
  method: 'PUT' | 'PATCH' | 'DELETE',
  path: string,
  body: unknown,
): Promise<WriteOutcome> {
  let retried = false;
  for (;;) {
    const result = await callApi(env, method, path, body);
    if (result.ok) {
      const parsed = writeResponseSchema.safeParse(result.body);
      if (!parsed.success) {
        // 200 なのに形が違う。反映されたか分からないので、送り直さず、失敗として返す。
        env.log(`${method} ${path}: 応答の形が想定と違います`);
        return { kind: 'failed', failure: { kind: 'server', status: 200 }, retried };
      }
      return parsed.data.applied
        ? { kind: 'applied' }
        : { kind: 'dropped', reason: parsed.data.reason, retried };
    }
    if (isTransportFailure(result.failure) && !retried) {
      retried = true;
      continue;
    }
    return { kind: 'failed', failure: result.failure, retried };
  }
}
