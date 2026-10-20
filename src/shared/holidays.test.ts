import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { addDays, dateToDays } from './date';
import {
  HOLIDAY_OVERRIDES,
  OBSERVANCE_OVERRIDES,
  holidayName,
  holidaysOfYear,
  isDayOff,
  isWeekday,
  observancesOfYear,
} from './holidays';

interface CabinetOfficeRow {
  date: string;
  name: string;
}

/** 内閣府の CSV（'1955/1/1,元日' の形）を、'YYYY-MM-DD' の日付にして読む。 */
function readCabinetOfficeRows(): CabinetOfficeRow[] {
  const csv = readFileSync(new URL('../../test/fixtures/syukujitsu.csv', import.meta.url), 'utf8');
  return csv
    .trim()
    .split('\n')
    .slice(1)
    .map((line) => {
      const [date = '', name = ''] = line.split(',');
      const [year = '', month = '', day = ''] = date.split('/');
      return { date: `${year}-${month.padStart(2, '0')}-${day.padStart(2, '0')}`, name };
    });
}

/**
 * 内閣府の表記と、画面に出す名前の対応。
 * CSV は「休日」と書くが、画面では振替休日と国民の休日を書き分ける。
 */
function acceptableNames({ date, name }: CabinetOfficeRow): string[] {
  switch (name) {
    case '休日':
      return ['振替休日', '国民の休日'];
    case '休日（祝日扱い）':
      return [{ '2019-05-01': '即位の日', '2019-10-22': '即位礼正殿の儀' }[date] ?? name];
    case '体育の日（スポーツの日）':
      return ['体育の日'];
    default:
      return [name];
  }
}

const cabinetOfficeRows = readCabinetOfficeRows();
const years = [...new Set(cabinetOfficeRows.map(({ date }) => Number(date.slice(0, 4))))];

function sortedEntries(holidays: ReadonlyMap<string, string>): [string, string][] {
  return [...holidays].sort(([a], [b]) => dateToDays(a) - dateToDays(b));
}

describe('HD-5: 内閣府の祝日一覧との照合（1955〜2027年）', () => {
  it('正解データは 1955〜2027 年のすべての年を含む', () => {
    expect(years[0]).toBe(1955);
    expect(years[years.length - 1]).toBe(2027);
    expect(years).toHaveLength(2027 - 1955 + 1);
  });

  it.each(years)('%i年の祝日が、日付も名前も一致する（多すぎも少なすぎもない）', (year) => {
    const computed = holidaysOfYear(year);
    const rows = cabinetOfficeRows.filter(({ date }) => date.startsWith(`${String(year)}-`));

    const expected = rows.map((row) => {
      const computedName = computed.get(row.date);
      const names = acceptableNames(row);
      return [
        row.date,
        computedName !== undefined && names.includes(computedName)
          ? computedName
          : (names[0] ?? ''),
      ];
    });

    expect(sortedEntries(computed)).toEqual(expected);
  });
});

