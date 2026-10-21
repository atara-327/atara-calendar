import { addDays, type DateStr } from '../../shared/date';
import { namedDatesBetween } from '../../shared/holidays';
import { occurrencesInPeriod } from '../../shared/period';
import { lastCoveredDate, type Occurrence } from '../../shared/recurrence';
import type { Entry, Workspace } from '../../shared/schema';
import { liveWorkspaceIds } from '../../shared/workspace';
import { layoutWeek, type MonthEvent, type WeekItem } from './layout';
import {
  FIRST_WEEK_NUMBER,
  LAST_WEEK_NUMBER,
  clampToRange,
  weekDates,
  weekStartDate,
} from './weeks';

/** 1 日のマスに出す、日付のまわりの情報。 */
export interface DayView {
  date: DateStr;
  /** 祝日名。祝日でない日と、組み込みのワークスペース「祝日」が OFF のときは null。 */
  holidayName: string | null;
  /** 記念日の名前（同じ日に重なることがある）。「記念日」が OFF のときは空。 */
  observanceNames: readonly string[];
}

/** 1 週間の行に描くもの。 */
export interface WeekView {
  weekNumber: number;
  /** 日曜から土曜の 7 日。 */
  days: readonly DayView[];
  items: readonly WeekItem[];
}

interface WeekViewSource {
  /** 全行（繰り返さない予定・系列・例外。削除済みを含んでよい）。 */
  entries: readonly Entry[];
  workspaces: Iterable<Workspace>;
  /** マスに入る予定の行数。 */
  slots: number;
}

// 回の一覧と祝日は、この数の週をまとめて求める。1 週ずつ求めると、そのたびに全行を走査するため。
// 大きくしすぎると、スクロールで新しい週が出てくるたびに、使わない週まで計算する。
const CHUNK_WEEKS = 8;

// 覚えておくまとまりの数の上限。上限を超えたら、いちばん長く使っていないものから捨てる。
// 遠くまでスクロールしても、覚える量が増え続けないようにするため。
const MAX_CACHED_CHUNKS = 48;

interface Chunk {
  events: readonly MonthEvent[];
  holidays: ReadonlyMap<DateStr, string>;
  observances: ReadonlyMap<DateStr, readonly string[]>;
  weeks: Map<number, WeekView>;
}

/**
 * 月表示に描く週の情報を、必要になった週の分だけ求めて、覚えておく（NF-6）。
 *
 * 全期間（300 年分）は計算しない。描く週（仮想スクロールの行 + 少しの余白）を含むまとまりだけを、
 * 初めて求めるときに計算する。スクロールしても、すでに覚えたまとまりは計算し直さない。
 * データ（entries・workspaces）か、マスに入る行数（slots）が変わるときは、新しいインスタンスを作る
 * （古い結果が混ざらないように、1 つのインスタンスの中では、入力を変えられない）。
 */
export class WeekViewCache {
  private readonly slots: number;
  private readonly entries: readonly Entry[];
  private readonly liveIds: ReadonlySet<string>;
  private readonly colors: ReadonlyMap<string, string>;
  private readonly showHolidays: boolean;
  private readonly showObservances: boolean;
  private readonly chunks = new Map<number, Chunk>();

  constructor({ entries, workspaces, slots }: WeekViewSource) {
    const all = [...workspaces];
    this.entries = entries;
    this.slots = slots;
    this.liveIds = liveWorkspaceIds(all);

    // 表示が OFF のワークスペースの予定は出さない（WS-3）。削除済みのワークスペースの予定は、
    // occurrencesInPeriod が除くので、ここでは見ない。
    // 組み込みの「祝日」「記念日」の行がないときは、出す。マイグレーションが必ず入れる行なので、
    // 行がないのは、まだ何も読み込んでいないときだけ。
    const colors = new Map<string, string>();
    let showHolidays = true;
    let showObservances = true;
    for (const workspace of all) {
      if (workspace.deletedAt !== null) continue;
      if (workspace.builtin === 'holiday') showHolidays = workspace.visible;
      else if (workspace.builtin === 'observance') showObservances = workspace.visible;
      else if (workspace.visible) colors.set(workspace.id, workspace.color);
    }
    this.colors = colors;
    this.showHolidays = showHolidays;
    this.showObservances = showObservances;
  }

