import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { createTestDatabase, type TestDatabase } from '../../../test/helpers/d1';
import { createDevice, type Device } from '../../../test/helpers/device';
import { readAllRows } from '../../../test/helpers/rows';
import { addDays } from '../../shared/date';
import { occurrencesInPeriod } from '../../shared/period';
import { changeEntry, createEntry, type Occurrence } from '../../shared/recurrence';
import type { EntryChanges, Scope } from '../../shared/schema';
import { liveWorkspaceIds } from '../../shared/workspace';
import { applyWrite } from '../../worker/db/store';
import { WeekViewCache } from '../month/weekViewCache';
import { weekNumberOf } from '../month/weeks';
import { DELETE_UNDO_MS } from '../sync/engine';
import { toChanges, toDraft } from './build';
import { describeFirstOccurrence, firstOccurrence, seriesRruleOf } from './repeat';
import { moveStart } from './schedule';
import { decideScope, type ScopeAction } from './scope';
import { validateForm } from './validate';
import { createValues, editValues, setKind, type FormValues } from './values';

// 繰り返しの予定を、フォームが作る本文（draft・changes）と、フォームが決める範囲（scope.ts）で、本物のエンジンと
// Worker（Miniflare の D1）に渡す。確かめることは 2 つ。
// 1. 作る・変更する・削除する（範囲ごと）と、月表示の回が、設計書 4.5 のとおりに変わる。
// 2. フォームが選べるとした範囲で送った依頼は、サーバーで 4xx にならず（保存できなかった変更が 0 件）、
//    サーバーの行（削除済みを含む）と、エンジンの view が一致する。
// 画面（React）そのものは、ここでは動かさない。判断を持つ部分は、画面に依存しない関数にしてあるため（設計書 2章）。

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

// 日本時間 2026-10-22（木）の 14:20（UTC 05:20）。
const AT_1420 = Date.UTC(2026, 9, 22, 5, 20);
const WORKSPACE = 'default-workspace';
// 2026-10-19 は月曜。
const MONDAY = '2026-10-19';

function isApplied(status: number, body: unknown): boolean {
  return (
    status === 200 &&
    typeof body === 'object' &&
    body !== null &&
    'applied' in body &&
    body.applied === true
  );
}

async function startedDevice(): Promise<Device> {
  const device = createDevice({ db: testDatabase.db });
  await device.engine.start();
  await device.engine.settled();
  return device;
}

function newValues(overrides: Partial<FormValues> = {}): FormValues {
  return {
    ...createValues({ kind: 'event', nowMs: AT_1420, workspaceId: WORKSPACE }),
    title: '練習',
    startDate: MONDAY,
    endDate: MONDAY,
    ...overrides,
  };
}

/** フォームの保存と同じ手順で、新しく作る。 */
async function create(device: Device, values: FormValues): Promise<string> {
  expect(validateForm(values)).toEqual({});
  const accepted = device.engine.createEntry(toDraft(values));
  if (accepted === null) throw new Error('エンジンが受け付けませんでした');
  await device.engine.settled();
  return accepted.entryId;
}

function occurrencesBetween(device: Device, from: string, to: string): Occurrence[] {
  const { entries, workspaces } = device.state().view;
  return occurrencesInPeriod(
    [...entries.values()],
    liveWorkspaceIds(workspaces.values()),
    from,
    to,
  );
}

/** 月表示が持つ回（押したときに、フォームへ渡す回）。回の日付（別の日に移した例外なら、元の日付）で探す。 */
function occurrenceOn(device: Device, seriesId: string, date: string): Occurrence {
  const found = occurrencesBetween(device, addDays(date, -14), addDays(date, 14)).find(
    (occurrence) => occurrence.seriesId === seriesId && occurrence.occurrenceDate === date,
  );
  if (found === undefined) throw new Error(`${date} の回がありません`);
  return found;
}

/** 開いた回の入力値（フォームを開いたときと同じ）。 */
function opened(device: Device, occurrence: Occurrence): FormValues {
  return editValues(
    occurrence,
    AT_1420,
    seriesRruleOf(device.state().view.entries, occurrence.seriesId),
  );
}

