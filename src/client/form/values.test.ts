import { describe, expect, it } from 'vitest';
import { makeEntry, makeOccurrence } from '../../../test/helpers/entries';
import { expandOccurrences } from '../../shared/recurrence';
import { seriesRruleOf } from './repeat';
import { createValues, defaultNotify, editValues, setAllDay, setKind } from './values';

// 日本時間 2026-10-22（木）の 14:20（UTC 05:20）。
const AT_1420 = Date.UTC(2026, 9, 22, 5, 20);

describe('通知の初期値（NT-2〜4）', () => {
  it('予定の時間指定は、ON・10 分前', () => {
    expect(defaultNotify('event', false)).toEqual({ notifyEnabled: true, notifyOffsetText: '10' });
  });

  it('予定の終日は、ON・当日の朝 6 時（-360）', () => {
    expect(defaultNotify('event', true)).toEqual({ notifyEnabled: true, notifyOffsetText: '-360' });
  });

  it('タイムブロックは OFF。OFF のときも、ON にしたときの初期のタイミング（10 分前）を持つ', () => {
    expect(defaultNotify('block', false)).toEqual({ notifyEnabled: false, notifyOffsetText: '10' });
  });
});

describe('新しく作るときの初期値', () => {
  it('予定: タイトルは空で、今日の次の正時から 1 時間の時間指定、通知は ON・10 分前', () => {
    expect(createValues({ kind: 'event', nowMs: AT_1420, workspaceId: 'w1' })).toEqual({
      kind: 'event',
      title: '',
      allDay: false,
      startDate: '2026-10-22',
      startTime: '15:00',
      endDate: '2026-10-22',
      endTime: '16:00',
      workspaceId: 'w1',
      repeat: 'none',
      repeatDays: null,
      notifyEnabled: true,
      notifyOffsetText: '10',
      location: '',
      url: '',
      memo: '',
    });
  });

  it('タイムブロック: 同じ開始と終了で、通知は OFF', () => {
    expect(createValues({ kind: 'block', nowMs: AT_1420, workspaceId: 'w1' })).toMatchObject({
      kind: 'block',
      startTime: '15:00',
      endTime: '16:00',
      notifyEnabled: false,
    });
  });

  it('開始を決めて開くと、今日の次の正時ではなく、その開始から 1 時間になる（日表示から。他の項目は同じ）', () => {
    const values = createValues({
      kind: 'block',
      nowMs: AT_1420,
      workspaceId: 'w1',
      start: { date: '2026-10-25', time: '09:30' },
    });

    expect(values).toMatchObject({
      kind: 'block',
      startDate: '2026-10-25',
      startTime: '09:30',
      endDate: '2026-10-25',
      endTime: '10:30',
      notifyEnabled: false,
    });
    expect(values).toEqual({
      ...createValues({ kind: 'block', nowMs: AT_1420, workspaceId: 'w1' }),
      startDate: '2026-10-25',
      startTime: '09:30',
      endDate: '2026-10-25',
      endTime: '10:30',
    });
  });

  it('開始を決めて開いたとき、23:30 なら、終了は翌日の 0:30', () => {
    expect(
      createValues({
        kind: 'block',
        nowMs: AT_1420,
        workspaceId: null,
        start: { date: '2026-10-25', time: '23:30' },
      }),
    ).toMatchObject({ endDate: '2026-10-26', endTime: '00:30' });
  });

  it('ワークスペースが 1 つもなければ null', () => {
    expect(
      createValues({ kind: 'event', nowMs: AT_1420, workspaceId: null }).workspaceId,
    ).toBeNull();
  });
});

describe('開いた回の入力値', () => {
  it('時間指定の予定: 回の内容がそのまま入る。空の項目は、空文字', () => {
    const occurrence = makeOccurrence({
      title: '歯医者',
      workspaceId: 'w1',
      allDay: false,
      startTime: '15:00',
      endTime: '16:00',
      notifyOffsetMin: 30,
    });

    expect(editValues(occurrence, AT_1420, null)).toEqual({
      kind: 'event',
      title: '歯医者',
      allDay: false,
      startDate: '2026-10-19',
      startTime: '15:00',
      endDate: '2026-10-19',
      endTime: '16:00',
      workspaceId: 'w1',
      repeat: 'none',
      repeatDays: null,
      notifyEnabled: true,
      notifyOffsetText: '30',
      location: '',
      url: '',
      memo: '',
    });
  });

  it('場所・URL・メモがあれば、そのまま入る', () => {
    const occurrence = makeOccurrence({
      location: '渋谷',
      url: 'https://example.com',
      memo: '保険証',
    });

    expect(editValues(occurrence, AT_1420, null)).toMatchObject({
      location: '渋谷',
      url: 'https://example.com',
      memo: '保険証',
    });
  });

  it('終日の予定の時刻の欄は、時間指定に切り替えたときの値として、今日の次の正時から 1 時間を入れる', () => {
    const values = editValues(makeOccurrence({ allDay: true }), AT_1420, null);

    expect(values).toMatchObject({ allDay: true, startTime: '15:00', endTime: '16:00' });
  });

  it('API から入れた、当日の朝 6 時でない終日の予定は、その値のまま開く（黙って書き換えない）', () => {
    const occurrence = makeOccurrence({ allDay: true, notifyOffsetMin: -480 });

    expect(editValues(occurrence, AT_1420, null)).toMatchObject({
      allDay: true,
      notifyOffsetText: '-480',
    });
  });

  it('タイムブロックは、ワークスペースが null のまま', () => {
    const occurrence = makeOccurrence({
      kind: 'block',
      workspaceId: null,
      allDay: false,
      startTime: '09:00',
      endTime: '18:00',
      notifyEnabled: false,
    });

    expect(editValues(occurrence, AT_1420, null)).toMatchObject({
      kind: 'block',
      workspaceId: null,
      notifyEnabled: false,
    });
  });
});

