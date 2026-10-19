import { addDays, dateToDays, dateToYmd, dayOfWeek, type DateStr } from './date';
import { isDayOff, isWeekday } from './holidays';
import type { Rrule } from './schema';

/** 回の判定に必要な、系列の列。 */
export interface SeriesRule {
  readonly rrule: Rrule;
  readonly startDate: DateStr;
  /** その日の回までで終わる（その日を含む）。null なら終わりがない（RP-3）。 */
  readonly untilDate: DateStr | null;
}

export interface DateRange {
  startDate: DateStr;
  endDate: DateStr;
}

function matchesRule(rrule: Rrule, startDate: DateStr, date: DateStr): boolean {
  switch (rrule.freq) {
    case 'daily':
      return true;
    case 'weekly':
      return rrule.days.includes(dayOfWeek(date));
    case 'monthly':
      // その日がない月（2月の31日など）は、日が一致する日が存在しないので、数えなくてもスキップになる。
      return dateToYmd(date).day === dateToYmd(startDate).day;
    case 'yearly': {
      // うるう年でない年の 2/29 は、存在しない日なので、同じ理由でスキップになる（設計書 Q9）。
      const target = dateToYmd(date);
      const start = dateToYmd(startDate);
      return target.month === start.month && target.day === start.day;
    }
    case 'weekday':
      return isWeekday(date);
    case 'holiday':
      return isDayOff(date);
  }
}

/** date が、その系列の回にあたるか。開始日より前と、untilDate より後は回ではない。 */
export function isOccurrenceDate(series: SeriesRule, date: DateStr): boolean {
  const days = dateToDays(date);
  if (days < dateToDays(series.startDate)) return false;
  if (series.untilDate !== null && days > dateToDays(series.untilDate)) return false;
  return matchesRule(series.rrule, series.startDate, date);
}

// ずらす必要があるのは weekly・weekday・holiday だけ（daily・monthly・yearly は開始日が基準なので、必ず合う）。
// どれも 1 週間以内に合う日が来る。366 日は、合う日が見つからないルール（曜日が空の weekly など）で、
// 無限に探さないための上限。
const MAX_NORMALIZE_DAYS = 366;

/**
 * 開始日がルールに合わないとき、ルールに合う最初の日（開始日以降）へ開始日をずらす（設計書 4.4）。
 * 終了日も同じ日数ずらして、1 回の長さを保つ。
 */
export function normalizeStart(rrule: Rrule, { startDate, endDate }: DateRange): DateRange {
  for (let shift = 0; shift <= MAX_NORMALIZE_DAYS; shift++) {
    const candidate = addDays(startDate, shift);
    if (matchesRule(rrule, startDate, candidate)) {
      return shift === 0
        ? { startDate, endDate }
        : { startDate: candidate, endDate: addDays(endDate, shift) };
    }
  }
  throw new RangeError(
    `${startDate} から ${String(MAX_NORMALIZE_DAYS)} 日以内に、ルールに合う日がありません`,
  );
}
