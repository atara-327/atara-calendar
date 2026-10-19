import { describe, expect, it } from 'vitest';
import { addDays, dateToDays, daysToDate } from './date';
import {
  expandOccurrences,
  isOccurrenceDate,
  lastCoveredDate,
  normalizeStart,
  type Occurrence,
  type SeriesRule,
} from './recurrence';
import type { Rrule } from './schema';
import { deepFreeze, makeEntry } from '../../test/helpers/entries';

function series(rrule: Rrule, startDate: string, untilDate: string | null = null): SeriesRule {
  return { rrule, startDate, untilDate };
}

/** from〜to（両端を含む）のうち、回にあたる日付。 */
function occurrenceDates(rule: SeriesRule, from: string, to: string): string[] {
  const dates: string[] = [];
  for (let days = dateToDays(from); days <= dateToDays(to); days++) {
    const date = daysToDate(days);
    if (isOccurrenceDate(rule, date)) dates.push(date);
  }
  return dates;
}

describe('RP-1: 毎日', () => {
  it('開始日から、すべての日が回になる', () => {
    expect(
      occurrenceDates(series({ freq: 'daily' }, '2026-10-19'), '2026-10-18', '2026-10-22'),
    ).toEqual(['2026-10-19', '2026-10-20', '2026-10-21', '2026-10-22']);
  });
});

describe('RP-1: 毎週（曜日を複数選べる）', () => {
  it('月・水・金を選ぶと、その曜日だけが回になる', () => {
    const rule = series({ freq: 'weekly', days: [1, 3, 5] }, '2026-10-19');
    expect(occurrenceDates(rule, '2026-10-19', '2026-10-26')).toEqual([
      '2026-10-19',
      '2026-10-21',
      '2026-10-23',
      '2026-10-26',
    ]);
  });

  it('日曜（0）と土曜（6）も選べる', () => {
    const rule = series({ freq: 'weekly', days: [0, 6] }, '2026-10-17');
    expect(occurrenceDates(rule, '2026-10-17', '2026-10-25')).toEqual([
      '2026-10-17',
      '2026-10-18',
      '2026-10-24',
      '2026-10-25',
    ]);
  });

  it('曜日の並びは、回の判定に影響しない', () => {
    const a = series({ freq: 'weekly', days: [5, 1, 3] }, '2026-10-19');
    const b = series({ freq: 'weekly', days: [1, 3, 5] }, '2026-10-19');
    expect(occurrenceDates(a, '2026-10-19', '2026-11-30')).toEqual(
      occurrenceDates(b, '2026-10-19', '2026-11-30'),
    );
  });
});

describe('RP-1: 毎月（開始日の「日」と同じ日）', () => {
  it('開始日と同じ日だけが回になる', () => {
    const rule = series({ freq: 'monthly' }, '2026-10-19');
    expect(occurrenceDates(rule, '2026-10-01', '2027-01-31')).toEqual([
      '2026-10-19',
      '2026-11-19',
      '2026-12-19',
      '2027-01-19',
    ]);
  });
});

describe('RP-2: 毎月の指定日がない月はスキップする', () => {
  it('31 日の毎月は、30 日までの月と 2 月をスキップする', () => {
    const rule = series({ freq: 'monthly' }, '2026-01-31');
    expect(occurrenceDates(rule, '2026-01-01', '2026-12-31')).toEqual([
      '2026-01-31',
      '2026-03-31',
      '2026-05-31',
      '2026-07-31',
      '2026-08-31',
      '2026-10-31',
      '2026-12-31',
    ]);
  });

  it('30 日の毎月は、2 月だけをスキップする', () => {
    const rule = series({ freq: 'monthly' }, '2026-01-30');
    expect(occurrenceDates(rule, '2026-01-01', '2026-04-30')).toEqual([
      '2026-01-30',
      '2026-03-30',
      '2026-04-30',
    ]);
  });

  it('29 日の毎月は、うるう年でない年の 2 月だけをスキップする', () => {
    const rule = series({ freq: 'monthly' }, '2023-01-29');
    expect(occurrenceDates(rule, '2024-01-01', '2024-03-31')).toEqual([
      '2024-01-29',
      '2024-02-29',
      '2024-03-29',
    ]);
    expect(occurrenceDates(rule, '2025-01-01', '2025-03-31')).toEqual(['2025-01-29', '2025-03-29']);
  });
});

describe('RP-1: 毎年（開始日と同じ月日）', () => {
  it('開始日と同じ月日だけが回になる', () => {
    const rule = series({ freq: 'yearly' }, '2026-10-19');
    expect(occurrenceDates(rule, '2026-01-01', '2029-12-31')).toEqual([
      '2026-10-19',
      '2027-10-19',
      '2028-10-19',
      '2029-10-19',
    ]);
  });
});

