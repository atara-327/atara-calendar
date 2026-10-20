import { Hono } from 'hono';
import { z } from 'zod';
import type { ChangesResponse } from '../../shared/api';
import { readChanges } from '../db/store';
import type { AppEnv } from '../env';
import { parseWith } from './request';

// 0 以上の整数だけ。Number('') が 0 になり、'1e3'・'1.5'・'-1' も読めてしまうので、数字だけの形を先に確かめる。
// 15 桁までにするのは、Number.MAX_SAFE_INTEGER（16 桁）を超えて、丸められないようにするため。
const sinceSchema = z
  .string()
  .regex(/^\d{1,15}$/)
  .transform(Number);

export const changesRoute = new Hono<AppEnv>();

changesRoute.get('/', async (c) => {
  const since = parseWith(sinceSchema, c.req.query('since'), 'since');
  const changes = await readChanges(c.env.DB, since);
  // 行ごとの rev と nextNotifyAt は、サーバーの都合の値なので、端末には返さない。
  const body: ChangesResponse = {
    rev: changes.rev,
    epoch: changes.epoch,
    workspaces: changes.workspaces.map(({ workspace }) => workspace),
    entries: changes.entries.map(({ entry }) => entry),
  };
  return c.json(body);
});