/** 月表示（週ごとの行）に、題名が出る日。 */
function monthDates(device: Device, title: string, from: string, to: string): string[] {
  const { entries, workspaces } = device.state().view;
  const cache = new WeekViewCache({
    entries: [...entries.values()],
    workspaces: workspaces.values(),
    slots: 20,
  });
  const dates: string[] = [];
  for (let week = weekNumberOf(from); week <= weekNumberOf(to); week += 1) {
    for (const item of cache.get(week).items) {
      if (item.kind !== 'more' && item.event.title === title) dates.push(item.event.startDate);
    }
  }
  return dates.filter((date) => date >= from && date <= to).sort();
}

/** 回の開始の時刻。日付ごと。 */
function startTimes(device: Device, from: string, to: string): Record<string, string | null> {
  return Object.fromEntries(
    occurrencesBetween(device, from, to).map(({ startDate, startTime }) => [startDate, startTime]),
  );
}

/**
 * 送信と受け取りが終わったあと、送った書き込みが、すべて書かれていて（200 の applied: true。4xx にも、200 の「捨てた」にも
 * なっていない）、サーバーの全行が、エンジンの view と一致する。
 * 行の一致だけでは、「捨てた」を見逃す。捨てられた依頼の結果は、受け取りのあと、view からも消えるので、
 * 一致して見えるため。
 */
async function expectServerMatchesView(device: Device): Promise<void> {
  await device.engine.settled();
  expect(
    device.network.writeResponses.filter(({ status, body }) => !isApplied(status, body)),
  ).toEqual([]);
  expect(device.state().discarded.count).toBe(0);
  expect(device.state().queue).toEqual([]);
  const server = await readAllRows(testDatabase.db);
  expect(Object.fromEntries(device.state().view.entries)).toEqual(
    Object.fromEntries(server.entries),
  );
}

/** フォームの保存と同じ手順。選べる範囲を決め、選んだ範囲が、その中にあることを確かめて、エンジンに渡す。 */
function save(device: Device, occurrence: Occurrence, values: FormValues, scope: Scope) {
  expect(validateForm(values, occurrence)).toEqual({});
  const originalRrule = seriesRruleOf(device.state().view.entries, occurrence.seriesId);
  const changes = toChanges(values, occurrence, originalRrule);
  const action: ScopeAction = { kind: 'change', changes };
  const decision = decideScope({
    rows: device.state().view.entries.values(),
    occurrence,
    action,
  });
  expect(decision.kind).toBe('choose');
  if (decision.kind !== 'choose') throw new Error('範囲を選べません');
  expect(decision.scopes).toContain(scope);
  const accepted = device.engine.changeEntry(
    { seriesId: occurrence.seriesId, occurrenceDate: occurrence.occurrenceDate, scope },
    changes,
  );
  if (accepted === null) throw new Error('エンジンが受け付けませんでした');
  return { changes, scopes: decision.scopes };
}

/** フォームの削除と同じ手順。 */
function remove(device: Device, occurrence: Occurrence, scope: Scope) {
  const decision = decideScope({
    rows: device.state().view.entries.values(),
    occurrence,
    action: { kind: 'delete' },
  });
  expect(decision.kind).toBe('choose');
  if (decision.kind !== 'choose') throw new Error('範囲を選べません');
  expect(decision.scopes).toContain(scope);
  const accepted = device.engine.deleteEntry({
    seriesId: occurrence.seriesId,
    occurrenceDate: occurrence.occurrenceDate,
    scope,
  });
  if (accepted === null) throw new Error('エンジンが受け付けませんでした');
  return accepted;
}

async function sendDeletes(device: Device): Promise<void> {
  device.clock.advance(DELETE_UNDO_MS);
  await device.engine.settled();
}

describe('書き込みの応答の確認（このファイルのテストが、捨てられた依頼を見逃さないことの確認）', () => {
  it('対象の回がない依頼は、200 の applied: false で捨てられる。そのとき、行は、view と一致して見える', async () => {
    const device = await startedDevice();
    const entryId = await create(device, newValues({ repeat: 'weekly', repeatDays: [1, 3, 5] }));

    // 10/20 は火曜で、この系列の回ではない。「この予定のみ」の変更は、対象がないので、サーバーが捨てる。
    device.engine.changeEntry(
      { seriesId: entryId, occurrenceDate: '2026-10-20', scope: 'this' },
      { title: '存在しない回' },
    );
    await device.engine.settled();

    const last = device.network.writeResponses.at(-1);
    expect(last).toMatchObject({ status: 200, body: { applied: false } });
    expect(isApplied(last?.status ?? 0, last?.body)).toBe(false);
    // 4xx ではないので、「保存できなかった変更」にも数えられない。行も一致して見える。
    expect(device.state().discarded.count).toBe(0);
    expect(Object.fromEntries(device.state().view.entries)).toEqual(
      Object.fromEntries((await readAllRows(testDatabase.db)).entries),
    );
  });
});

