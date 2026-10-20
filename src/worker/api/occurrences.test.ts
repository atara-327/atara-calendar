import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type { OccurrencesResponse } from '../../shared/api';
import { createTestDatabase, type TestDatabase } from '../../../test/helpers/d1';
import { callApi, dumpTables, seedWorkspace } from '../../../test/helpers/api';
import { makeEntry } from '../../../test/helpers/entries';
import { makeWorkspace } from '../../../test/helpers/workspaces';
import { applyWrite } from '../db/store';

let testDatabase: TestDatabase;

beforeAll(async () => {
  testDatabase = await createTestDatabase();
});

afterAll(async () => {
  await testDatabase.dispose();
});

beforeEach(async () => {
  await testDatabase.reset();
  await seedWorkspace(db(), 'w1');
  // 4xx の応答は、原因をログに出す。テストの出力に混ぜないため、黙らせる。
  vi.spyOn(console, 'warn').mockImplementation(() => undefined);
});

afterEach(() => {
  vi.restoreAllMocks();
});

function db(): D1Database {
  return testDatabase.db;
}

async function occurrences(from: string, to: string): Promise<OccurrencesResponse> {
  const res = await callApi(db(), 'GET', `/api/occurrences?from=${from}&to=${to}`);
  expect(res.status).toBe(200);
  // 応答の形は、各テストの toEqual が確かめる。ここは、中身を読むための型付け。
  return res.body as OccurrencesResponse;
}

const invalidRequest = { error: 'invalid_request', message: '入力が正しくありません' };

