import { describe, expect, it } from 'vitest';
import { dayOfWeek } from '../../shared/date';
import {
  FIRST_WEEK_NUMBER,
  LAST_WEEK_NUMBER,
  WEEK_COUNT,
  clampToRange,
  isInRange,
  rowOfWeek,
  weekDates,
  weekNumberOf,
  weekOfRow,
  weekStartDate,
} from './weeks';

describe('週の番号', () => {
  it('1970-01-04（日曜）の週が 0 番', () => {
    expect(weekNumberOf('1970-01-04')).toBe(0);
    expect(weekStartDate(0)).toBe('1970-01-04');
  });

  it('日曜から土曜までは同じ週で、次の日曜から次の週', () => {
    expect(weekNumberOf('1970-01-10')).toBe(0);
    expect(weekNumberOf('1970-01-11')).toBe(1);
  });

  it('1970-01-04 より前の週は、負の番号になる', () => {
    expect(weekNumberOf('1970-01-03')).toBe(-1);
    expect(weekStartDate(-1)).toBe('1969-12-28');
  });

  it('どの日付も、その週の日曜日から 6 日以内に収まる', () => {
    for (const date of ['1900-01-01', '2000-02-29', '2026-10-21', '2199-12-31']) {
      const start = weekStartDate(weekNumberOf(date));
      expect(dayOfWeek(start)).toBe(0);
      expect(start <= date).toBe(true);
    }
  });

  it('週の 7 日分の日付は、日曜から土曜まで', () => {
    expect(weekDates(weekNumberOf('2026-10-21'))).toEqual([
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

describe('表示できる範囲（1900年1月〜2199年12月）', () => {
  it('最初の週は 1900-01-01（月曜）を含む週で、前の年の 12/31（日曜）から始まる', () => {
    expect(weekStartDate(FIRST_WEEK_NUMBER)).toBe('1899-12-31');
    expect(weekDates(FIRST_WEEK_NUMBER)).toContain('1900-01-01');
  });

  it('最後の週は 2199-12-31 を含む週で、2200 年の 1 月にかかる', () => {
    const dates = weekDates(LAST_WEEK_NUMBER);
    expect(dates).toContain('2199-12-31');
    expect(dates.at(-1)).toBe('2200-01-04');
  });

  it('最初の週より前、最後の週より後の日付は、範囲の外', () => {
    expect(weekNumberOf('1899-12-30')).toBe(FIRST_WEEK_NUMBER - 1);
    expect(weekNumberOf('2200-01-04')).toBe(LAST_WEEK_NUMBER);
    expect(weekNumberOf('2200-01-05')).toBe(LAST_WEEK_NUMBER + 1);
  });

  it('週の数は、最初の週から最後の週までの数', () => {
    expect(WEEK_COUNT).toBe(LAST_WEEK_NUMBER - FIRST_WEEK_NUMBER + 1);
    // 300 年は約 15,652 週。
    expect(WEEK_COUNT).toBeGreaterThan(15_600);
    expect(WEEK_COUNT).toBeLessThan(15_700);
  });

  it('仮想スクロールの行の番号は、最初の週が 0、最後の週が WEEK_COUNT - 1', () => {
    expect(rowOfWeek(FIRST_WEEK_NUMBER)).toBe(0);
    expect(rowOfWeek(LAST_WEEK_NUMBER)).toBe(WEEK_COUNT - 1);
    expect(weekOfRow(0)).toBe(FIRST_WEEK_NUMBER);
    expect(weekOfRow(rowOfWeek(weekNumberOf('2026-10-21')))).toBe(weekNumberOf('2026-10-21'));
  });

  it('範囲の判定は、日付の端（1900-01-01 と 2199-12-31）を含む', () => {
    expect(isInRange('1900-01-01')).toBe(true);
    expect(isInRange('2199-12-31')).toBe(true);
    expect(isInRange('1899-12-31')).toBe(false);
    expect(isInRange('2200-01-01')).toBe(false);
  });

  it('範囲の外にはみ出した日付は、範囲の端に寄せる', () => {
    expect(clampToRange('1899-12-31')).toBe('1900-01-01');
    expect(clampToRange('2200-01-04')).toBe('2199-12-31');
    expect(clampToRange('2026-10-21')).toBe('2026-10-21');
  });
});
