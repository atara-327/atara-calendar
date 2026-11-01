import { describe, expect, it } from 'vitest';
import type { ApiErrorKind } from '../src/shared/api';
import {
  createFakeApi,
  createFakeDeps,
  jsonReply,
  type FakeReply,
  type RecordedRequest,
} from '../test/helpers/fakeApi';
import { makeOccurrence } from '../test/helpers/entries';
import { makeWorkspace } from '../test/helpers/workspaces';
import type { Workspace } from '../src/shared/schema';
import type { Occurrence } from '../src/shared/recurrence';
import { createTools, splitPeriod, type ToolDeps } from './tools';

// 応答の組み立て。
function changesReply(workspaces: Workspace[]): Response {
  return jsonReply({ rev: 1, epoch: 'e', workspaces, entries: [] });
}

function occurrencesReply(
  occurrences: Occurrence[] = [],
  named: {
    holidays?: { date: string; name: string }[];
    observances?: { date: string; name: string }[];
  } = {},
): Response {
  return jsonReply({
    occurrences,
    holidays: named.holidays ?? [],
    observances: named.observances ?? [],
  });
}

const APPLIED = (): Response => jsonReply({ applied: true });
const NETWORK_ERROR = (): Error => new TypeError('fetch failed');

function setup(respond: (request: RecordedRequest, index: number) => FakeReply, nowMs?: number) {
  const fake = createFakeApi(respond);
  const deps: ToolDeps = createFakeDeps(fake.api, nowMs === undefined ? {} : { nowMs });
  return { ...fake, tools: createTools(deps) };
}

function parse(text: string): unknown {
  return JSON.parse(text);
}

const OFFICE = makeWorkspace({ id: 'office', name: '仕事', color: '#4FC3F7', sortOrder: 1 });
const HOME = makeWorkspace({ id: 'home', name: '家', color: '#E57373', sortOrder: 0 });

describe('splitPeriod（MC-1）', () => {
  it('31 日以内なら、1 つの期間のまま', () => {
    expect(splitPeriod('2026-01-01', '2026-01-31')).toEqual([
      { from: '2026-01-01', to: '2026-01-31' },
    ]);
    expect(splitPeriod('2026-01-01', '2026-01-01')).toEqual([
      { from: '2026-01-01', to: '2026-01-01' },
    ]);
  });

  it('32 日なら、31 日と 1 日に分ける', () => {
    expect(splitPeriod('2026-01-01', '2026-02-01')).toEqual([
      { from: '2026-01-01', to: '2026-01-31' },
      { from: '2026-02-01', to: '2026-02-01' },
    ]);
  });

  it('366 日は、12 の期間になり、すき間も重なりもない', () => {
    const periods = splitPeriod('2026-01-01', '2027-01-01');
    expect(periods).toHaveLength(12);
    expect(periods[0]?.from).toBe('2026-01-01');
    expect(periods[11]?.to).toBe('2027-01-01');
    for (const [index, period] of periods.entries()) {
      const next = periods[index + 1];
      if (next !== undefined) {
        expect(new Date(next.from).getTime() - new Date(period.to).getTime()).toBe(86_400_000);
      }
    }
  });

  it('from が to より後なら、期間はない', () => {
    expect(splitPeriod('2026-01-02', '2026-01-01')).toEqual([]);
  });
});

