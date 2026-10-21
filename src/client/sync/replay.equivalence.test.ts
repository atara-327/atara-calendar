import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { callApi } from '../../../test/helpers/api';
import { createTestDatabase, type TestDatabase } from '../../../test/helpers/d1';
import { makeEntry } from '../../../test/helpers/entries';
import { readAllRows } from '../../../test/helpers/rows';
import { makeWorkspace } from '../../../test/helpers/workspaces';
import { writeResponseSchema } from '../../shared/api';
import type { Entry, EntryDraft, Workspace } from '../../shared/schema';
import { applyWrite } from '../../worker/db/store';
import { replayRequests } from './replay';
import { toHttpRequest, type PendingRequest } from './requests';

// 端末の「やり直し」（replay.ts）が、サーバーの書き込みと同じ行を書くことを、本物の Worker（Miniflare の D1）と
// 見比べて確かめる（設計書 5.2「端末とサーバーは同じ結果になる」）。
// 同じ行を、サーバーと端末の両方に用意し、同じ依頼を、サーバーには HTTP で、端末にはやり直しで当てて、
// 結果の全行（削除済みを含む）が一致することを見る。サーバーが 4xx にする依頼は、端末が当てない（行が変わらない）ことを見る。

let testDatabase: TestDatabase;

beforeAll(async () => {
  testDatabase = await createTestDatabase();
});

afterAll(async () => {
  await testDatabase.dispose();
});

beforeEach(async () => {
  await testDatabase.reset();
  vi.spyOn(console, 'warn').mockImplementation(() => undefined);
  vi.spyOn(console, 'error').mockImplementation(() => undefined);
});

afterEach(() => {
  vi.restoreAllMocks();
});

function db(): D1Database {
  return testDatabase.db;
}

function draft(overrides: Partial<EntryDraft> = {}): EntryDraft {
  return {
    kind: 'event',
    title: '歯医者',
    workspaceId: 'w1',
    allDay: false,
    startDate: '2026-10-19',
    startTime: '15:00',
    endDate: '2026-10-19',
    endTime: '16:00',
    location: null,
    url: null,
    memo: null,
    rrule: null,
    notifyEnabled: true,
    notifyOffsetMin: 10,
    ...overrides,
  };
}

const putEntry = (id: string, editedAt: number, overrides: Partial<EntryDraft> = {}) =>
  ({ type: 'putEntry', targetId: id, body: { draft: draft(overrides), editedAt } }) as const;

type PatchBody = Extract<PendingRequest, { type: 'patchEntry' }>['body'];

const patchEntry = (
  targetId: string,
  rest: Partial<PatchBody> & { editedAt?: number } = {},
): PendingRequest => ({
  type: 'patchEntry',
  targetId,
  body: {
    occurrenceDate: '2026-10-21',
    scope: 'all',
    changes: {},
    newId: 'new1',
    editedAt: 2000,
    ...rest,
  },
});

type DeleteBody = Extract<PendingRequest, { type: 'deleteEntry' }>['body'];

const deleteEntry = (targetId: string, rest: Partial<DeleteBody> = {}): PendingRequest => ({
  type: 'deleteEntry',
  targetId,
  body: { occurrenceDate: '2026-10-21', scope: 'all', newId: 'new1', editedAt: 2000, ...rest },
});

const putWorkspace = (workspace: Workspace): PendingRequest => ({
  type: 'putWorkspace',
  body: { workspace: { ...workspace, deletedAt: null } },
});

const deleteWorkspace = (targetId: string, editedAt = 2000): PendingRequest => ({
  type: 'deleteWorkspace',
  targetId,
  body: { editedAt },
});

const w1 = makeWorkspace({ id: 'w1', name: '仕事', editedAt: 100, sortOrder: 0 });
const w2 = makeWorkspace({ id: 'w2', name: '私用', editedAt: 100, sortOrder: 1 });
const goneW3 = makeWorkspace({ id: 'w3', name: '消した', editedAt: 100, deletedAt: 100 });

