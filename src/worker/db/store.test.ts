import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { z } from 'zod';
import { changeEntry, createEntry, deleteEntry } from '../../shared/recurrence';
import type { Entry, EntryDraft } from '../../shared/schema';
import { createTestDatabase, type TestDatabase } from '../../../test/helpers/d1';
import { makeEntry } from '../../../test/helpers/entries';
import { makeWorkspace } from '../../../test/helpers/workspaces';
import { CorruptRowError } from './rows';
import {
  KindMismatchError,
  MAX_UPSERT_VALUE_BYTES,
  applyWrite,
  readChanges,
  type Database,
  type WriteRequest,
} from './store';

let testDatabase: TestDatabase;

beforeAll(async () => {
  testDatabase = await createTestDatabase();
});

afterAll(async () => {
  await testDatabase.dispose();
});

/** 予定の行が使う外部キーの相手 'w1' を、rev 0 の行として最初から入れておく（rev の数え方を 0 から始めるため）。 */
beforeEach(async () => {
  await testDatabase.reset();
  await testDatabase.db
    .prepare(
      `INSERT INTO workspaces (id, name, color, sort_order, visible, builtin, edited_at, rev)
       VALUES ('w1', '仕事', '#4285F4', 0, 1, NULL, 0, 0)`,
    )
    .run();
});

function db(): D1Database {
  return testDatabase.db;
}

/** テーブルの中身をそのまま取り出す。「DB が変わらない」ことを、行の変換を通さずに確かめるため。 */
async function dump() {
  const [meta, workspaces, entries] = await db().batch([
    db().prepare('SELECT * FROM meta'),
    db().prepare('SELECT * FROM workspaces ORDER BY id'),
    db().prepare('SELECT * FROM entries ORDER BY id'),
  ]);
  return { meta: meta?.results, workspaces: workspaces?.results, entries: entries?.results };
}

function byId(rows: readonly Entry[]): Record<string, Entry> {
  return Object.fromEntries(rows.map((row) => [row.id, row]));
}

/** 1 回目の batch（edited_at の確認）の後、2 回目（書き込み）の前に、別の端末の書き込みを割り込ませる db。 */
function interleavedWith(interleavingWrite: WriteRequest): Database {
  let batches = 0;
  return {
    prepare: (query) => db().prepare(query),
    batch: async <T>(statements: D1PreparedStatement[]) => {
      batches += 1;
      if (batches === 2) await applyWrite(db(), interleavingWrite);
      return db().batch<T>(statements);
    },
  };
}

