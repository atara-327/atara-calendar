import { deltaT } from 'astronomia/deltat';
import { Planet } from 'astronomia/planetposition';
import { apparentVSOP87 } from 'astronomia/solar';
import earthData from './data/vsop87-earth-truncated.json';
import { dateToDays, utcMsToJstDate, ymdToDate, type DateStr } from './date';

/** 太陽の黄経（度）。315 = 立春、0 = 春分、90 = 夏至、180 = 秋分、270 = 冬至。 */
export type SolarLongitude = 0 | 90 | 180 | 270 | 315;

/** 画面のスクロール範囲（設計書 Q2）に合わせている。 */
export const MIN_YEAR = 1900;
export const MAX_YEAR = 2199;

const JD_UNIX_EPOCH = 2_440_587.5;
const MS_PER_DAY = 86_400_000;
const TWO_PI = 2 * Math.PI;
const MEAN_TROPICAL_YEAR_DAYS = 365.2422;
const CONVERGED_DAYS = 1e-7;
const MAX_ITERATIONS = 50;

// 反復の出発点。実際の日は前後に 1 日ずれることがあるが、反復で補正されるので、これで足りる。
const FIRST_GUESS: Record<SolarLongitude, { month: number; day: number }> = {
  315: { month: 2, day: 4 },
  0: { month: 3, day: 20 },
  90: { month: 6, day: 21 },
  180: { month: 9, day: 23 },
  270: { month: 12, day: 22 },
};

// 元データではなく間引いたデータを使う理由は src/shared/data/README.md。
const earth = new Planet(earthData);

const cache = new Map<string, number>();

export function assertSupportedYear(year: number): void {
  if (!Number.isInteger(year) || year < MIN_YEAR || year > MAX_YEAR) {
    throw new RangeError(
      `対応していない年です: ${String(year)}（${String(MIN_YEAR)}〜${String(MAX_YEAR)}年）`,
    );
  }
}

function normalizeToPi(radians: number): number {
  return radians - TWO_PI * Math.round(radians / TWO_PI);
}

/** 太陽の視黄経が目標になる瞬間のユリウス日（力学時）。 */
function solveJde(planet: Planet, year: number, longitude: SolarLongitude): number {
  const target = (longitude * Math.PI) / 180;
  const { month, day } = FIRST_GUESS[longitude];
  let jde = dateToDays(ymdToDate(year, month, day)) + JD_UNIX_EPOCH;

  for (let i = 0; i < MAX_ITERATIONS; i++) {
    const diff = normalizeToPi(target - apparentVSOP87(planet, jde).lon);
    const step = (diff / TWO_PI) * MEAN_TROPICAL_YEAR_DAYS;
    jde += step;
    if (Math.abs(step) < CONVERGED_DAYS) return jde;
  }
  throw new Error(`太陽の黄経 ${String(longitude)}度の計算が収束しませんでした: ${String(year)}年`);
}

/**
 * planet の VSOP87 データで、year 年に太陽の視黄経が longitude 度になる瞬間（UTC のミリ秒）を求める。
 * キャッシュしない。テストで、間引いたデータと元のデータの結果を比べるために公開している。
 *
 * 世界時への換算には、節気ごとの小数年ではなく年の真ん中の ΔT を使う。
 * 求め直しても結果が変わるのは最大 1.3 秒（2149 年の冬至。実測）で、手間に見合わないため。
 */
export function computeSolarTermInstant(
  planet: Planet,
  year: number,
  longitude: SolarLongitude,
): number {
  assertSupportedYear(year);
  const jdUt = solveJde(planet, year, longitude) - deltaT(year + 0.5) / 86_400;
  return Math.round((jdUt - JD_UNIX_EPOCH) * MS_PER_DAY);
}

/** year 年に、太陽の視黄経が longitude 度になる瞬間（UTC のミリ秒）。 */
export function solarTermInstant(year: number, longitude: SolarLongitude): number {
  const key = `${String(year)}:${String(longitude)}`;
  const cached = cache.get(key);
  if (cached !== undefined) return cached;

  const utcMs = computeSolarTermInstant(earth, year, longitude);
  cache.set(key, utcMs);
  return utcMs;
}

/** year 年に、太陽の視黄経が longitude 度になる日（日本時間）。 */
export function solarTermDate(year: number, longitude: SolarLongitude): DateStr {
  return utcMsToJstDate(solarTermInstant(year, longitude));
}
