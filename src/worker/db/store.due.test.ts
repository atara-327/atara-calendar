import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import {
  createTestDatabase,
  removeDefaultWorkspace,
  type TestDatabase,
} from '../../../test/helpers/d1';
import { makeEntry } from '../../../test/helpers/entries';
import { readNextNotifyAt } from '../../../test/helpers/rows';
import { makeWorkspace } from '../../../test/helpers/workspaces';
import {
  SELECT_DUE_ENTRIES_SQL,
  advanceNextNotifyAt,
  applyWrite,
  readDueEntries,
  readLiveWorkspaceIds,
} from './store';

let testDatabase: TestDatabase;

beforeAll(async () => {
  testDatabase = await createTestDatabase();
});

afterAll(async () => {
  await testDatabase.dispose();
});

beforeEach(async () => {
  await testDatabase.reset();
  await removeDefaultWorkspace(testDatabase.db);
  await applyWrite(testDatabase.db, { workspaces: [makeWorkspace({ id: 'w1' })] });
});

function db(): D1Database {
  return testDatabase.db;
}

/** 予定の行を書き、next_notify_at を、決めた値にする（保存したときの計算は、store.notify.test.ts が確かめている）。 */
async function seed(
  rows: { id: string; nextNotifyAt: number | null; seriesId?: string; deletedAt?: number }[],
): Promise<void> {
  await applyWrite(db(), {
    entries: rows.map(({ id, seriesId, deletedAt }) =>
      makeEntry({
        id,
        seriesId: seriesId ?? null,
        originalDate: seriesId === undefined ? null : '2026-10-19',
        deletedAt: deletedAt ?? null,
        editedAt: 1000,
      }),
    ),
  });
  await db().batch(
    rows.map(({ id, nextNotifyAt }) =>
      db().prepare('UPDATE entries SET next_notify_at = ?1 WHERE id = ?2').bind(nextNotifyAt, id),
    ),
  );
}

describe('readDueEntries（通知の時刻が来た行を探す。設計書 9.1）', () => {
  it('時刻が来た行（next_notify_at が今以前）を、時刻の順に返す', async () => {
    await seed([
      { id: 'c', nextNotifyAt: 3000 },
      { id: 'a', nextNotifyAt: 1000 },
      { id: 'b', nextNotifyAt: 2000 },
    ]);

    const due = await readDueEntries(db(), 5000, 10);

    expect(due).toEqual([
      { id: 'a', familyId: 'a', nextNotifyAt: 1000 },
      { id: 'b', familyId: 'b', nextNotifyAt: 2000 },
      { id: 'c', familyId: 'c', nextNotifyAt: 3000 },
    ]);
  });

  it('今とちょうど同じ時刻の行は、返す。1 ミリ秒先の行は、返さない', async () => {
    await seed([
      { id: 'now', nextNotifyAt: 5000 },
      { id: 'later', nextNotifyAt: 5001 },
    ]);

    expect((await readDueEntries(db(), 5000, 10)).map(({ id }) => id)).toEqual(['now']);
  });

  it('next_notify_at が NULL の行（通知しない行）は、返さない', async () => {
    await seed([
      { id: 'off', nextNotifyAt: null },
      { id: 'on', nextNotifyAt: 1000 },
    ]);

    expect((await readDueEntries(db(), 5000, 10)).map(({ id }) => id)).toEqual(['on']);
  });

  it('削除された行は、next_notify_at が残っていても、返さない（deleted_at IS NULL）', async () => {
    await seed([
      { id: 'gone', nextNotifyAt: 1000, deletedAt: 4000 },
      { id: 'live', nextNotifyAt: 2000 },
    ]);

    expect((await readDueEntries(db(), 5000, 10)).map(({ id }) => id)).toEqual(['live']);
  });

  it('limit 件までしか返さない。時刻が早い順の先頭から', async () => {
    await seed(
      Array.from({ length: 15 }, (_, index) => ({
        id: `e${String(index).padStart(2, '0')}`,
        nextNotifyAt: 1000 + index,
      })),
    );

    const due = await readDueEntries(db(), 5000, 10);

    expect(due.map(({ id }) => id)).toEqual(
      Array.from({ length: 10 }, (_, index) => `e${String(index).padStart(2, '0')}`),
    );
  });

  it('例外の行の familyId は、元の系列の id。系列の行と、繰り返さない予定は、自分の id', async () => {
    await seed([
      { id: 's', nextNotifyAt: 1000 },
      { id: 'x', nextNotifyAt: 2000, seriesId: 's' },
    ]);

    const due = await readDueEntries(db(), 5000, 10);

    expect(due.map(({ id, familyId }) => [id, familyId])).toEqual([
      ['s', 's'],
      ['x', 's'],
    ]);
  });

  it('時刻が来た行がなければ、空', async () => {
    await seed([{ id: 'future', nextNotifyAt: 9000 }]);

    expect(await readDueEntries(db(), 5000, 10)).toEqual([]);
  });

  it('部分索引 entries_notify を使う（全行を走査しない。D1 の読み取り行数を使わない）', async () => {
    const { results } = await db()
      .prepare(`EXPLAIN QUERY PLAN ${SELECT_DUE_ENTRIES_SQL}`)
      .bind(5000, 10)
      .all<{ detail: string }>();

    const plan = results.map(({ detail }) => detail).join('\n');
    expect(plan).toContain('USING INDEX entries_notify');
    expect(plan).not.toContain('SCAN entries');
    // 索引で時刻の順に取れるので、並べ替えのための一時的な表は要らない。
    expect(plan).not.toContain('TEMP B-TREE');
  });
});