describe('繰り返しの予定を作る（RP-1・RP-6）', () => {
  it('毎週（水・金）を、月曜の開始日で作ると、最初の回は水曜になり、水・金に回が出る', async () => {
    const device = await startedDevice();
    const values = newValues({ repeat: 'weekly', repeatDays: [5, 3] });

    const first = firstOccurrence(values);
    expect(describeFirstOccurrence(first, values.startDate)).toBe(
      '最初の回は 10月21日（水）になります',
    );
    const entryId = await create(device, values);

    const row = (await readAllRows(testDatabase.db)).entries.get(entryId);
    expect(row).toMatchObject({
      rrule: { freq: 'weekly', days: [3, 5] },
      startDate: '2026-10-21',
      endDate: '2026-10-21',
    });
    expect(monthDates(device, '練習', '2026-10-19', '2026-11-06')).toEqual([
      '2026-10-21',
      '2026-10-23',
      '2026-10-28',
      '2026-10-30',
      '2026-11-04',
      '2026-11-06',
    ]);
    await expectServerMatchesView(device);
  });

  it('毎月 31 日は、31 日がない月を飛ばす（RP-2）', async () => {
    const device = await startedDevice();

    await create(
      device,
      newValues({ repeat: 'monthly', startDate: '2026-10-31', endDate: '2026-10-31' }),
    );

    expect(monthDates(device, '練習', '2026-10-31', '2027-03-31')).toEqual([
      '2026-10-31',
      '2026-12-31',
      '2027-01-31',
      '2027-03-31',
    ]);
    await expectServerMatchesView(device);
  });

  it('毎年 2/29 は、うるう年だけ出る（Q9）', async () => {
    const device = await startedDevice();

    await create(
      device,
      newValues({ repeat: 'yearly', startDate: '2028-02-29', endDate: '2028-02-29' }),
    );

    expect(monthDates(device, '練習', '2028-01-01', '2033-12-31')).toEqual([
      '2028-02-29',
      '2032-02-29',
    ]);
    await expectServerMatchesView(device);
  });

  it('平日を土曜から始めると、最初の回は月曜になり、土日・祝日（11/3 文化の日）に回が出ない', async () => {
    const device = await startedDevice();
    const values = newValues({ repeat: 'weekday', startDate: '2026-10-24', endDate: '2026-10-24' });

    expect(describeFirstOccurrence(firstOccurrence(values), values.startDate)).toBe(
      '最初の回は 10月26日（月）になります',
    );
    await create(device, values);

    expect(monthDates(device, '練習', '2026-10-24', '2026-11-08')).toEqual([
      '2026-10-26',
      '2026-10-27',
      '2026-10-28',
      '2026-10-29',
      '2026-10-30',
      '2026-11-02',
      '2026-11-04',
      '2026-11-05',
      '2026-11-06',
    ]);
    await expectServerMatchesView(device);
  });

  it('休日を金曜から始めると、最初の回は土曜になり、土日・祝日に回が出る', async () => {
    const device = await startedDevice();

    await create(
      device,
      newValues({ repeat: 'holiday', startDate: '2026-10-23', endDate: '2026-10-23' }),
    );

    expect(monthDates(device, '練習', '2026-10-23', '2026-11-08')).toEqual([
      '2026-10-24',
      '2026-10-25',
      '2026-10-31',
      '2026-11-01',
      '2026-11-03',
      '2026-11-07',
      '2026-11-08',
    ]);
    await expectServerMatchesView(device);
  });

  it('タイムブロックも繰り返せる（月表示には出ない。行と、回で確かめる）', async () => {
    const device = await startedDevice();
    const values = setKind(newValues({ title: '睡眠', repeat: 'daily' }), 'block');

    const entryId = await create(device, values);

    expect((await readAllRows(testDatabase.db)).entries.get(entryId)).toMatchObject({
      kind: 'block',
      workspaceId: null,
      rrule: { freq: 'daily' },
    });
    expect(monthDates(device, '睡眠', '2026-10-19', '2026-10-25')).toEqual([]);
    expect(
      occurrencesBetween(device, '2026-10-19', '2026-10-21').map(({ startDate }) => startDate),
    ).toEqual(['2026-10-19', '2026-10-20', '2026-10-21']);
    await expectServerMatchesView(device);
  });

  it('繰り返さない予定に、ルールを付けると、範囲を聞かずに、繰り返す予定になる（開始日はずれる）', async () => {
    const device = await startedDevice();
    const entryId = await create(device, newValues());
    const occurrence = occurrenceOn(device, entryId, MONDAY);
    expect(occurrence.recurring).toBe(false);

    const values = { ...opened(device, occurrence), repeat: 'weekly' as const, repeatDays: [3] };
    expect(validateForm(values, occurrence)).toEqual({});
    const changes = toChanges(values, occurrence, null);
    expect(
      decideScope({
        rows: device.state().view.entries.values(),
        occurrence,
        action: { kind: 'change', changes },
      }),
    ).toEqual({ kind: 'single' });
    device.engine.changeEntry({ seriesId: entryId, occurrenceDate: MONDAY, scope: 'all' }, changes);

    await expectServerMatchesView(device);
    expect((await readAllRows(testDatabase.db)).entries.get(entryId)).toMatchObject({
      rrule: { freq: 'weekly', days: [3] },
      startDate: '2026-10-21',
    });
    expect(monthDates(device, '練習', '2026-10-19', '2026-11-01')).toEqual([
      '2026-10-21',
      '2026-10-28',
    ]);
  });
});

