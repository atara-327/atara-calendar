import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { createTestDatabase, type TestDatabase } from '../../../test/helpers/d1';
import { callApi } from '../../../test/helpers/api';
import { makeWorkspace } from '../../../test/helpers/workspaces';
import { apiErrorBodySchema } from '../../shared/api';
import { isForeignKeyViolation } from './errors';

let testDatabase: TestDatabase;

beforeAll(async () => {
  testDatabase = await createTestDatabase();
});

afterAll(async () => {
  await testDatabase.dispose();
});

beforeEach(async () => {
  await testDatabase.reset();
  vi.spyOn(console, 'warn').mockImplementation(() => undefined);
  vi.spyOn(console, 'error').mockImplementation(() => undefined);
});

afterEach(() => {
  vi.restoreAllMocks();
});

function db(): D1Database {
  return testDatabase.db;
}

const insertEntry = (workspaceId: string | null, title: string | null) =>
  db()
    .prepare(
      `INSERT INTO entries (id, kind, title, workspace_id, all_day, start_date, end_date,
         notify_enabled, notify_offset_min, edited_at, rev)
       VALUES ('e1', 'event', ?1, ?2, 0, '2026-10-19', '2026-10-19', 1, 10, 1000, 1)`,
    )
    .bind(title, workspaceId)
    .run();

describe('isForeignKeyViolation', () => {
  it('D1 が返す、外部キー違反の例外だと true（実際の D1 の例外で確かめる）', async () => {
    const error: unknown = await insertEntry('nothing', 't').catch((caught: unknown) => caught);

    expect(error).toBeInstanceOf(Error);
    expect(isForeignKeyViolation(error)).toBe(true);
  });

  it('D1 の、ほかの制約違反（NOT NULL）だと false', async () => {
    const error: unknown = await insertEntry('builtin-holiday', null).catch(
      (caught: unknown) => caught,
    );

    expect(error).toBeInstanceOf(Error);
    expect(isForeignKeyViolation(error)).toBe(false);
  });

  it('原因（cause）に文言が入っているときも true', () => {
    const error = new Error('D1_ERROR: failed', {
      cause: new Error('FOREIGN KEY constraint failed: SQLITE_CONSTRAINT'),
    });

    expect(isForeignKeyViolation(error)).toBe(true);
  });

  it.each([null, undefined, 'FOREIGN KEY constraint failed', { message: 'x' }])(
    'Error でない値（%s）は false',
    (value) => {
      expect(isForeignKeyViolation(value)).toBe(false);
    },
  );
});

describe('書き込みの途中の外部キー違反', () => {
  /**
   * API は、書く前にワークスペースの存在を確かめている（write.ts）。確かめた後に、ワークスペースが消える
   * 割り込みで、書き込みが外部キー違反になった場合を作る。型を合わせる as は、この 1 か所だけ。
   */
  const foreignKeyViolationDb = {
    prepare: (query: string) => db().prepare(query),
    batch: () =>
      Promise.reject(new Error('D1_ERROR: FOREIGN KEY constraint failed: SQLITE_CONSTRAINT')),
  } as unknown as D1Database;

  it('500 にせず 409（conflict）にする。再送しても直らず、500 だと端末が再送し続けるため', async () => {
    const res = await callApi(foreignKeyViolationDb, 'PUT', '/api/workspaces/w2', {
      body: { workspace: makeWorkspace({ id: 'w2', editedAt: 2000 }) },
    });

    expect(res.status).toBe(409);
    expect(res.body).toEqual({
      error: 'conflict',
      message: '依頼の内容が、保存されているデータと食い違っています',
    });
  });
});

describe('想定していない例外', () => {
  /** 読み書きで、内部の情報を含む例外を投げる D1。型を合わせる as は、この 1 か所だけ。 */
  const failingDb = {
    prepare: (query: string) => db().prepare(query),
    batch: () => Promise.reject(new Error('secret-internal-detail: table entries, id e1')),
  } as unknown as D1Database;

  it('NF-5: 500 で、本文は種類と固定の文言だけ。内部の情報は、ログにだけ出す', async () => {
    const res = await callApi(failingDb, 'GET', '/api/changes?since=0');

    expect(res.status).toBe(500);
    expect(res.body).toEqual({ error: 'internal_error', message: 'サーバーでエラーが起きました' });
    expect(apiErrorBodySchema.parse(res.body).error).toBe('internal_error');
    expect(JSON.stringify(res.body)).not.toContain('secret-internal-detail');
    expect(console.error).toHaveBeenCalledWith(
      expect.stringContaining('secret-internal-detail'),
      expect.any(Error),
    );
  });

  it('NF-2: 500 にも、API のセキュリティヘッダーが付く', async () => {
    const res = await callApi(failingDb, 'GET', '/api/changes?since=0');

    expect(res.headers.get('Cache-Control')).toBe('no-store');
    expect(res.headers.get('X-Content-Type-Options')).toBe('nosniff');
    expect(res.headers.get('Referrer-Policy')).toBe('no-referrer');
  });
});
