import { addDays, dateToDays, dateToYmd, dayOfWeek, daysToDate, type DateStr } from './date';
import { isDayOff, isWeekday } from './holidays';
import type { Entry, Rrule } from './schema';

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

function diffDays(from: DateStr, to: DateStr): number {
  return dateToDays(to) - dateToDays(from);
}

function compareStrings(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

type CoverageFields = Pick<Entry, 'allDay' | 'startDate' | 'endDate' | 'endTime'>;

/**
 * 回が「かかる」最後の日（設計書 7章）。終日は endDate（その日を含む）。
 * 時間指定は endDate だが、終了が 00:00 のときは、その瞬間を含まないので、endDate の前の日まで。
 * 開始日より前にはしない。00:00〜00:00 のように、開始日の中で終わるものも、開始日には出す。
 */
export function lastCoveredDate({ allDay, startDate, endDate, endTime }: CoverageFields): DateStr {
  if (allDay || endTime !== '00:00') return endDate;
  const previousDay = addDays(endDate, -1);
  return previousDay < startDate ? startDate : previousDay;
}

/** 展開した 1 回。表示と通知に必要な内容を、元の行から写している。 */
export interface Occurrence extends Pick<
  Entry,
  | 'kind'
  | 'title'
  | 'workspaceId'
  | 'allDay'
  | 'startDate'
  | 'startTime'
  | 'endDate'
  | 'endTime'
  | 'location'
  | 'url'
  | 'memo'
  | 'notifyEnabled'
  | 'notifyOffsetMin'
> {
  /** 内容の元の行の id。例外の回なら例外の行、そうでなければ系列（または繰り返さない予定）の行。 */
  entryId: string;
  /** 系列の id。繰り返さない予定なら自分の id。 */
  seriesId: string;
  /** 回の日付。例外なら originalDate、そうでなければ生成した日。変更・削除の対象を指すのに使う。 */
  occurrenceDate: DateStr;
  isException: boolean;
}

function toOccurrence(
  row: Entry,
  seriesId: string,
  occurrenceDate: DateStr,
  isException: boolean,
  dates: DateRange = row,
): Occurrence {
  return {
    entryId: row.id,
    seriesId,
    occurrenceDate,
    isException,
    kind: row.kind,
    title: row.title,
    workspaceId: row.workspaceId,
    allDay: row.allDay,
    startDate: dates.startDate,
    startTime: row.startTime,
    endDate: dates.endDate,
    endTime: row.endTime,
    location: row.location,
    url: row.url,
    memo: row.memo,
    notifyEnabled: row.notifyEnabled,
    notifyOffsetMin: row.notifyOffsetMin,
  };
}

function overlapsPeriod(row: CoverageFields, from: DateStr, to: DateStr): boolean {
  return row.startDate <= to && lastCoveredDate(row) >= from;
}

/** 同じ回の例外が 2 行あるときは、編集時刻が新しい方（同じなら id が大きい方）を採る。 */
function isNewerException(candidate: Entry, current: Entry): boolean {
  return (
    candidate.editedAt > current.editedAt ||
    (candidate.editedAt === current.editedAt && candidate.id > current.id)
  );
}

/** 時刻が欠けた行（本来はありえない）は、0:00 として並べる。1 行の不正で、画面全体を止めないため。 */
function compareOccurrences(a: Occurrence, b: Occurrence): number {
  if (a.startDate !== b.startDate) return compareStrings(a.startDate, b.startDate);
  if (a.allDay !== b.allDay) return a.allDay ? -1 : 1;
  const byTime = compareStrings(a.startTime ?? '', b.startTime ?? '');
  if (byTime !== 0) return byTime;
  // 最後は id で決める。入力の並びに依存すると、同じ内容でも結果の並びが変わってしまうため。
  return compareStrings(a.entryId, b.entryId) || compareStrings(a.occurrenceDate, b.occurrenceDate);
}

/**
 * 期間 [from, to]（両端を含む）にかかる回の一覧を、開始の日時の順（同じなら終日が先）に返す。
 * entries は全行（繰り返さない予定・系列・例外）。削除済みの行は無視し、
 * 系列が削除されていれば（見つからなければ）、その例外の行も出さない。
 */
export function expandOccurrences(
  entries: readonly Entry[],
  from: DateStr,
  to: DateStr,
): Occurrence[] {
  const seriesRows = new Map<string, Entry>();
  const exceptionsBySeries = new Map<string, Map<DateStr, Entry>>();
  const result: Occurrence[] = [];

  for (const row of entries) {
    if (row.deletedAt !== null) continue;
    if (row.seriesId !== null) {
      if (row.originalDate === null) continue;
      const exceptions = exceptionsBySeries.get(row.seriesId) ?? new Map<DateStr, Entry>();
      const current = exceptions.get(row.originalDate);
      if (current === undefined || isNewerException(row, current)) {
        exceptions.set(row.originalDate, row);
      }
      exceptionsBySeries.set(row.seriesId, exceptions);
    } else if (row.rrule !== null) {
      seriesRows.set(row.id, row);
    } else if (overlapsPeriod(row, from, to)) {
      result.push(toOccurrence(row, row.id, row.startDate, false));
    }
  }

  for (const series of seriesRows.values()) {
    const exceptions = exceptionsBySeries.get(series.id) ?? new Map<DateStr, Entry>();
    for (const date of generatedDates(series, from, to)) {
      if (exceptions.has(date)) continue;
      const endDate = addDays(date, diffDays(series.startDate, series.endDate));
      result.push(toOccurrence(series, series.id, date, false, { startDate: date, endDate }));
    }
    for (const [originalDate, exception] of exceptions) {
      if (exception.cancelled || !overlapsPeriod(exception, from, to)) continue;
      result.push(toOccurrence(exception, series.id, originalDate, true));
    }
  }

  return result.sort(compareOccurrences);
}

/** 系列が生成する回のうち、期間にかかるものの日付（開始日）。例外による置き換えは考えない。 */
function generatedDates(series: Entry, from: DateStr, to: DateStr): DateStr[] {
  const { rrule } = series;
  if (rrule === null) return [];
  const rule: SeriesRule = { rrule, startDate: series.startDate, untilDate: series.untilDate };

  // 期間の前から始まる、複数日・日付をまたぐ回も出すため、1 回がかかる日数だけ手前から探す。
  const coveredDays = diffDays(series.startDate, lastCoveredDate(series));
  const firstDay = Math.max(dateToDays(series.startDate), dateToDays(from) - coveredDays);
  const lastDay = Math.min(
    dateToDays(to),
    series.untilDate === null ? Number.POSITIVE_INFINITY : dateToDays(series.untilDate),
  );

  const dates: DateStr[] = [];
  for (let day = firstDay; day <= lastDay; day++) {
    const date = daysToDate(day);
    if (isOccurrenceDate(rule, date)) dates.push(date);
  }
  return dates;
}
