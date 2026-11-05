// 月表示の、日のマスの長押しの判定（MV-11。設計書 11.2）。画面（Pointer Events）に依存しない。
// 長押しの間に指が動いたら、スクロールとみなして、長押しにしない。ブラウザが縦のスクロールを始めると
// pointercancel が届くので、それでも捨てる。

/** これだけ（ミリ秒）押し続けたら、長押しとする。 */
export const LONG_PRESS_MS = 500;

/** 押している間に、この距離（px）以上動いたら、長押しをやめる。 */
export const LONG_PRESS_MOVE_LIMIT = 10;

export interface LongPressTracker {
  /** 指（やマウス）を置いた。最初の指（isPrimary）でなければ、追跡をやめる。 */
  start(x: number, y: number, pointerId: number, isPrimary: boolean): void;
  /** 動かした。LONG_PRESS_MOVE_LIMIT 以上、置いた位置から離れたら、長押しをやめる。 */
  move(x: number, y: number, pointerId: number): void;
  /** 離した・取り消された。長押しが成立する前なら、やめる。成立したあとの click の判定には、影響しない。 */
  stop(pointerId: number): void;
  /**
   * click を捨てるか。捨てるのは、長押しが成立した直後の、指（やマウス）の click だけ。判定したら、印を消す。
   * キーボードから来た click は、event.detail が 0 で、長押しのものではないので、捨てない
   * （isClickAfterSwipe と同じ。日表示の swipe.ts）。
   */
  consumeClick(detail: number): boolean;
}

interface Pressing {
  pointerId: number;
  originX: number;
  originY: number;
  timer: ReturnType<typeof setTimeout>;
}

export function createLongPressTracker(onLongPress: () => void): LongPressTracker {
  let pressing: Pressing | null = null;
  // 長押しが成立した印。次の pointerdown か、click の判定まで残す。
  // Why not pointerup で消す: click は pointerup のあとに来るので、消すと、捨てられない。
  let fired = false;

  function clear(): void {
    if (pressing !== null) clearTimeout(pressing.timer);
    pressing = null;
  }

  return {
    start(x, y, pointerId, isPrimary) {
      clear();
      fired = false;
      if (!isPrimary) return;
      const timer = setTimeout(() => {
        pressing = null;
        fired = true;
        onLongPress();
      }, LONG_PRESS_MS);
      pressing = { pointerId, originX: x, originY: y, timer };
    },
    move(x, y, pointerId) {
      if (pressing?.pointerId !== pointerId) return;
      if (Math.hypot(x - pressing.originX, y - pressing.originY) >= LONG_PRESS_MOVE_LIMIT) clear();
    },
    stop(pointerId) {
      if (pressing?.pointerId === pointerId) clear();
    },
    consumeClick(detail) {
      const swallow = fired && detail !== 0;
      fired = false;
      return swallow;
    },
  };
}
