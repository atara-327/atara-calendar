import { dateToYmd, dayOfWeek, type DateStr } from '../shared/date';

/** 曜日の 1 文字の表記。0 = 日曜 〜 6 = 土曜。 */
export const WEEKDAY_LABELS = ['日', '月', '火', '水', '木', '金', '土'] as const;

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

/** 「10/19」。月と日だけで、0 を付けない。日表示の上部の欄の期間と、読み上げの名前に使う。 */
export function formatShortDate(date: DateStr): string {
  const { month, day } = dateToYmd(date);
  return `${String(month)}/${String(day)}`;
}

/** 'HH:MM' を「9:00」にする（時の 0 を付けない）。日表示の項目の時刻と、時間軸の目盛りに使う。 */
export function formatTime(time: string): string {
  return `${String(Number(time.slice(0, 2)))}:${time.slice(3, 5)}`;
}
