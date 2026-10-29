import { dateToDays, type DateStr } from '../../shared/date';
import type { Occurrence } from '../../shared/recurrence';

// 1 週間の行（7 マス）に、予定をどう並べるか（MV-6・MV-9。設計書 11.2）。画面に依存しない計算だけを置く。

const DAYS_PER_WEEK = 7;

interface MonthEventBase {
  /** 回を見分ける値（同じ予定の別の回と区別する）。 */
  key: string;
  title: string;
  /** ワークスペースの色。祝日・記念日は、組み込みのワークスペースの色。 */
  color: string;
  allDay: boolean;
  startDate: DateStr;
  /** 回がかかる最後の日（その日を含む。shared の lastCoveredDate）。 */
  lastDate: DateStr;
  /** 'HH:MM'。終日なら null。 */
  startTime: string | null;
}

/** 利用者の予定（展開した回）。押すと、その回のフォームが開く。 */
export interface EntryMonthEvent extends MonthEventBase {
  source: 'entry';
  /** 押したときに開くフォームが、その回の内容を知るため。並べ方（このファイルの計算）は使わない。 */
  occurrence: Occurrence;
}

/**
 * 祝日・記念日。計算して出すもので、予定の行ではない。編集も削除もできないので、フォームを開く回を持たない
 * （押すと、マスのリンクと同じく、日表示へ移る）。終日で、その日 1 日だけ。
 */
export interface NamedMonthEvent extends MonthEventBase {
  source: 'holiday' | 'observance';
}

/** 月表示に出す、横棒か時間指定の 1 件。 */
export type MonthEvent = EntryMonthEvent | NamedMonthEvent;

/** 横棒（複数日の予定と、終日の予定と、祝日・記念日）。列は 0（日曜）〜6（土曜）で、endCol を含む。 */
export interface BarItem {
  kind: 'bar';
  event: MonthEvent;
  startCol: number;
  endCol: number;
  /** 上から何行目か（0 始まり）。 */
  row: number;
  /** 左が切れている（前の週から続く、または、左の日で出せなかった）。 */
  continuesBefore: boolean;
  /** 右が切れている（次の週へ続く、または、右の日で出せなかった）。 */
  continuesAfter: boolean;
}

/** 時間指定の、その日だけの予定。「15:00 歯医者」。 */
export interface TimedItem {
  kind: 'timed';
  event: EntryMonthEvent;
  col: number;
  row: number;
}

/** 入りきらなかった分。「+2件」。 */
export interface MoreItem {
  kind: 'more';
  col: number;
  row: number;
  /** その日にかかる予定（祝日・記念日を含む）のうち、出せなかった数。 */
  count: number;
}

export type WeekItem = BarItem | TimedItem | MoreItem;

function isMultiDay(event: MonthEvent): boolean {
  return event.lastDate > event.startDate;
}

/** 時間指定の、その日だけの予定か。横棒で出すのは、これ以外（複数日の予定・終日の予定・祝日・記念日）。 */
function isTimedEntry(event: MonthEvent): event is EntryMonthEvent {
  return event.source === 'entry' && !event.allDay && !isMultiDay(event);
}

