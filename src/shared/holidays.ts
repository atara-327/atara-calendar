import {
  addDays,
  dateToDays,
  dateToYmd,
  dayOfWeek,
  nthWeekday,
  ymdToDate,
  type DateStr,
} from './date';
import { assertSupportedYear, solarTermDate, type SolarLongitude } from './solarTerms';

/** 祝日の上書き。name が null なら、その日を祝日から外す（設計書 Q8）。 */
export interface HolidayOverride {
  date: DateStr;
  name: string | null;
}

export interface NamedDate {
  date: DateStr;
  name: string;
}

export type Observance = NamedDate;

/**
 * 内閣府の正式な発表と、計算の結果が食い違ったときに、ここへ足す。
 * 内閣府の CSV を自動で取りに行かないのは、形式の変更や文字コード（Shift_JIS）の扱いで壊れやすく、
 * 上書きが必要になるのは法律の特例があるときだけ（数年に1回程度）だから。
 */
export const HOLIDAY_OVERRIDES: readonly HolidayOverride[] = [];

const SUNDAY = 0;
const MONDAY = 1;
const SATURDAY = 6;

type DateRule =
  | { kind: 'fixed'; month: number; day: number }
  | { kind: 'nthWeekday'; month: number; weekday: number; n: number }
  | { kind: 'solarTerm'; longitude: SolarLongitude; offsetDays: number | undefined };

interface HolidayRule {
  name: string;
  fromYear: number;
  /** 省略すると、それ以降ずっと。 */
  toYear?: number;
  rule: DateRule;
}

const fixed = (month: number, day: number): DateRule => ({ kind: 'fixed', month, day });
const nthMonday = (month: number, n: number): DateRule => ({
  kind: 'nthWeekday',
  month,
  weekday: MONDAY,
  n,
});
const nthSunday = (month: number, n: number): DateRule => ({
  kind: 'nthWeekday',
  month,
  weekday: SUNDAY,
  n,
});
const solarTerm = (longitude: SolarLongitude, offsetDays?: number): DateRule => ({
  kind: 'solarTerm',
  longitude,
  offsetDays,
});

// 祝日法は 1948-07-20 に施行された。それより前の年は、どの行にも当てはまらないので祝日がない。
// 2020・2021 年の五輪による移動は、一度きりの祝日の表には入れず、年を限った行として並べる。
// 一度きりの祝日の表に入れると、「その年だけ元の日付の祝日を消す」処理が別に必要になるため。
const HOLIDAY_RULES: readonly HolidayRule[] = [
  { name: '元日', fromYear: 1949, rule: fixed(1, 1) },
  { name: '成人の日', fromYear: 1949, toYear: 1999, rule: fixed(1, 15) },
  { name: '成人の日', fromYear: 2000, rule: nthMonday(1, 2) },
  { name: '建国記念の日', fromYear: 1967, rule: fixed(2, 11) },
  { name: '春分の日', fromYear: 1949, rule: solarTerm(0) },
  { name: '天皇誕生日', fromYear: 1949, toYear: 1988, rule: fixed(4, 29) },
  { name: '天皇誕生日', fromYear: 1989, toYear: 2018, rule: fixed(12, 23) },
  { name: '天皇誕生日', fromYear: 2020, rule: fixed(2, 23) },
  { name: 'みどりの日', fromYear: 1989, toYear: 2006, rule: fixed(4, 29) },
  { name: 'みどりの日', fromYear: 2007, rule: fixed(5, 4) },
  { name: '昭和の日', fromYear: 2007, rule: fixed(4, 29) },
  { name: '憲法記念日', fromYear: 1949, rule: fixed(5, 3) },
  { name: 'こどもの日', fromYear: 1949, rule: fixed(5, 5) },
  { name: '海の日', fromYear: 1996, toYear: 2002, rule: fixed(7, 20) },
  { name: '海の日', fromYear: 2003, toYear: 2019, rule: nthMonday(7, 3) },
  { name: '海の日', fromYear: 2020, toYear: 2020, rule: fixed(7, 23) },
  { name: '海の日', fromYear: 2021, toYear: 2021, rule: fixed(7, 22) },
  { name: '海の日', fromYear: 2022, rule: nthMonday(7, 3) },
  { name: '山の日', fromYear: 2016, toYear: 2019, rule: fixed(8, 11) },
  { name: '山の日', fromYear: 2020, toYear: 2020, rule: fixed(8, 10) },
  { name: '山の日', fromYear: 2021, toYear: 2021, rule: fixed(8, 8) },
  { name: '山の日', fromYear: 2022, rule: fixed(8, 11) },
  { name: '敬老の日', fromYear: 1966, toYear: 2002, rule: fixed(9, 15) },
  { name: '敬老の日', fromYear: 2003, rule: nthMonday(9, 3) },
  { name: '秋分の日', fromYear: 1948, rule: solarTerm(180) },
  { name: '体育の日', fromYear: 1966, toYear: 1999, rule: fixed(10, 10) },
  { name: '体育の日', fromYear: 2000, toYear: 2019, rule: nthMonday(10, 2) },
  { name: 'スポーツの日', fromYear: 2020, toYear: 2020, rule: fixed(7, 24) },
  { name: 'スポーツの日', fromYear: 2021, toYear: 2021, rule: fixed(7, 23) },
  { name: 'スポーツの日', fromYear: 2022, rule: nthMonday(10, 2) },
  { name: '文化の日', fromYear: 1948, rule: fixed(11, 3) },
  { name: '勤労感謝の日', fromYear: 1948, rule: fixed(11, 23) },
];

