import { addDays, dateToDays, daysToDate, ymdToDate, type DateStr } from '../../shared/date';
import { MAX_YEAR, MIN_YEAR } from '../../shared/solarTerms';

// 月表示の行（週）の番号。「1970-01-04（日曜）から何週目か」を週の番号とし、その週の日曜日が
// 日付に対応する。週は日曜始まり（MV-2）。1970-01-04 より前の週は、負の番号になる。
// 仮想スクロールの行の番号（0 から）は、先頭の週の番号を引いた値にする（rowOfWeek）。

const DAYS_PER_WEEK = 7;
const WEEK_ZERO_DAYS = dateToDays('1970-01-04');

/** スクロールできる範囲（設計書 Q2）。1900 年 1 月 1 日〜2199 年 12 月 31 日。 */
export const MIN_DATE: DateStr = ymdToDate(MIN_YEAR, 1, 1);
export const MAX_DATE: DateStr = ymdToDate(MAX_YEAR, 12, 31);

/** 日付が属する週の番号。 */
export function weekNumberOf(date: DateStr): number {
  return Math.floor((dateToDays(date) - WEEK_ZERO_DAYS) / DAYS_PER_WEEK);
}

/** 週の番号から、その週の日曜日の日付。 */
export function weekStartDate(weekNumber: number): DateStr {
  return daysToDate(WEEK_ZERO_DAYS + weekNumber * DAYS_PER_WEEK);
}

/** 週の 7 日分の日付（日曜から土曜）。 */
export function weekDates(weekNumber: number): DateStr[] {
  const start = weekStartDate(weekNumber);
  return Array.from({ length: DAYS_PER_WEEK }, (_, offset) => addDays(start, offset));
}

/** 表示できる最初の週（1900-01-01 を含む週）と最後の週（2199-12-31 を含む週）の番号。 */
export const FIRST_WEEK_NUMBER = weekNumberOf(MIN_DATE);
export const LAST_WEEK_NUMBER = weekNumberOf(MAX_DATE);

/** 表示できる週の数。 */
export const WEEK_COUNT = LAST_WEEK_NUMBER - FIRST_WEEK_NUMBER + 1;

/** 週の番号から、仮想スクロールの行の番号（0 始まり）。 */
export function rowOfWeek(weekNumber: number): number {
  return weekNumber - FIRST_WEEK_NUMBER;
}

/** 仮想スクロールの行の番号から、週の番号。 */
export function weekOfRow(row: number): number {
  return row + FIRST_WEEK_NUMBER;
}

/** 日付が、表示できる範囲（1900〜2199 年）の中か。 */
export function isInRange(date: DateStr): boolean {
  return date >= MIN_DATE && date <= MAX_DATE;
}

/** 範囲の外にはみ出した日付を、範囲の端に寄せる。祝日の計算が対応するのは、1900〜2199 年だけのため。 */
export function clampToRange(date: DateStr): DateStr {
  if (date < MIN_DATE) return MIN_DATE;
  if (date > MAX_DATE) return MAX_DATE;
  return date;
}

/** 最初に開いたときと、「今日」ボタンで、今日の週を、上から何行目に置くか（0 始まり。2 行目）。 */
const TODAY_ROW_FROM_TOP = 1;

/**
 * 今日の週が、画面の上から 2 行目に来るときの、スクロールの位置（先頭の週から、何週ぶん下か）。
 * 2 行目にするのは、先週の予定も少し見えるようにするため（設計書 11.2）。
 */
export function scrollRowsForToday(today: DateStr): number {
  return rowOfWeek(weekNumberOf(today)) - TODAY_ROW_FROM_TOP;
}
