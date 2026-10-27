import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { createTestDatabase, type TestDatabase } from '../../../test/helpers/d1';
import { callApi, fetchChanges, seedWorkspace } from '../../../test/helpers/api';
import { makeDraft } from '../../../test/helpers/entries';
import { readNextNotifyAt } from '../../../test/helpers/rows';
import { jst } from '../../../test/helpers/time';
import type { EntryDraft, Scope } from '../../shared/schema';

// 保存したとき（PUT・PATCH・DELETE）に、next_notify_at が入ることを、API から確かめる（設計書 9.1）。
// 計算そのものは nextNotifyAt.test.ts、書き込みの仕組みは db/store.notify.test.ts で確かめている。
// ここでは、API が書く行（recurrence.ts・workspace.ts の結果）に、値が付くことを確かめる。

let testDatabase: TestDatabase;

beforeAll(async () => {
  testDatabase = await createTestDatabase();
});

afterAll(async () => {
  await testDatabase.dispose();
});

/** 計算に使う「今」。2026-10-27（火）の朝 9 時。API は Date.now() を使う。 */
const NOW = jst('2026-10-27', '09:00');

beforeEach(async () => {
  await testDatabase.reset();
  await seedWorkspace(db(), 'w1');
  vi.spyOn(Date, 'now').mockReturnValue(NOW);
  vi.spyOn(console, 'warn').mockImplementation(() => undefined);
  vi.spyOn(console, 'error').mockImplementation(() => undefined);
});

afterEach(() => {
  vi.restoreAllMocks();
});

function db(): D1Database {
  return testDatabase.db;
}

/** 15:00〜16:00・10 分前の予定の下書き。 */
function draft(overrides: Partial<EntryDraft> = {}): EntryDraft {
  return makeDraft({
    workspaceId: 'w1',
    startDate: '2026-10-27',
    endDate: '2026-10-27',
    ...overrides,
  });
}

async function put(id: string, entryDraft: EntryDraft, editedAt = 1000) {
  const res = await callApi(db(), 'PUT', `/api/entries/${id}`, {
    body: { draft: entryDraft, editedAt },
  });
  expect(res.body).toEqual({ applied: true });
}

async function patch(
  id: string,
  scope: Scope,
  occurrenceDate: string,
  changes: Record<string, unknown>,
  { newId, editedAt }: { newId: string; editedAt: number },
) {
  const res = await callApi(db(), 'PATCH', `/api/entries/${id}`, {
    body: { occurrenceDate, scope, changes, newId, editedAt },
  });
  expect(res.body).toEqual({ applied: true });
}

async function remove(
  id: string,
  scope: Scope,
  occurrenceDate: string,
  { newId, editedAt }: { newId: string; editedAt: number },
) {
  const res = await callApi(db(), 'DELETE', `/api/entries/${id}`, {
    body: { occurrenceDate, scope, newId, editedAt },
  });
  expect(res.body).toEqual({ applied: true });
}

describe('PUT /api/entries/:id（作成）', () => {
  it('NT-2: 時間指定の予定は、開始の 10 分前が入る', async () => {
    await put('e1', draft());

    expect(await readNextNotifyAt(db())).toEqual({ e1: jst('2026-10-27', '14:50') });
  });

  it('NT-3: 終日の予定は、当日の朝 6 時が入る', async () => {
    await put(
      'e1',
      draft({
        allDay: true,
        startDate: '2026-10-28',
        endDate: '2026-10-28',
        startTime: null,
        endTime: null,
        notifyOffsetMin: -360,
      }),
    );

    expect(await readNextNotifyAt(db())).toEqual({ e1: jst('2026-10-28', '06:00') });
  });

  it('NT-4: 通知が OFF の予定は、NULL', async () => {
    await put('e1', draft({ notifyEnabled: false }));

    expect(await readNextNotifyAt(db())).toEqual({ e1: null });
  });

  it('毎日の系列は、次の回の通知の時刻が入る', async () => {
    await put(
      's',
      draft({ rrule: { freq: 'daily' }, startDate: '2026-10-19', endDate: '2026-10-19' }),
    );

    expect(await readNextNotifyAt(db())).toEqual({ s: jst('2026-10-27', '14:50') });
  });

  it('開始日がルールに合わず、ずらした系列は、ずらした後の最初の回から探す', async () => {
    // 2026-10-27（火）から「毎週 金」。開始日は 10/30 にずれる。
    await put('s', draft({ rrule: { freq: 'weekly', days: [5] } }));

    expect(await readNextNotifyAt(db())).toEqual({ s: jst('2026-10-30', '14:50') });
  });
});

