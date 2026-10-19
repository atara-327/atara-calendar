import { addDays, dateToDays, dateToYmd, dayOfWeek, daysToDate, type DateStr } from './date';
import { isDayOff, isWeekday } from './holidays';
import { MAX_YEAR, MIN_YEAR } from './solarTerms';
import type { Entry, EntryChanges, EntryDraft, Rrule, Scope } from './schema';

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
  /** 繰り返しの系列の回なら true、繰り返さない予定なら false。範囲を選ぶ画面を出すかどうかの判断に使う。 */
  recurring: boolean;
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
    recurring: row.rrule !== null || row.seriesId !== null,
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
  if (from > to) return [];

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

// 系列が回を生成する日を、祝日の計算が対応する年に収める。収めないと、2199 年の最後の週の行が
// 2200 年の 1 月にかかって、平日・休日のルールが、対応外の年で例外を投げてしまう。
const MIN_GENERATED_DAY = dateToDays(`${String(MIN_YEAR)}-01-01`);
const MAX_GENERATED_DAY = dateToDays(`${String(MAX_YEAR)}-12-31`);

/** 系列が生成する回のうち、期間にかかるものの日付（開始日）。例外による置き換えは考えない。 */
function generatedDates(series: Entry, from: DateStr, to: DateStr): DateStr[] {
  const { rrule } = series;
  if (rrule === null) return [];
  const rule: SeriesRule = { rrule, startDate: series.startDate, untilDate: series.untilDate };

  // 期間の前から始まる、複数日・日付をまたぐ回も出すため、1 回がかかる日数だけ手前から探す。
  const coveredDays = diffDays(series.startDate, lastCoveredDate(series));
  const firstDay = Math.max(
    dateToDays(series.startDate),
    dateToDays(from) - coveredDays,
    MIN_GENERATED_DAY,
  );
  const lastDay = Math.min(
    dateToDays(to),
    series.untilDate === null ? Number.POSITIVE_INFINITY : dateToDays(series.untilDate),
    MAX_GENERATED_DAY,
  );

  const dates: DateStr[] = [];
  for (let day = firstDay; day <= lastDay; day++) {
    const date = daysToDate(day);
    if (isOccurrenceDate(rule, date)) dates.push(date);
  }
  return dates;
}

// 例外をクラスで分けるのは、API（#4）が「依頼を捨てる」場合（対象がもうない）と「エラーを返す」場合
// （依頼の中身が受け付けられない）を区別するため。message の文面で区別しないのは、
// 文面を直しただけで、API の振る舞いが変わってしまうため。

/** 変更・削除の対象にした回（または系列）が、存在しない、または削除されている。 */
export class OccurrenceNotFoundError extends Error {
  override readonly name = 'OccurrenceNotFoundError';
}

/** 変更の中身が受け付けられない（「この予定のみ」でルールを変える、など）。 */
export class InvalidChangeError extends Error {
  override readonly name = 'InvalidChangeError';
}

// ここから先は、作成・変更・削除（設計書 4.5）。どれも純粋な関数で、結果は「書き込む行
// （変更後の行全体）」の配列。端末とサーバーで同じ計算をして同じ行にするため（設計書 5.2）、
// 乱数も現在時刻も使わず、新しい行の id と編集時刻は引数で受け取る。

/** 変更・削除の対象にする回。繰り返さない予定なら、seriesId は自分の id。 */
export interface OccurrenceTarget {
  seriesId: string;
  occurrenceDate: DateStr;
}

type ContentFields = Pick<
  Entry,
  | 'kind'
  | 'title'
  | 'workspaceId'
  | 'allDay'
  | 'startTime'
  | 'endTime'
  | 'location'
  | 'url'
  | 'memo'
  | 'notifyEnabled'
  | 'notifyOffsetMin'
>;

/**
 * 新しい行に写す内容。スプレッドで行ごとコピーしないのは、DB から読んだ行に付いている
 * サーバーの都合の列（rev など）まで、別の行に引き継いでしまうため。
 */
function copyContent(row: Entry): ContentFields {
  return {
    kind: row.kind,
    title: row.title,
    workspaceId: row.workspaceId,
    allDay: row.allDay,
    startTime: row.startTime,
    endTime: row.endTime,
    location: row.location,
    url: row.url,
    memo: row.memo,
    notifyEnabled: row.notifyEnabled,
    notifyOffsetMin: row.notifyOffsetMin,
  };
}

