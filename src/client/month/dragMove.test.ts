import { describe, expect, it } from 'vitest';
import { dayShift, movedDates } from './dragMove';

describe('ドラッグで日付を移す（EV-6）', () => {
  it('EV-6: 押したマスと離したマスの差の日数だけ、ずらす（週をまたいでも、月をまたいでも）', () => {
    expect(dayShift('2026-10-19', '2026-10-22')).toBe(3);
    expect(dayShift('2026-10-31', '2026-10-25')).toBe(-6);
    expect(dayShift('2026-10-28', '2026-11-04')).toBe(7);
    expect(dayShift('2026-10-19', '2026-10-19')).toBe(0);
  });

  it('EV-6: 開始日と終了日を、同じ日数だけずらす', () => {
    expect(movedDates({ startDate: '2026-10-19', endDate: '2026-10-21' }, 3)).toEqual({
      startDate: '2026-10-22',
      endDate: '2026-10-24',
    });
    expect(movedDates({ startDate: '2026-10-19', endDate: '2026-10-19' }, -1)).toEqual({
      startDate: '2026-10-18',
      endDate: '2026-10-18',
    });
  });

  it('EV-6: 同じ日に離したら、何もしない', () => {
    expect(movedDates({ startDate: '2026-10-19', endDate: '2026-10-21' }, 0)).toBeNull();
  });

  it('EV-6: 範囲（1900〜2199 年）の外へは動かせない', () => {
    expect(movedDates({ startDate: '1900-01-02', endDate: '1900-01-03' }, -1)).not.toBeNull();
    expect(movedDates({ startDate: '1900-01-01', endDate: '1900-01-03' }, -1)).toBeNull();
    expect(movedDates({ startDate: '2199-12-30', endDate: '2199-12-31' }, 1)).toBeNull();
    expect(movedDates({ startDate: '2199-12-29', endDate: '2199-12-30' }, 1)).not.toBeNull();
  });
});
