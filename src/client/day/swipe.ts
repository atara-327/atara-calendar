// 日表示の、左右のスワイプの判定（DV-5。設計書 11.3）。画面（Pointer Events）に依存しない。
// 縦のスクロールと区別するため、動き始めの向きで決める。タイムラインは touch-action: pan-y にして、
// 縦のスクロールはブラウザに任せる。ブラウザが縦に動かし始めると pointercancel が届くので、cancel で捨てる。

/** 横に、これだけ（px）以上動いて指を離したら、スワイプとする。 */
export const SWIPE_DISTANCE = 60;

/** 動き始めの向きを決めるまでに、見送る距離（px）。指の、ほんの揺れで決めないため。 */
const DIRECTION_SLOP = 8;

/** 'left' は、指を左へ動かした（次の日へ）。'right' は、右へ（前の日へ）。 */
export type SwipeDirection = 'left' | 'right';

export interface SwipeTracker {
  /** 指を置いた。 */
  start(x: number, y: number): void;
  /** 指を動かした。動き始めの向きを決めるために使う。 */
  move(x: number, y: number): void;
  /** 指を離した。横にスワイプしたなら、その向き。そうでなければ null。 */
  end(x: number): SwipeDirection | null;
  /** 取り消された（ブラウザが縦のスクロールを始めたとき）。 */
  cancel(): void;
}

interface Tracking {
  originX: number;
  originY: number;
  /** 動き始めの向き。まだ決まっていなければ null。 */
  axis: 'horizontal' | 'vertical' | null;
}

export function createSwipeTracker(): SwipeTracker {
  let tracking: Tracking | null = null;

  return {
    start(x, y) {
      tracking = { originX: x, originY: y, axis: null };
    },
    move(x, y) {
      if (tracking === null || tracking.axis !== null) return;
      const dx = x - tracking.originX;
      const dy = y - tracking.originY;
      if (Math.max(Math.abs(dx), Math.abs(dy)) < DIRECTION_SLOP) return;
      // 動き始めに、横が縦より大きいときだけ、横の動き。途中から横に動いても、縦の動きのまま（斜めの指で、
      // 縦にスクロールしながら、日を動かしてしまわないため）。
      tracking.axis = Math.abs(dx) > Math.abs(dy) ? 'horizontal' : 'vertical';
    },
    end(x) {
      const current = tracking;
      tracking = null;
      if (current?.axis !== 'horizontal') return null;
      const dx = x - current.originX;
      if (Math.abs(dx) < SWIPE_DISTANCE) return null;
      return dx < 0 ? 'left' : 'right';
    },
    cancel() {
      tracking = null;
    },
  };
}