/** changes が undefined（変えていない）なら current、そうでなければ変更後の値。null は「空にした」。 */
function pick<T>(changed: T | undefined, current: T): T {
  return changed === undefined ? current : changed;
}

/** 例外の行に変更を当てたとき、値が変わったかどうかを調べる項目。 */
const COMPARED_KEYS = [
  'title',
  'workspaceId',
  'location',
  'url',
  'memo',
  'notifyEnabled',
  'notifyOffsetMin',
  'allDay',
  'startDate',
  'startTime',
  'endDate',
  'endTime',
] as const;

/** 日付・時刻・終日以外の項目（タイトル、ワークスペース、場所、URL、メモ、通知）の変更を当てる。 */
function withDetails<T extends ContentFields>(row: T, changes: EntryChanges): T {
  return {
    ...row,
    title: pick(changes.title, row.title),
    workspaceId: pick(changes.workspaceId, row.workspaceId),
    location: pick(changes.location, row.location),
    url: pick(changes.url, row.url),
    memo: pick(changes.memo, row.memo),
    notifyEnabled: pick(changes.notifyEnabled, row.notifyEnabled),
    notifyOffsetMin: pick(changes.notifyOffsetMin, row.notifyOffsetMin),
  };
}

/** 終日と時刻の変更を当てる。日付は、ずらし方が範囲ごとに違うので、ここでは扱わない。 */
function withTimes<T extends ContentFields>(row: T, changes: EntryChanges): T {
  return {
    ...row,
    allDay: pick(changes.allDay, row.allDay),
    startTime: pick(changes.startTime, row.startTime),
    endTime: pick(changes.endTime, row.endTime),
  };
}

/**
 * 1 回だけの行（例外の行）に、変更をすべて当てる（日時・終日を含む）。
 * 日付は、フォームに出ていた日付（displayed）に対する変更後の値。
 */
function applyToOccurrence(row: Entry, displayed: DateRange, changes: EntryChanges): Entry {
  return {
    ...withTimes(withDetails(row, changes), changes),
    ...resolveOccurrenceSchedule(displayed, changes),
  };
}

function cloneRrule(rrule: Rrule): Rrule {
  return rrule.freq === 'weekly' ? { freq: 'weekly', days: [...rrule.days] } : { ...rrule };
}

function sortedDays(days: readonly number[]): number[] {
  return [...days].sort((a, b) => a - b);
}

/** 曜日の並びや重複によらず、同じ曜日の組なら同じルールとみなす。 */
function isSameRrule(a: Rrule | null, b: Rrule | null): boolean {
  if (a === null || b === null) return a === b;
  if (a.freq === 'weekly' && b.freq === 'weekly') {
    const left = sortedDays(a.days);
    const right = sortedDays(b.days);
    return left.length === right.length && left.every((day, index) => day === right[index]);
  }
  return a.freq === b.freq;
}

function shiftWeekdays(days: readonly number[], delta: number): number[] {
  return sortedDays([...new Set(days.map((day) => (((day + delta) % 7) + 7) % 7))]);
}

/** 行の複製。rrule は入れ子のオブジェクトなので、入力の行と共有しないように複製する。 */
function cloneRow(row: Entry): Entry {
  return { ...row, rrule: row.rrule === null ? null : cloneRrule(row.rrule) };
}

function markDeleted(row: Entry, editedAt: number): Entry {
  return { ...cloneRow(row), deletedAt: editedAt, editedAt };
}

/** 下書きから行を作る。繰り返すなら、開始日をルールに合う最初の日へずらす（設計書 4.4）。 */
export function createEntry({
  draft,
  newId,
  editedAt,
}: {
  draft: EntryDraft;
  newId: string;
  editedAt: number;
}): Entry[] {
  const range = { startDate: draft.startDate, endDate: draft.endDate };
  const { startDate, endDate } = draft.rrule === null ? range : normalizeStart(draft.rrule, range);
  return [
    {
      id: newId,
      kind: draft.kind,
      title: draft.title,
      workspaceId: draft.workspaceId,
      allDay: draft.allDay,
      startDate,
      startTime: draft.startTime,
      endDate,
      endTime: draft.endTime,
      location: draft.location,
      url: draft.url,
      memo: draft.memo,
      rrule: draft.rrule === null ? null : cloneRrule(draft.rrule),
      untilDate: null,
      seriesId: null,
      originalDate: null,
      cancelled: false,
      notifyEnabled: draft.notifyEnabled,
      notifyOffsetMin: draft.notifyOffsetMin,
      editedAt,
      deletedAt: null,
    },
  ];
}