describe('readChanges', () => {
  it('SY-1: 何も書いていないときは、rev 0 と、組み込みの 2 つのワークスペースを返す', async () => {
    const changes = await readChanges(db(), 0);

    expect(changes.rev).toBe(0);
    expect(changes.entries).toEqual([]);
    expect(changes.workspaces.map(({ workspace }) => workspace.id)).toEqual([
      'builtin-holiday',
      'builtin-observance',
      'w1',
    ]);
  });

  it('SY-1: epoch は meta の値で、復元して epoch を変えると、別の値で返る（付録 A.1）', async () => {
    const before = await readChanges(db(), 0);
    await db().prepare("UPDATE meta SET epoch = 'restored'").run();
    const after = await readChanges(db(), 0);

    expect(before.epoch).toMatch(/^[0-9a-f]{16}$/);
    expect(after.epoch).toBe('restored');
  });

  it('SY-1: rev は、meta の今の rev', async () => {
    await applyWrite(db(), { entries: [makeEntry({ id: 'a' })] });
    await applyWrite(db(), { entries: [makeEntry({ id: 'b' })] });

    expect((await readChanges(db(), 0)).rev).toBe(2);
    expect((await readChanges(db(), 2)).rev).toBe(2);
  });

  describe('SY-1: sinceRev より大きい rev の行だけを返す', () => {
    beforeEach(async () => {
      await applyWrite(db(), { entries: [makeEntry({ id: 'a' })] });
      await applyWrite(db(), { entries: [makeEntry({ id: 'b' })] });
      await applyWrite(db(), { entries: [makeEntry({ id: 'c' })] });
    });

    it.each([
      { sinceRev: 0, ids: ['a', 'b', 'c'] },
      { sinceRev: 1, ids: ['b', 'c'] },
      { sinceRev: 2, ids: ['c'] },
      { sinceRev: 3, ids: [] },
      { sinceRev: 99, ids: [] },
    ])('sinceRev $sinceRev → $ids', async ({ sinceRev, ids }) => {
      const changes = await readChanges(db(), sinceRev);

      expect(changes.entries.map(({ entry }) => entry.id)).toEqual(ids);
    });

    it('各行の rev を、行と別に返す', async () => {
      const changes = await readChanges(db(), 1);

      expect(changes.entries.map(({ rev }) => rev)).toEqual([2, 3]);
    });

    it('rev の順に返す。同じ rev なら id の順', async () => {
      await applyWrite(db(), { entries: [makeEntry({ id: 'z' }), makeEntry({ id: 'd' })] });

      const changes = await readChanges(db(), 2);

      expect(changes.entries.map(({ entry }) => entry.id)).toEqual(['c', 'd', 'z']);
    });
  });

  describe('削除した行（deletedAt がある行）', () => {
    beforeEach(async () => {
      await applyWrite(db(), {
        entries: [makeEntry({ id: 'a' }), makeEntry({ id: 'b' })],
        workspaces: [makeWorkspace({ id: 'w2' })],
      });
      await applyWrite(db(), {
        entries: [makeEntry({ id: 'b', editedAt: 2000, deletedAt: 2000 })],
        workspaces: [makeWorkspace({ id: 'w2', editedAt: 2000, deletedAt: 2000 })],
      });
    });

    it('SY-1: sinceRev = 0（初回の読み込み）では返さない', async () => {
      const changes = await readChanges(db(), 0);

      expect(changes.entries.map(({ entry }) => entry.id)).toEqual(['a']);
      expect(changes.workspaces.map(({ workspace }) => workspace.id)).not.toContain('w2');
    });

    it('SY-1: sinceRev が 1 以上なら返す（他の端末に、削除を伝えるため）', async () => {
      const changes = await readChanges(db(), 1);

      expect(changes.entries).toEqual([
        {
          entry: makeEntry({ id: 'b', editedAt: 2000, deletedAt: 2000 }),
          rev: 2,
          nextNotifyAt: null,
        },
      ]);
      expect(changes.workspaces.map(({ workspace }) => workspace.id)).toEqual(['w2']);
      expect(changes.workspaces[0]?.workspace.deletedAt).toBe(2000);
    });

    it('削除した後の rev より後を読むときは、もう返さない', async () => {
      const changes = await readChanges(db(), 2);

      expect(changes.entries).toEqual([]);
      expect(changes.workspaces).toEqual([]);
    });
  });

  describe('WS-4: 組み込みのワークスペース（rev 0）', () => {
    it('sinceRev = 0 では返すが、sinceRev が 1 以上では返さない（初回の読み込みで受け取り済みのため）', async () => {
      await applyWrite(db(), { entries: [makeEntry({ id: 'a' })] });

      const first = await readChanges(db(), 0);
      const later = await readChanges(db(), 1);

      expect(first.workspaces.map(({ workspace }) => workspace.builtin)).toContain('holiday');
      expect(later.workspaces).toEqual([]);
    });

    it('表示を OFF にして書き換えると、新しい rev で返り、初回の読み込みにも反映される', async () => {
      const holiday = (await readChanges(db(), 0)).workspaces.find(
        ({ workspace }) => workspace.id === 'builtin-holiday',
      );
      if (holiday === undefined) throw new Error('組み込みの祝日がない');
      await applyWrite(db(), {
        workspaces: [{ ...holiday.workspace, visible: false, editedAt: 1000 }],
      });

      const changes = await readChanges(db(), 0);

      expect(
        changes.workspaces.find(({ workspace }) => workspace.id === 'builtin-holiday'),
      ).toEqual({ workspace: { ...holiday.workspace, visible: false, editedAt: 1000 }, rev: 1 });
    });
  });

  it('sinceRev が負の数や小数なら RangeError', async () => {
    await expect(readChanges(db(), -1)).rejects.toThrow(RangeError);
    await expect(readChanges(db(), 1.5)).rejects.toThrow(RangeError);
    await expect(readChanges(db(), Number.NaN)).rejects.toThrow(RangeError);
  });

  describe('読み込みは構造だけを確かめる（設計書 6.3）', () => {
    const INSERT_ENTRY = `INSERT INTO entries (id, kind, title, start_date, start_time, end_date, notify_enabled, notify_offset_min, edited_at, rev)
      VALUES (?1, 'event', 'x', ?2, ?3, ?2, 1, 10, 1000, 1)`;

    afterEach(() => {
      vi.restoreAllMocks();
    });

    it('入力のルール（15 分刻みの時刻など）に合わない行でも、構造が成り立っていれば読める', async () => {
      await db().prepare(INSERT_ENTRY).bind('odd-time', '2026-10-19', '15:10').run();

      const { entries } = await readChanges(db(), 0);

      expect(entries.map(({ entry }) => [entry.id, entry.startTime])).toEqual([
        ['odd-time', '15:10'],
      ]);
    });

    it.each([
      { table: 'entries', id: 'broken', sql: INSERT_ENTRY, params: ['broken', 'not-a-date', null] },
      {
        table: 'workspaces',
        id: 'broken',
        sql: `INSERT INTO workspaces (id, name, color, sort_order, visible, edited_at, rev)
          VALUES (?1, 'x', '#000000', 0, 2, 1000, 1)`,
        params: ['broken'],
      },
    ])(
      '$table の構造が壊れた行が 1 つでもあれば、ほかの正しい行も返さず、全体を CorruptRowError にする',
      async ({ table, id, sql, params }) => {
        const error = vi.spyOn(console, 'error').mockImplementation(() => undefined);
        await db().prepare(INSERT_ENTRY).bind('good', '2026-10-19', null).run();
        await db()
          .prepare(sql)
          .bind(...params)
          .run();

        const read = readChanges(db(), 0);

        await expect(read).rejects.toThrow(CorruptRowError);
        await expect(read).rejects.toMatchObject({ table, rowId: id });
        expect(error).toHaveBeenCalledWith(
          expect.stringContaining(`${table} の行が壊れています（id: ${id}）`),
        );
      },
    );

    it('壊れた行がなければ、ログを出さない', async () => {
      const error = vi.spyOn(console, 'error').mockImplementation(() => undefined);
      await applyWrite(db(), { entries: [makeEntry({ id: 'a' })] });

      await readChanges(db(), 0);

      expect(error).not.toHaveBeenCalled();
    });
  });
});

