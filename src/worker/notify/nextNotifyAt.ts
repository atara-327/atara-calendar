import {
  addDays,
  dateToYmd,
  daysInMonth,
  jstToUtcMs,
  utcMsToJstDate,
  ymdToDate,
  type DateStr,
} from '../../shared/date';
import { expandOccurrences, lastCoveredDate, type Occurrence } from '../../shared/recurrence';
import { INPUT_LIMITS, type Entry } from '../../shared/schema';

// 次に通知する時刻（next_notify_at）の計算（設計書 9.2）。純粋な関数だけで、DB には触れない。
// 保存（db/store.ts）が、保存したときに呼ぶ。定期実行（cron.ts）も、通知を送る回の確認と、その次の回を探すのに使う。

const MS_PER_MINUTE = 60_000;
const MINUTES_PER_DAY = 24 * 60;

/** 通知の時刻の計算に使う項目。行（Entry）も、展開した回（Occurrence）も、この形を満たす。 */
export type NotifyFields = Pick<Entry, 'allDay' | 'startDate' | 'startTime' | 'notifyOffsetMin'>;

function timeToMinutes(time: string): number {
  return Number(time.slice(0, 2)) * 60 + Number(time.slice(3, 5));
}

/**
 * 1 回の通知の時刻（UTC のミリ秒）= 開始 − notifyOffsetMin 分（設計書 4.3）。
 * 終日は、開始日の 0:00（日本時間）を開始とみなす。notifyEnabled は見ない（通知するかどうかは、呼び出し側が決める）。
 */
export function notifyAtMs({
  allDay,
  startDate,
  startTime,
  notifyOffsetMin,
}: NotifyFields): number {
  // 時間指定で時刻が欠けた行（本来はありえない）は、0:00 として扱う。1 行の不正で、系列の全行の計算を
  // 止めないため（shared/recurrence.ts の並べ替えと同じ）。
  const startMinute = allDay || startTime === null ? 0 : timeToMinutes(startTime);
  return jstToUtcMs(startDate, startMinute) - notifyOffsetMin * MS_PER_MINUTE;
}

// 通知の分の下限（-1440）は、開始の 1 日後に通知する回があることを表す。afterMs より後に通知する回の開始日は、
// afterMs の日付の 1 日前まで遡るので、探し始めは、さらに 1 日の余裕を見て、afterMs の日付の 2 日前にする。
const LOOKBACK_DAYS = Math.ceil(-INPUT_LIMITS.notifyOffsetMin.min / MINUTES_PER_DAY) + 1;

// 最初は 62 日（毎日・毎週・毎月の、ほとんどの系列の次の回が入る長さ）。なければ 1 年ずつ先へ広げる。
// 毎日の系列を、いきなり 9 年ぶん展開すると、CPU 時間（無料プランは 1 回 10ms。付録 A.2）を使うため。
const FIRST_WINDOW_DAYS = 62;
const NEXT_WINDOW_DAYS = 365;
// 2/29 の毎年は、次の回が最大 8 年先になる（2096 年の次のうるう年は 2104 年。設計書 9.2）ので、探し始めから 9 年まで探す。
const SEARCH_YEARS = 9;

/** 同じ月日の n 年後。その年にない日（2/29）は、月末にする。探す範囲の終わりを決めるだけなので、1 日のずれは気にしない。 */
function addYears(date: DateStr, years: number): DateStr {
  const { year, month, day } = dateToYmd(date);
  const target = year + years;
  return ymdToDate(target, month, Math.min(day, daysInMonth(target, month)));
}

/** 遅い方の日付。'YYYY-MM-DD' は、文字列のまま比べても、日付の順になる。 */
function laterDate(a: DateStr, b: DateStr): DateStr {
  return a > b ? a : b;
}

/** 繰り返さない予定。その行の 1 回だけ。通知の時刻が afterMs 以前なら、もう通知しない。 */
function singleNotifyAt(row: Entry, afterMs: number): number | null {
  const at = notifyAtMs(row);
  return at > afterMs ? at : null;
}

/**
 * family を、展開に渡す行の単位で引けるようにしたもの。nextNotifyTimes が 1 回だけ作る。
 * 行ごとに family の全行を走査（filter）しないのは、例外の多い系列で、例外の数の 2 乗で時間がかかるため
 * （まだ通知していない例外が、1,000 件で 約 7ms、2,000 件で 約 26ms。CPU 時間は無料プランで 1 回 10ms）。
 */
interface FamilyIndex {
  /** 行の id → 行（系列の行を、例外の行の seriesId から引く）。 */
  byId: ReadonlyMap<string, Entry>;
  /** 系列の id → その例外の行。 */
  exceptionsOfSeries: ReadonlyMap<string, readonly Entry[]>;
  /** （系列の id, 元の回の日付）→ 同じ回の例外の行。 */
  exceptionsOfOccurrence: ReadonlyMap<string, readonly Entry[]>;
}

