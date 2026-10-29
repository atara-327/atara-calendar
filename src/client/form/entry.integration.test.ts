import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { createTestDatabase, type TestDatabase } from '../../../test/helpers/d1';
import { createDevice, type Device } from '../../../test/helpers/device';
import { readAllRows } from '../../../test/helpers/rows';
import { makeWorkspace } from '../../../test/helpers/workspaces';
import type { Occurrence } from '../../shared/recurrence';
import { occurrencesInPeriod } from '../../shared/period';
import { liveWorkspaceIds } from '../../shared/workspace';
import { DELETE_UNDO_MS } from '../sync/engine';
import { WeekViewCache } from '../month/weekViewCache';
import { weekNumberOf } from '../month/weeks';
import { toChanges, toDraft } from './build';
import { validateForm } from './validate';
import { createValues, editValues, setAllDay, setKind, type FormValues } from './values';
import { moveStart } from './schedule';

// フォームが作る本文（draft・changes）を、本物のエンジンと Worker（Miniflare の D1）に渡して、
// 作った予定が月表示に出る・changes が変えた項目だけをサーバーへ送る・削除して元に戻すと戻る、を確かめる。
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

async function startedDevice(): Promise<Device> {
  const device = createDevice({ db: testDatabase.db });
  await device.engine.start();
  await device.engine.settled();
  return device;
}

function newValues(overrides: Partial<FormValues> = {}): FormValues {
  return {
    ...createValues({ kind: 'event', nowMs: AT_1420, workspaceId: WORKSPACE }),
    title: '歯医者',
    ...overrides,
  };
}

/** フォームの入力値を確かめて、エンジンに渡す（フォームの保存と同じ手順）。 */
function create(device: Device, values: FormValues): string {
  expect(validateForm(values)).toEqual({});
  const accepted = device.engine.createEntry(toDraft(values));
  if (accepted === null) throw new Error('エンジンが受け付けませんでした');
  return accepted.entryId;
}

/** 月表示が持つ回（押したときに、フォームへ渡す回）。 */
function occurrenceOf(device: Device, entryId: string): Occurrence {
  const { entries, workspaces } = device.state().view;
  const row = entries.get(entryId);
  if (row === undefined) throw new Error('行がありません');
  const [occurrence] = occurrencesInPeriod(
    [...entries.values()],
    liveWorkspaceIds(workspaces.values()),
    row.startDate,
    row.startDate,
  );
  if (occurrence === undefined) throw new Error('回がありません');
  return occurrence;
}

function change(device: Device, occurrence: Occurrence, values: FormValues) {
  const changes = toChanges(values, occurrence, null);
  const accepted = device.engine.changeEntry(
    { seriesId: occurrence.seriesId, occurrenceDate: occurrence.occurrenceDate, scope: 'all' },
    changes,
  );
  if (accepted === null) throw new Error('エンジンが受け付けませんでした');
  return changes;
}

/** 週に出る予定の題名。祝日・記念日の横棒は、予定ではないので数えない。 */
function monthEventTitles(device: Device, date: string): string[] {
  const { entries, workspaces } = device.state().view;
  const cache = new WeekViewCache({
    entries: [...entries.values()],
    workspaces: workspaces.values(),
    slots: 6,
  });
  return cache
    .get(weekNumberOf(date))
    .items.flatMap((item) =>
      item.kind !== 'more' && item.event.source === 'entry' ? [item.event.title] : [],
    );
}

