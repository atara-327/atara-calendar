import { describe, expect, it } from 'vitest';
import { layoutDay, type DaySegment } from './layout';

// 時刻は、その日の 0:00 からの分。h(9) は 9:00、h(9, 30) は 9:30。
const h = (hour: number, minute = 0) => hour * 60 + minute;
const seg = (start: number, end: number): DaySegment => ({ start, end });

describe('重ならない項目', () => {
  it('1 件だけなら、全幅（1 列のうちの 0 列目）', () => {
    expect(layoutDay([seg(h(9), h(10))])).toEqual([{ column: 0, columns: 1 }]);
  });

  it('何もなければ、何も返さない', () => {
    expect(layoutDay([])).toEqual([]);
  });

  it('時間が離れた 2 件は、どちらも全幅', () => {
    expect(layoutDay([seg(h(9), h(10)), seg(h(13), h(14))])).toEqual([
      { column: 0, columns: 1 },
      { column: 0, columns: 1 },
    ]);
  });

  it('終了と開始がちょうど接する 2 件は、重ならない扱いで、どちらも全幅', () => {
    expect(layoutDay([seg(h(9), h(10)), seg(h(10), h(11))])).toEqual([
      { column: 0, columns: 1 },
      { column: 0, columns: 1 },
    ]);
  });
});

describe('重なる項目', () => {
  it('2 件が重なると、2 列に並び、どちらも幅は半分（列の数が 2）', () => {
    expect(layoutDay([seg(h(9), h(11)), seg(h(10), h(12))])).toEqual([
      { column: 0, columns: 2 },
      { column: 1, columns: 2 },
    ]);
  });

  it('1 分でも重なれば、重なる扱い', () => {
    expect(layoutDay([seg(h(9), h(10)), seg(h(9, 59), h(11))])).toEqual([
      { column: 0, columns: 2 },
      { column: 1, columns: 2 },
    ]);
  });

  it('開始も終了も同じ 2 件は、2 列に並ぶ', () => {
    expect(layoutDay([seg(h(9), h(10)), seg(h(9), h(10))])).toEqual([
      { column: 0, columns: 2 },
      { column: 1, columns: 2 },
    ]);
  });

  it('3 件が同時に重なると、3 列', () => {
    expect(layoutDay([seg(h(9), h(12)), seg(h(9), h(11)), seg(h(9), h(10))])).toEqual([
      { column: 0, columns: 3 },
      { column: 1, columns: 3 },
      { column: 2, columns: 3 },
    ]);
  });

  it('開始が同じなら、長い方が左（0 列目）。入力の順は関係ない', () => {
    expect(layoutDay([seg(h(9), h(10)), seg(h(9), h(12))])).toEqual([
      { column: 1, columns: 2 },
      { column: 0, columns: 2 },
    ]);
  });

  it('開始が遅い方が入力の先頭でも、早く始まる方が左（0 列目）', () => {
    expect(layoutDay([seg(h(10), h(12)), seg(h(9), h(11))])).toEqual([
      { column: 1, columns: 2 },
      { column: 0, columns: 2 },
    ]);
  });
});

describe('連なって重なる項目（A と B、B と C が重なり、A と C は重ならない）', () => {
  it('A と C は同じ列に入り、全体で 2 列の、同じグループになる', () => {
    // A 9:00-10:00、B 9:30-10:30、C 10:00-11:00。
    expect(layoutDay([seg(h(9), h(10)), seg(h(9, 30), h(10, 30)), seg(h(10), h(11))])).toEqual([
      { column: 0, columns: 2 },
      { column: 1, columns: 2 },
      { column: 0, columns: 2 },
    ]);
  });

  it('グループは、最も遅い終了まで続く（C が B の途中で始まれば、A が終わっていても同じグループ）', () => {
    // A 9:00-9:30、B 9:00-11:00、C 10:00-10:30。A は C と重ならないが、B を通じて同じグループ。
    expect(layoutDay([seg(h(9), h(9, 30)), seg(h(9), h(11)), seg(h(10), h(10, 30))])).toEqual([
      { column: 1, columns: 2 },
      { column: 0, columns: 2 },
      { column: 1, columns: 2 },
    ]);
  });
});

describe('空いた列の再利用', () => {
  it('終わった列は、あとから始まる項目が使う（列が増えない）', () => {
    // A 9:00-12:00、B 9:00-10:00、C 10:00-11:00。C は、B が終わった 1 列目に入る。
    expect(layoutDay([seg(h(9), h(12)), seg(h(9), h(10)), seg(h(10), h(11))])).toEqual([
      { column: 0, columns: 2 },
      { column: 1, columns: 2 },
      { column: 1, columns: 2 },
    ]);
  });

  it('いちばん左の空いている列に入る', () => {
    // A 9:00-10:00、B 9:00-12:00、C 9:00-11:00、D 10:00-10:30。A が終わった 0 列目に D が入る。
    expect(
      layoutDay([seg(h(9), h(10)), seg(h(9), h(12)), seg(h(9), h(11)), seg(h(10), h(10, 30))]),
    ).toEqual([
      { column: 2, columns: 3 },
      { column: 0, columns: 3 },
      { column: 1, columns: 3 },
      { column: 2, columns: 3 },
    ]);
  });
});

describe('グループごとに、列の数を決める', () => {
  it('離れた時間の項目は、別のグループで、重なりの多い時間帯に引きずられず、全幅のまま', () => {
    const placements = layoutDay([
      seg(h(9), h(11)),
      seg(h(9), h(11)),
      seg(h(9), h(11)),
      seg(h(14), h(15)),
    ]);

    expect(placements.map((placement) => placement.columns)).toEqual([3, 3, 3, 1]);
  });

  it('前のグループが終わった（終了と開始が接する）あとの項目は、新しいグループで、0 列目から始まる', () => {
    expect(layoutDay([seg(h(9), h(10)), seg(h(9), h(10)), seg(h(10), h(11))])).toEqual([
      { column: 0, columns: 2 },
      { column: 1, columns: 2 },
      { column: 0, columns: 1 },
    ]);
  });
});

describe('日をまたいで切り取った項目（TB-6）', () => {
  it('前の日からの続き（0:00〜7:00）は、その日の 6:00〜8:00 の項目と重なる', () => {
    expect(layoutDay([seg(0, h(7)), seg(h(6), h(8))])).toEqual([
      { column: 0, columns: 2 },
      { column: 1, columns: 2 },
    ]);
  });

  it('次の日へ続く項目（23:00〜24:00）は、23:30〜24:00 の項目と重なる', () => {
    expect(layoutDay([seg(h(23), h(24)), seg(h(23, 30), h(24))])).toEqual([
      { column: 0, columns: 2 },
      { column: 1, columns: 2 },
    ]);
  });

  it('24:00 で終わる項目と、0:00 から始まる項目は、重ならない（別の日の端どうし）', () => {
    expect(layoutDay([seg(h(23), h(24)), seg(0, h(1))])).toEqual([
      { column: 0, columns: 1 },
      { column: 0, columns: 1 },
    ]);
  });
});

describe('入力', () => {
  it('入力の並びを書き換えず、入力と同じ順に返す', () => {
    const input = Object.freeze([
      Object.freeze(seg(h(10), h(11))),
      Object.freeze(seg(h(9), h(10, 30))),
    ]);

    const placements = layoutDay(input);

    expect(placements).toHaveLength(2);
    expect(input[0]).toEqual(seg(h(10), h(11)));
  });
});
