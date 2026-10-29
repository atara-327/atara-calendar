import { dateToDays, type DateStr } from '../../shared/date';
import { holidayName, namedDatesBetween } from '../../shared/holidays';
import { occurrencesInPeriod } from '../../shared/period';
import type { Occurrence } from '../../shared/recurrence';
import type { Entry } from '../../shared/schema';
import { formatShortDate, formatTime } from '../dateFormat';
import type { WorkspaceDisplay } from '../workspaceDisplay';
import { MINUTES_PER_DAY } from './timelineGeometry';

// その日の日表示に出す項目を、展開した回から求める（設計書 11.3）。画面に依存しない。
// 回の開始・終了を、「1970-01-01 の 0:00 からの分」にして、長さと、その日の範囲との重なりを求める。

interface BannerItemBase {
  /** 回を見分ける値。 */
  key: string;
  title: string;
  /** ワークスペースの色。祝日・記念日は、組み込みのワークスペースの色。 */
  color: string;
}

/** 上部の欄（DV-6）の、利用者の予定の 1 行。終日の予定と、24 時間以上の時間指定の予定。タイムブロックは入らない。 */
export interface EntryBannerItem extends BannerItemBase {
  source: 'entry';
  /** 複数日の期間。終日は「10/18〜10/21」、時間指定は「10/16 18:00〜10/18 20:00」。1 日だけの終日は null。 */
  period: string | null;
  /** 読み上げの名前。 */
  accessibleName: string;
  /** 押したときに開くフォームが、その回の内容を知るため。 */
  occurrence: Occurrence;
}

/**
 * 上部の欄の、祝日・記念日の 1 行。計算して出すもので、予定の行ではない。編集も削除もできないので、
 * フォームを開く回を持たず、押せない項目として出す（BannerList）。
 */
export interface NamedBannerItem extends BannerItemBase {
  source: 'holiday' | 'observance';
}

export type BannerItem = EntryBannerItem | NamedBannerItem;

/** タイムラインの 1 項目。 */
export interface TimelineItem {
  key: string;
  title: string;
  /** ワークスペースの色。タイムブロックは null。 */
  color: string | null;
  /** その日の範囲 [0, 1440) に切り取った、0:00 からの分。 */
  start: number;
  end: number;
  /** 画面に出す時刻「9:00〜10:00」。切り取っても、元の時刻（前の日からの続きは「23:00〜7:00」）。 */
  timeLabel: string;
  accessibleName: string;
  occurrence: Occurrence;
}

export interface DayItems {
  banner: BannerItem[];
  timeline: TimelineItem[];
}

function timeToMinutes(time: string | null): number {
  // 時間指定で時刻が欠けた行（本来はありえない）は、0:00 として扱う。1 行の不正で、画面全体を止めないため
  // （shared/recurrence.ts の並べ替えと同じ）。
  return time === null ? 0 : Number(time.slice(0, 2)) * 60 + Number(time.slice(3, 5));
}

/** 回の開始と終了を、「1970-01-01 の 0:00 からの分」にする。終日は、開始日の 0:00 から、最終日の翌日の 0:00 まで。 */
function absoluteRange(occurrence: Occurrence): { start: number; end: number } {
  const startDay = dateToDays(occurrence.startDate) * MINUTES_PER_DAY;
  const endDay = dateToDays(occurrence.endDate) * MINUTES_PER_DAY;
  if (occurrence.allDay) return { start: startDay, end: endDay + MINUTES_PER_DAY };
  return {
    start: startDay + timeToMinutes(occurrence.startTime),
    end: endDay + timeToMinutes(occurrence.endTime),
  };
}

/** 'HH:MM' の時刻を持つ日時。「10/16 18:00」。 */
function dateTime(date: DateStr, time: string | null): string {
  return `${formatShortDate(date)} ${formatTime(time ?? '00:00')}`;
}

function accessibleNameOf(occurrence: Occurrence, parts: readonly (string | null)[]): string {
  const prefix = occurrence.kind === 'block' ? 'タイムブロック' : null;
  return [prefix, ...parts, occurrence.title]
    .filter((part) => part !== null && part !== '')
    .join(' ');
}

function toBanner(occurrence: Occurrence, color: string): EntryBannerItem {
  const { startDate, endDate } = occurrence;
  let period: string | null;
  if (occurrence.allDay) {
    period =
      endDate > startDate ? `${formatShortDate(startDate)}〜${formatShortDate(endDate)}` : null;
  } else {
    period = `${dateTime(startDate, occurrence.startTime)}〜${dateTime(endDate, occurrence.endTime)}`;
  }
  return {
    source: 'entry',
    key: `${occurrence.entryId}:${occurrence.occurrenceDate}`,
    title: occurrence.title,
    color,
    period,
    accessibleName: accessibleNameOf(occurrence, [period, occurrence.allDay ? '終日' : null]),
    occurrence,
  };
}

