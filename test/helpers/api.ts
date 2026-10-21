import { expect } from 'vitest';
import type { z } from 'zod';
import { changesResponseSchema, type ChangesResponse } from '../../src/shared/api';
import type { Bindings } from '../../src/worker/env';
import { app } from '../../src/worker/index';

export interface ApiResponse {
  status: number;
  body: unknown;
  headers: Headers;
}

interface CallOptions {
  body?: unknown;
  /** JSON にしていない本文（壊れた JSON を送りたいとき）。 */
  rawBody?: string;
}

/**
 * app.request() で API を呼ぶ。認証は AUTH_MODE: 'dev'（localhost のときだけ効く）で通し、
 * 他サイトからのリクエストの確認（Sec-Fetch-Site と JSON）は、本物のミドルウェアのまま通す。
 */
export async function callApi(
  db: D1Database,
  method: 'GET' | 'PUT' | 'PATCH' | 'DELETE',
  path: string,
  { body, rawBody }: CallOptions = {},
): Promise<ApiResponse> {
  const env: Bindings = { DB: db, ACCESS_TEAM_DOMAIN: '', ACCESS_AUD: '', AUTH_MODE: 'dev' };
  const payload = rawBody ?? (body === undefined ? undefined : JSON.stringify(body));
  const res = await app.request(
    path,
    {
      method,
      headers: { 'Sec-Fetch-Site': 'same-origin', 'Content-Type': 'application/json' },
      body: payload,
    },
    env,
  );
  return { status: res.status, body: await res.json(), headers: res.headers };
}

/** GET /api/changes を呼んで、200 の応答を、スキーマ（changesResponseSchema）で確かめて返す。 */
export function fetchChanges(db: D1Database, since: number): Promise<ChangesResponse> {
  return callParsed(db, `/api/changes?since=${String(since)}`, changesResponseSchema);
}

/** GET を呼んで、200 の応答を、スキーマで確かめて返す。スキーマに合わない応答は、テストの失敗にする。 */
export async function callParsed<T extends z.ZodType>(
  db: D1Database,
  path: string,
  schema: T,
): Promise<z.infer<T>> {
  const res = await callApi(db, 'GET', path);
  expect(res.status).toBe(200);
  return schema.parse(res.body);
}

/**
 * 予定の行が使う外部キーの相手を、rev 0 の行として入れる。applyWrite で入れると meta.rev が進み、
 * テストが期待する rev（マイグレーション直後の次から数える）がずれるため。
 */
export async function seedWorkspace(db: D1Database, id: string, sortOrder = 0): Promise<void> {
  await db
    .prepare(
      `INSERT INTO workspaces (id, name, color, sort_order, visible, builtin, edited_at, rev)
       VALUES (?1, ?1, '#4285F4', ?2, 1, NULL, 0, 0)`,
    )
    .bind(id, sortOrder)
    .run();
}

/** テーブルの中身をそのまま取り出す。「DB が変わらない」ことを、行の変換を通さずに確かめるため。 */
export async function dumpTables(db: D1Database) {
  const [meta, workspaces, entries] = await db.batch([
    db.prepare('SELECT * FROM meta'),
    db.prepare('SELECT * FROM workspaces ORDER BY id'),
    db.prepare('SELECT * FROM entries ORDER BY id'),
  ]);
  return { meta: meta?.results, workspaces: workspaces?.results, entries: entries?.results };
}
