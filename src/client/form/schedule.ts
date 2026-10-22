import { dateToDays, daysToDate, utcMsToJstDate, utcMsToJstMinuteOfDay } from '../../shared/date';
import { lastCoveredDate } from '../../shared/recurrence';
import { inputDateSchema } from '../../shared/schema';

// フォームの、開始・終了（終日・日付・時刻）の計算（設計書 11.4）。画面に依存しない。
// 日付と時刻は、日本時間の文字列で持ち、計算は shared/date の整数（日数）と「その日の 0:00 からの分」で行う
// （Date を使わない理由は、設計書 2章の「日付・時刻の扱い」）。

const MINUTES_PER_DAY = 24 * 60;

/** 終了の初期値は、開始の 1 時間後（設計書 11.4）。 */
export const DEFAULT_LENGTH_MIN = 60;

/**
 * フォームの、開始と終了。日付は入力欄の値なので、空や、範囲（1900〜2199 年）の外のこともある。
 * 時刻は、選択欄の値（'HH:MM'）で、いつも正しい形。終日のときも持つ（時間指定に戻したときの値）。
 */
export interface Schedule {
  allDay: boolean;
  startDate: string;
  startTime: string;
  endDate: string;
  endTime: string;
}

export interface ScheduleErrors {
  startDate?: string;
  endDate?: string;
  /** 開始と終了の前後関係。 */
  range?: string;
}

/** 日付の入力欄の値を、日数にする。API の入力と同じ判定（shared の inputDateSchema）で、通らなければ null。 */
function dayOf(date: string): number | null {
  return inputDateSchema.safeParse(date).success ? dateToDays(date) : null;
}

function timeToMinutes(time: string): number {
  return Number(time.slice(0, 2)) * 60 + Number(time.slice(3, 5));
}

function minutesToTime(minutes: number): string {
  const hour = Math.floor(minutes / 60);
  return `${String(hour).padStart(2, '0')}:${String(minutes - hour * 60).padStart(2, '0')}`;
}

/** 「1970-01-01 の 0:00 から何分目か」。終日は、時刻を見ない（日の頭）。日付が正しくなければ null。 */
function absoluteMinutes(date: string, time: string, allDay: boolean): number | null {
  const day = dayOf(date);
  return day === null ? null : day * MINUTES_PER_DAY + (allDay ? 0 : timeToMinutes(time));
}

function fromAbsoluteMinutes(absolute: number): { date: string; time: string } {
  const day = Math.floor(absolute / MINUTES_PER_DAY);
  return { date: daysToDate(day), time: minutesToTime(absolute - day * MINUTES_PER_DAY) };
}

/** 今日（日本時間）の、次の正時。ちょうど正時のときも、その 1 時間後。23 時台なら翌日の 0:00。 */
export function nextFullHour(nowMs: number): { date: string; time: string } {
  const nextHourMinute = (Math.floor(utcMsToJstMinuteOfDay(nowMs) / 60) + 1) * 60;
  return fromAbsoluteMinutes(dateToDays(utcMsToJstDate(nowMs)) * MINUTES_PER_DAY + nextHourMinute);
}

/** 新しく作るときの、開始と終了（時間指定）。開始は今日の次の正時、終了はその 1 時間後。 */
export function defaultSchedule(nowMs: number): Schedule {
  const start = nextFullHour(nowMs);
  const end = fromAbsoluteMinutes(
    dateToDays(start.date) * MINUTES_PER_DAY + timeToMinutes(start.time) + DEFAULT_LENGTH_MIN,
  );
  return {
    allDay: false,
    startDate: start.date,
    startTime: start.time,
    endDate: end.date,
    endTime: end.time,
  };
}

/**
 * 開始（日付か時刻）を変える。終了も、開始が動いた分だけ動かして、長さを保つ（設計書 11.4）。
 * 終了が開始より前になっている（エラーの）ときも、同じ分だけ動かす。開始か終了の日付が正しくない
 * （入力の途中など）ときは、動かす分が決まらないので、終了は変えない。
 * 終日は、日数だけを動かす。
 */
export function moveStart<T extends Schedule>(
  schedule: T,
  patch: Partial<Pick<Schedule, 'startDate' | 'startTime'>>,
): T {
  const next = { ...schedule, ...patch };
  const before = absoluteMinutes(schedule.startDate, schedule.startTime, schedule.allDay);
  const after = absoluteMinutes(next.startDate, next.startTime, next.allDay);
  const end = absoluteMinutes(schedule.endDate, schedule.endTime, schedule.allDay);
  if (before === null || after === null || end === null) return next;
  const moved = fromAbsoluteMinutes(end + after - before);
  return schedule.allDay
    ? { ...next, endDate: moved.date }
    : { ...next, endDate: moved.date, endTime: moved.time };
}

/**
 * 終日にする。終了日は、時間指定のときの「最後にかかる日」にする（shared の lastCoveredDate）。
 * 終了が翌日の 0:00（23:00〜翌 0:00 など）のままだと、終日の終了日は「その日を含む」ので、2 日間になってしまう。
 */
export function toAllDay<T extends Schedule>(schedule: T): T {
  if (dayOf(schedule.startDate) === null || dayOf(schedule.endDate) === null) {
    return { ...schedule, allDay: true };
  }
  return {
    ...schedule,
    allDay: true,
    endDate: lastCoveredDate({
      allDay: false,
      startDate: schedule.startDate,
      endDate: schedule.endDate,
      endTime: schedule.endTime,
    }),
  };
}

/**
 * 時間指定にする。持っている時刻を使い、終了が開始より後にならなければ、開始の 1 時間後にする
 * （終日のとき、時刻の欄は見えないので、終了が開始より前のまま、エラーで出さないため）。
 */
export function toTimed<T extends Schedule>(schedule: T): T {
  const timed = { ...schedule, allDay: false };
  const start = absoluteMinutes(timed.startDate, timed.startTime, false);
  const end = absoluteMinutes(timed.endDate, timed.endTime, false);
  if (start === null || end === null || end > start) return timed;
  const moved = fromAbsoluteMinutes(start + DEFAULT_LENGTH_MIN);
  return { ...timed, endDate: moved.date, endTime: moved.time };
}

const DATE_RANGE_HINT = '1900〜2199 年';

/**
 * 開始・終了のエラー（日本語）。なければ空のオブジェクト。
 * 終日は、終了日が開始日より前でなければよい（同じ日は 1 日だけの予定）。時間指定は、終了が開始より後。
 * サーバーも同じ決まりで確かめる（shared/entryRules.ts）。ここは、どの欄の近くに、どう出すかのための確認。
 */
export function validateSchedule(schedule: Schedule): ScheduleErrors {
  const errors: ScheduleErrors = {};
  const start = absoluteMinutes(schedule.startDate, schedule.startTime, schedule.allDay);
  const end = absoluteMinutes(schedule.endDate, schedule.endTime, schedule.allDay);
  if (start === null) errors.startDate = `開始の日付を入力してください（${DATE_RANGE_HINT}）`;
  if (end === null) errors.endDate = `終了の日付を入力してください（${DATE_RANGE_HINT}）`;
  if (start === null || end === null) return errors;
  if (schedule.allDay ? end < start : end <= start) {
    errors.range = schedule.allDay
      ? '終了日は、開始日と同じか、それより後にしてください'
      : '終了は、開始より後にしてください';
  }
  return errors;
}
