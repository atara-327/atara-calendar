import { formatMonthDay } from '../dateFormat';
import type { MonthEvent } from './layout';

/**
 * 予定のボタンの読み上げ名。「10月22日（木） 15:00 歯医者」「10月22日（木） 終日 誕生日」。
 * 複数日の予定（横棒）は、開始日〜最後の日を入れる（「10月22日（木）〜10月24日（土） 終日 帰省」）。
 * 日付を入れるのは、月表示では、予定の位置（どの日のマスか）で日付が分かるが、読み上げでは、題名だけだと、
 * いつの予定か分からないため。「+N件」の読み上げ（MonthRow）と同じく、年は付けず、曜日を付ける。
 * 時刻は、スマホの幅では画面から省く（設計書 11.2）が、読み上げには入れる（画面が省くのは、幅が足りないため）。
 * 週をまたいで切れた横棒も、予定全体の日付を読み上げる（event の startDate・lastDate は、予定全体のもの）。
 */
export function eventAccessibleName(event: MonthEvent): string {
  const dates =
    event.lastDate > event.startDate
      ? `${formatMonthDay(event.startDate)}〜${formatMonthDay(event.lastDate)}`
      : formatMonthDay(event.startDate);
  const when = event.allDay ? '終日' : (event.startTime ?? '');
  return [dates, when, event.title].filter((part) => part !== '').join(' ');
}