const daily = makeEntry({
  id: 's1',
  title: '毎日',
  allDay: false,
  startTime: '09:00',
  endTime: '10:00',
  rrule: { freq: 'daily' },
  startDate: '2026-10-19',
  editedAt: 1000,
});
const weekly = makeEntry({
  id: 'sw',
  title: '毎週',
  rrule: { freq: 'weekly', days: [1, 3, 5] },
  startDate: '2026-10-19',
  editedAt: 1000,
});
const exception = makeEntry({
  id: 'x1',
  title: '例外',
  allDay: false,
  startTime: '09:00',
  endTime: '10:00',
  seriesId: 's1',
  originalDate: '2026-10-21',
  editedAt: 1000,
});
const lateException = makeEntry({
  id: 'x2',
  seriesId: 's1',
  originalDate: '2026-10-28',
  allDay: false,
  startTime: '09:00',
  endTime: '10:00',
  editedAt: 1000,
});
const cancelled = makeEntry({
  id: 'x3',
  seriesId: 's1',
  originalDate: '2026-10-23',
  allDay: false,
  startTime: '09:00',
  endTime: '10:00',
  cancelled: true,
  editedAt: 1000,
});
const deletedSeries = makeEntry({
  id: 'sd',
  rrule: { freq: 'daily' },
  editedAt: 1500,
  deletedAt: 1500,
});

interface Scenario {
  name: string;
  workspaces?: Workspace[];
  entries?: Entry[];
  request: PendingRequest;
}

