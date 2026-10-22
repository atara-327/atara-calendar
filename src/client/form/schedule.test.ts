import { describe, expect, it } from 'vitest';
import {
  defaultSchedule,
  moveStart,
  nextFullHour,
  toAllDay,
  toTimed,
  validateSchedule,
  type Schedule,
} from './schedule';

// 日本時間 2026-10-22（木）の 14:20（UTC 05:20）。
const AT_1420 = Date.UTC(2026, 9, 22, 5, 20);

function timed(overrides: Partial<Schedule> = {}): Schedule {
  return {
    allDay: false,
    startDate: '2026-10-22',
    startTime: '15:00',
    endDate: '2026-10-22',
    endTime: '16:00',
    ...overrides,
  };
}

function allDay(overrides: Partial<Schedule> = {}): Schedule {
  return timed({ allDay: true, ...overrides });
}

describe('開始の初期値: 今日の、次の正時', () => {
  it('14:20 なら、同じ日の 15:00', () => {
    expect(nextFullHour(AT_1420)).toEqual({ date: '2026-10-22', time: '15:00' });
  });

  it('ちょうど 14:00 のときも、その 1 時間後の 15:00（今より後にする）', () => {
    expect(nextFullHour(Date.UTC(2026, 9, 22, 5, 0))).toEqual({
      date: '2026-10-22',
      time: '15:00',
    });
  });

  it('14:59 でも 15:00', () => {
    expect(nextFullHour(Date.UTC(2026, 9, 22, 5, 59, 59, 999))).toEqual({
      date: '2026-10-22',
      time: '15:00',
    });
  });

  it('23 時台なら、翌日の 0:00', () => {
    // 日本時間 23:20 = UTC 14:20。
    expect(nextFullHour(Date.UTC(2026, 9, 22, 14, 20))).toEqual({
      date: '2026-10-23',
      time: '00:00',
    });
  });

  it('月末の 23 時台なら、翌月 1 日の 0:00', () => {
    expect(nextFullHour(Date.UTC(2026, 9, 31, 14, 30))).toEqual({
      date: '2026-11-01',
      time: '00:00',
    });
  });

  it('今日は、UTC ではなく日本時間で決める（UTC ではまだ 10-22 でも、日本時間は 10-23 の 0:30）', () => {
    expect(nextFullHour(Date.UTC(2026, 9, 22, 15, 30))).toEqual({
      date: '2026-10-23',
      time: '01:00',
    });
  });
});

describe('新しく作るときの開始と終了', () => {
  it('開始は今日の次の正時、終了はその 1 時間後（時間指定）', () => {
    expect(defaultSchedule(AT_1420)).toEqual({
      allDay: false,
      startDate: '2026-10-22',
      startTime: '15:00',
      endDate: '2026-10-22',
      endTime: '16:00',
    });
  });

  it('開始が 23:00 なら、終了は翌日の 0:00', () => {
    // 日本時間 22:10 = UTC 13:10。
    expect(defaultSchedule(Date.UTC(2026, 9, 22, 13, 10))).toMatchObject({
      startDate: '2026-10-22',
      startTime: '23:00',
      endDate: '2026-10-23',
      endTime: '00:00',
    });
  });

  it('23 時台に開くと、翌日の 0:00〜1:00', () => {
    expect(defaultSchedule(Date.UTC(2026, 9, 22, 14, 20))).toMatchObject({
      startDate: '2026-10-23',
      startTime: '00:00',
      endDate: '2026-10-23',
      endTime: '01:00',
    });
  });
});

describe('開始を変えたら、長さを保ったまま終了も動く', () => {
  it('開始の時刻を変えると、終了の時刻も同じだけ動く', () => {
    expect(moveStart(timed(), { startTime: '17:30' })).toMatchObject({
      startTime: '17:30',
      endDate: '2026-10-22',
      endTime: '18:30',
    });
  });

  it('開始の日付を変えると、終了の日付も同じだけ動く（時刻はそのまま）', () => {
    expect(moveStart(timed(), { startDate: '2026-10-25' })).toMatchObject({
      startDate: '2026-10-25',
      endDate: '2026-10-25',
      endTime: '16:00',
    });
  });

  it('終了が日付をまたぐように動くこともある（15:00〜16:00 の開始を 23:00 にすると、終了は翌日 0:00）', () => {
    expect(moveStart(timed(), { startTime: '23:00' })).toMatchObject({
      endDate: '2026-10-23',
      endTime: '00:00',
    });
  });

  it('複数日の長さも保つ', () => {
    const schedule = timed({ startDate: '2026-10-20', endDate: '2026-10-22' });

    expect(moveStart(schedule, { startDate: '2026-10-21' })).toMatchObject({
      endDate: '2026-10-23',
      endTime: '16:00',
    });
  });

  it('終了が開始より前のとき（エラーの状態）も、同じ分だけ動かす', () => {
    const schedule = timed({ startTime: '15:00', endTime: '14:00' });

    expect(moveStart(schedule, { startTime: '16:00' })).toMatchObject({ endTime: '15:00' });
  });

  it('終日は、日数だけ動かす', () => {
    const schedule = allDay({ startDate: '2026-10-20', endDate: '2026-10-22' });

    expect(moveStart(schedule, { startDate: '2026-10-25' })).toMatchObject({
      startDate: '2026-10-25',
      endDate: '2026-10-27',
    });
  });

  it('開始の日付が正しくない（入力の途中）ときは、終了を動かさない', () => {
    expect(moveStart(timed(), { startDate: '' })).toMatchObject({
      startDate: '',
      endDate: '2026-10-22',
    });
  });

  it('元の開始の日付が正しくなかったときも、動かす分が決まらないので、終了を動かさない', () => {
    expect(moveStart(timed({ startDate: '' }), { startDate: '2026-10-25' })).toMatchObject({
      startDate: '2026-10-25',
      endDate: '2026-10-22',
    });
  });

  it('入力の元の値は書き換えない', () => {
    const schedule = timed();
    moveStart(schedule, { startTime: '17:30' });
    expect(schedule).toEqual(timed());
  });
});

