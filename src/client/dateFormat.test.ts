import { describe, expect, it } from 'vitest';
import { WEEKDAY_LABELS, formatDayTitle } from './dateFormat';

describe('日付の表記', () => {
  it('「2026年10月21日（水）」の形にする', () => {
    expect(formatDayTitle('2026-10-21')).toBe('2026年10月21日（水）');
  });

  it('月と日は 0 を付けない', () => {
    expect(formatDayTitle('2027-01-01')).toBe('2027年1月1日（金）');
  });

  it('曜日は日曜から土曜の順で、日曜始まりの週と同じ並び', () => {
    expect(WEEKDAY_LABELS).toEqual(['日', '月', '火', '水', '木', '金', '土']);
    expect(formatDayTitle('2026-10-18')).toContain('（日）');
    expect(formatDayTitle('2026-10-24')).toContain('（土）');
  });
});
