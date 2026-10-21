import { describe, expect, it } from 'vitest';
import { makeEntry } from '../../../test/helpers/entries';
import { makeWorkspace } from '../../../test/helpers/workspaces';
import {
  classifyWriteResponse,
  fetchChanges,
  sendRequest,
  type FetchFn,
  type FetchInit,
  type FetchResponse,
} from './http';
import type { PendingRequest } from './requests';

function response(status: number, body: unknown, type = 'basic'): FetchResponse {
  return { type, status, json: () => Promise.resolve(body) };
}

/** JSON として読めない本文（HTML など）の応答。 */
function htmlResponse(status: number): FetchResponse {
  return {
    type: 'basic',
    status,
    json: () => Promise.reject(new SyntaxError('Unexpected token <')),
  };
}

const deleteWorkspaceRequest: PendingRequest = {
  type: 'deleteWorkspace',
  targetId: 'w1',
  body: { editedAt: 2000 },
};

describe('書き込みの応答の扱い（設計書 6.2）', () => {
  it.each([
    { name: '200 で反映した（applied: true）', res: response(200, { applied: true }) },
    {
      name: '200 で捨てた（applied: false。別の端末の新しい編集に負けた）',
      res: response(200, { applied: false, reason: 'stale' }),
    },
    {
      name: '200 で捨てた（applied: false。対象がもうない）',
      res: response(200, { applied: false, reason: 'not_found' }),
    },
  ])('$name は、列から外して次へ進む', async ({ res }) => {
    expect(await classifyWriteResponse(res)).toEqual({ kind: 'done' });
  });

  it.each([
    { status: 400, error: 'invalid_request' },
    { status: 400, error: 'invalid_change' },
    { status: 400, error: 'builtin_workspace' },
    { status: 400, error: 'last_workspace' },
    { status: 404, error: 'not_found' },
    { status: 409, error: 'conflict' },
    { status: 415, error: undefined },
    { status: 413, error: undefined },
  ])(
    '$status $error は、直らないので、列から外す（時計のずれではない）',
    async ({ status, error }) => {
      const body = error === undefined ? { error: 'x' } : { error, message: '固定の文言' };
      expect(await classifyWriteResponse(response(status, body))).toEqual({
        kind: 'rejected',
        clockSkew: false,
      });
    },
  );

  it('400 edited_at_in_future は、列から外す。端末の時計がずれていることを、あわせて伝える', async () => {
    const res = response(400, { error: 'edited_at_in_future', message: '未来すぎます' });
    expect(await classifyWriteResponse(res)).toEqual({ kind: 'rejected', clockSkew: true });
  });

  it('4xx の本文が JSON でなくても、列から外す', async () => {
    expect(await classifyWriteResponse(htmlResponse(400))).toEqual({
      kind: 'rejected',
      clockSkew: false,
    });
  });

  it.each([
    { name: '401', res: response(401, { error: 'unauthorized' }) },
    { name: '403（認証・リクエストの確認）', res: response(403, { error: 'forbidden' }) },
    {
      name: 'Access のログイン画面への転送（opaqueredirect）',
      res: response(0, null, 'opaqueredirect'),
    },
  ])('$name は、依頼を捨てずに、送信を止める（Q6）', async ({ res }) => {
    expect(await classifyWriteResponse(res)).toEqual({ kind: 'auth' });
  });

  it.each([500, 502, 503, 504])('%i は、外さずに、次のきっかけで再び試す', async (status) => {
    expect(await classifyWriteResponse(response(status, { error: 'internal_error' }))).toEqual({
      kind: 'retry',
    });
  });

  it.each([408, 429])('%i は、時間がたてば通るので、4xx でも外さずに再び試す', async (status) => {
    expect(await classifyWriteResponse(response(status, { error: 'x' }))).toEqual({
      kind: 'retry',
    });
  });

  it.each([
    { name: '書き込みの応答の形でない JSON', res: response(200, { ok: true }) },
    { name: 'JSON でない本文（中継ページの HTML など）', res: htmlResponse(200) },
  ])('200 でも、$name は、成功として扱わず、外さずに再び試す', async ({ res }) => {
    expect(await classifyWriteResponse(res)).toEqual({ kind: 'retry' });
  });
});