describe('PATCH /api/entries/:id（変更）', () => {
  describe('繰り返さない予定', () => {
    it('時刻を変えると、新しい時刻から計算し直す', async () => {
      await put('e1', draft());

      await patch(
        'e1',
        'all',
        '2026-10-27',
        { startTime: '16:00', endTime: '17:00' },
        { newId: 'n1', editedAt: 2000 },
      );

      expect(await readNextNotifyAt(db())).toEqual({ e1: jst('2026-10-27', '15:50') });
    });

    it('通知を OFF にすると、NULL になる', async () => {
      await put('e1', draft());

      await patch(
        'e1',
        'all',
        '2026-10-27',
        { notifyEnabled: false },
        { newId: 'n1', editedAt: 2000 },
      );

      expect(await readNextNotifyAt(db())).toEqual({ e1: null });
    });

    it('通知の分を変えると、その分で計算し直す', async () => {
      await put('e1', draft());

      await patch(
        'e1',
        'all',
        '2026-10-27',
        { notifyOffsetMin: 60 },
        { newId: 'n1', editedAt: 2000 },
      );

      expect(await readNextNotifyAt(db())).toEqual({ e1: jst('2026-10-27', '14:00') });
    });
  });

  describe('繰り返しの系列（毎日。2026-10-19 から）', () => {
    const daily = () =>
      draft({ rrule: { freq: 'daily' }, startDate: '2026-10-19', endDate: '2026-10-19' });

    it('この予定のみ: 次の回を別の日に移すと、系列はその日を飛ばし、例外の行は移した先の通知になる', async () => {
      await put('s', daily());

      await patch(
        's',
        'this',
        '2026-10-27',
        { startDate: '2026-10-29' },
        { newId: 'x', editedAt: 2000 },
      );

      expect(await readNextNotifyAt(db())).toEqual({
        s: jst('2026-10-28', '14:50'),
        x: jst('2026-10-29', '14:50'),
      });
    });

    it('この予定のみ: 例外の行だけの通知の分を変えても、系列の通知は変わらない', async () => {
      await put('s', daily());

      await patch(
        's',
        'this',
        '2026-10-28',
        { notifyOffsetMin: 60 },
        { newId: 'x', editedAt: 2000 },
      );

      expect(await readNextNotifyAt(db())).toEqual({
        s: jst('2026-10-27', '14:50'),
        x: jst('2026-10-28', '14:00'),
      });
    });

    it('これ以降すべて: 元の系列は切った後の回、新しい系列は変更後の内容の最初の回の通知になる', async () => {
      await put('s', daily());

      await patch(
        's',
        'following',
        '2026-10-28',
        { startTime: '16:00', endTime: '17:00' },
        { newId: 'n', editedAt: 2000 },
      );

      expect(await readNextNotifyAt(db())).toEqual({
        s: jst('2026-10-27', '14:50'),
        n: jst('2026-10-28', '15:50'),
      });
    });

    it('これ以降すべて: 今日の回から切ると、元の系列は、今日の回の通知も、もうない（NULL）', async () => {
      await put('s', daily());

      await patch(
        's',
        'following',
        '2026-10-27',
        { startTime: '16:00', endTime: '17:00' },
        { newId: 'n', editedAt: 2000 },
      );

      expect(await readNextNotifyAt(db())).toEqual({
        s: null,
        n: jst('2026-10-27', '15:50'),
      });
    });

    it('すべて: 時刻を変えると、系列の通知も、変えていない例外の行の通知も、計算し直す', async () => {
      await put('s', daily());
      await patch(
        's',
        'this',
        '2026-10-28',
        { startDate: '2026-10-30' },
        { newId: 'x', editedAt: 2000 },
      );

      await patch(
        's',
        'all',
        '2026-10-27',
        { notifyOffsetMin: 60 },
        { newId: 'n', editedAt: 3000 },
      );

      expect(await readNextNotifyAt(db())).toEqual({
        s: jst('2026-10-27', '14:00'),
        x: jst('2026-10-30', '14:00'),
      });
    });

    it('すべて: 通知を OFF にすると、系列も例外の行も、NULL になる', async () => {
      await put('s', daily());
      await patch(
        's',
        'this',
        '2026-10-28',
        { startDate: '2026-10-30' },
        { newId: 'x', editedAt: 2000 },
      );

      await patch(
        's',
        'all',
        '2026-10-27',
        { notifyEnabled: false },
        { newId: 'n', editedAt: 3000 },
      );

      expect(await readNextNotifyAt(db())).toEqual({ s: null, x: null });
    });

    it('すべて: ルールを変えると、例外の行は削除され（NULL）、系列は新しいルールの次の回になる', async () => {
      await put('s', daily());
      await patch(
        's',
        'this',
        '2026-10-28',
        { startDate: '2026-10-30' },
        { newId: 'x', editedAt: 2000 },
      );

      // 毎日 → 毎週 水・金。10/27 は火曜なので、次は 10/28（水）。
      await patch(
        's',
        'all',
        '2026-10-27',
        { rrule: { freq: 'weekly', days: [3, 5] } },
        { newId: 'n', editedAt: 3000 },
      );

      expect(await readNextNotifyAt(db())).toEqual({ s: jst('2026-10-28', '14:50'), x: null });
    });
  });
});