describe('繰り返しの予定を変更する（範囲。設計書 4.5）', () => {
  /** 毎週（月・水・金）の 15:00〜16:00。月曜の 10-19 から。 */
  async function deviceWithWeekly() {
    const device = await startedDevice();
    const entryId = await create(device, newValues({ repeat: 'weekly', repeatDays: [1, 3, 5] }));
    device.network.calls.length = 0;
    return { device, entryId };
  }

  it('「この予定のみ」で、1 回の題名を変えると、その回だけ変わる（例外の行ができる）', async () => {
    const { device, entryId } = await deviceWithWeekly();
    const occurrence = occurrenceOn(device, entryId, '2026-10-21');

    const { scopes } = save(
      device,
      occurrence,
      { ...opened(device, occurrence), title: '臨時' },
      'this',
    );
    await expectServerMatchesView(device);

    expect(scopes).toEqual(['this', 'following', 'all']);
    expect(monthDates(device, '臨時', '2026-10-19', '2026-10-30')).toEqual(['2026-10-21']);
    expect(monthDates(device, '練習', '2026-10-19', '2026-10-30')).toEqual([
      '2026-10-19',
      '2026-10-23',
      '2026-10-26',
      '2026-10-28',
      '2026-10-30',
    ]);
    const { entries } = await readAllRows(testDatabase.db);
    expect(entries.get(entryId)?.title).toBe('練習');
    expect([...entries.values()].filter((row) => row.seriesId === entryId)).toHaveLength(1);
  });

  it('「これ以降すべて」で、時刻を変えると、その回から先だけが新しい時刻になる（系列が切れる）', async () => {
    const { device, entryId } = await deviceWithWeekly();
    const occurrence = occurrenceOn(device, entryId, '2026-10-26');

    save(
      device,
      occurrence,
      moveStart(opened(device, occurrence), { startTime: '17:00' }),
      'following',
    );
    await expectServerMatchesView(device);

    expect(startTimes(device, '2026-10-19', '2026-11-02')).toEqual({
      '2026-10-19': '15:00',
      '2026-10-21': '15:00',
      '2026-10-23': '15:00',
      '2026-10-26': '17:00',
      '2026-10-28': '17:00',
      '2026-10-30': '17:00',
      '2026-11-02': '17:00',
    });
    expect((await readAllRows(testDatabase.db)).entries.get(entryId)?.untilDate).toBe('2026-10-25');
  });

  it('「すべて」で、題名を変えると、系列の全部の回が変わる。個別に時刻を変えた回は、時刻をそのまま保つ', async () => {
    const { device, entryId } = await deviceWithWeekly();
    const individual = occurrenceOn(device, entryId, '2026-10-21');
    save(device, individual, moveStart(opened(device, individual), { startTime: '16:00' }), 'this');
    await expectServerMatchesView(device);
    const occurrence = occurrenceOn(device, entryId, '2026-10-19');

    save(device, occurrence, { ...opened(device, occurrence), title: '練習（改）' }, 'all');
    await expectServerMatchesView(device);

    expect(monthDates(device, '練習（改）', '2026-10-19', '2026-10-30')).toEqual([
      '2026-10-19',
      '2026-10-21',
      '2026-10-23',
      '2026-10-26',
      '2026-10-28',
      '2026-10-30',
    ]);
    expect(monthDates(device, '練習', '2026-10-19', '2026-10-30')).toEqual([]);
    expect(startTimes(device, '2026-10-19', '2026-10-23')).toEqual({
      '2026-10-19': '15:00',
      '2026-10-21': '16:00',
      '2026-10-23': '15:00',
    });
  });

  it('「すべて」で、時刻を変えても、個別に時刻を変えた回は、その時刻のまま（開いた回が、その例外なら、変わる）', async () => {
    const { device, entryId } = await deviceWithWeekly();
    const individual = occurrenceOn(device, entryId, '2026-10-21');
    save(device, individual, moveStart(opened(device, individual), { startTime: '16:00' }), 'this');
    await expectServerMatchesView(device);

    const other = occurrenceOn(device, entryId, '2026-10-23');
    save(device, other, moveStart(opened(device, other), { startTime: '18:00' }), 'all');
    await expectServerMatchesView(device);
    expect(startTimes(device, '2026-10-19', '2026-10-23')).toEqual({
      '2026-10-19': '18:00',
      '2026-10-21': '16:00',
      '2026-10-23': '18:00',
    });

    const exception = occurrenceOn(device, entryId, '2026-10-21');
    save(device, exception, moveStart(opened(device, exception), { startTime: '19:00' }), 'all');
    await expectServerMatchesView(device);
    expect(startTimes(device, '2026-10-19', '2026-10-23')).toEqual({
      '2026-10-19': '19:00',
      '2026-10-21': '19:00',
      '2026-10-23': '19:00',
    });
  });

  it('ルールを変えると、「この予定のみ」は選べず、「これ以降すべて」で、その回から先だけ、新しいルールになる', async () => {
    const { device, entryId } = await deviceWithWeekly();
    const occurrence = occurrenceOn(device, entryId, '2026-10-26');

    const { scopes } = save(
      device,
      occurrence,
      { ...opened(device, occurrence), repeatDays: [1, 3] },
      'following',
    );
    await expectServerMatchesView(device);

    expect(scopes).toEqual(['following', 'all']);
    expect(monthDates(device, '練習', '2026-10-19', '2026-11-06')).toEqual([
      '2026-10-19',
      '2026-10-21',
      '2026-10-23',
      '2026-10-26',
      '2026-10-28',
      '2026-11-02',
      '2026-11-04',
    ]);
  });

  it('ルールを変えて「すべて」にすると、例外の行は消える（どの例外がどの回に当たるかが変わるため）', async () => {
    const { device, entryId } = await deviceWithWeekly();
    const individual = occurrenceOn(device, entryId, '2026-10-21');
    save(device, individual, { ...opened(device, individual), title: '臨時' }, 'this');
    await expectServerMatchesView(device);
    const occurrence = occurrenceOn(device, entryId, '2026-10-23');

    save(device, occurrence, { ...opened(device, occurrence), repeat: 'daily' }, 'all');
    await expectServerMatchesView(device);

    expect(monthDates(device, '臨時', '2026-10-19', '2026-10-30')).toEqual([]);
    expect(monthDates(device, '練習', '2026-10-19', '2026-10-22')).toEqual([
      '2026-10-19',
      '2026-10-20',
      '2026-10-21',
      '2026-10-22',
    ]);
  });

  it('ルールを「しない」に変えて「すべて」にすると、繰り返さない予定になる', async () => {
    const { device, entryId } = await deviceWithWeekly();
    const occurrence = occurrenceOn(device, entryId, '2026-10-23');

    save(device, occurrence, { ...opened(device, occurrence), repeat: 'none' }, 'all');
    await expectServerMatchesView(device);

    expect((await readAllRows(testDatabase.db)).entries.get(entryId)).toMatchObject({
      rrule: null,
      untilDate: null,
    });
    expect(monthDates(device, '練習', '2026-10-19', '2026-11-30')).toEqual(['2026-10-19']);
  });

  it('毎日の予定の日付を変えると、「この予定のみ」だけを選べる。その回だけが、別の日に移る', async () => {
    const device = await startedDevice();
    const entryId = await create(device, newValues({ repeat: 'daily' }));
    const occurrence = occurrenceOn(device, entryId, '2026-10-21');

    const { scopes } = save(
      device,
      occurrence,
      moveStart(opened(device, occurrence), { startDate: '2026-10-24' }),
      'this',
    );
    await expectServerMatchesView(device);

    expect(scopes).toEqual(['this']);
    expect(startTimes(device, '2026-10-20', '2026-10-25')).toMatchObject({
      '2026-10-20': '15:00',
      '2026-10-22': '15:00',
    });
    const { entries } = await readAllRows(testDatabase.db);
    expect([...entries.values()].find((row) => row.seriesId === entryId)).toMatchObject({
      originalDate: '2026-10-21',
      startDate: '2026-10-24',
    });
    expect(entries.get(entryId)).toMatchObject({ startDate: MONDAY, rrule: { freq: 'daily' } });
  });

  it('毎週を毎日に変えて、日付も変えると、どの範囲も選べず、何も送らない（片方ずつ保存する）', async () => {
    const { device, entryId } = await deviceWithWeekly();
    const occurrence = occurrenceOn(device, entryId, '2026-10-21');
    const values = moveStart(
      { ...opened(device, occurrence), repeat: 'daily' as const },
      { startDate: '2026-10-22' },
    );

    const decision = decideScope({
      rows: device.state().view.entries.values(),
      occurrence,
      action: {
        kind: 'change',
        changes: toChanges(values, occurrence, seriesRruleOf(device.state().view.entries, entryId)),
      },
    });

    expect(decision).toEqual({ kind: 'unavailable', reason: 'ruleAndDate' });
    expect(device.network.writes).toEqual([]);
  });

  it('開いている間に、ほかの端末が系列を削除したら、対象がないと分かり、何も送らない', async () => {
    const { device, entryId } = await deviceWithWeekly();
    const occurrence = occurrenceOn(device, entryId, '2026-10-21');
    const other = createDevice({ db: testDatabase.db, idPrefix: 'other' });
    await other.engine.start();
    await other.engine.settled();
    const theirs = occurrenceOn(other, entryId, '2026-10-21');
    other.engine.deleteEntry({
      seriesId: entryId,
      occurrenceDate: theirs.occurrenceDate,
      scope: 'all',
    });
    other.clock.advance(DELETE_UNDO_MS);
    await other.engine.settled();
    await device.engine.syncNow();
    await device.engine.settled();

    const decision = decideScope({
      rows: device.state().view.entries.values(),
      occurrence,
      action: { kind: 'change', changes: { title: '変更' } },
    });

    expect(decision).toEqual({ kind: 'gone' });
  });
});

