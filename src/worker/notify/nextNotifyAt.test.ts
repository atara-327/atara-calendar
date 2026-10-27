import { describe, expect, it } from 'vitest';
import type { Entry } from '../../shared/schema';
import { deepFreeze, makeEntry } from '../../../test/helpers/entries';
import { jst } from '../../../test/helpers/time';
import { nextNotifyTimes, notifyAtMs } from './nextNotifyAt';

/** 時間指定の予定（15:00〜16:00、10 分前に通知）。繰り返さない。 */
function timed(overrides: Partial<Entry> & Pick<Entry, 'id'>): Entry {
  return makeEntry({
    allDay: false,
    startTime: '15:00',
    endTime: '16:00',
    notifyOffsetMin: 10,
    ...overrides,
  });
}

/** 終日の予定（当日の朝 6 時 = -360 に通知）。繰り返さない。 */
function allDay(overrides: Partial<Entry> & Pick<Entry, 'id'>): Entry {
  return makeEntry({ allDay: true, notifyOffsetMin: -360, ...overrides });
}

/** 系列 's' の、例外の行。例外は 1 回だけの行で、ルールを持たない。 */
function exception(overrides: Partial<Entry> & Pick<Entry, 'id' | 'originalDate'>): Entry {
  return timed({ seriesId: 's', rrule: null, ...overrides });
}

/** 1 行だけの family の、その行の次の通知の時刻。 */
function nextOf(row: Entry, afterMs: number): number | null | undefined {
  return nextNotifyTimes({ family: [row], afterMs }).get(row.id);
}

describe('notifyAtMs（1 回の通知の時刻 = 開始 − 通知の分）', () => {
  it.each([
    {
      name: '時間指定: 15:00 の 10 分前は 14:50',
      fields: { startTime: '15:00', offset: 10 },
      expected: jst('2026-10-19', '14:50'),
    },
    {
      name: '通知の分が 0 なら、開始ちょうど',
      fields: { startTime: '15:00', offset: 0 },
      expected: jst('2026-10-19', '15:00'),
    },
    {
      name: '10080 分（1 週間）前は、7 日前の同じ時刻',
      fields: { startTime: '15:00', offset: 10_080 },
      expected: jst('2026-10-12', '15:00'),
    },
    {
      name: '開始が 0:05 で 10 分前なら、前の日の 23:55',
      fields: { startTime: '00:05', offset: 10 },
      expected: jst('2026-10-18', '23:55'),
    },
    {
      name: '負の値は、開始より後。時間指定の -1440 は、翌日の同じ時刻',
      fields: { startTime: '15:00', offset: -1440 },
      expected: jst('2026-10-20', '15:00'),
    },
  ])('$name', ({ fields, expected }) => {
    expect(
      notifyAtMs({
        allDay: false,
        startDate: '2026-10-19',
        startTime: fields.startTime,
        notifyOffsetMin: fields.offset,
      }),
    ).toBe(expected);
  });

  it.each([
    { offset: -360, expected: jst('2026-10-19', '06:00') },
    { offset: 0, expected: jst('2026-10-19', '00:00') },
    { offset: -1440, expected: jst('2026-10-20', '00:00') },
    { offset: 60, expected: jst('2026-10-18', '23:00') },
  ])(
    '終日は、開始日の 0:00 を開始とみなす。通知の分 $offset は、日本時間の $expected',
    ({ offset, expected }) => {
      expect(
        notifyAtMs({
          allDay: true,
          startDate: '2026-10-19',
          startTime: null,
          notifyOffsetMin: offset,
        }),
      ).toBe(expected);
    },
  );

  it('日本時間で求める（日本時間の 6:00 は、UTC では前の日の 21:00）', () => {
    expect(
      notifyAtMs({ allDay: true, startDate: '2026-10-19', startTime: null, notifyOffsetMin: -360 }),
    ).toBe(Date.UTC(2026, 9, 18, 21, 0));
  });
});