describe('GET /api/occurrences', () => {
  it('NF-5: 期間にかかる回を、繰り返しを展開して、日付順に返す', async () => {
    await applyWrite(db(), {
      entries: [
        makeEntry({ id: 'p', title: '単発', startDate: '2026-10-20' }),
        // 毎週月曜（2026-10-05 から）。10-19 は、例外で個別に変えた回。
        makeEntry({
          id: 'g',
          title: 'ゴミ出し',
          rrule: { freq: 'weekly', days: [1] },
          startDate: '2026-10-05',
          allDay: false,
          startTime: '07:00',
          endTime: '07:30',
        }),
        makeEntry({
          id: 'x',
          title: 'ゴミ出し（変更）',
          seriesId: 'g',
          originalDate: '2026-10-19',
          startDate: '2026-10-19',
          endDate: '2026-10-19',
          allDay: false,
          startTime: '08:00',
          endTime: '08:30',
        }),
        makeEntry({
          id: 'b',
          kind: 'block',
          title: '作業',
          workspaceId: null,
          startDate: '2026-10-21',
          allDay: false,
          startTime: '09:00',
          endTime: '10:00',
        }),
      ],
    });

    const result = await occurrences('2026-10-19', '2026-10-21');

    expect(
      result.occurrences.map(({ entryId, seriesId, occurrenceDate, title, recurring }) => ({
        entryId,
        seriesId,
        occurrenceDate,
        title,
        recurring,
      })),
    ).toEqual([
      {
        entryId: 'x',
        seriesId: 'g',
        occurrenceDate: '2026-10-19',
        title: 'ゴミ出し（変更）',
        recurring: true,
      },
      {
        entryId: 'p',
        seriesId: 'p',
        occurrenceDate: '2026-10-20',
        title: '単発',
        recurring: false,
      },
      {
        entryId: 'b',
        seriesId: 'b',
        occurrenceDate: '2026-10-21',
        title: '作業',
        recurring: false,
      },
    ]);
  });

  it('RP-4: この回だけ削除した回と、削除した予定は出ない', async () => {
    await applyWrite(db(), {
      entries: [
        makeEntry({ id: 'daily', rrule: { freq: 'daily' }, startDate: '2026-10-19' }),
        makeEntry({
          id: 'cancel',
          seriesId: 'daily',
          originalDate: '2026-10-20',
          startDate: '2026-10-20',
          endDate: '2026-10-20',
          cancelled: true,
        }),
        makeEntry({ id: 'gone', startDate: '2026-10-21', deletedAt: 1000 }),
      ],
    });

    const result = await occurrences('2026-10-19', '2026-10-21');

    expect(
      result.occurrences.map(({ entryId, occurrenceDate }) => [entryId, occurrenceDate]),
    ).toEqual([
      ['daily', '2026-10-19'],
      ['daily', '2026-10-21'],
    ]);
  });

  it('NF-5: 応答の回に、nextNotifyAt と rev は含まれない', async () => {
    await applyWrite(db(), { entries: [makeEntry({ id: 'p', startDate: '2026-10-20' })] });
    await db().prepare("UPDATE entries SET next_notify_at = 1234567890000 WHERE id = 'p'").run();

    const result = await occurrences('2026-10-20', '2026-10-20');

    expect(result.occurrences).toHaveLength(1);
    expect(JSON.stringify(result)).not.toMatch(/nextNotifyAt|next_notify_at|"rev"/);
  });

  describe('HD-1〜HD-3: 祝日・記念日', () => {
    it('期間の祝日と記念日を、日付順で返す。年をまたいでもよい', async () => {
      // 2026-12-20〜2027-01-19 は 31 日。
      const result = await occurrences('2026-12-20', '2027-01-19');

      expect(result.holidays).toEqual([
        { date: '2027-01-01', name: '元日' },
        { date: '2027-01-11', name: '成人の日' },
      ]);
      expect(result.observances).toEqual([
        { date: '2026-12-22', name: '冬至' },
        { date: '2026-12-24', name: 'クリスマスイブ' },
        { date: '2026-12-25', name: 'クリスマス' },
        { date: '2026-12-31', name: '大晦日' },
      ]);
      expect(result.occurrences).toEqual([]);
    });

    it('期間の外の祝日・記念日は含めない', async () => {
      const result = await occurrences('2027-01-02', '2027-01-10');

      expect(result.holidays).toEqual([]);
      expect(result.observances).toEqual([]);
    });

    it('両端の日を含む', async () => {
      const result = await occurrences('2027-01-01', '2027-01-01');

      expect(result.holidays).toEqual([{ date: '2027-01-01', name: '元日' }]);
    });
  });

  describe('削除済みのワークスペースの予定は出さない', () => {
    it('ワークスペースが削除済みで、予定の行が残っていても出ない', async () => {
      await seedWorkspace(db(), 'w2');
      await applyWrite(db(), {
        entries: [
          makeEntry({ id: 'live', workspaceId: 'w1', startDate: '2026-10-20' }),
          makeEntry({ id: 'orphan', workspaceId: 'w2', startDate: '2026-10-20' }),
        ],
      });
      await applyWrite(db(), {
        workspaces: [makeWorkspace({ id: 'w2', editedAt: 3000, deletedAt: 3000 })],
      });

      const result = await occurrences('2026-10-20', '2026-10-20');

      expect(result.occurrences.map(({ entryId }) => entryId)).toEqual(['live']);
    });

    it('削除済みのワークスペースを指す例外の行は、抑えていた元の回（10-20）を、系列の回として出さない', async () => {
      await seedWorkspace(db(), 'w2');
      await applyWrite(db(), {
        entries: [
          makeEntry({
            id: 'daily',
            workspaceId: 'w1',
            rrule: { freq: 'daily' },
            startDate: '2026-10-19',
          }),
          makeEntry({
            id: 'moved',
            workspaceId: 'w2',
            seriesId: 'daily',
            originalDate: '2026-10-20',
            startDate: '2026-10-25',
            endDate: '2026-10-25',
          }),
        ],
      });
      await applyWrite(db(), {
        workspaces: [makeWorkspace({ id: 'w2', editedAt: 3000, deletedAt: 3000 })],
      });

      const result = await occurrences('2026-10-19', '2026-10-25');

      expect(result.occurrences.map(({ occurrenceDate }) => occurrenceDate)).toEqual([
        '2026-10-19',
        '2026-10-21',
        '2026-10-22',
        '2026-10-23',
        '2026-10-24',
        '2026-10-25',
      ]);
    });

    it('表示を OFF にしたワークスペースの予定は、出す（OFF は画面の都合で、予定の削除ではない）', async () => {
      await applyWrite(db(), {
        workspaces: [makeWorkspace({ id: 'w1', visible: false, editedAt: 3000 })],
        entries: [makeEntry({ id: 'p', startDate: '2026-10-20' })],
      });

      const result = await occurrences('2026-10-20', '2026-10-20');

      expect(result.occurrences.map(({ entryId }) => entryId)).toEqual(['p']);
    });
  });

  describe('期間は最大 31 日（CPU 時間のため。設計書 5.1）', () => {
    it.each([
      { from: '2026-10-01', to: '2026-10-01', days: 1 },
      { from: '2026-10-01', to: '2026-10-31', days: 31 },
      { from: '2026-02-01', to: '2026-03-03', days: 31 },
      { from: '2199-12-01', to: '2199-12-31', days: 31 },
    ])('$days 日（$from〜$to）は通る', async ({ from, to }) => {
      const res = await callApi(db(), 'GET', `/api/occurrences?from=${from}&to=${to}`);

      expect(res.status).toBe(200);
    });

    it.each([
      { from: '2026-10-01', to: '2026-11-01', days: 32 },
      { from: '2026-02-01', to: '2026-03-04', days: 32 },
      { from: '2026-01-01', to: '2026-12-31', days: 365 },
    ])('$days 日（$from〜$to）は 400。DB は読まない', async ({ from, to }) => {
      const res = await callApi(db(), 'GET', `/api/occurrences?from=${from}&to=${to}`);

      expect(res.status).toBe(400);
      expect(res.body).toEqual(invalidRequest);
    });
  });

  it('from が to より後なら、空を返す（設計書 7章）', async () => {
    await applyWrite(db(), { entries: [makeEntry({ id: 'p', startDate: '2026-10-20' })] });

    const result = await occurrences('2026-10-21', '2026-10-19');

    expect(result).toEqual({ occurrences: [], holidays: [], observances: [] });
  });

  it.each([
    { name: 'from がない', query: '?to=2026-10-31' },
    { name: 'to がない', query: '?from=2026-10-01' },
    { name: 'どちらもない', query: '' },
    { name: '日付の形が違う', query: '?from=2026-1-1&to=2026-10-31' },
    { name: '存在しない日付', query: '?from=2026-02-30&to=2026-03-01' },
    { name: '年が 1900 より前', query: '?from=1899-12-31&to=1900-01-01' },
    { name: '年が 2199 より後', query: '?from=2199-12-31&to=2200-01-01' },
  ])('$name と 400', async ({ query }) => {
    const res = await callApi(db(), 'GET', `/api/occurrences${query}`);

    expect(res.status).toBe(400);
    expect(res.body).toEqual(invalidRequest);
  });

  it('読むだけで、DB は変わらない', async () => {
    await applyWrite(db(), { entries: [makeEntry({ id: 'p', startDate: '2026-10-20' })] });
    const before = await dumpTables(db());

    await callApi(db(), 'GET', '/api/occurrences?from=2026-10-01&to=2026-10-31');

    expect(await dumpTables(db())).toEqual(before);
  });
});