describe('list_events（MC-1）', () => {
  it('期間を 31 日ずつに区切って、API を呼ぶ', async () => {
    const { tools, requests } = setup((request) =>
      request.path.startsWith('/api/changes') ? changesReply([]) : occurrencesReply(),
    );
    await tools.listEvents({ from: '2026-01-01', to: '2026-03-31' });
    expect(
      requests.filter(({ path }) => path.startsWith('/api/occurrences')).map(({ path }) => path),
    ).toEqual([
      '/api/occurrences?from=2026-01-01&to=2026-01-31',
      '/api/occurrences?from=2026-02-01&to=2026-03-03',
      '/api/occurrences?from=2026-03-04&to=2026-03-31',
    ]);
  });

  it('366 日までは受け付け、367 日以上は API を呼ばずに断る', async () => {
    const accepted = setup((request) =>
      request.path.startsWith('/api/changes') ? changesReply([]) : occurrencesReply(),
    );
    expect((await accepted.tools.listEvents({ from: '2026-01-01', to: '2027-01-01' })).ok).toBe(
      true,
    );
    expect(
      accepted.requests.filter(({ path }) => path.startsWith('/api/occurrences')),
    ).toHaveLength(12);

    const refused = setup(() => occurrencesReply());
    const result = await refused.tools.listEvents({ from: '2026-01-01', to: '2027-01-02' });
    expect(result.ok).toBe(false);
    expect(result.text).toContain('366 日');
    expect(refused.requests).toHaveLength(0);
  });

  it('各回に、ワークスペースの名前を添える。タイムブロックは null', async () => {
    const event = makeOccurrence({ workspaceId: 'office', title: '会議' });
    const block = makeOccurrence({ id: 'e2', kind: 'block', workspaceId: null, title: '作業' });
    const { tools } = setup((request) =>
      request.path.startsWith('/api/changes')
        ? changesReply([OFFICE, HOME])
        : occurrencesReply([event, block]),
    );
    const result = await tools.listEvents({ from: '2026-10-19', to: '2026-10-19' });
    const body = parse(result.text) as {
      occurrences: { title: string; workspaceName: string | null }[];
    };
    expect(body.occurrences.map(({ title, workspaceName }) => [title, workspaceName])).toEqual([
      ['会議', '仕事'],
      ['作業', null],
    ]);
  });

  it('各回に、update_event・delete_event に渡す seriesId・occurrenceDate・recurring を含める', async () => {
    const occurrence = makeOccurrence({
      id: 'series-1',
      workspaceId: 'office',
      rrule: { freq: 'daily' },
    });
    const { tools } = setup((request) =>
      request.path.startsWith('/api/changes')
        ? changesReply([OFFICE])
        : occurrencesReply([occurrence]),
    );
    const body = parse((await tools.listEvents({ from: '2026-10-19', to: '2026-10-19' })).text) as {
      occurrences: Record<string, unknown>[];
    };
    expect(body.occurrences[0]).toMatchObject({
      seriesId: 'series-1',
      occurrenceDate: '2026-10-19',
      recurring: true,
    });
  });

  it('期間の区切りをまたぐ予定は、1 回だけ返す', async () => {
    const spanning = makeOccurrence({ id: 'trip', startDate: '2026-01-30', endDate: '2026-02-02' });
    const { tools } = setup((request) =>
      request.path.startsWith('/api/changes')
        ? changesReply([OFFICE])
        : occurrencesReply([spanning]),
    );
    const body = parse((await tools.listEvents({ from: '2026-01-01', to: '2026-02-28' })).text) as {
      occurrences: unknown[];
    };
    expect(body.occurrences).toHaveLength(1);
  });

  it('期間をまたいで、祝日・記念日を集める', async () => {
    const { tools } = setup((request) => {
      if (request.path.startsWith('/api/changes')) return changesReply([]);
      return request.path.includes('from=2026-01-01')
        ? occurrencesReply([], { holidays: [{ date: '2026-01-01', name: '元日' }] })
        : occurrencesReply([], { observances: [{ date: '2026-02-14', name: 'バレンタインデー' }] });
    });
    const body = parse((await tools.listEvents({ from: '2026-01-01', to: '2026-02-28' })).text);
    expect(body).toMatchObject({
      holidays: [{ date: '2026-01-01', name: '元日' }],
      observances: [{ date: '2026-02-14', name: 'バレンタインデー' }],
    });
  });

  it('API が断ったら、Claude に伝えられる文言で失敗を返す', async () => {
    const { tools } = setup(() => jsonReply({ error: 'forbidden' }, 403));
    const result = await tools.listEvents({ from: '2026-01-01', to: '2026-01-02' });
    expect(result.ok).toBe(false);
    expect(result.text).toContain('Client ID');
  });

  it('通信できなければ、送り直さずに失敗を返す（読み取りは、やり直しても結果が変わらない）', async () => {
    const { tools, requests } = setup(() => NETWORK_ERROR());
    const result = await tools.listEvents({ from: '2026-01-01', to: '2026-01-02' });
    expect(result).toMatchObject({ ok: false });
    expect(requests).toHaveLength(1);
  });
});

