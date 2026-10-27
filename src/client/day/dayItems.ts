import { dateToDays, type DateStr } from '../../shared/date';
import { occurrencesInPeriod } from '../../shared/period';
import type { Occurrence } from '../../shared/recurrence';
import type { Entry, Workspace } from '../../shared/schema';
import { formatShortDate, formatTime } from '../dateFormat';
import { workspaceDisplayOf } from '../workspaceDisplay';
import { MINUTES_PER_DAY } from './timeline';

// その日の日表示に出す項目を、展開した回から求める（設計書 11.3）。画面に依存しない。
// 回の開始・終了を、「1970-01-01 の 0:00 からの分」にして、長さと、その日の範囲との重なりを求める。

/** 上部の欄（DV-6）の 1 行。終日の予定と、24 時間以上の時間指定の予定・タイムブロック。 */
export interface BannerItem {
  /** 回を見分ける値。 */
  key: string;
  title: string;
  /** ワークスペースの色。タイムブロックは null（色は、画面が決める。TB-5）。 */
  color: string | null;
  /** 複数日の期間。終日は「10/18〜10/21」、時間指定は「10/16 18:00〜10/18 20:00」。1 日だけの終日は null。 */
  period: string | null;
  /** 読み上げの名前。 */
  accessibleName: string;
  /** 押したときに開くフォームが、その回の内容を知るため。 */
  occurrence: Occurrence;
}

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

function toBanner(occurrence: Occurrence, color: string | null): BannerItem {
  const { startDate, endDate } = occurrence;
  let period: string | null;
  if (occurrence.allDay) {
    period =
      endDate > startDate ? `${formatShortDate(startDate)}〜${formatShortDate(endDate)}` : null;
  } else {
    period = `${dateTime(startDate, occurrence.startTime)}〜${dateTime(endDate, occurrence.endTime)}`;
  }
  return {
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
  const timeLabel = `${formatTime(startTime ?? '00:00')}〜${formatTime(endTime ?? '00:00')}`;
  return {
    key: `${occurrence.entryId}:${occurrence.occurrenceDate}`,
    title: occurrence.title,
    color,
    start,
    end,
    timeLabel,
    accessibleName: accessibleNameOf(occurrence, [
      endDate > startDate
        ? `${dateTime(startDate, startTime)}〜${dateTime(endDate, endTime)}`
        : timeLabel,
    ]),
    occurrence,
  };
}

/**
 * date の日表示に出す項目。
 * 終日と、長さが 24 時間以上のものは、上部の欄（DV-6）。それ以外は、タイムラインで、日をまたぐものは、
 * その日の範囲に切り取る（TB-6）。終了が翌日の 0:00 ちょうどのものは、翌日には出ない（回の一覧が、
 * 回のかかる最後の日を、終了の前の日にしているため。shared の lastCoveredDate）。
 * タイムブロックは、ワークスペースの表示 ON/OFF によらず、常に出す（TB-3・TB-5・DV-2）。
 * 予定は、表示が ON で、削除されていないワークスペースのものだけ（WS-3）。
 * 表示が OFF のワークスペースの予定を、展開の前に除かず、展開した回から除く理由は、weekViewCache.ts と同じ。
 */
export function dayItemsOf({
  entries,
  workspaces,
  date,
}: {
  /** 全行（繰り返さない予定・系列・例外・タイムブロック。削除済みを含んでよい）。 */
  entries: readonly Entry[];
  workspaces: Iterable<Workspace>;
  date: DateStr;
}): DayItems {
  const display = workspaceDisplayOf(workspaces);
  const dayStart = dateToDays(date) * MINUTES_PER_DAY;
  const banner: BannerItem[] = [];
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
    if (occurrence.allDay || range.end - range.start >= MINUTES_PER_DAY) {
      banner.push(toBanner(occurrence, color));
    } else {
      const item = toTimeline(occurrence, color, dayStart, range);
      if (item !== null) timeline.push(item);
    }
  }
  return { banner, timeline };
}
