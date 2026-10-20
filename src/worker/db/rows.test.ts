import { describe, expect, it } from 'vitest';
import type { Entry, Workspace } from '../../shared/schema';
import { makeEntry } from '../../../test/helpers/entries';
import { makeWorkspace } from '../../../test/helpers/workspaces';
import {
  CorruptRowError,
  ENTRY_COLUMNS,
  WORKSPACE_COLUMNS,
  entryFromRow,
  entryToRow,
  workspaceFromRow,
  workspaceToRow,
} from './rows';

/** 全項目に値がある行。時刻・繰り返し・場所・メモ・通知まで、null でない列を一通り持つ。 */
const fullEntry: Entry = makeEntry({
  id: 'e1',
  title: '歯医者',
  allDay: false,
  startDate: '2026-10-19',
  startTime: '15:00',
  endDate: '2026-10-19',
  endTime: '16:00',
  location: '○○歯科',
  url: 'https://example.com',
  memo: '保険証',
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

/** 書き込む行に、読み込むときだけ付く 2 つの列を足したもの。DB から読んだ行の形。 */
function readBack(entry: Entry, extra: { rev?: number; next_notify_at?: number | null } = {}) {
  return { ...entryToRow(entry), rev: 3, next_notify_at: null, ...extra };
}

describe('予定の行の変換（entries）', () => {
  it('すべての列に値がある行は、書いて読み直すと同じ内容に戻る', () => {
    expect(entryFromRow(readBack(fullEntry)).entry).toEqual(fullEntry);
  });

  it('null の列（時刻・場所・繰り返しなど）も、書いて読み直すと null のまま', () => {
    const minimal = makeEntry({ id: 'e2' });
    const { entry } = entryFromRow(readBack(minimal));
    expect(entry).toEqual(minimal);
    expect(entry.startTime).toBeNull();
    expect(entry.rrule).toBeNull();
  });

  it('真偽値は 0 と 1 で書き、読むと真偽値に戻る', () => {
    const row = entryToRow(fullEntry);
    expect(row).toMatchObject({ all_day: 0, cancelled: 1, notify_enabled: 0 });

    const stored = entryFromRow(readBack(makeEntry({ id: 'e3', allDay: true, cancelled: false })));
    expect(stored.entry).toMatchObject({ allDay: true, cancelled: false, notifyEnabled: true });
  });

  it('繰り返しのルールは JSON の文字列で書き、読むとオブジェクトに戻る', () => {
    expect(entryToRow(fullEntry).rrule).toBe('{"freq":"weekly","days":[1,3,5]}');
    expect(entryFromRow(readBack(fullEntry)).entry.rrule).toEqual({
      freq: 'weekly',
      days: [1, 3, 5],
    });
  });

  it('書き込む行は、空の値を undefined にせず null にする（D1 は undefined を bind できない）', () => {
    const row = entryToRow(makeEntry({ id: 'e4' }));
    expect(Object.values(row)).not.toContain(undefined);
    expect(Object.keys(row).sort()).toEqual([...ENTRY_COLUMNS].sort());
  });

  it('rev と next_notify_at は、Entry に入れず、読み込み結果で別に持つ', () => {
    const stored = entryFromRow(
      readBack(fullEntry, { rev: 42, next_notify_at: 1_760_000_600_000 }),
    );
    expect(stored.rev).toBe(42);
    expect(stored.nextNotifyAt).toBe(1_760_000_600_000);
    expect(stored.entry).not.toHaveProperty('rev');
    expect(stored.entry).not.toHaveProperty('nextNotifyAt');
  });

  describe('壊れた行は例外にする', () => {
    it.each([
      { reason: '種類が event と block 以外', patch: { kind: 'task' } },
      { reason: '日付の形式が違う', patch: { start_date: '2026/10/19' } },
      { reason: '存在しない日付', patch: { end_date: '2026-02-30' } },
      { reason: '時刻が 15 分刻みでない', patch: { start_time: '15:10' } },
      { reason: '真偽値の列が 0 と 1 以外', patch: { all_day: 2 } },
      { reason: '真偽値の列が文字列', patch: { cancelled: 'true' } },
      { reason: 'rrule が JSON として読めない', patch: { rrule: '{freq:' } },
      { reason: 'rrule が知らない種類', patch: { rrule: '{"freq":"biweekly"}' } },
      { reason: 'rrule が曜日のない weekly', patch: { rrule: '{"freq":"weekly","days":[]}' } },
      { reason: 'タイトルが NULL', patch: { title: null } },
      { reason: 'rev が NULL', patch: { rev: null } },
      { reason: 'edited_at が文字列', patch: { edited_at: 'now' } },
    ])('$reason', ({ patch }) => {
      expect(() => entryFromRow({ ...readBack(fullEntry), ...patch })).toThrow(CorruptRowError);
    });

    it('列が足りない行', () => {
      const withoutTitle = Object.fromEntries(
        Object.entries(readBack(fullEntry)).filter(([column]) => column !== 'title'),
      );
      expect(() => entryFromRow(withoutTitle)).toThrow(CorruptRowError);
    });

    it('オブジェクトでない値', () => {
      expect(() => entryFromRow(null)).toThrow(CorruptRowError);
    });

    it('例外の文面から、どの表のどの行かがわかる', () => {
      expect(() => entryFromRow({ ...readBack(fullEntry), kind: 'task' })).toThrow(
        /entries の行が壊れています（id: e1）/,
      );
    });
  });

  it('知らない列が付いていても、読み込みでは捨てる（将来の列の追加で読めなくならない）', () => {
    expect(entryFromRow({ ...readBack(fullEntry), added_later: 'x' }).entry).toEqual(fullEntry);
  });
});

describe('ワークスペースの行の変換（workspaces）', () => {
  const full: Workspace = makeWorkspace({
    id: 'w1',
    name: '祝日',
    color: '#F28B82',
    sortOrder: 1_000_000,
    visible: false,
    builtin: 'holiday',
    editedAt: 1_760_000_000_000,
    deletedAt: 1_760_000_100_000,
  });

  function readBackWorkspace(workspace: Workspace, extra: { rev?: number } = {}) {
    return { ...workspaceToRow(workspace), rev: 3, ...extra };
  }

  it('書いて読み直すと同じ内容に戻る', () => {
    expect(workspaceFromRow(readBackWorkspace(full)).workspace).toEqual(full);
  });

  it('builtin と deletedAt が null の行も、null のまま戻る', () => {
    const plain = makeWorkspace({ id: 'w2' });
    const { workspace } = workspaceFromRow(readBackWorkspace(plain));
    expect(workspace).toEqual(plain);
    expect(workspace.builtin).toBeNull();
  });

  it('表示の ON/OFF は 0 と 1 で書き、読むと真偽値に戻る', () => {
    expect(workspaceToRow(full).visible).toBe(0);
    expect(workspaceToRow(makeWorkspace({ id: 'w3', visible: true })).visible).toBe(1);
    expect(workspaceFromRow(readBackWorkspace(full)).workspace.visible).toBe(false);
  });

  it('書き込む行は、空の値を undefined にせず null にする', () => {
    const row = workspaceToRow(makeWorkspace({ id: 'w4' }));
    expect(Object.values(row)).not.toContain(undefined);
    expect(Object.keys(row).sort()).toEqual([...WORKSPACE_COLUMNS].sort());
  });

  it('rev は、Workspace に入れず、読み込み結果で別に持つ', () => {
    const stored = workspaceFromRow(readBackWorkspace(full, { rev: 9 }));
    expect(stored.rev).toBe(9);
    expect(stored.workspace).not.toHaveProperty('rev');
  });

  it.each([
    { reason: '色が #RRGGBB でない', patch: { color: 'red' } },
    { reason: '組み込みの印が知らない値', patch: { builtin: 'custom' } },
    { reason: '表示の列が 0 と 1 以外', patch: { visible: 2 } },
    { reason: '並び順が小数', patch: { sort_order: 1.5 } },
    { reason: '名前が NULL', patch: { name: null } },
  ])('壊れた行は例外にする: $reason', ({ patch }) => {
    expect(() => workspaceFromRow({ ...readBackWorkspace(full), ...patch })).toThrow(
      CorruptRowError,
    );
  });

  it('例外の文面から、どの表のどの行かがわかる', () => {
    expect(() => workspaceFromRow({ ...readBackWorkspace(full), color: 'red' })).toThrow(
      /workspaces の行が壊れています（id: w1）/,
    );
  });
});
