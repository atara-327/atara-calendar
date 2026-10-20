import { describe, expect, it } from 'vitest';
import { deepFreeze, makeEntry } from '../../test/helpers/entries';
import { makeWorkspace } from '../../test/helpers/workspaces';
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
    const entries = deepFreeze([makeEntry({ id: 'plain', workspaceId: 'w1' })]);

    const result = deleteWorkspace({
      workspace: deepFreeze({ ...workspace }),
      entries,
      editedAt: 5000,
    });

    expect(result.entries.map(({ id, deletedAt }) => [id, deletedAt])).toEqual([['plain', 5000]]);
  });
});