describe('HD-5: 祝日の個別のルール', () => {
  it('祝日法の施行（1948-07-20）より前は、祝日がない', () => {
    expect(holidaysOfYear(1947).size).toBe(0);
    expect(holidayName('1900-01-01')).toBeNull();
  });

  it('1948年は、秋分の日・文化の日・勤労感謝の日だけ', () => {
    expect([...holidaysOfYear(1948).values()].sort()).toEqual(
      ['勤労感謝の日', '文化の日', '秋分の日'].sort(),
    );
  });

  it.each([
    ['1959-04-10', '結婚の儀'],
    ['1989-02-24', '大喪の礼'],
    ['1990-11-12', '即位礼正殿の儀'],
    ['1993-06-09', '結婚の儀'],
    ['2019-05-01', '即位の日'],
    ['2019-10-22', '即位礼正殿の儀'],
  ])('一度きりの祝日: %s は %s', (date, name) => {
    expect(holidayName(date)).toBe(name);
  });

  it('2020年は五輪のために、海の日・スポーツの日・山の日が動く', () => {
    expect(holidayName('2020-07-23')).toBe('海の日');
    expect(holidayName('2020-07-24')).toBe('スポーツの日');
    expect(holidayName('2020-08-10')).toBe('山の日');
    expect(holidayName('2020-07-20')).toBeNull();
    expect(holidayName('2020-10-12')).toBeNull();
  });

  it('2021年も五輪のために、海の日・スポーツの日・山の日が動く', () => {
    expect(holidayName('2021-07-22')).toBe('海の日');
    expect(holidayName('2021-07-23')).toBe('スポーツの日');
    expect(holidayName('2021-08-08')).toBe('山の日');
    expect(holidayName('2021-07-19')).toBeNull();
    expect(holidayName('2021-10-11')).toBeNull();
  });

  it('2019年には天皇誕生日がない（12/23 も 2/23 も祝日でない）', () => {
    expect(holidayName('2019-12-23')).toBeNull();
    expect(holidayName('2019-02-23')).toBeNull();
    expect(holidayName('2018-12-23')).toBe('天皇誕生日');
    expect(holidayName('2020-02-23')).toBe('天皇誕生日');
  });

  it('春分の日・秋分の日は、天文計算の結果の日になる', () => {
    expect(holidayName('2026-03-20')).toBe('春分の日');
    expect(holidayName('2026-09-23')).toBe('秋分の日');
    expect(holidayName('2021-03-20')).toBe('春分の日');
    expect(holidayName('2021-09-23')).toBe('秋分の日');
  });

  it('1948〜2199年のすべての年で、例外なく計算できる（祝日の表で、同じ日に2つの祝日が重ならない）', () => {
    const failures: string[] = [];

    for (let year = 1948; year <= 2199; year++) {
      try {
        holidaysOfYear(year);
      } catch (error) {
        failures.push(
          `${String(year)}年: ${error instanceof Error ? error.message : String(error)}`,
        );
      }
    }

    expect(failures).toEqual([]);
  });

  it('対応する年（1900〜2199年）の端でも求められる', () => {
    expect(holidaysOfYear(1900).size).toBe(0);
    expect(holidaysOfYear(2199).size).toBeGreaterThanOrEqual(16);
  });

  it.each([1899, 2200, 2026.5])('対応外の年 %s は例外を投げる', (year) => {
    expect(() => holidaysOfYear(year)).toThrow(RangeError);
  });

  it('同じ年の結果はキャッシュされ、同じものが返る', () => {
    expect(holidaysOfYear(2026)).toBe(holidaysOfYear(2026));
  });
});

describe('HD-5: 振替休日', () => {
  it('1973-04-12 以降に祝日が日曜なら、翌日の月曜が振替休日になる', () => {
    // 1973-04-29（天皇誕生日）は日曜
    expect(holidayName('1973-04-30')).toBe('振替休日');
    // 1989-01-01（元日）と 1989-01-15（成人の日）は日曜
    expect(holidayName('1989-01-02')).toBe('振替休日');
    expect(holidayName('1989-01-16')).toBe('振替休日');
  });

  it('1973-04-12 より前は、祝日が日曜でも振替休日がない', () => {
    // 1970-05-03（憲法記念日）は日曜
    expect(holidayName('1970-05-03')).toBe('憲法記念日');
    expect(holidayName('1970-05-04')).toBeNull();
  });

  it('2006年まで: 日曜の祝日の翌日（月曜）が振替休日になる', () => {
    // 1987-05-03（憲法記念日）は日曜。翌日の 5/4 は、祝日に挟まれていても国民の休日でなく振替休日
    expect(holidayName('1987-05-04')).toBe('振替休日');
  });

  it('2007年から: 日曜の祝日の後で、最も近い祝日でない日が振替休日になる', () => {
    // 2012-04-29（昭和の日）は日曜 → 翌日の月曜
    expect(holidayName('2012-04-30')).toBe('振替休日');
    // 2020-05-03（憲法記念日）は日曜。5/4・5/5 が祝日なので 5/6
    expect(holidayName('2020-05-06')).toBe('振替休日');
    // 2026-05-03（憲法記念日）は日曜。5/4・5/5 が祝日なので 5/6
    expect(holidayName('2026-05-06')).toBe('振替休日');
    // 2021-08-08（山の日）は日曜
    expect(holidayName('2021-08-09')).toBe('振替休日');
    // 2020-02-23（天皇誕生日）は日曜
    expect(holidayName('2020-02-24')).toBe('振替休日');
  });

  it('2006年までは、5/3 が日曜でも、5/6 は祝日にならない', () => {
    // 1992-05-03 は日曜。振替休日は翌日の 5/4（2007年からのルールなら 5/6 になる）
    expect(holidayName('1992-05-04')).toBe('振替休日');
    expect(holidayName('1992-05-06')).toBeNull();
  });
});

