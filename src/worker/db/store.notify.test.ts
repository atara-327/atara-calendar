import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Entry } from '../../shared/schema';
import {
  createTestDatabase,
  removeDefaultWorkspace,
  type TestDatabase,
} from '../../../test/helpers/d1';
import { makeEntry } from '../../../test/helpers/entries';
import { readNextNotifyAt } from '../../../test/helpers/rows';
import { jst } from '../../../test/helpers/time';
import { nextNotifyTimes } from '../notify/nextNotifyAt';
import { MAX_NOTIFY_UPDATE_ROWS, applyWrite, readChanges, type Database } from './store';

// 計算が例外を投げたとき（バグ）を再現するため、nextNotifyTimes だけ差し替えられるようにする。
// 入力の行は applyWrite が entrySchema で確かめるので、データだけで、計算を例外にすることはできない。
// 差し替えない限り、本物をそのまま呼ぶ。
vi.mock('../notify/nextNotifyAt', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../notify/nextNotifyAt')>();
  return { ...actual, nextNotifyTimes: vi.fn(actual.nextNotifyTimes) };
});

let testDatabase: TestDatabase;

beforeAll(async () => {
  testDatabase = await createTestDatabase();
});

afterAll(async () => {
  await testDatabase.dispose();
});

// 予定の行が使う外部キーの相手 'w1' を、rev 0 の行として入れ、rev を 0 から数える（store.test.ts と同じ）。
beforeEach(async () => {
  await testDatabase.reset();
  await removeDefaultWorkspace(testDatabase.db);
  await testDatabase.db
    .prepare(
      `INSERT INTO workspaces (id, name, color, sort_order, visible, builtin, edited_at, rev)
       VALUES ('w1', '仕事', '#4285F4', 0, 1, NULL, 0, 0)`,
    )
    .run();
});

afterEach(() => {
  vi.restoreAllMocks();
});

function db(): D1Database {
  return testDatabase.db;
}

/** 計算に使う「今」。2026-10-27（火）の朝 9 時。 */
const NOW = jst('2026-10-27', '09:00');

/** 時間指定の予定（15:00〜16:00、10 分前に通知）。繰り返さない。 */
function timed(overrides: Partial<Entry> & Pick<Entry, 'id'>): Entry {
  return makeEntry({
    allDay: false,
    startDate: '2026-10-27',
    startTime: '15:00',
    endTime: '16:00',
    notifyOffsetMin: 10,
    ...overrides,
  });
}

/** 系列 's' の、例外の行。 */
function exception(overrides: Partial<Entry> & Pick<Entry, 'id' | 'originalDate'>): Entry {
  return timed({ seriesId: 's', ...overrides });
}

function write(entries: Entry[]) {
  return applyWrite(db(), { entries }, { nowMs: NOW });
}

