import type { RowSet } from '../sync/replay';
import type { SyncState } from '../sync/state';

function sameRowsInMap<T>(a: ReadonlyMap<string, T>, b: ReadonlyMap<string, T>): boolean {
  if (a.size !== b.size) return false;
  for (const [id, row] of a) {
    if (b.get(id) !== row) return false;
  }
  return true;
}

function sameRows(a: RowSet, b: RowSet): boolean {
  return sameRowsInMap(a.workspaces, b.workspaces) && sameRowsInMap(a.entries, b.entries);
}

/**
 * 画面に出すデータ（view）を読む selector。中身（行）が前と同じなら、前と同じ参照を返す。
 * 呼び出しごとに、新しい selector を作る（前の値を、selector の中に覚えているため）。
 *
 * 同期のエンジンは、サーバーから受け取るたびに（変更がなくても、60 秒ごとに）、view の参照を作り直す。
 * 参照が変わるたびに、月表示の週ごとの情報（weekViewCache）を捨てて計算し直すと、何も変わっていないのに、
 * 1 分ごとにスクロールが引っかかる（NF-6）。そこで、行の参照が全部同じなら、同じ view として扱う。
 * 変わった行は、行ごと新しい参照になる（変更のない行は、同じ参照のまま。replay.ts・http.ts の mergeChanges）ので、
 * 行の参照の比較で、中身の変化を見逃さない。
 */
export function createViewSelector(): (state: SyncState) => RowSet {
  let last: RowSet | null = null;
  let lastSource: RowSet | null = null;
  return (state) => {
    // 同じ view が続けて渡されたときは、行を比べない（描画のたびに呼ばれるので、数千行の比較を毎回しないため）。
    if (state.view === lastSource && last !== null) return last;
    lastSource = state.view;
    if (last === null || !sameRows(last, state.view)) last = state.view;
    return last;
  };
}
