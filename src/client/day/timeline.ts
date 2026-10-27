import { formatTime } from '../dateFormat';

// 日表示のタイムラインの、大きさと位置の決まり（設計書 11.3）。画面に依存しない。
// 数値は CSS の px と対応する（DayView.module.css）。時間は、その日の 0:00 からの分。

export const MINUTES_PER_DAY = 24 * 60;

/** 1 時間の高さ（px）。15 分刻み（DV-3）の項目でも、題名が 1 行読める高さにするため（設計書 11.3）。 */
export const HOUR_HEIGHT = 60;

/** 1 分の高さ（px）。 */
export const PX_PER_MINUTE = HOUR_HEIGHT / 60;

/** タイムライン全体の高さ（px）。0:00〜24:00。 */
export const DAY_HEIGHT = MINUTES_PER_DAY * PX_PER_MINUTE;

/** 項目の最小の高さ（px）。時刻は 15 分刻みで、終了は開始より後なので、15 分（15px）以上になる。 */
export const MIN_ITEM_HEIGHT = 15 * PX_PER_MINUTE;

/** 2 行目に時刻を出せる、項目の高さ（px）。これより低い項目は、題名の 1 行だけにする。 */
export const TWO_LINE_HEIGHT = 30 * PX_PER_MINUTE;

/** 空いているところをタップしたときの、開始の時刻の単位（分。DV-3）。 */
export const TAP_SNAP_MINUTES = 15;

/** 最初に表示する位置が決まらないとき（他の日で、タイムラインに項目がない）の、時刻（分）。8:00。 */
export const FALLBACK_TOP_MINUTE = 8 * 60;

/** 今日を開いたとき、今の時刻より、どれだけ前から表示するか（分）。 */
const LEAD_BEFORE_NOW_MINUTES = 60;

/** 分（0〜1439）を 'HH:MM' にする。 */
export function minutesToTime(minutes: number): string {
  const hour = Math.floor(minutes / 60);
  return `${String(hour).padStart(2, '0')}:${String(minutes - hour * 60).padStart(2, '0')}`;
}

/**
 * タイムラインの、いちばん上に出す時刻（0:00 からの分）。設計書 11.3。
 * 今日は、今の時刻の 1 時間前。他の日は、タイムラインの最初の項目の開始（上部の欄の項目は数えない。
 * 前の日から続く項目は 0:00）。項目がなければ 8:00。
 * Why: 開いたときに、いちばん見たいところが、すぐ見えるようにするため。
 */
export function initialTopMinute({
  isToday,
  nowMinute,
  firstItemStart,
}: {
  isToday: boolean;
  /** 今の、日本時間の 0:00 からの分（0〜1439）。 */
  nowMinute: number;
  /** その日のタイムラインの、最初の項目の開始。項目がなければ null。 */
  firstItemStart: number | null;
}): number {
  if (isToday) return Math.max(0, nowMinute - LEAD_BEFORE_NOW_MINUTES);
  return firstItemStart ?? FALLBACK_TOP_MINUTE;
}

/**
 * 空いているところをタップしたときの、開始の時刻。タイムラインの上端からの距離（px）を、
 * 15 分単位に切り下げる。23:30 をタップしたら、23:30（1 時間の項目は、翌日の 0:30 まで。TB-6）。
 * 範囲の外（上端より上・下端より下）は、端に寄せる。
 */
export function tapStartTime(offsetY: number): string {
  const minute = Math.floor(offsetY / PX_PER_MINUTE);
  const clamped = Math.min(Math.max(minute, 0), MINUTES_PER_DAY - 1);
  return minutesToTime(Math.floor(clamped / TAP_SNAP_MINUTES) * TAP_SNAP_MINUTES);
}

/** 時間軸の目盛りの文字（「0:00」〜「23:00」）。 */
export const HOUR_LABELS: readonly string[] = Array.from({ length: 24 }, (_, hour) =>
  formatTime(minutesToTime(hour * 60)),
);