describe('終日の切り替え', () => {
  it('時間指定から終日にしても、日付はそのまま（1 日だけなら 1 日のまま）', () => {
    expect(toAllDay(timed())).toMatchObject({
      allDay: true,
      startDate: '2026-10-22',
      endDate: '2026-10-22',
    });
  });

  it('終わりが翌日の 0:00 の時間指定は、終日にしたとき、開始と同じ日の 1 日だけにする（2 日間にしない）', () => {
    const schedule = timed({ startTime: '23:00', endDate: '2026-10-23', endTime: '00:00' });

    expect(toAllDay(schedule)).toMatchObject({ allDay: true, endDate: '2026-10-22' });
  });

  it('複数日の時間指定は、終日にしたとき、終了日までの複数日になる', () => {
    const schedule = timed({ endDate: '2026-10-24' });

    expect(toAllDay(schedule)).toMatchObject({ endDate: '2026-10-24' });
  });

  it('時刻の欄の値は、終日のあいだも持ち続ける（時間指定に戻したとき使う）', () => {
    expect(toAllDay(timed())).toMatchObject({ startTime: '15:00', endTime: '16:00' });
  });

  it('日付が正しくないとき（入力の途中）は、日付を変えずに終日にする', () => {
    expect(toAllDay(timed({ endDate: '' }))).toMatchObject({ allDay: true, endDate: '' });
  });

  it('終日から時間指定に戻すと、持っていた時刻で、終了が開始より後ならそのまま', () => {
    expect(toTimed(allDay())).toMatchObject({
      allDay: false,
      startTime: '15:00',
      endDate: '2026-10-22',
      endTime: '16:00',
    });
  });

  it('時間指定に戻したとき、終了が開始より後にならなければ、開始の 1 時間後にする', () => {
    // 時刻の欄が 23:00〜0:00 のまま、終日（終了日は開始日と同じ）から戻すと、終了が開始より前になる。
    const schedule = allDay({ startTime: '23:00', endTime: '00:00' });

    expect(toTimed(schedule)).toMatchObject({ endDate: '2026-10-23', endTime: '00:00' });
  });

  it('複数日の終日から戻すと、終了の日付はそのまま', () => {
    expect(toTimed(allDay({ endDate: '2026-10-24' }))).toMatchObject({ endDate: '2026-10-24' });
  });
});

describe('開始・終了のエラー', () => {
  it('正しい時間指定は、エラーがない', () => {
    expect(validateSchedule(timed())).toEqual({});
  });

  it('時間指定は、終了が開始と同じ日時だとエラー', () => {
    expect(validateSchedule(timed({ endTime: '15:00' })).range).toBeDefined();
  });

  it('時間指定は、終了が開始より前だとエラー（同じ日）', () => {
    expect(validateSchedule(timed({ endTime: '14:45' })).range).toBeDefined();
  });

  it('時間指定は、終了の日付が開始の日付より前だとエラー', () => {
    expect(validateSchedule(timed({ endDate: '2026-10-21' })).range).toBeDefined();
  });

  it('日付をまたぐ時間指定（23:00〜翌 7:00。TB-6）は、終了の日付を翌日にすれば、エラーがない', () => {
    const schedule = timed({ startTime: '23:00', endDate: '2026-10-23', endTime: '07:00' });

    expect(validateSchedule(schedule)).toEqual({});
  });

  it('終日は、終了日が開始日と同じでもよい（1 日だけの予定）', () => {
    expect(validateSchedule(allDay())).toEqual({});
  });

  it('終日は、終了日が開始日より前だとエラー', () => {
    expect(validateSchedule(allDay({ endDate: '2026-10-21' })).range).toBeDefined();
  });

  it('終日のとき、時刻の欄の値は見ない（時刻が、終了を開始より前にしていてもエラーにしない）', () => {
    expect(validateSchedule(allDay({ startTime: '23:00', endTime: '00:00' }))).toEqual({});
  });

  it('日付が空なら、その欄のエラー（前後の確認はしない）', () => {
    expect(validateSchedule(timed({ startDate: '' }))).toEqual({
      startDate: expect.any(String) as string,
    });
    expect(validateSchedule(timed({ endDate: '' }))).toEqual({
      endDate: expect.any(String) as string,
    });
  });

  it('日付が範囲（1900〜2199 年）の外ならエラー', () => {
    expect(validateSchedule(timed({ startDate: '1899-12-31' })).startDate).toBeDefined();
    expect(validateSchedule(timed({ endDate: '2200-01-01' })).endDate).toBeDefined();
  });

  it('範囲の端（1900-01-01 と 2199-12-31）は通る', () => {
    expect(validateSchedule(allDay({ startDate: '1900-01-01', endDate: '1900-01-01' }))).toEqual(
      {},
    );
    expect(validateSchedule(allDay({ startDate: '2199-12-31', endDate: '2199-12-31' }))).toEqual(
      {},
    );
  });
});
