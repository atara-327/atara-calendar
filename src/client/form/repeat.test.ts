import { describe, expect, it } from 'vitest';
import type { Rrule } from '../../shared/schema';
import {
  REPEAT_OPTIONS,
  describeFirstOccurrence,
  describeRepeat,
  firstOccurrence,
  hasNoWeeklyDays,
  repeatFieldsOf,
  rruleOf,
  toggleRepeatDay,
  weeklyDays,
  type RepeatFields,
} from './repeat';

// 2026-10-19 は月曜、10-21 は水曜、10-22 は木曜、10-24 は土曜。
const MONDAY = '2026-10-19';
const THURSDAY = '2026-10-22';

function input(fields: Partial<RepeatFields>, startDate = MONDAY) {
  return { repeat: 'none' as const, repeatDays: null, startDate, ...fields };
}

describe('繰り返しの選択肢（RP-1）', () => {
  it('しない・毎日・毎週・毎月・毎年・平日・休日の順で、終わりの指定は出さない（RP-3）', () => {
    expect(REPEAT_OPTIONS.map(({ label }) => label)).toEqual([
      'しない',
      '毎日',
      '毎週',
      '毎月',
      '毎年',
      '平日',
      '休日',
    ]);
  });
});

describe('欄の値から rrule を作る', () => {
  it('しない: null', () => {
    expect(rruleOf(input({ repeat: 'none' }))).toBeNull();
  });

  it.each<[Exclude<RepeatFields['repeat'], 'none' | 'weekly'>]>([
    ['daily'],
    ['monthly'],
    ['yearly'],
    ['weekday'],
    ['holiday'],
  ])('%s: 種類だけのルール', (repeat) => {
    expect(rruleOf(input({ repeat }))).toEqual({ freq: repeat });
  });

  it('毎週: 選んだ曜日を、並びによらず昇順にそろえる（並びの違いをルールの変更と見なさないため）', () => {
    expect(rruleOf(input({ repeat: 'weekly', repeatDays: [5, 1, 3] }))).toEqual({
      freq: 'weekly',
      days: [1, 3, 5],
    });
  });

  it('毎週で、曜日を選んでいなければ、開始日の曜日（月曜）', () => {
    expect(rruleOf(input({ repeat: 'weekly', repeatDays: null }, MONDAY))).toEqual({
      freq: 'weekly',
      days: [1],
    });
    expect(rruleOf(input({ repeat: 'weekly', repeatDays: null }, THURSDAY))).toEqual({
      freq: 'weekly',
      days: [4],
    });
  });

  it('毎週で、曜日を選んでいなければ、開始日を変えると曜日もついてくる。選んだあとは、ついてこない', () => {
    const untouched = input({ repeat: 'weekly' }, MONDAY);
    const moved = { ...untouched, startDate: THURSDAY };
    expect(weeklyDays(moved)).toEqual([4]);

    const chosen = { ...untouched, ...toggleRepeatDay(untouched, 3) };
    expect(weeklyDays({ ...chosen, startDate: THURSDAY })).toEqual([1, 3]);
  });

  it('毎週で、開始日が正しくなければ（日付を打っている途中）、曜日は空', () => {
    expect(weeklyDays(input({ repeat: 'weekly' }, ''))).toEqual([]);
    expect(weeklyDays(input({ repeat: 'weekly' }, '0002-10-25'))).toEqual([]);
  });
});

describe('開いた予定の rrule から、欄の値を作る', () => {
  it('ルールなし: しない', () => {
    expect(repeatFieldsOf(null)).toEqual({ repeat: 'none', repeatDays: null });
  });

  it('毎週: 曜日を昇順で持つ', () => {
    expect(repeatFieldsOf({ freq: 'weekly', days: [5, 3] })).toEqual({
      repeat: 'weekly',
      repeatDays: [3, 5],
    });
  });

  it.each<Rrule>([
    { freq: 'daily' },
    { freq: 'weekly', days: [1, 3, 5] },
    { freq: 'monthly' },
    { freq: 'yearly' },
    { freq: 'weekday' },
    { freq: 'holiday' },
  ])('rrule（$freq）を欄の値にして、また rrule にすると、元に戻る', (rrule) => {
    expect(rruleOf({ ...repeatFieldsOf(rrule), startDate: MONDAY })).toEqual(rrule);
  });
});