/** 一度きりの祝日。国民の祝日として扱い、国民の休日の判定でも祝日に数える。 */
const ONE_OFF_HOLIDAYS: readonly NamedDate[] = [
  { date: '1959-04-10', name: '結婚の儀' },
  { date: '1989-02-24', name: '大喪の礼' },
  { date: '1990-11-12', name: '即位礼正殿の儀' },
  { date: '1993-06-09', name: '結婚の儀' },
  { date: '2019-05-01', name: '即位の日' },
  { date: '2019-10-22', name: '即位礼正殿の儀' },
];

// 記念日は表（データ）として持つ（HD-4）。
const OBSERVANCE_RULES: readonly { name: string; rule: DateRule }[] = [
  { name: '節分', rule: solarTerm(315, -1) },
  { name: 'バレンタインデー', rule: fixed(2, 14) },
  { name: 'ひな祭り', rule: fixed(3, 3) },
  { name: 'ホワイトデー', rule: fixed(3, 14) },
  { name: '母の日', rule: nthSunday(5, 2) },
  { name: '父の日', rule: nthSunday(6, 3) },
  { name: '夏至', rule: solarTerm(90) },
  { name: '七夕', rule: fixed(7, 7) },
  { name: 'ハロウィン', rule: fixed(10, 31) },
  { name: '冬至', rule: solarTerm(270) },
  { name: 'クリスマスイブ', rule: fixed(12, 24) },
  { name: 'クリスマス', rule: fixed(12, 25) },
  { name: '大晦日', rule: fixed(12, 31) },
];

/** 振替休日の制度が始まった日。この日より前の祝日が日曜でも、振替休日はない。 */
const SUBSTITUTE_HOLIDAY_START: DateStr = '1973-04-12';
/** 国民の休日の制度が始まった年。 */
const CITIZENS_HOLIDAY_START_YEAR = 1986;
/** 振替休日と国民の休日のルールが変わった年。 */
const RULE_CHANGE_YEAR = 2007;

function resolveDateRule(year: number, rule: DateRule): DateStr {
  switch (rule.kind) {
    case 'fixed':
      return ymdToDate(year, rule.month, rule.day);
    case 'nthWeekday':
      return nthWeekday(year, rule.month, rule.weekday, rule.n);
    case 'solarTerm':
      return addDays(solarTermDate(year, rule.longitude), rule.offsetDays ?? 0);
  }
}

function isInYears(
  year: number,
  { fromYear, toYear }: { fromYear: number; toYear?: number },
): boolean {
  return year >= fromYear && (toYear === undefined || year <= toYear);
}

