import { describe, expect, it } from 'vitest';
import { dayOfWeek } from '../../shared/date';
import { createValues, setAllDay, type FormValues } from './values';
import { validateForm } from './validate';

// 日本時間 2026-10-22（木）の 14:20（UTC 05:20）。
const AT_1420 = Date.UTC(2026, 9, 22, 5, 20);

function valid(overrides: Partial<FormValues> = {}): FormValues {
  return {
    ...createValues({ kind: 'event', nowMs: AT_1420, workspaceId: 'w1' }),
    title: '歯医者',
    ...overrides,
  };
}

describe('保存の前の確認', () => {
  it('正しい入力は、誤りがない', () => {
    expect(validateForm(valid())).toEqual({});
  });

  describe('タイトル（EV-2。必須。200 文字まで）', () => {
    it('空なら、タイトルの誤り', () => {
      expect(validateForm(valid({ title: '' })).title).toBeDefined();
    });

    it('空白だけでも、空と同じ', () => {
      expect(validateForm(valid({ title: '  　 ' })).title).toBeDefined();
    });

    it('200 文字までは通り、201 文字は誤り', () => {
      expect(validateForm(valid({ title: 'あ'.repeat(200) }))).toEqual({});
      expect(validateForm(valid({ title: 'あ'.repeat(201) })).title).toContain('200');
    });

    it('誤りの文言は、日本語（zod の英語の文言ではない）', () => {
      expect(validateForm(valid({ title: '' })).title).toMatch(/タイトル/);
    });
  });

  describe('開始・終了', () => {
    it('終了が開始より前なら、エラー（時間指定）', () => {
      expect(validateForm(valid({ endTime: '14:00' })).range).toBeDefined();
    });

    it('終了が開始より前なら、エラー（終日。終了日が開始日より前）', () => {
      const values = { ...setAllDay(valid(), true), endDate: '2026-10-21' };

      expect(validateForm(values).range).toBeDefined();
    });

    it('日付が空なら、その欄の誤り', () => {
      expect(validateForm(valid({ startDate: '' })).startDate).toBeDefined();
      expect(validateForm(valid({ endDate: '' })).endDate).toBeDefined();
    });

    it('日付が 1900〜2199 年の外なら、誤り', () => {
      expect(
        validateForm(valid({ startDate: '2200-01-01', endDate: '2200-01-02' })).startDate,
      ).toBeDefined();
    });

    it('日付をまたぐ時間指定（23:00〜翌 7:00）は、誤りがない', () => {
      const values = valid({
        kind: 'block',
        startTime: '23:00',
        endDate: '2026-10-23',
        endTime: '07:00',
      });

      expect(validateForm(values)).toEqual({});
    });
  });

  describe('通知のタイミング（時間指定の「何分前」）', () => {
    it.each(['0', '10', '10080'])('%s 分前は通る（0 は開始時刻。上限は 10080 分）', (text) => {
      expect(validateForm(valid({ notifyOffsetText: text }))).toEqual({});
    });

    it.each(['', '-', '1.5', 'abc', '10081', '-1'])('「%s」は、通知のタイミングの誤り', (text) => {
      expect(validateForm(valid({ notifyOffsetText: text })).notify).toBeDefined();
    });

    it('誤りの文言は、整数でないときと、範囲の外のときで分かれる（日本語）', () => {
      expect(validateForm(valid({ notifyOffsetText: '1.5' })).notify).toContain('整数');
      expect(validateForm(valid({ notifyOffsetText: '10081' })).notify).toContain('10,080');
    });

    it('通知が OFF でも確かめる（OFF のときも入力欄を見せているので、誤りが見えないまま保存が止まることはない）', () => {
      expect(
        validateForm(valid({ notifyEnabled: false, notifyOffsetText: '' })).notify,
      ).toBeDefined();
    });

    it('タイムブロック（常に時間指定）も、同じ範囲', () => {
      const block = valid({ kind: 'block', notifyOffsetText: '10081' });

      expect(validateForm(block).notify).toBeDefined();
      expect(validateForm({ ...block, notifyOffsetText: '60' })).toEqual({});
    });
  });

  describe('API から入った、開始より後の通知（時間指定で、通知の分が負の値）', () => {
    // 時間指定の予定の通知は、画面では 0〜10080 だけ。API は、終日のために、-1440 から通す。
    const original = { notifyOffsetMin: -30, allDay: false, recurring: false };

    it('開いたときの値から変えていなければ、題名だけ直して保存できる（変えていない項目は送らない）', () => {
      expect(validateForm(valid({ notifyOffsetText: '-30' }), original)).toEqual({});
    });

    it('変えたときは、これまでどおり、0〜10080 の間だけ', () => {
      expect(validateForm(valid({ notifyOffsetText: '-10' }), original).notify).toBeDefined();
      expect(validateForm(valid({ notifyOffsetText: '45' }), original)).toEqual({});
    });

    it('新しく作るとき（開いた回がない）は、負の値は通さない', () => {
      expect(validateForm(valid({ notifyOffsetText: '-30' })).notify).toBeDefined();
    });

    it('開いた回の値と同じでも、整数でなければ誤り', () => {
      expect(validateForm(valid({ notifyOffsetText: '' }), original).notify).toBeDefined();
    });

    it('終日だった予定を時間指定にしたら、元の分と同じ負の値でも誤り（終日と時間指定では、同じ数でも意味が違う）', () => {
      // 終日の -360 は「当日の朝 6 時」、時間指定の -360 は「開始の 6 時間後」。
      const allDayOriginal = { notifyOffsetMin: -360, allDay: true, recurring: false };
      const toTimed = setAllDay(setAllDay(valid(), true), false);

      expect(
        validateForm({ ...toTimed, notifyOffsetText: '-360' }, allDayOriginal).notify,
      ).toBeDefined();
      expect(
        validateForm(
          { ...toTimed, notifyOffsetText: '-30' },
          { ...allDayOriginal, notifyOffsetMin: -30 },
        ).notify,
      ).toBeDefined();
    });

    it('終日だった予定を時間指定にして、0〜10080 の分を入れたら通る（元と同じ数でも）', () => {
      const allDayOriginal = { notifyOffsetMin: 5, allDay: true, recurring: false };
      const toTimed = setAllDay(setAllDay(valid(), true), false);

      expect(validateForm({ ...toTimed, notifyOffsetText: '5' }, allDayOriginal)).toEqual({});
      expect(validateForm(toTimed, allDayOriginal)).toEqual({});
    });

    it('時間指定だった予定を終日にしたら、通知の分は確かめない（固定の値で、入力欄がない）', () => {
      const timedOriginal = { notifyOffsetMin: -30, allDay: false, recurring: false };

      expect(validateForm(setAllDay(valid(), true), timedOriginal)).toEqual({});
    });
  });

  describe('終日の通知の時刻（固定。入力欄がない）', () => {
    it('固定の値（-360）の終日は、誤りがない', () => {
      expect(validateForm(setAllDay(valid(), true))).toEqual({});
    });

    it('API から入れた、別の値（-480 や、前日の値）の終日の予定も、そのまま保存できる', () => {
      for (const text of ['-480', '60', '10080', '-1440']) {
        expect(validateForm({ ...setAllDay(valid(), true), notifyOffsetText: text })).toEqual({});
      }
    });

    it('サーバーが受け付けない範囲の値は、欄に結びつかない誤りにする（入力欄がないため）', () => {
      const errors = validateForm({ ...setAllDay(valid(), true), notifyOffsetText: '-2000' });

      expect(errors.notify).toBeUndefined();
      expect(errors.form).toBeDefined();
    });
  });

  describe('ワークスペース', () => {
    it('予定は、ワークスペースが必要', () => {
      expect(validateForm(valid({ workspaceId: null })).workspace).toBeDefined();
    });

    it('タイムブロックは、ワークスペースがなくてよい', () => {
      expect(validateForm(valid({ kind: 'block', workspaceId: null }))).toEqual({});
    });
  });

  describe('場所・URL・メモ', () => {
    it('場所は 200 文字まで', () => {
      expect(validateForm(valid({ location: '渋'.repeat(200) }))).toEqual({});
      expect(validateForm(valid({ location: '渋'.repeat(201) })).location).toBeDefined();
    });

    it('メモは 10,000 文字まで', () => {
      expect(validateForm(valid({ memo: 'あ'.repeat(10_000) }))).toEqual({});
      expect(validateForm(valid({ memo: 'あ'.repeat(10_001) })).memo).toBeDefined();
    });

    it('URL は、空か、http:// か https:// で始まる正しい形', () => {
      expect(validateForm(valid({ url: '' }))).toEqual({});
      expect(validateForm(valid({ url: 'https://example.com/a?b=1' }))).toEqual({});
      expect(validateForm(valid({ url: 'http://example.com' }))).toEqual({});
    });

    it.each([
      'javascript:alert(1)',
      'ftp://example.com',
      'example.com',
      'https://',
      'data:text/plain,a',
    ])('URL が %s なら、誤り', (url) => {
      expect(validateForm(valid({ url })).url).toBeDefined();
    });

    it('URL は 2048 文字まで', () => {
      const url = (length: number) => `https://example.com/${'a'.repeat(length - 20)}`;

      expect(validateForm(valid({ url: url(2048) }))).toEqual({});
      expect(validateForm(valid({ url: url(2049) })).url).toBeDefined();
    });
  });

  describe('繰り返し', () => {
    it('どのルールも、正しい入力なら、誤りがない（タイムブロックも。RP-6）', () => {
      for (const repeat of [
        'daily',
        'weekly',
        'monthly',
        'yearly',
        'weekday',
        'holiday',
      ] as const) {
        expect(validateForm(valid({ repeat }))).toEqual({});
        expect(validateForm(valid({ kind: 'block', workspaceId: null, repeat }))).toEqual({});
      }
    });

    it('毎週で、曜日が 1 つも選ばれていなければ、繰り返しの誤り', () => {
      const errors = validateForm(valid({ repeat: 'weekly', repeatDays: [] }));

      expect(errors.repeat).toBe('繰り返す曜日を 1 つ以上選んでください');
      expect(Object.keys(errors)).toEqual(['repeat']);
    });

    it('毎週で、曜日を選んでいなければ（開始日の曜日になる）、誤りではない', () => {
      expect(validateForm(valid({ repeat: 'weekly', repeatDays: null }))).toEqual({});
    });

    it('毎週で曜日を選んでいなくても、開始日が空のとき（日付を打っている途中）は、開始日の誤りだけを出す', () => {
      const errors = validateForm(valid({ repeat: 'weekly', repeatDays: null, startDate: '' }));

      expect(Object.keys(errors)).toEqual(['startDate']);
    });

    it('曜日を選んでいない状態でも、ほかのルールなら、誤りではない（曜日は使わない）', () => {
      expect(validateForm(valid({ repeat: 'daily', repeatDays: [] }))).toEqual({});
    });

    it('開始日がルールに合わなくても、ずれた後の日付が範囲内なら、誤りではない（毎週の水・金を月曜から）', () => {
      const values = valid({
        repeat: 'weekly',
        repeatDays: [3, 5],
        startDate: '2026-10-19',
        endDate: '2026-10-19',
      });

      expect(validateForm(values)).toEqual({});
    });

    it('開始日から、ルールに合う最初の日が、2199 年の外にずれるときは、繰り返しの誤り（サーバーが 400 にする）', () => {
      // 2199-12-31（木）から毎週の月曜は、2200-01-03 へずれる。
      const weekly = valid({
        repeat: 'weekly',
        repeatDays: [1],
        startDate: '2199-12-31',
        startTime: '10:00',
        endDate: '2199-12-31',
        endTime: '11:00',
      });
      // 年末年始の平日は、ずらす途中で、日付の計算が対応外の年になる。
      const weekday = valid({
        repeat: 'weekday',
        startDate: '2199-12-31',
        startTime: '10:00',
        endDate: '2199-12-31',
        endTime: '11:00',
      });

      expect(validateForm(weekly).repeat).toMatch(/1900〜2199 年の外/);
      expect(validateForm(weekday).repeat).toMatch(/1900〜2199 年の外/);
    });

    it('2199 年の中なら、同じルールでも誤りではない（2199-12-28 の毎週の月曜は、そのまま）', () => {
      const values = valid({
        repeat: 'weekly',
        repeatDays: [dayOfWeek('2199-12-28')],
        startDate: '2199-12-28',
        startTime: '10:00',
        endDate: '2199-12-28',
        endTime: '11:00',
      });

      expect(validateForm(values)).toEqual({});
    });

    it('すでに繰り返している予定は、ここでは確かめない（範囲ごとの確認は、範囲を選ぶ前に行う）', () => {
      const values = valid({
        repeat: 'weekday',
        startDate: '2199-12-31',
        startTime: '10:00',
        endDate: '2199-12-31',
        endTime: '11:00',
      });
      const original = { notifyOffsetMin: 10, allDay: false, recurring: true };

      expect(validateForm(values, original)).toEqual({});
    });
  });

  it('誤りは、まとめて返す（1 つ直して、次の誤りが出る、を繰り返させない）', () => {
    const errors = validateForm(valid({ title: '', endTime: '14:00', url: 'foo' }));

    expect(Object.keys(errors).sort()).toEqual(['range', 'title', 'url']);
  });
});
