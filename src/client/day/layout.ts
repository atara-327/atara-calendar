// 日表示のタイムラインで、時間が重なる項目を、横にどう並べるか（DV-4。設計書 11.3）。
// 画面に依存しない計算だけを置く。時間は、その日の 0:00 からの分（0〜1440）。

/** 1 日の中の 1 件。[start, end)（end の瞬間は含まない）。日をまたぐものは、その日の範囲に切り取ってから渡す。 */
export interface DaySegment {
  start: number;
  end: number;
}

/** 横の位置。幅は 1 / columns、左は column / columns（全体の幅に対する割合）。 */
export interface DayPlacement {
  /** 左から何列目か（0 始まり）。 */
  column: number;
  /** 同じグループの列の数。グループは、時間が連なって重なっているまとまり。 */
  columns: number;
}

/**
 * 項目の横の位置を決める。戻り値は、入力と同じ順。
 *
 * 開始の早い順（同じなら長い順）に見て、今のグループの中の最も遅い終了より前に始まるものは、同じグループ、
 * そうでなければ新しいグループにする。グループの中では、左から順に、最後の終了が自分の開始以前の、
 * 最初の列に入れる（なければ列を足す）。幅は、グループの列の数で割る。
 * 終了と開始がちょうど接する項目は、重ならないものとして扱う（同じグループにも、同じ列にもなりうる）。
 *
 * Why not 重なった全体を 1 つのグループにして、全体の最大の重なりで割る: A と B、B と C が重なり、
 * A と C は重ならないとき、A と C は同じ列に入れられる。列の数をグループごとに決めれば、
 * 離れた時間の項目まで、細くならない（Google カレンダーと同じ。設計書 11.3）。
 */
export function layoutDay(segments: readonly DaySegment[]): DayPlacement[] {
  const order = segments
    .map((segment, index) => ({ segment, index }))
    .sort(
      (a, b) =>
        a.segment.start - b.segment.start || b.segment.end - a.segment.end || a.index - b.index,
    );

  const columnOf = new Array<number>(segments.length).fill(0);
  const columnsOf = new Array<number>(segments.length).fill(1);

  // 今のグループ。
  let members: number[] = [];
  let groupEnd = 0;
  // 列ごとの、いちばん最後の終了。
  let columnEnds: number[] = [];

  const closeGroup = () => {
    for (const index of members) columnsOf[index] = columnEnds.length;
    members = [];
    columnEnds = [];
  };

  for (const { segment, index } of order) {
    if (members.length > 0 && segment.start >= groupEnd) closeGroup();

    let column = columnEnds.findIndex((end) => end <= segment.start);
    if (column === -1) column = columnEnds.length;
    columnEnds[column] = segment.end;

    columnOf[index] = column;
    members.push(index);
    groupEnd = members.length === 1 ? segment.end : Math.max(groupEnd, segment.end);
  }
  closeGroup();

  return segments.map((_, index) => ({
    column: columnOf[index] ?? 0,
    columns: columnsOf[index] ?? 1,
  }));
}