describe('RP-2: 2/29 の毎年は、うるう年だけが回になる', () => {
  const rule = series({ freq: 'yearly' }, '2024-02-29');

  it('うるう年でない年の 2/28 と 3/1 は回ではない', () => {
    expect(isOccurrenceDate(rule, '2025-02-28')).toBe(false);
    expect(isOccurrenceDate(rule, '2025-03-01')).toBe(false);
  });

  it('4 年ごとのうるう年は回になる', () => {
    expect(occurrenceDates(rule, '2024-01-01', '2032-12-31')).toEqual([
      '2024-02-29',
      '2028-02-29',
      '2032-02-29',
    ]);
  });

  it('2100 年は平年なので、2096 年の次は 2104 年になる', () => {
    expect(occurrenceDates(rule, '2097-01-01', '2104-12-31')).toEqual(['2104-02-29']);
  });
});

describe('RP-1・RP-5: 平日', () => {
  const rule = series({ freq: 'weekday' }, '2026-05-01');

  it('土曜・日曜は回ではない', () => {
    expect(isOccurrenceDate(rule, '2026-05-02')).toBe(false);
    expect(isOccurrenceDate(rule, '2026-05-03')).toBe(false);
  });

  it('祝日と、振替休日（2026-05-06）は回ではない', () => {
    expect(occurrenceDates(rule, '2026-05-01', '2026-05-08')).toEqual([
      '2026-05-01',
      '2026-05-07',
      '2026-05-08',
    ]);
  });

  it('国民の休日（2026-09-22）は回ではない', () => {
    expect(isOccurrenceDate(series({ freq: 'weekday' }, '2026-09-01'), '2026-09-22')).toBe(false);
  });

  it('年末年始（12/29〜1/3）は、平日の曜日でも回ではない', () => {
    const yearEnd = series({ freq: 'weekday' }, '2026-12-25');
    expect(occurrenceDates(yearEnd, '2026-12-25', '2027-01-05')).toEqual([
      '2026-12-25',
      '2026-12-28',
      '2027-01-04',
      '2027-01-05',
    ]);
  });

  it('記念日（2026-12-24 のクリスマスイブ）は休日ではないので、回になる', () => {
    expect(isOccurrenceDate(series({ freq: 'weekday' }, '2026-12-01'), '2026-12-24')).toBe(true);
  });
});

describe('RP-1・RP-5: 休日', () => {
  const rule = series({ freq: 'holiday' }, '2026-05-01');

  it('土曜・日曜と祝日と振替休日（2026-05-02〜06）が回になる', () => {
    expect(occurrenceDates(rule, '2026-05-01', '2026-05-08')).toEqual([
      '2026-05-02',
      '2026-05-03',
      '2026-05-04',
      '2026-05-05',
      '2026-05-06',
    ]);
  });

  it('年末年始（2026-12-29 は火曜）は、平日の曜日でも回になる', () => {
    const yearEnd = series({ freq: 'holiday' }, '2026-12-25');
    expect(occurrenceDates(yearEnd, '2026-12-25', '2027-01-05')).toEqual([
      '2026-12-26',
      '2026-12-27',
      '2026-12-29',
      '2026-12-30',
      '2026-12-31',
      '2027-01-01',
      '2027-01-02',
      '2027-01-03',
    ]);
  });

  it('平日の記念日（2026-12-24）は回ではない', () => {
    expect(isOccurrenceDate(series({ freq: 'holiday' }, '2026-12-01'), '2026-12-24')).toBe(false);
  });
});

describe('RP-3: 終わりの指定はない', () => {
  it('遠い年（2199 年の最後の月曜）まで、回になる', () => {
    expect(
      isOccurrenceDate(series({ freq: 'weekly', days: [1] }, '2026-10-19'), '2199-12-30'),
    ).toBe(true);
    expect(isOccurrenceDate(series({ freq: 'monthly' }, '2026-10-19'), '2199-12-19')).toBe(true);
    expect(isOccurrenceDate(series({ freq: 'yearly' }, '2026-10-19'), '2199-10-19')).toBe(true);
    expect(isOccurrenceDate(series({ freq: 'daily' }, '2026-10-19'), '2199-12-31')).toBe(true);
  });

  it('untilDate があれば、その日（含む）で止まる', () => {
    const rule = series({ freq: 'daily' }, '2026-10-19', '2026-10-21');
    expect(occurrenceDates(rule, '2026-10-18', '2026-10-24')).toEqual([
      '2026-10-19',
      '2026-10-20',
      '2026-10-21',
    ]);
  });
});

describe('開始日より前は、回ではない', () => {
  it.each<[string, Rrule]>([
    ['毎日', { freq: 'daily' }],
    ['毎週', { freq: 'weekly', days: [1] }],
    ['毎月', { freq: 'monthly' }],
    ['毎年', { freq: 'yearly' }],
    ['平日', { freq: 'weekday' }],
    ['休日', { freq: 'holiday' }],
  ])('%s', (_name, rrule) => {
    const rule = series(rrule, '2026-10-19');
    expect(isOccurrenceDate(rule, addDays('2026-10-19', -7))).toBe(false);
    expect(isOccurrenceDate(rule, addDays('2026-10-19', -1))).toBe(false);
  });
});

