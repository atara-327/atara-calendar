import { describe, expect, it } from 'vitest';
import { addDays, dateToDays, daysToDate } from './date';
import { isOccurrenceDate, normalizeStart, type SeriesRule } from './recurrence';
import type { Rrule } from './schema';

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
