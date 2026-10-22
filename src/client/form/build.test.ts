import { describe, expect, it } from 'vitest';
import { makeOccurrence } from '../../../test/helpers/entries';
import type { Occurrence } from '../../shared/recurrence';
import { entryDraftInputSchema, type Rrule } from '../../shared/schema';
import { toChanges, toDraft } from './build';
import { createValues, editValues, setAllDay, type FormValues } from './values';

// 日本時間 2026-10-22（木）の 14:20（UTC 05:20）。
const AT_1420 = Date.UTC(2026, 9, 22, 5, 20);

function newEvent(overrides: Partial<FormValues> = {}): FormValues {
  return {
    ...createValues({ kind: 'event', nowMs: AT_1420, workspaceId: 'w1' }),
    title: '歯医者',
    ...overrides,
  };
}

describe('新しく作るときの下書き', () => {
  it('時間指定の予定: 入力値がそのまま下書きになり、サーバーの入力の検証を通る', () => {
    const draft = toDraft(newEvent());

    expect(draft).toEqual({
      kind: 'event',
      title: '歯医者',
      workspaceId: 'w1',
      allDay: false,
      startDate: '2026-10-22',
      startTime: '15:00',
      endDate: '2026-10-22',
      endTime: '16:00',
      location: null,
      url: null,
      memo: null,
      rrule: null,
      notifyEnabled: true,
      notifyOffsetMin: 10,
    });
    expect(entryDraftInputSchema.safeParse(draft).success).toBe(true);
  });

  it('終日の予定: 時刻は null（時刻の欄に値が残っていても、保存しない）', () => {
    const draft = toDraft(setAllDay(newEvent(), true));

    expect(draft).toMatchObject({
      allDay: true,
      startTime: null,
      endTime: null,
      notifyOffsetMin: -360,
    });
    expect(entryDraftInputSchema.safeParse(draft).success).toBe(true);
  });

  it('タイムブロック: ワークスペースは null、終日にしない（予定のときの値が残っていても）', () => {
    const draft = toDraft(newEvent({ kind: 'block', allDay: true, notifyEnabled: false }));

    expect(draft).toMatchObject({
      kind: 'block',
      workspaceId: null,
      allDay: false,
      startTime: '15:00',
      endTime: '16:00',
      notifyEnabled: false,
    });
    expect(entryDraftInputSchema.safeParse(draft).success).toBe(true);
  });

  it('日付をまたぐタイムブロック（23:00〜翌 7:00。TB-6）は、終了の日付を翌日にして保存する', () => {
    const draft = toDraft(
      newEvent({
        kind: 'block',
        startTime: '23:00',
        endDate: '2026-10-23',
        endTime: '07:00',
      }),
    );

    expect(draft).toMatchObject({
      startDate: '2026-10-22',
      startTime: '23:00',
      endDate: '2026-10-23',
      endTime: '07:00',
    });
  });

  it('場所・URL・メモは、空なら null、入力があれば、前後の空白も含めて、そのまま', () => {
    expect(toDraft(newEvent({ location: '', url: '', memo: '' }))).toMatchObject({
      location: null,
      url: null,
      memo: null,
    });
    expect(toDraft(newEvent({ location: ' 渋谷 ', memo: '1行目\n2行目' }))).toMatchObject({
      location: ' 渋谷 ',
      memo: '1行目\n2行目',
    });
  });

  it('通知のタイミングが整数でなければ、整数でない値（NaN）にする（確認を通さずに作っても、別の値で保存されない）', () => {
    const draft = toDraft(newEvent({ notifyOffsetText: '' }));

    expect(draft.notifyOffsetMin).toBeNaN();
    expect(entryDraftInputSchema.safeParse(draft).success).toBe(false);
  });

  it('繰り返さないなら、rrule は null', () => {
    expect(toDraft(newEvent()).rrule).toBeNull();
  });

  describe('繰り返し（RP-1・RP-6）', () => {
    it.each<[Exclude<FormValues['repeat'], 'none' | 'weekly'>]>([
      ['daily'],
      ['monthly'],
      ['yearly'],
      ['weekday'],
      ['holiday'],
    ])('%s: 種類だけの rrule が入り、サーバーの入力の検証を通る', (repeat) => {
      const draft = toDraft(newEvent({ repeat }));

      expect(draft.rrule).toEqual({ freq: repeat });
      expect(entryDraftInputSchema.safeParse(draft).success).toBe(true);
    });

    it('毎週: 選んだ曜日が、昇順で入る', () => {
      const draft = toDraft(newEvent({ repeat: 'weekly', repeatDays: [5, 1, 3] }));

      expect(draft.rrule).toEqual({ freq: 'weekly', days: [1, 3, 5] });
      expect(entryDraftInputSchema.safeParse(draft).success).toBe(true);
    });

    it('毎週で、曜日を選んでいなければ、開始日（木曜）の曜日が入る', () => {
      expect(toDraft(newEvent({ repeat: 'weekly' })).rrule).toEqual({
        freq: 'weekly',
        days: [4],
      });
    });

    it('タイムブロックにも、ルールが付く（RP-6）', () => {
      const draft = toDraft(newEvent({ kind: 'block', repeat: 'weekday' }));

      expect(draft).toMatchObject({ kind: 'block', workspaceId: null, rrule: { freq: 'weekday' } });
      expect(entryDraftInputSchema.safeParse(draft).success).toBe(true);
    });
  });
});

