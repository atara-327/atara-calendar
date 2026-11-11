import { useSyncExternalStore } from 'react';
import type { DateStr } from '../../shared/date';

// ドラッグ中に、指（マウス）の下にあるマス（落ちる日）。マスが、自分が落ち先かを知るための、小さな外部の状態。
// Why not 親から props で渡す: 行（MonthRow）は memo で、スクロールのために描き直しを避けている（NF-6）。
// props にすると、動かすたびに、全部の行が描き直される。ここなら、落ち先の変わった 2 マスだけが描き直される。

let current: DateStr | null = null;
const listeners = new Set<() => void>();

export function setDropDate(date: DateStr | null): void {
  if (current === date) return;
  current = date;
  for (const listener of listeners) listener();
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

/** このマスが、今のドラッグの落ち先か。 */
export function useIsDropDate(date: DateStr): boolean {
  return useSyncExternalStore(subscribe, () => current === date);
}

/**
 * 画面の位置の下にあるマスの日。予定のボタンが上に重なっていても、その下のマスを探す（elementsFromPoint は、
 * 重なった要素をすべて返す）。マスは data-date を持つ。範囲（1900〜2199 年）の外のマスは持たないので、null。
 * Why not マスの座標を自分で計算する: 行の高さ・仮想スクロールの位置・曜日の列を、再現することになるため。
 */
export function dateAtPoint(x: number, y: number): DateStr | null {
  for (const element of document.elementsFromPoint(x, y)) {
    if (element instanceof HTMLElement && element.dataset.date !== undefined) {
      return element.dataset.date;
    }
  }
  return null;
}