describe('HD-5: 国民の休日', () => {
  it('1986年以降に、前の日と次の日が祝日である平日は、国民の休日になる', () => {
    // 1988-04-29（天皇誕生日）の後は 5/3・5/5 に挟まれた 5/4
    expect(holidayName('1988-05-04')).toBe('国民の休日');
    // 2006-05-03（憲法記念日）と 5/5（こどもの日）の間
    expect(holidayName('2006-05-04')).toBe('国民の休日');
    // 2009-09-21（敬老の日）と 9/23（秋分の日）の間
    expect(holidayName('2009-09-22')).toBe('国民の休日');
    // 2026-09-21（敬老の日）と 9/23（秋分の日）の間
    expect(holidayName('2026-09-22')).toBe('国民の休日');
  });

  it('2019年: 即位の日の前後（4/30 と 5/2）は国民の休日になる', () => {
    expect(holidayName('2019-04-30')).toBe('国民の休日');
    expect(holidayName('2019-05-01')).toBe('即位の日');
    expect(holidayName('2019-05-02')).toBe('国民の休日');
  });

  it('2006年まで: 日曜は国民の休日にならない', () => {
    // 1986-05-04 は日曜。5/3（土）と 5/5（月）の祝日に挟まれているが、休日にならない
    expect(holidayName('1986-05-03')).toBe('憲法記念日');
    expect(holidayName('1986-05-04')).toBeNull();
    expect(holidayName('1986-05-05')).toBe('こどもの日');
  });

  it('1986年より前は、祝日に挟まれた日でも国民の休日にならない', () => {
    // 1985-05-04 は土曜で、5/3 と 5/5 は祝日（5/5 は日曜なので 5/6 が振替休日）
    expect(holidayName('1985-05-04')).toBeNull();
  });
});

describe('HD-5: 上書き一覧（設計書 Q8）', () => {
  it('既定の上書き一覧は空', () => {
    expect(HOLIDAY_OVERRIDES).toEqual([]);
  });

  it('日付と名前を指定して、祝日を追加できる', () => {
    const overrides = [{ date: '2026-10-13', name: '臨時の祝日' }];

    expect(holidayName('2026-10-13', overrides)).toBe('臨時の祝日');
    expect(holidaysOfYear(2026, overrides).get('2026-10-13')).toBe('臨時の祝日');
  });

  it('name を null にして、計算で出た祝日を外せる', () => {
    const overrides = [{ date: '2026-01-01', name: null }];

    expect(holidayName('2026-01-01', overrides)).toBeNull();
    expect(holidaysOfYear(2026, overrides).has('2026-01-01')).toBe(false);
  });

  it('計算で出た祝日の名前を差し替えられる', () => {
    const overrides = [{ date: '2026-03-20', name: '春分の日（特例）' }];

    expect(holidayName('2026-03-20', overrides)).toBe('春分の日（特例）');
  });

  it('上書きしても、既定の結果や他の年の結果は変わらない', () => {
    holidaysOfYear(2026, [{ date: '2026-10-13', name: '臨時の祝日' }]);

    expect(holidayName('2026-10-13')).toBeNull();
    expect(holidayName('2025-01-01', [{ date: '2026-01-01', name: null }])).toBe('元日');
  });

  it('上書きは計算の最後に適用し、振替休日などは計算し直さない', () => {
    // 2026-10-18 は日曜。ここを祝日にしても、翌日の月曜は振替休日にならない
    const overrides = [{ date: '2026-10-18', name: '臨時の祝日' }];

    expect(holidayName('2026-10-18', overrides)).toBe('臨時の祝日');
    expect(holidayName('2026-10-19', overrides)).toBeNull();
  });

  it('存在しない日付の上書きは例外を投げる', () => {
    expect(() => holidayName('2026-10-13', [{ date: '2026-02-30', name: 'x' }])).toThrow(
      RangeError,
    );
  });
});

