// 日付は日本時間の 'YYYY-MM-DD' で持ち、計算は「1970-01-01 からの日数」の整数で行う。
// Date を使わないのは、ローカル時刻系の API が端末のタイムゾーンに左右されるうえ、
// Date.UTC も 0〜99 年を 1900 年代に読み替えるため。整数だけで閉じれば、そのどちらも気にしなくて済む。

export type DateStr = string;

export interface Ymd {
  year: number;
  month: number;
  day: number;
}

const MS_PER_DAY = 86_400_000;
const JST_OFFSET_MS = 9 * 3_600_000;
const DATE_PATTERN = /^\d{4}-\d{2}-\d{2}$/;
// 0000-03-01 から 1970-01-01 までの日数。ymdToDays の計算の基準をずらすのに使う。
const DAYS_FROM_0000_03_01_TO_EPOCH = 719_468;

export function isLeapYear(year: number): boolean {
  return (year % 4 === 0 && year % 100 !== 0) || year % 400 === 0;
}

export function daysInMonth(year: number, month: number): number {
  assertMonth(month);
  if (month === 2) return isLeapYear(year) ? 29 : 28;
  return month === 4 || month === 6 || month === 9 || month === 11 ? 30 : 31;
}

function assertMonth(month: number): void {
  if (!Number.isInteger(month) || month < 1 || month > 12) {
    throw new RangeError(`月が不正です: ${String(month)}`);
  }
}

function ymdToDays({ year, month, day }: Ymd): number {
  if (!Number.isInteger(year) || year < 0 || year > 9999) {
    throw new RangeError(`年が不正です: ${String(year)}`);
  }
  assertMonth(month);
  if (!Number.isInteger(day) || day < 1 || day > daysInMonth(year, month)) {
    throw new RangeError(`日が不正です: ${String(year)}-${String(month)}-${String(day)}`);
  }
  // 3月始まりの年として数えると、うるう日が年の最後に来て、日数の式が単純になる。
  const shiftedYear = month <= 2 ? year - 1 : year;
  const era = Math.floor(shiftedYear / 400);
  const yearOfEra = shiftedYear - era * 400;
  const dayOfYear = Math.floor((153 * (month > 2 ? month - 3 : month + 9) + 2) / 5) + day - 1;
  const dayOfEra =
    yearOfEra * 365 + Math.floor(yearOfEra / 4) - Math.floor(yearOfEra / 100) + dayOfYear;
  return era * 146_097 + dayOfEra - DAYS_FROM_0000_03_01_TO_EPOCH;
}

function daysToYmd(days: number): Ymd {
  if (!Number.isInteger(days)) {
    throw new RangeError(`日数が整数ではありません: ${String(days)}`);
  }
  const shifted = days + DAYS_FROM_0000_03_01_TO_EPOCH;
  const era = Math.floor(shifted / 146_097);
  const dayOfEra = shifted - era * 146_097;
  const yearOfEra = Math.floor(
    (dayOfEra -
      Math.floor(dayOfEra / 1460) +
      Math.floor(dayOfEra / 36_524) -
      Math.floor(dayOfEra / 146_096)) /
      365,
  );
  const dayOfYear =
    dayOfEra - (365 * yearOfEra + Math.floor(yearOfEra / 4) - Math.floor(yearOfEra / 100));
  const monthIndex = Math.floor((5 * dayOfYear + 2) / 153);
  const day = dayOfYear - Math.floor((153 * monthIndex + 2) / 5) + 1;
  const month = monthIndex < 10 ? monthIndex + 3 : monthIndex - 9;
  return { year: yearOfEra + era * 400 + (month <= 2 ? 1 : 0), month, day };
}

function parseYmd(date: DateStr): Ymd {
  if (!DATE_PATTERN.test(date)) {
    throw new RangeError(`日付の形式が不正です: ${date}`);
  }
  return {
    year: Number(date.slice(0, 4)),
    month: Number(date.slice(5, 7)),
    day: Number(date.slice(8, 10)),
  };
}

