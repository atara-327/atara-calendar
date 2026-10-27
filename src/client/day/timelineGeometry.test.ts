import { describe, expect, it } from 'vitest';
import {
  DAY_HEIGHT,
  FALLBACK_TOP_MINUTE,
  HOUR_LABELS,
  initialTopMinute,
  minutesToTime,
  tapStartTime,
} from './timelineGeometry';

const h = (hour: number, minute = 0) => hour * 60 + minute;

describe('タイムラインの大きさ', () => {
  it('0:00〜24:00 で、1 時間 60px（合計 1440px）', () => {
    expect(DAY_HEIGHT).toBe(1440);
  });

  it('目盛りは「0:00」から「23:00」まで、1 時間ごと', () => {
    expect(HOUR_LABELS).toHaveLength(24);
    expect(HOUR_LABELS[0]).toBe('0:00');
    expect(HOUR_LABELS[9]).toBe('9:00');
    expect(HOUR_LABELS[23]).toBe('23:00');
  });
});

describe('最初に表示する位置（設計書 11.3）', () => {
  it('今日は、今の時刻の 1 時間前（14:20 なら 13:20）。項目の有無は関係ない', () => {
    expect(initialTopMinute({ isToday: true, nowMinute: h(14, 20), firstItemStart: h(9) })).toBe(
      h(13, 20),
    );
    expect(initialTopMinute({ isToday: true, nowMinute: h(14, 20), firstItemStart: null })).toBe(
      h(13, 20),
    );
  });

  it('今日の 0:30 のように、1 時間前が前の日になるときは、0:00', () => {
    expect(initialTopMinute({ isToday: true, nowMinute: h(0, 30), firstItemStart: null })).toBe(0);
  });

  it('他の日は、タイムラインの最初の項目の開始', () => {
    expect(
      initialTopMinute({ isToday: false, nowMinute: h(14, 20), firstItemStart: h(9, 30) }),
    ).toBe(h(9, 30));
  });

  it('他の日で、前の日から続く項目があれば（開始が 0:00）、0:00', () => {
    expect(initialTopMinute({ isToday: false, nowMinute: h(14, 20), firstItemStart: 0 })).toBe(0);
  });

  it('他の日で、タイムラインに項目がなければ、8:00', () => {
    expect(initialTopMinute({ isToday: false, nowMinute: h(14, 20), firstItemStart: null })).toBe(
      FALLBACK_TOP_MINUTE,
    );
    expect(FALLBACK_TOP_MINUTE).toBe(h(8));
  });
});

describe('空いているところをタップしたときの、開始の時刻', () => {
  it('タイムラインの上端は 0:00', () => {
    expect(tapStartTime(0)).toBe('00:00');
  });

  it('15 分単位に切り下げる（8:59 のあたりは 8:45）', () => {
    expect(tapStartTime(h(8, 59))).toBe('08:45');
    expect(tapStartTime(h(9, 14))).toBe('09:00');
    expect(tapStartTime(h(9, 15))).toBe('09:15');
  });

  it('1 時間 60px なので、距離（px）は、分と同じ', () => {
    expect(tapStartTime(540)).toBe('09:00');
  });

  it('端数のある距離（小数の px）も、切り下げる', () => {
    expect(tapStartTime(h(9, 14) + 0.9)).toBe('09:00');
  });

  it('23:30 のあたりは 23:30（日をまたぐ 1 時間のブロックにしてよい）', () => {
    expect(tapStartTime(h(23, 30))).toBe('23:30');
    expect(tapStartTime(h(23, 59))).toBe('23:45');
  });

  it('範囲の外は、端に寄せる（上端より上は 0:00、下端より下は 23:45）', () => {
    expect(tapStartTime(-20)).toBe('00:00');
    expect(tapStartTime(1440)).toBe('23:45');
    expect(tapStartTime(2000)).toBe('23:45');
  });
});

describe('分から時刻', () => {
  it('0 を付けた 2 桁の時と分にする', () => {
    expect(minutesToTime(h(9, 5))).toBe('09:05');
    expect(minutesToTime(0)).toBe('00:00');
    expect(minutesToTime(h(23, 45))).toBe('23:45');
  });
});
