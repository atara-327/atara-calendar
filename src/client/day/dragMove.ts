import { MINUTES_PER_DAY, minutesToTime } from '../../shared/date';
import { LONG_PRESS_MOVE_LIMIT, LONG_PRESS_MS } from '../month/longPress';
import { PX_PER_MINUTE } from './timelineGeometry';

// 日表示の、ドラッグで時刻を移す判定（EV-6。設計書 11.3）。画面（Pointer Events）に依存しない。
// 長押しの時間と、動いたら長押しをやめる距離は、月表示の長押し（longPress.ts）と同じ値を使う。

/** 動かした量を、これ（分）の倍数にする。 */
export const DRAG_SNAP_MINUTES = 15;

/** マウスは、押してから、これだけ（px）以上動いたら、ドラッグを始める。これより小さい動きは、クリックの手ぶれ。 */
export const MOUSE_DRAG_THRESHOLD = 4;

/**
 * 縦に動かした距離（px）を、ずらす分にする。15 分の倍数に丸め、その日の中に収まる範囲で止める。
 * 終了は 23:59 まで（終了の時刻は 24:00 を書けないため）。端数の分は、そのまま残る（10:07 は、15 分下げて 10:22）。
 * start・end は、その日の 0:00 からの分。
 */
export function snapMoveMinutes(dyPx: number, start: number, end: number): number {
  const wanted = Math.round(dyPx / PX_PER_MINUTE / DRAG_SNAP_MINUTES) * DRAG_SNAP_MINUTES;
  const lowest = Math.ceil(-start / DRAG_SNAP_MINUTES) * DRAG_SNAP_MINUTES;
  const highest = Math.floor((MINUTES_PER_DAY - 1 - end) / DRAG_SNAP_MINUTES) * DRAG_SNAP_MINUTES;
  // `+ 0` は、-0 を 0 にする。
  return Math.min(Math.max(wanted, lowest), Math.max(lowest, highest)) + 0;
}

/** 開始と終了（0:00 からの分）を、同じだけずらした、'HH:MM' の組。 */
export function movedTimes(
  start: number,
  end: number,
  by: number,
): { startTime: string; endTime: string } {
  return { startTime: minutesToTime(start + by), endTime: minutesToTime(end + by) };
}

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
