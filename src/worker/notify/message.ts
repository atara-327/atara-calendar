import { dateToDays, dayOfWeek, utcMsToJstDate, type DateStr } from '../../shared/date';
import { WEEKDAY_LABELS, formatShortDate, formatTime } from '../../shared/dateFormat';
import { dayPath } from '../../shared/paths';
import type { Occurrence } from '../../shared/recurrence';
import { notifyAtMs } from './nextNotifyAt';

// Discord に送る通知の文面（設計書 9.4）。純粋な関数だけで、送信は discord.ts が行う。

/** 文面に使う、回の項目。 */
export type NotifyMessageFields = Pick<
  Occurrence,
  | 'title'
  | 'allDay'
  | 'startDate'
  | 'startTime'
  | 'endDate'
  | 'endTime'
  | 'location'
  | 'notifyOffsetMin'
>;

/** Discord の content の上限（文字数）。 */
export const DISCORD_CONTENT_LIMIT = 2000;

const MINUTES_PER_HOUR = 60;
const MINUTES_PER_DAY = 24 * MINUTES_PER_HOUR;

/** 「1日1時間30分」。0 でない単位だけを並べる。minutes は 1 以上。 */
function formatDuration(minutes: number): string {
  const days = Math.floor(minutes / MINUTES_PER_DAY);
  const hours = Math.floor((minutes % MINUTES_PER_DAY) / MINUTES_PER_HOUR);
  const rest = minutes % MINUTES_PER_HOUR;
  return [
    days > 0 ? `${String(days)}日` : '',
    hours > 0 ? `${String(hours)}時間` : '',
    rest > 0 ? `${String(rest)}分` : '',
  ].join('');
}

/** 時間指定の「いつ」。開始の何分前か（負なら、開始の何分後か）で決まる。 */
function timedWhen(notifyOffsetMin: number): string {
  if (notifyOffsetMin === 0) return '今から';
  if (notifyOffsetMin > 0) return `${formatDuration(notifyOffsetMin)}後`;
  return `開始から${formatDuration(-notifyOffsetMin)}`;
}

/**
 * 終日の「いつ」。通知の日（日本時間）と開始日の差で決まる。通知の分は 0:00 からの分なので（設計書 4.3）、
 * 「何分後」では言わない（-360 は「6時間後」ではなく、「今日」と言いたい）。
 */
function allDayWhen(fields: NotifyMessageFields): string {
  const notifyDate = utcMsToJstDate(notifyAtMs(fields));
  const daysUntilStart = dateToDays(fields.startDate) - dateToDays(notifyDate);
  if (daysUntilStart === 0) return '今日';
  if (daysUntilStart === 1) return '明日';
  if (daysUntilStart > 1) return `${String(daysUntilStart)}日後`;
  // 通知の分の下限は -1440 なので、-1 だけが入力の範囲に収まる。範囲の外の値も、文面は作れるようにしておく。
  if (daysUntilStart === -1) return '昨日から';
  return `${String(-daysUntilStart)}日前から`;
}

/** 「10/19（月）」。 */
function formatDateWithWeekday(date: DateStr): string {
  return `${formatShortDate(date)}（${WEEKDAY_LABELS[dayOfWeek(date)] ?? ''}）`;
}

/** 時間指定の日時の行。「10/19（月）15:00〜16:00」。日をまたぐときは、終わりにも日付を付ける。 */
function timedRange(fields: NotifyMessageFields): string {
  const { startDate, startTime, endDate, endTime } = fields;
  const start = `${formatDateWithWeekday(startDate)}${startTime === null ? '' : formatTime(startTime)}`;
  const endTimeText = endTime === null ? '' : formatTime(endTime);
  const end =
    endDate === startDate ? endTimeText : `${formatDateWithWeekday(endDate)}${endTimeText}`;
  return end === '' ? start : `${start}〜${end}`;
}

/** 文字数が maxLength（UTF-16 の単位）を超えるときは、最後を「…」にして収める。サロゲートペアの途中では切らない。 */
function truncate(text: string, maxLength: number): string {
  if (text.length <= maxLength) return text;
  if (maxLength <= 0) return '';
  let kept = '';
  for (const char of text) {
    if (kept.length + char.length > maxLength - 1) break;
    kept += char;
  }
  return `${kept}…`;
}

/**
 * 通知の文面。時間指定は 4 行（場所がなければ 3 行）、終日は 2 行（場所がなければ 1 行少ない）。
 * 最後の行は、その回の開始日の日表示へのリンク。appOrigin は、末尾の / があってもよい。
 * Discord の上限（2000 文字）を超えるときは、題名と場所を切り詰める。上限に収めるのは、超えると Discord が
 * 400 を返し、通知が届かないため。リンクと日時は、通知の用が足りなくなるので、切らない。
 */
export function buildNotifyMessage(fields: NotifyMessageFields, appOrigin: string): string {
  const hasLocation = fields.location !== null && fields.location.trim() !== '';
  const multiDayAllDay = fields.allDay && fields.startDate !== fields.endDate;
  const when = fields.allDay ? allDayWhen(fields) : timedWhen(fields.notifyOffsetMin);
  const period = multiDayAllDay
    ? `（${formatShortDate(fields.startDate)}〜${formatShortDate(fields.endDate)}）`
    : '';
  const link = `${appOrigin.replace(/\/+$/, '')}${dayPath(fields.startDate)}`;

  const compose = (title: string, location: string | null): string =>
    [
      `🔔 ${when}: ${title}${period}`,
      ...(fields.allDay ? [] : [timedRange(fields)]),
      ...(location === null ? [] : [`📍 ${location}`]),
      link,
    ].join('\n');

  const location = hasLocation ? (fields.location ?? '') : null;
  const budget = DISCORD_CONTENT_LIMIT - compose('', location === null ? null : '').length;
  if (fields.title.length + (location?.length ?? 0) <= budget)
    return compose(fields.title, location);

  // 場所は、予算の半分までは削らない。長い題名が、場所を押し出さないようにするため。題名は、場所が使い残した分を使う。
  const locationReserve = Math.min(location?.length ?? 0, Math.floor(budget / 2));
  const title = truncate(fields.title, budget - locationReserve);
  return compose(title, location === null ? null : truncate(location, budget - title.length));
}
