import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { createTestDatabase, type TestDatabase } from '../../../test/helpers/d1';
import { callApi, dumpTables, fetchChanges, seedWorkspace } from '../../../test/helpers/api';
import { makeEntry } from '../../../test/helpers/entries';
import { changesResponseSchema } from '../../shared/api';
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
  // 4xx・500 の応答は、原因をログに出す。テストの出力に混ぜないため、黙らせる。
  vi.spyOn(console, 'warn').mockImplementation(() => undefined);
  vi.spyOn(console, 'error').mockImplementation(() => undefined);
});

afterEach(() => {
  vi.restoreAllMocks();
});

function db(): D1Database {
  return testDatabase.db;
}

describe('GET /api/changes', () => {
  it('SY-1: 何も書いていないときは、rev 0・epoch・組み込みのワークスペースを返す', async () => {
    const res = await callApi(db(), 'GET', '/api/changes?since=0');

    expect(res.status).toBe(200);
    expect(res.body).toEqual({
      rev: 0,
      epoch: expect.stringMatching(/^[0-9a-f]{16}$/) as unknown,
      workspaces: [
        expect.objectContaining({ id: 'builtin-holiday', builtin: 'holiday' }),
        expect.objectContaining({ id: 'builtin-observance', builtin: 'observance' }),
        expect.objectContaining({ id: 'w1', builtin: null }),
      ],
      entries: [],
    });
  });

  it('応答は、スキーマ（changesResponseSchema）を満たす', async () => {
    await applyWrite(db(), { entries: [makeEntry({ id: 'e1' })] });

    const res = await callApi(db(), 'GET', '/api/changes?since=0');

    expect(changesResponseSchema.parse(res.body).entries).toEqual([makeEntry({ id: 'e1' })]);
  });

  it('SY-1: since より後に変わった行だけを返し、削除した行も含める', async () => {
    await applyWrite(db(), { entries: [makeEntry({ id: 'a' })] });
    await applyWrite(db(), { entries: [makeEntry({ id: 'b' })] });
    await applyWrite(db(), { entries: [makeEntry({ id: 'a', editedAt: 2000, deletedAt: 2000 })] });

    const changes = await fetchChanges(db(), 2);

    expect(changes.rev).toBe(3);
    expect(changes.entries.map(({ id, deletedAt }) => ({ id, deletedAt }))).toEqual([
      { id: 'a', deletedAt: 2000 },
    ]);
  });

  it('SY-1: since=0 は、削除した行を返さない', async () => {
    await applyWrite(db(), { entries: [makeEntry({ id: 'a' }), makeEntry({ id: 'b' })] });
    await applyWrite(db(), { entries: [makeEntry({ id: 'a', editedAt: 2000, deletedAt: 2000 })] });

    const changes = await fetchChanges(db(), 0);

    expect(changes.entries.map(({ id }) => id)).toEqual(['b']);
  });

  it('SY-1: 応答の行に、nextNotifyAt と行ごとの rev は含まれない（サーバーの都合の値）', async () => {
    await applyWrite(db(), { entries: [makeEntry({ id: 'a' })] });
    await db().prepare("UPDATE entries SET next_notify_at = 1234567890000 WHERE id = 'a'").run();

    const changes = await fetchChanges(db(), 0);

    expect(JSON.stringify(changes)).not.toMatch(/nextNotifyAt|next_notify_at/);
    const entry = changes.entries[0];
    const workspace = changes.workspaces[0];
    expect(entry).toBeDefined();
    expect(workspace).toBeDefined();
    expect(entry).not.toHaveProperty('rev');
    expect(workspace).not.toHaveProperty('rev');
    expect(Object.keys(changes).sort()).toEqual(['entries', 'epoch', 'rev', 'workspaces']);
  });

  it('SY-1: 復元して epoch を変えると、応答の epoch も変わる（付録 A.1）', async () => {
    await db().prepare("UPDATE meta SET epoch = 'restored'").run();

    expect((await fetchChanges(db(), 0)).epoch).toBe('restored');
  });

  it.each([
    { name: 'since がない', query: '' },
    { name: '空', query: '?since=' },
    { name: '負の数', query: '?since=-1' },
    { name: '小数', query: '?since=1.5' },
    { name: '指数表記', query: '?since=1e3' },
    { name: '数字でない', query: '?since=abc' },
    { name: '空白つき', query: '?since=%201' },
    { name: '安全な整数を超える桁数', query: '?since=9007199254740993' },
  ])('SY-1: since が不正（$name）なら 400。DB は読まない', async ({ query }) => {
    const res = await callApi(db(), 'GET', `/api/changes${query}`);

    expect(res.status).toBe(400);
    expect(res.body).toEqual({ error: 'invalid_request', message: '入力が正しくありません' });
  });

  it('NF-5: 行の構造が壊れていると 500。本文には、表名も id も出さない（付録 A.3）', async () => {
    await db()
      .prepare(
        `INSERT INTO entries (id, kind, title, all_day, start_date, end_date, notify_enabled,
           notify_offset_min, edited_at, rev)
         VALUES ('broken-id-xyz', 'event', 't', 0, 'not-a-date', '2026-10-19', 1, 10, 1000, 1)`,
      )
      .run();

    const res = await callApi(db(), 'GET', '/api/changes?since=0');

    expect(res.status).toBe(500);
    expect(res.body).toEqual({ error: 'internal_error', message: 'サーバーでエラーが起きました' });
    expect(JSON.stringify(res.body)).not.toMatch(/broken-id-xyz|entries|not-a-date/);
    // 直すための手がかりは、ログに残す。
    expect(console.error).toHaveBeenCalledWith(expect.stringContaining('broken-id-xyz'));
  });

  it('NF-2: エラー応答にも、API のセキュリティヘッダーが付く', async () => {
    const res = await callApi(db(), 'GET', '/api/changes?since=x');

    expect(res.status).toBe(400);
    expect(res.headers.get('Cache-Control')).toBe('no-store');
    expect(res.headers.get('X-Content-Type-Options')).toBe('nosniff');
  });

  it('SY-1: 読むだけで、DB は変わらない', async () => {
    await applyWrite(db(), { entries: [makeEntry({ id: 'a' })] });
    const before = await dumpTables(db());

    await callApi(db(), 'GET', '/api/changes?since=0');

    expect(await dumpTables(db())).toEqual(before);
  });
});