describe('4.4: 開始日の正規化', () => {
  it('月曜を開始日にして水・金を選ぶと、開始日は水曜になり、終了日も同じだけずれる', () => {
    expect(
      normalizeStart(
        { freq: 'weekly', days: [3, 5] },
        { startDate: '2026-10-19', endDate: '2026-10-20' },
      ),
    ).toEqual({ startDate: '2026-10-21', endDate: '2026-10-22' });
  });

  it('開始日がルールに合っていれば、そのまま', () => {
    const range = { startDate: '2026-10-21', endDate: '2026-10-23' };
    expect(normalizeStart({ freq: 'weekly', days: [3, 5] }, range)).toEqual(range);
  });

  it('金曜を開始日にして水・金を選んでも、開始日は金曜のまま', () => {
    expect(
      normalizeStart(
        { freq: 'weekly', days: [3, 5] },
        { startDate: '2026-10-23', endDate: '2026-10-23' },
      ),
    ).toEqual({ startDate: '2026-10-23', endDate: '2026-10-23' });
  });

  it('週をまたいで、次の週の曜日へずれることもある', () => {
    expect(
      normalizeStart(
        { freq: 'weekly', days: [1] },
        { startDate: '2026-10-20', endDate: '2026-10-20' },
      ),
    ).toEqual({ startDate: '2026-10-26', endDate: '2026-10-26' });
  });

  it('平日を、土曜から始めると、月曜になる', () => {
    expect(
      normalizeStart({ freq: 'weekday' }, { startDate: '2026-10-24', endDate: '2026-10-24' }),
    ).toEqual({ startDate: '2026-10-26', endDate: '2026-10-26' });
  });

  it('平日を、連休の初日（2026-05-02）から始めると、振替休日（5/6）の次の 5/7 になる', () => {
    expect(
      normalizeStart({ freq: 'weekday' }, { startDate: '2026-05-02', endDate: '2026-05-02' }),
    ).toEqual({ startDate: '2026-05-07', endDate: '2026-05-07' });
  });

  it('平日を、大型連休の初日（2019-04-27）から始めると、10 日後の 05-07 になる（1 週間では足りない）', () => {
    expect(
      normalizeStart({ freq: 'weekday' }, { startDate: '2019-04-27', endDate: '2019-04-27' }),
    ).toEqual({ startDate: '2019-05-07', endDate: '2019-05-07' });
  });

  it('平日を、年末年始（2026-12-29）から始めると、1/4 になる', () => {
    expect(
      normalizeStart({ freq: 'weekday' }, { startDate: '2026-12-29', endDate: '2026-12-29' }),
    ).toEqual({ startDate: '2027-01-04', endDate: '2027-01-04' });
  });

  it('休日を、平日（金曜）から始めると、土曜になる', () => {
    expect(
      normalizeStart({ freq: 'holiday' }, { startDate: '2026-10-23', endDate: '2026-10-23' }),
    ).toEqual({ startDate: '2026-10-24', endDate: '2026-10-24' });
  });

  it.each<[string, Rrule]>([
    ['毎日', { freq: 'daily' }],
    ['毎月', { freq: 'monthly' }],
    ['毎年', { freq: 'yearly' }],
  ])('%s は、開始日が基準なので、ずれない', (_name, rrule) => {
    const range = { startDate: '2026-10-19', endDate: '2026-10-20' };
    expect(normalizeStart(rrule, range)).toEqual(range);
  });

  it('合う日が見つからないルール（曜日が空の毎週）は例外を投げる', () => {
    expect(() =>
      normalizeStart(
        { freq: 'weekly', days: [] },
        { startDate: '2026-10-19', endDate: '2026-10-19' },
      ),
    ).toThrow(RangeError);
  });
});

/** 「元の行の id @ 回の日付」の形にして、どの回が出たかを比べやすくする。 */
function labels(occurrences: readonly Occurrence[]): string[] {
  return occurrences.map(({ entryId, occurrenceDate }) => `${entryId}@${occurrenceDate}`);
}

