import { describe, expect, it } from 'vitest';
import { makeEntry } from '../../../test/helpers/entries';
import { makeWorkspace } from '../../../test/helpers/workspaces';
import type { BarItem, MoreItem, TimedItem } from './layout';
import { WeekViewCache } from './weekViewCache';
import { FIRST_WEEK_NUMBER, LAST_WEEK_NUMBER, weekNumberOf } from './weeks';

const workspaces = [
  makeWorkspace({ id: 'w1', color: '#039BE5' }),
  makeWorkspace({ id: 'builtin-holiday', builtin: 'holiday', color: '#F28B82' }),
  makeWorkspace({ id: 'builtin-observance', builtin: 'observance', color: '#9AA0A6' }),
];

function cacheOf(
  entries: Parameters<typeof makeEntry>[0][],
  options: { workspaces?: typeof workspaces; slots?: number } = {},
): WeekViewCache {
  return new WeekViewCache({
    entries: entries.map((entry) => makeEntry(entry)),
    workspaces: options.workspaces ?? workspaces,
    slots: options.slots ?? 4,
  });
}

const week = (date: string) => weekNumberOf(date);

describe('週に描く予定', () => {
  it('終日の予定は、ワークスペースの色の横棒になる', () => {
    const cache = cacheOf([
      { id: 'e1', title: '帰省', startDate: '2026-10-20', endDate: '2026-10-22' },
    ]);

    const items = cache.get(week('2026-10-20')).items;

    expect(items).toMatchObject([
      { kind: 'bar', event: { title: '帰省', color: '#039BE5' }, startCol: 2, endCol: 4 },
    ]);
  });

  it('時間指定の予定は、その日に「15:00 歯医者」として出る', () => {
    const cache = cacheOf([
      {
        id: 'e1',
        title: '歯医者',
        allDay: false,
        startDate: '2026-10-21',
        startTime: '15:00',
        endDate: '2026-10-21',
        endTime: '16:00',
      },
    ]);

    const [item] = cache.get(week('2026-10-21')).items;

    expect(item).toMatchObject({
      kind: 'timed',
      col: 3,
      event: { title: '歯医者', startTime: '15:00' },
    });
  });

  it('日付をまたぐ時間指定の予定（23:00〜翌 1:00）は、横棒で、2 日にまたがる', () => {
    const cache = cacheOf([
      {
        id: 'e1',
        allDay: false,
        startDate: '2026-10-20',
        startTime: '23:00',
        endDate: '2026-10-21',
        endTime: '01:00',
      },
    ]);

    const items = cache.get(week('2026-10-20')).items;

    expect(items).toEqual([expect.objectContaining({ kind: 'bar', startCol: 2, endCol: 3 })]);
  });

  it('終わりが 00:00 の時間指定の予定（20:00〜翌 0:00）は、翌日にはかからず、横棒にならない', () => {
    const cache = cacheOf([
      {
        id: 'e1',
        allDay: false,
        startDate: '2026-10-20',
        startTime: '20:00',
        endDate: '2026-10-21',
        endTime: '00:00',
      },
    ]);

    const items = cache.get(week('2026-10-20')).items;

    expect(items).toEqual([expect.objectContaining({ kind: 'timed', col: 2 })]);
  });

  it('繰り返しの予定は、描く週だけ展開して、それぞれの日に出る', () => {
    const cache = cacheOf([
      { id: 'e1', rrule: { freq: 'weekly', days: [1, 3] }, startDate: '2026-10-19' },
    ]);

    const columns = cache.get(week('2026-10-20')).items.map((item) => (item as BarItem).startCol);
    const nextWeek = cache.get(week('2026-10-27')).items.map((item) => (item as BarItem).startCol);

    expect(columns).toEqual([1, 3]);
    expect(nextWeek).toEqual([1, 3]);
  });

  it('タイムブロックは出さない', () => {
    const cache = cacheOf([
      {
        id: 'b1',
        kind: 'block',
        workspaceId: null,
        allDay: false,
        startDate: '2026-10-21',
        startTime: '09:00',
        endDate: '2026-10-21',
        endTime: '18:00',
      },
    ]);

    expect(cache.get(week('2026-10-21')).items).toEqual([]);
  });

  it('表示が OFF のワークスペースの予定は出さない', () => {
    const cache = cacheOf(
      [
        { id: 'e1', workspaceId: 'w1', startDate: '2026-10-21' },
        { id: 'e2', workspaceId: 'w2', startDate: '2026-10-21' },
      ],
      { workspaces: [...workspaces, makeWorkspace({ id: 'w2', visible: false })] },
    );

    const items = cache.get(week('2026-10-21')).items as BarItem[];

    expect(items.map((item) => item.event.key)).toEqual(['e1:2026-10-21']);
  });

  it('削除済みのワークスペースの予定は出さない', () => {
    const cache = cacheOf(
      [
        { id: 'e1', workspaceId: 'w1', startDate: '2026-10-21' },
        { id: 'e2', workspaceId: 'w2', startDate: '2026-10-21' },
      ],
      { workspaces: [...workspaces, makeWorkspace({ id: 'w2', deletedAt: 5000 })] },
    );

    const items = cache.get(week('2026-10-21')).items as BarItem[];

    expect(items.map((item) => item.event.key)).toEqual(['e1:2026-10-21']);
  });

  it('入りきらない予定は、その日の「+N件」になる', () => {
    const cache = cacheOf(
      Array.from({ length: 6 }, (_, index) => ({
        id: `e${String(index)}`,
        allDay: false,
        startDate: '2026-10-21',
        startTime: `${String(9 + index).padStart(2, '0')}:00`,
        endDate: '2026-10-21',
        endTime: `${String(10 + index).padStart(2, '0')}:00`,
      })),
      { slots: 4 },
    );

    const items = cache.get(week('2026-10-21')).items;

    expect(items.filter((item): item is TimedItem => item.kind === 'timed')).toHaveLength(3);
    expect(items.filter((item): item is MoreItem => item.kind === 'more')).toEqual([
      { kind: 'more', col: 3, row: 3, count: 3 },
    ]);
  });
});