describe('NT-2〜4: nextNotifyTimes（繰り返さない予定）', () => {
  const after = jst('2026-10-19', '09:00');

  it('NT-2: 時間指定の予定は、開始の 10 分前', () => {
    expect(nextOf(timed({ id: 'e', startDate: '2026-10-19' }), after)).toBe(
      jst('2026-10-19', '14:50'),
    );
  });

  it('NT-3: 終日の予定は、-360 なら、当日の朝 6 時', () => {
    expect(nextOf(allDay({ id: 'e', startDate: '2026-10-20' }), after)).toBe(
      jst('2026-10-20', '06:00'),
    );
  });

  it('終日の予定の通知の分が 0 なら、当日の 0:00', () => {
    expect(nextOf(allDay({ id: 'e', startDate: '2026-10-20', notifyOffsetMin: 0 }), after)).toBe(
      jst('2026-10-20', '00:00'),
    );
  });

  it('終日の予定の通知の分が -1440 なら、翌日の 0:00（開始の 1 日後）', () => {
    expect(
      nextOf(allDay({ id: 'e', startDate: '2026-10-20', notifyOffsetMin: -1440 }), after),
    ).toBe(jst('2026-10-21', '00:00'));
  });

  it('通知の分が 10080 なら、1 週間前', () => {
    expect(
      nextOf(timed({ id: 'e', startDate: '2026-10-26', notifyOffsetMin: 10_080 }), after),
    ).toBe(jst('2026-10-19', '15:00'));
  });

  it('NT-4: 通知が OFF なら、null', () => {
    expect(
      nextOf(timed({ id: 'e', startDate: '2026-10-20', notifyEnabled: false }), after),
    ).toBeNull();
  });

  it('通知の時刻が、afterMs より前（過ぎている）なら、null', () => {
    expect(
      nextOf(timed({ id: 'e', startDate: '2026-10-19', startTime: '08:30' }), after),
    ).toBeNull();
  });

  it('通知の時刻が、afterMs とちょうど同じなら、null（afterMs より後だけを数える）', () => {
    const entry = timed({ id: 'e', startDate: '2026-10-19', startTime: '15:00' });

    expect(nextOf(entry, jst('2026-10-19', '14:50'))).toBeNull();
    expect(nextOf(entry, jst('2026-10-19', '14:50') - 1)).toBe(jst('2026-10-19', '14:50'));
  });

  it('遠い先の予定でも、その行の通知の時刻を返す（探す範囲は、繰り返しの系列だけの決まり）', () => {
    expect(nextOf(timed({ id: 'e', startDate: '2090-05-01' }), after)).toBe(
      jst('2090-05-01', '14:50'),
    );
  });

  it('NT-4・TB-1: タイムブロックは、通知が ON なら、予定と同じ式で求める。OFF（タイムブロックの初期値）なら null', () => {
    const block = timed({ id: 'b', kind: 'block', workspaceId: null, startDate: '2026-10-19' });

    expect(nextOf({ ...block, notifyEnabled: true }, after)).toBe(jst('2026-10-19', '14:50'));
    expect(nextOf({ ...block, notifyEnabled: false }, after)).toBeNull();
  });

  it('削除された行は、結果に入れない', () => {
    const live = timed({ id: 'live', startDate: '2026-10-20' });
    const deleted = timed({ id: 'gone', startDate: '2026-10-20', deletedAt: 5000 });

    const result = nextNotifyTimes({ family: [live, deleted], afterMs: after });

    expect([...result.keys()]).toEqual(['live']);
  });

  it('入力の行を書き換えない', () => {
    const family = deepFreeze([
      timed({ id: 's', rrule: { freq: 'daily' }, startDate: '2026-10-19' }),
      exception({ id: 'x', originalDate: '2026-10-21', startDate: '2026-10-22' }),
    ]);

    expect(() => nextNotifyTimes({ family, afterMs: after })).not.toThrow();
  });
});