describe('list_workspaces（MC-3）', () => {
  it('削除済みと組み込みを除き、並び順で、id・名前・色（と色の名前）を返す', async () => {
    const { tools } = setup(() =>
      changesReply([
        OFFICE,
        HOME,
        makeWorkspace({ id: 'gone', name: '消した', deletedAt: 5 }),
        makeWorkspace({ id: 'builtin-holiday', name: '祝日', builtin: 'holiday', sortOrder: 9999 }),
        makeWorkspace({ id: 'custom', name: '自由', color: '#123456', sortOrder: 2 }),
      ]),
    );
    const result = await tools.listWorkspaces();
    expect(parse(result.text)).toEqual({
      workspaces: [
        { id: 'home', name: '家', color: '#E57373', colorName: 'トマト' },
        { id: 'office', name: '仕事', color: '#4FC3F7', colorName: 'ピーコック' },
        { id: 'custom', name: '自由', color: '#123456', colorName: null },
      ],
    });
  });
});

describe('書き込みのヘッダーと本文（MC-2・MC-4）', () => {
  const draftInput = {
    kind: 'event',
    title: '歯医者',
    workspaceId: 'office',
    startDate: '2026-10-19',
    startTime: '15:00',
    endDate: '2026-10-19',
    endTime: '16:00',
  } as const;

  it('読み取りにも書き込みにも、サービストークンのヘッダーを付ける', async () => {
    const { tools, requests } = setup((request) =>
      request.method === 'GET' ? changesReply([]) : APPLIED(),
    );
    await tools.listWorkspaces();
    await tools.createEvent(draftInput);
    expect(requests.map(({ method }) => method)).toEqual(['GET', 'PUT']);
    for (const { headers } of requests) {
      expect(headers['cf-access-client-id']).toBe('test-client-id');
      expect(headers['cf-access-client-secret']).toBe('test-client-secret');
    }
  });

  it('書き込みには JSON の Content-Type を付ける（サーバーが確かめる。設計書 10.3）', async () => {
    const { tools, requests } = setup(() => APPLIED());
    await tools.createEvent(draftInput);
    expect(requests[0]?.headers['content-type']).toBe('application/json');
  });

  it('転送を追わない（トークンを転送先に送らない）', async () => {
    const { tools, requests } = setup(() => changesReply([]));
    await tools.listWorkspaces();
    expect(requests[0]?.redirect).toBe('manual');
  });

  it('Access の転送（ログイン画面）は、認証の失敗として伝える', async () => {
    const { tools } = setup(
      () =>
        new Response(null, {
          status: 302,
          headers: { Location: 'https://example.cloudflareaccess.com/' },
        }),
    );
    const result = await tools.createEvent(draftInput);
    expect(result.ok).toBe(false);
    expect(result.text).toContain('認証に失敗しました');
  });

  it('ログに、トークンを出さない', async () => {
    const { tools, logs } = setup(() => jsonReply({ error: 'forbidden' }, 403));
    await tools.createEvent(draftInput);
    expect(logs.length).toBeGreaterThan(0);
    expect(logs.join('\n')).not.toContain('test-client-secret');
    expect(logs.join('\n')).not.toContain('test-client-id');
  });

  it('create_event: id（UUID の代わり）を URL に使い、反映したら、その id を伝える', async () => {
    const { tools, requests } = setup(() => APPLIED());
    const result = await tools.createEvent(draftInput);
    expect(requests[0]).toMatchObject({ method: 'PUT', path: '/api/entries/id-1' });
    expect(result).toEqual({ ok: true, text: '予定「歯医者」を作りました（id: id-1）' });
  });

  it('create_event: 省略した項目は、空・繰り返さない・要件 NT-2〜4 の通知の初期値になる', async () => {
    const { tools, requests } = setup(() => APPLIED());
    await tools.createEvent(draftInput);
    await tools.createEvent({
      kind: 'event',
      title: '誕生日',
      workspaceId: 'office',
      allDay: true,
      startDate: '2026-10-20',
      endDate: '2026-10-20',
    });
    await tools.createEvent({ ...draftInput, kind: 'block', workspaceId: undefined });
    const drafts = requests.map(({ body }) => (body as { draft: Record<string, unknown> }).draft);
    expect(drafts[0]).toMatchObject({
      allDay: false,
      location: null,
      url: null,
      memo: null,
      rrule: null,
      notifyEnabled: true,
      notifyOffsetMin: 10,
    });
    expect(drafts[1]).toMatchObject({
      allDay: true,
      startTime: null,
      endTime: null,
      notifyEnabled: true,
      notifyOffsetMin: -360,
    });
    expect(drafts[2]).toMatchObject({ kind: 'block', workspaceId: null, notifyEnabled: false });
  });

  it('create_event: 繰り返しのルールをそのまま送る', async () => {
    const { tools, requests } = setup(() => APPLIED());
    await tools.createEvent({ ...draftInput, rrule: { freq: 'weekly', days: [1, 3] } });
    expect((requests[0]?.body as { draft: { rrule: unknown } }).draft.rrule).toEqual({
      freq: 'weekly',
      days: [1, 3],
    });
  });

  it('create_event: サーバーが断る組み合わせは、送る前に理由を返す', async () => {
    const { tools, requests } = setup(() => APPLIED());
    const noWorkspace = await tools.createEvent({ ...draftInput, workspaceId: undefined });
    const blockWithWorkspace = await tools.createEvent({ ...draftInput, kind: 'block' });
    const endBeforeStart = await tools.createEvent({ ...draftInput, endTime: '14:00' });
    expect(noWorkspace).toEqual({
      ok: false,
      text: '入力が正しくありません: 予定にはワークスペースが必要です',
    });
    expect(blockWithWorkspace.text).toContain('タイムブロックはワークスペースを持てません');
    expect(endBeforeStart.ok).toBe(false);
    expect(requests).toHaveLength(0);
  });

  it('update_event: 系列の id を URL に、回の日付・範囲・変更・newId・editedAt を本文に送る', async () => {
    const { tools, requests } = setup(() => APPLIED(), 7000);
    const result = await tools.updateEvent({
      seriesId: 'series-1',
      occurrenceDate: '2026-10-19',
      scope: 'following',
      changes: { title: '歯科', memo: null },
    });
    expect(requests[0]).toMatchObject({
      method: 'PATCH',
      path: '/api/entries/series-1',
      body: {
        occurrenceDate: '2026-10-19',
        scope: 'following',
        changes: { title: '歯科', memo: null },
        newId: 'id-1',
        editedAt: 7000,
      },
    });
    expect(result).toEqual({ ok: true, text: '変更しました（範囲: これ以降すべて）' });
  });

  it('update_event: 変える項目がなければ、送らずに断る', async () => {
    const { tools, requests } = setup(() => APPLIED());
    const result = await tools.updateEvent({
      seriesId: 'series-1',
      occurrenceDate: '2026-10-19',
      scope: 'all',
      changes: {},
    });
    expect(result.ok).toBe(false);
    expect(requests).toHaveLength(0);
  });

  it('delete_event: 系列の id を URL に、回の日付・範囲・newId・editedAt を本文に送る', async () => {
    const { tools, requests } = setup(() => APPLIED(), 7000);
    const result = await tools.deleteEvent({
      seriesId: 'series-1',
      occurrenceDate: '2026-10-19',
      scope: 'this',
    });
    expect(requests[0]).toMatchObject({
      method: 'DELETE',
      path: '/api/entries/series-1',
      body: { occurrenceDate: '2026-10-19', scope: 'this', newId: 'id-1', editedAt: 7000 },
    });
    expect(result).toEqual({ ok: true, text: '削除しました（範囲: この予定のみ）' });
  });

  it('editedAt は、同じミリ秒に続けて書いても、増えていく', async () => {
    const { tools, requests } = setup(() => APPLIED(), 7000);
    await tools.createEvent(draftInput);
    await tools.deleteEvent({ seriesId: 's', occurrenceDate: '2026-10-19', scope: 'all' });
    await tools.createEvent(draftInput);
    expect(requests.map(({ body }) => (body as { editedAt: number }).editedAt)).toEqual([
      7000, 7001, 7002,
    ]);
  });

  it('依頼ごとに、新しい id（newId）を使う', async () => {
    const { tools, requests } = setup(() => APPLIED());
    const target = { seriesId: 's', occurrenceDate: '2026-10-19', scope: 'this' } as const;
    await tools.deleteEvent(target);
    await tools.deleteEvent(target);
    expect(requests.map(({ body }) => (body as { newId: string }).newId)).toEqual(['id-1', 'id-2']);
  });
});

