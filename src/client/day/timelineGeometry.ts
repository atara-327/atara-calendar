import type { DateStr } from '../../shared/date';
import { utcMsToJstMinuteOfDay } from '../../shared/date';
import { formatTime } from '../dateFormat';
import type { StartPoint } from '../form/schedule';

// 日表示のタイムラインの、大きさと位置の決まり（設計書 11.3）。画面に依存しない。
// ファイル名を timeline.ts にしない: 同じフォルダの Timeline.tsx と、大文字小文字だけが違い、大文字小文字を
// 区別しないファイルシステム（macOS・Windows）で、`./Timeline` が、このファイルに解決されるため。
// 数値は CSS の px と対応する（Timeline.module.css）。時間は、その日の 0:00 からの分。

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

/** 分（0〜1440）を 'HH:MM' にする。1440 は、タイムラインの下端の目盛り「24:00」。 */
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

/** 最初の位置を置いたときの、日付と、最初の読み込みが終わっていたか。 */
export interface PlacedState {
  date: DateStr;
  ready: boolean;
}

/**
 * 最初の位置を、置く（決め直す）か。previous は、前に置いたときの状態で、まだ置いていなければ null。
 * 置くのは、最初の描画と、日付が変わったとき（‹ ›・スワイプ・［今日］）と、同じ日のまま、最初の読み込みが
 * 終わったとき（`/day/...` を直接開くと、読み込みの前は、データがないので、決まりどおりの位置を決められない）。
 * 同じ日のまま、同期でデータが変わっても、置かない。見ている位置が、勝手に動いてしまうため。
 */
export function shouldPlace(previous: PlacedState | null, current: PlacedState): boolean {
  if (previous === null || previous.date !== current.date) return true;
  return !previous.ready && current.ready;
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

/**
 * 日表示の ( + ) ボタンの、開始。見ている日の、今の次の正時。ちょうど正時のときも、その 1 時間後。
 * 23 時台は、見ている日の 23:00（日は変えず、時刻を、その日の中に収める）。
 * 日は、見ている日のまま（今日以外を見ているときも）。日表示は、その日の時間割を立てる場所のため（設計書 11.3）。
 * Why not form/schedule.ts の nextFullHour: 23 時台は、翌日の 0:00 を返す。その時刻だけを使うと、
 * 今日を見ていて 23:20 に押したとき、23 時間以上前の、タイムラインの反対の端に作ってしまう。
 * 「開いてすぐ、これから使う時間帯になっている」（設計書 11.4）とも、逆になる。
 */
export function addButtonStart(date: DateStr, nowMs: number): StartPoint {
  const hour = Math.min(Math.floor(utcMsToJstMinuteOfDay(nowMs) / 60) + 1, 23);
  return { date, time: minutesToTime(hour * 60) };
}

/**
 * 時間軸の目盛りの文字（「0:00」〜「24:00」。25 個）。24:00 は、タイムラインの下端（1440px）の目盛りで、
 * 23 時台の項目が、どこまで続くか（23:30 までか、24:00 までか）を、見て分かるようにするため（設計書 11.3）。
 */
export const HOUR_LABELS: readonly string[] = Array.from({ length: 25 }, (_, hour) =>
  formatTime(minutesToTime(hour * 60)),
);