describe('変更の中身（変えた項目だけ。設計書 4.5）', () => {
  const original = () =>
    makeOccurrence({
      title: '歯医者',
      workspaceId: 'w1',
      allDay: false,
      startDate: '2026-10-22',
      startTime: '15:00',
      endDate: '2026-10-22',
      endTime: '16:00',
      notifyEnabled: true,
      notifyOffsetMin: 10,
    });

  function edit(overrides: Partial<FormValues>): FormValues {
    return { ...editValues(original(), AT_1420, null), ...overrides };
  }

  it('何も変えていなければ、空（キーがない = 変えていない）', () => {
    expect(toChanges(edit({}), original(), null)).toEqual({});
  });

  it('タイトルだけ変えたら、タイトルだけが入る', () => {
    expect(toChanges(edit({ title: '歯医者（予約済み）' }), original(), null)).toEqual({
      title: '歯医者（予約済み）',
    });
  });

  it('時刻だけ変えたら、変えた時刻だけが入る', () => {
    expect(toChanges(edit({ endTime: '17:00' }), original(), null)).toEqual({ endTime: '17:00' });
  });

  it('開始の時刻と終了の時刻を、一緒に動かしたら、両方が入る', () => {
    expect(toChanges(edit({ startTime: '16:00', endTime: '17:00' }), original(), null)).toEqual({
      startTime: '16:00',
      endTime: '17:00',
    });
  });

  it('開始の日付を変えたら、終了の日付も入る（同じ長さのままでも）。開始だけ渡して、サーバーに終了をずらさせない', () => {
    expect(
      toChanges(edit({ startDate: '2026-10-25', endDate: '2026-10-25' }), original(), null),
    ).toEqual({ startDate: '2026-10-25', endDate: '2026-10-25' });
  });

  it('開始の日付を変えて、終了を別の長さに直したときも、直した終了の日付が入る', () => {
    expect(
      toChanges(edit({ startDate: '2026-10-25', endDate: '2026-10-27' }), original(), null),
    ).toEqual({ startDate: '2026-10-25', endDate: '2026-10-27' });
  });

  it('終了の日付だけ変えたら、終了の日付だけが入る', () => {
    expect(toChanges(edit({ endDate: '2026-10-23' }), original(), null)).toEqual({
      endDate: '2026-10-23',
    });
  });

  it('時間指定を終日にしたら、終日と、時刻の null が入る（時刻は消える）', () => {
    expect(toChanges(setAllDay(edit({}), true), original(), null)).toEqual({
      allDay: true,
      startTime: null,
      endTime: null,
      notifyOffsetMin: -360,
    });
  });

  it('終日を時間指定にしたら、終日でなくなることと、時刻が入る', () => {
    const allDayOriginal = makeOccurrence({ allDay: true, notifyOffsetMin: -360 });
    const values = setAllDay(editValues(allDayOriginal, AT_1420, null), false);

    expect(toChanges(values, allDayOriginal, null)).toEqual({
      allDay: false,
      startTime: '15:00',
      endTime: '16:00',
      notifyOffsetMin: 10,
    });
  });

  it('通知のタイミングの文字は、整数にして入れる', () => {
    expect(toChanges(edit({ notifyOffsetText: '45' }), original(), null)).toEqual({
      notifyOffsetMin: 45,
    });
  });

  it('API から入れた、当日の朝 6 時でない終日の予定は、ほかの項目だけを変えても、通知のタイミングを書き換えない', () => {
    const allDayOriginal = makeOccurrence({ allDay: true, notifyOffsetMin: -480 });
    const values = { ...editValues(allDayOriginal, AT_1420, null), title: '誕生日' };

    expect(toChanges(values, allDayOriginal, null)).toEqual({ title: '誕生日' });
  });

  it('終日を切り替えたときは、通知の分も、元と同じ数でも入る（分の意味が違うため）', () => {
    // 終日の 5（前日 23:55）を、時間指定の 5（開始の 5 分前）にする。数は同じだが、意味が変わる。
    const allDayOriginal = makeOccurrence({ allDay: true, notifyOffsetMin: 5 });
    const values = {
      ...setAllDay(editValues(allDayOriginal, AT_1420, null), false),
      notifyOffsetText: '5',
    };

    expect(toChanges(values, allDayOriginal, null)).toEqual({
      allDay: false,
      startTime: '15:00',
      endTime: '16:00',
      notifyOffsetMin: 5,
    });
  });

  it('時間指定を終日にしたときも、通知の分が入る（固定の -360）', () => {
    const timedOriginal = makeOccurrence({
      allDay: false,
      startTime: '15:00',
      endTime: '16:00',
      notifyOffsetMin: -360,
    });

    expect(
      toChanges(setAllDay(editValues(timedOriginal, AT_1420, null), true), timedOriginal, null),
    ).toEqual({
      allDay: true,
      startTime: null,
      endTime: null,
      notifyOffsetMin: -360,
    });
  });

  it('場所・URL・メモを入力したら入り、空にしたら null（空にした）になる', () => {
    expect(
      toChanges(
        edit({ location: '渋谷', url: 'https://example.com', memo: 'メモ' }),
        original(),
        null,
      ),
    ).toEqual({
      location: '渋谷',
      url: 'https://example.com',
      memo: 'メモ',
    });

    const filled = makeOccurrence({ location: '渋谷', url: 'https://example.com', memo: 'メモ' });
    expect(
      toChanges(
        { ...editValues(filled, AT_1420, null), location: '', url: '', memo: '' },
        filled,
        null,
      ),
    ).toEqual({ location: null, url: null, memo: null });
  });

  it('API から入った空文字（場所・URL・メモ）は、触らなければ、変えていないことになる（null を送らない）', () => {
    // サーバーの入力の検証は、場所・メモの空文字を通す。URL は通さないが、読み込みの確認は構造だけなので、行にはありうる。
    const emptyStrings = makeOccurrence({ location: '', url: '', memo: '' });

    expect(toChanges(editValues(emptyStrings, AT_1420, null), emptyStrings, null)).toEqual({});
    expect(
      toChanges(
        { ...editValues(emptyStrings, AT_1420, null), title: '題名だけ' },
        emptyStrings,
        null,
      ),
    ).toEqual({ title: '題名だけ' });
  });

  it('API から入った空文字の場所に、入力したら入り、そのあと空にしたら null（空にした）になる', () => {
    const emptyStrings = makeOccurrence({ location: '' });

    expect(
      toChanges(
        { ...editValues(emptyStrings, AT_1420, null), location: '渋谷' },
        emptyStrings,
        null,
      ),
    ).toEqual({ location: '渋谷' });
    const filled = makeOccurrence({ location: '渋谷' });
    expect(toChanges({ ...editValues(filled, AT_1420, null), location: '' }, filled, null)).toEqual(
      {
        location: null,
      },
    );
  });

  it('何も変えずに保存したときは、何も送らない（開いた回が、どんな値でも、changes が空）', () => {
    const occurrences = [
      makeOccurrence({ location: '', memo: '' }),
      makeOccurrence({ location: '渋谷', url: 'https://example.com', memo: 'メモ' }),
      makeOccurrence({ allDay: true, notifyOffsetMin: -480 }),
      makeOccurrence({ allDay: false, startTime: '09:00', endTime: '10:00', notifyOffsetMin: -30 }),
    ];

    for (const occurrence of occurrences) {
      expect(toChanges(editValues(occurrence, AT_1420, null), occurrence, null)).toEqual({});
    }
  });

  it('場所が空のままなら、変えていないことになる（元が null で、入力欄が空文字）', () => {
    expect(toChanges(edit({ location: '' }), original(), null)).toEqual({});
  });

  it('ワークスペースを変えたら、ワークスペースだけが入る', () => {
    expect(toChanges(edit({ workspaceId: 'w2' }), original(), null)).toEqual({ workspaceId: 'w2' });
  });

  it('通知の ON/OFF とタイミングを変えたら、それが入る', () => {
    expect(
      toChanges(edit({ notifyEnabled: false, notifyOffsetText: '60' }), original(), null),
    ).toEqual({
      notifyEnabled: false,
      notifyOffsetMin: 60,
    });
  });

  it('タイムブロックは、ワークスペースが null のままなので、入らない', () => {
    const block = makeOccurrence({
      kind: 'block',
      workspaceId: null,
      allDay: false,
      startTime: '09:00',
      endTime: '18:00',
      notifyEnabled: false,
    });

    expect(toChanges({ ...editValues(block, AT_1420, null), title: '仕事' }, block, null)).toEqual({
      title: '仕事',
    });
  });

  it('kind と繰り返しのルールは、入らない（作成後に変えられない・フォームにまだない）', () => {
    const changes = toChanges(edit({ title: '別の題名', endTime: '17:00' }), original(), null);

    expect(changes).not.toHaveProperty('kind');
    expect(changes).not.toHaveProperty('rrule');
  });
});