describe('展開: 繰り返さない予定', () => {
  const single = makeEntry({ id: 'e1', startDate: '2026-10-19', endDate: '2026-10-19' });

  it('期間（両端を含む）にかかる予定だけが出る', () => {
    expect(labels(expandOccurrences([single], '2026-10-19', '2026-10-19'))).toEqual([
      'e1@2026-10-19',
    ]);
    expect(labels(expandOccurrences([single], '2026-10-13', '2026-10-19'))).toEqual([
      'e1@2026-10-19',
    ]);
    expect(expandOccurrences([single], '2026-10-20', '2026-10-26')).toEqual([]);
    expect(expandOccurrences([single], '2026-10-12', '2026-10-18')).toEqual([]);
  });

  it('期間の終わりが開始より前（from が to より後）なら、空', () => {
    expect(expandOccurrences([single], '2026-10-20', '2026-10-18')).toEqual([]);
  });

  it('各回に、元の行の id・系列の id（自分の id）・回の日付・内容が入る', () => {
    const row = makeEntry({
      id: 'e1',
      title: '歯医者',
      allDay: false,
      startTime: '15:00',
      endTime: '16:00',
      location: '○○歯科',
      url: 'https://example.com',
      memo: '保険証',
      notifyEnabled: false,
      notifyOffsetMin: 30,
    });
    expect(expandOccurrences([row], '2026-10-19', '2026-10-19')).toEqual([
      {
        entryId: 'e1',
        seriesId: 'e1',
        occurrenceDate: '2026-10-19',
        isException: false,
        recurring: false,
        kind: 'event',
        title: '歯医者',
        workspaceId: 'w1',
        allDay: false,
        startDate: '2026-10-19',
        startTime: '15:00',
        endDate: '2026-10-19',
        endTime: '16:00',
        location: '○○歯科',
        url: 'https://example.com',
        memo: '保険証',
        notifyEnabled: false,
        notifyOffsetMin: 30,
      },
    ]);
  });
});

describe('EV-4: 複数日にまたがる予定', () => {
  const trip = makeEntry({ id: 'trip', startDate: '2026-10-17', endDate: '2026-10-20' });

  it('期間の前から始まっていても、期間にかかっていれば出る', () => {
    expect(labels(expandOccurrences([trip], '2026-10-19', '2026-10-25'))).toEqual([
      'trip@2026-10-17',
    ]);
  });

  it('終日の最終日（endDate）は、その日を含む', () => {
    expect(labels(expandOccurrences([trip], '2026-10-20', '2026-10-20'))).toEqual([
      'trip@2026-10-17',
    ]);
    expect(expandOccurrences([trip], '2026-10-21', '2026-10-25')).toEqual([]);
  });

  it('期間の後から始まるものは出ない', () => {
    expect(expandOccurrences([trip], '2026-10-10', '2026-10-16')).toEqual([]);
  });

  it('繰り返しの回も、前の回が期間にかかっていれば出る（毎週 水・金の 2 日間）', () => {
    const rule = makeEntry({
      id: 's1',
      rrule: { freq: 'weekly', days: [3, 5] },
      startDate: '2026-10-21',
      endDate: '2026-10-22',
    });
    const occurrences = expandOccurrences([rule], '2026-10-22', '2026-10-25');
    expect(labels(occurrences)).toEqual(['s1@2026-10-21', 's1@2026-10-23']);
    expect(occurrences.map(({ startDate, endDate }) => [startDate, endDate])).toEqual([
      ['2026-10-21', '2026-10-22'],
      ['2026-10-23', '2026-10-24'],
    ]);
  });
});

describe('TB-6: 日付をまたぐタイムブロック', () => {
  const sleep = makeEntry({
    id: 'sleep',
    kind: 'block',
    workspaceId: null,
    allDay: false,
    startDate: '2026-10-19',
    startTime: '23:00',
    endDate: '2026-10-20',
    endTime: '07:00',
    notifyEnabled: false,
  });

  it('23:00〜翌 7:00 は、開始の日にも終わりの日にもかかる', () => {
    expect(labels(expandOccurrences([sleep], '2026-10-19', '2026-10-19'))).toEqual([
      'sleep@2026-10-19',
    ]);
    expect(labels(expandOccurrences([sleep], '2026-10-20', '2026-10-20'))).toEqual([
      'sleep@2026-10-19',
    ]);
    expect(expandOccurrences([sleep], '2026-10-21', '2026-10-21')).toEqual([]);
  });

  it('毎日の繰り返しなら、ある日には前の日の回の続きと、その日の回が両方かかる', () => {
    const daily = { ...sleep, rrule: { freq: 'daily' } as const };
    expect(labels(expandOccurrences([daily], '2026-10-21', '2026-10-21'))).toEqual([
      'sleep@2026-10-20',
      'sleep@2026-10-21',
    ]);
  });

  it('終了が 00:00 なら、その日にはかからない（終わりの瞬間を含まないため）', () => {
    const block = makeEntry({
      id: 'b1',
      kind: 'block',
      workspaceId: null,
      allDay: false,
      startTime: '20:00',
      endDate: '2026-10-20',
      endTime: '00:00',
    });
    expect(labels(expandOccurrences([block], '2026-10-19', '2026-10-19'))).toEqual([
      'b1@2026-10-19',
    ]);
    expect(expandOccurrences([block], '2026-10-20', '2026-10-20')).toEqual([]);
  });

  it('毎日の 20:00〜翌 00:00 は、前の日の回が翌日にかからない', () => {
    const daily = makeEntry({
      id: 'b1',
      kind: 'block',
      workspaceId: null,
      allDay: false,
      rrule: { freq: 'daily' },
      startTime: '20:00',
      endDate: '2026-10-20',
      endTime: '00:00',
    });
    expect(labels(expandOccurrences([daily], '2026-10-21', '2026-10-21'))).toEqual([
      'b1@2026-10-21',
    ]);
  });

  it('複数日の時間指定で、終了が 00:00 なら、最後の日の前の日までかかる', () => {
    const trip = makeEntry({
      id: 't1',
      allDay: false,
      startDate: '2026-10-23',
      startTime: '18:00',
      endDate: '2026-10-26',
      endTime: '00:00',
    });
    expect(labels(expandOccurrences([trip], '2026-10-25', '2026-10-25'))).toEqual([
      't1@2026-10-23',
    ]);
    expect(expandOccurrences([trip], '2026-10-26', '2026-10-26')).toEqual([]);
  });

  it('00:00〜00:00（同じ日）は、開始の日に出る', () => {
    const instant = makeEntry({
      id: 'i1',
      allDay: false,
      startTime: '00:00',
      endTime: '00:00',
    });
    expect(labels(expandOccurrences([instant], '2026-10-19', '2026-10-19'))).toEqual([
      'i1@2026-10-19',
    ]);
  });
});

