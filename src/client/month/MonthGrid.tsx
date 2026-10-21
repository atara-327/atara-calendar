import { useVirtualizer } from '@tanstack/react-virtual';
import { useLayoutEffect, useMemo, useState } from 'react';
import type { DateStr } from '../../shared/date';
import { useSyncState } from '../sync/instance';
import styles from './MonthView.module.css';
import { MonthRow } from './MonthRow';
import { loadScrollRows, saveScrollRows } from './scrollMemory';
import { slotsFor } from './sizing';
import { createViewSelector } from './stableRows';
import { WeekViewCache } from './weekViewCache';
import { WEEK_COUNT, scrollRowsForToday, weekOfRow } from './weeks';

// 画面に見えている行の前後に、余分に描く行の数。速くスクロールしたときに、空白が見えないようにする。
const OVERSCAN_ROWS = 4;

interface MonthGridProps {
  scrollElement: HTMLElement;
  /** スクロールする領域の高さ。 */
  viewportHeight: number;
  rowHeight: number;
  today: DateStr;
  /** いちばん上に見える行が変わったときに呼ぶ（固定ヘッダーの年月を変えるため）。 */
  onTopRowChange: (row: number) => void;
}

/**
 * 週の行の仮想スクロール（MV-1）。画面に見えている行（と少しの余白）だけを描く。
 * 行の高さは全部同じ（MV-6）なので、行の位置は、番号 × 高さで決まる。行の高さを測らない。
 * 画面の大きさが変わって行の高さが変わるときは、呼び出し側が、key を変えて作り直す。
 * 作り直しても、同じ位置を開く（scrollMemory。位置は onChange で覚える）。
 */
export function MonthGrid({
  scrollElement,
  viewportHeight,
  rowHeight,
  today,
  onTopRowChange,
}: MonthGridProps) {
  // 行が変わっていなければ、同じ view が返る（受け取りのたびに、週の情報を計算し直さないため。stableRows.ts）。
  const [selectView] = useState(createViewSelector);
  const view = useSyncState(selectView);
  const slots = slotsFor(rowHeight);

  // データ（view）か、マスに入る行数が変わったときだけ、作り直す。スクロールでは作り直さない（NF-6）。
  const cache = useMemo(
    () =>
      new WeekViewCache({
        entries: [...view.entries.values()],
        workspaces: view.workspaces.values(),
        slots,
      }),
    [view, slots],
  );

  // useVirtualizer が返す関数は、React Compiler の自動のメモ化と合わない、という警告が出る。
  // このプロジェクトは React Compiler を使っていない（手でメモ化している）ので、警告の通りの問題は起きない。
  // eslint-disable-next-line react-hooks/incompatible-library
  const virtualizer = useVirtualizer({
    count: WEEK_COUNT,
    getScrollElement: () => scrollElement,
    estimateSize: () => rowHeight,
    overscan: OVERSCAN_ROWS,
    // 最初の描画から、開く位置の行を描く。省くと、いったん空で描いてから、描き直す。
    initialOffset: () => (loadScrollRows() ?? scrollRowsForToday(today)) * rowHeight,
    initialRect: { width: 0, height: viewportHeight },
    onChange: (instance) => {
      // 日表示から戻ったとき・画面の大きさが変わって作り直したときに、同じ位置を開けるよう、位置を覚える。
      // 呼ばれるのは、見える行が変わったときと、スクロールが始まった・止まったとき。止まったときの値が、最後の位置になる。
      // scrollOffset は、ライブラリがスクロールの出来事で持っている値なので、DOM（scrollTop）を読まない。
      // 読むと、ブラウザが、その場でレイアウトをやり直す（強制リフロー）。
      // 後片付け（下の useLayoutEffect）だけで覚える形にしないのは、作り直すとき、新しい MonthGrid が覚えた位置を読む
      // （initialOffset）のが、古い MonthGrid の後片付けより先になり、古い位置に飛ぶため。
      // 新しいインスタンスの最初の onChange は、initialOffset を当てた値なので、覚えた位置を、0 などで上書きしない。
      saveScrollRows((instance.scrollOffset ?? 0) / rowHeight);
      const first = instance.range?.startIndex;
      if (first !== undefined) onTopRowChange(first);
    },
  });

  // 画面が消えるときにも、位置を覚える。onChange は、見える行か isScrolling が変わったときだけ呼ばれるので、
  // スクロールの途中や、止まってから isScrolling が false になるまで（約 150ms）に日表示へ移ると、
  // 最後の onChange のあとの動きが、覚えた位置に入らず、1 行未満ずれる。
  // virtualizer.scrollOffset を読むので、DOM（scrollTop）には触れず、強制リフローは起きない。
  // 作り直すとき（key が変わるとき）は、新しい MonthGrid が覚えた位置を読んだ後に動くので、害はない
  // （同じ週の位置を、覚え直すだけ）。
  useLayoutEffect(
    () => () => {
      saveScrollRows((virtualizer.scrollOffset ?? 0) / rowHeight);
    },
    [virtualizer, rowHeight],
  );

  return (
    <div className={styles.sizer} style={{ height: virtualizer.getTotalSize() }}>
      {virtualizer.getVirtualItems().map((item) => (
        <div
          key={item.key}
          className={styles.rowFrame}
          style={{ height: rowHeight, transform: `translateY(${String(item.start)}px)` }}
        >
          <MonthRow view={cache.get(weekOfRow(item.index))} slots={slots} today={today} />
        </div>
      ))}
    </div>
  );
}
