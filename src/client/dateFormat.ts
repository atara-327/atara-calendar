import { dateToYmd, dayOfWeek, type DateStr } from '../shared/date';

/** 曜日の 1 文字の表記。0 = 日曜 〜 6 = 土曜。 */
export const WEEKDAY_LABELS = ['日', '月', '火', '水', '木', '金', '土'] as const;

/** 「2026年10月21日（水）」。 */
export function formatDayTitle(date: DateStr): string {
  const { year, month, day } = dateToYmd(date);
  const weekday = WEEKDAY_LABELS[dayOfWeek(date)] ?? '';
  return `${String(year)}年${String(month)}月${String(day)}日（${weekday}）`;
}