describe('HD-3: 記念日', () => {
  it('2026年の13件の日付', () => {
    expect(observancesOfYear(2026)).toEqual([
      { date: '2026-02-03', name: '節分' },
      { date: '2026-02-14', name: 'バレンタインデー' },
      { date: '2026-03-03', name: 'ひな祭り' },
      { date: '2026-03-14', name: 'ホワイトデー' },
      { date: '2026-05-10', name: '母の日' },
      { date: '2026-06-21', name: '父の日' },
      { date: '2026-06-21', name: '夏至' },
      { date: '2026-07-07', name: '七夕' },
      { date: '2026-10-31', name: 'ハロウィン' },
      { date: '2026-12-22', name: '冬至' },
      { date: '2026-12-24', name: 'クリスマスイブ' },
      { date: '2026-12-25', name: 'クリスマス' },
      { date: '2026-12-31', name: '大晦日' },
    ]);
  });

  it.each([2021, 2025])('%i年の節分は 2/2（立春が 2/3 になる年）', (year) => {
    const date = observancesOfYear(year).find(({ name }) => name === '節分')?.date;

    expect(date).toBe(`${String(year)}-02-02`);
  });

  it.each([2022, 2023, 2024, 2026])('%i年の節分は 2/3（立春が 2/4 になる年）', (year) => {
    const date = observancesOfYear(year).find(({ name }) => name === '節分')?.date;

    expect(date).toBe(`${String(year)}-02-03`);
  });

  it.each([
    [2025, '2025-05-11', '2025-06-15'],
    [2026, '2026-05-10', '2026-06-21'],
    [2027, '2027-05-09', '2027-06-20'],
    [2028, '2028-05-14', '2028-06-18'],
  ])('%i年の母の日は %s、父の日は %s', (year, mothersDay, fathersDay) => {
    const dateOf = (name: string) => observancesOfYear(year).find((o) => o.name === name)?.date;

    expect(dateOf('母の日')).toBe(mothersDay);
    expect(dateOf('父の日')).toBe(fathersDay);
  });

  it('夏至・冬至・節分は、国立天文台の暦要項（2004〜2027年）と同じ日になる', () => {
    const csv = readFileSync(
      new URL('../../test/fixtures/naoj-solar-terms.csv', import.meta.url),
      'utf8',
    );
    const rows = csv
      .trim()
      .split('\n')
      .slice(1)
      .map((line) => line.split(','));

    // 国立天文台の節気名 → [記念日の名前, 節気の日から記念日までの日数]。春分・秋分は記念日にない
    const observanceOfTerm: Record<string, readonly [string, number]> = {
      夏至: ['夏至', 0],
      冬至: ['冬至', 0],
      立春: ['節分', -1],
    };
    const comparedCounts: Record<string, number> = {};

    for (const [year = '', term = '', , date = ''] of rows) {
      const target = observanceOfTerm[term];
      if (target === undefined) continue;

      const [name, offsetDays] = target;
      const actual = observancesOfYear(Number(year)).find((o) => o.name === name)?.date;

      expect(actual).toBe(addDays(date, offsetDays));
      comparedCounts[term] = (comparedCounts[term] ?? 0) + 1;
    }

    // 2004〜2027 年の 24 年 × 3 種類。照合の対象が空になって、何も確かめずに通るのを防ぐ
    expect(comparedCounts).toEqual({ 夏至: 24, 冬至: 24, 立春: 24 });
  });

  it('毎年 13 件あり、日付順に並ぶ', () => {
    for (const year of [1900, 2000, 2026, 2199]) {
      const observances = observancesOfYear(year);
      const days = observances.map(({ date }) => dateToDays(date));

      expect(observances).toHaveLength(13);
      expect(days).toEqual([...days].sort((a, b) => a - b));
    }
  });

  it('記念日は祝日に含まれない', () => {
    expect(holidayName('2026-02-14')).toBeNull();
    expect(holidayName('2026-12-25')).toBeNull();
    expect(holidaysOfYear(2026).has('2026-06-21')).toBe(false);
  });

  it('同じ年の結果はキャッシュされ、同じものが返る', () => {
    expect(observancesOfYear(2026)).toBe(observancesOfYear(2026));
  });

  it.each([1899, 2200])('対応外の年 %s は例外を投げる', (year) => {
    expect(() => observancesOfYear(year)).toThrow(RangeError);
  });
});

