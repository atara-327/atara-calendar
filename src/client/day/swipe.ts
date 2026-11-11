// 日表示の、左右のスワイプの判定（DV-5。設計書 11.3）。画面（Pointer Events）に依存しない。
// 縦のスクロールと区別するため、動き始めの向きで決める。タイムラインは touch-action: pan-y にして、
// 縦のスクロールはブラウザに任せる。ブラウザが縦に動かし始めると pointercancel が届くので、cancel で捨てる。

/** 横に、これだけ（px）以上動いて指を離したら、スワイプとする。 */
export const SWIPE_DISTANCE = 60;

/**
 * 離したときの速さ（px/ms）が、これ以上なら、60px に届かなくても、スワイプとする（はじいた）。
 * 1 か所の定数にして、使い心地を、ここだけで調整できるようにする。
 */
export const SWIPE_FLING_VELOCITY = 0.5;

/** 速さを測る、直近の時間（ms）。離す直前の動きだけを見るため（ゆっくり動かして、最後に止めた指を、はじきにしない）。 */
const VELOCITY_WINDOW = 100;

/** 端（範囲の外へ動かせない向き）では、指の動きの、この割合だけ動く。動かせないことを、手応えで伝えるため。 */
const EDGE_RESISTANCE = 0.3;

/** 動き始めの向きを決めるまでに、見送る距離（px）。指の、ほんの揺れで決めないため。 */
const DIRECTION_SLOP = 8;

/** 'left' は、指を左へ動かした（次の日へ）。'right' は、右へ（前の日へ）。 */
export type SwipeDirection = 'left' | 'right';

/**
 * 離したときに、どちらの隣の日へ切り替えるか（null は、元に戻る）。dx は横の動き（px）、velocity は速さ（px/ms。右が正）。
 * はじいたときは、はじいた向き。そうでなければ、60px 以上動かした向き。
 */
export function releaseDirection(dx: number, velocity: number): SwipeDirection | null {
  if (Math.abs(velocity) >= SWIPE_FLING_VELOCITY) return velocity < 0 ? 'left' : 'right';
  if (Math.abs(dx) >= SWIPE_DISTANCE) return dx < 0 ? 'left' : 'right';
  return null;
}

/**
 * 指についてくる、画面の横のずれ（px）。dx > 0（右へ）は前の日、dx < 0 は次の日が見えてくる。
 * その日が範囲の外なら、動きを小さくする。
 */
export function followOffset(dx: number, hasPrevious: boolean, hasNext: boolean): number {
  const available = dx > 0 ? hasPrevious : hasNext;
  return available ? dx : dx * EDGE_RESISTANCE;
}

/**
 * 指ごとの出来事（Pointer Events の pointerId）で受け取る。追跡するのは、最初の指（isPrimary の指）だけ。
 * 2 本目の指が触れたら、その操作は、スワイプにしない。
 * Why not 指を区別せず、最後に置いた指の位置を起点にする: 指 A を置いたあと、指 B を置くと、起点が B の位置に
 * 上書きされ、A がほとんど動いていなくても、B との距離で、日が動く判定になる（拡大などの 2 本指の操作と、
 * 取り違える）。
 */
export interface SwipeTracker {
  /** 指を置いた。最初の指（isPrimary）でなければ、追跡をやめる（2 本目の指が触れた）。 */
  start(x: number, y: number, pointerId: number, isPrimary: boolean, time: number): void;
  /**
   * 指を動かした。動き始めの向きを決めるために使う。追跡している指の出来事だけを見る。
   * 横の動きと決まっていれば、起点からの横の動き（px）。そうでなければ null。
   */
  move(x: number, y: number, pointerId: number, time: number): number | null;
  /**
   * 指を離した。追跡している指が、横にスワイプした（60px 以上、またははじいた）なら、その向き。そうでなければ null。
   * time は、出来事の時刻（ms。event.timeStamp）。速さの計算に使う。
   */
  end(x: number, pointerId: number, time: number): SwipeDirection | null;
  /** 取り消された（ブラウザが縦のスクロールを始めたとき）。追跡している指の出来事だけを見る。 */
  cancel(pointerId: number): void;
}

interface Tracking {
  pointerId: number;
  originX: number;
  originY: number;
  /** 動き始めの向き。まだ決まっていなければ null。 */
  axis: 'horizontal' | 'vertical' | null;
  /** 直近（VELOCITY_WINDOW の間）の、指の位置。速さを測る。 */
  samples: { x: number; time: number }[];
}

function recordSample(tracking: Tracking, x: number, time: number): void {
  tracking.samples.push({ x, time });
  while (
    tracking.samples.length > 2 &&
    time - (tracking.samples[0]?.time ?? time) > VELOCITY_WINDOW
  ) {
    tracking.samples.shift();
  }
}

/** 直近の速さ（px/ms。右が正）。時間が進んでいなければ 0。 */
function velocityOf(tracking: Tracking): number {
  const first = tracking.samples[0];
  const last = tracking.samples[tracking.samples.length - 1];
  if (first === undefined || last === undefined || last.time <= first.time) return 0;
  return (last.x - first.x) / (last.time - first.time);
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
    start(x, y, pointerId, isPrimary, time) {
      // 2 本目の指（isPrimary でない）が触れたら、最初の指の追跡も捨てる。以後、その操作は、スワイプにしない。
      tracking = isPrimary
        ? { pointerId, originX: x, originY: y, axis: null, samples: [{ x, time }] }
        : null;
    },
    move(x, y, pointerId, time) {
      if (tracking?.pointerId !== pointerId) return null;
      recordSample(tracking, x, time);
      const dx = x - tracking.originX;
      if (tracking.axis === null) {
        const dy = y - tracking.originY;
        if (Math.max(Math.abs(dx), Math.abs(dy)) < DIRECTION_SLOP) return null;
        // 動き始めに、横が縦より大きいときだけ、横の動き。途中から横に動いても、縦の動きのまま（斜めの指で、
        // 縦にスクロールしながら、日を動かしてしまわないため）。
        tracking.axis = Math.abs(dx) > Math.abs(dy) ? 'horizontal' : 'vertical';
      }
      return tracking.axis === 'horizontal' ? dx : null;
    },
    end(x, pointerId, time) {
      const current = tracking;
      if (current?.pointerId !== pointerId) return null;
      tracking = null;
      if (current.axis !== 'horizontal') return null;
      recordSample(current, x, time);
      return releaseDirection(x - current.originX, velocityOf(current));
    },
    cancel(pointerId) {
      if (tracking?.pointerId === pointerId) tracking = null;
    },
  };
}
