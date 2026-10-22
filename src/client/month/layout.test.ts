import { describe, expect, it } from 'vitest';
import { makeOccurrence } from '../../../test/helpers/entries';
import { layoutWeek, type BarItem, type MonthEvent, type MoreItem, type TimedItem } from './layout';

// 2026-10-18（日）〜 10-24（土）の週。列は 0（日）〜 6（土）。10-19 が月曜（列 1）。
const WEEK = '2026-10-18';
const SLOTS = 4;
// 並べ方は、押したときに開く回（occurrence）を使わない。どの予定も、同じ回を持たせる。
const OCCURRENCE = makeOccurrence();

function timed(key: string, date: string, time: string): MonthEvent {
  return {
    key,
    title: key,
    color: '#039BE5',
    allDay: false,
    startDate: date,
    lastDate: date,
    startTime: time,
    occurrence: OCCURRENCE,
  };
}

function allDay(key: string, startDate: string, lastDate = startDate): MonthEvent {
  return {
    key,
    title: key,
    color: '#039BE5',
    allDay: true,
    startDate,
    lastDate,
    startTime: null,
    occurrence: OCCURRENCE,
  };
}

function bars(items: ReturnType<typeof layoutWeek>): BarItem[] {
  return items.filter((item): item is BarItem => item.kind === 'bar');
}
function timeds(items: ReturnType<typeof layoutWeek>): TimedItem[] {
  return items.filter((item): item is TimedItem => item.kind === 'timed');
}
function mores(items: ReturnType<typeof layoutWeek>): MoreItem[] {
  return items.filter((item): item is MoreItem => item.kind === 'more');
}

describe('複数日の予定は、マスをまたぐ横棒になる', () => {
  it('開始の列から終了の列まで、1 本の棒にする', () => {
    const items = layoutWeek([allDay('帰省', '2026-10-20', '2026-10-22')], WEEK, SLOTS);

    expect(bars(items)).toEqual([
      expect.objectContaining({
        startCol: 2,
        endCol: 4,
        row: 0,
        continuesBefore: false,
        continuesAfter: false,
      }),
    ]);
  });

  it('前の週から続く棒は、左が切れている', () => {
    const items = layoutWeek([allDay('旅行', '2026-10-15', '2026-10-20')], WEEK, SLOTS);

    expect(bars(items)).toEqual([
      expect.objectContaining({
        startCol: 0,
        endCol: 2,
        continuesBefore: true,
        continuesAfter: false,
      }),
    ]);
  });

  it('次の週へ続く棒は、右が切れている', () => {
    const items = layoutWeek([allDay('旅行', '2026-10-23', '2026-10-27')], WEEK, SLOTS);

    expect(bars(items)).toEqual([
      expect.objectContaining({
        startCol: 5,
        endCol: 6,
        continuesBefore: false,
        continuesAfter: true,
      }),
    ]);
  });

  it('この週にかからない予定は出さない', () => {
    const items = layoutWeek(
      [allDay('前', '2026-10-10', '2026-10-17'), allDay('後', '2026-10-25')],
      WEEK,
      SLOTS,
    );

    expect(items).toEqual([]);
  });

  it('日付をまたぐ時間指定の予定（23:00〜翌 1:00）も、横棒になる', () => {
    const overnight: MonthEvent = {
      ...timed('夜勤', '2026-10-20', '23:00'),
      lastDate: '2026-10-21',
    };

    const items = layoutWeek([overnight], WEEK, SLOTS);

    expect(timeds(items)).toEqual([]);
    expect(bars(items)).toEqual([expect.objectContaining({ startCol: 2, endCol: 3 })]);
  });
});

