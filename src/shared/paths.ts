import type { DateStr } from './date';

// 画面の URL のパス。画面（client/route.ts が再び出す）と、通知のリンク（worker/notify/message.ts）が使う。
// 片方だけが形を変えると、通知のリンクが、画面で開けなくなる。

/** 日表示のパス。`/day/YYYY-MM-DD`（設計書 11.1）。 */
export function dayPath(date: DateStr): string {
  return `/day/${date}`;
}