describe('RP-1〜6: nextNotifyTimes（繰り返しの系列）', () => {
  // 2026-10-19 は月曜。
  const daily = timed({ id: 's', rrule: { freq: 'daily' }, startDate: '2026-10-19' });
  const nextOfSeries = (family: Entry[], afterMs: number) =>
    nextNotifyTimes({ family, afterMs }).get('s');

  describe('毎日', () => {
    it('今日の通知がまだなら、今日の回', () => {
      expect(nextOfSeries([daily], jst('2026-10-27', '09:00'))).toBe(jst('2026-10-27', '14:50'));
    });

    it('今日の通知が過ぎていたら、翌日の回', () => {
      expect(nextOfSeries([daily], jst('2026-10-27', '15:00'))).toBe(jst('2026-10-28', '14:50'));
    });

    it('afterMs が、通知の時刻とちょうど同じなら、その回は数えず、次の回', () => {
      expect(nextOfSeries([daily], jst('2026-10-27', '14:50'))).toBe(jst('2026-10-28', '14:50'));
    });

    it('開始日より前なら、最初の回', () => {
      expect(nextOfSeries([daily], jst('2026-10-01', '09:00'))).toBe(jst('2026-10-19', '14:50'));
    });

    it('終日の毎日（-360）は、次の朝 6 時', () => {
      const series = allDay({ id: 's', rrule: { freq: 'daily' }, startDate: '2026-10-19' });

      expect(nextOfSeries([series], jst('2026-10-27', '09:00'))).toBe(jst('2026-10-28', '06:00'));
    });

    it('終日で通知の分が -1440 なら、昨日の回の通知（今日の 0:00）が、まだなら、それを返す', () => {
      const series = allDay({
        id: 's',
        rrule: { freq: 'daily' },
        startDate: '2026-10-19',
        notifyOffsetMin: -1440,
      });

      // 10/26 の回は、10/27 の 0:00 に通知する。10/26 23:00 の時点では、まだ先。
      expect(nextOfSeries([series], jst('2026-10-26', '23:00'))).toBe(jst('2026-10-27', '00:00'));
      expect(nextOfSeries([series], jst('2026-10-27', '00:00'))).toBe(jst('2026-10-28', '00:00'));
    });

    it('開始の 1 日後に通知する回（-1440）は、昨日の日付の回でも、今日の通知が残っていれば返す', () => {
      const series = timed({
        id: 's',
        rrule: { freq: 'daily' },
        startDate: '2026-10-19',
        startTime: '23:30',
        notifyOffsetMin: -1440,
      });

      // 10/26 23:30 の回は、10/27 23:30 に通知する。10/27 の朝 5 時の時点では、まだ先。
      expect(nextOfSeries([series], jst('2026-10-27', '05:00'))).toBe(jst('2026-10-27', '23:30'));
    });

    it('通知が OFF なら、null', () => {
      expect(
        nextOfSeries([{ ...daily, notifyEnabled: false }], jst('2026-10-27', '09:00')),
      ).toBeNull();
    });
  });

  describe('毎週・毎月・毎年', () => {
    it('毎週 月・水・金: 水曜の通知が過ぎたら、金曜', () => {
      const series = timed({
        id: 's',
        rrule: { freq: 'weekly', days: [1, 3, 5] },
        startDate: '2026-10-19',
      });

      expect(nextOfSeries([series], jst('2026-10-21', '15:00'))).toBe(jst('2026-10-23', '14:50'));
    });

    it('毎月 31 日: 30 日までの月は飛ばして、次に 31 日がある月の回（最初の 62 日で見つからなくても、先へ広げる）', () => {
      const series = timed({
        id: 's',
        rrule: { freq: 'monthly' },
        startDate: '2026-01-31',
      });

      expect(nextOfSeries([series], jst('2026-10-31', '15:00'))).toBe(jst('2026-12-31', '14:50'));
    });

    it('毎年: 来年の同じ日', () => {
      const series = timed({ id: 's', rrule: { freq: 'yearly' }, startDate: '2020-10-19' });

      expect(nextOfSeries([series], jst('2026-10-27', '09:00'))).toBe(jst('2027-10-19', '14:50'));
    });
  });

  describe('毎年の 2/29（Q9: うるう年だけ。次の回は最大 8 年先）', () => {
    const leapDay = allDay({ id: 's', rrule: { freq: 'yearly' }, startDate: '2096-02-29' });

    it('2097 年からなら、2100 年（うるう年でない）を飛ばして、2104 年の 2/29', () => {
      expect(nextOfSeries([leapDay], jst('2097-01-01', '00:00'))).toBe(jst('2104-02-29', '06:00'));
    });

    it('2096-02-29 の回が過ぎた直後なら、7 年 11 か月先の 2104 年の 2/29 まで探す', () => {
      expect(nextOfSeries([leapDay], jst('2096-03-01', '00:00'))).toBe(jst('2104-02-29', '06:00'));
    });
  });

  describe('探す範囲は、探し始め（afterMs の日付の 2 日前と、系列の開始日の、遅い方）から 9 年まで', () => {
    it('開始日が 9 年より先の系列も、開始日の最初の回が見つかる（毎年）', () => {
      const series = allDay({ id: 's', rrule: { freq: 'yearly' }, startDate: '2036-04-01' });

      expect(nextOfSeries([series], jst('2026-10-27', '09:00'))).toBe(jst('2036-04-01', '06:00'));
    });

    it('開始日が 9 年より先の系列も、開始日の最初の回が見つかる（毎日・開始日が 9 年と 1 日後）', () => {
      const series = allDay({ id: 's', rrule: { freq: 'daily' }, startDate: '2035-10-28' });

      expect(nextOfSeries([series], jst('2026-10-27', '09:00'))).toBe(jst('2035-10-28', '06:00'));
    });

    it('開始日が遠い先の、毎年の 2/29 は、開始日の最初の回が見つかる（うるう年の開始日）', () => {
      const series = allDay({ id: 's', rrule: { freq: 'yearly' }, startDate: '2096-02-29' });

      expect(nextOfSeries([series], jst('2026-10-27', '09:00'))).toBe(jst('2096-02-29', '06:00'));
    });

    it('開始日が遠い先の、毎週・平日の系列も、開始日以降の最初の回が見つかる', () => {
      // 2040-01-02 と 2040-02-06 は月曜。
      const weekly = allDay({
        id: 's',
        rrule: { freq: 'weekly', days: [1] },
        startDate: '2040-01-02',
      });
      const weekday = allDay({ id: 's', rrule: { freq: 'weekday' }, startDate: '2040-02-06' });

      expect(nextOfSeries([weekly], jst('2026-10-27', '09:00'))).toBe(jst('2040-01-02', '06:00'));
      expect(nextOfSeries([weekday], jst('2026-10-27', '09:00'))).toBe(jst('2040-02-06', '06:00'));
    });

    it('開始日が過去なら、これまでどおり、afterMs の後の最初の回（開始日からは探さない）', () => {
      const series = allDay({ id: 's', rrule: { freq: 'yearly' }, startDate: '2020-04-01' });

      expect(nextOfSeries([series], jst('2026-10-27', '09:00'))).toBe(jst('2027-04-01', '06:00'));
    });
  });

  describe('後ろを切った系列（untilDate）', () => {
    const cut = { ...daily, untilDate: '2026-10-27' };

    it('untilDate の回の通知がまだなら、その回', () => {
      expect(nextOfSeries([cut], jst('2026-10-27', '09:00'))).toBe(jst('2026-10-27', '14:50'));
    });

    it('untilDate を過ぎたら、null', () => {
      expect(nextOfSeries([cut], jst('2026-10-27', '15:00'))).toBeNull();
    });
  });

  describe('RP-5: 平日・休日（祝日の計算は、祝日の一覧と同じもの）', () => {
    // 2026-10-23 は金曜。10/24 は土曜、10/25 は日曜。11/3（火）は文化の日。
    it('平日: 金曜の通知が過ぎたら、土日を飛ばして月曜', () => {
      const series = timed({ id: 's', rrule: { freq: 'weekday' }, startDate: '2026-10-19' });

      expect(nextOfSeries([series], jst('2026-10-23', '15:00'))).toBe(jst('2026-10-26', '14:50'));
    });

    it('平日: 祝日は飛ばす（11/3 は文化の日なので、月曜の次は水曜）', () => {
      const series = timed({ id: 's', rrule: { freq: 'weekday' }, startDate: '2026-10-19' });

      expect(nextOfSeries([series], jst('2026-11-02', '15:00'))).toBe(jst('2026-11-04', '14:50'));
    });

    it('休日: 金曜の通知が過ぎたら、土曜', () => {
      const series = timed({ id: 's', rrule: { freq: 'holiday' }, startDate: '2026-10-19' });

      expect(nextOfSeries([series], jst('2026-10-23', '15:00'))).toBe(jst('2026-10-24', '14:50'));
    });

    it('休日: 平日の祝日も数える（日曜の次は、月曜を飛ばして、文化の日の 11/3）', () => {
      const series = timed({ id: 's', rrule: { freq: 'holiday' }, startDate: '2026-10-19' });

      expect(nextOfSeries([series], jst('2026-11-01', '15:00'))).toBe(jst('2026-11-03', '14:50'));
    });
  });

  describe('RP-4: 例外の行（この予定のみ）', () => {
    const after = jst('2026-10-27', '15:00');

    it('次の回を、別の日に移すと、系列はその日を飛ばし、例外の行は移した先の通知になる', () => {
      const moved = exception({
        id: 'x',
        originalDate: '2026-10-28',
        startDate: '2026-10-30',
        startTime: '10:00',
      });

      const result = nextNotifyTimes({ family: [daily, moved], afterMs: after });

      expect(result.get('s')).toBe(jst('2026-10-29', '14:50'));
      expect(result.get('x')).toBe(jst('2026-10-30', '09:50'));
    });

    it('例外の行は、系列と別の通知の分・通知の ON/OFF を持てる', () => {
      const changed = exception({
        id: 'x',
        originalDate: '2026-10-28',
        startDate: '2026-10-28',
        notifyOffsetMin: 60,
      });
      const off = exception({
        id: 'y',
        originalDate: '2026-10-29',
        startDate: '2026-10-29',
        notifyEnabled: false,
      });

      const result = nextNotifyTimes({ family: [daily, changed, off], afterMs: after });

      expect(result.get('x')).toBe(jst('2026-10-28', '14:00'));
      expect(result.get('y')).toBeNull();
      // 系列の次の回は、例外にした 10/28・10/29 を飛ばして、10/30。
      expect(result.get('s')).toBe(jst('2026-10-30', '14:50'));
    });

    it('例外の回を削除したら（cancelled）、例外の行は null で、系列もその日を飛ばす', () => {
      const cancelled = exception({
        id: 'x',
        originalDate: '2026-10-28',
        startDate: '2026-10-28',
        cancelled: true,
      });

      const result = nextNotifyTimes({ family: [daily, cancelled], afterMs: after });

      expect(result.get('x')).toBeNull();
      expect(result.get('s')).toBe(jst('2026-10-29', '14:50'));
    });

    it('移した先が、探す範囲（9 年）より遠くても、例外の行の通知は見つかる', () => {
      const far = exception({
        id: 'x',
        originalDate: '2026-10-28',
        startDate: '2050-01-10',
      });

      expect(nextNotifyTimes({ family: [daily, far], afterMs: after }).get('x')).toBe(
        jst('2050-01-10', '14:50'),
      );
    });

    it('例外の行の通知の時刻が、過ぎていたら null', () => {
      const past = exception({ id: 'x', originalDate: '2026-10-28', startDate: '2026-10-26' });

      expect(nextNotifyTimes({ family: [daily, past], afterMs: after }).get('x')).toBeNull();
    });

    it('削除された例外の行は、結果に入れず、その回は系列の回に戻る（展開と同じ）', () => {
      const deleted = exception({
        id: 'x',
        originalDate: '2026-10-28',
        startDate: '2026-10-30',
        deletedAt: 5000,
      });

      const result = nextNotifyTimes({ family: [daily, deleted], afterMs: after });

      expect(result.has('x')).toBe(false);
      expect(result.get('s')).toBe(jst('2026-10-28', '14:50'));
    });

    it('系列が削除されている例外の行は、画面に出ないので null', () => {
      const deletedSeries = { ...daily, deletedAt: 5000 };
      const orphan = exception({ id: 'x', originalDate: '2026-10-28', startDate: '2026-10-28' });

      const result = nextNotifyTimes({ family: [deletedSeries, orphan], afterMs: after });

      expect(result.has('s')).toBe(false);
      expect(result.get('x')).toBeNull();
    });

    it('同じ回の例外の行が 2 つあるときは、画面に出る新しい方だけが通知する', () => {
      const older = exception({
        id: 'x1',
        originalDate: '2026-10-28',
        startDate: '2026-10-28',
        editedAt: 2000,
      });
      const newer = exception({
        id: 'x2',
        originalDate: '2026-10-28',
        startDate: '2026-10-28',
        editedAt: 3000,
      });

      const result = nextNotifyTimes({ family: [daily, older, newer], afterMs: after });

      expect(result.get('x1')).toBeNull();
      expect(result.get('x2')).toBe(jst('2026-10-28', '14:50'));
    });

    it('例外の行は、同じ family の別の系列の回と、取り違えない', () => {
      const other = timed({
        id: 'o',
        rrule: { freq: 'weekly', days: [2] },
        startDate: '2026-10-20',
      });
      const moved = exception({
        id: 'x',
        originalDate: '2026-10-28',
        startDate: '2026-10-30',
      });

      const result = nextNotifyTimes({ family: [other, daily, moved], afterMs: after });

      expect(result.get('x')).toBe(jst('2026-10-30', '14:50'));
      expect(result.get('s')).toBe(jst('2026-10-29', '14:50'));
    });
  });
});