describe('変更の中身: 繰り返しのルール（設計書 4.5）', () => {
  const weeklyOriginal = (): Occurrence =>
    makeOccurrence({
      allDay: false,
      startDate: '2026-10-21',
      startTime: '15:00',
      endTime: '16:00',
      rrule: { freq: 'weekly', days: [3, 5] },
    });
  const weeklyRrule: Rrule = { freq: 'weekly', days: [3, 5] };

  it('ルールを変えていなければ、rrule は入らない（開いた回が、どんな値でも）', () => {
    const occurrence = weeklyOriginal();

    expect(
      toChanges(editValues(occurrence, AT_1420, weeklyRrule), occurrence, weeklyRrule),
    ).toEqual({});
  });

  it('曜日の並びだけが違うルールは、変えたことにしない（rrule は入らない）', () => {
    const occurrence = weeklyOriginal();
    const unordered: Rrule = { freq: 'weekly', days: [5, 3] };

    expect(toChanges(editValues(occurrence, AT_1420, unordered), occurrence, weeklyRrule)).toEqual(
      {},
    );
  });

  it('系列のルールと別の曜日にしたら、新しいルールが入る（昇順）', () => {
    const occurrence = weeklyOriginal();
    const values = { ...editValues(occurrence, AT_1420, weeklyRrule), repeatDays: [6, 1] };

    expect(toChanges(values, occurrence, weeklyRrule)).toEqual({
      rrule: { freq: 'weekly', days: [1, 6] },
    });
  });

  it('毎週を毎日に変えたら、新しいルールが入る', () => {
    const occurrence = weeklyOriginal();
    const values = { ...editValues(occurrence, AT_1420, weeklyRrule), repeat: 'daily' as const };

    expect(toChanges(values, occurrence, weeklyRrule)).toEqual({ rrule: { freq: 'daily' } });
  });

  it('繰り返さない予定に、ルールを付けたら、rrule が入る', () => {
    const occurrence = makeOccurrence({ allDay: false, startTime: '15:00', endTime: '16:00' });
    const values = { ...editValues(occurrence, AT_1420, null), repeat: 'monthly' as const };

    expect(toChanges(values, occurrence, null)).toEqual({ rrule: { freq: 'monthly' } });
  });

  it('ルールをなくしたら、null（ルールをなくした）が入る', () => {
    const occurrence = weeklyOriginal();
    const values = { ...editValues(occurrence, AT_1420, weeklyRrule), repeat: 'none' as const };

    expect(toChanges(values, occurrence, weeklyRrule)).toEqual({ rrule: null });
  });

  it('ほかの項目だけ変えたときは、ルールを入れない（開いてから送るまでに、別の端末が変えたルールを、上書きしない）', () => {
    const occurrence = weeklyOriginal();
    const values = { ...editValues(occurrence, AT_1420, weeklyRrule), title: '英会話' };

    expect(toChanges(values, occurrence, weeklyRrule)).toEqual({ title: '英会話' });
  });
});
