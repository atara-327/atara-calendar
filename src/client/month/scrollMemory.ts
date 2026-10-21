// 月表示の、いちばん上に見えている位置（先頭の週から、何週ぶん下か。小数）。
// 日表示から戻ったときや、画面の大きさが変わって作り直したときに、同じ位置を開くために覚える。
// 週ではなく「週ぶん」で覚えるのは、画面の大きさで行の高さ（px）が変わっても、同じ週が上に来るため。
// 覚えるのは、このページを開いている間だけ（保存はしない。開き直したら、今日の週から始める）。

let savedRows: number | null = null;

export function loadScrollRows(): number | null {
  return savedRows;
}

export function saveScrollRows(rows: number): void {
  savedRows = rows;
}