describe('通信の失敗と送り直し（MC-2）', () => {
  const create = {
    kind: 'event',
    title: '歯医者',
    workspaceId: 'office',
    startDate: '2026-10-19',
    startTime: '15:00',
    endDate: '2026-10-19',
    endTime: '16:00',
  } as const;

  it('通信が失敗したら、同じ id・editedAt で 1 回だけ送り直し、2 回目が通れば反映済みと返す', async () => {
    const { tools, requests } = setup((_, index) => (index === 0 ? NETWORK_ERROR() : APPLIED()));
    const result = await tools.createEvent(create);
    expect(requests).toHaveLength(2);
    expect(requests[1]).toEqual(requests[0]);
    expect(result).toEqual({ ok: true, text: '予定「歯医者」を作りました（id: id-1）' });
  });

  it('update_event も、同じ newId・editedAt で送り直す', async () => {
    const { tools, requests } = setup((_, index) => (index === 0 ? NETWORK_ERROR() : APPLIED()));
    await tools.updateEvent({
      seriesId: 's',
      occurrenceDate: '2026-10-19',
      scope: 'this',
      changes: { title: 'a' },
    });
    expect(requests).toHaveLength(2);
    expect(requests[1]?.body).toEqual(requests[0]?.body);
  });

  it('delete_event も、同じ newId・editedAt で送り直す', async () => {
    const { tools, requests } = setup((_, index) => (index === 0 ? NETWORK_ERROR() : APPLIED()));
    await tools.deleteEvent({ seriesId: 's', occurrenceDate: '2026-10-19', scope: 'all' });
    expect(requests).toHaveLength(2);
    expect(requests[1]?.body).toEqual(requests[0]?.body);
  });

  it('5xx も、通信の失敗と同じく、1 回だけ送り直す', async () => {
    const { tools, requests } = setup((_, index) =>
      index === 0 ? jsonReply({ error: 'internal_error', message: 'x' }, 500) : APPLIED(),
    );
    const result = await tools.createEvent(create);
    expect(requests).toHaveLength(2);
    expect(result.ok).toBe(true);
  });

  it('2 回続けて失敗したら、3 回目は送らず、反映されたか分からないと伝える', async () => {
    const { tools, requests } = setup(() => NETWORK_ERROR());
    const result = await tools.createEvent(create);
    expect(requests).toHaveLength(2);
    expect(result.ok).toBe(false);
    expect(result.text).toContain('反映されたかどうか分かりません');
  });

  it('送り直した結果が stale なら、「反映済みか、ほかの端末の新しい編集があった」と返す', async () => {
    const { tools, requests } = setup((_, index) =>
      index === 0 ? NETWORK_ERROR() : jsonReply({ applied: false, reason: 'stale' }),
    );
    const result = await tools.createEvent(create);
    expect(requests).toHaveLength(2);
    expect(result.ok).toBe(false);
    expect(result.text).toContain('反映済みか、ほかの端末の新しい編集があった');
  });

  it('送り直さなかった stale は、「ほかの端末の新しい編集があったため、反映しませんでした」と返す', async () => {
    const { tools, requests } = setup(() => jsonReply({ applied: false, reason: 'stale' }));
    const result = await tools.createEvent(create);
    expect(requests).toHaveLength(1);
    expect(result).toEqual({
      ok: false,
      text: 'ほかの端末の新しい編集があったため、反映しませんでした',
    });
  });

  it('not_found は、「対象の予定（またはワークスペース）が見つかりません」と返す。送り直さない', async () => {
    const { tools, requests } = setup(() => jsonReply({ applied: false, reason: 'not_found' }));
    const result = await tools.deleteEvent({
      seriesId: 's',
      occurrenceDate: '2026-10-19',
      scope: 'all',
    });
    expect(requests).toHaveLength(1);
    expect(result).toEqual({
      ok: false,
      text: '対象の予定（またはワークスペース）が見つかりません',
    });
  });

  const clientErrors: [ApiErrorKind, number, string][] = [
    ['invalid_request', 400, '入力が受け付けられませんでした'],
    ['invalid_change', 400, 'その変更は受け付けられません'],
    ['builtin_workspace', 400, '組み込みのワークスペース'],
    ['edited_at_in_future', 400, '時計が進んでいる'],
    ['conflict', 409, '食い違っています'],
    ['not_found', 404, 'ベース URL'],
  ];
  it.each(clientErrors)(
    '4xx（%s）は、種類に合わせた文言で返し、送り直さない',
    async (error, status, text) => {
      const { tools, requests } = setup(() =>
        jsonReply({ error, message: 'サーバーの文言' }, status),
      );
      const result = await tools.createEvent(create);
      expect(requests).toHaveLength(1);
      expect(result.ok).toBe(false);
      expect(result.text).toContain(text);
      expect(result.text).not.toContain('サーバーの文言');
    },
  );

  it('401・403 は、認証の失敗として返す', async () => {
    for (const status of [401, 403]) {
      const { tools, requests } = setup(() => new Response('denied', { status }));
      const result = await tools.createEvent(create);
      expect(requests).toHaveLength(1);
      expect(result.text).toContain('認証に失敗しました');
    }
  });

  it('本文が JSON でない 4xx も、HTTP の番号だけを伝える', async () => {
    const { tools } = setup(() => new Response('<html>', { status: 418 }));
    const result = await tools.createEvent(create);
    expect(result).toEqual({ ok: false, text: 'リクエストが受け付けられませんでした（HTTP 418）' });
  });
});

