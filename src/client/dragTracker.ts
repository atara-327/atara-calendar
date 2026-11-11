import { LONG_PRESS_MOVE_LIMIT, LONG_PRESS_MS } from './month/longPress';

// ドラッグで予定を移す、始まり方・動き・終わりの判定（EV-6。設計書 11.2・11.3）。画面（Pointer Events）に依存しない。
// 日表示（縦の距離で時刻）と月表示（指の位置で日）が共有する。長押しの時間と、動いたら長押しをやめる距離は、
// 月表示の長押し（longPress.ts）と同じ値を使う。

/** マウスは、押してから、これだけ（px）以上動いたら、ドラッグを始める。これより小さい動きは、クリックの手ぶれ。 */
export const MOUSE_DRAG_THRESHOLD = 4;

export interface DragTracker {
  /** 指（やマウス）を置いた。最初の指（isPrimary）でなければ、追跡をやめる。 */
  start(x: number, y: number, pointerId: number, isPrimary: boolean, pointerType: string): void;
  /** 動かした。ドラッグが始まる前は、始める・やめるの判定。始まったあとは、置いた位置からの縦の距離を渡す。 */
  move(x: number, y: number, pointerId: number): void;
  /** 離した。ドラッグ中だったら、置いた位置からの縦の距離（px。下が正）を返す。そうでなければ null。 */
  end(y: number, pointerId: number): number | null;
  /** 取り消された。ドラッグ中なら、やめる。始まる前なら、追跡をやめる。 */
  cancel(pointerId: number): void;
  /** ドラッグ中か。 */
  isDragging(): boolean;
  /**
   * click を捨てるか。捨てるのは、ドラッグが始まったあとの、指（やマウス）の click だけ。判定したら、印を消す。
   * キーボードから来た click は、event.detail が 0 で、ドラッグのものではないので、捨てない。
   */
  consumeClick(detail: number): boolean;
}

export interface DragHandlers {
  /** ドラッグが始まった（スマホは長押しが成立した、PC は 4px 動いた）。 */
  onActivate: () => void;
  /** 置いた位置からの、縦の距離（px。下が正）。 */
  onMove: (dyPx: number) => void;
  /** 取り消された（ブラウザが操作を取り上げた）。 */
  onAbort: () => void;
}

interface Tracking {
  pointerId: number;
  originX: number;
  originY: number;
  /** スマホ・ペンは、長押しの待ち。PC のマウスは、動き出しの待ち。 */
  mode: 'long-press' | 'mouse';
  timer: ReturnType<typeof setTimeout> | null;
  active: boolean;
}

export function createDragTracker(handlers: DragHandlers): DragTracker {
  let tracking: Tracking | null = null;
  // ドラッグが始まった印。次の pointerdown か、click の判定まで残す（longPress.ts と同じ。
  // Why not pointerup で消す: click は pointerup のあとに来るので、消すと捨てられない）。
  let fired = false;

  function clear(): void {
    if (tracking?.timer != null) clearTimeout(tracking.timer);
    tracking = null;
  }

  function activate(current: Tracking): void {
    if (current.timer !== null) clearTimeout(current.timer);
    current.timer = null;
    current.active = true;
    fired = true;
    handlers.onActivate();
  }

  return {
    start(x, y, pointerId, isPrimary, pointerType) {
      clear();
      fired = false;
      if (!isPrimary) return;
      const current: Tracking = {
        pointerId,
        originX: x,
        originY: y,
        mode: pointerType === 'mouse' ? 'mouse' : 'long-press',
        timer: null,
        active: false,
      };
      if (current.mode === 'long-press') {
        current.timer = setTimeout(() => {
          activate(current);
        }, LONG_PRESS_MS);
      }
      tracking = current;
    },
    move(x, y, pointerId) {
      if (tracking?.pointerId !== pointerId) return;
      if (tracking.active) {
        handlers.onMove(y - tracking.originY);
        return;
      }
      const distance = Math.hypot(x - tracking.originX, y - tracking.originY);
      if (tracking.mode === 'mouse') {
        if (distance < MOUSE_DRAG_THRESHOLD) return;
        activate(tracking);
        handlers.onMove(y - tracking.originY);
      } else if (distance >= LONG_PRESS_MOVE_LIMIT) {
        // 長押しの前に動いたら、スクロールやスワイプ。ドラッグにしない。
        clear();
      }
    },
    end(y, pointerId) {
      if (tracking?.pointerId !== pointerId) return null;
      const dy = tracking.active ? y - tracking.originY : null;
      clear();
      return dy;
    },
    cancel(pointerId) {
      if (tracking?.pointerId !== pointerId) return;
      const wasActive = tracking.active;
      clear();
      if (wasActive) handlers.onAbort();
    },
    isDragging() {
      return tracking?.active === true;
    },
    consumeClick(detail) {
      const swallow = fired && detail !== 0;
      fired = false;
      return swallow;
    },
  };
}