function compareText(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

/**
 * 横棒を上から詰める順番。「複数日の予定と、祝日・記念日」が先、そのあと 1 日だけの終日予定。
 * 先の組は、先に始まったものが先。同じ日に始まるものは、祝日 → 記念日 → 複数日の予定
 * （複数日の予定は、長いものが先。Googleカレンダーと同じ）。
 * 祝日・記念日は、その日の 1 日だけの終日予定より上に出る（休みかどうかを先に知りたいため）。
 * Why not 祝日・記念日を、すべての棒の先頭にする: 前の日から続く棒の行は、週の中で 1 つなので、
 * 祝日の日のために棒ごと 1 行下がり、ほかの日の上に空き行ができて、位置が日によって変わってしまう。
 * 前の日から続く棒は、始まりが祝日より早いので、先に行が決まり、動かない。
 */
function compareBars(a: MonthEvent, b: MonthEvent): number {
  return (
    barGroup(a) - barGroup(b) ||
    compareText(a.startDate, b.startDate) ||
    barRank(a) - barRank(b) ||
    compareText(b.lastDate, a.lastDate) ||
    Number(b.allDay) - Number(a.allDay) ||
    compareText(a.startTime ?? '', b.startTime ?? '') ||
    compareText(a.key, b.key)
  );
}

/** 0: 複数日の予定と、祝日・記念日。1: 1 日だけの終日予定。 */
function barGroup(event: MonthEvent): number {
  return isMultiDay(event) || event.source !== 'entry' ? 0 : 1;
}

/** 同じ日に始まる棒の順。祝日 → 記念日 → 予定。 */
function barRank(event: MonthEvent): number {
  switch (event.source) {
    case 'holiday':
      return 0;
    case 'observance':
      return 1;
    case 'entry':
      return 2;
  }
}

function compareTimed(a: MonthEvent, b: MonthEvent): number {
  return compareText(a.startTime ?? '', b.startTime ?? '') || compareText(a.key, b.key);
}

interface PlacedBar {
  event: MonthEvent;
  startCol: number;
  endCol: number;
  continuesBefore: boolean;
  continuesAfter: boolean;
  lane: number;
}

/**
 * 週（weekStart は日曜日）の予定の並べ方。events は、その週にかかる回を含む一覧でよい（かからないものは無視する）。
 * slots は、マスに入る予定の行数（「+N件」の行も数える）。
 *
 * - 横棒は、週の中で行（レーン）を 1 つ決める。ほかの日と重ならない、いちばん上の行に詰める。
 *   決めた行は、横棒がかかる日のすべてで同じ。日によって上下に動かさない（途中で折れると、1 本の棒に見えない）。
 * - 時間指定の予定は、その日の横棒の下に、時刻順に並べる。横棒がその日に通っていない行（上の空き）には入れない。
 * - 1 日に出す行数を超えたら、いちばん下の行を「+N件」にして、そこから下にあった予定は出さない。
 *   N は、その日にかかる予定（祝日・記念日を含む）のうち、出せなかった数。横棒が日によって出せない（途中で切れる）ときも、
 *   その日の分として数える。Googleカレンダーと同じ。
 */
export function layoutWeek(
  events: readonly MonthEvent[],
  weekStart: DateStr,
  slots: number,
): WeekItem[] {
  const weekStartDays = dateToDays(weekStart);

  const bars: PlacedBar[] = [];
  const timedByCol: EntryMonthEvent[][] = Array.from({ length: DAYS_PER_WEEK }, () => []);
  for (const event of [...events].sort(compareBars)) {
    const firstCol = dateToDays(event.startDate) - weekStartDays;
    const lastCol = dateToDays(event.lastDate) - weekStartDays;
    if (lastCol < 0 || firstCol > DAYS_PER_WEEK - 1) continue;
    const startCol = Math.max(0, firstCol);
    const endCol = Math.min(DAYS_PER_WEEK - 1, lastCol);
    if (isTimedEntry(event)) {
      timedByCol[startCol]?.push(event);
    } else {
      bars.push({
        event,
        startCol,
        endCol,
        continuesBefore: firstCol < 0,
        continuesAfter: lastCol > DAYS_PER_WEEK - 1,
        lane: 0,
      });
    }
  }

  assignLanes(bars);

  // その日の横棒が占める行数（いちばん下の横棒の行 + 1）。横棒がなければ 0。
  const barRows = Array.from({ length: DAYS_PER_WEEK }, () => 0);
  for (const bar of bars) {
    for (let col = bar.startCol; col <= bar.endCol; col++) {
      barRows[col] = Math.max(barRows[col] ?? 0, bar.lane + 1);
    }
  }
  for (const timed of timedByCol) timed.sort(compareTimed);

  // 入りきらない日は、いちばん下の行を「+N件」にするので、出せる行は slots - 1 になる。
  const visibleRows = Array.from({ length: DAYS_PER_WEEK }, (_, col) => {
    const usedRows = (barRows[col] ?? 0) + (timedByCol[col]?.length ?? 0);
    return usedRows > slots ? slots - 1 : slots;
  });

  const items: WeekItem[] = [];
  const hiddenCounts = Array.from({ length: DAYS_PER_WEEK }, () => 0);

  for (const bar of bars) {
    // 出せる日をつないで、1 本の棒にする。出せない日があれば、そこで棒が切れる。
    let runStart: number | null = null;
    for (let col = bar.startCol; col <= bar.endCol + 1; col++) {
      const visible = col <= bar.endCol && bar.lane < (visibleRows[col] ?? slots);
      if (col <= bar.endCol && !visible) hiddenCounts[col] = (hiddenCounts[col] ?? 0) + 1;
      if (visible && runStart === null) runStart = col;
      if (!visible && runStart !== null) {
        items.push({
          kind: 'bar',
          event: bar.event,
          startCol: runStart,
          endCol: col - 1,
          row: bar.lane,
          continuesBefore: runStart > bar.startCol || bar.continuesBefore,
          continuesAfter: col - 1 < bar.endCol || bar.continuesAfter,
        });
        runStart = null;
      }
    }
  }

  timedByCol.forEach((timed, col) => {
    timed.forEach((event, index) => {
      const row = (barRows[col] ?? 0) + index;
      if (row < (visibleRows[col] ?? slots)) items.push({ kind: 'timed', event, col, row });
      else hiddenCounts[col] = (hiddenCounts[col] ?? 0) + 1;
    });
  });

  hiddenCounts.forEach((count, col) => {
    if (count > 0) items.push({ kind: 'more', col, row: slots - 1, count });
  });

  return items;
}

/** 横棒に、重ならない行（レーン）を割り当てる。bars は、上に詰めたい順に並んでいること。 */
function assignLanes(bars: PlacedBar[]): void {
  const occupied: boolean[][] = [];
  for (const bar of bars) {
    let lane = 0;
    for (;;) {
      const cols = (occupied[lane] ??= Array.from({ length: DAYS_PER_WEEK }, () => false));
      let free = true;
      for (let col = bar.startCol; col <= bar.endCol; col++) {
        if (cols[col] === true) free = false;
      }
      if (free) {
        for (let col = bar.startCol; col <= bar.endCol; col++) cols[col] = true;
        break;
      }
      lane += 1;
    }
    bar.lane = lane;
  }
}