describe('毎週の曜日のトグル', () => {
  it('選んでいない曜日を押すと、足される（昇順）', () => {
    const fields = input({ repeat: 'weekly', repeatDays: [1, 5] });

    expect(toggleRepeatDay(fields, 3)).toEqual({ repeat: 'weekly', repeatDays: [1, 3, 5] });
  });

  it('選んでいる曜日を押すと、外れる', () => {
    const fields = input({ repeat: 'weekly', repeatDays: [1, 3, 5] });

    expect(toggleRepeatDay(fields, 3)).toEqual({ repeat: 'weekly', repeatDays: [1, 5] });
  });

  it('まだ選んでいないとき（開始日の曜日）は、開始日の曜日を起点に切り替える', () => {
    const fields = input({ repeat: 'weekly', repeatDays: null }, MONDAY);

    expect(toggleRepeatDay(fields, 3).repeatDays).toEqual([1, 3]);
    expect(toggleRepeatDay(fields, 1).repeatDays).toEqual([]);
  });

  it('1 つも選ばない状態にできる。それは保存できない誤り（開始日の曜日のままの状態は、誤りではない）', () => {
    const none = toggleRepeatDay(input({ repeat: 'weekly', repeatDays: [3] }), 3);

    expect(hasNoWeeklyDays(none)).toBe(true);
    expect(hasNoWeeklyDays({ repeat: 'weekly', repeatDays: null })).toBe(false);
    expect(hasNoWeeklyDays({ repeat: 'daily', repeatDays: [] })).toBe(false);
  });
});

describe('繰り返しの説明（設計書 4.4・Q9・RP-2・RP-5）', () => {
  it('毎月は「毎月 N 日」。基準は開始日', () => {
    expect(describeRepeat('monthly', '2026-10-22')).toBe('毎月 22 日');
    expect(describeRepeat('monthly', '2026-02-28')).toBe('毎月 28 日');
  });

  it.each(['2026-10-29', '2026-10-30', '2026-10-31'])(
    '毎月で、開始日が %s（29〜31 日）なら、その日がない月は飛ばすと添える（RP-2）',
    (date) => {
      expect(describeRepeat('monthly', date)).toMatch(
        /^毎月 \d+ 日（その日がない月は飛ばします）$/,
      );
    },
  );

  it('毎年は「毎年 M 月 D 日」', () => {
    expect(describeRepeat('yearly', '2026-10-22')).toBe('毎年 10 月 22 日');
  });

  it('毎年で、2/29 なら、うるう年だけと添える（Q9）。2/28 には添えない', () => {
    expect(describeRepeat('yearly', '2028-02-29')).toBe('毎年 2 月 29 日（うるう年だけ）');
    expect(describeRepeat('yearly', '2027-02-28')).toBe('毎年 2 月 28 日');
  });

  it('平日の説明は、休日の決まり（土日・祝日・年末年始）と、記念日は休日ではないことを言う（RP-5）', () => {
    const text = describeRepeat('weekday', MONDAY) ?? '';

    expect(text).toContain('祝日');
    expect(text).toContain('年末年始');
    expect(text).toContain('12/29〜1/3');
    expect(text).toContain('記念日は休日ではありません');
  });

  it('休日の説明は、土日・祝日・年末年始の日で、記念日は含まないことを言う（RP-5）', () => {
    const text = describeRepeat('holiday', MONDAY) ?? '';

    expect(text).toContain('土曜・日曜・祝日・年末年始');
    expect(text).toContain('記念日は含みません');
  });

  it('しない・毎日・毎週は、説明を添えない。日付が正しくないときも、添えない', () => {
    expect(describeRepeat('none', MONDAY)).toBeNull();
    expect(describeRepeat('daily', MONDAY)).toBeNull();
    expect(describeRepeat('weekly', MONDAY)).toBeNull();
    expect(describeRepeat('monthly', '')).toBeNull();
    expect(describeRepeat('yearly', '0002-02-29')).toBeNull();
  });
});

