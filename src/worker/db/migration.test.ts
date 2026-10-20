import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import {
  createTestDatabase,
  readMigrationStatements,
  splitStatements,
  type TestDatabase,
} from '../../../test/helpers/d1';

let testDatabase: TestDatabase;

beforeAll(async () => {
  testDatabase = await createTestDatabase();
});

afterAll(async () => {
  await testDatabase.dispose();
});

beforeEach(async () => {
  await testDatabase.reset();
});

describe('マイグレーション後の初期状態', () => {
  it('SY-1: meta は 1 行で、rev は 0、epoch は 16 桁の 16 進数', async () => {
    const { results } = await testDatabase.db
      .prepare('SELECT * FROM meta')
      .all<{ id: number; rev: number; epoch: string }>();

    expect(results).toHaveLength(1);
    expect(results[0]).toMatchObject({ id: 1, rev: 0 });
    expect(results[0]?.epoch).toMatch(/^[0-9a-f]{16}$/);
  });

  it('WS-4: 組み込みの「祝日」「記念日」が、全端末で同じ固定の id で入っている', async () => {
    const { results } = await testDatabase.db
      .prepare('SELECT * FROM workspaces ORDER BY sort_order')
      .all();

    expect(results).toEqual([
      {
        id: 'builtin-holiday',
        name: '祝日',
        color: '#F28B82',
        sort_order: 1_000_000,
        visible: 1,
        builtin: 'holiday',
        edited_at: 0,
        rev: 0,
        deleted_at: null,
      },
      {
        id: 'builtin-observance',
        name: '記念日',
        color: '#9AA0A6',
        sort_order: 1_000_001,
        visible: 1,
        builtin: 'observance',
        edited_at: 0,
        rev: 0,
        deleted_at: null,
      },
    ]);
  });

  it('予定の表は空', async () => {
    const row = await testDatabase.db.prepare('SELECT count(*) AS count FROM entries').first();

    expect(row).toEqual({ count: 0 });
  });

  it('索引（rev・系列・通知）が作られている', async () => {
    const { results } = await testDatabase.db
      .prepare("SELECT name FROM sqlite_master WHERE type = 'index' AND name LIKE 'entries_%'")
      .all<{ name: string }>();

    expect(results.map(({ name }) => name).sort()).toEqual([
      'entries_notify',
      'entries_rev',
      'entries_series',
    ]);
  });

  it('meta は 1 行しか持てない', async () => {
    const insertSecond = testDatabase.db
      .prepare("INSERT INTO meta (id, rev, epoch) VALUES (2, 0, 'x')")
      .run();

    await expect(insertSecond).rejects.toThrow();
  });

  it('リセットするたびに、epoch は別の値になる', async () => {
    const read = async () =>
      (await testDatabase.db.prepare('SELECT epoch FROM meta').first<{ epoch: string }>())?.epoch;
    const before = await read();
    await testDatabase.reset();

    expect(await read()).not.toBe(before);
  });
});

describe('テスト用の SQL の分割', () => {
  it('文を `;` で分け、複数行の文はそのまま 1 つにする', () => {
    expect(splitStatements('CREATE TABLE a (\n  id TEXT\n);\nDROP TABLE a;\n')).toEqual([
      'CREATE TABLE a (\n  id TEXT\n)',
      'DROP TABLE a',
    ]);
  });

  it('`--` のコメントは捨て、コメントの中の `;` で分けない', () => {
    expect(
      splitStatements('-- 先頭; のコメント\nSELECT 1; -- 末尾; のコメント\nSELECT 2;'),
    ).toEqual(['SELECT 1', 'SELECT 2']);
  });

  it("'...' の中の `;` と `--` は、文字列として残す", () => {
    expect(splitStatements("INSERT INTO a VALUES ('x;y', 'p--q');")).toEqual([
      "INSERT INTO a VALUES ('x;y', 'p--q')",
    ]);
  });

  it('migrations/ の SQL がすべて文に分かれる', () => {
    expect(readMigrationStatements().length).toBeGreaterThan(0);
  });
});