describe('create_workspace（MC-3）', () => {
  function workspaceBody(requests: RecordedRequest[]): Record<string, unknown> {
    const write = requests.find(({ method }) => method === 'PUT');
    return (write?.body as { workspace: Record<string, unknown> }).workspace;
  }

  function setupWorkspaces(existing: Workspace[]) {
    return setup(
      (request) => (request.method === 'GET' ? changesReply(existing) : APPLIED()),
      9000,
    );
  }

  it('色の名前から、8 色の値を選ぶ', async () => {
    const { tools, requests } = setupWorkspaces([HOME]);
    await tools.createWorkspace({ name: '趣味', color: 'バジル' });
    expect(workspaceBody(requests).color).toBe('#81C784');
  });

  it('色を省くと、まだ使っていない色の先頭にする', async () => {
    const { tools, requests } = setupWorkspaces([
      makeWorkspace({ id: 'a', color: '#E57373', sortOrder: 0 }),
      makeWorkspace({ id: 'b', color: '#ff8a65', sortOrder: 1 }),
    ]);
    await tools.createWorkspace({ name: '趣味' });
    expect(workspaceBody(requests).color).toBe('#FFD54F');
  });

  it('色を省いて、8 色すべて使っていれば、1 色目（トマト）にする', async () => {
    const colors = [
      '#E57373',
      '#FF8A65',
      '#FFD54F',
      '#81C784',
      '#4FC3F7',
      '#7986CB',
      '#B39DDB',
      '#BDBDBD',
    ];
    const { tools, requests } = setupWorkspaces(
      colors.map((color, index) =>
        makeWorkspace({ id: `w${String(index)}`, color, sortOrder: index }),
      ),
    );
    await tools.createWorkspace({ name: '趣味' });
    expect(workspaceBody(requests).color).toBe('#E57373');
  });

  it('削除済みと組み込みのワークスペースの色は、使っているとみなさない', async () => {
    const { tools, requests } = setupWorkspaces([
      makeWorkspace({ id: 'gone', color: '#E57373', deletedAt: 3 }),
      makeWorkspace({
        id: 'builtin-holiday',
        color: '#E57373',
        builtin: 'holiday',
        sortOrder: 9999,
      }),
    ]);
    await tools.createWorkspace({ name: '趣味' });
    expect(workspaceBody(requests).color).toBe('#E57373');
  });

  it('sortOrder は、今ある最大 + 1。組み込み（大きな値）と削除済みは数えない', async () => {
    const { tools, requests } = setupWorkspaces([
      makeWorkspace({ id: 'a', sortOrder: 0 }),
      makeWorkspace({ id: 'b', sortOrder: 4 }),
      makeWorkspace({ id: 'gone', sortOrder: 50, deletedAt: 3 }),
      makeWorkspace({ id: 'builtin-holiday', builtin: 'holiday', sortOrder: 9999 }),
    ]);
    await tools.createWorkspace({ name: '趣味' });
    expect(workspaceBody(requests).sortOrder).toBe(5);
  });

  it('ワークスペースがまだなければ、sortOrder は 0', async () => {
    const { tools, requests } = setupWorkspaces([]);
    await tools.createWorkspace({ name: '趣味' });
    expect(workspaceBody(requests).sortOrder).toBe(0);
  });

  it('表示 ON・組み込みでない行を、新しい id で作る', async () => {
    const { tools, requests } = setupWorkspaces([HOME]);
    const result = await tools.createWorkspace({ name: ' 趣味 ', color: 'トマト' });
    expect(requests.at(-1)).toMatchObject({ method: 'PUT', path: '/api/workspaces/id-1' });
    expect(workspaceBody(requests)).toEqual({
      id: 'id-1',
      name: '趣味',
      color: '#E57373',
      sortOrder: 1,
      visible: true,
      builtin: null,
      editedAt: 9000,
      deletedAt: null,
    });
    expect(result).toEqual({ ok: true, text: 'ワークスペース「趣味」を作りました（id: id-1）' });
  });

  it('空の名前（空白だけを含む）は、送らずに断る', async () => {
    const { tools, requests } = setupWorkspaces([]);
    const result = await tools.createWorkspace({ name: '   ' });
    expect(result.ok).toBe(false);
    expect(requests).toHaveLength(0);
  });

  it('通信が失敗したら、同じ id・editedAt で 1 回だけ送り直す', async () => {
    const { tools, requests } = setup((request, index) =>
      request.method === 'GET' ? changesReply([]) : index === 1 ? NETWORK_ERROR() : APPLIED(),
    );
    await tools.createWorkspace({ name: '趣味' });
    const writes = requests.filter(({ method }) => method === 'PUT');
    expect(writes).toHaveLength(2);
    expect(writes[1]).toEqual(writes[0]);
  });
});
