/**
 * 文字列を、文字コードの順で比べる（sort の比較関数）。日付（'YYYY-MM-DD'）・時刻（'HH:MM'）・id の並べ替えに使う。
 * localeCompare にしない: 端末やサーバーのロケールで並びが変わり、画面と Worker で順番が食い違うため。
 */
export function compareText(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}
