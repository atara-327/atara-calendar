import { describe, expect, it } from 'vitest';
import { INPUT_LIMITS } from '../../shared/schema';
import {
  DEFAULT_ALL_DAY_NOTIFY_MIN,
  DEFAULT_TIMED_NOTIFY_MIN,
  TIMED_NOTIFY_RANGE,
  describeAllDayNotify,
  parseNotifyOffset,
} from './notify';

describe('通知の初期値（NT-2・NT-3）', () => {
  it('時間指定は 10 分前、終日は当日の朝 6 時（開始の 0:00 から 360 分後 = -360）', () => {
    expect(DEFAULT_TIMED_NOTIFY_MIN).toBe(10);
    expect(DEFAULT_ALL_DAY_NOTIFY_MIN).toBe(-360);
  });
});

describe('時間指定の「何分前」の入力欄', () => {
  it('入力できる範囲は、0（開始時刻）から、サーバーの入力の検証の上限（10080 分）まで', () => {
    expect(TIMED_NOTIFY_RANGE).toEqual({ min: 0, max: INPUT_LIMITS.notifyOffsetMin.max });
    expect(TIMED_NOTIFY_RANGE.max).toBe(10_080);
  });

  it('整数の文字を、数にする', () => {
    expect(parseNotifyOffset('10')).toBe(10);
    expect(parseNotifyOffset('0')).toBe(0);
    expect(parseNotifyOffset('10080')).toBe(10_080);
    expect(parseNotifyOffset('-30')).toBe(-30);
  });

  it('-0 は 0 にする', () => {
    expect(Object.is(parseNotifyOffset('-0'), 0)).toBe(true);
  });

  it.each(['', '-', '1.5', '10.0', 'abc', '1e2', ' 10', '10 ', '１０', '+5'])(
    '整数でない「%s」は null（入力の途中や、小数・文字を、保存させない）',
    (text) => {
      expect(parseNotifyOffset(text)).toBeNull();
    },
  );
});

describe('終日の通知の時刻の表記', () => {
  it('ふつう（固定の初期値 -360）は「当日 6:00」', () => {
    expect(describeAllDayNotify(DEFAULT_ALL_DAY_NOTIFY_MIN)).toBe('当日 6:00');
  });

  it('API から入れた、別の当日の時刻も表記できる（分は 2 桁）', () => {
    expect(describeAllDayNotify(0)).toBe('当日 0:00');
    expect(describeAllDayNotify(-375)).toBe('当日 6:15');
    expect(describeAllDayNotify(-7)).toBe('当日 0:07');
    expect(describeAllDayNotify(-1425)).toBe('当日 23:45');
  });

  it('前の日・翌日になる値も表記できる（API は -1440〜10080 を受け付ける）', () => {
    expect(describeAllDayNotify(60)).toBe('前日 23:00');
    expect(describeAllDayNotify(1440)).toBe('前日 0:00');
    expect(describeAllDayNotify(10_080)).toBe('7日前 0:00');
    expect(describeAllDayNotify(-1440)).toBe('翌日 0:00');
  });
});