describe('applyWrite', () => {
  describe('SY-1: 書き込み', () => {
    it('新しい行を追加すると rev が 1 つ増え、読み直すと同じ行になる', async () => {
      const entry = makeEntry({ id: 'a', title: '歯医者', rrule: { freq: 'daily' } });

      const result = await applyWrite(db(), { entries: [entry] });

      expect(result).toEqual({ applied: true, rev: 1 });
      const changes = await readChanges(db(), 0);
      expect(changes.rev).toBe(1);
      expect(changes.entries).toEqual([{ entry, rev: 1, nextNotifyAt: null }]);
    });

    it('行を更新すると rev がもう 1 つ増え、その行の rev も新しくなる', async () => {
      await applyWrite(db(), { entries: [makeEntry({ id: 'a', title: '歯医者' })] });
      const updated = makeEntry({ id: 'a', title: '内科', editedAt: 2000 });

      const result = await applyWrite(db(), { entries: [updated] });

      expect(result).toEqual({ applied: true, rev: 2 });
      expect((await readChanges(db(), 0)).entries).toEqual([
        { entry: updated, rev: 2, nextNotifyAt: null },
      ]);
    });

    it('1 回の依頼で書いた全部の行（予定とワークスペース）が、同じ rev になる', async () => {
      await applyWrite(db(), {
        entries: [makeEntry({ id: 'a' }), makeEntry({ id: 'b' }), makeEntry({ id: 'c' })],
        workspaces: [makeWorkspace({ id: 'w2' })],
      });

      const changes = await readChanges(db(), 0);

      expect(changes.rev).toBe(1);
      expect(changes.entries.map(({ rev }) => rev)).toEqual([1, 1, 1]);
      expect(changes.workspaces.find(({ workspace }) => workspace.id === 'w2')?.rev).toBe(1);
    });

    it('ワークスペースを先に書くので、同じ依頼で作るワークスペースを使う予定も書ける', async () => {
      const result = await applyWrite(db(), {
        workspaces: [makeWorkspace({ id: 'w2' })],
        entries: [makeEntry({ id: 'a', workspaceId: 'w2' })],
      });

      expect(result).toEqual({ applied: true, rev: 1 });
    });

    it('予定とワークスペースのどちらも空の依頼は、何も書かず、今の rev を返す', async () => {
      await applyWrite(db(), { entries: [makeEntry({ id: 'a' })] });
      const before = await dump();

      const result = await applyWrite(db(), {});

      expect(result).toEqual({ applied: true, rev: 1 });
      expect(await dump()).toEqual(before);
    });

    describe('next_notify_at（通知の時刻は、通知を作る実装 #11 が計算する）', () => {
      const NOTIFY_AT = 1_760_000_000_000;

      function nextNotifyAt() {
        return db().prepare("SELECT next_notify_at FROM entries WHERE id = 'a'").first();
      }

      it('新しい行では、書かず、NULL のままにする', async () => {
        await applyWrite(db(), { entries: [makeEntry({ id: 'a' })] });

        expect(await nextNotifyAt()).toEqual({ next_notify_at: null });
      });

      it('行を更新したら、古い通知の時刻を残さず、NULL に戻す（変更した予定の通知が古い時刻に飛ばないように）', async () => {
        await applyWrite(db(), { entries: [makeEntry({ id: 'a' })] });
        await db()
          .prepare("UPDATE entries SET next_notify_at = ?1 WHERE id = 'a'")
          .bind(NOTIFY_AT)
          .run();

        await applyWrite(db(), {
          entries: [makeEntry({ id: 'a', title: '変更', editedAt: 2000 })],
        });

        expect(await nextNotifyAt()).toEqual({ next_notify_at: null });
      });

      it('行を削除したときも、NULL に戻す（削除した予定の通知が飛ばないように）', async () => {
        await applyWrite(db(), { entries: [makeEntry({ id: 'a' })] });
        await db()
          .prepare("UPDATE entries SET next_notify_at = ?1 WHERE id = 'a'")
          .bind(NOTIFY_AT)
          .run();

        await applyWrite(db(), {
          entries: [makeEntry({ id: 'a', editedAt: 2000, deletedAt: 2000 })],
        });

        expect(await nextNotifyAt()).toEqual({ next_notify_at: null });
      });

      it('古くて捨てられた依頼では、行を更新しないので、通知の時刻も残る', async () => {
        await applyWrite(db(), { entries: [makeEntry({ id: 'a', editedAt: 2000 })] });
        await db()
          .prepare("UPDATE entries SET next_notify_at = ?1 WHERE id = 'a'")
          .bind(NOTIFY_AT)
          .run();

        await applyWrite(db(), {
          entries: [makeEntry({ id: 'a', title: '古い', editedAt: 1000 })],
        });

        expect(await nextNotifyAt()).toEqual({ next_notify_at: NOTIFY_AT });
      });
    });

    describe('kind は作成後に変えられない（設計書 4.5）', () => {
      it('新しい行には kind を書く', async () => {
        await applyWrite(db(), {
          entries: [makeEntry({ id: 'b', kind: 'block', workspaceId: null })],
        });

        const row = await db().prepare("SELECT kind FROM entries WHERE id = 'b'").first();

        expect(row).toEqual({ kind: 'block' });
      });

      describe('同じ id で別の kind の行が届いたら、呼び出し側のバグなので、何も書かずに KindMismatchError にする', () => {
        beforeEach(async () => {
          await applyWrite(db(), { entries: [makeEntry({ id: 'a', kind: 'event', title: '元' })] });
        });

        const blockOfA = (overrides: Partial<Entry> = {}) =>
          makeEntry({ id: 'a', kind: 'block', workspaceId: null, title: '更新', ...overrides });

        it('edited_at が新しくても、ほかの正しい行も含めて、何も書かれない', async () => {
          const before = await dump();

          const write = applyWrite(db(), {
            entries: [makeEntry({ id: 'good', editedAt: 2000 }), blockOfA({ editedAt: 2000 })],
            workspaces: [makeWorkspace({ id: 'good-ws', editedAt: 2000 })],
          });

          await expect(write).rejects.toThrow(KindMismatchError);
          await expect(write).rejects.toMatchObject({ entryId: 'a' });
          expect(await dump()).toEqual(before);
        });

        it('edited_at が古くても、「捨てた」と返さず、例外にする（バグを隠さない）', async () => {
          const write = applyWrite(db(), { entries: [blockOfA({ editedAt: 500 })] });

          await expect(write).rejects.toThrow(KindMismatchError);
        });

        it('メッセージに、id と、今の kind と、届いた kind を入れる', async () => {
          const write = applyWrite(db(), { entries: [blockOfA({ editedAt: 2000 })] });

          await expect(write).rejects.toThrow(/id: a、今の kind: event、届いた kind: block/);
        });

        it('kind が同じなら、更新できる', async () => {
          const result = await applyWrite(db(), {
            entries: [makeEntry({ id: 'a', kind: 'event', title: '更新', editedAt: 2000 })],
          });

          expect(result).toEqual({ applied: true, rev: 2 });
        });
      });

      it('確認の後に、別の書き込みが同じ id の行を別の kind で作ったときは、kind は作成時のまま残り、ほかの列は更新される', async () => {
        const interleaving = interleavedWith({
          entries: [makeEntry({ id: 'a', kind: 'event', title: '別の端末の作成' })],
        });

        const result = await applyWrite(interleaving, {
          entries: [
            makeEntry({ id: 'a', kind: 'block', workspaceId: null, title: '更新', editedAt: 2000 }),
          ],
        });

        expect(result).toEqual({ applied: true, rev: 2 });
        const { entries } = await readChanges(db(), 1);
        expect(entries.map(({ entry }) => [entry.kind, entry.title, entry.workspaceId])).toEqual([
          ['event', '更新', null],
        ]);
      });
    });

    it('同じ id の行が 1 つの依頼に 2 つあるのは、呼び出し側のバグなので、例外にする', async () => {
      const rows = [makeEntry({ id: 'a', editedAt: 1000 }), makeEntry({ id: 'a', editedAt: 2000 })];

      await expect(applyWrite(db(), { entries: rows })).rejects.toThrow(/同じ id/);
    });
  });

  describe('1 回の書き込みの文の数（D1 の 1 回の呼び出しあたりのクエリ数の上限のため）', () => {
    /** 渡された batch の文の数と、upsert に bind された値の大きさ（UTF-8 のバイト数）を、呼ばれた順に記録する db。 */
    function recordingDatabase() {
      const batchSizes: number[] = [];
      const upsertValueBytes: number[] = [];
      const encoder = new TextEncoder();
      const database: Database = {
        prepare: (query) => {
          const statement = db().prepare(query);
          if (!query.includes('ON CONFLICT')) return statement;
          // Miniflare の文は bind を差し替えられないので、upsert の文だけ、bind を記録する入れ物で包む。
          // 包んだ文は batch に渡さない。bind の結果（本物の文）だけを、batch に渡す。
          const recording = {
            bind: (...values: unknown[]) => {
              for (const value of values)
                upsertValueBytes.push(encoder.encode(String(value)).length);
              return statement.bind(...values);
            },
          };
          return recording as unknown as D1PreparedStatement;
        },
        batch: <T>(statements: D1PreparedStatement[]) => {
          batchSizes.push(statements.length);
          return db().batch<T>(statements);
        },
      };
      return { database, batchSizes, upsertValueBytes };
    }

    it('予定とワークスペースを数百行書いても、書き込みの batch は rev・workspaces・entries の 3 文', async () => {
      const { database, batchSizes } = recordingDatabase();

      await applyWrite(database, {
        workspaces: [makeWorkspace({ id: 'w2' }), makeWorkspace({ id: 'w3' })],
        entries: Array.from({ length: 300 }, (_, index) => makeEntry({ id: `e${String(index)}` })),
      });

      // 1 つ目は edited_at の確認（表ごとに 1 文）、2 つ目が書き込み
      expect(batchSizes).toEqual([2, 3]);
    });

    it('書く行がない表の文は、batch に入れない', async () => {
      const { database, batchSizes } = recordingDatabase();

      await applyWrite(database, { entries: [makeEntry({ id: 'a' }), makeEntry({ id: 'b' })] });

      expect(batchSizes).toEqual([2, 2]);
    });

    describe('upsert の値 1 つは、D1 の上限（約 2MB）に収まるように、約 1MB ごとのかたまりに分ける', () => {
      /** UTF-8 で約 300KB の予定。日本語は 1 文字 3 バイトなので、文字数は 10 万。 */
      const bigEntry = (id: string, overrides: Partial<Entry> = {}) =>
        makeEntry({ id, memo: '漢'.repeat(100_000), ...overrides });
      const bigEntries = (count: number) =>
        Array.from({ length: count }, (_, index) => bigEntry(`big${String(index)}`));

      afterEach(() => {
        vi.restoreAllMocks();
      });

      it('大きな依頼でも、bind する値は 1 つ残らず上限以下で、かたまりごとの文が、同じ 1 回の batch に入る', async () => {
        const { database, batchSizes, upsertValueBytes } = recordingDatabase();

        await applyWrite(database, { entries: bigEntries(8) });

        expect(upsertValueBytes).toHaveLength(3);
        expect(upsertValueBytes.every((bytes) => bytes <= MAX_UPSERT_VALUE_BYTES)).toBe(true);
        // 1 つ目は edited_at の確認、2 つ目が書き込み（rev の UPDATE ＋ かたまりごとの upsert）
        expect(batchSizes).toEqual([2, 1 + 3]);
      });

      it('大きさは、文字数ではなく UTF-8 のバイト数で数える（文字数の合計は上限未満でも、バイト数が超えるなら分ける）', async () => {
        const { database, upsertValueBytes } = recordingDatabase();

        await applyWrite(database, { entries: bigEntries(5) });

        expect(5 * 100_000).toBeLessThan(MAX_UPSERT_VALUE_BYTES);
        expect(upsertValueBytes).toHaveLength(2);
        expect(upsertValueBytes.every((bytes) => bytes <= MAX_UPSERT_VALUE_BYTES)).toBe(true);
      });

      it('複数のかたまりに分かれても、全部の行が同じ rev になり、読み直すと同じ行になる', async () => {
        const entries = bigEntries(8);

        const result = await applyWrite(db(), { entries });

        expect(result).toEqual({ applied: true, rev: 1 });
        const changes = await readChanges(db(), 0);
        expect(changes.rev).toBe(1);
        expect(changes.entries.map(({ rev }) => rev)).toEqual(Array.from({ length: 8 }, () => 1));
        expect(byId(changes.entries.map(({ entry }) => entry))).toEqual(byId(entries));
      });

      it('途中のかたまりで失敗したら、前のかたまりも含めて、1 行も書かれず、rev も進まない（全部か無しか）', async () => {
        const { database, upsertValueBytes } = recordingDatabase();
        await applyWrite(db(), { entries: [makeEntry({ id: 'a' })] });
        const before = await dump();

        // 最後のかたまりの行が、存在しないワークスペースを指している（外部キーの違反）
        const write = applyWrite(database, {
          entries: [...bigEntries(7), bigEntry('ng', { workspaceId: 'no-such-workspace' })],
        });

        await expect(write).rejects.toThrow(/FOREIGN KEY/);
        expect(upsertValueBytes).toHaveLength(3);
        expect(await dump()).toEqual(before);
      });

      it('書けた行数は、かたまりをまたいで表ごとに合計して比べる。弾かれた行があれば、合計の行数をログに出す', async () => {
        const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
        // 1 つ目のかたまり（big0）と、3 つ目のかたまり（big7）の行が、別の端末の新しい編集に割り込まれる
        const interleaving = interleavedWith({
          entries: [
            makeEntry({ id: 'big0', editedAt: 3000 }),
            makeEntry({ id: 'big7', editedAt: 3000 }),
          ],
        });

        await applyWrite(interleaving, {
          entries: bigEntries(8).map((e) => ({ ...e, editedAt: 2000 })),
        });

        expect(warn).toHaveBeenCalledTimes(1);
        expect(String(warn.mock.calls[0]?.[0])).toContain('entries の 8 行のうち、書けたのは 6 行');
      });

      it('かたまりが複数でも、全部の行が書けたときは、ログを出さない', async () => {
        const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);

        await applyWrite(db(), { entries: bigEntries(8) });

        expect(warn).not.toHaveBeenCalled();
      });

      it('1 行だけで上限を超える行は、分けられないので、その行だけで 1 つのかたまりになる（防ぐのは、入力の文字列の長さの上限。#4c）', async () => {
        const { database, upsertValueBytes } = recordingDatabase();
        const huge = bigEntry('huge', { memo: '漢'.repeat(400_000) });

        const result = await applyWrite(database, {
          entries: [makeEntry({ id: 'a' }), huge, makeEntry({ id: 'b' })],
        });

        expect(result).toEqual({ applied: true, rev: 1 });
        expect(upsertValueBytes.filter((bytes) => bytes > MAX_UPSERT_VALUE_BYTES)).toHaveLength(1);
        expect(upsertValueBytes).toHaveLength(3);
        expect((await readChanges(db(), 0)).entries.map(({ entry }) => entry.id)).toEqual([
          'a',
          'b',
          'huge',
        ]);
      });
    });

    it('3000 行の依頼（ワークスペースの削除で、中の予定をすべて論理削除するような依頼）を書ける', async () => {
      const entries = Array.from({ length: 3000 }, (_, index) =>
        makeEntry({ id: `e${String(index)}`, title: `予定 ${String(index)}` }),
      );
      await applyWrite(db(), { entries });
      const deleted = entries.map((entry) => ({ ...entry, editedAt: 2000, deletedAt: 2000 }));

      const result = await applyWrite(db(), { entries: deleted });

      expect(result).toEqual({ applied: true, rev: 2 });
      const changes = await readChanges(db(), 1);
      expect(changes.entries).toHaveLength(3000);
      expect(changes.entries.every(({ entry, rev }) => entry.deletedAt === 2000 && rev === 2)).toBe(
        true,
      );
      expect((await readChanges(db(), 0)).entries).toEqual([]);
    }, 30_000);

    it('全部の列に値がある行や、引用符・改行・絵文字・バックスラッシュを含む文字列も、そのまま書いて読める', async () => {
      const entry = makeEntry({
        id: 'full',
        title: `"引用" 'シングル' \\ バックスラッシュ\n改行\t😀 {"json":[1,2]}`,
        allDay: false,
        startDate: '2026-10-19',
        startTime: '15:00',
        endDate: '2026-10-19',
        endTime: '16:00',
        location: '○○歯科',
        url: 'https://example.com/?q=a&b=c',
        memo: '1 行目\n2 行目',
        rrule: { freq: 'weekly', days: [1, 3, 5] },
        untilDate: '2027-03-31',
        seriesId: 's0',
        originalDate: '2026-10-19',
        cancelled: true,
        notifyEnabled: false,
        notifyOffsetMin: -360,
        editedAt: 1_760_000_000_000,
        deletedAt: 1_760_000_100_000,
      });

      await applyWrite(db(), { entries: [makeEntry({ id: 'other' })] });

      await applyWrite(db(), { entries: [entry] });

      const row = await db().prepare('SELECT * FROM entries WHERE id = ?1').bind('full').first();
      expect(row).toMatchObject({
        all_day: 0,
        cancelled: 1,
        notify_enabled: 0,
        rrule: '{"freq":"weekly","days":[1,3,5]}',
        edited_at: 1_760_000_000_000,
      });
      expect((await readChanges(db(), 1)).entries.map(({ entry }) => entry)).toEqual([entry]);
    });
  });

  describe('書く前の検証（entrySchema・workspaceSchema）', () => {
    it.each<{ reason: string; invalid: WriteRequest }>([
      {
        reason: '時刻が 15 分刻みでない予定',
        invalid: { entries: [makeEntry({ id: 'bad', allDay: false, startTime: '15:10' })] },
      },
      {
        reason: '存在しない日付の予定',
        invalid: { entries: [makeEntry({ id: 'bad', startDate: '2026-02-30' })] },
      },
      {
        reason: '曜日のない weekly の予定',
        invalid: { entries: [makeEntry({ id: 'bad', rrule: { freq: 'weekly', days: [] } })] },
      },
      {
        reason: '色の形が違うワークスペース',
        invalid: { workspaces: [makeWorkspace({ id: 'bad', color: 'red' })] },
      },
    ])(
      '$reason が 1 つでもあれば、ほかの正しい行も含めて何も書かず、例外にする',
      async ({ invalid }) => {
        const before = await dump();

        const write = applyWrite(db(), {
          entries: [makeEntry({ id: 'good', editedAt: 2000 }), ...(invalid.entries ?? [])],
          workspaces: [
            makeWorkspace({ id: 'good-ws', editedAt: 2000 }),
            ...(invalid.workspaces ?? []),
          ],
        });

        await expect(write).rejects.toThrow(z.ZodError);
        expect(await dump()).toEqual(before);
      },
    );

    it('検証を通る行は、境界の値でも、書けて、読み直すと同じ行になる（書けた行は必ず読める）', async () => {
      const entries = [
        makeEntry({
          id: 'min',
          title: '',
          allDay: false,
          startDate: '0001-01-01',
          startTime: '00:00',
          endDate: '0001-01-01',
          endTime: '00:00',
          notifyOffsetMin: -1440,
        }),
        makeEntry({
          id: 'max',
          allDay: false,
          startDate: '9999-12-31',
          startTime: '23:45',
          endDate: '9999-12-31',
          endTime: '23:45',
          rrule: { freq: 'weekly', days: [0, 6] },
        }),
      ];
      const workspaces = [makeWorkspace({ id: 'w-lower', color: '#abcdef', name: '' })];

      await applyWrite(db(), { entries, workspaces });

      const changes = await readChanges(db(), 0);
      expect(byId(changes.entries.map(({ entry }) => entry))).toEqual(byId(entries));
      expect(
        changes.workspaces.find(({ workspace }) => workspace.id === 'w-lower')?.workspace,
      ).toEqual(workspaces[0]);
    });
  });

  describe('SY-3: 食い違ったときは、edited_at が新しい方を残す', () => {
    const stored = makeEntry({ id: 'a', title: '元', editedAt: 1000 });

    beforeEach(async () => {
      await applyWrite(db(), { entries: [stored] });
    });

    afterEach(() => {
      vi.restoreAllMocks();
    });

    it('今の行より古い edited_at の依頼は、全体が捨てられて、DB は変わらない', async () => {
      const before = await dump();

      const result = await applyWrite(db(), {
        entries: [makeEntry({ id: 'a', title: '古い編集', editedAt: 500 })],
      });

      expect(result).toEqual({ applied: false });
      expect(await dump()).toEqual(before);
    });

    it('今の行と同じ edited_at の依頼は、内容が違っても捨てられる', async () => {
      const before = await dump();

      const result = await applyWrite(db(), {
        entries: [makeEntry({ id: 'a', title: '同じ時刻の別の編集', editedAt: 1000 })],
      });

      expect(result).toEqual({ applied: false });
      expect(await dump()).toEqual(before);
    });

    it('同じ依頼を 2 回送ると、2 回目は「もう反映済み」として捨てられ、rev は進まない', async () => {
      const request = { entries: [makeEntry({ id: 'a', title: '新', editedAt: 2000 })] };

      const first = await applyWrite(db(), request);
      const afterFirst = await dump();
      const second = await applyWrite(db(), request);

      expect(first).toEqual({ applied: true, rev: 2 });
      expect(second).toEqual({ applied: false });
      expect(await dump()).toEqual(afterFirst);
    });

    it('複数行のうち 1 行だけ古いと、依頼全体が捨てられる（新しい行も書かれない）', async () => {
      const before = await dump();

      const result = await applyWrite(db(), {
        entries: [
          makeEntry({ id: 'new-row', editedAt: 3000 }),
          makeEntry({ id: 'a', title: '古い編集', editedAt: 500 }),
        ],
      });

      expect(result).toEqual({ applied: false });
      expect(await dump()).toEqual(before);
    });

    it('古い行が予定でなくワークスペースの方でも、依頼全体が捨てられる', async () => {
      await applyWrite(db(), { workspaces: [makeWorkspace({ id: 'w2', editedAt: 2000 })] });
      const before = await dump();

      const result = await applyWrite(db(), {
        workspaces: [makeWorkspace({ id: 'w2', name: '古い名前', editedAt: 1500 })],
        entries: [makeEntry({ id: 'new-row', editedAt: 3000 })],
      });

      expect(result).toEqual({ applied: false });
      expect(await dump()).toEqual(before);
    });

    describe('同じ id の行が、ワークスペースと予定の両方の表にあるとき（id は表の中でだけ一意）', () => {
      beforeEach(async () => {
        await applyWrite(db(), {
          workspaces: [makeWorkspace({ id: 'x', editedAt: 2000 })],
          entries: [makeEntry({ id: 'x', editedAt: 1000 })],
        });
      });

      it('ワークスペースだけが古い依頼は、予定の方が新しくても、全体が捨てられる（一部だけ保存されない）', async () => {
        const before = await dump();

        const result = await applyWrite(db(), {
          workspaces: [makeWorkspace({ id: 'x', name: '古い名前', editedAt: 1500 })],
          entries: [makeEntry({ id: 'x', title: '新しい編集', editedAt: 3000 })],
        });

        expect(result).toEqual({ applied: false });
        expect(await dump()).toEqual(before);
      });

      it('予定だけが古い依頼も、ワークスペースの方が新しくても、全体が捨てられる', async () => {
        const before = await dump();

        const result = await applyWrite(db(), {
          workspaces: [makeWorkspace({ id: 'x', name: '新しい名前', editedAt: 3000 })],
          entries: [makeEntry({ id: 'x', title: '古い編集', editedAt: 500 })],
        });

        expect(result).toEqual({ applied: false });
        expect(await dump()).toEqual(before);
      });

      it('どちらの表でも、自分の表の行より新しければ、もう一方の表の同じ id に関係なく書ける', async () => {
        const result = await applyWrite(db(), {
          workspaces: [makeWorkspace({ id: 'x', name: '新しい名前', editedAt: 2500 })],
          entries: [makeEntry({ id: 'x', title: '新しい編集', editedAt: 1500 })],
        });

        expect(result).toEqual({ applied: true, rev: 3 });
        const changes = await readChanges(db(), 2);
        expect(changes.workspaces.map(({ workspace }) => workspace.name)).toEqual(['新しい名前']);
        expect(changes.entries.map(({ entry }) => entry.title)).toEqual(['新しい編集']);
      });
    });

    it('削除した行にも、古い edited_at の書き込みは通らない（削除が取り消されない）', async () => {
      await applyWrite(db(), {
        entries: [makeEntry({ id: 'a', editedAt: 3000, deletedAt: 3000 })],
      });
      const before = await dump();

      const result = await applyWrite(db(), {
        entries: [makeEntry({ id: 'a', title: '削除前の編集', editedAt: 2000 })],
      });

      expect(result).toEqual({ applied: false });
      expect(await dump()).toEqual(before);
    });

    describe('確認と書き込みの間に、別の書き込みが割り込んだとき', () => {
      it('新しい行を古い行で上書きしない', async () => {
        vi.spyOn(console, 'warn').mockImplementation(() => undefined);
        const interleaving = interleavedWith({
          entries: [makeEntry({ id: 'a', title: '別の端末の新しい編集', editedAt: 3000 })],
        });

        await applyWrite(interleaving, {
          entries: [makeEntry({ id: 'a', title: '遅れて届いた編集', editedAt: 2000 })],
        });

        const { entries } = await readChanges(db(), 0);
        expect(entries.map(({ entry }) => [entry.title, entry.editedAt])).toEqual([
          ['別の端末の新しい編集', 3000],
        ]);
      });

      it('一部の行だけが弾かれたら、表と行数をログに出す（id と内容は出さない）。結果は applied: true のまま', async () => {
        const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
        const interleaving = interleavedWith({
          entries: [makeEntry({ id: 'secret-id', title: '別の端末の編集', editedAt: 3000 })],
        });

        const result = await applyWrite(interleaving, {
          entries: [
            makeEntry({ id: 'secret-id', title: '秘密のタイトル', editedAt: 2000 }),
            makeEntry({ id: 'other', editedAt: 2000 }),
          ],
        });

        expect(result).toMatchObject({ applied: true });
        expect(warn).toHaveBeenCalledTimes(1);
        const message = String(warn.mock.calls[0]?.[0]);
        expect(message).toContain('entries の 2 行のうち、書けたのは 1 行');
        expect(message).not.toContain('secret-id');
        expect(message).not.toContain('秘密のタイトル');
      });

      it('ワークスペースの表で弾かれたときは、その表について出す', async () => {
        const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
        const interleaving = interleavedWith({
          workspaces: [makeWorkspace({ id: 'w2', editedAt: 3000 })],
        });

        await applyWrite(interleaving, {
          workspaces: [makeWorkspace({ id: 'w2', editedAt: 2000 })],
          entries: [makeEntry({ id: 'other', editedAt: 2000 })],
        });

        expect(warn).toHaveBeenCalledTimes(1);
        expect(String(warn.mock.calls[0]?.[0])).toContain(
          'workspaces の 1 行のうち、書けたのは 0 行',
        );
      });
    });

    it('割り込まれずに全部の行が書けたときは、ログを出さない', async () => {
      const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);

      await applyWrite(db(), {
        workspaces: [makeWorkspace({ id: 'w2' })],
        entries: [makeEntry({ id: 'a', title: '更新', editedAt: 2000 }), makeEntry({ id: 'b' })],
      });

      expect(warn).not.toHaveBeenCalled();
    });
  });

  it('途中で失敗した書き込みは、1 行も残らず、rev も進まない', async () => {
    await applyWrite(db(), { entries: [makeEntry({ id: 'a' })] });
    const before = await dump();

    // 2 行目が、存在しないワークスペースを指している（外部キーの違反）
    const write = applyWrite(db(), {
      entries: [
        makeEntry({ id: 'ok', editedAt: 2000 }),
        makeEntry({ id: 'ng', workspaceId: 'no-such-workspace', editedAt: 2000 }),
      ],
    });

    await expect(write).rejects.toThrow(/FOREIGN KEY/);
    expect(await dump()).toEqual(before);
  });

  describe('WS-4: 組み込みのワークスペースは、edited_at が 0 なので、端末の最初の編集が勝つ', () => {
    it('表示の ON/OFF を書き換えられる', async () => {
      const builtin = makeWorkspace({
        id: 'builtin-observance',
        name: '記念日',
        color: '#9AA0A6',
        sortOrder: 1_000_001,
        builtin: 'observance',
        visible: false,
        editedAt: 1,
      });

      const result = await applyWrite(db(), { workspaces: [builtin] });

      expect(result).toEqual({ applied: true, rev: 1 });
      const { workspaces } = await readChanges(db(), 0);
      expect(workspaces.find(({ workspace }) => workspace.id === 'builtin-observance')).toEqual({
        workspace: builtin,
        rev: 1,
      });
    });
  });

  describe('recurrence.ts が返す「書き込む行の配列」を、そのまま書ける', () => {
    const series = makeEntry({
      id: 's1',
      title: 'ジム',
      allDay: false,
      startDate: '2026-10-19',
      startTime: '19:00',
      endDate: '2026-10-19',
      endTime: '20:00',
      rrule: { freq: 'weekly', days: [1, 3, 5] },
    });
    const exception = makeEntry({
      id: 'ex1',
      title: 'ジム（個別）',
      allDay: false,
      startDate: '2026-11-04',
      startTime: '07:00',
      endDate: '2026-11-04',
      endTime: '08:00',
      seriesId: 's1',
      originalDate: '2026-11-04',
    });

    beforeEach(async () => {
      await applyWrite(db(), { entries: [series, exception] });
    });

    function followingChange(): Entry[] {
      return changeEntry({
        entries: [series, exception],
        target: { seriesId: 's1', occurrenceDate: '2026-11-02' },
        scope: 'following',
        changes: { title: '筋トレ' },
        newId: 'new-1',
        editedAt: 5000,
      });
    }

    it('SY-1: 「これ以降すべて」の 3 種類の行（切った系列・消した例外・新しい系列）を書き、読み直すと同じ行になる', async () => {
      const rows = followingChange();
      expect(rows.map(({ id }) => id).sort()).toEqual(['ex1', 'new-1', 's1']);
      expect(byId(rows)['s1']?.untilDate).toBe('2026-11-01');
      expect(byId(rows)['ex1']?.deletedAt).toBe(5000);
      expect(byId(rows)['new-1']?.title).toBe('筋トレ');

      const result = await applyWrite(db(), { entries: rows });

      expect(result).toEqual({ applied: true, rev: 2 });
      const changes = await readChanges(db(), 1);
      expect(byId(changes.entries.map(({ entry }) => entry))).toEqual(byId(rows));
      expect(changes.entries.map(({ rev }) => rev)).toEqual([2, 2, 2]);
    });

    it('SY-1: 初回の読み込み（sinceRev = 0）には、消した例外が出ない', async () => {
      await applyWrite(db(), { entries: followingChange() });

      const { entries } = await readChanges(db(), 0);

      expect(entries.map(({ entry }) => entry.id).sort()).toEqual(['new-1', 's1']);
    });

    it('SY-3: 「これ以降すべて」の依頼を 2 回送ると、2 回目は捨てられ、新しい系列が二重にならない', async () => {
      const rows = followingChange();
      await applyWrite(db(), { entries: rows });
      const afterFirst = await dump();

      const second = await applyWrite(db(), { entries: rows });

      expect(second).toEqual({ applied: false });
      expect(await dump()).toEqual(afterFirst);
    });

    it('SY-3: 「これ以降すべて」の行の 1 つ（切る系列）が、サーバーでもっと新しく編集されていたら、全体が捨てられる', async () => {
      const rows = followingChange();
      await applyWrite(db(), {
        entries: [makeEntry({ ...series, title: '別の端末で改名', editedAt: 4000 })],
      });
      const before = await dump();

      const result = await applyWrite(db(), {
        entries: rows.map((row) => ({ ...row, editedAt: 3000 })),
      });

      expect(result).toEqual({ applied: false });
      expect(await dump()).toEqual(before);
    });

    it('「この予定のみ」の変更（新しい例外の行 1 つ）を書ける', async () => {
      const rows = changeEntry({
        entries: [series, exception],
        target: { seriesId: 's1', occurrenceDate: '2026-10-21' },
        scope: 'this',
        changes: { title: '休憩' },
        newId: 'new-2',
        editedAt: 5000,
      });

      const result = await applyWrite(db(), { entries: rows });

      expect(rows).toHaveLength(1);
      expect(result).toEqual({ applied: true, rev: 2 });
      expect((await readChanges(db(), 1)).entries.map(({ entry }) => entry)).toEqual(rows);
    });

    it('作成（createEntry）の行を書ける', async () => {
      const draft: EntryDraft = {
        kind: 'event',
        title: '歯医者',
        workspaceId: 'w1',
        allDay: false,
        startDate: '2026-12-01',
        startTime: '15:00',
        endDate: '2026-12-01',
        endTime: '16:00',
        location: '○○歯科',
        url: null,
        memo: null,
        rrule: { freq: 'monthly' },
        notifyEnabled: true,
        notifyOffsetMin: 10,
      };
      const rows = createEntry({ draft, newId: 'new-3', editedAt: 5000 });

      await applyWrite(db(), { entries: rows });

      expect((await readChanges(db(), 1)).entries.map(({ entry }) => entry)).toEqual(rows);
    });

    it('「すべて」の削除（元の予定と例外の論理削除）を書くと、他の端末には削除として伝わる', async () => {
      const rows = deleteEntry({
        entries: [series, exception],
        target: { seriesId: 's1', occurrenceDate: '2026-10-19' },
        scope: 'all',
        newId: 'unused',
        editedAt: 5000,
      });

      const result = await applyWrite(db(), { entries: rows });

      expect(result).toEqual({ applied: true, rev: 2 });
      const changes = await readChanges(db(), 1);
      expect(byId(changes.entries.map(({ entry }) => entry))).toEqual(byId(rows));
      expect(changes.entries.every(({ entry }) => entry.deletedAt === 5000)).toBe(true);
      expect((await readChanges(db(), 0)).entries).toEqual([]);
    });
  });
});