describe('保存したときの、最初の回（設計書 4.4。shared の normalizeStart で求める）', () => {
  it('月曜を開始日にして毎週の水・金を選ぶと、最初の回は水曜になる。終了日も同じだけずれる', () => {
    const first = firstOccurrence({
      ...input({ repeat: 'weekly', repeatDays: [3, 5] }, MONDAY),
      endDate: '2026-10-20',
    });

    expect(first).toEqual({ kind: 'found', startDate: '2026-10-21', endDate: '2026-10-22' });
    expect(describeFirstOccurrence(first, MONDAY)).toBe('最初の回は 10月21日（水）になります');
  });

  it('開始日がルールに合っていれば、ずれない（文言は出さない）', () => {
    const first = firstOccurrence({
      ...input({ repeat: 'weekly', repeatDays: [1, 3] }, MONDAY),
      endDate: MONDAY,
    });

    expect(first).toEqual({ kind: 'found', startDate: MONDAY, endDate: MONDAY });
    expect(describeFirstOccurrence(first, MONDAY)).toBeNull();
  });

  it('平日を土曜から始めると、月曜になる。休日を金曜から始めると、土曜になる', () => {
    const weekday = firstOccurrence({
      ...input({ repeat: 'weekday' }, '2026-10-24'),
      endDate: '2026-10-24',
    });
    const holiday = firstOccurrence({
      ...input({ repeat: 'holiday' }, '2026-10-23'),
      endDate: '2026-10-23',
    });

    expect(describeFirstOccurrence(weekday, '2026-10-24')).toBe(
      '最初の回は 10月26日（月）になります',
    );
    expect(describeFirstOccurrence(holiday, '2026-10-23')).toBe(
      '最初の回は 10月24日（土）になります',
    );
  });

  it('毎日・毎月・毎年は、開始日が基準なので、ずれない', () => {
    for (const repeat of ['daily', 'monthly', 'yearly'] as const) {
      const first = firstOccurrence({ ...input({ repeat }, '2026-10-31'), endDate: '2026-10-31' });
      expect(describeFirstOccurrence(first, '2026-10-31')).toBeNull();
    }
  });

  it('開始日と別の年にずれるときは、年も付ける', () => {
    const first = firstOccurrence({
      ...input({ repeat: 'weekday' }, '2026-12-29'),
      endDate: '2026-12-29',
    });

    expect(describeFirstOccurrence(first, '2026-12-29')).toBe(
      '最初の回は 2027年1月4日（月）になります',
    );
  });

  it('繰り返さない・日付が正しくない・毎週で曜日がないときは、求めない（別の誤りが出る）', () => {
    expect(firstOccurrence({ ...input({ repeat: 'none' }), endDate: MONDAY })).toEqual({
      kind: 'none',
    });
    expect(firstOccurrence({ ...input({ repeat: 'daily' }, ''), endDate: MONDAY })).toEqual({
      kind: 'none',
    });
    expect(firstOccurrence({ ...input({ repeat: 'daily' }), endDate: '' })).toEqual({
      kind: 'none',
    });
    expect(
      firstOccurrence({ ...input({ repeat: 'weekly', repeatDays: [] }), endDate: MONDAY }),
    ).toEqual({ kind: 'none' });
  });

  it('ずらす途中で、日付の計算が対応する年（2199 年まで）を出るときは、求められない（サーバーも 400 にする）', () => {
    const first = firstOccurrence({
      ...input({ repeat: 'weekday' }, '2199-12-31'),
      endDate: '2199-12-31',
    });

    expect(first).toEqual({ kind: 'unsupported' });
    expect(describeFirstOccurrence(first, '2199-12-31')).toBeNull();
  });
});
