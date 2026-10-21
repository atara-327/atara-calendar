import { addDays, dateToYmd, type DateStr } from '../../shared/date';
import { weekStartDate } from './weeks';

const WEDNESDAY_OFFSET = 3;

/**
 * 固定ヘッダーの年月。いちばん上に見えている週の、水曜日が属する月（設計書 11.2）。
 * 水曜日にするのは、7 日のうち真ん中で、その月が週の 4 日以上を占めるため。
 */
export function headerTitle(topWeekNumber: number): string {
  const { year, month } = dateToYmd(addDays(weekStartDate(topWeekNumber), WEDNESDAY_OFFSET));
  return `${String(year)}年${String(month)}月`;
}

/**
 * 各月の 1 日のマスに付けるラベル（MV-5）。「10月」。1 月 1 日だけ、年も付けて「2027年1月」。
 * 1 日以外は null。
 */
export function dayLabel(date: DateStr): string | null {
  const { year, month, day } = dateToYmd(date);
  if (day !== 1) return null;
  return month === 1 ? `${String(year)}年1月` : `${String(month)}月`;
}
