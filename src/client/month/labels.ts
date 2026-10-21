import { addDays, dateToYmd, type DateStr } from '../../shared/date';
import { isDateInSupportedYears } from '../../shared/schema';
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

/** 1 日のラベルの、年の部分（1 月 1 日だけ。「2027年」）と、月の部分（「1月」）。 */
export interface DayLabelParts {
  year: string | null;
  month: string;
}

/**
 * 各月の 1 日のマスに付けるラベル（MV-5）の部品。1 日以外と、範囲の外の日は null。
 * 年の部分を分けるのは、幅の狭い画面（スマホ）で、年だけ省けるようにするため（MonthRow.module.css）。
 */
export function dayLabelParts(date: DateStr): DayLabelParts | null {
  const { year, month, day } = dateToYmd(date);
  // 範囲（1900〜2199 年）の外の日（最後の週にはみ出した 2200-01-01 など）には、付けない。
  if (day !== 1 || !isDateInSupportedYears(date)) return null;
  return { year: month === 1 ? `${String(year)}年` : null, month: `${String(month)}月` };
}

/**
 * 各月の 1 日のマスに付けるラベル（MV-5）。「10月」。1 月 1 日だけ、年も付けて「2027年1月」。
 * 1 日以外は null。
 */
export function dayLabel(date: DateStr): string | null {
  const parts = dayLabelParts(date);
  return parts === null ? null : `${parts.year ?? ''}${parts.month}`;
}