describe('横棒の行（レーン）の割り当て', () => {
  it('日が重ならない棒は、同じ行に並ぶ', () => {
    const items = layoutWeek(
      [allDay('A', '2026-10-19', '2026-10-20'), allDay('B', '2026-10-21', '2026-10-22')],
      WEEK,
      SLOTS,
    );

    expect(bars(items).map((bar) => [bar.event.key, bar.row])).toEqual([
      ['A', 0],
      ['B', 0],
    ]);
  });

  it('日が重なる棒は、上から詰めて別の行に置く', () => {
    const items = layoutWeek(
      [allDay('A', '2026-10-19', '2026-10-21'), allDay('B', '2026-10-20', '2026-10-22')],
      WEEK,
      SLOTS,
    );

    expect(bars(items).map((bar) => [bar.event.key, bar.row])).toEqual([
      ['A', 0],
      ['B', 1],
    ]);
  });

  it('先に始まった棒が上、同じ日に始まるなら長い棒が上に来る', () => {
    const items = layoutWeek(
      [
        allDay('短い', '2026-10-19', '2026-10-20'),
        allDay('長い', '2026-10-19', '2026-10-23'),
        allDay('先', '2026-10-18', '2026-10-19'),
      ],
      WEEK,
      SLOTS,
    );

    const rows = new Map(bars(items).map((bar) => [bar.event.key, bar.row]));
    expect(rows.get('先')).toBe(0);
    expect(rows.get('長い')).toBe(1);
    expect(rows.get('短い')).toBe(2);
  });

  it('複数日の棒を先に詰め、そのあとに 1 日だけの終日の予定を置く', () => {
    const items = layoutWeek(
      [allDay('終日', '2026-10-20'), allDay('帰省', '2026-10-20', '2026-10-22')],
      WEEK,
      SLOTS,
    );

    const rows = new Map(bars(items).map((bar) => [bar.event.key, bar.row]));
    expect(rows.get('帰省')).toBe(0);
    expect(rows.get('終日')).toBe(1);
  });

  it('棒の行は、棒がかかる日のすべてで同じ（日によって上下に動かさない）', () => {
    // A は月〜火、B は火〜木。B は火で A と重なるので 1 行目。水・木でも 1 行目のまま。
    const items = layoutWeek(
      [allDay('A', '2026-10-19', '2026-10-20'), allDay('B', '2026-10-20', '2026-10-22')],
      WEEK,
      SLOTS,
    );

    const b = bars(items).find((bar) => bar.event.key === 'B');
    expect(b).toEqual(expect.objectContaining({ row: 1, startCol: 2, endCol: 4 }));
  });
});

describe('時間指定の予定', () => {
  it('その日の中で、時刻順に並べる', () => {
    const items = layoutWeek(
      [
        timed('夕方', '2026-10-20', '18:00'),
        timed('朝', '2026-10-20', '09:00'),
        timed('昼', '2026-10-20', '12:30'),
      ],
      WEEK,
      SLOTS,
    );

    expect(timeds(items).map((item) => [item.event.key, item.col, item.row])).toEqual([
      ['朝', 2, 0],
      ['昼', 2, 1],
      ['夕方', 2, 2],
    ]);
  });

  it('その日にかかる横棒（複数日・終日）の下に並べる', () => {
    const items = layoutWeek(
      [
        timed('歯医者', '2026-10-21', '15:00'),
        allDay('帰省', '2026-10-20', '2026-10-22'),
        allDay('誕生日', '2026-10-21'),
      ],
      WEEK,
      SLOTS,
    );

    expect(timeds(items)).toEqual([expect.objectContaining({ col: 3, row: 2 })]);
  });

  it('横棒が通っていない日は、別の日の棒の行数に関係なく、いちばん上から並べる', () => {
    const items = layoutWeek(
      [
        allDay('A', '2026-10-19', '2026-10-20'),
        allDay('B', '2026-10-19', '2026-10-20'),
        timed('水曜', '2026-10-21', '10:00'),
      ],
      WEEK,
      SLOTS,
    );

    expect(timeds(items)).toEqual([expect.objectContaining({ col: 3, row: 0 })]);
  });
});

