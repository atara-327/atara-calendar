import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  addDays,
  dateToDays,
  dateToYmd,
  dayOfWeek,
  daysInMonth,
  daysToDate,
  isLeapYear,
  nthWeekday,
  todayJst,
  utcMsToJstDate,
  ymdToDate,
} from './date';

describe('isLeapYear', () => {
  it.each([
    [1900, false],
    [2000, true],
    [2024, true],
    [2026, false],
    [2100, false],
    [2196, true],
  ])('%i 年は、うるう年 = %s', (year, expected) => {
    expect(isLeapYear(year)).toBe(expected);
  });
});

describe('daysInMonth', () => {
  it.each([
    [1900, 2, 28],
    [2000, 2, 29],
    [2026, 2, 28],
    [2024, 2, 29],
    [2026, 1, 31],
    [2026, 4, 30],
    [2026, 12, 31],
  ])('%i 年 %i 月は %i 日ある', (year, month, expected) => {
    expect(daysInMonth(year, month)).toBe(expected);
  });

  it.each([0, 13, 1.5])('月が %s のときは例外を投げる', (month) => {
    expect(() => daysInMonth(2026, month)).toThrow(RangeError);
  });
});

describe('日付文字列と日数の変換', () => {
  it('1970-01-01 は 0 日目', () => {
    expect(dateToDays('1970-01-01')).toBe(0);
    expect(daysToDate(0)).toBe('1970-01-01');
  });

  it('1970-01-01 より前は負の日数になる', () => {
    expect(dateToDays('1969-12-31')).toBe(-1);
    expect(daysToDate(-1)).toBe('1969-12-31');
  });

  it.each([
    ['1900-01-01', -25_567],
    ['2000-01-01', 10_957],
    ['2000-03-01', 11_017],
    ['2026-10-19', 20_745],
  ])('%s は %i 日目', (date, days) => {
    expect(dateToDays(date)).toBe(days);
    expect(daysToDate(days)).toBe(date);
  });

  it('スクロールできる範囲（1900-01-01〜2199-12-31）の全日で、UTC の暦と一致して往復できる', () => {
    const first = dateToDays('1900-01-01');
    const last = dateToDays('2199-12-31');

    for (let days = first; days <= last; days++) {
      const date = daysToDate(days);

      expect(date).toBe(new Date(days * 86_400_000).toISOString().slice(0, 10));
      expect(dateToDays(date)).toBe(days);
    }
  });

  it.each([
    '2026-02-30',
    '2026-02-29',
    '1900-02-29',
    '2026-13-01',
    '2026-00-10',
    '2026-04-31',
    '2026-01-00',
    '2026-1-1',
    '26-01-01',
    '2026/01/01',
    '2026-01-01T00:00',
    '',
  ])('不正な日付 %j は例外を投げる', (date) => {
    expect(() => dateToDays(date)).toThrow(RangeError);
    expect(() => dateToYmd(date)).toThrow(RangeError);
  });

  it('うるう日は受け付ける', () => {
    expect(dateToYmd('2024-02-29')).toEqual({ year: 2024, month: 2, day: 29 });
    expect(dateToYmd('2000-02-29')).toEqual({ year: 2000, month: 2, day: 29 });
  });

  it('整数でない日数は例外を投げる', () => {
    expect(() => daysToDate(0.5)).toThrow(RangeError);
  });
});

describe('ymdToDate', () => {
  it('年月日を 0 埋めした日付文字列にする', () => {
    expect(ymdToDate(2026, 1, 5)).toBe('2026-01-05');
    expect(ymdToDate(1900, 12, 31)).toBe('1900-12-31');
  });

  it('存在しない日付は例外を投げる', () => {
    expect(() => ymdToDate(2026, 2, 29)).toThrow(RangeError);
    expect(() => ymdToDate(2026, 0, 1)).toThrow(RangeError);
  });
});

describe('dayOfWeek', () => {
  it.each([
    ['1970-01-01', 4],
    ['1900-01-01', 1],
    ['2000-01-01', 6],
    ['2024-02-29', 4],
    ['2026-10-18', 0],
    ['2026-10-19', 1],
    ['2026-10-24', 6],
  ])('%s の曜日は %i（0 = 日曜〜6 = 土曜）', (date, expected) => {
    expect(dayOfWeek(date)).toBe(expected);
  });

  it('連続する日付で 0〜6 を順にくり返す', () => {
    let date = '1900-01-07';
    for (let i = 0; i < 400; i++) {
      expect(dayOfWeek(date)).toBe(i % 7);
      date = addDays(date, 1);
    }
  });
});

