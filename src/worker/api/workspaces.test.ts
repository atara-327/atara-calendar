import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { createTestDatabase, type TestDatabase } from '../../../test/helpers/d1';
import {
  callApi,
  callParsed,
  dumpTables,
  fetchChanges,
  seedWorkspace,
} from '../../../test/helpers/api';
import { makeEntry } from '../../../test/helpers/entries';
import { makeWorkspace } from '../../../test/helpers/workspaces';
import { occurrencesResponseSchema } from '../../shared/api';
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

function putWorkspace(id: string, workspace: unknown) {
  return callApi(db(), 'PUT', `/api/workspaces/${id}`, { body: { workspace } });
}

function deleteWorkspace(id: string, editedAt: number) {
  return callApi(db(), 'DELETE', `/api/workspaces/${id}`, { body: { editedAt } });
}

const invalidRequest = { error: 'invalid_request', message: '入力が正しくありません' };

describe('PUT /api/workspaces/:id（作成・更新）', () => {
  it('WS-1: 新しいワークスペースを作れる。応答は { applied: true } だけで、rev は返さない', async () => {
    const res = await putWorkspace('w2', makeWorkspace({ id: 'w2', name: '私用', editedAt: 2000 }));

    expect(res.status).toBe(200);
    expect(res.body).toEqual({ applied: true });
    const changes = await fetchChanges(db(), 0);
    expect(changes.workspaces.find(({ id }) => id === 'w2')).toEqual(
      makeWorkspace({ id: 'w2', name: '私用', editedAt: 2000 }),
    );
  });

  it('WS-1・WS-2・WS-3: 名前・色・並び順・表示を更新できる', async () => {
    const updated = makeWorkspace({
      id: 'w1',
      name: '仕事（新）',
      color: '#33B679',
      sortOrder: 3,
      visible: false,
      editedAt: 2000,
    });

    const res = await putWorkspace('w1', updated);

    expect(res.body).toEqual({ applied: true });
    const changes = await fetchChanges(db(), 0);
    expect(changes.workspaces.find(({ id }) => id === 'w1')).toEqual(updated);
  });

  it('SY-3: マイグレーションが入れた「予定」は、edited_at が 0 なので、端末の最初の編集（名前・色）が勝つ', async () => {
    const updated = makeWorkspace({
      id: 'default-workspace',
      name: '私用',
      color: '#33B679',
      editedAt: 1,
    });

    const res = await putWorkspace('default-workspace', updated);

    expect(res.body).toEqual({ applied: true });
    const changes = await fetchChanges(db(), 0);
    expect(changes.workspaces.find(({ id }) => id === 'default-workspace')).toEqual(updated);
  });

  it('SY-3: 同じ依頼を 2 回送ると、2 回目は stale で捨て、DB は変わらない', async () => {
    const workspace = makeWorkspace({ id: 'w2', editedAt: 2000 });
    await putWorkspace('w2', workspace);
    const before = await dumpTables(db());

    const second = await putWorkspace('w2', workspace);

    expect(second.status).toBe(200);
    expect(second.body).toEqual({ applied: false, reason: 'stale' });
    expect(await dumpTables(db())).toEqual(before);
  });

  it('SY-3: サーバーの行より古い依頼は、stale で捨て、DB は変わらない', async () => {
    await putWorkspace('w1', makeWorkspace({ id: 'w1', name: '新しい名前', editedAt: 3000 }));
    const before = await dumpTables(db());

    const res = await putWorkspace(
      'w1',
      makeWorkspace({ id: 'w1', name: '古い名前', editedAt: 2000 }),
    );

    expect(res.body).toEqual({ applied: false, reason: 'stale' });
    expect(await dumpTables(db())).toEqual(before);
  });

  it('SY-3: 削除済みのワークスペースへの更新は、生き返らせずに捨てる（削除より新しければ not_found、古ければ stale）', async () => {
    await seedWorkspace(db(), 'w2');
    await deleteWorkspace('w2', 5000);
    const before = await dumpTables(db());

    const newer = await putWorkspace('w2', makeWorkspace({ id: 'w2', editedAt: 6000 }));
    const older = await putWorkspace('w2', makeWorkspace({ id: 'w2', editedAt: 4000 }));

    expect(newer.body).toEqual({ applied: false, reason: 'not_found' });
    expect(older.body).toEqual({ applied: false, reason: 'stale' });
    expect(await dumpTables(db())).toEqual(before);
  });

  it('SY-3: 書き込みの途中の失敗は 500（internal_error）。端末は 5xx を再送する（設計書 6.2）', async () => {
    // 書き込みの batch だけが失敗する D1。型を合わせる as は、この 1 か所だけ。
    const failingDb = {
      prepare: (query: string) => db().prepare(query),
      batch: () => Promise.reject(new Error('secret-internal-detail')),
    } as unknown as D1Database;

    const res = await callApi(failingDb, 'PUT', '/api/workspaces/w2', {
      body: { workspace: makeWorkspace({ id: 'w2', editedAt: 2000 }) },
    });

    expect(res.status).toBe(500);
    expect(res.body).toEqual({ error: 'internal_error', message: 'サーバーでエラーが起きました' });
    expect(JSON.stringify(res.body)).not.toContain('secret-internal-detail');
  });

  describe('WS-4: 組み込みのワークスペースの保護', () => {
    const holiday = makeWorkspace({
      id: 'builtin-holiday',
      name: '祝日',
      color: '#F28B82',
      sortOrder: 1_000_000,
      builtin: 'holiday',
      editedAt: 2000,
    });

    it('表示（visible）と並び順（sortOrder）は変えられる', async () => {
      const res = await putWorkspace('builtin-holiday', {
        ...holiday,
        visible: false,
        sortOrder: 7,
      });

      expect(res.body).toEqual({ applied: true });
      const changes = await fetchChanges(db(), 0);
      expect(changes.workspaces.find(({ id }) => id === 'builtin-holiday')).toEqual({
        ...holiday,
        visible: false,
        sortOrder: 7,
      });
    });

    it.each([
      { name: '名前の変更', change: { name: '祝日（改）' } },
      { name: '色の変更', change: { color: '#000000' } },
      { name: 'builtin を外す', change: { builtin: null } },
      { name: 'builtin を別の種類に変える', change: { builtin: 'observance' } },
    ])('$name は 400（builtin_workspace）で、DB は変わらない', async ({ change }) => {
      const before = await dumpTables(db());

      const res = await putWorkspace('builtin-holiday', { ...holiday, ...change });

      expect(res.status).toBe(400);
      expect(res.body).toEqual({
        error: 'builtin_workspace',
        message: '組み込みのワークスペースには、この操作はできません',
      });
      expect(await dumpTables(db())).toEqual(before);
    });

    it('builtin を付けた新しいワークスペースの作成は 400（builtin_workspace）', async () => {
      const before = await dumpTables(db());

      const res = await putWorkspace(
        'w9',
        makeWorkspace({ id: 'w9', builtin: 'holiday', editedAt: 2000 }),
      );

      expect(res.status).toBe(400);
      expect(res.body).toMatchObject({ error: 'builtin_workspace' });
      expect(await dumpTables(db())).toEqual(before);
    });

    it('組み込みでない既存のワークスペースに、builtin を付けるのは 400（builtin_workspace）', async () => {
      const before = await dumpTables(db());

      const res = await putWorkspace(
        'w1',
        makeWorkspace({ id: 'w1', builtin: 'observance', editedAt: 2000 }),
      );

      expect(res.status).toBe(400);
      expect(res.body).toMatchObject({ error: 'builtin_workspace' });
      expect(await dumpTables(db())).toEqual(before);
    });
  });

  describe('入力の検証（NF-2・NF-5）', () => {
    const valid = makeWorkspace({ id: 'w2', editedAt: 2000 });

    it.each<{ name: string; workspace: Record<string, unknown> }>([
      { name: '名前が空', workspace: { ...valid, name: '' } },
      { name: '名前が 51 文字', workspace: { ...valid, name: 'あ'.repeat(51) } },
      { name: '色が #RRGGBB でない', workspace: { ...valid, color: 'red' } },
      { name: '並び順が整数でない', workspace: { ...valid, sortOrder: 1.5 } },
      { name: '表示が真偽値でない', workspace: { ...valid, visible: 'yes' } },
      { name: 'editedAt が負の数', workspace: { ...valid, editedAt: -1 } },
      {
        name: 'deletedAt が null でない（PUT では削除できない）',
        workspace: { ...valid, deletedAt: 3000 },
      },
      { name: '知らないキーがある', workspace: { ...valid, extra: 1 } },
      { name: '列が足りない', workspace: { id: 'w2', name: '私用' } },
    ])('$name なら 400。本文には Zod のエラー文を出さない', async ({ workspace }) => {
      const before = await dumpTables(db());

      const res = await putWorkspace('w2', workspace);

      expect(res.status).toBe(400);
      expect(res.body).toEqual(invalidRequest);
      expect(await dumpTables(db())).toEqual(before);
    });

    it('名前が 50 文字ちょうどなら通る', async () => {
      const res = await putWorkspace('w2', { ...valid, name: 'あ'.repeat(50) });

      expect(res.body).toEqual({ applied: true });
    });

    it('本文の id が URL の id と違うと 400', async () => {
      const res = await putWorkspace('w3', valid);

      expect(res.status).toBe(400);
      expect(res.body).toEqual(invalidRequest);
    });

    it.each([
      { name: '空白を含む', id: 'bad%20id' },
      { name: '記号を含む', id: 'a.b' },
      { name: '65 文字', id: 'a'.repeat(65) },
    ])('URL の id が $name と 400', async ({ id }) => {
      const res = await putWorkspace(id, { ...valid, id: 'w2' });

      expect(res.status).toBe(400);
      expect(res.body).toEqual(invalidRequest);
    });

    it('id が 64 文字ちょうどで、英数字とハイフンだけなら通る', async () => {
      const id = `${'a'.repeat(32)}-${'B'.repeat(31)}`;

      const res = await putWorkspace(id, { ...valid, id });

      expect(res.body).toEqual({ applied: true });
    });

    it('本文が JSON として読めないと 400', async () => {
      const res = await callApi(db(), 'PUT', '/api/workspaces/w2', { rawBody: '{not json' });

      expect(res.status).toBe(400);
      expect(res.body).toEqual(invalidRequest);
    });

    it('本文に workspace がないと 400', async () => {
      const res = await callApi(db(), 'PUT', '/api/workspaces/w2', { body: {} });

      expect(res.status).toBe(400);
      expect(res.body).toEqual(invalidRequest);
    });
  });

  describe('SY-3: editedAt がサーバーの今より 10 分より未来だと 400', () => {
    it('11 分先は 400（edited_at_in_future）で、DB は変わらない', async () => {
      const before = await dumpTables(db());

      const res = await putWorkspace(
        'w2',
        makeWorkspace({ id: 'w2', editedAt: Date.now() + 11 * 60_000 }),
      );

      expect(res.status).toBe(400);
      expect(res.body).toEqual({
        error: 'edited_at_in_future',
        message: '編集した時刻が未来すぎます',
      });
      expect(await dumpTables(db())).toEqual(before);
    });

    it('9 分先までは通る（端末の時計の普通のずれ）', async () => {
      const res = await putWorkspace(
        'w2',
        makeWorkspace({ id: 'w2', editedAt: Date.now() + 9 * 60_000 }),
      );

      expect(res.body).toEqual({ applied: true });
    });
  });
});