describe('advanceNextNotifyAt（条件付きの UPDATE）', () => {
  it('値が読んだ値のままなら、次の値に変えて、true を返す', async () => {
    await seed([{ id: 'a', nextNotifyAt: 1000 }]);

    expect(await advanceNextNotifyAt(db(), 'a', 1000, 2000)).toBe(true);
    expect(await readNextNotifyAt(db())).toEqual({ a: 2000 });
  });

  it('次がなければ、NULL にできる', async () => {
    await seed([{ id: 'a', nextNotifyAt: 1000 }]);

    expect(await advanceNextNotifyAt(db(), 'a', 1000, null)).toBe(true);
    expect(await readNextNotifyAt(db())).toEqual({ a: null });
  });

  it('値が読んだ値と違えば（別の実行か保存が先に変えた）、何もせず、false を返す', async () => {
    await seed([{ id: 'a', nextNotifyAt: 3000 }]);

    expect(await advanceNextNotifyAt(db(), 'a', 1000, 2000)).toBe(false);
    expect(await readNextNotifyAt(db())).toEqual({ a: 3000 });
  });

  it('同じ更新を 2 回続けると、2 回目は false（二重に送らない）', async () => {
    await seed([{ id: 'a', nextNotifyAt: 1000 }]);

    expect(await advanceNextNotifyAt(db(), 'a', 1000, 2000)).toBe(true);
    expect(await advanceNextNotifyAt(db(), 'a', 1000, 2000)).toBe(false);
  });

  it('NULL の行は、読んだ値と一致しないので、false', async () => {
    await seed([{ id: 'a', nextNotifyAt: null }]);

    expect(await advanceNextNotifyAt(db(), 'a', 1000, 2000)).toBe(false);
    expect(await readNextNotifyAt(db())).toEqual({ a: null });
  });

  it('ほかの行は変えない', async () => {
    await seed([
      { id: 'a', nextNotifyAt: 1000 },
      { id: 'b', nextNotifyAt: 1000 },
    ]);

    await advanceNextNotifyAt(db(), 'a', 1000, 2000);

    expect(await readNextNotifyAt(db())).toEqual({ a: 2000, b: 1000 });
  });

  it('rev と edited_at は変えない（next_notify_at は端末に送らない列のため）', async () => {
    await seed([{ id: 'a', nextNotifyAt: 1000 }]);
    const before = await db()
      .prepare('SELECT rev, edited_at FROM entries WHERE id = ?1')
      .bind('a')
      .first();

    await advanceNextNotifyAt(db(), 'a', 1000, 2000);

    expect(
      await db().prepare('SELECT rev, edited_at FROM entries WHERE id = ?1').bind('a').first(),
    ).toEqual(before);
  });
});

describe('readLiveWorkspaceIds', () => {
  it('削除されていないワークスペース（組み込みを含む）の id を返す', async () => {
    await applyWrite(db(), {
      workspaces: [makeWorkspace({ id: 'w2', editedAt: 2000 })],
    });

    const ids = await readLiveWorkspaceIds(db());

    expect(ids).toEqual(new Set(['builtin-holiday', 'builtin-observance', 'w1', 'w2']));
  });

  it('削除されたワークスペースは、含めない', async () => {
    await applyWrite(db(), {
      workspaces: [makeWorkspace({ id: 'w2', editedAt: 2000, deletedAt: 3000 })],
    });

    expect((await readLiveWorkspaceIds(db())).has('w2')).toBe(false);
    expect((await readLiveWorkspaceIds(db())).has('w1')).toBe(true);
  });
});
