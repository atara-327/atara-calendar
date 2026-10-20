import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { changeEntry, createEntry, deleteEntry } from '../../shared/recurrence';
import type { Entry, EntryDraft } from '../../shared/schema';
import { createTestDatabase, type TestDatabase } from '../../../test/helpers/d1';
import { makeEntry } from '../../../test/helpers/entries';
import { makeWorkspace } from '../../../test/helpers/workspaces';
import { CorruptRowError } from './rows';
import { applyWrite, readChanges, type Database } from './store';

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

  it('壊れた行が DB にあれば、黙って飛ばさず CorruptRowError にする', async () => {
    await db()
      .prepare(
        `INSERT INTO entries (id, kind, title, start_date, end_date, notify_enabled, notify_offset_min, edited_at, rev)
         VALUES ('broken', 'event', 'x', 'not-a-date', '2026-10-19', 1, 10, 1000, 1)`,
      )
      .run();

    await expect(readChanges(db(), 0)).rejects.toThrow(CorruptRowError);
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

    it('next_notify_at は書かず、NULL のままにする（通知の実装 #11 が計算する）', async () => {
      await applyWrite(db(), { entries: [makeEntry({ id: 'a' })] });

      const row = await db().prepare('SELECT next_notify_at FROM entries').first();

      expect(row).toEqual({ next_notify_at: null });
    });

    it('同じ id の行が 1 つの依頼に 2 つあるのは、呼び出し側のバグなので、例外にする', async () => {
      const rows = [makeEntry({ id: 'a', editedAt: 1000 }), makeEntry({ id: 'a', editedAt: 2000 })];

      await expect(applyWrite(db(), { entries: rows })).rejects.toThrow(/同じ id/);
    });
  });

  describe('SY-3: 食い違ったときは、edited_at が新しい方を残す', () => {
    const stored = makeEntry({ id: 'a', title: '元', editedAt: 1000 });

    beforeEach(async () => {
      await applyWrite(db(), { entries: [stored] });
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

    it('確認と書き込みの間に別の書き込みが割り込んでも、新しい行を古い行で上書きしない', async () => {
      let batches = 0;
      const interleaving: Database = {
        prepare: (query) => db().prepare(query),
        batch: async <T>(statements: D1PreparedStatement[]) => {
          batches += 1;
          // 1 回目の batch は edited_at の確認。2 回目の（書き込みの）前に、別の端末の書き込みを割り込ませる。
          if (batches === 2) {
            await applyWrite(db(), {
              entries: [makeEntry({ id: 'a', title: '別の端末の新しい編集', editedAt: 3000 })],
            });
          }
          return db().batch<T>(statements);
        },
      };

      await applyWrite(interleaving, {
        entries: [makeEntry({ id: 'a', title: '遅れて届いた編集', editedAt: 2000 })],
      });

      const { entries } = await readChanges(db(), 0);
      expect(entries.map(({ entry }) => [entry.title, entry.editedAt])).toEqual([
        ['別の端末の新しい編集', 3000],
      ]);
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