function toTimeline(
  occurrence: Occurrence,
  color: string | null,
  dayStart: number,
  range: { start: number; end: number },
): TimelineItem | null {
  const start = Math.max(range.start, dayStart) - dayStart;
  const end = Math.min(range.end, dayStart + MINUTES_PER_DAY) - dayStart;
  // その日に 1 分もかからないもの。回の一覧は、その日にかかる回だけを返すので、起きないはずだが、
  // 高さ 0 の項目を、画面に出さないための守り。
  if (end <= start) return null;
  const { startDate, endDate, startTime, endTime } = occurrence;
  const datedRange = `${dateTime(startDate, startTime)}〜${dateTime(endDate, endTime)}`;
  // 24 時間以上のもの（タイムブロックだけ。予定は上部の欄に出る）は、日付も出す。時刻だけだと、
  // 「9:00〜9:00」（長さ 0 に見える）や、真ん中の日の「18:00〜20:00」（その日の 18:00〜20:00 に見える）になるため。
  const timeLabel =
    range.end - range.start >= MINUTES_PER_DAY
      ? datedRange
      : `${formatTime(startTime ?? '00:00')}〜${formatTime(endTime ?? '00:00')}`;
  return {
    key: `${occurrence.entryId}:${occurrence.occurrenceDate}`,
    title: occurrence.title,
    color,
    start,
    end,
    timeLabel,
    accessibleName: accessibleNameOf(occurrence, [endDate > startDate ? datedRange : timeLabel]),
    occurrence,
  };
}

/**
 * date の日表示に出す項目。
 * 終日の予定と、長さが 24 時間以上の時間指定の予定は、上部の欄（DV-6）。それ以外は、タイムラインで、
 * 日をまたぐものは、その日の範囲に切り取る（TB-6）。終了が翌日の 0:00 ちょうどのものは、翌日には出ない
 * （回の一覧が、回のかかる最後の日を、終了の前の日にしているため。shared の lastCoveredDate）。
 * タイムブロックは、長さによらず、タイムラインに出す。3 日にわたるものなら、真ん中の日は 0:00〜24:00 になる。
 * Why not 24 時間以上のタイムブロックも、上部の欄に出す: 要件 TB-6 は、日付をまたぐタイムブロックを、
 * 前の日と次の日に分けて表示するとしている。「24 時間以上は上部の欄」は、時間指定の予定の決まりで
 * （設計書 11.3）、タイムブロックへ広げる根拠がない。
 * タイムブロックは、ワークスペースの表示 ON/OFF によらず、常に出す（TB-3・TB-5・DV-2）。
 * 予定は、表示が ON で、削除されていないワークスペースのものだけ（WS-3）。
 * 祝日・記念日は、上部の欄の先頭に出す（祝日 → 記念日 → 予定）。休みかどうかを先に知りたいため
 * （月表示の、その日の終日の予定の先頭と同じ。設計書 11.2）。組み込みのワークスペースが OFF なら出さない。
 * 表示が OFF のワークスペースの予定を、展開の前に除かず、展開した回から除く理由は、weekViewCache.ts と同じ。
 */
export function dayItemsOf({
  entries,
  display,
  date,
}: {
  /** 全行（繰り返さない予定・系列・例外・タイムブロック。削除済みを含んでよい）。 */
  entries: readonly Entry[];
  /** ワークスペースの行から決めた、出すものの決まり（workspaceDisplayOf）。 */
  display: WorkspaceDisplay;
  date: DateStr;
}): DayItems {
  const dayStart = dateToDays(date) * MINUTES_PER_DAY;
  const banner: BannerItem[] = namedBannerItems(date, display);
  const timeline: TimelineItem[] = [];

  for (const occurrence of occurrencesInPeriod(entries, display.liveIds, date, date)) {
    let color: string | null = null;
    if (occurrence.kind === 'event') {
      const workspaceColor =
        occurrence.workspaceId === null ? undefined : display.colors.get(occurrence.workspaceId);
      if (workspaceColor === undefined) continue;
      color = workspaceColor;
    }

    const range = absoluteRange(occurrence);
    // 色を持つのは予定だけ（タイムブロックは null）。上部の欄に出るのは、予定だけ。
    if (color !== null && (occurrence.allDay || range.end - range.start >= MINUTES_PER_DAY)) {
      banner.push(toBanner(occurrence, color));
    } else {
      const item = toTimeline(occurrence, color, dayStart, range);
      if (item !== null) timeline.push(item);
    }
  }
  return { banner, timeline };
}

/** date の祝日・記念日の、上部の欄の項目。祝日 → 記念日の順。組み込みのワークスペースが OFF なら、出さない。 */
function namedBannerItems(date: DateStr, display: WorkspaceDisplay): NamedBannerItem[] {
  const named = namedDatesBetween(date, date);
  const toItem =
    (source: NamedBannerItem['source'], color: string) =>
    ({ name }: { name: string }): NamedBannerItem => ({
      source,
      key: `${source}:${date}:${name}`,
      title: name,
      color,
    });
  const { holidayBarColor, observanceBarColor } = display;
  return [
    ...(holidayBarColor === undefined
      ? []
      : named.holidays.map(toItem('holiday', holidayBarColor))),
    ...(observanceBarColor === undefined
      ? []
      : named.observances.map(toItem('observance', observanceBarColor))),
  ];
}

/**
 * date が、表示が ON の祝日か。ヘッダーの日付を赤にするか決める（月表示の日付の色と同じ決まり。設計書 11.2）。
 * 組み込みのワークスペース「祝日」が OFF なら、祝日でも false。
 */
export function isHolidayShown(date: DateStr, display: WorkspaceDisplay): boolean {
  return display.showHolidays && holidayName(date) !== null;
}