const scenarios: Scenario[] = [
  // 予定の作成
  { name: '予定の作成', request: putEntry('e1', 2000) },
  {
    name: '繰り返しの作成（開始日がルールに合わず、ずれる）',
    request: putEntry('e1', 2000, { rrule: { freq: 'weekly', days: [3] } }),
  },
  {
    name: 'タイムブロックの作成',
    request: putEntry('b1', 2000, { kind: 'block', workspaceId: null }),
  },
  {
    name: '同じ id の行が、依頼より新しく保存されている作成（stale）',
    entries: [makeEntry({ id: 'e1', editedAt: 5000 })],
    request: putEntry('e1', 2000),
  },
  {
    name: '同じ id の行が、依頼より古く保存されている作成（409）',
    entries: [makeEntry({ id: 'e1', editedAt: 500 })],
    request: putEntry('e1', 2000),
  },
  {
    name: '同じ editedAt の行がすでにある作成（同じ依頼の 2 回目。同じなら捨てる）',
    entries: [makeEntry({ id: 'e1', title: '別の中身', editedAt: 2000 })],
    request: putEntry('e1', 2000),
  },
  {
    name: '削除済みの同じ id の行がある作成',
    entries: [makeEntry({ id: 'e1', editedAt: 500, deletedAt: 500 })],
    request: putEntry('e1', 2000),
  },
  {
    name: '削除済みのワークスペースへの作成',
    request: putEntry('e1', 2000, { workspaceId: 'w3' }),
  },
  {
    name: '存在しないワークスペースへの作成（409）',
    request: putEntry('e1', 2000, { workspaceId: 'nothing' }),
  },
  {
    name: '日付の計算が対応する年を出る作成（400）',
    request: putEntry('e1', 2000, {
      allDay: true,
      startTime: null,
      endTime: null,
      startDate: '2199-12-31',
      endDate: '2199-12-31',
      rrule: { freq: 'weekday' },
    }),
  },

  // 予定の変更
  {
    name: '繰り返さない予定の変更',
    entries: [makeEntry({ id: 'e1' })],
    request: patchEntry('e1', { changes: { title: '変更' } }),
  },
  {
    name: '繰り返さない予定にルールを付ける',
    entries: [makeEntry({ id: 'e1' })],
    request: patchEntry('e1', { changes: { rrule: { freq: 'weekly', days: [3] } } }),
  },
  {
    name: '「この予定のみ」の変更（例外の行を作る）',
    entries: [daily],
    request: patchEntry('s1', { scope: 'this', changes: { title: '休み' }, newId: 'n1' }),
  },
  {
    name: '「この予定のみ」の変更（日時を別の日に移す）',
    entries: [daily],
    request: patchEntry('s1', {
      scope: 'this',
      changes: { startDate: '2026-10-25', startTime: '13:00', endTime: '14:00' },
      newId: 'n1',
    }),
  },
  {
    name: '「この予定のみ」の変更（すでに例外の行がある回。その行を書き換える）',
    entries: [daily, exception],
    request: patchEntry('s1', { scope: 'this', changes: { title: '2 回目' }, newId: 'n1' }),
  },
  {
    name: '「この予定のみ」の変更（削除した回。存在しない回）',
    entries: [daily, cancelled],
    request: patchEntry('s1', {
      scope: 'this',
      occurrenceDate: '2026-10-23',
      changes: { title: '変更' },
      newId: 'n1',
    }),
  },
  {
    name: '「この予定のみ」で、ルールを変える（400）',
    entries: [daily],
    request: patchEntry('s1', {
      scope: 'this',
      changes: { rrule: { freq: 'weekly', days: [1] } },
      newId: 'n1',
    }),
  },
  {
    name: '「すべて」の変更（例外のある系列）',
    entries: [daily, exception, lateException, cancelled],
    request: patchEntry('s1', { scope: 'all', changes: { title: '全部変更', location: '東京' } }),
  },
  {
    name: '「すべて」の変更（開いていた回が例外の行。日時も含めて当てる）',
    entries: [daily, exception, lateException],
    request: patchEntry('s1', {
      scope: 'all',
      changes: { startTime: '11:00', endTime: '12:00', title: '時刻も変更' },
    }),
  },
  {
    name: '「すべて」の変更（終日にする。通知の分は、終日が違う例外には当てない）',
    entries: [daily, exception],
    request: patchEntry('s1', {
      scope: 'all',
      changes: { allDay: true, startTime: null, endTime: null, notifyOffsetMin: -360 },
    }),
  },
  {
    name: '「すべて」の変更（曜日の繰り返しの日付をずらす。例外はすべて消える）',
    entries: [weekly],
    request: patchEntry('sw', {
      scope: 'all',
      occurrenceDate: '2026-10-21',
      changes: { startDate: '2026-10-22' },
      newId: 'n1',
    }),
  },
  {
    name: '「すべて」の変更（毎日の日付をずらす。400）',
    entries: [daily],
    request: patchEntry('s1', { scope: 'all', changes: { startDate: '2026-10-22' } }),
  },
  {
    name: '「すべて」の変更（ルールをなくす）',
    entries: [daily, exception],
    request: patchEntry('s1', { scope: 'all', changes: { rrule: null } }),
  },
  {
    name: '「これ以降すべて」の変更（系列を切って、新しい系列を作る）',
    entries: [daily, exception, lateException, cancelled],
    request: patchEntry('s1', {
      scope: 'following',
      occurrenceDate: '2026-10-22',
      changes: { title: '以降変更' },
      newId: 'n1',
    }),
  },
  {
    name: '「これ以降すべて」の変更（最初の回。「すべて」と同じ）',
    entries: [daily, exception],
    request: patchEntry('s1', {
      scope: 'following',
      occurrenceDate: '2026-10-19',
      changes: { title: '最初から' },
      newId: 'n1',
    }),
  },
  {
    name: '「これ以降すべて」の変更（消す例外の 1 つが、依頼より新しい）',
    entries: [daily, { ...lateException, editedAt: 9000 }],
    request: patchEntry('s1', {
      scope: 'following',
      occurrenceDate: '2026-10-22',
      changes: { title: '以降変更' },
      newId: 'n1',
    }),
  },
  {
    name: '新しい系列の id が、別の行とぶつかる変更（stale）',
    entries: [daily, makeEntry({ id: 'n1', editedAt: 5000 })],
    request: patchEntry('s1', {
      scope: 'following',
      occurrenceDate: '2026-10-22',
      changes: { title: '以降変更' },
      newId: 'n1',
    }),
  },
  {
    name: '新しい系列の id が、別の行とぶつかる変更（409）',
    entries: [daily, makeEntry({ id: 'n1', editedAt: 500 })],
    request: patchEntry('s1', {
      scope: 'following',
      occurrenceDate: '2026-10-22',
      changes: { title: '以降変更' },
      newId: 'n1',
    }),
  },
  {
    name: '対象の予定がない変更',
    request: patchEntry('nothing', { changes: { title: '変更' } }),
  },
  {
    name: '削除済みの系列への変更',
    entries: [deletedSeries],
    request: patchEntry('sd', { changes: { title: '変更' } }),
  },
  {
    name: '系列の回でない日付への「この予定のみ」の変更',
    entries: [daily],
    request: patchEntry('s1', {
      scope: 'this',
      occurrenceDate: '2026-10-01',
      changes: { title: '変更' },
      newId: 'n1',
    }),
  },
  {
    name: 'サーバーの行の方が新しい変更（stale）',
    entries: [{ ...daily, editedAt: 5000 }],
    request: patchEntry('s1', { changes: { title: '変更' } }),
  },
  {
    name: '同じ editedAt の行がすでにある変更（同じ依頼の 2 回目。同じなら捨てる）',
    entries: [{ ...daily, title: '別の中身', editedAt: 2000 }],
    request: patchEntry('s1', { changes: { title: '変更' } }),
  },
  {
    name: '削除済みのワークスペースへ移す変更',
    entries: [daily],
    request: patchEntry('s1', { changes: { workspaceId: 'w3' } }),
  },

  // 予定の削除
  {
    name: '繰り返さない予定の削除',
    entries: [makeEntry({ id: 'e1' })],
    request: deleteEntry('e1'),
  },
  {
    name: '「すべて」の削除（例外ごと）',
    entries: [daily, exception, cancelled],
    request: deleteEntry('s1'),
  },
  {
    name: '「この予定のみ」の削除（例外の行を作る）',
    entries: [daily],
    request: deleteEntry('s1', { scope: 'this', newId: 'n1' }),
  },
  {
    name: '「この予定のみ」の削除（すでに例外の行がある回）',
    entries: [daily, exception],
    request: deleteEntry('s1', { scope: 'this', newId: 'n1' }),
  },
  {
    name: '「これ以降すべて」の削除（系列を切る。以降の例外を消す）',
    entries: [daily, exception, lateException],
    request: deleteEntry('s1', { scope: 'following', occurrenceDate: '2026-10-22', newId: 'n1' }),
  },
  {
    name: '「これ以降すべて」の削除（最初の回。「すべて」と同じ）',
    entries: [daily, exception],
    request: deleteEntry('s1', { scope: 'following', occurrenceDate: '2026-10-19', newId: 'n1' }),
  },
  {
    name: '同じ editedAt で削除済みの系列への削除（同じ依頼の 2 回目）',
    entries: [{ ...daily, title: '別の中身', editedAt: 2000, deletedAt: 2000 }],
    request: deleteEntry('s1'),
  },
  {
    name: '対象の予定がない削除',
    request: deleteEntry('nothing'),
  },
  {
    name: '消す行の 1 つが、依頼より新しい削除',
    entries: [daily, { ...exception, editedAt: 9000 }],
    request: deleteEntry('s1'),
  },

  // ワークスペース
  {
    name: 'ワークスペースの作成',
    request: putWorkspace(makeWorkspace({ id: 'w9', name: '新規', editedAt: 2000, sortOrder: 5 })),
  },
  {
    name: 'ワークスペースの更新',
    request: putWorkspace(makeWorkspace({ id: 'w1', name: '改名', editedAt: 2000 })),
  },
  {
    name: '同じ editedAt のワークスペースの更新（同じ依頼の 2 回目。同じなら捨てる）',
    workspaces: [makeWorkspace({ id: 'w5', name: '別の中身', editedAt: 2000 })],
    request: putWorkspace(makeWorkspace({ id: 'w5', name: '改名', editedAt: 2000 })),
  },
  {
    name: 'サーバーの行の方が新しいワークスペースの更新',
    request: putWorkspace(makeWorkspace({ id: 'w1', name: '改名', editedAt: 50 })),
  },
  {
    name: '削除済みのワークスペースの更新（生き返らせない）',
    request: putWorkspace(makeWorkspace({ id: 'w3', name: '生き返り', editedAt: 2000 })),
  },
  {
    name: 'ワークスペースの削除（中の予定ごと）',
    entries: [
      makeEntry({ id: 'plain', workspaceId: 'w1' }),
      makeEntry({ id: 'out', workspaceId: 'w2' }),
      daily,
      exception,
    ],
    request: deleteWorkspace('w1'),
  },
  {
    name: 'ワークスペースの削除（別のワークスペースへ移した例外は、その回を削除した形にして戻す）',
    entries: [
      daily,
      { ...exception, workspaceId: 'w2', startDate: '2026-10-25', endDate: '2026-10-25' },
    ],
    request: deleteWorkspace('w2'),
  },
  {
    name: 'ワークスペースの削除（削除済みの系列の例外は、論理削除する）',
    entries: [
      deletedSeries,
      makeEntry({ id: 'orphan', workspaceId: 'w2', seriesId: 'sd', originalDate: '2026-10-20' }),
    ],
    request: deleteWorkspace('w2'),
  },
  {
    name: 'ワークスペースの削除（系列が別のワークスペースで、例外だけが w1 を指す）',
    entries: [
      { ...daily, workspaceId: 'w2' },
      { ...exception, workspaceId: 'w1' },
      { ...lateException, workspaceId: 'w2' },
    ],
    request: deleteWorkspace('w1'),
  },
  {
    name: 'ワークスペースの削除（中の予定の 1 行が、依頼より新しい）',
    entries: [makeEntry({ id: 'plain', workspaceId: 'w1', editedAt: 9000 })],
    request: deleteWorkspace('w1'),
  },
  {
    name: 'ワークスペースの削除（削除済み）',
    request: deleteWorkspace('w3'),
  },
  {
    name: 'ワークスペースの削除（存在しない）',
    request: deleteWorkspace('nothing'),
  },
  {
    name: 'ワークスペースの削除（サーバーの行の方が新しい）',
    request: deleteWorkspace('w1', 50),
  },
];

