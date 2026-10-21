import { Hono } from 'hono';
import { z } from 'zod';
import { MAX_OCCURRENCES_DAYS, type OccurrencesResponse } from '../../shared/api';
import { dateToDays, dateToYmd, type DateStr } from '../../shared/date';
import { holidaysOfYear, observancesOfYear, type NamedDate } from '../../shared/holidays';
import { expandOccurrences } from '../../shared/recurrence';
import { inputDateSchema } from '../../shared/schema';
import { isInLiveWorkspace } from '../../shared/workspace';
import { readLiveData } from '../db/store';
import type { AppEnv } from '../env';
import { badRequest } from './errors';
import { parseWith } from './request';

const querySchema = z.object({ from: inputDateSchema, to: inputDateSchema });

/** 期間 [from, to] の祝日と記念日。日付順。年をまたぐ期間は、年ごとに計算する。 */
function namedDatesBetween(
  from: DateStr,
  to: DateStr,
): Pick<OccurrencesResponse, 'holidays' | 'observances'> {
  const holidays: NamedDate[] = [];
  const observances: NamedDate[] = [];
  for (let year = dateToYmd(from).year; year <= dateToYmd(to).year; year++) {
    for (const [date, name] of holidaysOfYear(year)) {
      if (date >= from && date <= to) holidays.push({ date, name });
    }
    for (const observance of observancesOfYear(year)) {
      if (observance.date >= from && observance.date <= to) observances.push(observance);
    }
  }
  // 祝日は Map の挿入順で、日付順とは限らない。記念日は、年ごとに日付順で返ってくる。
  holidays.sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : 0));
  return { holidays, observances };
}

export const occurrencesRoute = new Hono<AppEnv>();

// 画面は使わない。将来の MCP が「今週の予定は？」に答えるためのもの（設計書 5.1）。
occurrencesRoute.get('/', async (c) => {
  const { from, to } = parseWith(
    querySchema,
    { from: c.req.query('from'), to: c.req.query('to') },
    '期間',
  );
  // from が to より後なら、空を返す（設計書 7章。expandOccurrences と同じ）。
  if (from > to)
    return c.json<OccurrencesResponse>({ occurrences: [], holidays: [], observances: [] });
  // 上限があるのは、繰り返しの展開の CPU 時間のため。Node の実測で、系列 100 件の 1 年分が約 34ms かかり、
  // 無料プランの Worker（1 回 10ms）に収まらない。31 日なら約 3ms。長い期間は、呼び出し側が区切って呼ぶ。
  if (dateToDays(to) - dateToDays(from) + 1 > MAX_OCCURRENCES_DAYS) {
    throw badRequest(`期間が ${String(MAX_OCCURRENCES_DAYS)} 日を超えています: ${from}〜${to}`);
  }

  const { entries, workspaceIds } = await readLiveData(c.env.DB);
  // 削除済みのワークスペースの予定は出さない。ワークスペースの削除は中の予定も消すが、書き込みが重なると
  // （設計書 6.4）、削除したワークスペースを指す、削除されていない行が残ることがある。
  // 展開の前ではなく後で除くのは、先に除くと、除いた例外の行が抑えていた、元の系列の回が現れてしまうため。
  const occurrences = expandOccurrences(entries, from, to).filter((occurrence) =>
    isInLiveWorkspace(occurrence, workspaceIds),
  );
  return c.json<OccurrencesResponse>({ occurrences, ...namedDatesBetween(from, to) });
});
