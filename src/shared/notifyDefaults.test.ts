import { describe, expect, it } from 'vitest';
import {
  DEFAULT_ALL_DAY_NOTIFY_MIN,
  DEFAULT_TIMED_NOTIFY_MIN,
  defaultNotify,
} from './notifyDefaults';

describe('通知の初期値（NT-2・NT-3）', () => {
  it('時間指定は 10 分前、終日は当日の朝 6 時（開始の 0:00 から 360 分後 = -360）', () => {
    expect(DEFAULT_TIMED_NOTIFY_MIN).toBe(10);
    expect(DEFAULT_ALL_DAY_NOTIFY_MIN).toBe(-360);
  });
});

describe('通知の初期値（NT-4）', () => {
  it('予定は ON。時間指定は 10 分前', () => {
    expect(defaultNotify('event', false)).toEqual({ notifyEnabled: true, notifyOffsetMin: 10 });
  });

  it('終日の予定は ON。当日の朝 6 時（-360）', () => {
    expect(defaultNotify('event', true)).toEqual({ notifyEnabled: true, notifyOffsetMin: -360 });
  });

  it('タイムブロックは OFF。ON にしたときの初期のタイミングは 10 分前', () => {
    expect(defaultNotify('block', false)).toEqual({ notifyEnabled: false, notifyOffsetMin: 10 });
  });
});