describe('週に描く祝日名・記念日名', () => {
  it('祝日の日には、祝日名が付く', () => {
    const cache = cacheOf([]);

    // 2026-11-03 は文化の日（火曜）。
    const day = cache.get(week('2026-11-03')).days[2];

    expect(day).toEqual({ date: '2026-11-03', holidayName: '文化の日', observanceNames: [] });
  });

  it('記念日の日には、記念日名が付く。重なる日は、すべて付く', () => {
    const cache = cacheOf([]);

    // 2026-06-21 は夏至と父の日が重なる。
    const day = cache.get(week('2026-06-21')).days[0];

    expect(day?.holidayName).toBeNull();
    expect(day?.observanceNames).toEqual(expect.arrayContaining(['夏至', '父の日']));
  });

  it('組み込みのワークスペース「祝日」が OFF なら、祝日名を出さない', () => {
    const cache = cacheOf([], {
      workspaces: [
        makeWorkspace({ id: 'w1' }),
        makeWorkspace({ id: 'builtin-holiday', builtin: 'holiday', visible: false }),
        makeWorkspace({ id: 'builtin-observance', builtin: 'observance' }),
      ],
    });

    const days = cache.get(week('2026-11-03')).days;

    expect(days.every((day) => day.holidayName === null)).toBe(true);
  });

  it('組み込みのワークスペース「記念日」が OFF なら、記念日名を出さない', () => {
    const cache = cacheOf([], {
      workspaces: [
        makeWorkspace({ id: 'w1' }),
        makeWorkspace({ id: 'builtin-holiday', builtin: 'holiday' }),
        makeWorkspace({ id: 'builtin-observance', builtin: 'observance', visible: false }),
      ],
    });

    const days = cache.get(week('2026-06-21')).days;

    expect(days.every((day) => day.observanceNames.length === 0)).toBe(true);
  });

  it('週は日曜から土曜の 7 日分', () => {
    const days = cacheOf([]).get(week('2026-10-21')).days;

    expect(days.map((day) => day.date)).toEqual([
      '2026-10-18',
      '2026-10-19',
      '2026-10-20',
      '2026-10-21',
      '2026-10-22',
      '2026-10-23',
      '2026-10-24',
    ]);
  });
});

describe('範囲の端', () => {
  it('最初の週（1899-12-31 から始まる）を計算できる', () => {
    const cache = cacheOf([{ id: 'e1', startDate: '1900-01-01' }]);

    const view = cache.get(FIRST_WEEK_NUMBER);

    expect(view.days[0]?.date).toBe('1899-12-31');
    expect(view.items).toEqual([expect.objectContaining({ kind: 'bar', startCol: 1 })]);
  });

  it('最後の週（2200-01-04 で終わる）を計算できる', () => {
    const cache = cacheOf([{ id: 'e1', rrule: { freq: 'daily' }, startDate: '2199-12-01' }]);

    const view = cache.get(LAST_WEEK_NUMBER);

    expect(view.days.at(-1)?.date).toBe('2200-01-04');
    // 2199-12-31（火）までは出るが、範囲の外（2200 年）の日の回は出ない。
    expect(view.items.map((item) => (item as BarItem).startCol)).toEqual([0, 1, 2]);
  });

  it('範囲の外の週は、例外を投げる', () => {
    const cache = cacheOf([]);

    expect(() => cache.get(FIRST_WEEK_NUMBER - 1)).toThrow(RangeError);
    expect(() => cache.get(LAST_WEEK_NUMBER + 1)).toThrow(RangeError);
  });
});

describe('必要な週の分だけ計算して、覚えておく（NF-6）', () => {
  it('1 週を求めても、全期間は計算しない（計算するのは、その週を含む少数の週のまとまりだけ）', () => {
    const cache = cacheOf([{ id: 'e1', rrule: { freq: 'daily' }, startDate: '2026-01-01' }]);

    cache.get(week('2026-10-21'));

    expect(cache.computedChunkCount).toBe(1);
  });

  it('近い週を求めても、同じまとまりは計算し直さない', () => {
    const cache = cacheOf([]);

    cache.get(week('2026-10-21'));
    cache.get(week('2026-10-21') + 1);

    expect(cache.computedChunkCount).toBeLessThanOrEqual(2);
  });

  it('同じ週を 2 回求めると、同じ結果（同じ参照）が返る', () => {
    const cache = cacheOf([{ id: 'e1', startDate: '2026-10-21' }]);

    expect(cache.get(week('2026-10-21'))).toBe(cache.get(week('2026-10-21')));
  });

  it('覚えるまとまりの数には上限があり、遠くまでスクロールしても増え続けない', () => {
    const cache = cacheOf([]);

    for (let offset = 0; offset < 2000; offset += 8) cache.get(FIRST_WEEK_NUMBER + offset);

    expect(cache.computedChunkCount).toBeLessThanOrEqual(48);
  });

  it('上限を超えて捨てられた週も、求め直せば同じ内容になる', () => {
    const cache = cacheOf([{ id: 'e1', startDate: '1900-02-01' }]);
    const before = cache.get(FIRST_WEEK_NUMBER + 4);

    for (let offset = 8; offset < 8 * 60; offset += 8) cache.get(FIRST_WEEK_NUMBER + offset);
    const after = cache.get(FIRST_WEEK_NUMBER + 4);

    expect(after).toEqual(before);
  });
});