/** 'YYYY-MM-DD' を「1970-01-01 からの日数」に直す。形式が違う、または存在しない日付は例外を投げる。 */
export function dateToDays(date: DateStr): number {
  return ymdToDays(parseYmd(date));
}

/** 「1970-01-01 からの日数」を 'YYYY-MM-DD' に直す。年が 0〜9999 に収まらなければ例外を投げる。 */
export function daysToDate(days: number): DateStr {
  const { year, month, day } = daysToYmd(days);
  return ymdToDate(year, month, day);
}

/** 年月日を 'YYYY-MM-DD' にする。存在しない日付は例外を投げる。 */
export function ymdToDate(year: number, month: number, day: number): DateStr {
  ymdToDays({ year, month, day });
  return `${String(year).padStart(4, '0')}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
}

/** 'YYYY-MM-DD' を年月日に分ける。形式が違う、または存在しない日付は例外を投げる。 */
export function dateToYmd(date: DateStr): Ymd {
  const ymd = parseYmd(date);
  ymdToDays(ymd);
  return ymd;
}

/** 曜日。0 = 日曜 〜 6 = 土曜。1970-01-01 は木曜（4）。 */
export function dayOfWeek(date: DateStr): number {
  return (((dateToDays(date) + 4) % 7) + 7) % 7;
}

export function addDays(date: DateStr, n: number): DateStr {
  return daysToDate(dateToDays(date) + n);
}

/** y 年 m 月の第 n（1 始まり）weekday（0 = 日曜 〜 6 = 土曜）曜日。その月に存在しなければ例外を投げる。 */
export function nthWeekday(year: number, month: number, weekday: number, n: number): DateStr {
  if (!Number.isInteger(weekday) || weekday < 0 || weekday > 6) {
    throw new RangeError(`曜日が不正です: ${String(weekday)}`);
  }
  if (!Number.isInteger(n) || n < 1) {
    throw new RangeError(`n が不正です: ${String(n)}`);
  }
  const first = ymdToDate(year, month, 1);
  const day = 1 + ((weekday - dayOfWeek(first) + 7) % 7) + (n - 1) * 7;
  if (day > daysInMonth(year, month)) {
    throw new RangeError(
      `${String(year)}年${String(month)}月に第${String(n)}の曜日 ${String(weekday)} はありません`,
    );
  }
  return ymdToDate(year, month, day);
}

/** UTC のミリ秒を、日本時間の日付にする。 */
export function utcMsToJstDate(utcMs: number): DateStr {
  return daysToDate(Math.floor((utcMs + JST_OFFSET_MS) / MS_PER_DAY));
}

/** UTC のミリ秒を、日本時間のその日の 0:00 からの分（0〜1439）にする。 */
export function utcMsToJstMinuteOfDay(utcMs: number): number {
  // % は負の数で負を返すので、1970 年より前でも 0 以上に収める。
  const msOfDay = (((utcMs + JST_OFFSET_MS) % MS_PER_DAY) + MS_PER_DAY) % MS_PER_DAY;
  return Math.floor(msOfDay / 60_000);
}

/**
 * 日本時間の日付と、その日の 0:00 からの分（0〜1439）を、UTC のミリ秒にする。utcMsToJstDate・utcMsToJstMinuteOfDay の逆。
 * 日本時間は夏時間がなく +9 時間で固定なので、日数と分の足し算だけで求まる（Date は使わない）。
 */
export function jstToUtcMs(date: DateStr, minuteOfDay: number): number {
  if (!Number.isInteger(minuteOfDay) || minuteOfDay < 0 || minuteOfDay >= 24 * 60) {
    throw new RangeError(`0:00 からの分が不正です: ${String(minuteOfDay)}`);
  }
  return dateToDays(date) * MS_PER_DAY + minuteOfDay * 60_000 - JST_OFFSET_MS;
}

/** 日本時間の「今日」。端末のタイムゾーンは見ない。 */
export function todayJst(nowMs: number = Date.now()): DateStr {
  return utcMsToJstDate(nowMs);
}