describe('lastCoveredDate: 回がかかる最後の日', () => {
  it.each([
    ['終日は endDate', { allDay: true, endTime: null, endDate: '2026-10-20' }, '2026-10-20'],
    [
      '時間指定は endDate',
      { allDay: false, endTime: '07:00', endDate: '2026-10-20' },
      '2026-10-20',
    ],
    [
      '終了が 00:00 なら前の日',
      { allDay: false, endTime: '00:00', endDate: '2026-10-20' },
      '2026-10-19',
    ],
    [
      '00:00 でも、開始日より前にはならない',
      { allDay: false, endTime: '00:00', endDate: '2026-10-19' },
      '2026-10-19',
    ],
  ])('%s', (_name, fields, expected) => {
    expect(lastCoveredDate({ startDate: '2026-10-19', ...fields })).toBe(expected);
  });
});

describe('RP-1〜3: 系列の展開', () => {
  it('毎週 月・水・金は、期間の中の該当する日だけが出る', () => {
    const rule = makeEntry({
      id: 's1',
      rrule: { freq: 'weekly', days: [1, 3, 5] },
      startDate: '2026-10-19',
      endDate: '2026-10-19',
    });
    expect(labels(expandOccurrences([rule], '2026-10-14', '2026-10-24'))).toEqual([
      's1@2026-10-19',
      's1@2026-10-21',
      's1@2026-10-23',
    ]);
  });

  it('開始日より前の日は出ない', () => {
    const rule = makeEntry({ id: 's1', rrule: { freq: 'daily' }, startDate: '2026-10-19' });
    expect(labels(expandOccurrences([rule], '2026-10-17', '2026-10-20'))).toEqual([
      's1@2026-10-19',
      's1@2026-10-20',
    ]);
  });

  it('RP-3: 終わりがなく、遠い年（2199 年）でも出る', () => {
    const rule = makeEntry({ id: 's1', rrule: { freq: 'monthly' }, startDate: '2026-10-19' });
    expect(labels(expandOccurrences([rule], '2199-12-01', '2199-12-31'))).toEqual([
      's1@2199-12-19',
    ]);
  });

  it('RP-3: untilDate があれば、その日（含む）で止まる', () => {
    const rule = makeEntry({
      id: 's1',
      rrule: { freq: 'daily' },
      startDate: '2026-10-19',
      untilDate: '2026-10-21',
    });
    expect(labels(expandOccurrences([rule], '2026-10-19', '2026-10-30'))).toEqual([
      's1@2026-10-19',
      's1@2026-10-20',
      's1@2026-10-21',
    ]);
  });

  it('RP-1・RP-5: 平日は、2026 年の GW の連休と振替休日（5/6）を飛ばす', () => {
    const rule = makeEntry({ id: 's1', rrule: { freq: 'weekday' }, startDate: '2026-05-01' });
    expect(labels(expandOccurrences([rule], '2026-05-01', '2026-05-10'))).toEqual([
      's1@2026-05-01',
      's1@2026-05-07',
      's1@2026-05-08',
    ]);
  });

  it('RP-1・RP-5: 休日は、年末年始の 12/29〜1/3 を含む', () => {
    const rule = makeEntry({ id: 's1', rrule: { freq: 'holiday' }, startDate: '2026-12-25' });
    expect(labels(expandOccurrences([rule], '2026-12-28', '2027-01-04'))).toEqual([
      's1@2026-12-29',
      's1@2026-12-30',
      's1@2026-12-31',
      's1@2027-01-01',
      's1@2027-01-02',
      's1@2027-01-03',
    ]);
  });

  it('各回の開始日・終了日は、その回の日付になり、1 回の長さは系列と同じ', () => {
    const rule = makeEntry({
      id: 's1',
      rrule: { freq: 'weekly', days: [1] },
      startDate: '2026-10-19',
      endDate: '2026-10-21',
    });
    const [first, second] = expandOccurrences([rule], '2026-10-19', '2026-10-30');
    expect([first?.startDate, first?.endDate]).toEqual(['2026-10-19', '2026-10-21']);
    expect([second?.startDate, second?.endDate]).toEqual(['2026-10-26', '2026-10-28']);
  });

  it('RP-6: タイムブロック（kind が block）も同じように展開される', () => {
    const rule = makeEntry({
      id: 'b1',
      kind: 'block',
      workspaceId: null,
      allDay: false,
      rrule: { freq: 'weekday' },
      startDate: '2026-10-19',
      startTime: '09:00',
      endDate: '2026-10-19',
      endTime: '18:00',
      notifyEnabled: false,
    });
    const occurrences = expandOccurrences([rule], '2026-10-19', '2026-10-26');
    expect(labels(occurrences)).toEqual([
      'b1@2026-10-19',
      'b1@2026-10-20',
      'b1@2026-10-21',
      'b1@2026-10-22',
      'b1@2026-10-23',
      'b1@2026-10-26',
    ]);
    expect(
      occurrences.every(({ kind, startTime }) => kind === 'block' && startTime === '09:00'),
    ).toBe(true);
  });
});

