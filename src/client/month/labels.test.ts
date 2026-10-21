import { describe, expect, it } from 'vitest';
import { dayLabel, dayLabelParts, headerTitle } from './labels';
import { FIRST_WEEK_NUMBER, LAST_WEEK_NUMBER, weekNumberOf } from './weeks';

describe('固定ヘッダーの年月', () => {
  it('いちばん上に見えている週の、水曜日の年月を出す', () => {
    // 2026-10-25（日）〜 10-31（土）の週。水曜日は 10-28。
    expect(headerTitle(weekNumberOf('2026-10-25'))).toBe('2026年10月');
  });

  it('週が月をまたぐときは、水曜日が属する月にする（前の月が 4 日以上を占める週）', () => {
    // 2026-09-27（日）〜 10-03（土）。水曜日は 9-30 なので 9 月。
    expect(headerTitle(weekNumberOf('2026-10-01'))).toBe('2026年9月');
  });

  it('週が月をまたぐときは、水曜日が属する月にする（次の月が 4 日以上を占める週）', () => {
    // 2026-10-25（日）〜 10-31 は同じ月。2026-11-01 は日曜で、その週の水曜日は 11-04。
    expect(headerTitle(weekNumberOf('2026-11-01'))).toBe('2026年11月');
    // 2026-04-26（日）〜 05-02（土）。水曜日は 4-29。
    expect(headerTitle(weekNumberOf('2026-05-01'))).toBe('2026年4月');
    // 2026-05-31（日）〜 06-06（土）。水曜日は 6-03。
    expect(headerTitle(weekNumberOf('2026-05-31'))).toBe('2026年6月');
  });

  it('年をまたぐ週は、水曜日の年を出す', () => {
    // 2026-12-27（日）〜 2027-01-02（土）。水曜日は 12-30。
    expect(headerTitle(weekNumberOf('2027-01-01'))).toBe('2026年12月');
    // 2027-01-03（日）〜 01-09。水曜日は 01-06。
    expect(headerTitle(weekNumberOf('2027-01-03'))).toBe('2027年1月');
  });

  it('範囲の端の週も、水曜日の年月を出す', () => {
    // 最初の週は 1899-12-31（日）から始まり、水曜日は 1900-01-03。
    expect(headerTitle(FIRST_WEEK_NUMBER)).toBe('1900年1月');
    // 最後の週は 2199-12-29（日）から始まり、水曜日は 2200-01-01。
    expect(headerTitle(LAST_WEEK_NUMBER)).toBe('2200年1月');
  });
});

describe('1 日のラベル', () => {
  it('各月の 1 日には「10月」のようなラベルを付ける', () => {
    expect(dayLabel('2026-10-01')).toBe('10月');
    expect(dayLabel('2026-02-01')).toBe('2月');
    expect(dayLabel('2026-12-01')).toBe('12月');
  });

  it('1 月 1 日は、年も付けて「2027年1月」にする', () => {
    expect(dayLabel('2027-01-01')).toBe('2027年1月');
  });

  it('1 日以外にはラベルを付けない', () => {
    expect(dayLabel('2026-10-02')).toBeNull();
    expect(dayLabel('2026-10-31')).toBeNull();
    expect(dayLabel('2027-01-02')).toBeNull();
  });
});

describe('1 日のラベルの部品', () => {
  it('1 月 1 日は、年の部分と月の部分に分かれる（幅の狭い画面で、年だけ省けるように）', () => {
    expect(dayLabelParts('2027-01-01')).toEqual({ year: '2027年', month: '1月' });
  });

  it('1 月以外の 1 日は、年の部分がない', () => {
    expect(dayLabelParts('2026-10-01')).toEqual({ year: null, month: '10月' });
  });

  it('1 日以外は null', () => {
    expect(dayLabelParts('2026-10-02')).toBeNull();
  });

  it('範囲（1900〜2199 年）の外の 1 日は null（最後の週にはみ出した 2200-01-01 に「2200年1月」を付けない）', () => {
    expect(dayLabelParts('2200-01-01')).toBeNull();
    expect(dayLabelParts('1900-01-01')).toEqual({ year: '1900年', month: '1月' });
  });
});
