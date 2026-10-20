import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import vsop87Bearth from 'astronomia/data/vsop87Bearth';
import { Planet } from 'astronomia/planetposition';
import { dateToDays } from './date';
import {
  MAX_YEAR,
  MIN_YEAR,
  computeSolarTermInstant,
  solarTermDate,
  solarTermInstant,
  type SolarLongitude,
} from './solarTerms';

const JST_OFFSET_MS = 9 * 3_600_000;

interface NaojRow {
  year: number;
  term: string;
  longitude: SolarLongitude;
  date: string;
  time: string;
}

function readNaojRows(): NaojRow[] {
  const csv = readFileSync(
    new URL('../../test/fixtures/naoj-solar-terms.csv', import.meta.url),
    'utf8',
  );
  return csv
    .trim()
    .split('\n')
    .slice(1)
    .map((line) => {
      const [year, term, longitude, date, time] = line.split(',');
      return {
        year: Number(year),
        term: term ?? '',
        longitude: Number(longitude) as SolarLongitude,
        date: date ?? '',
        time: time ?? '',
      };
    });
}

/** 国立天文台の「日付 + 時刻（日本時間）」を UTC のミリ秒にする。 */
function naojInstant(row: NaojRow): number {
  const [hour, minute] = row.time.split(':').map(Number);
  return (
    dateToDays(row.date) * 86_400_000 + ((hour ?? 0) * 60 + (minute ?? 0)) * 60_000 - JST_OFFSET_MS
  );
}

const naojRows = readNaojRows();

describe('HD-5: 国立天文台の暦要項との照合（2004〜2027年）', () => {
  it('正解データは 24 年 × 5 節気 = 120 件ある', () => {
    expect(naojRows).toHaveLength(120);
  });

  it.each(naojRows)('$year年 $term の日付（日本時間）が一致する', (row) => {
    expect(solarTermDate(row.year, row.longitude)).toBe(row.date);
  });

  it.each(naojRows)('$year年 $term の時刻が ±1 分以内で一致する', (row) => {
    const diffMs = solarTermInstant(row.year, row.longitude) - naojInstant(row);

    expect(Math.abs(diffMs)).toBeLessThanOrEqual(60_000);
  });

  it('2025年の冬至（日付の境目の 0:03）は 12/22 になる', () => {
    expect(solarTermDate(2025, 270)).toBe('2025-12-22');
  });

  it('2021年の立春（日付の境目の 23:59）は 2/3 になる', () => {
    expect(solarTermDate(2021, 315)).toBe('2021-02-03');
  });
});

describe('solarTermInstant', () => {
  it('同じ年・同じ黄経は、何度求めても同じ値になる', () => {
    expect(solarTermInstant(2026, 0)).toBe(solarTermInstant(2026, 0));
  });

  it('春分 → 夏至 → 秋分 → 冬至の順に、約 3 か月ずつ進む', () => {
    const instants = ([0, 90, 180, 270] as const).map((longitude) =>
      solarTermInstant(2026, longitude),
    );

    for (let i = 1; i < instants.length; i++) {
      const days = ((instants[i] ?? 0) - (instants[i - 1] ?? 0)) / 86_400_000;
      expect(days).toBeGreaterThan(88);
      expect(days).toBeLessThan(94);
    }
  });

  it.each([MIN_YEAR - 1, MAX_YEAR + 1, 2026.5, Number.NaN])(
    '対応外の年 %s は例外を投げる',
    (year) => {
      expect(() => solarTermInstant(year, 0)).toThrow(RangeError);
    },
  );

  it('対応する年の両端（1900年・2199年）でも、すべての節気がその年の中の日付になる', () => {
    for (const year of [MIN_YEAR, MAX_YEAR]) {
      for (const longitude of [315, 0, 90, 180, 270] as const) {
        expect(solarTermDate(year, longitude)).toMatch(new RegExp(`^${String(year)}-`));
      }
    }
  });
});

describe('間引いた VSOP87 データの精度', () => {
  const fullEarth = new Planet(vsop87Bearth);
  const longitudes = [315, 0, 90, 180, 270] as const;

  it('1900〜2199年の全節気で、元データで求めた瞬間との差が 30 秒以内', () => {
    let maxDiffMs = 0;
    for (let year = MIN_YEAR; year <= MAX_YEAR; year++) {
      for (const longitude of longitudes) {
        const diff = Math.abs(
          solarTermInstant(year, longitude) - computeSolarTermInstant(fullEarth, year, longitude),
        );
        maxDiffMs = Math.max(maxDiffMs, diff);
      }
    }

    expect(maxDiffMs).toBeLessThanOrEqual(30_000);
  });
});