describe('RP-4: 例外の行の展開', () => {
  const daily = makeEntry({
    id: 's1',
    title: 'ジム',
    rrule: { freq: 'daily' },
    startDate: '2026-10-19',
    allDay: false,
    startTime: '19:00',
    endTime: '20:00',
  });

  function exception(overrides: Parameters<typeof makeEntry>[0]) {
    return makeEntry({
      seriesId: 's1',
      allDay: false,
      startTime: '19:00',
      endTime: '20:00',
      ...overrides,
    });
  }

  it('例外の行は、originalDate の回を置き換える', () => {
    const ex = exception({
      id: 'ex1',
      originalDate: '2026-10-21',
      title: 'ジム（プール）',
      startDate: '2026-10-21',
      endDate: '2026-10-21',
      startTime: '07:00',
      endTime: '08:00',
    });
    const occurrences = expandOccurrences([daily, ex], '2026-10-20', '2026-10-22');
    expect(labels(occurrences)).toEqual(['s1@2026-10-20', 'ex1@2026-10-21', 's1@2026-10-22']);
    const replaced = occurrences[1];
    expect(replaced).toMatchObject({
      entryId: 'ex1',
      seriesId: 's1',
      occurrenceDate: '2026-10-21',
      isException: true,
      title: 'ジム（プール）',
      startTime: '07:00',
    });
    expect(occurrences[0]?.isException).toBe(false);
  });

  it('cancelled の例外は、その回を出さない', () => {
    const ex = exception({
      id: 'ex1',
      originalDate: '2026-10-21',
      startDate: '2026-10-21',
      endDate: '2026-10-21',
      cancelled: true,
    });
    expect(labels(expandOccurrences([daily, ex], '2026-10-20', '2026-10-22'))).toEqual([
      's1@2026-10-20',
      's1@2026-10-22',
    ]);
  });

  it('日時を別の日に移した例外は、移した先の日に出て、元の日には出ない', () => {
    const ex = exception({
      id: 'ex1',
      originalDate: '2026-10-21',
      startDate: '2026-10-25',
      endDate: '2026-10-25',
    });
    expect(labels(expandOccurrences([daily, ex], '2026-10-21', '2026-10-21'))).toEqual([]);
    expect(labels(expandOccurrences([daily, ex], '2026-10-25', '2026-10-25'))).toEqual([
      'ex1@2026-10-21',
      's1@2026-10-25',
    ]);
  });

  it('移す前の日（originalDate）が期間の外でも、移した先が期間にかかれば出る', () => {
    const ex = exception({
      id: 'ex1',
      originalDate: '2026-10-21',
      startDate: '2026-10-25',
      endDate: '2026-10-25',
    });
    const occurrences = expandOccurrences([daily, ex], '2026-10-24', '2026-10-26');
    expect(labels(occurrences)).toEqual([
      's1@2026-10-24',
      'ex1@2026-10-21',
      's1@2026-10-25',
      's1@2026-10-26',
    ]);
  });

  it('期間の外の日から、期間の中へ移した例外も出る', () => {
    const ex = exception({
      id: 'ex1',
      originalDate: '2026-10-10',
      startDate: '2026-10-21',
      endDate: '2026-10-21',
      startTime: '12:00',
      endTime: '13:00',
    });
    const earlier = makeEntry({
      id: 's1',
      rrule: { freq: 'daily' },
      startDate: '2026-10-01',
      allDay: false,
      startTime: '19:00',
      endTime: '20:00',
    });
    const occurrences = expandOccurrences([earlier, ex], '2026-10-21', '2026-10-21');
    expect(labels(occurrences)).toEqual(['ex1@2026-10-10', 's1@2026-10-21']);
  });

  it('終日の例外を、前の日から始まる複数日に変えたものも、かかる日で出る', () => {
    const ex = exception({
      id: 'ex1',
      originalDate: '2026-10-21',
      allDay: true,
      startTime: null,
      endTime: null,
      startDate: '2026-10-20',
      endDate: '2026-10-22',
    });
    expect(labels(expandOccurrences([daily, ex], '2026-10-22', '2026-10-22'))).toEqual([
      'ex1@2026-10-21',
      's1@2026-10-22',
    ]);
  });

  it('同じ回の例外が 2 行あれば、編集時刻が新しい方だけを使う', () => {
    const older = exception({
      id: 'ex-a',
      originalDate: '2026-10-21',
      startDate: '2026-10-21',
      endDate: '2026-10-21',
      title: '古い',
      editedAt: 1000,
    });
    const newer = exception({
      id: 'ex-b',
      originalDate: '2026-10-21',
      startDate: '2026-10-21',
      endDate: '2026-10-21',
      title: '新しい',
      editedAt: 2000,
    });
    const occurrences = expandOccurrences([daily, newer, older], '2026-10-21', '2026-10-21');
    expect(occurrences.map(({ title }) => title)).toEqual(['新しい']);
  });

  it('削除済みの例外は無視され、元の回が戻る', () => {
    const ex = exception({
      id: 'ex1',
      originalDate: '2026-10-21',
      startDate: '2026-10-21',
      endDate: '2026-10-21',
      cancelled: true,
      deletedAt: 5000,
    });
    expect(labels(expandOccurrences([daily, ex], '2026-10-21', '2026-10-21'))).toEqual([
      's1@2026-10-21',
    ]);
  });

  it('系列が削除されていれば、その例外の行も出さない', () => {
    const ex = exception({
      id: 'ex1',
      originalDate: '2026-10-21',
      startDate: '2026-10-21',
      endDate: '2026-10-21',
    });
    const deleted = { ...daily, deletedAt: 5000 };
    expect(expandOccurrences([deleted, ex], '2026-10-01', '2026-10-31')).toEqual([]);
  });

  it('系列の行が見つからない例外の行は出さない', () => {
    const ex = exception({
      id: 'ex1',
      originalDate: '2026-10-21',
      startDate: '2026-10-21',
      endDate: '2026-10-21',
    });
    expect(expandOccurrences([ex], '2026-10-01', '2026-10-31')).toEqual([]);
  });
});

