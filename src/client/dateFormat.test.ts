import { describe, expect, it } from 'vitest';
import {
  WEEKDAY_LABELS,
  formatDayTitle,
  formatMonthDay,
  formatShortDate,
  formatTime,
  formatYear,
} from './dateFormat';

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

describe('年の表記', () => {
  it('「2026年」の形にする', () => {
    expect(formatYear('2026-10-21')).toBe('2026年');
  });

  it('年と、月日・曜日をつなぐと、「2026年10月21日（水）」になる（日表示のヘッダーが、年だけを省けるように）', () => {
    expect(`${formatYear('2026-10-21')}${formatMonthDay('2026-10-21')}`).toBe(
      formatDayTitle('2026-10-21'),
    );
  });
});

describe('月日と曜日の表記', () => {
  it('「10月22日（木）」の形にする（年は付けない）', () => {
    expect(formatMonthDay('2026-10-22')).toBe('10月22日（木）');
  });

  it('月と日は 0 を付けない', () => {
    expect(formatMonthDay('2027-01-01')).toBe('1月1日（金）');
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