function occurrenceKey(seriesId: string, originalDate: DateStr | null): string {
  return `${seriesId}\n${originalDate ?? ''}`;
}

function indexFamily(family: readonly Entry[]): FamilyIndex {
  const byId = new Map<string, Entry>();
  const exceptionsOfSeries = new Map<string, Entry[]>();
  const exceptionsOfOccurrence = new Map<string, Entry[]>();
  const push = (map: Map<string, Entry[]>, key: string, row: Entry) => {
    const rows = map.get(key);
    if (rows === undefined) map.set(key, [row]);
    else rows.push(row);
  };
  for (const row of family) {
    byId.set(row.id, row);
    if (row.seriesId === null) continue;
    push(exceptionsOfSeries, row.seriesId, row);
    push(exceptionsOfOccurrence, occurrenceKey(row.seriesId, row.originalDate), row);
  }
  return { byId, exceptionsOfSeries, exceptionsOfOccurrence };
}

/**
 * 例外の行の回。展開（expandOccurrences）が出さない例外は、画面に出ない予定なので、null（通知もしない）。
 * 系列が見つからない、または削除されている例外と、同じ回に、より新しい例外の行が別にあるときの、古い方がそうなる。
 * 展開に渡すのは、系列の行と、同じ回の例外の行だけ。family の全行を渡すと、例外の多い系列で、例外の数の
 * 2 乗で時間がかかる（FamilyIndex）。
 */
function shownExceptionOccurrence(
  row: Entry,
  seriesId: string,
  index: FamilyIndex,
): Occurrence | null {
  const series = index.byId.get(seriesId);
  const sameOccurrence = [
    ...(series === undefined ? [] : [series]),
    ...(index.exceptionsOfOccurrence.get(occurrenceKey(seriesId, row.originalDate)) ?? []),
  ];
  return (
    expandOccurrences(sameOccurrence, row.startDate, lastCoveredDate(row)).find(
      (occurrence) => occurrence.entryId === row.id,
    ) ?? null
  );
}

/**
 * 例外の行。例外の行そのものが 1 回の内容を持つので、その行の開始から直接求める。
 * 直接求めるのは、移した先が遠い日付（探す範囲の外）でも、見つけるため。
 * 求めた時刻が afterMs 以前の例外は、展開しない（探す必要がないので、CPU 時間を使わない）。
 */
function exceptionNotifyAt(row: Entry, index: FamilyIndex, afterMs: number): number | null {
  if (row.seriesId === null || row.cancelled) return null;
  const at = notifyAtMs(row);
  if (at <= afterMs) return null;
  return shownExceptionOccurrence(row, row.seriesId, index) === null ? null : at;
}

/**
 * 系列の行。展開した回のうち、例外でない回（entryId が系列の id の回）だけを見る。例外で変えた回・削除した回は、
 * 展開が除くか、例外の行の回にするので、系列の回としては数えない。
 * 期間を区切って先へ広げ、見つかったら、そこで止める。通知の分は系列で 1 つなので、通知の時刻の順は、
 * 開始日の順と同じになる。先の期間に、より早い回はない。
 */
function seriesNotifyAt(series: Entry, index: FamilyIndex, afterMs: number): number | null {
  const sameSeries = [series, ...(index.exceptionsOfSeries.get(series.id) ?? [])];
  // 開始日より前に回はないので、探し始めは開始日より前にしない。afterMs の日付から数えて 9 年より先に始まる系列も、
  // 最初の回から探す（そうしないと、保存し直さない限り、開始日になっても通知されない。計算は、保存したときと
  // 通知を送ったときにしか動かないため）。9 年も、探し始めから数える。
  const searchFrom = laterDate(addDays(utcMsToJstDate(afterMs), -LOOKBACK_DAYS), series.startDate);
  // 終わりの日が探し始めより前の系列は、通知する回がもうないので、期間を展開せずに終える。終わった系列
  // （「これ以降すべて」で切った古い系列）を、保存のたびに、10 個の期間ぶん、無駄に展開しないため。
  if (series.untilDate !== null && series.untilDate < searchFrom) return null;
  const lastDate = addYears(searchFrom, SEARCH_YEARS);
  let from = searchFrom;
  let windowDays = FIRST_WINDOW_DAYS;
  while (from <= lastDate) {
    const windowEnd = addDays(from, windowDays - 1);
    const to = windowEnd < lastDate ? windowEnd : lastDate;
    const times = expandOccurrences(sameSeries, from, to)
      .filter((occurrence) => occurrence.entryId === series.id)
      .map(notifyAtMs)
      .filter((at) => at > afterMs);
    if (times.length > 0) return Math.min(...times);
    from = addDays(to, 1);
    windowDays = NEXT_WINDOW_DAYS;
  }
  return null;
}

