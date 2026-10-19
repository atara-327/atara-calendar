import { addDays, dateToDays, dateToYmd, dayOfWeek, daysToDate, type DateStr } from './date';
import { isDayOff, isWeekday } from './holidays';
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

const DETAIL_KEYS = [
  'title',
  'workspaceId',
  'location',
  'url',
  'memo',
  'notifyEnabled',
  'notifyOffsetMin',
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
  if (row === undefined) throw new Error(`対象の予定が見つかりません: ${seriesId}`);
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
    throw new RangeError(`${occurrenceDate} は、${series.id} の回ではありません`);
  }
  return {
    exception: undefined,
    displayed: {
      startDate: occurrenceDate,
      endDate: addDays(occurrenceDate, diffDays(series.startDate, series.endDate)),
    },
  };
}

interface Schedule extends DateRange {
  /** 表示上の開始日から、変更後の開始日までの日数（Δ）。 */
  delta: number;
}

/**
 * フォームに出ていた日付（displayed）に対する、変更後の開始日・終了日。
 * 開始日だけを変えたときは、1 回の長さを保つように、終了日も同じだけ動かす。
 */
function resolveSchedule(displayed: DateRange, changes: EntryChanges): Schedule {
  const startDate = pick(changes.startDate, displayed.startDate);
  const delta = diffDays(displayed.startDate, startDate);
  return {
    startDate,
    endDate: pick(changes.endDate, addDays(displayed.endDate, delta)),
    delta,
  };
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
function seriesLength(series: Entry, schedule: Schedule, changes: EntryChanges): number {
  return changes.endDate === undefined
    ? diffDays(series.startDate, series.endDate)
    : diffDays(schedule.startDate, schedule.endDate);
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
  return [{ ...cloneRow(series), untilDate: addDays(occurrenceDate, -1), editedAt }, ...removed];
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

  const { exception, displayed } = locateOccurrence(entries, series, rrule, target.occurrenceDate);

  if (scope === 'this') {
    return [
      changeThis(series, exception, displayed, target.occurrenceDate, changes, { newId, editedAt }),
    ];
  }

  // 最初の回から「これ以降すべて」にするのは、「すべて」と同じ。系列を切ると、1 回も残らない系列ができてしまう。
  if (scope === 'all' || target.occurrenceDate === series.startDate) {
    return changeAll(entries, series, rrule, displayed, changes, editedAt);
  }
  return changeFollowing(entries, series, rrule, target.occurrenceDate, displayed, changes, {
    newId,
    editedAt,
  });
}

/** 「この予定のみ」。例外の行があればそれを書き換え、なければ系列のコピーから例外の行を作る。 */
function changeThis(
  series: Entry,
  exception: Entry | undefined,
  displayed: DateRange,
  occurrenceDate: DateStr,
  changes: EntryChanges,
  stamp: { newId: string; editedAt: number },
): Entry {
  // 例外の行は 1 回だけの行で、ルールを持たない。変えたいなら「これ以降すべて」か「すべて」にする。
  if (changes.rrule !== undefined) {
    throw new Error('「この予定のみ」では、繰り返しのルールを変えられません');
  }
  const schedule = resolveSchedule(displayed, changes);
  const base = exception ?? newException(series, occurrenceDate, displayed, stamp);
  return {
    ...withTimes(withDetails(base, changes), changes),
    startDate: schedule.startDate,
    endDate: schedule.endDate,
    editedAt: stamp.editedAt,
  };
}

/** 繰り返さない予定。範囲は無視して、その行を書き換える。ルールを付ければ、繰り返す予定になる。 */
function changeSingle(row: Entry, changes: EntryChanges, editedAt: number): Entry {
  const schedule = resolveSchedule(row, changes);
  const rrule = pick(changes.rrule, row.rrule);
  const range = { startDate: schedule.startDate, endDate: schedule.endDate };
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
  displayed: DateRange,
  changes: EntryChanges,
  editedAt: number,
): Entry[] {
  const schedule = resolveSchedule(displayed, changes);
  const rrule = nextRrule(currentRrule, changes, schedule.delta);
  const { startDate, endDate } = rescheduled(
    rrule,
    addDays(series.startDate, schedule.delta),
    seriesLength(series, schedule, changes),
  );
  const changed: Entry = {
    ...withTimes(withDetails(series, changes), changes),
    rrule,
    // ルールをなくして繰り返さない予定にしたら、系列の「終わり」の印も要らない。
    untilDate: rrule === null ? null : series.untilDate,
    startDate,
    endDate,
    editedAt,
  };

  // ルールか開始日が変わると、どの例外がどの回に当たるのかが変わるので、例外はすべて消す。
  const exceptions = liveExceptionsOf(entries, series.id);
  const ruleChanged = changes.rrule !== undefined && !isSameRrule(changes.rrule, currentRrule);
  if (ruleChanged || schedule.delta !== 0) {
    return [changed, ...exceptions.map((exception) => markDeleted(exception, editedAt))];
  }

  // そうでなければ、削除した回はそのまま残し、個別に変えた回には、今回変えた項目だけを当てる。
  // 日時は、その回に個別に決めた値を保つので当てない。値が変わらない行は書き込まない。
  const patched: Entry[] = [];
  for (const exception of exceptions) {
    if (exception.cancelled) continue;
    const patch = withDetails(exception, changes);
    if (DETAIL_KEYS.some((key) => patch[key] !== exception[key])) {
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
  const schedule = resolveSchedule(displayed, changes);
  const rrule = nextRrule(currentRrule, changes, schedule.delta);
  const { startDate, endDate } = rescheduled(
    rrule,
    addDays(occurrenceDate, schedule.delta),
    seriesLength(series, schedule, changes),
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
