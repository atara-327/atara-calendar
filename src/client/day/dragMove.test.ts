import { describe, expect, it } from 'vitest';
import { movedTimes, snapMoveMinutes } from './dragMove';
import { PX_PER_MINUTE } from './timelineGeometry';

describe('ドラッグで時刻を移す（EV-6）: ずらす量', () => {
  it('EV-6: 動かした距離は、15 分刻みに丸める', () => {
    expect(snapMoveMinutes(7 * PX_PER_MINUTE, 600, 660)).toBe(0);
    expect(snapMoveMinutes(8 * PX_PER_MINUTE, 600, 660)).toBe(15);
    expect(snapMoveMinutes(-23 * PX_PER_MINUTE, 600, 660)).toBe(-30);
  });

  it('EV-6: 開始と終了を同じ分だけずらし、端数の分は残す（10:07 を 15 分下げると 10:22）', () => {
    expect(movedTimes(10 * 60 + 7, 11 * 60 + 7, 15)).toEqual({
      startTime: '10:22',
      endTime: '11:22',
    });
  });

  it('EV-6: その日の 0:00 より前には動かせず、端で止まる', () => {
    expect(snapMoveMinutes(-500 * PX_PER_MINUTE, 30, 90)).toBe(-30);
    expect(snapMoveMinutes(-500 * PX_PER_MINUTE, 7, 67)).toBe(0);
  });

  it('EV-6: その日の終わり（23:59）より後ろには動かせず、端で止まる', () => {
    expect(snapMoveMinutes(500 * PX_PER_MINUTE, 22 * 60, 23 * 60)).toBe(45);
    expect(snapMoveMinutes(500 * PX_PER_MINUTE, 23 * 60 + 30, 23 * 60 + 59)).toBe(0);
  });
});
