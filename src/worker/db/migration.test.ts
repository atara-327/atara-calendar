import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import {
  createTestDatabase,
  readMigrationFileStatements,
  readMigrationStatements,
  splitStatements,
  type TestDatabase,
} from '../../../test/helpers/d1';
import { makeWorkspace } from '../../../test/helpers/workspaces';
import { applyWrite, readChanges } from './store';

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

async function runStatements(statements: string[]): Promise<void> {
  await testDatabase.db.batch(statements.map((statement) => testDatabase.db.prepare(statement)));
}

async function readWorkspaces() {
  return (await testDatabase.db.prepare('SELECT * FROM workspaces ORDER BY id').all()).results;
}

async function readRev(): Promise<number> {
  const row = await testDatabase.db.prepare('SELECT rev FROM meta').first<{ rev: number }>();
  return row?.rev ?? Number.NaN;
}

describe('マイグレーション後の初期状態', () => {
  it('SY-1: meta は 1 行で、rev は 2（「予定」を入れた分と、その色を直した分だけ進んでいる）、epoch は 16 桁の 16 進数', async () => {
    const { results } = await testDatabase.db
      .prepare('SELECT * FROM meta')
      .all<{ id: number; rev: number; epoch: string }>();

    expect(results).toHaveLength(1);
    expect(results[0]).toMatchObject({ id: 1, rev: 2 });
    expect(results[0]?.epoch).toMatch(/^[0-9a-f]{16}$/);
  });

  it('WS-4: 組み込みの「祝日」「記念日」が、全端末で同じ固定の id で入っている', async () => {
    const { results } = await testDatabase.db
      .prepare('SELECT * FROM workspaces WHERE builtin IS NOT NULL ORDER BY sort_order')
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

  it('4.2・11.5: 最初のワークスペース「予定」が、全端末で同じ固定の id で、ピーコックの色で入っている', async () => {
    const { results } = await testDatabase.db
      .prepare('SELECT * FROM workspaces WHERE builtin IS NULL')
      .all();

    expect(results).toEqual([
      {
        id: 'default-workspace',
        name: '予定',
        color: '#4FC3F7',
        sort_order: 0,
        visible: 1,
        builtin: null,
        edited_at: 0,
        rev: 2,
        deleted_at: null,
      },
    ]);
  });

  it('SY-1: 「予定」は、初回の読み込みで返り、その rev は meta の rev と同じ（1 以上）', async () => {
    const changes = await readChanges(testDatabase.db, 0);

    const defaultWorkspace = changes.workspaces.find(
      ({ workspace }) => workspace.id === 'default-workspace',
    );
    expect(defaultWorkspace?.workspace).toMatchObject({ name: '予定', builtin: null });
    expect(defaultWorkspace?.rev).toBe(changes.rev);
    expect(changes.rev).toBeGreaterThanOrEqual(1);
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

describe('0002_default_workspace.sql', () => {
  const statements = readMigrationFileStatements('0002_default_workspace.sql');

  async function run(): Promise<void> {
    await runStatements(statements);
  }

  it('SY-1: すでに rev を覚えている端末も、差分（since）で「予定」を受け取れる', async () => {
    // 0002 を当てる前の本番に見立てる。「予定」を消し、予定の行が書かれて rev が 5 まで進んだことにする。
    await testDatabase.db.batch([
      testDatabase.db.prepare("DELETE FROM workspaces WHERE id = 'default-workspace'"),
      testDatabase.db.prepare('UPDATE meta SET rev = 5'),
    ]);

    await run();

    const changes = await readChanges(testDatabase.db, 5);
    expect(changes.rev).toBe(6);
    expect(changes.workspaces.map(({ workspace, rev }) => ({ id: workspace.id, rev }))).toEqual([
      { id: 'default-workspace', rev: 6 },
    ]);
  });

  it('同じ id の行がすでにあれば、何も変えない（rev も進めない）', async () => {
    await testDatabase.db
      .prepare(
        "UPDATE workspaces SET name = '仕事', edited_at = 1000 WHERE id = 'default-workspace'",
      )
      .run();
    const before = await readWorkspaces();
    const revBefore = await readRev();

    await run();

    expect(await readWorkspaces()).toEqual(before);
    expect(await readRev()).toBe(revBefore);
  });

  it('「予定」が論理削除されていても、生き返らせず、rev も進めない', async () => {
    await applyWrite(testDatabase.db, {
      workspaces: [
        makeWorkspace({
          id: 'default-workspace',
          name: '予定',
          color: '#039BE5',
          editedAt: 2000,
          deletedAt: 2000,
        }),
      ],
    });
    const before = await readWorkspaces();
    const revBefore = await readRev();

    await run();

    expect(await readWorkspaces()).toEqual(before);
    expect(await readRev()).toBe(revBefore);
    expect(before).toContainEqual(
      expect.objectContaining({ id: 'default-workspace', deleted_at: 2000, rev: revBefore }),
    );
  });
});

describe('0003_default_workspace_color.sql', () => {
  const statements = readMigrationFileStatements('0003_default_workspace_color.sql');

  async function run(): Promise<void> {
    await runStatements(statements);
  }

  it('SY-1: 0002 の後の「予定」の色を #4FC3F7 にして rev を進め、すでに rev を覚えている端末も、差分（since）で受け取れる', async () => {
    // 0002 を当てた直後の本番に見立てる。端末は、0002 が「予定」を入れた rev までを受け取っている。
    await testDatabase.db.batch([
      testDatabase.db.prepare("DELETE FROM workspaces WHERE id = 'default-workspace'"),
      testDatabase.db.prepare('UPDATE meta SET rev = 5'),
    ]);
    await runStatements(readMigrationFileStatements('0002_default_workspace.sql'));
    const revBefore = await readRev();

    await run();

    const changes = await readChanges(testDatabase.db, revBefore);
    expect(changes.rev).toBe(revBefore + 1);
    expect(
      changes.workspaces.map(({ workspace, rev }) => ({
        id: workspace.id,
        color: workspace.color,
        editedAt: workspace.editedAt,
        rev,
      })),
    ).toEqual([{ id: 'default-workspace', color: '#4FC3F7', editedAt: 0, rev: revBefore + 1 }]);
  });

  it('もう一度当てても、何も変えない（rev も進めない）', async () => {
    const before = await readWorkspaces();
    const revBefore = await readRev();

    await run();

    expect(await readWorkspaces()).toEqual(before);
    expect(await readRev()).toBe(revBefore);
  });

  it('4.2: 「予定」が編集済み（edited_at が 0 でない）なら、利用者が選んだ色を残し、rev も進めない', async () => {
    await applyWrite(testDatabase.db, {
      workspaces: [
        makeWorkspace({ id: 'default-workspace', name: '予定', color: '#E57373', editedAt: 2000 }),
      ],
    });
    const before = await readWorkspaces();
    const revBefore = await readRev();

    await run();

    expect(await readWorkspaces()).toEqual(before);
    expect(await readRev()).toBe(revBefore);
    expect(before).toContainEqual(
      expect.objectContaining({ id: 'default-workspace', color: '#E57373', rev: revBefore }),
    );
  });

  it('4.2: 編集済みなら、色が仮の値（#039BE5）のままでも、変えない（名前だけ変えた場合）', async () => {
    await applyWrite(testDatabase.db, {
      workspaces: [
        makeWorkspace({ id: 'default-workspace', name: '仕事', color: '#039BE5', editedAt: 2000 }),
      ],
    });
    const before = await readWorkspaces();
    const revBefore = await readRev();

    await run();

    expect(await readWorkspaces()).toEqual(before);
    expect(await readRev()).toBe(revBefore);
    expect(before).toContainEqual(
      expect.objectContaining({ id: 'default-workspace', color: '#039BE5', rev: revBefore }),
    );
  });

  it('「予定」が論理削除されていても、色を変えず、rev も進めない', async () => {
    await applyWrite(testDatabase.db, {
      workspaces: [
        makeWorkspace({
          id: 'default-workspace',
          name: '予定',
          color: '#039BE5',
          editedAt: 2000,
          deletedAt: 2000,
        }),
      ],
    });
    const before = await readWorkspaces();
    const revBefore = await readRev();

    await run();

    expect(await readWorkspaces()).toEqual(before);
    expect(await readRev()).toBe(revBefore);
    expect(before).toContainEqual(
      expect.objectContaining({ id: 'default-workspace', color: '#039BE5', deleted_at: 2000 }),
    );
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
