import { describe, expect, it } from 'vitest';
import { addDays, dayOfWeek, type DateStr } from '../../shared/date';
import { cellBoundary } from './boundaries';

describe('階段状の線を引くマス', () => {
  it('各月の 1 日のマスは、左側と上側に月の境目の線を持つ', () => {
    // 2026-10-01 は木曜日。
    expect(cellBoundary('2026-10-01')).toEqual({ top: 'month', left: 'month' });
  });

  it('日曜日の 1 日は、行の左端で、左に隣のマスがないので、上側にだけ線を持つ', () => {
    // 2026-11-01 は日曜日。
    expect(cellBoundary('2026-11-01')).toEqual({ top: 'month', left: 'none' });
  });

  it('各月の 2〜7 日のマスは、上側にだけ月の境目の線を持つ', () => {
    for (const day of ['02', '03', '04', '05', '06', '07']) {
      expect(cellBoundary(`2026-10-${day}`)).toEqual({ top: 'month', left: 'none' });
    }
  });

  it('各月の 8 日以降のマスは、境目の線を持たない', () => {
    expect(cellBoundary('2026-10-08')).toEqual({ top: 'none', left: 'none' });
    expect(cellBoundary('2026-10-31')).toEqual({ top: 'none', left: 'none' });
  });

  it('1 月の 1 日のマスは、年の境目の太い線を持つ', () => {
    // 2027-01-01 は金曜日。
    expect(cellBoundary('2027-01-01')).toEqual({ top: 'year', left: 'year' });
  });

  it('日曜日の 1 月 1 日は、上側にだけ年の境目の線を持つ', () => {
    // 2023-01-01 は日曜日。
    expect(cellBoundary('2023-01-01')).toEqual({ top: 'year', left: 'none' });
  });

  it('1 月の 2〜7 日のマスは、上側に年の境目の線を持つ', () => {
    expect(cellBoundary('2027-01-02')).toEqual({ top: 'year', left: 'none' });
    expect(cellBoundary('2027-01-07')).toEqual({ top: 'year', left: 'none' });
    expect(cellBoundary('2027-01-08')).toEqual({ top: 'none', left: 'none' });
  });

  it('12 月の最終日は、線を持たない（線は次の月の側が持つ）', () => {
    expect(cellBoundary('2026-12-31')).toEqual({ top: 'none', left: 'none' });
  });

  // 階段が途切れないことの確認。1 日の曜日がどれでも、1 日から数えて 7 マスぶんの上側の線と、
  // 1 日の左側の線で、前の月のマスと接する辺がすべて線になる。
  describe('前の月のマスと接する辺は、すべて線になる', () => {
    function neighbors(date: DateStr): { above: DateStr; left: DateStr | null } {
      return { above: addDays(date, -7), left: dayOfWeek(date) === 0 ? null : addDays(date, -1) };
    }

    it.each(['2026-02-01', '2026-03-01', '2026-10-01', '2027-01-01', '2026-08-01', '2026-11-01'])(
      '%s から始まる月（1 日の曜日が違っても）',
      (first) => {
        const month = first.slice(0, 7);
        for (let offset = 0; offset < 31; offset++) {
          const date = addDays(first, offset);
          if (!date.startsWith(month)) break;
          const { above, left } = neighbors(date);
          const boundary = cellBoundary(date);
          // 上のマスが前の月なら、上側に線がある。
          expect(above.startsWith(month) || boundary.top !== 'none').toBe(true);
          // 左のマスが前の月なら、左側に線がある。
          if (left !== null) expect(left.startsWith(month) || boundary.left !== 'none').toBe(true);
          // 逆に、上のマスも左のマスも同じ月なら、線はない（余計な線を引かない）。
          if (above.startsWith(month)) expect(boundary.top).toBe('none');
          if (left?.startsWith(month)) expect(boundary.left).toBe('none');
        }
      },
    );
  });
});