describe('HD-5: 記念日の上書き一覧', () => {
  it('既定の上書き一覧は空で、記念日は計算どおりになる', () => {
    expect(OBSERVANCE_OVERRIDES).toEqual([]);
    expect(observancesOfYear(2026)).toEqual(observancesOfYear(2026, []));
    expect(observancesOfYear(2026).find(({ name }) => name === '冬至')?.date).toBe('2026-12-22');
  });

  it('その年のその記念日の日付を、差し替えられる', () => {
    const overrides = [{ year: 2026, name: '冬至', date: '2026-12-23' }];

    const observances = observancesOfYear(2026, overrides);

    expect(observances.find(({ name }) => name === '冬至')).toEqual({
      date: '2026-12-23',
      name: '冬至',
    });
    expect(observances).toHaveLength(13);
  });

  it('差し替えた後も、日付順に並ぶ', () => {
    // 節分を 2/3 から 2/15 に動かすと、バレンタインデー（2/14）の後ろになる
    const overrides = [{ year: 2026, name: '節分', date: '2026-02-15' }];

    const names = observancesOfYear(2026, overrides).map(({ name }) => name);

    expect(names.slice(0, 3)).toEqual(['バレンタインデー', '節分', 'ひな祭り']);
  });

  it('同じ年の複数の記念日を、まとめて差し替えられる', () => {
    const overrides = [
      { year: 2026, name: '夏至', date: '2026-06-22' },
      { year: 2026, name: '冬至', date: '2026-12-23' },
    ];

    const dates = observancesOfYear(2026, overrides)
      .filter(({ name }) => name === '夏至' || name === '冬至')
      .map(({ date }) => date);

    expect(dates).toEqual(['2026-06-22', '2026-12-23']);
  });

  it('上書きしても、既定の結果や他の年の結果は変わらない', () => {
    const overrides = [{ year: 2026, name: '冬至', date: '2026-12-23' }];

    observancesOfYear(2026, overrides);

    expect(observancesOfYear(2026).find(({ name }) => name === '冬至')?.date).toBe('2026-12-22');
    expect(observancesOfYear(2025, overrides)).toBe(observancesOfYear(2025));
  });

  it('記念日の表にない名前の上書きは、例外を投げる', () => {
    expect(() =>
      observancesOfYear(2026, [{ year: 2026, name: '春分', date: '2026-03-20' }]),
    ).toThrow(RangeError);
  });

  it('記念日の表にない名前の上書きは、別の年の分でも例外を投げる', () => {
    expect(() =>
      observancesOfYear(2026, [{ year: 2027, name: '春分', date: '2027-03-21' }]),
    ).toThrow(RangeError);
  });

  it('日付が、上書きの年でないときは例外を投げる', () => {
    expect(() =>
      observancesOfYear(2026, [{ year: 2026, name: '冬至', date: '2027-12-22' }]),
    ).toThrow(RangeError);
  });

  it('存在しない日付の上書きは例外を投げる', () => {
    expect(() =>
      observancesOfYear(2026, [{ year: 2026, name: '冬至', date: '2026-12-32' }]),
    ).toThrow(RangeError);
  });
});

