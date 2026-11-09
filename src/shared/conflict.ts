import type { Entry } from './schema';

// 食い違いの判定（設計書 6.4・5.1）。サーバーの書き込み（worker/db/store.ts・worker/api/write.ts）と、
// 端末のやり直し（client/sync/replay.ts）が、同じ決め方を使う。
// 判定の順番と、判定のあとの扱い（サーバーは 200 の「捨てた」か 4xx、端末は当てない）は、それぞれの側にある。
// Why not 1 つの関数にまとめる: サーバーは、判定の合間に DB を読み、400 の入力の検証も挟むが、端末は 400 の検証を
// 真似ない（replay.ts）。順番まで共有すると、片方にしかない段を、もう片方が読み飛ばす作りになる。
// 2 つの結果が一致することは、replay.equivalence.test.ts で確かめている。

/**
 * 今の行の編集時刻が、書く行の編集時刻以上か（同じ id の行が、まだなければ false）。
 * 「以上」にするのは、同じ依頼の 2 回目を、反映済みとして捨てるため（設計書 6.2）。
 */
export function isStale(
  row: { id: string; editedAt: number },
  current: ReadonlyMap<string, { editedAt: number }>,
): boolean {
  const stored = current.get(row.id);
  return stored !== undefined && stored.editedAt >= row.editedAt;
}

/**
 * 同じ回の例外の行か（どちらも例外の行で、系列と回の日付が同じ）。
 * 新しい行の id が、保存されている行と同じでも、同じ回の例外の行なら、ぶつかりではない（設計書 5.1）。
 */
export function isSameException(stored: Entry, written: Entry): boolean {
  return (
    stored.seriesId !== null &&
    stored.seriesId === written.seriesId &&
    stored.originalDate === written.originalDate
  );
}
