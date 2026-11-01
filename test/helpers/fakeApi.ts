import type { ApiEnv } from '../../mcp/apiClient';
import { createEditedAtClock } from '../../mcp/editedAtClock';
import type { ToolDeps } from '../../mcp/tools';

/** 偽の fetch が受け取った依頼。headers のキーは小文字。 */
export interface RecordedRequest {
  method: string;
  /** ベース URL を除いた、パスとクエリ。 */
  path: string;
  headers: Record<string, string>;
  body: unknown;
  redirect: RequestRedirect | undefined;
}

/** 偽の応答。Error は、通信の失敗（fetch が例外を投げる）。 */
export type FakeReply = Response | Error;

export function jsonReply(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

export const BASE_URL = 'https://calendar.example.test';

/**
 * 本物の通信をしない API の環境と、受け取った依頼の記録。
 * respond は、依頼ごとに応答を決める。時計・UUID・ログも偽物（設計書 3章の、env を引数で受ける決まり）。
 */
export function createFakeApi(respond: (request: RecordedRequest, index: number) => FakeReply) {
  const requests: RecordedRequest[] = [];
  const logs: string[] = [];
  const fakeFetch: typeof fetch = (input, init) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
    const headers = Object.fromEntries(
      Object.entries((init?.headers ?? {}) as Record<string, string>).map(([key, value]) => [
        key.toLowerCase(),
        value,
      ]),
    );
    const request: RecordedRequest = {
      method: init?.method ?? 'GET',
      path: url.slice(BASE_URL.length),
      headers,
      body: typeof init?.body === 'string' ? JSON.parse(init.body) : undefined,
      redirect: init?.redirect,
    };
    requests.push(request);
    const reply = respond(request, requests.length - 1);
    return reply instanceof Error ? Promise.reject(reply) : Promise.resolve(reply);
  };
  const api: ApiEnv = {
    fetch: fakeFetch,
    baseUrl: BASE_URL,
    clientId: 'test-client-id',
    clientSecret: 'test-client-secret',
    timeoutMs: 1000,
    log: (message) => logs.push(message),
  };
  return { api, requests, logs };
}

/** 連番の UUID の代わり（'id-1'・'id-2'…。idInputSchema を通る形）と、今の時刻が固定の時計。 */
export function createFakeDeps(
  api: ApiEnv,
  { nowMs = 1_000_000 }: { nowMs?: number } = {},
): ToolDeps {
  let count = 0;
  return {
    api,
    newId: () => `id-${String((count += 1))}`,
    nextEditedAt: createEditedAtClock(() => nowMs),
  };
}