describe('繰り返しの予定を削除する（範囲。設計書 4.5）', () => {
  async function deviceWithWeekly() {
    const device = await startedDevice();
    const entryId = await create(device, newValues({ repeat: 'weekly', repeatDays: [1, 3, 5] }));
    device.network.calls.length = 0;
    return { device, entryId };
  }

  it('「この予定のみ」で削除すると、その回だけが消える', async () => {
    const { device, entryId } = await deviceWithWeekly();

    remove(device, occurrenceOn(device, entryId, '2026-10-21'), 'this');
    expect(monthDates(device, '練習', '2026-10-19', '2026-10-30')).not.toContain('2026-10-21');
    await sendDeletes(device);
    await expectServerMatchesView(device);

    expect(monthDates(device, '練習', '2026-10-19', '2026-10-30')).toEqual([
      '2026-10-19',
      '2026-10-23',
      '2026-10-26',
      '2026-10-28',
      '2026-10-30',
    ]);
    const { entries } = await readAllRows(testDatabase.db);
    expect([...entries.values()].find((row) => row.seriesId === entryId)).toMatchObject({
      cancelled: true,
      originalDate: '2026-10-21',
    });
  });

  it('「これ以降すべて」で削除すると、その回から先が消える（系列が切れる）', async () => {
    const { device, entryId } = await deviceWithWeekly();

    remove(device, occurrenceOn(device, entryId, '2026-10-26'), 'following');
    await sendDeletes(device);
    await expectServerMatchesView(device);

    expect(monthDates(device, '練習', '2026-10-19', '2026-11-30')).toEqual([
      '2026-10-19',
      '2026-10-21',
      '2026-10-23',
    ]);
    expect((await readAllRows(testDatabase.db)).entries.get(entryId)?.untilDate).toBe('2026-10-25');
  });

  it('「すべて」で削除すると、系列も、例外の回も、すべて消える', async () => {
    const { device, entryId } = await deviceWithWeekly();
    const individual = occurrenceOn(device, entryId, '2026-10-21');
    save(device, individual, { ...opened(device, individual), title: '臨時' }, 'this');
    await expectServerMatchesView(device);

    remove(device, occurrenceOn(device, entryId, '2026-10-23'), 'all');
    await sendDeletes(device);
    await expectServerMatchesView(device);

    expect(monthDates(device, '練習', '2026-10-19', '2026-11-30')).toEqual([]);
    expect(monthDates(device, '臨時', '2026-10-19', '2026-11-30')).toEqual([]);
    const { entries } = await readAllRows(testDatabase.db);
    expect([...entries.values()].every((row) => row.deletedAt !== null)).toBe(true);
  });

  it('元に戻すと、削除前に戻り、サーバーには削除を送らない（範囲によらない）', async () => {
    for (const scope of ['this', 'following', 'all'] as const) {
      const { device, entryId } = await deviceWithWeekly();
      const before = monthDates(device, '練習', '2026-10-19', '2026-11-30');

      const { requestId } = remove(device, occurrenceOn(device, entryId, '2026-10-26'), scope);
      expect(monthDates(device, '練習', '2026-10-19', '2026-11-30')).not.toEqual(before);
      expect(device.engine.undo(requestId)).toBe(true);
      await sendDeletes(device);

      expect(monthDates(device, '練習', '2026-10-19', '2026-11-30')).toEqual(before);
      expect(device.network.writes).toEqual([]);
      expect((await readAllRows(testDatabase.db)).entries.get(entryId)?.deletedAt).toBeNull();
      await testDatabase.reset();
    }
  });
});