/**
 * 削除されていない各行の、次に通知する時刻（UTC のミリ秒）。afterMs より後（> afterMs）の、いちばん早いもの。なければ null。
 * 「その行が内容の元になっている回」の通知だけを数える（例外で置き換えた回は、系列ではなく、例外の行の通知になる）。
 * family は、1 つの系列の全行（系列の行と、その例外の行。削除済みを含んでよい）か、繰り返さない予定の 1 行。
 * 返す Map には、削除されている行を入れない。
 * 通知が OFF の行は null。
 * afterMs は、保存したときは「今」（保存する行について。書かない行は afterMsById で上書きする）。通知を送った回の次を探すときは、`max(送った回の時刻, 今 − 10 分)` を渡す（送った回の時刻より後だけを数えるので、同じ回を 2 回見つけない。今の 10 分前を下限にするのは、遅れた回が続くとき、1 回で、遅れていない最初の回まで進むため。cron.ts・設計書 9.3）。
 * 今より前の回は飛ばす（保存した時点で通知の時刻が過ぎている回は、送っても役に立たないため）。
 * afterMsById は、行ごとに afterMs を変えたいときの上書き（行の id → afterMs）。保存で書かない行は、時刻が来て
 * まだ送っていない回を飛ばさないために、「今」より前の afterMs で計算する（notifyUpdates.ts）。
 * ワークスペース（削除・表示 OFF）は見ない。送るときに確かめる。見ると、ワークスペースを変えるたびに、
 * 中の全行を計算し直すことになる。
 */
export function nextNotifyTimes({
  family,
  afterMs,
  afterMsById,
}: {
  family: readonly Entry[];
  afterMs: number;
  afterMsById?: ReadonlyMap<string, number>;
}): Map<string, number | null> {
  const result = new Map<string, number | null>();
  const index = indexFamily(family);
  for (const row of family) {
    if (row.deletedAt !== null) continue;
    const after = afterMsById?.get(row.id) ?? afterMs;
    if (!row.notifyEnabled) {
      result.set(row.id, null);
    } else if (row.seriesId !== null) {
      result.set(row.id, exceptionNotifyAt(row, index, after));
    } else if (row.rrule !== null) {
      result.set(row.id, seriesNotifyAt(row, index, after));
    } else {
      result.set(row.id, singleNotifyAt(row, after));
    }
  }
  return result;
}

/**
 * 通知の時刻がちょうど notifyAt になる、その行の回。なければ null。
 * 定期実行（cron.ts）が、送る直前に、読んだ next_notify_at の回が、まだその行の回かを確かめ、送る回の内容
 * （題名・日時・場所）を得るのに使う。2 台でほぼ同時に操作した割り込み（設計書 6.4）で、next_notify_at に、
 * もうない回の古い値が残ることがあるため（設計書 9.3）。
 * family は、nextNotifyTimes と同じ（1 つの系列の全行、または繰り返さない予定の 1 行）。
 * 削除されている行・通知が OFF の行・展開が出さない回は、null（nextNotifyTimes が値を返さない行と同じ）。
 * 系列の行は、通知の時刻から開始日を逆算して、その 1 日だけを展開する。nextNotifyTimes のように、期間を広げて
 * 探さないのは、探す回の日付が、時刻から一つに決まるため（CPU 時間を使わない）。
 */
export function occurrenceNotifiedAt({
  family,
  rowId,
  notifyAt,
}: {
  family: readonly Entry[];
  rowId: string;
  notifyAt: number;
}): Occurrence | null {
  const index = indexFamily(family);
  const row = index.byId.get(rowId);
  if (row === undefined || row.deletedAt !== null || !row.notifyEnabled) return null;

  if (row.seriesId !== null) {
    if (row.cancelled || notifyAtMs(row) !== notifyAt) return null;
    return shownExceptionOccurrence(row, row.seriesId, index);
  }
  if (row.rrule === null) {
    if (notifyAtMs(row) !== notifyAt) return null;
    return (
      expandOccurrences([row], row.startDate, lastCoveredDate(row)).find(
        (occurrence) => occurrence.entryId === row.id,
      ) ?? null
    );
  }
  // 開始 = 通知の時刻 + 通知の分。時刻は、系列のどの回でも同じ（回の長さと開始の時刻は、系列の行のもの）なので、
  // 開始の日本時間の日付が、探す回の日付になる。
  const startDate = utcMsToJstDate(notifyAt + row.notifyOffsetMin * MS_PER_MINUTE);
  const sameSeries = [row, ...(index.exceptionsOfSeries.get(row.id) ?? [])];
  return (
    expandOccurrences(sameSeries, startDate, startDate).find(
      (occurrence) =>
        occurrence.entryId === row.id &&
        occurrence.startDate === startDate &&
        notifyAtMs(occurrence) === notifyAt,
    ) ?? null
  );
}
