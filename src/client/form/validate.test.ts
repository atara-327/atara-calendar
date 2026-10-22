import { describe, expect, it } from 'vitest';
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
    const original = { notifyOffsetMin: -30 };

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

  it('誤りは、まとめて返す（1 つ直して、次の誤りが出る、を繰り返させない）', () => {
    const errors = validateForm(valid({ title: '', endTime: '14:00', url: 'foo' }));

    expect(Object.keys(errors).sort()).toEqual(['range', 'title', 'url']);
  });
});