function sortedById<T extends { id: string }>(rows: ReadonlyMap<string, T>): T[] {
  return [...rows.values()].sort((a, b) => (a.id < b.id ? -1 : 1));
}

describe('端末の「やり直し」は、サーバーの書き込みと同じ行を書く（設計書 5.2）', () => {
  it.each(scenarios)('$name', async ({ workspaces = [], entries = [], request }) => {
    // どのシナリオでも、最後の 1 つ以外のワークスペースを消せるように、w1・w2 の 2 つの利用者のワークスペースを置く。
    await applyWrite(db(), { workspaces: [w1, w2, goneW3, ...workspaces], entries });
    const before = await readAllRows(db());

    const { method, url, body } = toHttpRequest(request);
    const response = await callApi(db(), method, url, { body });
    const after = await readAllRows(db());
    const replayed = replayRequests(before, [request]);

    // サーバーが 4xx にする依頼（入力の検証に合わない、409）は、サーバーは何も書かない。端末も当てない。
    const applied = response.status === 200 && writeResponseSchema.parse(response.body).applied;
    if (!applied) expect(after).toEqual(before);
    expect(sortedById(replayed.workspaces)).toEqual(sortedById(after.workspaces));
    expect(sortedById(replayed.entries)).toEqual(sortedById(after.entries));
  });
});