describe('入りきらない分は「+N件」にする', () => {
  function week(day: string, count: number): MonthEvent[] {
    return Array.from({ length: count }, (_, index) =>
      timed(`予定${String(index)}`, day, `${String(8 + index).padStart(2, '0')}:00`),
    );
  }

  it('ちょうど入るときは、「+N件」を出さない', () => {
    const items = layoutWeek(week('2026-10-20', SLOTS), WEEK, SLOTS);

    expect(timeds(items)).toHaveLength(SLOTS);
    expect(mores(items)).toEqual([]);
  });

  it('1 件でも超えたら、いちばん下の行を「+N件」にする（出せない予定 + その行にあった予定）', () => {
    const items = layoutWeek(week('2026-10-20', SLOTS + 1), WEEK, SLOTS);

    expect(timeds(items).map((item) => item.row)).toEqual([0, 1, 2]);
    expect(mores(items)).toEqual([{ kind: 'more', col: 2, row: SLOTS - 1, count: 2 }]);
  });

  it('N は、出せなかった予定の数', () => {
    const items = layoutWeek(week('2026-10-20', 9), WEEK, SLOTS);

    expect(timeds(items)).toHaveLength(SLOTS - 1);
    expect(mores(items)).toEqual([expect.objectContaining({ col: 2, count: 9 - (SLOTS - 1) })]);
  });

  it('「+N件」は、入りきらない日だけに出す', () => {
    const items = layoutWeek(
      [...week('2026-10-20', 6), timed('水', '2026-10-21', '10:00')],
      WEEK,
      SLOTS,
    );

    expect(mores(items).map((item) => item.col)).toEqual([2]);
    expect(timeds(items).filter((item) => item.col === 3)).toHaveLength(1);
  });

  it('横棒も、その日にかかる予定として数える（横棒が出せないときは、その日の N に入る）', () => {
    // 3 行しか入らない。月曜に、横棒 3 本と時間指定 1 件。
    const items = layoutWeek(
      [
        allDay('A', '2026-10-19', '2026-10-21'),
        allDay('B', '2026-10-19', '2026-10-21'),
        allDay('C', '2026-10-19', '2026-10-21'),
        timed('歯医者', '2026-10-19', '15:00'),
      ],
      WEEK,
      3,
    );

    // 月曜: 4 件のうち、出せるのは 2 行（A・B）。C と歯医者が出せない。
    expect(mores(items)).toEqual(
      expect.arrayContaining([expect.objectContaining({ col: 1, row: 2, count: 2 })]),
    );
    expect(timeds(items)).toEqual([]);
  });

  it('溢れた日だけに「+N件」を出し、ほかの日の横棒の行は動かさない', () => {
    // 4 行。A・B・C が月〜金の棒（行 0〜2）。水曜だけ、時間指定が 2 件あって 5 行になり溢れる。
    const items = layoutWeek(
      [
        allDay('A', '2026-10-19', '2026-10-23'),
        allDay('B', '2026-10-19', '2026-10-23'),
        allDay('C', '2026-10-19', '2026-10-23'),
        timed('水の予定 1', '2026-10-21', '10:00'),
        timed('水の予定 2', '2026-10-21', '11:00'),
      ],
      WEEK,
      4,
    );

    // 水曜の出せる行は 3 行（A・B・C）。水曜の予定 2 件が出せない。
    expect(mores(items)).toEqual([{ kind: 'more', col: 3, row: 3, count: 2 }]);
    expect(timeds(items)).toEqual([]);
    expect(bars(items).map((bar) => [bar.event.key, bar.startCol, bar.endCol, bar.row])).toEqual([
      ['A', 1, 5, 0],
      ['B', 1, 5, 1],
      ['C', 1, 5, 2],
    ]);
  });

  it('横棒が途中の日で「+N件」の行に当たると、その日で棒が切れて、2 本になる', () => {
    // 行は 2 つ。A は月〜金（行 0）、B は月〜金（行 1）。水曜に時間指定が 1 件あって溢れると、
    // 水曜の行 1 は「+N件」になり、B は水曜で切れる。
    const items = layoutWeek(
      [
        allDay('A', '2026-10-19', '2026-10-23'),
        allDay('B', '2026-10-19', '2026-10-23'),
        timed('水の予定', '2026-10-21', '10:00'),
      ],
      WEEK,
      2,
    );

    const b = bars(items).filter((bar) => bar.event.key === 'B');
    expect(b).toEqual([
      expect.objectContaining({
        startCol: 1,
        endCol: 2,
        continuesBefore: false,
        continuesAfter: true,
      }),
      expect.objectContaining({
        startCol: 4,
        endCol: 5,
        continuesBefore: true,
        continuesAfter: false,
      }),
    ]);
    // 水曜の「+N件」は、B（水曜にかかる分）と水の予定。
    expect(mores(items)).toEqual([{ kind: 'more', col: 3, row: 1, count: 2 }]);
    // A は行 0 なので、切れない。
    expect(bars(items).filter((bar) => bar.event.key === 'A')).toEqual([
      expect.objectContaining({ startCol: 1, endCol: 5 }),
    ]);
  });

  it('1 行しか入らないときは、予定を出さずに「+N件」だけを出す', () => {
    const items = layoutWeek(week('2026-10-20', 2), WEEK, 1);

    expect(timeds(items)).toEqual([]);
    expect(mores(items)).toEqual([{ kind: 'more', col: 2, row: 0, count: 2 }]);
  });
});
