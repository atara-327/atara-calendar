// 月表示の行の高さと、マスに入る予定の行数（設計書 11.2）。数値は CSS の px と対応する。

/** 画面にだいたい見える週の数。行の高さは、画面の高さをこの数で割って決める。 */
export const VISIBLE_WEEKS = 6;

/** 行の高さの下限。画面が極端に低いときに、日付の行と予定が 1 行も入らなくならないように。 */
export const MIN_ROW_HEIGHT = 84;

/** マスの上の、日付の数字と祝日名を出す行の高さ。 */
export const DATE_HEADER_HEIGHT = 24;

/** 予定 1 行（横棒・時間指定の予定・「+N件」）の高さ。 */
export const SLOT_HEIGHT = 20;

/** 画面（スクロールする領域）の高さから、行の高さを決める。全部の行が同じ高さになる（MV-6）。 */
export function rowHeightFor(viewportHeight: number): number {
  return Math.max(MIN_ROW_HEIGHT, Math.floor(viewportHeight / VISIBLE_WEEKS));
}

/** 行の高さから、マスに入る予定の行数。「+N件」の行も数える。1 行は必ず入る。 */
export function slotsFor(rowHeight: number): number {
  return Math.max(1, Math.floor((rowHeight - DATE_HEADER_HEIGHT) / SLOT_HEIGHT));
}