describe('RP-5: 休日と平日の判定', () => {
  it('土曜・日曜は休日', () => {
    expect(isDayOff('2026-10-17')).toBe(true);
    expect(isDayOff('2026-10-18')).toBe(true);
    expect(isWeekday('2026-10-17')).toBe(false);
    expect(isWeekday('2026-10-18')).toBe(false);
  });

  it('祝日でない月〜金は平日', () => {
    expect(isDayOff('2026-10-19')).toBe(false);
    expect(isWeekday('2026-10-19')).toBe(true);
    expect(isWeekday('2026-10-23')).toBe(true);
  });

  it('平日にあたる祝日は休日', () => {
    // 2026-10-12（月）はスポーツの日
    expect(isDayOff('2026-10-12')).toBe(true);
    expect(isWeekday('2026-10-12')).toBe(false);
  });

  it('平日にあたる振替休日・国民の休日は休日', () => {
    // 2026-05-06（水）は振替休日、2026-09-22（火）は国民の休日
    expect(isDayOff('2026-05-06')).toBe(true);
    expect(isDayOff('2026-09-22')).toBe(true);
    expect(isWeekday('2026-05-06')).toBe(false);
    expect(isWeekday('2026-09-22')).toBe(false);
  });

  it('年末年始（12/29〜1/3）は、平日にあたっても休日', () => {
    // 2025-12-29（月）〜 2025-12-31（水）、2028-01-03（月）
    for (const date of ['2025-12-29', '2025-12-30', '2025-12-31', '2026-01-02', '2028-01-03']) {
      expect(isDayOff(date)).toBe(true);
      expect(isWeekday(date)).toBe(false);
    }
  });

  it('年末年始の前後（12/28 と 1/4）の平日は、平日のまま', () => {
    // 2026-12-28（月）、2028-01-04（火）、2026-01-05（月）
    expect(isWeekday('2026-12-28')).toBe(true);
    expect(isWeekday('2028-01-04')).toBe(true);
    expect(isWeekday('2026-01-05')).toBe(true);
  });

  it('年末年始は休日の判定にだけ使い、祝日にはならない', () => {
    expect(holidayName('2025-12-29')).toBeNull();
    expect(holidayName('2026-01-02')).toBeNull();
    expect(holidaysOfYear(2025).has('2025-12-30')).toBe(false);
  });

  it('記念日の日は、平日のまま', () => {
    // 2026-07-07（火）七夕、2026-12-24（木）クリスマスイブ、2026-02-03（火）節分
    for (const date of ['2026-07-07', '2026-12-24', '2026-02-03', '2026-03-03']) {
      expect(observancesOfYear(2026).some((o) => o.date === date)).toBe(true);
      expect(isDayOff(date)).toBe(false);
      expect(isWeekday(date)).toBe(true);
    }
  });

  it('上書き一覧の追加・削除が、休日の判定に反映される', () => {
    expect(isWeekday('2026-10-13', [{ date: '2026-10-13', name: '臨時の祝日' }])).toBe(false);
    expect(isWeekday('2026-10-12', [{ date: '2026-10-12', name: null }])).toBe(true);
    // 土日は、祝日から外しても休日のまま
    expect(isDayOff('2026-10-18', [{ date: '2026-10-18', name: null }])).toBe(true);
  });

  it.each(['1899-12-31', '2200-01-01'])('対応外の日付 %s は、土日でも例外を投げる', (date) => {
    expect(() => isDayOff(date)).toThrow(RangeError);
    expect(() => isWeekday(date)).toThrow(RangeError);
  });
});