describe('next_notify_at（保存したときに、次に通知する時刻を計算して入れる。設計書 9.2）', () => {
  describe('書いた行の値', () => {
    it('NT-2: 時間指定の予定を書くと、開始の 10 分前が入る', async () => {
      await write([timed({ id: 'a' })]);

      expect(await readNextNotifyAt(db())).toEqual({ a: jst('2026-10-27', '14:50') });
    });

    it('NT-3: 終日の予定は、-360 なら、当日の朝 6 時が入る', async () => {
      await write([
        makeEntry({ id: 'a', allDay: true, startDate: '2026-10-28', notifyOffsetMin: -360 }),
      ]);

      expect(await readNextNotifyAt(db())).toEqual({ a: jst('2026-10-28', '06:00') });
    });

    it('NT-4: 通知が OFF の予定は、NULL', async () => {
      await write([timed({ id: 'a', notifyEnabled: false })]);

      expect(await readNextNotifyAt(db())).toEqual({ a: null });
    });

    it('通知の時刻が、書いた時点で過ぎている予定は、NULL（送っても役に立たないため）', async () => {
      await write([timed({ id: 'a', startTime: '08:30' })]);

      expect(await readNextNotifyAt(db())).toEqual({ a: null });
    });

    it('繰り返しの系列は、次の回の通知の時刻が入る', async () => {
      await write([timed({ id: 's', rrule: { freq: 'daily' }, startDate: '2026-10-19' })]);

      expect(await readNextNotifyAt(db())).toEqual({ s: jst('2026-10-27', '14:50') });
    });

    it('計算に使う「今」を省くと、Date.now()', async () => {
      vi.spyOn(Date, 'now').mockReturnValue(jst('2026-10-27', '15:00'));

      await applyWrite(db(), {
        entries: [timed({ id: 's', rrule: { freq: 'daily' }, startDate: '2026-10-19' })],
      });

      expect(await readNextNotifyAt(db())).toEqual({ s: jst('2026-10-28', '14:50') });
    });
  });

  describe('更新・削除', () => {
    it('行を更新したら、古い値を残さず、新しい内容から計算し直した値にする', async () => {
      await write([timed({ id: 'a', editedAt: 1000 })]);

      await write([timed({ id: 'a', editedAt: 2000, startTime: '16:00' })]);

      expect(await readNextNotifyAt(db())).toEqual({ a: jst('2026-10-27', '15:50') });
    });

    it('通知を OFF にして更新したら、NULL にする', async () => {
      await write([timed({ id: 'a', editedAt: 1000 })]);

      await write([timed({ id: 'a', editedAt: 2000, notifyEnabled: false })]);

      expect(await readNextNotifyAt(db())).toEqual({ a: null });
    });

    it('行を削除したら、NULL にする（削除した予定の通知が飛ばないように）', async () => {
      await write([timed({ id: 'a', editedAt: 1000 })]);

      await write([timed({ id: 'a', editedAt: 2000, deletedAt: 2000 })]);

      expect(await readNextNotifyAt(db())).toEqual({ a: null });
    });

    it('古くて捨てられた依頼では、行を更新しないので、通知の時刻も残る', async () => {
      await write([timed({ id: 'a', editedAt: 2000 })]);

      const result = await write([timed({ id: 'a', editedAt: 1000, startTime: '16:00' })]);

      expect(result).toEqual({ applied: false });
      expect(await readNextNotifyAt(db())).toEqual({ a: jst('2026-10-27', '14:50') });
    });
  });

  describe('書かない行の値（同じ系列の行は、書いていなくても計算し直す）', () => {
    const series = () => timed({ id: 's', rrule: { freq: 'daily' }, startDate: '2026-10-19' });

    it('「この予定のみ」で例外の行だけを書いたとき、系列の行の次の回が変わる', async () => {
      await write([series()]);
      expect((await readNextNotifyAt(db())).s).toBe(jst('2026-10-27', '14:50'));

      // 今日の回を、10/29 に移す。書くのは例外の行だけ。
      await write([exception({ id: 'x', originalDate: '2026-10-27', startDate: '2026-10-29' })]);

      expect(await readNextNotifyAt(db())).toEqual({
        s: jst('2026-10-28', '14:50'),
        x: jst('2026-10-29', '14:50'),
      });
    });

    it('例外の行だけを書いたとき、その回を削除した（cancelled）なら、例外の行は NULL で、系列はその日を飛ばす', async () => {
      await write([series()]);

      await write([
        exception({
          id: 'x',
          originalDate: '2026-10-27',
          startDate: '2026-10-27',
          cancelled: true,
        }),
      ]);

      expect(await readNextNotifyAt(db())).toEqual({ s: jst('2026-10-28', '14:50'), x: null });
    });

    it('系列の行だけを書いたとき、まだ通知が来る例外の行の値は、そのまま残る', async () => {
      await write([series()]);
      await write([exception({ id: 'x', originalDate: '2026-10-28', startDate: '2026-10-30' })]);

      await write([{ ...series(), editedAt: 3000, title: '名前だけ変える' }]);

      expect(await readNextNotifyAt(db())).toEqual({
        s: jst('2026-10-27', '14:50'),
        x: jst('2026-10-30', '14:50'),
      });
    });

    it('系列を切る（untilDate）と、その後ろの例外の行の削除と合わせて、すべての値を計算し直す', async () => {
      await write([series()]);
      await write([exception({ id: 'x', originalDate: '2026-10-29', startDate: '2026-10-30' })]);

      // 「これ以降すべて」の削除（10/28 から）: 系列を 10/27 で切り、10/28 以降の例外を削除する。
      await write([
        { ...series(), editedAt: 3000, untilDate: '2026-10-27' },
        exception({
          id: 'x',
          originalDate: '2026-10-29',
          startDate: '2026-10-30',
          editedAt: 3000,
          deletedAt: 3000,
        }),
      ]);

      expect(await readNextNotifyAt(db())).toEqual({ s: jst('2026-10-27', '14:50'), x: null });
    });

    it('時刻が来て、まだ送っていない通知は、同じ系列の明日の回を変えても、書かない系列の行に残る', async () => {
      await write([series()]);
      expect((await readNextNotifyAt(db())).s).toBe(jst('2026-10-27', '14:50'));

      // 14:50:20（定期実行が、14:50 の通知を拾う前）に、明日の回を「この予定のみ」で変える。
      await applyWrite(
        db(),
        {
          entries: [
            exception({
              id: 'x',
              originalDate: '2026-10-28',
              startDate: '2026-10-28',
              startTime: '16:00',
            }),
          ],
        },
        { nowMs: jst('2026-10-27', '14:50') + 20_000 },
      );

      expect(await readNextNotifyAt(db())).toEqual({
        s: jst('2026-10-27', '14:50'),
        x: jst('2026-10-28', '15:50'),
      });
    });

    it('別の系列の行は、読まず、書き換えない', async () => {
      await write([
        timed({ id: 'other', rrule: { freq: 'weekly', days: [3] }, startDate: '2026-10-21' }),
        series(),
      ]);
      const before = (await readNextNotifyAt(db())).other;

      await write([exception({ id: 'x', originalDate: '2026-10-27', startDate: '2026-10-29' })]);

      expect((await readNextNotifyAt(db())).other).toBe(before);
    });
  });

  describe('rev は変えない（next_notify_at は、端末に送らない列）', () => {
    it('例外の行を書いて、系列の行の next_notify_at だけが変わっても、系列の行の rev は進まず、差分に出ない', async () => {
      await write([timed({ id: 's', rrule: { freq: 'daily' }, startDate: '2026-10-19' })]);

      await write([exception({ id: 'x', originalDate: '2026-10-27', startDate: '2026-10-29' })]);

      const changes = await readChanges(db(), 1);
      expect(changes.entries.map(({ entry, rev }) => [entry.id, rev])).toEqual([['x', 2]]);
      expect((await readChanges(db(), 0)).entries.map(({ entry, rev }) => [entry.id, rev])).toEqual(
        [
          ['s', 1],
          ['x', 2],
        ],
      );
    });

    it('書いた行の rev は、これまでどおり、その書き込みの rev', async () => {
      await write([timed({ id: 'a', editedAt: 1000 })]);
      await write([timed({ id: 'a', editedAt: 2000, startTime: '16:00' })]);

      const { entries, rev } = await readChanges(db(), 0);

      expect(rev).toBe(2);
      expect(entries.map((stored) => stored.rev)).toEqual([2]);
    });
  });

  describe('同じ batch で書く（設計書 9.2）', () => {
    /** next_notify_at の UPDATE だけを、必ず失敗する文にする db。 */
    function failingNotifyUpdate(): Database {
      return {
        prepare: (query) =>
          db().prepare(
            query.startsWith('UPDATE entries SET next_notify_at')
              ? 'UPDATE no_such_table SET x = 1'
              : query,
          ),
        batch: (statements) => db().batch(statements),
      };
    }

    it('next_notify_at の UPDATE が失敗したら、行の upsert も取り消される（NULL のまま残る行を作らない）', async () => {
      await expect(
        applyWrite(failingNotifyUpdate(), { entries: [timed({ id: 'a' })] }, { nowMs: NOW }),
      ).rejects.toThrow();

      expect(await readNextNotifyAt(db())).toEqual({});
      expect((await readChanges(db(), 0)).rev).toBe(0);
    });
  });

  describe('文の数（D1 の 1 回の呼び出しあたりのクエリ数の上限のため）', () => {
    /** 渡された batch の文の数と、next_notify_at の UPDATE に bind された値の大きさ（UTF-8 のバイト数）を記録する db。 */
    function recordingDatabase() {
      const batchSizes: number[] = [];
      const updateValueBytes: number[] = [];
      const encoder = new TextEncoder();
      const database: Database = {
        prepare: (query) => {
          const statement = db().prepare(query);
          if (!query.startsWith('UPDATE entries SET next_notify_at')) return statement;
          const recording = {
            bind: (...values: unknown[]) => {
              for (const value of values)
                updateValueBytes.push(encoder.encode(String(value)).length);
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
      return { database, batchSizes, updateValueBytes };
    }

    it('値を決める行が何行あっても、UPDATE は 1 文（rev・entries の upsert・UPDATE の 3 文）', async () => {
      const { database, batchSizes } = recordingDatabase();

      await applyWrite(
        database,
        { entries: Array.from({ length: 300 }, (_, i) => timed({ id: `e${String(i)}` })) },
        { nowMs: NOW },
      );

      // 1 つ目は、今の行の確認（workspaces・entries・系列の行の 3 文）、2 つ目が書き込み
      expect(batchSizes).toEqual([3, 3]);
      expect(Object.keys(await readNextNotifyAt(db()))).toHaveLength(300);
    });

    it('値が変わる行がなければ、UPDATE の文を入れない', async () => {
      const { database, batchSizes } = recordingDatabase();

      await applyWrite(
        database,
        { entries: [timed({ id: 'a', notifyEnabled: false })] },
        { nowMs: NOW },
      );

      expect(batchSizes).toEqual([3, 2]);
    });

    it('削除する行だけを書くときは、系列の行を読む文も、UPDATE の文も入れない', async () => {
      await write([timed({ id: 'a', editedAt: 1000 })]);
      const { database, batchSizes } = recordingDatabase();

      await applyWrite(
        database,
        { entries: [timed({ id: 'a', editedAt: 2000, deletedAt: 2000 })] },
        { nowMs: NOW },
      );

      expect(batchSizes).toEqual([2, 2]);
    });

    it('ワークスペースだけを書くときも、系列の行を読む文を入れない', async () => {
      const { database, batchSizes } = recordingDatabase();

      await applyWrite(
        database,
        { workspaces: [{ ...(await workspaceW1()), name: '改名', editedAt: 5000 }] },
        { nowMs: NOW },
      );

      expect(batchSizes).toEqual([2, 2]);
    });

    it.each([
      { rows: MAX_NOTIFY_UPDATE_ROWS, statements: 1 },
      { rows: MAX_NOTIFY_UPDATE_ROWS + 1, statements: 2 },
      { rows: MAX_NOTIFY_UPDATE_ROWS * 2 + 1, statements: 3 },
    ])(
      `UPDATE は、1 文に入る行数を ${String(MAX_NOTIFY_UPDATE_ROWS)} 行までにする（値の大きさが小さくても、行数で分ける）。$rows 行の更新は $statements 文`,
      async ({ rows, statements }) => {
        const { database, batchSizes, updateValueBytes } = recordingDatabase();
        const entries = Array.from({ length: rows }, (_, index) =>
          timed({ id: `e${String(index)}` }),
        );

        await applyWrite(database, { entries }, { nowMs: NOW });

        expect(updateValueBytes).toHaveLength(statements);
        // 1 つ目は今の行の確認。2 つ目が書き込み（rev・entries の upsert・UPDATE のかたまり）。
        expect(batchSizes).toEqual([3, 1 + 1 + statements]);
        const nextNotifyAt = Object.values(await readNextNotifyAt(db()));
        expect(nextNotifyAt).toHaveLength(rows);
        expect(nextNotifyAt.every((value) => value === jst('2026-10-27', '14:50'))).toBe(true);
      },
    );

    it('UPDATE の値は、upsert と同じく、約 1MB ごとのかたまりに分けて、同じ batch に入れる', async () => {
      const { database, batchSizes, updateValueBytes } = recordingDatabase();
      // 1 行あたり約 5KB（id が 5,000 文字）の更新を 400 行 = 約 2MB。id を長くするのは、行数を増やすと、
      // UPDATE が行ごとに JSON を走査するので（store.ts の UPDATE_NEXT_NOTIFY_AT）、テストが遅くなるため。
      const entries = Array.from({ length: 400 }, (_, index) =>
        timed({ id: `${String(index)}-${'x'.repeat(5000)}` }),
      );

      await applyWrite(database, { entries }, { nowMs: NOW });

      expect(updateValueBytes.length).toBeGreaterThan(1);
      expect(updateValueBytes.every((bytes) => bytes <= 1_000_000)).toBe(true);
      // 1 つ目は今の行の確認。2 つ目が書き込み（rev・upsert のかたまり・UPDATE のかたまり）。
      expect(batchSizes).toHaveLength(2);
      const nextNotifyAt = Object.values(await readNextNotifyAt(db()));
      expect(nextNotifyAt).toHaveLength(400);
      expect(nextNotifyAt.every((value) => value === jst('2026-10-27', '14:50'))).toBe(true);
    });
  });

  describe('割り込み（確認と書き込みの間に、別の書き込みが同じ行を新しくした。設計書 6.4）', () => {
    it('割り込んだ書き込みが決めた値を、古い内容から計算した値で上書きしない', async () => {
      await write([timed({ id: 'a', editedAt: 1000 })]);
      let batches = 0;
      const interleaved: Database = {
        prepare: (query) => db().prepare(query),
        batch: async <T>(statements: D1PreparedStatement[]) => {
          batches += 1;
          // 2 回目の batch（書き込み）の前に、別の端末が、同じ行を新しい時刻で書く。
          if (batches === 2) {
            await applyWrite(
              db(),
              { entries: [timed({ id: 'a', editedAt: 3000, startTime: '18:00' })] },
              { nowMs: NOW },
            );
          }
          return db().batch<T>(statements);
        },
      };

      await applyWrite(
        interleaved,
        { entries: [timed({ id: 'a', editedAt: 2000, startTime: '16:00' })] },
        { nowMs: NOW },
      );

      // 割り込んだ編集（edited_at 3000、18:00 開始）が残り、その値のまま。
      expect(await readNextNotifyAt(db())).toEqual({ a: jst('2026-10-27', '17:50') });
    });
  });

  describe('計算が例外を投げたとき（バグ）でも、保存は成功させる', () => {
    function failNextCalculation(error: Error) {
      vi.mocked(nextNotifyTimes).mockImplementationOnce(() => {
        throw error;
      });
    }

    it('書いた行は保存され、その系列の通知の時刻は NULL になる', async () => {
      vi.spyOn(console, 'error').mockImplementation(() => undefined);
      failNextCalculation(new Error('計算のバグ'));

      const result = await write([timed({ id: 'a', title: '歯医者' })]);

      expect(result).toEqual({ applied: true, rev: 1 });
      expect((await readChanges(db(), 0)).entries.map(({ entry }) => entry.title)).toEqual([
        '歯医者',
      ]);
      expect(await readNextNotifyAt(db())).toEqual({ a: null });
    });

    it('書かない行も、古い値を残さず NULL にする（残すと、変わった系列に、古い時刻で通知してしまう）', async () => {
      vi.spyOn(console, 'error').mockImplementation(() => undefined);
      await write([timed({ id: 's', rrule: { freq: 'daily' }, startDate: '2026-10-19' })]);
      expect((await readNextNotifyAt(db())).s).toBe(jst('2026-10-27', '14:50'));
      failNextCalculation(new Error('計算のバグ'));

      await write([exception({ id: 'x', originalDate: '2026-10-27', startDate: '2026-10-29' })]);

      expect(await readNextNotifyAt(db())).toEqual({ s: null, x: null });
    });

    it('ログに、系列の id と例外を出し、予定の題名などの中身は出さない', async () => {
      const error = vi.spyOn(console, 'error').mockImplementation(() => undefined);
      const failure = new Error('計算のバグ');
      failNextCalculation(failure);

      await write([
        timed({ id: 'a', title: '秘密の題名', memo: '秘密のメモ', location: '秘密の場所' }),
      ]);

      expect(error).toHaveBeenCalledTimes(1);
      const logged = error.mock.calls[0] ?? [];
      expect(logged[0]).toContain('id: a');
      expect(logged[1]).toBe(failure);
      expect(JSON.stringify(logged)).not.toMatch(/秘密/);
    });

    it('別の系列の計算は、続ける（1 つの系列の例外で、同じ依頼の他の系列を NULL にしない）', async () => {
      vi.spyOn(console, 'error').mockImplementation(() => undefined);
      failNextCalculation(new Error('計算のバグ'));

      await write([timed({ id: 'a' }), timed({ id: 'b' })]);

      const values = await readNextNotifyAt(db());
      expect(Object.values(values).filter((value) => value === null)).toHaveLength(1);
      expect(
        Object.values(values).filter((value) => value === jst('2026-10-27', '14:50')),
      ).toHaveLength(1);
    });
  });
});

async function workspaceW1() {
  const { workspaces } = await readChanges(db(), 0);
  const found = workspaces.find(({ workspace }) => workspace.id === 'w1');
  if (found === undefined) throw new Error('w1 がない');
  return found.workspace;
}
