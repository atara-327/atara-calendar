import { Hono } from 'hono';
import { z } from 'zod';
import { MAX_OCCURRENCES_DAYS, type OccurrencesResponse } from '../../shared/api';
import { dateToDays } from '../../shared/date';
import { namedDatesBetween } from '../../shared/holidays';
import { occurrencesInPeriod } from '../../shared/period';
import { inputDateSchema } from '../../shared/schema';
import { readLiveData } from '../db/store';
import type { AppEnv } from '../env';
import { badRequest } from './errors';
import { parseWith } from './request';

const querySchema = z.object({ from: inputDateSchema, to: inputDateSchema });

export const occurrencesRoute = new Hono<AppEnv>();

// 画面は、この API を呼ばず、同じ shared の関数を手元の行に当てる。
// この API は、将来の MCP が「今週の予定は？」に答えるためのもの（設計書 5.1）。
occurrencesRoute.get('/', async (c) => {
  const { from, to } = parseWith(
    querySchema,
    { from: c.req.query('from'), to: c.req.query('to') },
    '期間',
  );
  // from が to より後なら、空を返す（設計書 7章）。shared の関数も同じ結果になるが、ここで先に返すのは、
  // 空と分かっている依頼で、全行の読み込み（D1）をしないため。
  if (from > to)
    return c.json<OccurrencesResponse>({ occurrences: [], holidays: [], observances: [] });
  // 上限があるのは、繰り返しの展開の CPU 時間のため。Node の実測で、系列 100 件の 1 年分が約 34ms かかり、
  // 無料プランの Worker（1 回 10ms）に収まらない。31 日なら約 3ms。長い期間は、呼び出し側が区切って呼ぶ。
  if (dateToDays(to) - dateToDays(from) + 1 > MAX_OCCURRENCES_DAYS) {
    throw badRequest(`期間が ${String(MAX_OCCURRENCES_DAYS)} 日を超えています: ${from}〜${to}`);
  }

  const { entries, workspaceIds } = await readLiveData(c.env.DB);
  return c.json<OccurrencesResponse>({
    occurrences: occurrencesInPeriod(entries, workspaceIds, from, to),
    ...namedDatesBetween(from, to),
  });
});