describe('DELETE /api/entries/:id（削除）', () => {
  const daily = () =>
    draft({ rrule: { freq: 'daily' }, startDate: '2026-10-19', endDate: '2026-10-19' });

  it('繰り返さない予定を削除すると、NULL になる', async () => {
    await put('e1', draft());

    await remove('e1', 'all', '2026-10-27', { newId: 'n1', editedAt: 2000 });

    expect(await readNextNotifyAt(db())).toEqual({ e1: null });
  });

  it('この予定のみ: その回を削除すると、例外の行は NULL で、系列はその日を飛ばす', async () => {
    await put('s', daily());

    await remove('s', 'this', '2026-10-27', { newId: 'x', editedAt: 2000 });

    expect(await readNextNotifyAt(db())).toEqual({ s: jst('2026-10-28', '14:50'), x: null });
  });

  it('これ以降すべて: 系列を切ると、切った後の回の通知は NULL になり、後ろの例外の行も NULL になる', async () => {
    await put('s', daily());
    await patch(
      's',
      'this',
      '2026-10-28',
      { startDate: '2026-10-30' },
      { newId: 'x', editedAt: 2000 },
    );

    await remove('s', 'following', '2026-10-27', { newId: 'n', editedAt: 3000 });

    expect(await readNextNotifyAt(db())).toEqual({ s: null, x: null });
  });

  it('すべて: 系列も例外の行も、NULL になる', async () => {
    await put('s', daily());
    await patch(
      's',
      'this',
      '2026-10-28',
      { startDate: '2026-10-30' },
      { newId: 'x', editedAt: 2000 },
    );

    await remove('s', 'all', '2026-10-27', { newId: 'n', editedAt: 3000 });

    expect(await readNextNotifyAt(db())).toEqual({ s: null, x: null });
  });
});

describe('DELETE /api/workspaces/:id（ワークスペースの削除）', () => {
  it('中の予定は NULL になり、別のワークスペースの系列は、そのまま通知される', async () => {
    await seedWorkspace(db(), 'w2');
    await put(
      's',
      draft({ rrule: { freq: 'daily' }, startDate: '2026-10-19', endDate: '2026-10-19' }),
    );
    await put('e2', draft({ workspaceId: 'w2', startDate: '2026-10-28', endDate: '2026-10-28' }));
    // 系列 s（w1）の 10/28 の回を、w2 に移して 10/29 にした例外の行 x。
    await patch(
      's',
      'this',
      '2026-10-28',
      { workspaceId: 'w2', startDate: '2026-10-29' },
      { newId: 'x', editedAt: 2000 },
    );
    expect(await readNextNotifyAt(db())).toEqual({
      s: jst('2026-10-27', '14:50'),
      x: jst('2026-10-29', '14:50'),
      e2: jst('2026-10-28', '14:50'),
    });

    const res = await callApi(db(), 'DELETE', '/api/workspaces/w2', { body: { editedAt: 3000 } });

    expect(res.body).toEqual({ applied: true });
    // e2 は削除、x は、その回を削除した形（cancelled）になるので、どちらも通知しない。
    expect(await readNextNotifyAt(db())).toEqual({
      s: jst('2026-10-27', '14:50'),
      x: null,
      e2: null,
    });
  });

  it('ワークスペースの中の系列は、例外の行も含めて、NULL になる', async () => {
    await put(
      's',
      draft({ rrule: { freq: 'daily' }, startDate: '2026-10-19', endDate: '2026-10-19' }),
    );
    await patch(
      's',
      'this',
      '2026-10-28',
      { startDate: '2026-10-30' },
      { newId: 'x', editedAt: 2000 },
    );
    await seedWorkspace(db(), 'w2');

    await callApi(db(), 'DELETE', '/api/workspaces/w1', { body: { editedAt: 3000 } });

    expect(await readNextNotifyAt(db())).toEqual({ s: null, x: null });
  });
});

describe('GET /api/changes', () => {
  it('SY-1: next_notify_at は、DB に入っていても、応答の行に含めない（サーバーの都合の値）', async () => {
    await put('e1', draft());
    expect((await readNextNotifyAt(db())).e1).not.toBeNull();

    const changes = await fetchChanges(db(), 0);

    expect(changes.entries).toHaveLength(1);
    expect(JSON.stringify(changes)).not.toMatch(/nextNotifyAt|next_notify_at/);
  });
});
