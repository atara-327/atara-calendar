import { dateToYmd, dayOfWeek, type DateStr } from '../shared/date';
import { WEEKDAY_LABELS } from '../shared/dateFormat';

// 通知の文面（Worker）と共通の表記は、shared/dateFormat.ts にある。画面の import を変えずに済むよう、ここから再び出す。
export { WEEKDAY_LABELS, formatShortDate, formatTime } from '../shared/dateFormat';

/** 「2026年」。日表示のヘッダーは、幅の狭い画面で、年だけを省くので、月日と別に取り出せるようにしている。 */
export function formatYear(date: DateStr): string {
  return `${String(dateToYmd(date).year)}年`;
}

/** 「2026年10月21日（水）」。 */
export function formatDayTitle(date: DateStr): string {
  return `${formatYear(date)}${formatMonthDay(date)}`;
}

/** 「10月22日（木）」。年は付けない。マスのリンクの読み上げの名前に使う。 */
export function formatMonthDay(date: DateStr): string {
  const { month, day } = dateToYmd(date);
  const weekday = WEEKDAY_LABELS[dayOfWeek(date)] ?? '';
  return `${String(month)}月${String(day)}日（${weekday}）`;
}