/** 系列（または繰り返さない予定）の行。例外の行や削除済みの行は、系列として扱わない。 */
function findSeriesRow(entries: readonly Entry[], seriesId: string): Entry {
  const row = entries.find(
    (entry) => entry.id === seriesId && entry.seriesId === null && entry.deletedAt === null,
  );
  if (row === undefined) {
    throw new OccurrenceNotFoundError(`対象の予定が見つかりません: ${seriesId}`);
  }
  return row;
}

function liveExceptionsOf(entries: readonly Entry[], seriesId: string): Entry[] {
  return entries.filter((entry) => entry.seriesId === seriesId && entry.deletedAt === null);
}

function findException(
  entries: readonly Entry[],
  seriesId: string,
  originalDate: DateStr,
): Entry | undefined {
  return liveExceptionsOf(entries, seriesId)
    .filter((entry) => entry.originalDate === originalDate)
    .reduce<Entry | undefined>(
      (newest, entry) => (newest === undefined || isNewerException(entry, newest) ? entry : newest),
      undefined,
    );
}

interface LocatedOccurrence {
  /** その回の例外の行。なければ undefined。 */
  exception: Entry | undefined;
  /** フォームに出ていた、その回の開始日と終了日。例外なら例外の行の値。 */
  displayed: DateRange;
}

/**
 * 対象の回を探す。例外の行も、系列が生成する回でもない日付は、存在しない回なので例外を投げる
 * （黙って受け付けると、「この予定のみ」の変更が、存在しない回の予定を新しく作ってしまう）。
 */
function locateOccurrence(
  entries: readonly Entry[],
  series: Entry,
  rrule: Rrule,
  occurrenceDate: DateStr,
): LocatedOccurrence {
  const exception = findException(entries, series.id, occurrenceDate);
  if (exception !== undefined) {
    return {
      exception,
      displayed: { startDate: exception.startDate, endDate: exception.endDate },
    };
  }
  const rule: SeriesRule = { rrule, startDate: series.startDate, untilDate: series.untilDate };
  if (!isOccurrenceDate(rule, occurrenceDate)) {
    throw new OccurrenceNotFoundError(`${occurrenceDate} は、${series.id} の回ではありません`);
  }
  return {
    exception: undefined,
    displayed: {
      startDate: occurrenceDate,
      endDate: addDays(occurrenceDate, diffDays(series.startDate, series.endDate)),
    },
  };
}

/**
 * フォームに出ていた日付（displayed）に対する、変更後の開始日・終了日（1 回だけの行の日付）。
 * 開始日だけを変えたときは、1 回の長さを保つように、終了日も同じだけ動かす。
 */
function resolveOccurrenceSchedule(displayed: DateRange, changes: EntryChanges): DateRange {
  const startDate = pick(changes.startDate, displayed.startDate);
  const shift = diffDays(displayed.startDate, startDate);
  return { startDate, endDate: pick(changes.endDate, addDays(displayed.endDate, shift)) };
}

/**
 * 「これ以降すべて」「すべて」で、系列をずらす日数 Δ。変更後の開始日 − その回の日付
 * （例外の行なら originalDate）。開始日を変えていなければ 0。
 * 表示上の開始日（移した例外なら移した先）から数えないのは、別の日に移した回を開いて日付を変えたとき、
 * 移した日数の分だけずれた日にその回が出てしまい、ユーザーが選んだ日にならないため。
 */
function shiftDays(occurrenceDate: DateStr, changes: EntryChanges): number {
  return changes.startDate === undefined ? 0 : diffDays(occurrenceDate, changes.startDate);
}

// daily・weekday・holiday の開始日は、どの日に回があるかを決めない。ずらしても回は動かず、
// 最初の回が消えたり、例外が黙って消えたりするだけなので、ずらせるようにしない（日付を動かしたい
// ときは「この予定のみ」にする）。
const SHIFTABLE_FREQS: ReadonlySet<Rrule['freq']> = new Set<Rrule['freq']>([
  'weekly',
  'monthly',
  'yearly',
]);