describe('展開: Occurrence.recurring（範囲を選ぶ画面を出すかどうか）', () => {
  const daily = makeEntry({ id: 's1', rrule: { freq: 'daily' }, startDate: '2026-10-19' });
  const exception = makeEntry({
    id: 'ex1',
    seriesId: 's1',
    originalDate: '2026-10-20',
    startDate: '2026-10-21',
  });

  it('繰り返さない予定は false', () => {
    const single = makeEntry({ id: 'e1' });
    expect(expandOccurrences([single], '2026-10-19', '2026-10-19').map((o) => o.recurring)).toEqual(
      [false],
    );
  });

  it('系列の回は true', () => {
    const occurrences = expandOccurrences([daily], '2026-10-19', '2026-10-20');
    expect(occurrences.map(({ recurring }) => recurring)).toEqual([true, true]);
  });

  it('系列の例外の回（移した回を含む）は true', () => {
    const occurrences = expandOccurrences([daily, exception], '2026-10-20', '2026-10-21');
    expect(
      occurrences.filter(({ isException }) => isException).map(({ recurring }) => recurring),
    ).toEqual([true]);
  });
});

describe('展開: 期間の端', () => {
  const daily = makeEntry({ id: 's1', rrule: { freq: 'daily' }, startDate: '2026-10-19' });
  const exception = makeEntry({
    id: 'ex1',
    seriesId: 's1',
    originalDate: '2026-10-21',
    startDate: '2026-10-21',
  });

  it('from が to より後なら、系列も例外も出ず、空になる', () => {
    expect(expandOccurrences([daily, exception], '2026-10-25', '2026-10-20')).toEqual([]);
  });

  it('from が to より後なら、両方の日にかかる長い予定や系列があっても、空になる', () => {
    const trip = makeEntry({ id: 'trip', startDate: '2026-10-10', endDate: '2026-10-30' });
    const longWeekly = makeEntry({
      id: 'long',
      rrule: { freq: 'weekly', days: [1] },
      startDate: '2026-10-05',
      endDate: '2026-10-30',
    });
    expect(expandOccurrences([trip, longWeekly], '2026-10-25', '2026-10-20')).toEqual([]);
  });

  it('from と to が同じ日なら、その 1 日だけを展開する', () => {
    expect(labels(expandOccurrences([daily], '2026-10-22', '2026-10-22'))).toEqual([
      's1@2026-10-22',
    ]);
  });

  it('2199 年の末をまたぐ期間でも例外にならず、2199-12-31 までの回が出る', () => {
    const weekday = makeEntry({ id: 'w', rrule: { freq: 'weekday' }, startDate: '2199-12-01' });
    const holiday = makeEntry({ id: 'h', rrule: { freq: 'holiday' }, startDate: '2199-12-01' });
    const weekdays = expandOccurrences([weekday], '2199-12-20', '2200-01-10');
    const holidays = expandOccurrences([holiday], '2199-12-20', '2200-01-10');
    expect(weekdays.at(-1)?.occurrenceDate).toBe('2199-12-27');
    expect(holidays.at(-1)?.occurrenceDate).toBe('2199-12-31');
  });

  it('2199-12-31 の毎日は、期間が 2200 年にかかっても、2199-12-31 で止まる', () => {
    const every = makeEntry({ id: 's1', rrule: { freq: 'daily' }, startDate: '2199-12-30' });
    expect(labels(expandOccurrences([every], '2199-12-30', '2200-01-05'))).toEqual([
      's1@2199-12-30',
      's1@2199-12-31',
    ]);
  });

  it('1900 年より前の日は、系列の開始日がそれより前でも、回を生成しない', () => {
    const weekday = makeEntry({ id: 'w', rrule: { freq: 'weekday' }, startDate: '1899-12-27' });
    expect(labels(expandOccurrences([weekday], '1899-12-27', '1900-01-08'))).toEqual([
      'w@1900-01-04',
      'w@1900-01-05',
      'w@1900-01-08',
    ]);
  });
});

