import { dateToYmd, type DateStr } from './date';

// 画面（client/dateFormat.ts）と、通知の文面（worker/notify/message.ts）が、同じ表記を使うための部品。
// 通知の文面は「画面の表記と同じ」にする（設計書 9.4）ので、Worker 側に同じ関数を書き写さず、ここに置く。

/** 曜日の 1 文字の表記。0 = 日曜 〜 6 = 土曜。 */
export const WEEKDAY_LABELS = ['日', '月', '火', '水', '木', '金', '土'] as const;

/** 「10/19」。月と日だけで、0 を付けない。 */
export function formatShortDate(date: DateStr): string {
  const { month, day } = dateToYmd(date);
  return `${String(month)}/${String(day)}`;
}

/** 'HH:MM' を「9:00」にする（時の 0 を付けない）。 */
export function formatTime(time: string): string {
  return `${String(Number(time.slice(0, 2)))}:${time.slice(3, 5)}`;
}