function assertShiftable(rrule: Rrule | null, delta: number): void {
  if (rrule !== null && delta !== 0 && !SHIFTABLE_FREQS.has(rrule.freq)) {
    throw new InvalidChangeError(
      `${rrule.freq} の繰り返しは、開始日をずらせません。日付を変えるなら「この予定のみ」にしてください`,
    );
  }
}

/**
 * 変更後の繰り返しのルール。ルールを変えていない weekly は、日付をずらした分だけ曜日もずらす
 * （水・金の回を 1 日後ろにしたら、木・土）。こうしないと、開始日だけが動いて、曜日が合わなくなる。
 */
function nextRrule(current: Rrule, changes: EntryChanges, delta: number): Rrule | null {
  const changed = changes.rrule;
  if (changed !== undefined && !isSameRrule(changed, current)) {
    return changed === null ? null : cloneRrule(changed);
  }
  if (current.freq === 'weekly' && delta !== 0) {
    return { freq: 'weekly', days: shiftWeekdays(current.days, delta) };
  }
  return cloneRrule(current);
}

/** 系列の行を、ずらした開始日・終了日と、変更後のルールで作り直す（「すべて」と「これ以降」で共通）。 */
function rescheduled(rrule: Rrule | null, startDate: DateStr, length: number): DateRange {
  const range = { startDate, endDate: addDays(startDate, length) };
  return rrule === null ? range : normalizeStart(rrule, range);
}

/**
 * 系列の 1 回の長さ（日数）。終了日を変えたときだけ、変更後の値に合わせる。
 * 変えていないのに displayed から求めないのは、例外の回が系列と違う長さのとき、
 * タイトルを変えただけで系列の長さが変わってしまうため。
 */
function seriesLength(series: Entry, displayed: DateRange, changes: EntryChanges): number {
  return changes.endDate === undefined
    ? diffDays(series.startDate, series.endDate)
    : diffDays(pick(changes.startDate, displayed.startDate), changes.endDate);
}

/** 例外の行を作る。内容は系列のコピーで、日付はその回のもの。 */
function newException(
  series: Entry,
  occurrenceDate: DateStr,
  displayed: DateRange,
  { newId, editedAt }: { newId: string; editedAt: number },
): Entry {
  return {
    id: newId,
    ...copyContent(series),
    startDate: displayed.startDate,
    endDate: displayed.endDate,
    rrule: null,
    untilDate: null,
    seriesId: series.id,
    originalDate: occurrenceDate,
    cancelled: false,
    editedAt,
    deletedAt: null,
  };
}

/** 系列を、occurrenceDate の前の日で切る。それ以降の例外は消す。 */
function cutBefore(
  entries: readonly Entry[],
  series: Entry,
  occurrenceDate: DateStr,
  editedAt: number,
): Entry[] {
  const removed = liveExceptionsOf(entries, series.id)
    .filter(({ originalDate }) => originalDate !== null && originalDate >= occurrenceDate)
    .map((exception) => markDeleted(exception, editedAt));
  const cutAt = addDays(occurrenceDate, -1);
  // 既存の untilDate が手前にあれば、それを残す。延ばすと、前に切って消えた回が戻ってしまう。
  const untilDate =
    series.untilDate !== null && series.untilDate < cutAt ? series.untilDate : cutAt;
  return [{ ...cloneRow(series), untilDate, editedAt }, ...removed];
}

interface ChangeArguments {
  entries: readonly Entry[];
  target: OccurrenceTarget;
  scope: Scope;
  changes: EntryChanges;
  newId: string;
  editedAt: number;
}

/**
 * 予定・タイムブロックの変更（設計書 4.5）。changes は、ユーザーが変えた項目だけ。
 * 日付と時刻は、フォームに出ていた、その回の値に対する変更後の値。
 * kind は作成した後に変えられないので、changes に含めない。
 */