describe('DELETE /api/workspaces/:id', () => {
  /** w1 に、繰り返しの系列・その例外・繰り返さない予定。w2 に、繰り返さない予定。 */
  async function seedEntries() {
    await seedWorkspace(db(), 'w2');
    await applyWrite(db(), {
      entries: [
        makeEntry({ id: 'series', rrule: { freq: 'daily' }, workspaceId: 'w1' }),
        makeEntry({
          id: 'exception',
          seriesId: 'series',
          originalDate: '2026-10-20',
          startDate: '2026-10-20',
          endDate: '2026-10-20',
          workspaceId: 'w1',
        }),
        makeEntry({ id: 'plain', workspaceId: 'w1' }),
        makeEntry({ id: 'other', workspaceId: 'w2' }),
      ],
    });
  }

  it('WS-1・Q6: ワークスペースと、中の予定（系列・例外を含む）を、すべて削除済みとして届ける', async () => {
    await seedEntries();
    const { rev } = await fetchChanges(db(), 0);

    const res = await deleteWorkspace('w1', 5000);

    expect(res.status).toBe(200);
    expect(res.body).toEqual({ applied: true });
    const changes = await fetchChanges(db(), rev);
    expect(
      changes.workspaces.map(({ id, deletedAt, editedAt }) => ({ id, deletedAt, editedAt })),
    ).toEqual([{ id: 'w1', deletedAt: 5000, editedAt: 5000 }]);
    expect(
      changes.entries.map(({ id, deletedAt, editedAt }) => ({ id, deletedAt, editedAt })),
    ).toEqual([
      { id: 'exception', deletedAt: 5000, editedAt: 5000 },
      { id: 'plain', deletedAt: 5000, editedAt: 5000 },
      { id: 'series', deletedAt: 5000, editedAt: 5000 },
    ]);
  });

  it('Q6: 別のワークスペースの予定は消えない', async () => {
    await seedEntries();

    await deleteWorkspace('w1', 5000);

    const changes = await fetchChanges(db(), 0);
    expect(changes.entries.map(({ id }) => id)).toEqual(['other']);
    expect(changes.workspaces.map(({ id }) => id)).toContain('w2');
  });

  it('Q6: 例外の行が別のワークスペースを指していても、系列と一緒に消える', async () => {
    await seedWorkspace(db(), 'w2');
    await applyWrite(db(), {
      entries: [
        makeEntry({ id: 'series', rrule: { freq: 'daily' }, workspaceId: 'w1' }),
        makeEntry({
          id: 'moved',
          seriesId: 'series',
          originalDate: '2026-10-20',
          startDate: '2026-10-20',
          endDate: '2026-10-20',
          workspaceId: 'w2',
        }),
      ],
    });

    await deleteWorkspace('w1', 5000);

    expect((await fetchChanges(db(), 0)).entries).toEqual([]);
  });

  describe('別のワークスペースの系列の例外が、このワークスペースを指しているとき', () => {
    /** w1 の毎日の系列 's' の、10-20 の回を、この予定のみで w2 に移し、10-25 にした例外 'x'。 */
    async function seedMovedException() {
      await seedWorkspace(db(), 'w2');
      await applyWrite(db(), {
        entries: [
          makeEntry({ id: 's', rrule: { freq: 'daily' }, workspaceId: 'w1' }),
          makeEntry({
            id: 'x',
            seriesId: 's',
            originalDate: '2026-10-20',
            startDate: '2026-10-25',
            endDate: '2026-10-25',
            workspaceId: 'w2',
            title: '移した回',
          }),
        ],
      });
    }

    async function occurrenceDates() {
      const { occurrences } = await callParsed(
        db(),
        '/api/occurrences?from=2026-10-19&to=2026-10-25',
        occurrencesResponseSchema,
      );
      return occurrences.map(({ entryId, startDate }) => [entryId, startDate]);
    }

    it('Q6: 移していた回は消え、移す前の日（10-20）に、系列の回は戻らない。w1 の他の回は出る', async () => {
      await seedMovedException();
      expect(await occurrenceDates()).toContainEqual(['x', '2026-10-25']);

      const res = await deleteWorkspace('w2', 5000);

      expect(res.body).toEqual({ applied: true });
      expect(await occurrenceDates()).toEqual([
        ['s', '2026-10-19'],
        ['s', '2026-10-21'],
        ['s', '2026-10-22'],
        ['s', '2026-10-23'],
        ['s', '2026-10-24'],
        ['s', '2026-10-25'],
      ]);
    });

    it('Q6: 例外の行は、論理削除せず、その回を削除した形で w1 に戻す。系列の行は書き換えない', async () => {
      await seedMovedException();
      const { rev } = await fetchChanges(db(), 0);

      await deleteWorkspace('w2', 5000);

      const changes = await fetchChanges(db(), rev);
      expect(changes.entries).toHaveLength(1);
      expect(changes.entries[0]).toMatchObject({
        id: 'x',
        cancelled: true,
        workspaceId: 'w1',
        editedAt: 5000,
        deletedAt: null,
      });
      expect(changes.workspaces.map(({ id, deletedAt }) => [id, deletedAt])).toEqual([
        ['w2', 5000],
      ]);
    });

    it('系列が削除済みなら、例外の行は論理削除する', async () => {
      await seedMovedException();
      await applyWrite(db(), {
        entries: [
          makeEntry({ id: 's', rrule: { freq: 'daily' }, editedAt: 2000, deletedAt: 2000 }),
        ],
      });
      const { rev } = await fetchChanges(db(), 0);

      await deleteWorkspace('w2', 5000);

      const changes = await fetchChanges(db(), rev);
      expect(
        changes.entries.map(({ id, cancelled, deletedAt }) => [id, cancelled, deletedAt]),
      ).toEqual([['x', false, 5000]]);
    });
  });

  it('SY-3: 同じ依頼を 2 回送ると、2 回目は stale で捨て、DB は変わらない', async () => {
    await seedEntries();
    await deleteWorkspace('w1', 5000);
    const before = await dumpTables(db());

    const second = await deleteWorkspace('w1', 5000);

    expect(second.status).toBe(200);
    expect(second.body).toEqual({ applied: false, reason: 'stale' });
    expect(await dumpTables(db())).toEqual(before);
  });

  it('SY-3: 削除より新しい依頼が、削除済みのワークスペースを対象にしたら not_found', async () => {
    await seedEntries();
    await deleteWorkspace('w1', 5000);

    const res = await deleteWorkspace('w1', 6000);

    expect(res.body).toEqual({ applied: false, reason: 'not_found' });
  });

  it('存在しないワークスペースは、not_found で捨てる', async () => {
    const before = await dumpTables(db());

    const res = await deleteWorkspace('nothing', 5000);

    expect(res.status).toBe(200);
    expect(res.body).toEqual({ applied: false, reason: 'not_found' });
    expect(await dumpTables(db())).toEqual(before);
  });

  it('SY-3: 中の予定に、依頼より新しい編集があれば、依頼全体を捨てる（ワークスペースも消さない）', async () => {
    await seedEntries();
    await applyWrite(db(), {
      entries: [makeEntry({ id: 'plain', workspaceId: 'w1', editedAt: 9000 })],
    });
    const before = await dumpTables(db());

    const res = await deleteWorkspace('w1', 5000);

    expect(res.body).toEqual({ applied: false, reason: 'stale' });
    expect(await dumpTables(db())).toEqual(before);
  });

  it.each(['builtin-holiday', 'builtin-observance'])(
    'WS-4: 組み込みの %s は削除できない（400。builtin_workspace）',
    async (id) => {
      const before = await dumpTables(db());

      const res = await deleteWorkspace(id, 5000);

      expect(res.status).toBe(400);
      expect(res.body).toMatchObject({ error: 'builtin_workspace' });
      expect(await dumpTables(db())).toEqual(before);
    },
  );

  it('11.5: 最後の 1 つのワークスペースは削除できない（400。last_workspace）。組み込みは数えない', async () => {
    // マイグレーションが入れる「予定」を先に消して、w1 を最後の 1 つにする。
    const deletedDefault = await deleteWorkspace('default-workspace', 4000);
    expect(deletedDefault.body).toEqual({ applied: true });
    const before = await dumpTables(db());

    const res = await deleteWorkspace('w1', 5000);

    expect(res.status).toBe(400);
    expect(res.body).toEqual({
      error: 'last_workspace',
      message: '最後のワークスペースは削除できません',
    });
    expect(await dumpTables(db())).toEqual(before);
  });

  it('11.5: ほかに 1 つ残っていれば削除でき、そのあとの最後の 1 つは削除できない', async () => {
    // w1 のほかに残る 1 つは、マイグレーションが入れる「予定」。最後の 1 つも「予定」になる。
    const first = await deleteWorkspace('w1', 5000);
    const last = await deleteWorkspace('default-workspace', 6000);

    expect(first.body).toEqual({ applied: true });
    expect(last.status).toBe(400);
    expect(last.body).toMatchObject({ error: 'last_workspace' });
  });

  it('SY-3: editedAt がサーバーの今より 10 分より未来だと 400（edited_at_in_future）', async () => {
    await seedWorkspace(db(), 'w2');

    const res = await deleteWorkspace('w1', Date.now() + 11 * 60_000);

    expect(res.status).toBe(400);
    expect(res.body).toMatchObject({ error: 'edited_at_in_future' });
  });

  it.each([
    { name: 'editedAt がない', body: {} },
    { name: 'editedAt が数値でない', body: { editedAt: 'now' } },
    { name: '知らないキーがある', body: { editedAt: 5000, force: true } },
  ])('入力の検証: $name と 400', async ({ body }) => {
    await seedWorkspace(db(), 'w2');
    const before = await dumpTables(db());

    const res = await callApi(db(), 'DELETE', '/api/workspaces/w1', { body });

    expect(res.status).toBe(400);
    expect(res.body).toEqual(invalidRequest);
    expect(await dumpTables(db())).toEqual(before);
  });
});