describe('新しく作る', () => {
  it('フォームで作った予定が、月表示に出る回になり、サーバーにも保存される', async () => {
    const device = await startedDevice();

    const entryId = create(device, newValues({ location: '渋谷', memo: '保険証' }));

    expect(monthEventTitles(device, '2026-10-22')).toEqual(['歯医者']);
    await device.engine.settled();
    const saved = (await readAllRows(testDatabase.db)).entries.get(entryId);
    expect(saved).toMatchObject({
      kind: 'event',
      title: '歯医者',
      workspaceId: WORKSPACE,
      allDay: false,
      startDate: '2026-10-22',
      startTime: '15:00',
      endDate: '2026-10-22',
      endTime: '16:00',
      location: '渋谷',
      url: null,
      memo: '保険証',
      notifyEnabled: true,
      notifyOffsetMin: 10,
    });
    expect(device.state().discarded.count).toBe(0);
  });

  it('終日・複数日の予定も作れる（通知は当日の朝 6 時 = -360）', async () => {
    const device = await startedDevice();
    const values = { ...setAllDay(newValues({ title: '帰省' }), true), endDate: '2026-10-24' };

    const entryId = create(device, values);

    await device.engine.settled();
    expect((await readAllRows(testDatabase.db)).entries.get(entryId)).toMatchObject({
      allDay: true,
      startTime: null,
      endTime: null,
      startDate: '2026-10-22',
      endDate: '2026-10-24',
      notifyOffsetMin: -360,
    });
    expect(monthEventTitles(device, '2026-10-23')).toEqual(['帰省']);
    expect(device.state().discarded.count).toBe(0);
  });

  it('日付をまたぐタイムブロック（23:00〜翌 7:00）は作れて、月表示には出ない', async () => {
    const device = await startedDevice();
    const values = setKind(newValues({ title: '睡眠' }), 'block');

    const entryId = create(device, {
      ...values,
      startTime: '23:00',
      endDate: '2026-10-23',
      endTime: '07:00',
    });

    await device.engine.settled();
    expect((await readAllRows(testDatabase.db)).entries.get(entryId)).toMatchObject({
      kind: 'block',
      workspaceId: null,
      startDate: '2026-10-22',
      startTime: '23:00',
      endDate: '2026-10-23',
      endTime: '07:00',
      notifyEnabled: false,
    });
    expect(monthEventTitles(device, '2026-10-22')).toEqual([]);
    expect(device.state().discarded.count).toBe(0);
  });

  it('フォームの確認を通る入力は、サーバーに断られない（保存できなかった変更が 0 件）', async () => {
    const device = await startedDevice();
    const inputs: FormValues[] = [
      newValues(),
      setAllDay(newValues(), true),
      newValues({ notifyOffsetText: '0' }),
      newValues({ notifyOffsetText: '10080', url: 'https://example.com/a?b=1' }),
      newValues({ title: 'あ'.repeat(200), location: '渋'.repeat(200), memo: 'あ'.repeat(10_000) }),
      setKind(newValues(), 'block'),
      newValues({ startDate: '1900-01-01', endDate: '1900-01-01' }),
      newValues({
        startDate: '2199-12-31',
        startTime: '10:00',
        endDate: '2199-12-31',
        endTime: '23:45',
      }),
    ];

    for (const values of inputs) create(device, values);
    await device.engine.settled();

    expect(device.state().discarded.count).toBe(0);
    expect(device.state().queue).toEqual([]);
    expect((await readAllRows(testDatabase.db)).entries.size).toBe(inputs.length);
  });
});