export function changeEntry({
  entries,
  target,
  scope,
  changes,
  newId,
  editedAt,
}: ChangeArguments): Entry[] {
  const series = findSeriesRow(entries, target.seriesId);
  const { rrule } = series;

  if (rrule === null) return [changeSingle(series, changes, editedAt)];

  const located = locateOccurrence(entries, series, rrule, target.occurrenceDate);

  if (scope === 'this') {
    return [changeThis(series, located, target.occurrenceDate, changes, { newId, editedAt })];
  }

  // 最初の回から「これ以降すべて」にするのは、「すべて」と同じ。系列を切ると、1 回も残らない系列ができてしまう。
  if (scope === 'all' || target.occurrenceDate === series.startDate) {
    return changeAll(entries, series, rrule, target.occurrenceDate, located, changes, editedAt);
  }
  return changeFollowing(
    entries,
    series,
    rrule,
    target.occurrenceDate,
    located.displayed,
    changes,
    { newId, editedAt },
  );
}

/** 「この予定のみ」。例外の行があればそれを書き換え、なければ系列のコピーから例外の行を作る。 */
function changeThis(
  series: Entry,
  { exception, displayed }: LocatedOccurrence,
  occurrenceDate: DateStr,
  changes: EntryChanges,
  stamp: { newId: string; editedAt: number },
): Entry {
  // 削除した回は、画面に出ていない回なので、存在しない回として扱う。通すと、画面に出ない行に
  // 変更が残るだけになる。
  if (exception?.cancelled === true) {
    throw new OccurrenceNotFoundError(`${occurrenceDate} の回は、削除されています: ${series.id}`);
  }
  // 例外の行は 1 回だけの行で、ルールを持たない。変えたいなら「これ以降すべて」か「すべて」にする。
  // キーがあるかどうかで判定しないのは、フォームが、変えていないルールまで送ってきたときに、
  // 弾かないため（「すべて」と同じ判定にそろえている）。
  if (changes.rrule !== undefined && !isSameRrule(changes.rrule, series.rrule)) {
    throw new InvalidChangeError('「この予定のみ」では、繰り返しのルールを変えられません');
  }
  const base = exception ?? newException(series, occurrenceDate, displayed, stamp);
  return { ...applyToOccurrence(base, displayed, changes), editedAt: stamp.editedAt };
}

/** 繰り返さない予定。範囲は無視して、その行を書き換える。ルールを付ければ、繰り返す予定になる。 */
function changeSingle(row: Entry, changes: EntryChanges, editedAt: number): Entry {
  const range = resolveOccurrenceSchedule(row, changes);
  const rrule = pick(changes.rrule, row.rrule);
  const { startDate, endDate } = rrule === null ? range : normalizeStart(rrule, range);
  return {
    ...withTimes(withDetails(row, changes), changes),
    rrule: rrule === null ? null : cloneRrule(rrule),
    startDate,
    endDate,
    editedAt,
  };
}

function changeAll(
  entries: readonly Entry[],
  series: Entry,
  currentRrule: Rrule,
  occurrenceDate: DateStr,
  { exception: target, displayed }: LocatedOccurrence,
  changes: EntryChanges,
  editedAt: number,
): Entry[] {
  const delta = shiftDays(occurrenceDate, changes);
  const rrule = nextRrule(currentRrule, changes, delta);
  assertShiftable(rrule, delta);
  const { startDate, endDate } = rescheduled(
    rrule,
    addDays(series.startDate, delta),
    seriesLength(series, displayed, changes),
  );
  const changed: Entry = {
    ...withTimes(withDetails(series, changes), changes),
    rrule,
    // ルールをなくして繰り返さない予定にしたら、系列の「終わり」の印も要らない。
    // そうでなければ、開始日と同じだけずらす。ずらさないと、ずらした後で回の数が変わってしまう。
    untilDate:
      rrule === null || series.untilDate === null ? null : addDays(series.untilDate, delta),
    startDate,
    endDate,
    editedAt,
  };

  // ルールか開始日が変わると、どの例外がどの回に当たるのかが変わるので、例外はすべて消す。
  const exceptions = liveExceptionsOf(entries, series.id);
  const ruleChanged = changes.rrule !== undefined && !isSameRrule(changes.rrule, currentRrule);
  if (ruleChanged || delta !== 0) {
    return [changed, ...exceptions.map((exception) => markDeleted(exception, editedAt))];
  }

  // そうでなければ、削除した回はそのまま残し、個別に変えた回には、今回変えた項目だけを当てる。
  // 日時・終日は、その回に個別に決めた値を保つので当てない。ただし、開いていた回の例外だけは、
  // 日時・終日も含めて、変更をすべて当てる（時刻を変えたのに、その回だけ変わらないのは不自然なため）。
  // 値が変わらない行は書き込まない。
  const patched: Entry[] = [];
  for (const exception of exceptions) {
    if (exception.cancelled) continue;
    const applied =
      exception.id === target?.id
        ? applyToOccurrence(exception, displayed, changes)
        : withDetails(exception, changes);
    // notifyOffsetMin は、終日と時間指定で意味が違う（設計書 4.3）。終日かどうかが系列と違う行に
    // 当てると、終日の「朝 6 時 = -360」が時間指定の行に入って、開始の 360 分後に通知してしまう。
    const patch =
      applied.allDay === changed.allDay
        ? applied
        : { ...applied, notifyOffsetMin: exception.notifyOffsetMin };
    if (COMPARED_KEYS.some((key) => patch[key] !== exception[key])) {
      patched.push({ ...patch, editedAt });
    }
  }
  return [changed, ...patched];
}

