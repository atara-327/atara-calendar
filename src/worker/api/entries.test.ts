import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { createTestDatabase, type TestDatabase } from '../../../test/helpers/d1';
import { callApi, dumpTables, fetchChanges, seedWorkspace } from '../../../test/helpers/api';
import { makeEntry } from '../../../test/helpers/entries';
import { makeWorkspace } from '../../../test/helpers/workspaces';
import type { Entry } from '../../shared/schema';
import { applyWrite } from '../db/store';

let testDatabase: TestDatabase;

beforeAll(async () => {
  testDatabase = await createTestDatabase();
});

afterAll(async () => {
  await testDatabase.dispose();
});

beforeEach(async () => {
  await testDatabase.reset();
  await seedWorkspace(db(), 'w1');
  // 4xx の応答は、原因をログに出す。テストの出力に混ぜないため、黙らせる。
  vi.spyOn(console, 'warn').mockImplementation(() => undefined);
  vi.spyOn(console, 'error').mockImplementation(() => undefined);
});

afterEach(() => {
  vi.restoreAllMocks();
});

function db(): D1Database {
  return testDatabase.db;
}

/** 時間指定の予定の下書き。overrides には、不正な値を入れるテストのために、何でも渡せる。 */
function draft(overrides: Record<string, unknown> = {}): Record<string, unknown> {
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

function putEntry(id: string, body: unknown) {
  return callApi(db(), 'PUT', `/api/entries/${id}`, { body });
}

function patchEntry(id: string, overrides: Record<string, unknown> = {}) {
  return callApi(db(), 'PATCH', `/api/entries/${id}`, {
    body: {
      occurrenceDate: '2026-10-19',
      scope: 'all',
      changes: {},
      newId: 'new1',
      editedAt: 2000,
      ...overrides,
    },
  });
}

function deleteEntry(id: string, overrides: Record<string, unknown> = {}) {
  return callApi(db(), 'DELETE', `/api/entries/${id}`, {
    body: {
      occurrenceDate: '2026-10-19',
      scope: 'all',
      newId: 'new1',
      editedAt: 2000,
      ...overrides,
    },
  });
}

/** 削除済みも含めて、行の今の状態を読む。 */
async function stored(id: string) {
  return db()
    .prepare(
      'SELECT id, title, series_id, original_date, until_date, cancelled, edited_at, deleted_at FROM entries WHERE id = ?1',
    )
    .bind(id)
    .first();
}

const invalidRequest = { error: 'invalid_request', message: '入力が正しくありません' };

/** 毎日の、終日の系列 's'（2026-10-19 から）を入れる。 */
async function seedSeries(overrides: Partial<Entry> = {}) {
  await applyWrite(db(), {
    entries: [
      makeEntry({ id: 's', rrule: { freq: 'daily' }, startDate: '2026-10-19', ...overrides }),
    ],
  });
}

describe('PUT /api/entries/:id（作成）', () => {
  it('EV-1・EV-2: 時間指定の予定を作れる。応答は { applied: true } だけで、rev は返さない', async () => {
    const res = await putEntry('e1', { draft: draft(), editedAt: 2000 });

    expect(res.status).toBe(200);
    expect(res.body).toEqual({ applied: true });
    const changes = await fetchChanges(db(), 0);
    expect(changes.entries).toEqual([
      makeEntry({
        id: 'e1',
        title: '歯医者',
        allDay: false,
        startTime: '15:00',
        endTime: '16:00',
        editedAt: 2000,
      }),
    ]);
  });

  it('EV-3: 終日の予定は、1 日だけなら、開始日と終了日が同じでよい', async () => {
    const res = await putEntry('e1', {
      draft: draft({ allDay: true, startTime: null, endTime: null }),
      editedAt: 2000,
    });

    expect(res.body).toEqual({ applied: true });
  });

  it('EV-4: 複数日の終日の予定を作れる', async () => {
    const res = await putEntry('e1', {
      draft: draft({ allDay: true, startTime: null, endTime: null, endDate: '2026-10-21' }),
      editedAt: 2000,
    });

    expect(res.body).toEqual({ applied: true });
    expect((await fetchChanges(db(), 0)).entries[0]).toMatchObject({ endDate: '2026-10-21' });
  });

  it('TB-2・TB-6: 日付をまたぐタイムブロック（23:00〜翌 7:00）を作れる', async () => {
    const res = await putEntry('b1', {
      draft: draft({
        kind: 'block',
        workspaceId: null,
        title: '睡眠',
        startTime: '23:00',
        endDate: '2026-10-20',
        endTime: '07:00',
        notifyEnabled: false,
      }),
      editedAt: 2000,
    });

    expect(res.body).toEqual({ applied: true });
    expect((await fetchChanges(db(), 0)).entries[0]).toMatchObject({
      id: 'b1',
      kind: 'block',
      workspaceId: null,
      endDate: '2026-10-20',
    });
  });

  it('RP-1・4.4: 開始日が繰り返しのルールに合わないと、ルールに合う最初の日へずらして作る', async () => {
    // 2026-10-19 は月曜。毎週 水・金 なら、水曜の 10-21 から始まる。
    const res = await putEntry('e1', {
      draft: draft({ rrule: { freq: 'weekly', days: [3, 5] } }),
      editedAt: 2000,
    });

    expect(res.body).toEqual({ applied: true });
    expect((await fetchChanges(db(), 0)).entries[0]).toMatchObject({
      startDate: '2026-10-21',
      endDate: '2026-10-21',
      rrule: { freq: 'weekly', days: [3, 5] },
    });
  });

  it('SY-3: 同じ依頼を 2 回送ると、2 回目は stale で捨て、DB は変わらない', async () => {
    const body = { draft: draft(), editedAt: 2000 };
    await putEntry('e1', body);
    const before = await dumpTables(db());

    const second = await putEntry('e1', body);

    expect(second.status).toBe(200);
    expect(second.body).toEqual({ applied: false, reason: 'stale' });
    expect(await dumpTables(db())).toEqual(before);
  });

  it('SY-3: サーバーの行より古い依頼は、stale で捨て、DB は変わらない', async () => {
    await putEntry('e1', { draft: draft({ title: '新しい' }), editedAt: 3000 });
    const before = await dumpTables(db());

    const res = await putEntry('e1', { draft: draft({ title: '古い' }), editedAt: 2000 });

    expect(res.body).toEqual({ applied: false, reason: 'stale' });
    expect(await dumpTables(db())).toEqual(before);
  });

  describe('項目をまたぐ確認（4.2）', () => {
    it.each<{ name: string; overrides: Record<string, unknown> }>([
      { name: '終日なのに開始時刻がある', overrides: { allDay: true, endTime: null } },
      { name: '終日なのに終了時刻がある', overrides: { allDay: true, startTime: null } },
      { name: '時間指定なのに開始時刻がない', overrides: { startTime: null } },
      { name: '時間指定なのに終了時刻がない', overrides: { endTime: null } },
      { name: '終了が開始と同じ日時', overrides: { endTime: '15:00' } },
      { name: '終了が開始より前（同じ日）', overrides: { endTime: '14:45' } },
      { name: '終了日が開始日より前', overrides: { endDate: '2026-10-18' } },
      {
        name: '終日で、終了日が開始日より前',
        overrides: { allDay: true, startTime: null, endTime: null, endDate: '2026-10-18' },
      },
      {
        name: 'タイムブロックを終日にした',
        overrides: {
          kind: 'block',
          workspaceId: null,
          allDay: true,
          startTime: null,
          endTime: null,
        },
      },
      { name: 'タイムブロックにワークスペースがある', overrides: { kind: 'block' } },
      { name: '予定にワークスペースがない', overrides: { workspaceId: null } },
    ])('$name と 400。DB は変わらない', async ({ overrides }) => {
      const before = await dumpTables(db());

      const res = await putEntry('e1', { draft: draft(overrides), editedAt: 2000 });

      expect(res.status).toBe(400);
      expect(res.body).toEqual(invalidRequest);
      expect(await dumpTables(db())).toEqual(before);
    });
  });

  describe('文字数・形式・範囲の確認（10.3・4.2）', () => {
    it.each<{ name: string; overrides: Record<string, unknown> }>([
      { name: 'タイトルが空', overrides: { title: '' } },
      { name: 'タイトルが 201 文字', overrides: { title: 'あ'.repeat(201) } },
      { name: '場所が 201 文字', overrides: { location: 'あ'.repeat(201) } },
      { name: 'メモが 10001 文字', overrides: { memo: 'あ'.repeat(10_001) } },
      { name: 'URL が javascript:', overrides: { url: 'javascript:alert(1)' } },
      { name: 'URL が ftp://', overrides: { url: 'ftp://example.com/' } },
      { name: 'URL が先頭に空白つき', overrides: { url: ' https://example.com/' } },
      { name: 'URL が 2049 文字', overrides: { url: `https://example.com/${'a'.repeat(2029)}` } },
      { name: '開始日の年が 1899', overrides: { startDate: '1899-12-31', endDate: '1899-12-31' } },
      { name: '終了日の年が 2200', overrides: { endDate: '2200-01-01' } },
      { name: '存在しない日付', overrides: { startDate: '2026-02-30', endDate: '2026-02-30' } },
      { name: '分が 15 分刻みでない', overrides: { startTime: '15:10' } },
      { name: '通知が 1441 分後より前（-1441）', overrides: { notifyOffsetMin: -1441 } },
      { name: '通知が 10081 分前', overrides: { notifyOffsetMin: 10_081 } },
      { name: '通知が整数でない', overrides: { notifyOffsetMin: 1.5 } },
      { name: 'kind が不正', overrides: { kind: 'task' } },
      { name: 'id の形でない workspaceId', overrides: { workspaceId: 'w 1' } },
      { name: '知らないキーがある', overrides: { untilDate: '2026-12-31' } },
    ])('$name と 400。DB は変わらない', async ({ overrides }) => {
      const before = await dumpTables(db());

      const res = await putEntry('e1', { draft: draft(overrides), editedAt: 2000 });

      expect(res.status).toBe(400);
      expect(res.body).toEqual(invalidRequest);
      expect(await dumpTables(db())).toEqual(before);
    });

    it('上限ちょうど（タイトル 200・場所 200・メモ 10000・URL 2048・通知 -1440 と 10080）は通る', async () => {
      const limits = {
        title: 'あ'.repeat(200),
        location: 'あ'.repeat(200),
        memo: 'あ'.repeat(10_000),
        url: `https://example.com/${'a'.repeat(2028)}`,
      };

      const first = await putEntry('e1', {
        draft: draft({ ...limits, notifyOffsetMin: -1440 }),
        editedAt: 2000,
      });
      const second = await putEntry('e2', {
        draft: draft({ notifyOffsetMin: 10_080 }),
        editedAt: 2000,
      });

      expect(first.body).toEqual({ applied: true });
      expect(second.body).toEqual({ applied: true });
    });

    it.each(['https://example.com/a?b=c#d', 'http://localhost:8080/', 'HTTPS://EXAMPLE.COM/'])(
      'URL %s は通り、保存する値は入力のまま（黙って整えない）',
      async (url) => {
        const res = await putEntry('e1', { draft: draft({ url }), editedAt: 2000 });

        expect(res.body).toEqual({ applied: true });
        expect((await fetchChanges(db(), 0)).entries[0]?.url).toBe(url);
      },
    );

    it('年の境目（1900-01-01 と 2199-12-31）は通る', async () => {
      const first = await putEntry('e1', {
        draft: draft({ startDate: '1900-01-01', endDate: '1900-01-01' }),
        editedAt: 2000,
      });
      const second = await putEntry('e2', {
        draft: draft({ startDate: '2199-12-31', endDate: '2199-12-31' }),
        editedAt: 2000,
      });

      expect(first.body).toEqual({ applied: true });
      expect(second.body).toEqual({ applied: true });
    });

    it('本文が JSON として読めないと 400', async () => {
      const res = await callApi(db(), 'PUT', '/api/entries/e1', { rawBody: 'draft' });

      expect(res.status).toBe(400);
      expect(res.body).toEqual(invalidRequest);
    });

    it('URL の id の形が不正だと 400', async () => {
      const res = await putEntry('a.b', { draft: draft(), editedAt: 2000 });

      expect(res.status).toBe(400);
      expect(res.body).toEqual(invalidRequest);
    });

    it('日付の計算が対応する年を出る依頼（2199-12-31 から始まる「平日」）は、500 ではなく 400', async () => {
      const before = await dumpTables(db());

      const res = await putEntry('e1', {
        draft: draft({
          allDay: true,
          startTime: null,
          endTime: null,
          startDate: '2199-12-31',
          endDate: '2199-12-31',
          rrule: { freq: 'weekday' },
        }),
        editedAt: 2000,
      });

      expect(res.status).toBe(400);
      expect(res.body).toEqual(invalidRequest);
      expect(await dumpTables(db())).toEqual(before);
    });
  });

  describe('ワークスペースの確認', () => {
    it('存在しないワークスペースは、外部キー違反として 409（conflict）。DB は変わらない', async () => {
      const before = await dumpTables(db());

      const res = await putEntry('e1', {
        draft: draft({ workspaceId: 'nothing' }),
        editedAt: 2000,
      });

      expect(res.status).toBe(409);
      expect(res.body).toEqual({
        error: 'conflict',
        message: '依頼の内容が、保存されているデータと食い違っています',
      });
      expect(await dumpTables(db())).toEqual(before);
    });

    it('SY-3: 削除済みのワークスペースの予定は、not_found で捨てる（ワークスペースの削除より新しい依頼）', async () => {
      await seedWorkspace(db(), 'w2');
      await callApi(db(), 'DELETE', '/api/workspaces/w2', { body: { editedAt: 5000 } });
      const before = await dumpTables(db());

      const res = await putEntry('e1', { draft: draft({ workspaceId: 'w2' }), editedAt: 6000 });

      expect(res.status).toBe(200);
      expect(res.body).toEqual({ applied: false, reason: 'not_found' });
      expect(await dumpTables(db())).toEqual(before);
    });

    it('SY-3: 削除済みのワークスペースの予定は、ワークスペースの削除より古い依頼なら stale で捨てる', async () => {
      await seedWorkspace(db(), 'w2');
      await callApi(db(), 'DELETE', '/api/workspaces/w2', { body: { editedAt: 5000 } });

      const res = await putEntry('e1', { draft: draft({ workspaceId: 'w2' }), editedAt: 4000 });

      expect(res.body).toEqual({ applied: false, reason: 'stale' });
    });
  });

  describe('SY-3: editedAt がサーバーの今より 10 分より未来だと 400', () => {
    it('11 分先は 400（edited_at_in_future）で、DB は変わらない', async () => {
      const before = await dumpTables(db());

      const res = await putEntry('e1', { draft: draft(), editedAt: Date.now() + 11 * 60_000 });

      expect(res.status).toBe(400);
      expect(res.body).toEqual({
        error: 'edited_at_in_future',
        message: '編集した時刻が未来すぎます',
      });
      expect(await dumpTables(db())).toEqual(before);
    });

    it('9 分先までは通る', async () => {
      const res = await putEntry('e1', { draft: draft(), editedAt: Date.now() + 9 * 60_000 });

      expect(res.body).toEqual({ applied: true });
    });
  });

  it('4.5: 同じ id の既存の行と kind が違うと 409（conflict）で、DB は変わらない', async () => {
    await applyWrite(db(), {
      entries: [
        makeEntry({
          id: 'e1',
          kind: 'block',
          workspaceId: null,
          allDay: false,
          startTime: '09:00',
          endTime: '10:00',
        }),
      ],
    });
    const before = await dumpTables(db());

    const res = await putEntry('e1', { draft: draft(), editedAt: 2000 });

    expect(res.status).toBe(409);
    expect(res.body).toMatchObject({ error: 'conflict' });
    expect(await dumpTables(db())).toEqual(before);
  });
});

describe('PATCH /api/entries/:id（変更）', () => {
  it('EV-1: 繰り返さない予定は、範囲に関係なく、その行を書き換える', async () => {
    await applyWrite(db(), { entries: [makeEntry({ id: 'p', title: '旧' })] });

    const res = await patchEntry('p', { scope: 'this', changes: { title: '新' } });

    expect(res.body).toEqual({ applied: true });
    expect(await stored('p')).toMatchObject({ title: '新', edited_at: 2000 });
    expect((await fetchChanges(db(), 0)).entries).toHaveLength(1);
  });

  it('RP-4: 「この予定のみ」は、例外の行（newId）を作り、系列は書き換えない', async () => {
    await seedSeries();

    const res = await patchEntry('s', {
      occurrenceDate: '2026-10-21',
      scope: 'this',
      changes: { title: 'この日だけ' },
      newId: 'x1',
    });

    expect(res.body).toEqual({ applied: true });
    expect(await stored('x1')).toMatchObject({
      title: 'この日だけ',
      series_id: 's',
      original_date: '2026-10-21',
      cancelled: 0,
    });
    expect(await stored('s')).toMatchObject({ edited_at: 1000 });
  });

  it('RP-4: 「すべて」は、系列を書き換える', async () => {
    await seedSeries();

    const res = await patchEntry('s', { scope: 'all', changes: { title: '全部' } });

    expect(res.body).toEqual({ applied: true });
    expect(await stored('s')).toMatchObject({ title: '全部', edited_at: 2000 });
  });

  it('RP-4・SY-1: 「これ以降すべて」の変更は、切った系列・消した例外・新しい系列の 3 種類の行が届く', async () => {
    await applyWrite(db(), {
      entries: [
        makeEntry({ id: 's', rrule: { freq: 'daily' }, startDate: '2026-10-19', title: '旧' }),
        makeEntry({
          id: 'x',
          seriesId: 's',
          originalDate: '2026-10-23',
          startDate: '2026-10-23',
          endDate: '2026-10-23',
          title: '個別',
        }),
      ],
    });
    const { rev } = await fetchChanges(db(), 0);

    const res = await patchEntry('s', {
      occurrenceDate: '2026-10-21',
      scope: 'following',
      changes: { title: '新' },
      newId: 'n1',
      editedAt: 3000,
    });

    expect(res.body).toEqual({ applied: true });
    const changes = await fetchChanges(db(), rev);
    expect(changes.rev).toBe(rev + 1);
    expect(changes.entries).toHaveLength(3);
    const byId = Object.fromEntries(changes.entries.map((entry) => [entry.id, entry]));
    expect(byId['s']).toMatchObject({
      untilDate: '2026-10-20',
      title: '旧',
      editedAt: 3000,
      deletedAt: null,
    });
    expect(byId['x']).toMatchObject({ deletedAt: 3000, editedAt: 3000 });
    expect(byId['n1']).toMatchObject({
      title: '新',
      startDate: '2026-10-21',
      rrule: { freq: 'daily' },
      seriesId: null,
      editedAt: 3000,
      deletedAt: null,
    });
  });

  it('空の changes（何も変えていない）も受け付ける', async () => {
    await seedSeries();

    const res = await patchEntry('s', { scope: 'all', changes: {} });

    expect(res.body).toEqual({ applied: true });
  });

  describe('SY-3: 同じ依頼を 2 回送ると、2 回目は stale で捨て、DB は変わらない', () => {
    it.each([
      { scope: 'this', occurrenceDate: '2026-10-21' },
      { scope: 'following', occurrenceDate: '2026-10-21' },
      { scope: 'all', occurrenceDate: '2026-10-21' },
    ])('繰り返す予定の「$scope」', async ({ scope, occurrenceDate }) => {
      await seedSeries();
      const request = { scope, occurrenceDate, changes: { title: '新' }, newId: 'n1' };
      expect((await patchEntry('s', request)).body).toEqual({ applied: true });
      const before = await dumpTables(db());

      const second = await patchEntry('s', request);

      expect(second.status).toBe(200);
      expect(second.body).toEqual({ applied: false, reason: 'stale' });
      expect(await dumpTables(db())).toEqual(before);
    });

    it('繰り返さない予定', async () => {
      await applyWrite(db(), { entries: [makeEntry({ id: 'p' })] });
      const request = { scope: 'all', changes: { title: '新' } };
      await patchEntry('p', request);
      const before = await dumpTables(db());

      const second = await patchEntry('p', request);

      expect(second.body).toEqual({ applied: false, reason: 'stale' });
      expect(await dumpTables(db())).toEqual(before);
    });
  });

  it('SY-3: サーバーの行より古い依頼は、stale で捨て、DB は変わらない', async () => {
    await seedSeries({ editedAt: 3000 });
    const before = await dumpTables(db());

    const res = await patchEntry('s', {
      scope: 'all',
      changes: { title: '古い編集' },
      editedAt: 2000,
    });

    expect(res.body).toEqual({ applied: false, reason: 'stale' });
    expect(await dumpTables(db())).toEqual(before);
  });

  describe('対象がもうないときは、200 の applied: false（not_found）で捨てる（6.2）', () => {
    it('存在しない予定', async () => {
      const before = await dumpTables(db());

      const res = await patchEntry('nothing');

      expect(res.status).toBe(200);
      expect(res.body).toEqual({ applied: false, reason: 'not_found' });
      expect(await dumpTables(db())).toEqual(before);
    });

    it('系列の回でない日付（開始日より前）', async () => {
      await seedSeries();

      const res = await patchEntry('s', { scope: 'this', occurrenceDate: '2026-10-01' });

      expect(res.body).toEqual({ applied: false, reason: 'not_found' });
    });

    it('「これ以降すべて」で切られて、なくなった回', async () => {
      await seedSeries({ untilDate: '2026-10-25' });

      const res = await patchEntry('s', { scope: 'this', occurrenceDate: '2026-10-26' });

      expect(res.body).toEqual({ applied: false, reason: 'not_found' });
    });

    it('削除した回（cancelled の例外）への「この予定のみ」', async () => {
      await seedSeries();
      await deleteEntry('s', {
        scope: 'this',
        occurrenceDate: '2026-10-21',
        newId: 'x1',
        editedAt: 1500,
      });

      const res = await patchEntry('s', {
        scope: 'this',
        occurrenceDate: '2026-10-21',
        newId: 'x2',
      });

      expect(res.body).toEqual({ applied: false, reason: 'not_found' });
    });

    it('削除済みの系列（削除より新しい依頼なら not_found、古い依頼なら stale）', async () => {
      await seedSeries();
      await deleteEntry('s', { scope: 'all', editedAt: 5000 });
      const before = await dumpTables(db());

      const newer = await patchEntry('s', { editedAt: 6000 });
      const older = await patchEntry('s', { editedAt: 4000 });

      expect(newer.body).toEqual({ applied: false, reason: 'not_found' });
      expect(older.body).toEqual({ applied: false, reason: 'stale' });
      expect(await dumpTables(db())).toEqual(before);
    });

    it('例外の行の id を、系列の id として指した依頼', async () => {
      await seedSeries();
      await patchEntry('s', {
        scope: 'this',
        occurrenceDate: '2026-10-21',
        newId: 'x1',
        editedAt: 1500,
      });

      const res = await patchEntry('x1', { scope: 'all', editedAt: 3000 });

      expect(res.body).toEqual({ applied: false, reason: 'not_found' });
    });

    it('変更先のワークスペースが削除済み（ワークスペースの削除より新しい依頼）', async () => {
      await seedSeries();
      await seedWorkspace(db(), 'w2');
      await callApi(db(), 'DELETE', '/api/workspaces/w2', { body: { editedAt: 5000 } });
      const before = await dumpTables(db());

      const res = await patchEntry('s', { changes: { workspaceId: 'w2' }, editedAt: 6000 });

      expect(res.body).toEqual({ applied: false, reason: 'not_found' });
      expect(await dumpTables(db())).toEqual(before);
    });
  });

  describe('受け付けられない変更は 400', () => {
    it('「この予定のみ」で繰り返しのルールを変える（InvalidChangeError → invalid_change）', async () => {
      await seedSeries();
      const before = await dumpTables(db());

      const res = await patchEntry('s', {
        scope: 'this',
        occurrenceDate: '2026-10-21',
        changes: { rrule: { freq: 'weekly', days: [1] } },
      });

      expect(res.status).toBe(400);
      expect(res.body).toEqual({
        error: 'invalid_change',
        message: '変更の内容を受け付けられません',
      });
      expect(await dumpTables(db())).toEqual(before);
    });

    it('毎日の繰り返しの開始日をずらす（InvalidChangeError → invalid_change）', async () => {
      await seedSeries();

      const res = await patchEntry('s', {
        scope: 'all',
        occurrenceDate: '2026-10-21',
        changes: { startDate: '2026-10-22' },
      });

      expect(res.status).toBe(400);
      expect(res.body).toMatchObject({ error: 'invalid_change' });
    });

    it.each<{ name: string; series: Partial<Entry>; changes: Record<string, unknown> }>([
      {
        name: '終日にして、時刻を消していない',
        series: { allDay: false, startTime: '15:00', endTime: '16:00' },
        changes: { allDay: true },
      },
      {
        name: '時間指定にして、時刻を入れていない',
        series: { allDay: true },
        changes: { allDay: false },
      },
      {
        name: '終了を開始より前にした',
        series: { allDay: false, startTime: '15:00', endTime: '16:00' },
        changes: { endTime: '14:00' },
      },
      {
        name: 'ワークスペースを外した',
        series: { allDay: true },
        changes: { workspaceId: null },
      },
    ])('項目をまたぐ確認: 変更後の行で $name と 400', async ({ series, changes }) => {
      await seedSeries(series);
      const before = await dumpTables(db());

      const res = await patchEntry('s', { scope: 'all', changes });

      expect(res.status).toBe(400);
      expect(res.body).toEqual(invalidRequest);
      expect(await dumpTables(db())).toEqual(before);
    });

    it('項目をまたぐ確認: 終日にして、時刻を消せば通る', async () => {
      await seedSeries({ allDay: false, startTime: '15:00', endTime: '16:00' });

      const res = await patchEntry('s', {
        scope: 'all',
        changes: { allDay: true, startTime: null, endTime: null },
      });

      expect(res.body).toEqual({ applied: true });
    });

    it.each<{ name: string; overrides: Record<string, unknown> }>([
      { name: 'kind を変える', overrides: { changes: { kind: 'block' } } },
      { name: '知らないキーがある', overrides: { changes: { untilDate: '2026-12-31' } } },
      { name: 'タイトルが空', overrides: { changes: { title: '' } } },
      { name: 'URL が javascript:', overrides: { changes: { url: 'javascript:alert(1)' } } },
      { name: '年が範囲外', overrides: { changes: { startDate: '2200-01-01' } } },
      { name: 'scope が不正', overrides: { scope: 'some' } },
      { name: 'occurrenceDate が不正', overrides: { occurrenceDate: '2026-02-30' } },
      { name: 'newId の形が不正', overrides: { newId: 'new id' } },
      { name: 'editedAt がない', overrides: { editedAt: undefined } },
      { name: 'changes がない', overrides: { changes: undefined } },
    ])('入力の検証: $name と 400', async ({ overrides }) => {
      await seedSeries();
      const before = await dumpTables(db());

      const res = await patchEntry('s', overrides);

      expect(res.status).toBe(400);
      expect(res.body).toEqual(invalidRequest);
      expect(await dumpTables(db())).toEqual(before);
    });

    it('newId が系列の id と同じだと 400（例外の行が、系列の行を上書きしてしまうため）', async () => {
      await seedSeries();
      const before = await dumpTables(db());

      const res = await patchEntry('s', {
        scope: 'this',
        occurrenceDate: '2026-10-21',
        newId: 's',
      });

      expect(res.status).toBe(400);
      expect(res.body).toEqual(invalidRequest);
      expect(await dumpTables(db())).toEqual(before);
    });

    it('新しい行の id が、消す例外の行の id と重なると 400（500 にして、端末に再送させない）', async () => {
      await seedSeries();
      await patchEntry('s', {
        scope: 'this',
        occurrenceDate: '2026-10-23',
        newId: 'x1',
        editedAt: 1500,
      });
      const before = await dumpTables(db());

      const res = await patchEntry('s', {
        scope: 'following',
        occurrenceDate: '2026-10-21',
        newId: 'x1',
        changes: { title: '新' },
        editedAt: 3000,
      });

      expect(res.status).toBe(400);
      expect(res.body).toEqual(invalidRequest);
      expect(await dumpTables(db())).toEqual(before);
    });

    it('存在しないワークスペースへの変更は、外部キー違反として 409（conflict）', async () => {
      await seedSeries();
      const before = await dumpTables(db());

      const res = await patchEntry('s', { changes: { workspaceId: 'nothing' } });

      expect(res.status).toBe(409);
      expect(res.body).toMatchObject({ error: 'conflict' });
      expect(await dumpTables(db())).toEqual(before);
    });

    it('SY-3: editedAt がサーバーの今より 10 分より未来だと 400（edited_at_in_future）', async () => {
      await seedSeries();

      const res = await patchEntry('s', { editedAt: Date.now() + 11 * 60_000 });

      expect(res.status).toBe(400);
      expect(res.body).toMatchObject({ error: 'edited_at_in_future' });
    });
  });

  it('NF-5: 系列の行が壊れていると 500。本文には、中身を出さない', async () => {
    await db()
      .prepare(
        `INSERT INTO entries (id, kind, title, workspace_id, all_day, start_date, end_date, rrule,
           notify_enabled, notify_offset_min, edited_at, rev)
         VALUES ('s', 'event', 't', 'w1', 1, '2026-10-19', '2026-10-19', 'not-json', 1, 10, 1000, 1)`,
      )
      .run();

    const res = await patchEntry('s');

    expect(res.status).toBe(500);
    expect(res.body).toEqual({ error: 'internal_error', message: 'サーバーでエラーが起きました' });
  });
});

describe('DELETE /api/entries/:id（削除）', () => {
  it('EV-1: 繰り返さない予定を削除する（論理削除。deletedAt に削除の時刻が入る）', async () => {
    await applyWrite(db(), { entries: [makeEntry({ id: 'p' })] });
    const { rev } = await fetchChanges(db(), 0);

    const res = await deleteEntry('p');

    expect(res.body).toEqual({ applied: true });
    expect(await stored('p')).toMatchObject({ deleted_at: 2000, edited_at: 2000 });
    expect((await fetchChanges(db(), rev)).entries).toEqual([
      makeEntry({ id: 'p', editedAt: 2000, deletedAt: 2000 }),
    ]);
    expect((await fetchChanges(db(), 0)).entries).toEqual([]);
  });

  it('RP-4: 「すべて」は、系列と、すべての例外を削除する', async () => {
    await seedSeries();
    await patchEntry('s', {
      scope: 'this',
      occurrenceDate: '2026-10-21',
      newId: 'x1',
      editedAt: 1500,
    });

    const res = await deleteEntry('s', { scope: 'all', editedAt: 3000 });

    expect(res.body).toEqual({ applied: true });
    expect(await stored('s')).toMatchObject({ deleted_at: 3000 });
    expect(await stored('x1')).toMatchObject({ deleted_at: 3000 });
  });

  it('RP-4: 「この予定のみ」は、cancelled の例外の行（newId）を作り、系列は残す', async () => {
    await seedSeries();

    const res = await deleteEntry('s', {
      scope: 'this',
      occurrenceDate: '2026-10-21',
      newId: 'x1',
    });

    expect(res.body).toEqual({ applied: true });
    expect(await stored('x1')).toMatchObject({
      series_id: 's',
      original_date: '2026-10-21',
      cancelled: 1,
      deleted_at: null,
    });
    expect(await stored('s')).toMatchObject({ deleted_at: null, edited_at: 1000 });
  });

  it('RP-4: 「これ以降すべて」は、系列を前の日で切り、それ以降の例外を削除する', async () => {
    await seedSeries();
    await patchEntry('s', {
      scope: 'this',
      occurrenceDate: '2026-10-23',
      newId: 'x1',
      editedAt: 1500,
    });

    const res = await deleteEntry('s', {
      scope: 'following',
      occurrenceDate: '2026-10-21',
      editedAt: 3000,
    });

    expect(res.body).toEqual({ applied: true });
    expect(await stored('s')).toMatchObject({
      until_date: '2026-10-20',
      deleted_at: null,
      edited_at: 3000,
    });
    expect(await stored('x1')).toMatchObject({ deleted_at: 3000 });
  });

  describe('SY-3: 同じ依頼を 2 回送ると、2 回目は stale で捨て、DB は変わらない', () => {
    it.each([
      { scope: 'this', occurrenceDate: '2026-10-21' },
      { scope: 'following', occurrenceDate: '2026-10-21' },
      { scope: 'following', occurrenceDate: '2026-10-19' },
      { scope: 'all', occurrenceDate: '2026-10-21' },
    ])('繰り返す予定の「$scope」（$occurrenceDate）', async ({ scope, occurrenceDate }) => {
      await seedSeries();
      const request = { scope, occurrenceDate, newId: 'x1' };
      expect((await deleteEntry('s', request)).body).toEqual({ applied: true });
      const before = await dumpTables(db());

      const second = await deleteEntry('s', request);

      expect(second.status).toBe(200);
      expect(second.body).toEqual({ applied: false, reason: 'stale' });
      expect(await dumpTables(db())).toEqual(before);
    });

    it('繰り返さない予定', async () => {
      await applyWrite(db(), { entries: [makeEntry({ id: 'p' })] });
      await deleteEntry('p');
      const before = await dumpTables(db());

      const second = await deleteEntry('p');

      expect(second.body).toEqual({ applied: false, reason: 'stale' });
      expect(await dumpTables(db())).toEqual(before);
    });
  });

  it('SY-3: サーバーの行より古い依頼は、stale で捨て、DB は変わらない', async () => {
    await seedSeries({ editedAt: 3000 });
    const before = await dumpTables(db());

    const res = await deleteEntry('s', { scope: 'all', editedAt: 2000 });

    expect(res.body).toEqual({ applied: false, reason: 'stale' });
    expect(await dumpTables(db())).toEqual(before);
  });

  it('対象がもうない（存在しない予定・系列の回でない日付）ときは、not_found で捨てる', async () => {
    await seedSeries();
    const before = await dumpTables(db());

    const missing = await deleteEntry('nothing');
    const notOccurrence = await deleteEntry('s', { scope: 'this', occurrenceDate: '2026-10-01' });

    expect(missing.body).toEqual({ applied: false, reason: 'not_found' });
    expect(notOccurrence.body).toEqual({ applied: false, reason: 'not_found' });
    expect(await dumpTables(db())).toEqual(before);
  });

  it.each<{ name: string; overrides: Record<string, unknown> }>([
    { name: 'scope がない', overrides: { scope: undefined } },
    { name: 'scope が不正', overrides: { scope: 'some' } },
    { name: 'occurrenceDate がない', overrides: { occurrenceDate: undefined } },
    { name: '知らないキーがある', overrides: { changes: {} } },
    { name: 'newId が系列の id と同じ', overrides: { newId: 's' } },
  ])('入力の検証: $name と 400', async ({ overrides }) => {
    await seedSeries();
    const before = await dumpTables(db());

    const res = await deleteEntry('s', overrides);

    expect(res.status).toBe(400);
    expect(res.body).toEqual(invalidRequest);
    expect(await dumpTables(db())).toEqual(before);
  });

  it('SY-3: editedAt がサーバーの今より 10 分より未来だと 400（edited_at_in_future）', async () => {
    await seedSeries();

    const res = await deleteEntry('s', { editedAt: Date.now() + 11 * 60_000 });

    expect(res.status).toBe(400);
    expect(res.body).toMatchObject({ error: 'edited_at_in_future' });
  });

  it('WS-1: 削除済みのワークスペースの予定の削除も、受け付ける（行の確認は、削除する行にはしない）', async () => {
    await seedWorkspace(db(), 'w2');
    await applyWrite(db(), { entries: [makeEntry({ id: 'p', workspaceId: 'w2' })] });
    await applyWrite(db(), {
      workspaces: [makeWorkspace({ id: 'w2', editedAt: 3000, deletedAt: 3000 })],
    });

    const res = await deleteEntry('p', { editedAt: 4000 });

    expect(res.body).toEqual({ applied: true });
  });
});