  /** これまでに計算したまとまりの数。計算が、描いた週の分だけに収まっていることの確認に使う。 */
  get computedChunkCount(): number {
    return this.chunks.size;
  }

  /** weekNumber の週に描くもの。範囲（1900-01-01 を含む週〜2199-12-31 を含む週）の外は、例外を投げる。 */
  get(weekNumber: number): WeekView {
    if (weekNumber < FIRST_WEEK_NUMBER || weekNumber > LAST_WEEK_NUMBER) {
      throw new RangeError(`週の番号が範囲の外です: ${String(weekNumber)}`);
    }
    const chunkIndex = Math.floor((weekNumber - FIRST_WEEK_NUMBER) / CHUNK_WEEKS);
    const chunk = this.chunk(chunkIndex);
    let view = chunk.weeks.get(weekNumber);
    if (view === undefined) {
      view = this.buildWeek(chunk, weekNumber);
      chunk.weeks.set(weekNumber, view);
    }
    return view;
  }

  private chunk(chunkIndex: number): Chunk {
    const cached = this.chunks.get(chunkIndex);
    if (cached !== undefined) {
      // 使った順に並べ直して、先頭が、いちばん長く使っていないものになるようにする。
      this.chunks.delete(chunkIndex);
      this.chunks.set(chunkIndex, cached);
      return cached;
    }
    const chunk = this.buildChunk(chunkIndex);
    this.chunks.set(chunkIndex, chunk);
    if (this.chunks.size > MAX_CACHED_CHUNKS) {
      const oldest = this.chunks.keys().next();
      if (!oldest.done) this.chunks.delete(oldest.value);
    }
    return chunk;
  }

  private buildChunk(chunkIndex: number): Chunk {
    const firstWeek = FIRST_WEEK_NUMBER + chunkIndex * CHUNK_WEEKS;
    const lastWeek = Math.min(firstWeek + CHUNK_WEEKS - 1, LAST_WEEK_NUMBER);
    // 最初と最後の週は、範囲（1900〜2199 年）の外の日を含む。祝日の計算が対応するのは範囲の中だけなので寄せる。
    const from = clampToRange(weekStartDate(firstWeek));
    const to = clampToRange(addDays(weekStartDate(lastWeek), 6));

    const events: MonthEvent[] = [];
    for (const occurrence of occurrencesInPeriod(this.entries, this.liveIds, from, to)) {
      const event = this.toMonthEvent(occurrence);
      if (event !== null) events.push(event);
    }

    const holidays = new Map<DateStr, string>();
    const observances = new Map<DateStr, string[]>();
    const named = namedDatesBetween(from, to);
    for (const { date, name } of named.holidays) holidays.set(date, name);
    for (const { date, name } of named.observances) {
      observances.set(date, [...(observances.get(date) ?? []), name]);
    }
    return { events, holidays, observances, weeks: new Map() };
  }

  /** 月表示に出す予定にする。出さないもの（タイムブロック・表示が OFF のワークスペース）は null。 */
  private toMonthEvent(occurrence: Occurrence): MonthEvent | null {
    // タイムブロックは月表示に出さない（MV-10）。
    if (occurrence.kind !== 'event' || occurrence.workspaceId === null) return null;
    const color = this.colors.get(occurrence.workspaceId);
    if (color === undefined) return null;
    return {
      key: `${occurrence.entryId}:${occurrence.occurrenceDate}`,
      title: occurrence.title,
      color,
      allDay: occurrence.allDay,
      startDate: occurrence.startDate,
      lastDate: lastCoveredDate(occurrence),
      startTime: occurrence.startTime,
    };
  }

  private buildWeek(chunk: Chunk, weekNumber: number): WeekView {
    const first = weekStartDate(weekNumber);
    const last = addDays(first, 6);
    const days = weekDates(weekNumber).map((date): DayView => ({
      date,
      holidayName: this.showHolidays ? (chunk.holidays.get(date) ?? null) : null,
      observanceNames: this.showObservances ? (chunk.observances.get(date) ?? []) : [],
    }));
    // 週にかからない予定を先に除く。まとまり全体を、週ごとに並べ替えないため。
    const events = chunk.events.filter(
      (event) => event.startDate <= last && event.lastDate >= first,
    );
    return { weekNumber, days, items: layoutWeek(events, first, this.slots) };
  }
}
