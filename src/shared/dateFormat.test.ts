import { describe, expect, it } from 'vitest';
import { WEEKDAY_LABELS, formatShortDate, formatTime } from './dateFormat';

describe('曜日の表記', () => {
  it('日曜から土曜の順で、1 文字', () => {
    expect(WEEKDAY_LABELS).toEqual(['日', '月', '火', '水', '木', '金', '土']);
  });
});

describe('月日だけの表記', () => {
  it('「10/19」の形にする（年と曜日は付けない）', () => {
    expect(formatShortDate('2026-10-19')).toBe('10/19');
  });

  it('月と日は 0 を付けない', () => {
    expect(formatShortDate('2027-01-05')).toBe('1/5');
  });
});

describe('時刻の表記', () => {
  it('時の 0 を付けず、「9:00」の形にする', () => {
    expect(formatTime('09:00')).toBe('9:00');
    expect(formatTime('00:15')).toBe('0:15');
  });

  it('2 桁の時は、そのまま', () => {
    expect(formatTime('18:45')).toBe('18:45');
    expect(formatTime('23:00')).toBe('23:00');
  });
});