describe('開いた予定を変更する', () => {
  async function deviceWithEvent() {
    const device = await startedDevice();
    const entryId = create(device, newValues({ location: '渋谷', memo: '保険証' }));
    await device.engine.settled();
    device.network.calls.length = 0;
    return { device, entryId };
  }

  it('タイトルだけ変えると、changes にはタイトルだけが入り、ほかの項目は、サーバーでそのまま', async () => {
    const { device, entryId } = await deviceWithEvent();
    const occurrence = occurrenceOf(device, entryId);

    const changes = change(device, occurrence, {
      ...editValues(occurrence, AT_1420, null),
      title: '歯医者（予約済み）',
    });
    await device.engine.settled();

    expect(changes).toEqual({ title: '歯医者（予約済み）' });
    expect(device.network.writes).toHaveLength(1);
    expect(device.network.writes[0]?.body).toMatchObject({
      changes: { title: '歯医者（予約済み）' },
    });
    expect((await readAllRows(testDatabase.db)).entries.get(entryId)).toMatchObject({
      title: '歯医者（予約済み）',
      location: '渋谷',
      memo: '保険証',
      startTime: '15:00',
      endTime: '16:00',
      workspaceId: WORKSPACE,
    });
    expect(monthEventTitles(device, '2026-10-22')).toEqual(['歯医者（予約済み）']);
  });

  it('開始の時刻を変えると、終了も同じ長さで動き、月表示も、サーバーも変わる', async () => {
    const { device, entryId } = await deviceWithEvent();
    const occurrence = occurrenceOf(device, entryId);

    const values = moveStart(editValues(occurrence, AT_1420, null), { startTime: '17:30' });
    const changes = change(device, occurrence, values);
    await device.engine.settled();

    expect(changes).toEqual({ startTime: '17:30', endTime: '18:30' });
    expect((await readAllRows(testDatabase.db)).entries.get(entryId)).toMatchObject({
      startTime: '17:30',
      endTime: '18:30',
    });
  });

  it('開始の日付を変えると、終了の日付も動き、その日の月表示に移る', async () => {
    const { device, entryId } = await deviceWithEvent();
    const occurrence = occurrenceOf(device, entryId);

    const values = moveStart(editValues(occurrence, AT_1420, null), { startDate: '2026-10-27' });
    change(device, occurrence, values);
    await device.engine.settled();

    expect((await readAllRows(testDatabase.db)).entries.get(entryId)).toMatchObject({
      startDate: '2026-10-27',
      endDate: '2026-10-27',
    });
    expect(monthEventTitles(device, '2026-10-22')).toEqual([]);
    expect(monthEventTitles(device, '2026-10-27')).toEqual(['歯医者']);
  });

  it('開始の日付を変えて、終了を別の長さに直したら、直した終了になる（サーバーが長さを保って動かした値にならない）', async () => {
    const { device, entryId } = await deviceWithEvent();
    const occurrence = occurrenceOf(device, entryId);

    const values = {
      ...moveStart(editValues(occurrence, AT_1420, null), { startDate: '2026-10-27' }),
      endDate: '2026-10-29',
    };
    change(device, occurrence, values);
    await device.engine.settled();

    expect((await readAllRows(testDatabase.db)).entries.get(entryId)).toMatchObject({
      startDate: '2026-10-27',
      endDate: '2026-10-29',
    });
  });

  it('ワークスペースを変えると、新しいワークスペースの予定になる', async () => {
    const { device, entryId } = await deviceWithEvent();
    device.engine.saveWorkspace(makeWorkspace({ id: 'work', name: '仕事', sortOrder: 1 }));
    await device.engine.settled();
    const occurrence = occurrenceOf(device, entryId);

    change(device, occurrence, { ...editValues(occurrence, AT_1420, null), workspaceId: 'work' });
    await device.engine.settled();

    expect((await readAllRows(testDatabase.db)).entries.get(entryId)?.workspaceId).toBe('work');
  });

  it('時間指定を終日にすると、時刻が消えて、通知は当日の朝 6 時になる', async () => {
    const { device, entryId } = await deviceWithEvent();
    const occurrence = occurrenceOf(device, entryId);

    const values = setAllDay(editValues(occurrence, AT_1420, null), true);
    expect(validateForm(values)).toEqual({});
    change(device, occurrence, values);
    await device.engine.settled();

    expect((await readAllRows(testDatabase.db)).entries.get(entryId)).toMatchObject({
      allDay: true,
      startTime: null,
      endTime: null,
      notifyOffsetMin: -360,
    });
    expect(device.state().discarded.count).toBe(0);
  });

  it('場所を空にすると null（空にした）として送られ、サーバーでも空になる', async () => {
    const { device, entryId } = await deviceWithEvent();
    const occurrence = occurrenceOf(device, entryId);

    const changes = change(device, occurrence, {
      ...editValues(occurrence, AT_1420, null),
      location: '',
    });
    await device.engine.settled();

    expect(changes).toEqual({ location: null });
    expect((await readAllRows(testDatabase.db)).entries.get(entryId)?.location).toBeNull();
  });

  it('API から入れた、当日の朝 6 時でない終日の予定は、タイトルだけ変えても、通知の値が変わらない', async () => {
    const device = await startedDevice();
    const apiValues = {
      ...setAllDay(newValues({ title: '誕生日' }), true),
      notifyOffsetText: '-480',
    };
    const entryId = device.engine.createEntry(toDraft(apiValues))?.entryId ?? '';
    await device.engine.settled();
    const occurrence = occurrenceOf(device, entryId);

    const changes = change(device, occurrence, {
      ...editValues(occurrence, AT_1420, null),
      title: '誕生日（祝）',
    });
    await device.engine.settled();

    expect(changes).toEqual({ title: '誕生日（祝）' });
    expect((await readAllRows(testDatabase.db)).entries.get(entryId)?.notifyOffsetMin).toBe(-480);
  });
});

