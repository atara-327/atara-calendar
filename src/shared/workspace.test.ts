import { describe, expect, it } from 'vitest';
import { deepFreeze, makeEntry } from '../../test/helpers/entries';
import { makeWorkspace } from '../../test/helpers/workspaces';
import { markCancelled } from './recurrence';
import { deleteWorkspace } from './workspace';

const workspace = makeWorkspace({ id: 'w1', editedAt: 1000 });

describe('WS-1・Q6: ワークスペースの削除', () => {
  it('ワークスペースを、削除の時刻で論理削除した行にする', () => {
    const result = deleteWorkspace({ workspace, entries: [], editedAt: 5000 });

    expect(result.workspace).toEqual({ ...workspace, editedAt: 5000, deletedAt: 5000 });
    expect(result.entries).toEqual([]);
  });

  it('中の予定（繰り返さない予定・系列・例外）を、すべて論理削除した行にする', () => {
    const entries = [
      makeEntry({ id: 'plain', workspaceId: 'w1' }),
      makeEntry({ id: 'series', workspaceId: 'w1', rrule: { freq: 'daily' } }),
      makeEntry({
        id: 'exception',
        workspaceId: 'w1',
        seriesId: 'series',
        originalDate: '2026-10-20',
      }),
    ];

    const result = deleteWorkspace({ workspace, entries, editedAt: 5000 });

    expect(result.entries).toEqual(
      entries.map((entry) => ({ ...entry, editedAt: 5000, deletedAt: 5000 })),
    );
  });

  it('別のワークスペースを指す例外の行も、そのワークスペースの系列のものなら削除する', () => {
    const entries = [
      makeEntry({ id: 'series', workspaceId: 'w1', rrule: { freq: 'daily' } }),
      makeEntry({ id: 'moved', workspaceId: 'w2', seriesId: 'series', originalDate: '2026-10-20' }),
    ];

    const result = deleteWorkspace({ workspace, entries, editedAt: 5000 });

    expect(result.entries.map(({ id }) => id)).toEqual(['series', 'moved']);
  });

  describe('別のワークスペースの系列の例外が、このワークスペースを指しているとき', () => {
    const series = makeEntry({ id: 'series2', workspaceId: 'w2', rrule: { freq: 'daily' } });
    /** 10-20 の回を、このワークスペースの 10-25 に移した例外。 */
    const moved = makeEntry({
      id: 'moved',
      workspaceId: 'w1',
      seriesId: 'series2',
      originalDate: '2026-10-20',
      startDate: '2026-10-25',
    });

    it('論理削除せず、その回を削除した形（cancelled）にして、系列のワークスペースに戻す', () => {
      const result = deleteWorkspace({ workspace, entries: [series, moved], editedAt: 5000 });

      expect(result.entries).toEqual([{ ...markCancelled(moved, 5000), workspaceId: 'w2' }]);
      expect(result.entries[0]).toMatchObject({
        cancelled: true,
        workspaceId: 'w2',
        editedAt: 5000,
        deletedAt: null,
        originalDate: '2026-10-20',
      });
    });

    it('系列の行は、別のワークスペースの行なので、entries に含まれていても削除しない', () => {
      const result = deleteWorkspace({ workspace, entries: [series, moved], editedAt: 5000 });

      expect(result.entries.map(({ id }) => id)).toEqual(['moved']);
    });

    it('すでに cancelled の例外も、論理削除せず、系列のワークスペースに戻す（削除すると、その回が現れるため）', () => {
      const cancelled = { ...moved, cancelled: true };

      const result = deleteWorkspace({ workspace, entries: [series, cancelled], editedAt: 5000 });

      expect(result.entries).toEqual([{ ...cancelled, workspaceId: 'w2', editedAt: 5000 }]);
    });

    it('系列の行が entries にないときは、論理削除する（系列がないので、残しても画面に出ない）', () => {
      const result = deleteWorkspace({ workspace, entries: [moved], editedAt: 5000 });

      expect(result.entries).toEqual([{ ...moved, editedAt: 5000, deletedAt: 5000 }]);
    });

    it('系列が削除済みのときも、論理削除する', () => {
      const deletedSeries = { ...series, editedAt: 3000, deletedAt: 3000 };

      const result = deleteWorkspace({
        workspace,
        entries: [deletedSeries, moved],
        editedAt: 5000,
      });

      expect(result.entries).toEqual([{ ...moved, editedAt: 5000, deletedAt: 5000 }]);
    });

    it('このワークスペースの予定と一緒でも、それぞれの扱いになる', () => {
      const plain = makeEntry({ id: 'plain', workspaceId: 'w1' });

      const result = deleteWorkspace({
        workspace,
        entries: [plain, series, moved],
        editedAt: 5000,
      });

      expect(result.entries).toEqual([
        { ...plain, editedAt: 5000, deletedAt: 5000 },
        { ...moved, cancelled: true, workspaceId: 'w2', editedAt: 5000 },
      ]);
    });
  });

  it('削除済みの系列の例外は、系列がこのワークスペースのものでも、削除しない（サーバーが読まない行と、同じ結果にする）', () => {
    const entries = [
      makeEntry({
        id: 'series',
        workspaceId: 'w1',
        rrule: { freq: 'daily' },
        editedAt: 2000,
        deletedAt: 2000,
      }),
      makeEntry({ id: 'x', workspaceId: 'w2', seriesId: 'series', originalDate: '2026-10-20' }),
    ];

    const result = deleteWorkspace({ workspace, entries, editedAt: 5000 });

    expect(result.entries).toEqual([]);
  });

  it('別のワークスペースの予定と、その系列の例外は、削除しない', () => {
    const entries = [
      makeEntry({ id: 'other', workspaceId: 'w2' }),
      makeEntry({ id: 'otherSeries', workspaceId: 'w2', rrule: { freq: 'daily' } }),
      makeEntry({
        id: 'otherException',
        workspaceId: 'w2',
        seriesId: 'otherSeries',
        originalDate: '2026-10-20',
      }),
      makeEntry({ id: 'block', kind: 'block', workspaceId: null }),
    ];

    const result = deleteWorkspace({ workspace, entries, editedAt: 5000 });

    expect(result.entries).toEqual([]);
  });

  it('削除済みの行は、もう一度書かない', () => {
    const entries = [
      makeEntry({ id: 'done', workspaceId: 'w1', editedAt: 3000, deletedAt: 3000 }),
      makeEntry({ id: 'alive', workspaceId: 'w1' }),
    ];

    const result = deleteWorkspace({ workspace, entries, editedAt: 5000 });

    expect(result.entries.map(({ id }) => id)).toEqual(['alive']);
  });

  it('入力の行を書き換えない', () => {
    const entries = deepFreeze([
      makeEntry({ id: 'plain', workspaceId: 'w1' }),
      makeEntry({ id: 'series2', workspaceId: 'w2', rrule: { freq: 'daily' } }),
      makeEntry({
        id: 'moved',
        workspaceId: 'w1',
        seriesId: 'series2',
        originalDate: '2026-10-20',
      }),
    ]);

    const result = deleteWorkspace({
      workspace: deepFreeze({ ...workspace }),
      entries,
      editedAt: 5000,
    });

    expect(result.entries.map(({ id, deletedAt }) => [id, deletedAt])).toEqual([
      ['plain', 5000],
      ['moved', null],
    ]);
  });
});