describe('展開: 削除済みの行', () => {
  it('deletedAt がある、繰り返さない予定と系列は出ない', () => {
    const single = makeEntry({ id: 'e1', deletedAt: 5000 });
    const series = makeEntry({ id: 's1', rrule: { freq: 'daily' }, deletedAt: 5000 });
    expect(expandOccurrences([single, series], '2026-10-01', '2026-10-31')).toEqual([]);
  });
});

describe('展開: 並び順', () => {
  const allDayOn19 = makeEntry({ id: 'd', startDate: '2026-10-19', endDate: '2026-10-19' });
  const allDayOn20 = makeEntry({ id: 'b', startDate: '2026-10-20', endDate: '2026-10-20' });
  const at9 = makeEntry({
    id: 'c',
    allDay: false,
    startDate: '2026-10-20',
    startTime: '09:00',
    endDate: '2026-10-20',
    endTime: '10:00',
  });
  const at10 = makeEntry({
    id: 'a',
    allDay: false,
    startDate: '2026-10-20',
    startTime: '10:00',
    endDate: '2026-10-20',
    endTime: '11:00',
  });

  it('開始の日時の順に並び、同じ日なら終日が先', () => {
    expect(
      labels(expandOccurrences([at10, at9, allDayOn20, allDayOn19], '2026-10-19', '2026-10-20')),
    ).toEqual(['d@2026-10-19', 'b@2026-10-20', 'c@2026-10-20', 'a@2026-10-20']);
  });

  it('期間の前から始まる複数日の予定は、開始の日時の位置に並ぶ', () => {
    const trip = makeEntry({ id: 'trip', startDate: '2026-10-17', endDate: '2026-10-20' });
    expect(labels(expandOccurrences([allDayOn20, trip], '2026-10-19', '2026-10-20'))).toEqual([
      'trip@2026-10-17',
      'b@2026-10-20',
    ]);
  });

  it('開始が同じなら、入力の並びによらず結果が同じになる', () => {
    const a = makeEntry({ id: 'a1' });
    const b = makeEntry({ id: 'a2' });
    expect(labels(expandOccurrences([a, b], '2026-10-19', '2026-10-19'))).toEqual(
      labels(expandOccurrences([b, a], '2026-10-19', '2026-10-19')),
    );
  });
});

describe('展開は純粋な関数', () => {
  const entries = deepFreeze([
    makeEntry({ id: 's1', rrule: { freq: 'weekly', days: [1, 3] }, startDate: '2026-10-19' }),
    makeEntry({
      id: 'ex1',
      seriesId: 's1',
      originalDate: '2026-10-21',
      startDate: '2026-10-22',
      endDate: '2026-10-22',
    }),
    makeEntry({ id: 'e1', startDate: '2026-10-20', endDate: '2026-10-20' }),
  ]);

  it('同じ入力からは、同じ結果が返る', () => {
    expect(expandOccurrences(entries, '2026-10-19', '2026-11-15')).toEqual(
      expandOccurrences(entries, '2026-10-19', '2026-11-15'),
    );
  });

  it('入力の配列と行を書き換えない（凍結した入力で例外にならない）', () => {
    expect(() => expandOccurrences(entries, '2026-10-19', '2026-11-15')).not.toThrow();
  });
});