describe('終日の予定を時間指定に変える（通知の分は、意味が変わる。設計書 4.3）', () => {
  /** API から入れた、終日の予定（通知の分は、フォームの固定の値とは限らない）。 */
  async function deviceWithAllDay(notifyOffsetMin: number) {
    const device = await startedDevice();
    const apiValues = { ...setAllDay(newValues({ title: '誕生日' }), true) };
    const draft = { ...toDraft(apiValues), notifyOffsetMin };
    const accepted = device.engine.createEntry(draft);
    if (accepted === null) throw new Error('エンジンが受け付けませんでした');
    await device.engine.settled();
    return { device, entryId: accepted.entryId };
  }

  it('終日の -360（当日の朝 6 時）と同じ -360 を、時間指定で入力しても、フォームの確認が止める（開始の 6 時間後の通知を作らない）', async () => {
    const { device, entryId } = await deviceWithAllDay(-360);
    const occurrence = occurrenceOf(device, entryId);
    const values = {
      ...setAllDay(editValues(occurrence, AT_1420, null), false),
      notifyOffsetText: '-360',
    };

    expect(validateForm(values, occurrence).notify).toBeDefined();
  });

  it('時間指定にして、元と同じ数（5）を入力して保存すると、サーバーの行は、フォームの下書きと一致する', async () => {
    const { device, entryId } = await deviceWithAllDay(5);
    const occurrence = occurrenceOf(device, entryId);
    const values = {
      ...setAllDay(editValues(occurrence, AT_1420, null), false),
      notifyOffsetText: '5',
    };
    expect(validateForm(values, occurrence)).toEqual({});
    device.network.calls.length = 0;

    const changes = change(device, occurrence, values);
    await device.engine.settled();

    // 数が同じでも、通知の分を送る（終日を変えたため）。
    expect(changes).toMatchObject({ allDay: false, notifyOffsetMin: 5 });
    expect(device.network.writes[0]?.body).toMatchObject({ changes: { notifyOffsetMin: 5 } });
    const draft = toDraft(values);
    expect((await readAllRows(testDatabase.db)).entries.get(entryId)).toMatchObject({
      allDay: draft.allDay,
      startTime: draft.startTime,
      endTime: draft.endTime,
      notifyEnabled: draft.notifyEnabled,
      notifyOffsetMin: draft.notifyOffsetMin,
    });
    expect(device.state().discarded.count).toBe(0);
  });

  it('時間指定に変えて、通知の分を直さなければ、初期値（10 分前）になり、サーバーの行も、10 分前の時間指定になる', async () => {
    const { device, entryId } = await deviceWithAllDay(-360);
    const occurrence = occurrenceOf(device, entryId);
    const values = setAllDay(editValues(occurrence, AT_1420, null), false);
    expect(validateForm(values, occurrence)).toEqual({});

    change(device, occurrence, values);
    await device.engine.settled();

    expect((await readAllRows(testDatabase.db)).entries.get(entryId)).toMatchObject({
      allDay: false,
      startTime: '15:00',
      endTime: '16:00',
      notifyOffsetMin: 10,
    });
  });
});

describe('削除と、元に戻す（OT-1）', () => {
  async function deviceWithEvent() {
    const device = await startedDevice();
    const entryId = create(device, newValues());
    await device.engine.settled();
    device.network.calls.length = 0;
    return { device, entryId };
  }

  function remove(device: Device, occurrence: Occurrence) {
    const accepted = device.engine.deleteEntry({
      seriesId: occurrence.seriesId,
      occurrenceDate: occurrence.occurrenceDate,
      scope: 'all',
    });
    if (accepted === null) throw new Error('エンジンが受け付けませんでした');
    return accepted;
  }

  it('削除すると、すぐ月表示から消える', async () => {
    const { device, entryId } = await deviceWithEvent();

    remove(device, occurrenceOf(device, entryId));

    expect(monthEventTitles(device, '2026-10-22')).toEqual([]);
  });

  it('元に戻すと、予定が戻り、サーバーには、削除を送らない', async () => {
    const { device, entryId } = await deviceWithEvent();
    const { requestId } = remove(device, occurrenceOf(device, entryId));

    expect(device.engine.undo(requestId)).toBe(true);
    device.clock.advance(DELETE_UNDO_MS * 2);
    await device.engine.settled();

    expect(monthEventTitles(device, '2026-10-22')).toEqual(['歯医者']);
    expect(device.network.writes).toEqual([]);
    expect((await readAllRows(testDatabase.db)).entries.get(entryId)?.deletedAt).toBeNull();
  });

  it('元に戻さずに DELETE_UNDO_MS（5 秒）たつと、削除をサーバーへ送る。そのあとは、元に戻せない', async () => {
    const { device, entryId } = await deviceWithEvent();
    const { requestId } = remove(device, occurrenceOf(device, entryId));

    device.clock.advance(DELETE_UNDO_MS - 1);
    expect(device.network.writes).toEqual([]);
    device.clock.advance(1);
    await device.engine.settled();

    expect(device.network.writes).toHaveLength(1);
    expect((await readAllRows(testDatabase.db)).entries.get(entryId)?.deletedAt).not.toBeNull();
    expect(device.engine.undo(requestId)).toBe(false);
    expect(monthEventTitles(device, '2026-10-22')).toEqual([]);
  });
});
