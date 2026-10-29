import { describe, expect, it } from 'vitest';
import { makeEntry } from '../../../test/helpers/entries';
import { makeWorkspace } from '../../../test/helpers/workspaces';
import type { BarItem, MoreItem, TimedItem } from './layout';
import { CHUNK_WEEKS, MAX_CACHED_CHUNKS, WeekViewCache } from './weekViewCache';
import { FIRST_WEEK_NUMBER, LAST_WEEK_NUMBER, weekDates, weekNumberOf } from './weeks';

const workspaces = [
  makeWorkspace({ id: 'w1', color: '#039BE5' }),
  makeWorkspace({ id: 'builtin-holiday', builtin: 'holiday', color: '#F28B82' }),
  makeWorkspace({ id: 'builtin-observance', builtin: 'observance', color: '#9AA0A6' }),
];

// 予定の並びだけを確かめるテストは、祝日・記念日の横棒が混ざらないよう、これを使う。
const workspacesWithoutNamedDates = [
  makeWorkspace({ id: 'w1', color: '#039BE5' }),
  makeWorkspace({ id: 'builtin-holiday', builtin: 'holiday', visible: false }),
  makeWorkspace({ id: 'builtin-observance', builtin: 'observance', visible: false }),
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

  it('予定は、押したときに開くフォームのために、元の回（どの予定の、どの日の回か）を持つ', () => {
    const cache = cacheOf([
      { id: 'e1', title: '歯医者', startDate: '2026-10-21', endDate: '2026-10-21' },
    ]);

    const [item] = cache.get(week('2026-10-21')).items;

    expect(item).toMatchObject({
      event: {
        occurrence: {
          entryId: 'e1',
          seriesId: 'e1',
          occurrenceDate: '2026-10-21',
          title: '歯医者',
          recurring: false,
        },
      },
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
    const cache = cacheOf(
      [{ id: 'e1', rrule: { freq: 'weekly', days: [1, 3] }, startDate: '2026-10-19' }],
      { workspaces: workspacesWithoutNamedDates },
    );

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

  it('タイムブロックの系列が混ざっていても、予定の回は出て、タイムブロックは出ない', () => {
    const cache = cacheOf([
      {
        id: 'b1',
        kind: 'block',
        workspaceId: null,
        rrule: { freq: 'daily' },
        allDay: false,
        startDate: '2026-10-01',
        startTime: '09:00',
        endDate: '2026-10-01',
        endTime: '18:00',
      },
      { id: 'e1', startDate: '2026-10-21' },
    ]);

    const items = cache.get(week('2026-10-21')).items as BarItem[];

    expect(items.map((item) => item.event.key)).toEqual(['e1:2026-10-21']);
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

  it('別のワークスペースへ移した回が OFF のワークスペースにあるとき、元の日に、系列の回が現れない', () => {
    const cache = cacheOf(
      [
        { id: 's1', workspaceId: 'w1', rrule: { freq: 'daily' }, startDate: '2026-10-19' },
        // 10-21 の回だけ、OFF のワークスペースへ移した例外。
        {
          id: 'x1',
          seriesId: 's1',
          originalDate: '2026-10-21',
          workspaceId: 'w2',
          startDate: '2026-10-21',
        },
      ],
      { workspaces: [...workspaces, makeWorkspace({ id: 'w2', visible: false })] },
    );

    const items = cache.get(week('2026-10-21')).items as BarItem[];

    expect(items.map((item) => item.startCol)).toEqual([1, 2, 4, 5, 6]);
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

describe('週に描く、日付のまわりの祝日名・記念日名（日付の色と、マスの読み上げに使う）', () => {
  it('祝日の日には、祝日名が付く', () => {
    const cache = cacheOf([]);

    // 2026-11-03 は文化の日（火曜）。
    const day = cache.get(week('2026-11-03')).days[2];

    expect(day).toEqual({
      date: '2026-11-03',
      inRange: true,
      holidayName: '文化の日',
      observanceNames: [],
    });
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

describe('週に描く祝日・記念日の横棒', () => {
  const holidayOnly = [
    makeWorkspace({ id: 'w1', color: '#039BE5' }),
    makeWorkspace({ id: 'builtin-holiday', builtin: 'holiday', color: '#F28B82' }),
    makeWorkspace({ id: 'builtin-observance', builtin: 'observance', visible: false }),
  ];

  it('祝日は、その日 1 マスの横棒になる。色は、組み込みのワークスペース「祝日」の色', () => {
    const cache = cacheOf([], {
      workspaces: [
        makeWorkspace({ id: 'builtin-holiday', builtin: 'holiday', color: '#111111' }),
        makeWorkspace({ id: 'builtin-observance', builtin: 'observance', color: '#222222' }),
      ],
    });

    // 2026-11-03 は文化の日（火曜）。
    const items = cache.get(week('2026-11-03')).items;

    expect(items).toMatchObject([
      {
        kind: 'bar',
        event: { source: 'holiday', title: '文化の日', color: '#111111', allDay: true },
        startCol: 2,
        endCol: 2,
        row: 0,
      },
    ]);
  });

  it('記念日も、その日 1 マスの横棒になる。色は、組み込みのワークスペース「記念日」の色', () => {
    const cache = cacheOf([], {
      workspaces: [
        makeWorkspace({ id: 'builtin-holiday', builtin: 'holiday', color: '#111111' }),
        makeWorkspace({ id: 'builtin-observance', builtin: 'observance', color: '#222222' }),
      ],
    });

    // 2026-10-31 はハロウィン（土曜）。
    const items = cache.get(week('2026-10-31')).items;

    expect(items).toMatchObject([
      {
        kind: 'bar',
        event: { source: 'observance', title: 'ハロウィン', color: '#222222' },
        startCol: 6,
        endCol: 6,
      },
    ]);
  });

  it('振替休日も、祝日の横棒になる', () => {
    const cache = cacheOf([]);

    // 2025-11-23 が日曜なので、2025-11-24（月曜）が振替休日。
    const items = cache.get(week('2025-11-24')).items;

    expect(items).toMatchObject([
      { event: { source: 'holiday', title: '勤労感謝の日' }, startCol: 0 },
      { event: { source: 'holiday', title: '振替休日' }, startCol: 1 },
    ]);
  });

  it('祝日・記念日の横棒は、予定の行ではないので、フォームを開く回を持たない', () => {
    const cache = cacheOf([]);

    const [item] = cache.get(week('2026-11-03')).items as BarItem[];

    expect(item?.event).not.toHaveProperty('occurrence');
  });

  it('同じ日に重なる記念日（夏至と父の日）は、どちらも別の行の横棒になる', () => {
    const cache = cacheOf([]);

    // 2026-06-21（日曜）。
    const items = cache.get(week('2026-06-21')).items as BarItem[];

    expect(items.map((item) => [item.event.title, item.startCol, item.row]).sort()).toEqual([
      ['夏至', 0, expect.any(Number)],
      ['父の日', 0, expect.any(Number)],
    ]);
    expect(new Set(items.map((item) => item.row)).size).toBe(2);
  });

  it('その日の終日の予定より上（先頭）に出る。祝日 → 記念日 → 予定', () => {
    // 2026-06-21 は夏至と父の日。祝日ではないので、記念日の 2 つと予定。
    const cache = cacheOf([{ id: 'e1', title: '予定', startDate: '2026-06-21' }]);

    const items = cache.get(week('2026-06-21')).items as BarItem[];

    const rowOf = (title: string) => items.find((item) => item.event.title === title)?.row;
    expect(rowOf('夏至')).toBeLessThan(rowOf('予定') ?? -1);
    expect(rowOf('父の日')).toBeLessThan(rowOf('予定') ?? -1);
  });

  it('祝日は、その日の終日の予定より上に出る', () => {
    const cache = cacheOf([{ id: 'e1', title: '予定', startDate: '2026-11-03' }]);

    const items = cache.get(week('2026-11-03')).items as BarItem[];

    expect(items.map((item) => [item.event.title, item.row])).toEqual([
      ['文化の日', 0],
      ['予定', 1],
    ]);
  });

  it('前の日から続く複数日の横棒の行は動かさない。祝日は、空いている行のうち、いちばん上に置く', () => {
    const cache = cacheOf([
      { id: 'e1', title: '帰省', startDate: '2026-11-02', endDate: '2026-11-04' },
      { id: 'e2', title: '予定', startDate: '2026-11-03' },
    ]);

    const items = cache.get(week('2026-11-03')).items as BarItem[];

    expect(items.map((item) => [item.event.title, item.row])).toEqual([
      ['帰省', 0],
      ['文化の日', 1],
      ['予定', 2],
    ]);
  });

  it('入りきらないときは、予定と同じく「+N件」の数に含める', () => {
    const cache = cacheOf(
      [
        { id: 'e1', title: '予定 1', startDate: '2026-11-03' },
        { id: 'e2', title: '予定 2', startDate: '2026-11-03' },
      ],
      { slots: 2 },
    );

    const items = cache.get(week('2026-11-03')).items;

    expect(items.filter((item): item is BarItem => item.kind === 'bar')).toMatchObject([
      { event: { title: '文化の日' } },
    ]);
    expect(items.filter((item): item is MoreItem => item.kind === 'more')).toEqual([
      { kind: 'more', col: 2, row: 1, count: 2 },
    ]);
  });

  it('祝日の横棒が「+N件」の行に当たって隠れたときも、「+N件」の数に入る', () => {
    // 2 行。火曜に、前の日から続く帰省（行 0）と、祝日（行 1）と、予定 1 件。出せるのは 1 行（帰省）。
    const cache = cacheOf(
      [
        { id: 'e1', title: '帰省', startDate: '2026-11-02', endDate: '2026-11-04' },
        { id: 'e2', title: '予定', startDate: '2026-11-03' },
      ],
      { slots: 2 },
    );

    const items = cache.get(week('2026-11-03')).items;

    expect(items.filter((item): item is MoreItem => item.kind === 'more')).toEqual([
      { kind: 'more', col: 2, row: 1, count: 2 },
    ]);
  });

  it('組み込みのワークスペース「祝日」が OFF なら、祝日の横棒を出さない（記念日は出る）', () => {
    const cache = cacheOf([], {
      workspaces: [
        makeWorkspace({ id: 'builtin-holiday', builtin: 'holiday', visible: false }),
        makeWorkspace({ id: 'builtin-observance', builtin: 'observance' }),
      ],
    });

    expect(cache.get(week('2026-11-03')).items).toEqual([]);
    expect(cache.get(week('2026-10-31')).items).toMatchObject([{ event: { title: 'ハロウィン' } }]);
  });

  it('組み込みのワークスペース「記念日」が OFF なら、記念日の横棒を出さない（祝日は出る）', () => {
    const cache = cacheOf([], { workspaces: holidayOnly });

    expect(cache.get(week('2026-10-31')).items).toEqual([]);
    expect(cache.get(week('2026-11-03')).items).toMatchObject([{ event: { title: '文化の日' } }]);
  });

  it('組み込みの行が（まだ読み込んでいなくて）ないときは、色が決まらないので、横棒を出さない', () => {
    const cache = cacheOf([], { workspaces: [] });

    expect(cache.get(week('2026-11-03')).items).toEqual([]);
  });

  it('範囲（1900〜2199 年）の最初と最後の週でも、範囲の中の日の祝日が横棒になる', () => {
    const cache = cacheOf([]);

    // 1900-01-01 は元日ではない（祝日法は 1948 年から）。2199-12-31 は大晦日（記念日）。
    expect(cache.get(FIRST_WEEK_NUMBER).items).toEqual([]);
    expect(cache.get(LAST_WEEK_NUMBER).items).toMatchObject([
      { event: { title: '大晦日' }, startCol: 2 },
    ]);
  });
});

describe('まとまり（4 週間）の境目をまたぐ予定', () => {
  // 2026-10-18 以降で、最初に来る、まとまりの先頭の週。その 1 つ前の週が、前のまとまりの最後の週。
  const nextStart =
    FIRST_WEEK_NUMBER +
    Math.ceil((weekNumberOf('2026-10-18') - FIRST_WEEK_NUMBER) / CHUNK_WEEKS) * CHUNK_WEEKS;
  const previousLast = nextStart - 1;
  // 前のまとまりの最後の週の、金曜日（列 5）と、次のまとまりの最初の週の、月曜日（列 1）・水曜日（列 3）。
  const previousFriday = weekDates(previousLast)[5] ?? '';
  const previousWednesday = weekDates(previousLast)[3] ?? '';
  const nextMonday = weekDates(nextStart)[1] ?? '';
  const nextWednesday = weekDates(nextStart)[3] ?? '';

  function barsOf(cache: WeekViewCache, weekNumber: number): BarItem[] {
    return cache.get(weekNumber).items.filter((item): item is BarItem => item.kind === 'bar');
  }

  it('境目をまたぐ横棒は、前の週で右が切れ、後ろの週で左が切れる（後ろのまとまりを先に計算しても）', () => {
    const cache = cacheOf(
      [{ id: 'e1', title: '帰省', startDate: previousFriday, endDate: nextMonday }],
      { workspaces: workspacesWithoutNamedDates },
    );

    // 後ろのまとまりを先に計算する。
    const [after] = barsOf(cache, nextStart);
    const [before] = barsOf(cache, previousLast);

    expect(after).toMatchObject({
      startCol: 0,
      endCol: 1,
      continuesBefore: true,
      continuesAfter: false,
    });
    expect(before).toMatchObject({
      startCol: 5,
      endCol: 6,
      continuesBefore: false,
      continuesAfter: true,
    });
    expect(cache.computedChunkCount).toBe(2);
  });

  it('前のまとまりから始まる、繰り返しの複数日の回は、後ろのまとまりにも出る', () => {
    // 毎週金曜に始まる、金〜月（4 日間）の終日の予定。最初の回が、前のまとまりの最後の週の金曜。
    const cache = cacheOf(
      [
        {
          id: 's1',
          title: '週末',
          rrule: { freq: 'weekly', days: [5] },
          startDate: previousFriday,
          endDate: nextMonday,
        },
      ],
      { workspaces: workspacesWithoutNamedDates },
    );

    // 後ろのまとまりを先に計算する。前のまとまりの金曜に始まった回が、月曜まで続いて見える。
    const afterBars = barsOf(cache, nextStart);

    expect(afterBars.map((bar) => [bar.startCol, bar.endCol, bar.continuesBefore])).toEqual([
      [0, 1, true],
      [5, 6, false],
    ]);
    expect(afterBars[1]).toMatchObject({ continuesAfter: true });
  });

  it('別のまとまりへ移した例外の回は、移した先に出て、元の日には出ない', () => {
    // 毎日の系列の、前のまとまりの水曜の回だけを、次のまとまりの水曜に移した例外。
    const cache = cacheOf([
      { id: 's1', title: '毎日', rrule: { freq: 'daily' }, startDate: '2026-01-01' },
      {
        id: 'x1',
        title: '移した回',
        seriesId: 's1',
        originalDate: previousWednesday,
        startDate: nextWednesday,
        endDate: nextWednesday,
      },
    ]);

    // 移した先（後ろのまとまり）を先に計算する。
    const moved = barsOf(cache, nextStart).filter((bar) => bar.event.title === '移した回');
    const origin = barsOf(cache, previousLast).filter((bar) => bar.startCol === 3);

    expect(moved).toHaveLength(1);
    expect(moved[0]).toMatchObject({ startCol: 3, endCol: 3 });
    // 元の日（前のまとまりの水曜）には、系列の回も、移した回も出ない。
    expect(origin).toEqual([]);
    // 移した先の日には、移した回のほかに、系列のその日の回（動いていない）が出る。
    expect(barsOf(cache, nextStart).filter((bar) => bar.startCol === 3)).toHaveLength(2);
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
    // 2199-12-31 は大晦日。祝日・記念日の横棒を、予定と混ぜないよう、出さない。
    const cache = cacheOf([{ id: 'e1', rrule: { freq: 'daily' }, startDate: '2199-12-01' }], {
      workspaces: workspacesWithoutNamedDates,
    });

    const view = cache.get(LAST_WEEK_NUMBER);

    expect(view.days.at(-1)?.date).toBe('2200-01-04');
    // 2199-12-31（火）までは出るが、範囲の外（2200 年）の日の回は出ない。
    expect(view.items.map((item) => (item as BarItem).startCol)).toEqual([0, 1, 2]);
  });

  it('範囲の外の日（1899-12-31 と 2200-01-01 以降）は、inRange が false になる', () => {
    const cache = cacheOf([]);

    const first = cache.get(FIRST_WEEK_NUMBER).days.map((day) => [day.date, day.inRange]);
    const last = cache.get(LAST_WEEK_NUMBER).days.map((day) => [day.date, day.inRange]);

    expect(first[0]).toEqual(['1899-12-31', false]);
    expect(first.slice(1).every(([, inRange]) => inRange === true)).toBe(true);
    expect(last.slice(0, 3)).toEqual([
      ['2199-12-29', true],
      ['2199-12-30', true],
      ['2199-12-31', true],
    ]);
    expect(last.slice(3)).toEqual([
      ['2200-01-01', false],
      ['2200-01-02', false],
      ['2200-01-03', false],
      ['2200-01-04', false],
    ]);
  });

  it('範囲の中の日に始まる複数日の予定は、範囲の外の日まで横棒が伸び、外の日には「+N件」を出さない', () => {
    // 2199-12-31 に始まり、2200-01-03 まで続く終日の予定が 3 件。2 行しか入らないので、どの日もあふれる（外の日も、数えるだけなら「+2件」になる）。
    const cache = cacheOf(
      ['a', 'b', 'c'].map((id) => ({
        id,
        title: id,
        startDate: '2199-12-31',
        endDate: '2200-01-03',
      })),
      { slots: 2, workspaces: workspacesWithoutNamedDates },
    );

    const items = cache.get(LAST_WEEK_NUMBER).items;
    const mores = items.filter((item): item is MoreItem => item.kind === 'more');
    const bars = items.filter((item): item is BarItem => item.kind === 'bar');

    // 出せる行は 1 行（残りの 1 行が「+N件」）。その横棒は、範囲の外のマス（2200-01-01 = 列 3 から 2200-01-03 = 列 5）まで伸びる。
    expect(bars.map((bar) => [bar.event.title, bar.startCol, bar.endCol])).toEqual([['a', 2, 5]]);
    // 「+N件」は、範囲の中の日（2199-12-31 = 列 2）だけ。外の日（列 3 以降）には出ない。
    expect(mores).toEqual([{ kind: 'more', col: 2, row: 1, count: 2 }]);
  });

  it('範囲の中の週の日は、すべて inRange が true', () => {
    const days = cacheOf([]).get(week('2026-10-21')).days;

    expect(days.every((day) => day.inRange)).toBe(true);
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

    for (let chunk = 0; chunk < MAX_CACHED_CHUNKS * 3; chunk++) {
      cache.get(FIRST_WEEK_NUMBER + chunk * CHUNK_WEEKS);
    }

    expect(cache.computedChunkCount).toBe(MAX_CACHED_CHUNKS);
  });

  it('上限を超えて捨てられた週も、求め直せば同じ内容になる', () => {
    const cache = cacheOf([{ id: 'e1', startDate: '1900-01-02' }]);
    const before = cache.get(FIRST_WEEK_NUMBER);

    for (let chunk = 1; chunk <= MAX_CACHED_CHUNKS + 5; chunk++) {
      cache.get(FIRST_WEEK_NUMBER + chunk * CHUNK_WEEKS);
    }
    const after = cache.get(FIRST_WEEK_NUMBER);

    expect(after).toEqual(before);
    expect(after).not.toBe(before);
    expect(after.items).toHaveLength(1);
  });
});
