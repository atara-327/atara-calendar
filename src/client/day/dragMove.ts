import { MINUTES_PER_DAY, minutesToTime } from '../../shared/date';
import { PX_PER_MINUTE } from './timelineGeometry';

// 日表示の、ドラッグで時刻を移す計算（EV-6。設計書 11.3）。画面（Pointer Events）に依存しない。
// 始まり方の判定（長押し・4px）は、月表示のドラッグ（11.2）と共有する dragTracker.ts。

/** 動かした量を、これ（分）の倍数にする。 */
export const DRAG_SNAP_MINUTES = 15;

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