describe('開いた回の、繰り返しの欄（設計書 11.4）', () => {
  it('系列のルールが入る。毎週は、曜日が昇順で入る', () => {
    const occurrence = makeOccurrence({
      rrule: { freq: 'weekly', days: [5, 3] },
      startDate: '2026-10-21',
    });

    expect(editValues(occurrence, AT_1420, { freq: 'weekly', days: [5, 3] })).toMatchObject({
      repeat: 'weekly',
      repeatDays: [3, 5],
    });
    expect(editValues(occurrence, AT_1420, { freq: 'monthly' })).toMatchObject({
      repeat: 'monthly',
    });
  });

  it('繰り返さない予定は、「しない」', () => {
    expect(editValues(makeOccurrence(), AT_1420, null)).toMatchObject({
      repeat: 'none',
      repeatDays: null,
    });
  });

  it('例外の回（別の日に移した回）も、系列のルールが入る（例外の行はルールを持たない）', () => {
    const series = makeEntry({ id: 's1', rrule: { freq: 'daily' }, startDate: '2026-10-19' });
    const exception = makeEntry({
      id: 'x1',
      seriesId: 's1',
      originalDate: '2026-10-21',
      startDate: '2026-10-23',
      title: '移した回',
    });
    const [occurrence] = expandOccurrences([series, exception], '2026-10-23', '2026-10-23').filter(
      ({ isException }) => isException,
    );
    if (occurrence === undefined) throw new Error('回がありません');
    const entries = new Map([series, exception].map((row) => [row.id, row]));

    const values = editValues(occurrence, AT_1420, seriesRruleOf(entries, occurrence.seriesId));

    expect(values).toMatchObject({ title: '移した回', startDate: '2026-10-23', repeat: 'daily' });
  });
});

describe('種類（予定・タイムブロック）を切り替える', () => {
  const event = () => createValues({ kind: 'event', nowMs: AT_1420, workspaceId: 'w1' });

  it('タイムブロックにすると、通知は OFF の初期値になる', () => {
    const values = setKind(event(), 'block');

    expect(values).toMatchObject({ kind: 'block', notifyEnabled: false, notifyOffsetText: '10' });
  });

  it('予定に戻すと、通知は ON の初期値になる（切り替える順番で、初期値が変わらない）', () => {
    const edited = { ...setKind(event(), 'block'), notifyEnabled: true, notifyOffsetText: '60' };

    expect(setKind(edited, 'event')).toMatchObject({
      kind: 'event',
      notifyEnabled: true,
      notifyOffsetText: '10',
    });
  });

  it('予定の終日をタイムブロックにすると、終日は外れる（タイムブロックは終日にできない）', () => {
    const values = setKind(setAllDay(event(), true), 'block');

    expect(values).toMatchObject({ kind: 'block', allDay: false });
  });

  it('入力したタイトル・ワークスペースは残る（予定に戻したときのため）', () => {
    const values = setKind({ ...event(), title: '仕事' }, 'block');

    expect(values).toMatchObject({ title: '仕事', workspaceId: 'w1' });
  });

  it('同じ種類にしても、何も変わらない', () => {
    const values = { ...event(), notifyOffsetText: '60' };

    expect(setKind(values, 'event')).toBe(values);
  });
});

describe('終日と時間指定を切り替える', () => {
  const timed = () => createValues({ kind: 'event', nowMs: AT_1420, workspaceId: 'w1' });

  it('終日にすると、通知のタイミングは、終日の固定の値（当日の朝 6 時 = -360）に戻る', () => {
    const values = setAllDay({ ...timed(), notifyOffsetText: '60' }, true);

    expect(values).toMatchObject({ allDay: true, notifyOffsetText: '-360' });
  });

  it('時間指定に戻すと、通知のタイミングは、時間指定の初期値（10 分前）に戻る', () => {
    const values = setAllDay({ ...setAllDay(timed(), true), notifyOffsetText: '-480' }, false);

    expect(values).toMatchObject({ allDay: false, notifyOffsetText: '10' });
  });

  it('通知の ON/OFF は、切り替えても変わらない', () => {
    const off = { ...timed(), notifyEnabled: false };

    expect(setAllDay(off, true).notifyEnabled).toBe(false);
    expect(setAllDay({ ...off, notifyEnabled: true }, true).notifyEnabled).toBe(true);
  });

  it('同じ状態にしても、何も変わらない（通知のタイミングを戻さない）', () => {
    const values = { ...timed(), notifyOffsetText: '60' };

    expect(setAllDay(values, false)).toBe(values);
  });

  it('終日にしたとき、終了が翌日の 0:00 なら、1 日だけの終日になる', () => {
    // 日本時間 22:10 に開くと、23:00〜翌 0:00。
    const values = createValues({
      kind: 'event',
      nowMs: Date.UTC(2026, 9, 22, 13, 10),
      workspaceId: 'w1',
    });

    expect(setAllDay(values, true)).toMatchObject({
      startDate: '2026-10-22',
      endDate: '2026-10-22',
    });
  });
});