describe('依頼の送信', () => {
  function recordingFetch(res: FetchResponse | Error) {
    const calls: { url: string; init: FetchInit }[] = [];
    const fetchFn: FetchFn = (url, init) => {
      calls.push({ url, init });
      return res instanceof Error ? Promise.reject(res) : Promise.resolve(res);
    };
    return { fetchFn, calls };
  }

  it('同じオリジンの /api/... に、JSON の本文と Content-Type を付け、転送を追わずに送る', async () => {
    const { fetchFn, calls } = recordingFetch(response(200, { applied: true }));

    await sendRequest(fetchFn, deleteWorkspaceRequest, { keepalive: false });

    expect(calls).toEqual([
      {
        url: '/api/workspaces/w1',
        init: {
          method: 'DELETE',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ editedAt: 2000 }),
          redirect: 'manual',
        },
      },
    ]);
  });

  it('keepalive を指定したときだけ、keepalive: true を付ける（タブが裏に回る・閉じるときの送信）', async () => {
    const { fetchFn, calls } = recordingFetch(response(200, { applied: true }));

    await sendRequest(fetchFn, deleteWorkspaceRequest, { keepalive: true });

    expect(calls[0]?.init.keepalive).toBe(true);
  });

  it.each([
    {
      name: '予定の作成',
      request: {
        type: 'putEntry',
        targetId: 'e1',
        body: {
          draft: {
            kind: 'event',
            title: 't',
            workspaceId: 'w1',
            allDay: true,
            startDate: '2026-10-19',
            startTime: null,
            endDate: '2026-10-19',
            endTime: null,
            location: null,
            url: null,
            memo: null,
            rrule: null,
            notifyEnabled: true,
            notifyOffsetMin: 0,
          },
          editedAt: 1,
        },
      } satisfies PendingRequest,
      method: 'PUT',
      url: '/api/entries/e1',
    },
    {
      name: '予定の変更',
      request: {
        type: 'patchEntry',
        targetId: 's1',
        body: { occurrenceDate: '2026-10-19', scope: 'all', changes: {}, newId: 'n1', editedAt: 1 },
      } satisfies PendingRequest,
      method: 'PATCH',
      url: '/api/entries/s1',
    },
    {
      name: '予定の削除',
      request: {
        type: 'deleteEntry',
        targetId: 's1',
        body: { occurrenceDate: '2026-10-19', scope: 'this', newId: 'n1', editedAt: 1 },
      } satisfies PendingRequest,
      method: 'DELETE',
      url: '/api/entries/s1',
    },
    {
      name: 'ワークスペースの作成・更新',
      request: {
        type: 'putWorkspace',
        body: { workspace: { ...makeWorkspace({ id: 'w9' }), deletedAt: null } },
      } satisfies PendingRequest,
      method: 'PUT',
      url: '/api/workspaces/w9',
    },
  ])('$name は、$method $url に送る', async ({ request, method, url }) => {
    const { fetchFn, calls } = recordingFetch(response(200, { applied: true }));

    await sendRequest(fetchFn, request, { keepalive: false });

    expect(calls[0]).toMatchObject({ url, init: { method } });
  });

  it('通信の失敗（電波がない・タイムアウトなど）は、外さずに再び試す', async () => {
    const { fetchFn } = recordingFetch(new TypeError('Failed to fetch'));
    expect(await sendRequest(fetchFn, deleteWorkspaceRequest, { keepalive: false })).toEqual({
      kind: 'retry',
    });
  });
});

describe('差分の受け取りの応答の扱い（設計書 6.3）', () => {
  const body = {
    rev: 3,
    epoch: 'abcd',
    workspaces: [makeWorkspace({ id: 'w1' })],
    entries: [makeEntry({ id: 'e1' })],
  };

  function fetching(res: FetchResponse | Error) {
    const calls: { url: string; init: FetchInit }[] = [];
    const fetchFn: FetchFn = (url, init) => {
      calls.push({ url, init });
      return res instanceof Error ? Promise.reject(res) : Promise.resolve(res);
    };
    return { fetchFn, calls };
  }

  it('GET /api/changes?since=<rev> を、転送を追わずに呼び、応答を返す', async () => {
    const { fetchFn, calls } = fetching(response(200, body));

    const outcome = await fetchChanges(fetchFn, 12);

    expect(calls).toEqual([
      { url: '/api/changes?since=12', init: { method: 'GET', redirect: 'manual' } },
    ]);
    expect(outcome).toEqual({ kind: 'ok', changes: body });
  });

  it('入力のルール（15 分刻み・#RRGGBB など）を満たさない行があっても、応答を受け取る', async () => {
    const lenient = {
      ...body,
      workspaces: [makeWorkspace({ id: 'w1', color: 'red' })],
      entries: [makeEntry({ id: 'e1', allDay: false, startTime: '09:07', endTime: '10:07' })],
    };
    const outcome = await fetchChanges(fetching(response(200, lenient)).fetchFn, 0);
    expect(outcome).toEqual({ kind: 'ok', changes: lenient });
  });

  it.each([
    { name: '構造の合わない行がある', res: response(200, { ...body, entries: [{ id: 'e1' }] }) },
    { name: 'rev がない', res: response(200, { ...body, rev: undefined }) },
    { name: 'JSON でない本文', res: htmlResponse(200) },
  ])('$name 応答は、当てずに、読めない応答として返す', async ({ res }) => {
    expect(await fetchChanges(fetching(res).fetchFn, 0)).toEqual({ kind: 'invalid' });
  });

  it.each([response(401, null), response(403, null), response(0, null, 'opaqueredirect')])(
    '認証が通っていない応答（%o）は、認証の問題として返す',
    async (res) => {
      expect(await fetchChanges(fetching(res).fetchFn, 0)).toEqual({ kind: 'auth' });
    },
  );

  it.each([response(500, null), response(503, null), response(404, null)])(
    '200 でない応答（%o）は、失敗として返す（次のきっかけで再び試す）',
    async (res) => {
      expect(await fetchChanges(fetching(res).fetchFn, 0)).toEqual({ kind: 'failed' });
    },
  );

  it('通信の失敗は、失敗として返す', async () => {
    expect(await fetchChanges(fetching(new TypeError('Failed to fetch')).fetchFn, 0)).toEqual({
      kind: 'failed',
    });
  });
});