// 年をまたいで判定しないのは、年末年始（12/31 と 1/1）を前後から挟む祝日の並びがなく、
// 振替休日も 12/23 や 1/1 の翌日で収まるため。
function computeHolidays(year: number): Map<DateStr, string> {
  assertSupportedYear(year);

  const national = new Map<DateStr, string>();
  for (const { name, rule, ...years } of HOLIDAY_RULES) {
    if (isInYears(year, years)) national.set(resolveDateRule(year, rule), name);
  }
  for (const { date, name } of ONE_OFF_HOLIDAYS) {
    if (dateToYmd(date).year === year) national.set(date, name);
  }

  const all = new Map(national);

  // 振替休日。国民の休日より先に決める（5/4 が日曜の翌日かつ祝日に挟まれたとき、振替休日を優先する）。
  for (const date of national.keys()) {
    if (date < SUBSTITUTE_HOLIDAY_START || dayOfWeek(date) !== SUNDAY) continue;
    let substitute = addDays(date, 1);
    if (year >= RULE_CHANGE_YEAR) {
      while (national.has(substitute)) substitute = addDays(substitute, 1);
    }
    all.set(substitute, '振替休日');
  }

  // 国民の休日。前の日と次の日が祝日（振替休日・国民の休日は数えない）である日。
  if (year >= CITIZENS_HOLIDAY_START_YEAR) {
    for (const date of national.keys()) {
      const between = addDays(date, 1);
      if (!national.has(addDays(date, 2)) || all.has(between)) continue;
      if (year < RULE_CHANGE_YEAR && dayOfWeek(between) === SUNDAY) continue;
      all.set(between, '国民の休日');
    }
  }

  return all;
}

const holidayCache = new Map<number, ReadonlyMap<DateStr, string>>();

function baseHolidays(year: number): ReadonlyMap<DateStr, string> {
  const cached = holidayCache.get(year);
  if (cached !== undefined) return cached;
  const computed = computeHolidays(year);
  holidayCache.set(year, computed);
  return computed;
}

/**
 * year 年の祝日（国民の祝日・振替休日・国民の休日）。日付 → 名前。
 * 1900〜2199 年に対応する。範囲外は例外を投げる。
 */
export function holidaysOfYear(
  year: number,
  overrides: readonly HolidayOverride[] = HOLIDAY_OVERRIDES,
): ReadonlyMap<DateStr, string> {
  const base = baseHolidays(year);
  const applicable = overrides.filter(({ date }) => dateToYmd(date).year === year);
  if (applicable.length === 0) return base;

  // 上書きは、振替休日などの計算がすべて終わった後で、その日の名前だけを差し替える。
  // 上書きした結果から振替休日を計算し直さないのは、正式な発表の内容をそのまま信じるため。
  const merged = new Map(base);
  for (const { date, name } of applicable) {
    if (name === null) merged.delete(date);
    else merged.set(date, name);
  }
  return merged;
}

/** その日の祝日名。祝日でなければ null。 */
export function holidayName(
  date: DateStr,
  overrides: readonly HolidayOverride[] = HOLIDAY_OVERRIDES,
): string | null {
  return holidaysOfYear(dateToYmd(date).year, overrides).get(date) ?? null;
}

const observanceCache = new Map<number, readonly Observance[]>();

/**
 * year 年の記念日（休日ではない）。日付順。同じ日に重なることがある（例: 2026 年の夏至と父の日）。
 * 1900〜2199 年に対応する。範囲外は例外を投げる。
 */
export function observancesOfYear(year: number): readonly Observance[] {
  const cached = observanceCache.get(year);
  if (cached !== undefined) return cached;

  assertSupportedYear(year);
  const observances = OBSERVANCE_RULES.map(({ name, rule }) => ({
    date: resolveDateRule(year, rule),
    name,
  })).sort((a, b) => dateToDays(a.date) - dateToDays(b.date));
  observanceCache.set(year, observances);
  return observances;
}

/**
 * 休日（土曜・日曜・祝日・年末年始の 12/29〜1/3）かどうか。記念日は休日に含めない。
 * 祝日（holiday）より広いので、名前を分けている。
 */
export function isDayOff(
  date: DateStr,
  overrides: readonly HolidayOverride[] = HOLIDAY_OVERRIDES,
): boolean {
  const { year, month, day } = dateToYmd(date);
  // 土日でも先に引くのは、対応外の年を、曜日によらず同じ例外にそろえるため。
  const isHoliday = holidaysOfYear(year, overrides).has(date);
  const weekday = dayOfWeek(date);
  const isNewYear = (month === 12 && day >= 29) || (month === 1 && day <= 3);
  return weekday === SUNDAY || weekday === SATURDAY || isNewYear || isHoliday;
}

/** 平日（休日でない日）かどうか。 */
export function isWeekday(
  date: DateStr,
  overrides: readonly HolidayOverride[] = HOLIDAY_OVERRIDES,
): boolean {
  return !isDayOff(date, overrides);
}