function changeFollowing(
  entries: readonly Entry[],
  series: Entry,
  currentRrule: Rrule,
  occurrenceDate: DateStr,
  displayed: DateRange,
  changes: EntryChanges,
  { newId, editedAt }: { newId: string; editedAt: number },
): Entry[] {
  const delta = shiftDays(occurrenceDate, changes);
  const rrule = nextRrule(currentRrule, changes, delta);
  assertShiftable(rrule, delta);
  const { startDate, endDate } = rescheduled(
    rrule,
    addDays(occurrenceDate, delta),
    seriesLength(series, displayed, changes),
  );
  // untilDate を引き継ぐのは、元の系列が、前に「これ以降すべて」で後ろを切られていたとき、
  // 新しい系列がその先まで続いてしまわないようにするため。
  const created: Entry = {
    id: newId,
    ...withTimes(withDetails(copyContent(series), changes), changes),
    startDate,
    endDate,
    rrule,
    untilDate: rrule === null ? null : series.untilDate,
    seriesId: null,
    originalDate: null,
    cancelled: false,
    editedAt,
    deletedAt: null,
  };
  return [...cutBefore(entries, series, occurrenceDate, editedAt), created];
}

interface DeleteArguments {
  entries: readonly Entry[];
  target: OccurrenceTarget;
  scope: Scope;
  newId: string;
  editedAt: number;
}

/** 予定・タイムブロックの削除（設計書 4.5）。削除は、行を消さずに deletedAt を付ける（論理削除）。 */
export function deleteEntry({ entries, target, scope, newId, editedAt }: DeleteArguments): Entry[] {
  const series = findSeriesRow(entries, target.seriesId);
  const { rrule } = series;

  // 「すべて」で消すのに、回の日付は要らないので、日付が合わなくても止めない。
  if (rrule === null || scope === 'all') return deleteSeries(entries, series, editedAt);

  if (scope === 'this') {
    return [cancelOccurrence(entries, series, rrule, target.occurrenceDate, { newId, editedAt })];
  }

  locateOccurrence(entries, series, rrule, target.occurrenceDate);
  // 最初の回から「これ以降すべて」で消すのは、「すべて」と同じ。系列を切ると、1 回も残らない系列ができてしまう。
  if (target.occurrenceDate === series.startDate) return deleteSeries(entries, series, editedAt);
  return cutBefore(entries, series, target.occurrenceDate, editedAt);
}

function deleteSeries(entries: readonly Entry[], series: Entry, editedAt: number): Entry[] {
  const exceptions = liveExceptionsOf(entries, series.id);
  return [series, ...exceptions].map((row) => markDeleted(row, editedAt));
}

/** その回だけを消す。例外の行があればそれを cancelled にし、なければ cancelled の例外の行を作る。 */
function cancelOccurrence(
  entries: readonly Entry[],
  series: Entry,
  rrule: Rrule,
  occurrenceDate: DateStr,
  { newId, editedAt }: { newId: string; editedAt: number },
): Entry {
  const { exception, displayed } = locateOccurrence(entries, series, rrule, occurrenceDate);
  const base = exception ?? newException(series, occurrenceDate, displayed, { newId, editedAt });
  return { ...base, cancelled: true, editedAt };
}
