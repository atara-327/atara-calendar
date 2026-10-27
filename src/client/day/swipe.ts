// 日表示の、左右のスワイプの判定（DV-5。設計書 11.3）。画面（Pointer Events）に依存しない。
// 縦のスクロールと区別するため、動き始めの向きで決める。タイムラインは touch-action: pan-y にして、
// 縦のスクロールはブラウザに任せる。ブラウザが縦に動かし始めると pointercancel が届くので、cancel で捨てる。

/** 横に、これだけ（px）以上動いて指を離したら、スワイプとする。 */
export const SWIPE_DISTANCE = 60;

/** 動き始めの向きを決めるまでに、見送る距離（px）。指の、ほんの揺れで決めないため。 */
const DIRECTION_SLOP = 8;

/** 'left' は、指を左へ動かした（次の日へ）。'right' は、右へ（前の日へ）。 */
export type SwipeDirection = 'left' | 'right';

/**
 * 指ごとの出来事（Pointer Events の pointerId）で受け取る。追跡するのは、最初の指（isPrimary の指）だけ。
 * 2 本目の指が触れたら、その操作は、スワイプにしない。
 * Why not 指を区別せず、最後に置いた指の位置を起点にする: 指 A を置いたあと、指 B を置くと、起点が B の位置に
 * 上書きされ、A がほとんど動いていなくても、B との距離で、日が動く判定になる（拡大などの 2 本指の操作と、
 * 取り違える）。
 */
export interface SwipeTracker {
  /** 指を置いた。最初の指（isPrimary）でなければ、追跡をやめる（2 本目の指が触れた）。 */
  start(x: number, y: number, pointerId: number, isPrimary: boolean): void;
  /** 指を動かした。動き始めの向きを決めるために使う。追跡している指の出来事だけを見る。 */
  move(x: number, y: number, pointerId: number): void;
  /** 指を離した。追跡している指が、横にスワイプしたなら、その向き。そうでなければ null。 */
  end(x: number, pointerId: number): SwipeDirection | null;
  /** 取り消された（ブラウザが縦のスクロールを始めたとき）。追跡している指の出来事だけを見る。 */
  cancel(pointerId: number): void;
}

interface Tracking {
  pointerId: number;
  originX: number;
  originY: number;
  /** 動き始めの向き。まだ決まっていなければ null。 */
  axis: 'horizontal' | 'vertical' | null;
}

/**
 * スワイプの直後の click を、捨てるか。捨てるのは、スワイプに続いて来た、指（やマウス）の click だけ。
 * キーボード（Enter・Space）から来た click は、event.detail が 0 で、スワイプのものではないので、捨てない。
 * Why: スワイプのあと、click が来ない端末では、「スワイプした」印が、次の pointerdown まで残る。
 * その間に、Enter で押した項目を、1 回、無視してしまう。
 */
export function isClickAfterSwipe(swiped: boolean, detail: number): boolean {
  return swiped && detail !== 0;
}

export function createSwipeTracker(): SwipeTracker {
  let tracking: Tracking | null = null;

  return {
    start(x, y, pointerId, isPrimary) {
      // 2 本目の指（isPrimary でない）が触れたら、最初の指の追跡も捨てる。以後、その操作は、スワイプにしない。
      tracking = isPrimary ? { pointerId, originX: x, originY: y, axis: null } : null;
    },
    move(x, y, pointerId) {
      if (tracking === null || tracking.pointerId !== pointerId || tracking.axis !== null) return;
      const dx = x - tracking.originX;
      const dy = y - tracking.originY;
      if (Math.max(Math.abs(dx), Math.abs(dy)) < DIRECTION_SLOP) return;
      // 動き始めに、横が縦より大きいときだけ、横の動き。途中から横に動いても、縦の動きのまま（斜めの指で、
      // 縦にスクロールしながら、日を動かしてしまわないため）。
      tracking.axis = Math.abs(dx) > Math.abs(dy) ? 'horizontal' : 'vertical';
    },
    end(x, pointerId) {
      const current = tracking;
      if (current?.pointerId !== pointerId) return null;
      tracking = null;
      if (current.axis !== 'horizontal') return null;
      const dx = x - current.originX;
      if (Math.abs(dx) < SWIPE_DISTANCE) return null;
      return dx < 0 ? 'left' : 'right';
    },
    cancel(pointerId) {
      if (tracking?.pointerId === pointerId) tracking = null;
    },
  };
}