// フォームが選べるとした範囲は、どれも、サーバーで 4xx にならない。ルールの種類 × 開く回 × 変える内容の、
// 組み合わせを総当たりで試す。選べないとされた組み合わせは、送らないので、ここでは試さない。
// 試す数が多いので、系列は、フォームを通さず、shared の createEntry で作って、DB に直接書く（作る経路は、上で確かめた）。
describe('フォームが選べるとした範囲は、サーバーに断られず、サーバーの行と、エンジンの view が一致する', () => {
  const SERIES_ID = 'series-1';

  const SERIES: readonly {
    name: string;
    values: Partial<FormValues>;
    dates: string[];
    /** 10/21 の回を、「この予定のみ」で変えた例外の行を、先に作っておく（別の日・時刻に移した回。系列の状態）。 */
    exception?: EntryChanges;
  }[] = [
    { name: '毎日', values: { repeat: 'daily' }, dates: ['2026-10-22'] },
    {
      name: '毎週（月・水・金）',
      values: { repeat: 'weekly', repeatDays: [1, 3, 5] },
      dates: ['2026-10-19', '2026-10-23'],
    },
    {
      name: '毎週（月・水・金）で、10/21 の回を、10/22 の 17:00 に移した例外がある',
      values: { repeat: 'weekly', repeatDays: [1, 3, 5] },
      // 開く回は、例外の回（回の日付は、元の日付の 10/21）と、そのあとの回。
      dates: ['2026-10-21', '2026-10-23'],
      exception: {
        startDate: '2026-10-22',
        endDate: '2026-10-22',
        startTime: '17:00',
        endTime: '18:00',
      },
    },
    { name: '毎月', values: { repeat: 'monthly' }, dates: ['2026-11-19'] },
    { name: '平日', values: { repeat: 'weekday' }, dates: ['2026-10-22'] },
  ];

  const EDITS: readonly { name: string; edit: (values: FormValues) => FormValues }[] = [
    { name: '題名', edit: (v) => ({ ...v, title: '変更後' }) },
    { name: '時刻', edit: (v) => moveStart(v, { startTime: '17:00' }) },
    {
      name: '日付を 1 日後ろへ',
      edit: (v) => moveStart(v, { startDate: addDays(v.startDate, 1) }),
    },
    { name: 'ルールを毎日へ', edit: (v) => ({ ...v, repeat: 'daily' }) },
    { name: 'ルールを平日へ', edit: (v) => ({ ...v, repeat: 'weekday' }) },
    { name: 'ルールを休日へ', edit: (v) => ({ ...v, repeat: 'holiday' }) },
    { name: 'ルールを毎週（火）へ', edit: (v) => ({ ...v, repeat: 'weekly', repeatDays: [2] }) },
    { name: 'ルールをなくす', edit: (v) => ({ ...v, repeat: 'none' }) },
    {
      name: 'ルールを毎日へ・日付を 1 日後ろへ',
      edit: (v) => ({ ...moveStart(v, { startDate: addDays(v.startDate, 1) }), repeat: 'daily' }),
    },
    {
      name: 'ルールを毎週（火）へ・日付を 1 日後ろへ',
      edit: (v) => ({
        ...moveStart(v, { startDate: addDays(v.startDate, 1) }),
        repeat: 'weekly',
        repeatDays: [2],
      }),
    },
  ];

  /** 系列（と、あれば例外の行）だけがある状態から、端末を起動して、開く回を用意する。 */
  async function openedDevice(
    series: Partial<FormValues>,
    date: string,
    exception: EntryChanges | undefined,
  ) {
    await testDatabase.db.prepare('DELETE FROM entries').run();
    const values = newValues(series);
    expect(validateForm(values)).toEqual({});
    const seriesRows = createEntry({
      draft: toDraft(values),
      newId: SERIES_ID,
      editedAt: Date.now() - 60_000,
    });
    await applyWrite(testDatabase.db, { entries: seriesRows });
    if (exception !== undefined) {
      const exceptionRows = changeEntry({
        entries: seriesRows,
        target: { seriesId: SERIES_ID, occurrenceDate: '2026-10-21' },
        scope: 'this',
        changes: exception,
        newId: 'exception-1',
        editedAt: Date.now() - 30_000,
      });
      await applyWrite(testDatabase.db, { entries: exceptionRows });
    }
    const device = await startedDevice();
    return { device, occurrence: occurrenceOn(device, SERIES_ID, date) };
  }

  describe.each(SERIES)('変更: $name', ({ values, dates, exception }) => {
    it.each(dates)(
      '%s の回を開いて、変える内容ごとに、選べる範囲をすべて試す',
      async (date) => {
        const probe = await openedDevice(values, date, exception);
        const trials: string[] = [];
        for (const { name, edit } of EDITS) {
          const edited = edit(opened(probe.device, probe.occurrence));
          if (Object.keys(validateForm(edited, probe.occurrence)).length > 0) continue;
          const changes = toChanges(
            edited,
            probe.occurrence,
            seriesRruleOf(probe.device.state().view.entries, SERIES_ID),
          );
          const decision = decideScope({
            rows: probe.device.state().view.entries.values(),
            occurrence: probe.occurrence,
            action: { kind: 'change', changes },
          });
          if (decision.kind !== 'choose') {
            trials.push(`${name}: ${decision.kind}`);
            continue;
          }
          for (const scope of decision.scopes) {
            const { device, occurrence } = await openedDevice(values, date, exception);
            save(device, occurrence, edit(opened(device, occurrence)), scope);
            await expectServerMatchesView(device);
            trials.push(`${name}: ${scope}`);
          }
        }
        // 題名・時刻の変更は、どの系列でも、3 つとも試した。
        expect(trials).toEqual(
          expect.arrayContaining(['題名: this', '題名: following', '題名: all', '時刻: all']),
        );
      },
      60_000,
    );
  });

  describe.each(SERIES)('削除: $name', ({ values, dates, exception }) => {
    it.each(dates)(
      '%s の回を開いて、3 つの範囲のどれで削除しても、サーバーに断られない',
      async (date) => {
        for (const scope of ['this', 'following', 'all'] as const) {
          const { device, occurrence } = await openedDevice(values, date, exception);
          remove(device, occurrence, scope);
          await sendDeletes(device);
          await expectServerMatchesView(device);
        }
      },
      60_000,
    );
  });
});