describe('addDays', () => {
  it.each([
    ['2026-10-19', 0, '2026-10-19'],
    ['2026-10-19', 1, '2026-10-20'],
    ['2026-10-31', 1, '2026-11-01'],
    ['2026-12-31', 1, '2027-01-01'],
    ['2027-01-01', -1, '2026-12-31'],
    ['2026-02-28', 1, '2026-03-01'],
    ['2024-02-28', 1, '2024-02-29'],
    ['2024-02-29', 1, '2024-03-01'],
    ['2000-02-28', 2, '2000-03-01'],
    ['1900-02-28', 1, '1900-03-01'],
    ['2026-10-19', 365, '2027-10-19'],
    ['2026-10-19', -7, '2026-10-12'],
  ])('%s の %i 日後は %s', (date, n, expected) => {
    expect(addDays(date, n)).toBe(expected);
  });
});

describe('nthWeekday', () => {
  it('2026年1月の第2月曜（成人の日）は 1/12', () => {
    expect(nthWeekday(2026, 1, 1, 2)).toBe('2026-01-12');
  });

  it('2026年5月の第2日曜（母の日）は 5/10', () => {
    expect(nthWeekday(2026, 5, 0, 2)).toBe('2026-05-10');
  });

  it('2026年6月の第3日曜（父の日）は 6/21', () => {
    expect(nthWeekday(2026, 6, 0, 3)).toBe('2026-06-21');
  });

  it('月の1日がその曜日なら、第1がその日になる', () => {
    // 2026-03-01 は日曜
    expect(nthWeekday(2026, 3, 0, 1)).toBe('2026-03-01');
    expect(nthWeekday(2026, 3, 0, 5)).toBe('2026-03-29');
  });

  it('月の末日が第n曜日になることがある', () => {
    // 2026-05-31 は日曜
    expect(nthWeekday(2026, 5, 0, 5)).toBe('2026-05-31');
  });

  it('その月にない第n曜日は例外を投げる', () => {
    // 2026年2月の日曜は 1・8・15・22 の4回だけ
    expect(() => nthWeekday(2026, 2, 0, 5)).toThrow(RangeError);
  });

  it('曜日や n が範囲外なら例外を投げる', () => {
    expect(() => nthWeekday(2026, 1, 7, 1)).toThrow(RangeError);
    expect(() => nthWeekday(2026, 1, 1, 0)).toThrow(RangeError);
  });
});

describe('utcMsToJstDate', () => {
  it('UTC 14:59:59.999 はまだ同じ日、15:00:00.000 から翌日になる', () => {
    expect(utcMsToJstDate(Date.UTC(2026, 9, 19, 14, 59, 59, 999))).toBe('2026-10-19');
    expect(utcMsToJstDate(Date.UTC(2026, 9, 19, 15, 0, 0, 0))).toBe('2026-10-20');
  });

  it('年の境目をまたぐ', () => {
    expect(utcMsToJstDate(Date.UTC(2026, 11, 31, 14, 59, 59, 999))).toBe('2026-12-31');
    expect(utcMsToJstDate(Date.UTC(2026, 11, 31, 15, 0, 0, 0))).toBe('2027-01-01');
  });

  it('1970年より前のミリ秒でも日付が正しく切り替わる', () => {
    expect(utcMsToJstDate(-9 * 3_600_000)).toBe('1970-01-01');
    expect(utcMsToJstDate(-9 * 3_600_000 - 1)).toBe('1969-12-31');
  });
});

describe('ENV-3: todayJst', () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it('UTC 15:00 以降は翌日になる', () => {
    expect(todayJst(Date.UTC(2026, 9, 19, 14, 59, 59))).toBe('2026-10-19');
    expect(todayJst(Date.UTC(2026, 9, 19, 15, 0, 0))).toBe('2026-10-20');
  });

  it('引数を省略すると、現在時刻から求める', () => {
    vi.useFakeTimers();
    vi.setSystemTime(Date.UTC(2026, 9, 19, 15, 30, 0));

    expect(todayJst()).toBe('2026-10-20');
  });
});
