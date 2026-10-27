import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { createTestDatabase, type TestDatabase } from '../../../test/helpers/d1';
import { createDevice, type Device } from '../../../test/helpers/device';
import { makeDraft } from '../../../test/helpers/entries';
import { readAllRows } from '../../../test/helpers/rows';
import type { Workspace } from '../../shared/schema';
import { DELETE_UNDO_MS } from '../sync/engine';
import { WORKSPACE_COLORS } from '../workspaceColors';
import { workspaceDisplayOf } from '../workspaceDisplay';
import {
  countEntriesIn,
  isLastWorkspace,
  newWorkspaceInput,
  reorderWorkspaces,
  toWorkspaceInput,
  workspaceToSave,
  type WorkspaceInput,
} from './workspaceEdit';
import { menuSections } from './workspaceList';

// サイドメニューとワークスペースの編集が、エンジンに渡す入力を、本物のエンジンと Worker（Miniflare の D1）に
// 渡して、サーバーに断られず、別の端末にも同じ並び・同じ表示で届くことを確かめる。
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

async function startedDevice(idPrefix?: string): Promise<Device> {
  const device = createDevice({ db: testDatabase.db, idPrefix });
  await device.engine.start();
  await device.engine.settled();
  return device;
}

function workspacesOf(device: Device) {
  return device.state().view.workspaces.values();
}

function rowOf(device: Device, id: string): Workspace {
  const row = device.state().view.workspaces.get(id);
  if (row === undefined) throw new Error(`ワークスペース ${id} がありません`);
  return row;
}

/** メニュー（と編集の一覧）に出る、利用者のワークスペースの id の並び。 */
function menuOrder(device: Device): string[] {
  return menuSections(workspacesOf(device)).workspaces.map(({ id }) => id);
}

/** 新しいワークスペースを、編集のダイアログと同じ手順（初期値 → 名前を入れて保存）で作る。 */
async function addWorkspace(device: Device, id: string, name: string): Promise<void> {
  const input = { ...newWorkspaceInput(workspacesOf(device), id), name };
  if (device.engine.saveWorkspace(input) === null)
    throw new Error('エンジンが受け付けませんでした');
  await device.engine.settled();
}

/** ↑ ↓ を押したときと同じ手順（振り直した行だけを、1 行ずつ保存する）。 */
async function move(device: Device, id: string, direction: 'up' | 'down'): Promise<void> {
  for (const row of reorderWorkspaces(workspacesOf(device), id, direction)) {
    if (device.engine.saveWorkspace(toWorkspaceInput(row)) === null) {
      throw new Error('エンジンが受け付けませんでした');
    }
  }
  await device.engine.settled();
}

async function serverSortOrders(): Promise<Record<string, number>> {
  const { workspaces } = await readAllRows(testDatabase.db);
  return Object.fromEntries(
    [...workspaces.values()]
      .filter(({ deletedAt, builtin }) => deletedAt === null && builtin === null)
      .map(({ id, sortOrder }) => [id, sortOrder]),
  );
}

describe('表示の ON/OFF（サイドメニューのチェックボックス）', () => {
  it('利用者のワークスペースを OFF にすると、画面の色の対象から外れ、サーバーにも保存され、別の端末にも届く', async () => {
    const device = await startedDevice();
    const row = rowOf(device, 'default-workspace');

    device.engine.saveWorkspace({ ...toWorkspaceInput(row), visible: false });

    expect(workspaceDisplayOf(workspacesOf(device)).colors.has('default-workspace')).toBe(false);
    await device.engine.settled();
    expect(device.state().discarded.count).toBe(0);
    expect((await readAllRows(testDatabase.db)).workspaces.get('default-workspace')?.visible).toBe(
      false,
    );
    const other = await startedDevice('other');
    expect(workspaceDisplayOf(workspacesOf(other)).colors.has('default-workspace')).toBe(false);
  });

  it('組み込みの「祝日」「記念日」も、サーバーに断られずに切り替えられ、祝日名・記念日名を出さない決まりになる', async () => {
    const device = await startedDevice();

    for (const builtin of ['holiday', 'observance'] as const) {
      const row = [...workspacesOf(device)].find((workspace) => workspace.builtin === builtin);
      if (row === undefined) throw new Error('組み込みの行がありません');
      device.engine.saveWorkspace({ ...toWorkspaceInput(row), visible: false });
    }
    await device.engine.settled();

    expect(device.state().discarded.count).toBe(0);
    expect(workspaceDisplayOf(workspacesOf(device))).toMatchObject({
      showHolidays: false,
      showObservances: false,
    });
    const { workspaces } = await readAllRows(testDatabase.db);
    expect(workspaces.get('builtin-holiday')?.visible).toBe(false);
    expect(workspaces.get('builtin-observance')?.visible).toBe(false);
  });
});

describe('ワークスペースを作る', () => {
  it('初期値に名前を入れて保存すると、サーバーに断られず、メニューの並びの最後に出る', async () => {
    const device = await startedDevice();

    await addWorkspace(device, 'work', '仕事');

    expect(device.state().discarded.count).toBe(0);
    expect(menuOrder(device)).toEqual(['default-workspace', 'work']);
    expect((await readAllRows(testDatabase.db)).workspaces.get('work')).toMatchObject({
      name: '仕事',
      sortOrder: 1,
      visible: true,
      builtin: null,
    });
  });

  it('色は、使っていない最初の 8 色になる（「予定」はピーコックなので、トマトから）', async () => {
    const device = await startedDevice();

    await addWorkspace(device, 'a', 'A');
    await addWorkspace(device, 'b', 'B');

    const { workspaces } = await readAllRows(testDatabase.db);
    expect(workspaces.get('a')?.color).toBe(WORKSPACE_COLORS[0].value);
    expect(workspaces.get('b')?.color).toBe(WORKSPACE_COLORS[1]?.value);
  });
});

describe('並べ替え（↑ ↓）', () => {
  it('↓ で 1 つ下げると、サーバーの sortOrder が、並びの順の 0, 1, 2 になり、別の端末の並びも同じになる', async () => {
    const device = await startedDevice();
    await addWorkspace(device, 'work', '仕事');
    await addWorkspace(device, 'hobby', '趣味');

    await move(device, 'default-workspace', 'down');

    expect(menuOrder(device)).toEqual(['work', 'default-workspace', 'hobby']);
    expect(device.state().discarded.count).toBe(0);
    expect(await serverSortOrders()).toEqual({ work: 0, 'default-workspace': 1, hobby: 2 });
    const other = await startedDevice('other');
    expect(menuOrder(other)).toEqual(['work', 'default-workspace', 'hobby']);
  });

  it('同じ sortOrder の行があっても（API から入ったとき）、↑ で並びが入れ替わる', async () => {
    const device = await startedDevice();
    await addWorkspace(device, 'a', 'A');
    const row = rowOf(device, 'a');
    // 「予定」と同じ sortOrder（0）にする。同じ値なら、id の順（'a' が先、'default-workspace' が後）。
    device.engine.saveWorkspace({ ...toWorkspaceInput(row), sortOrder: 0 });
    await device.engine.settled();
    expect(menuOrder(device)).toEqual(['a', 'default-workspace']);

    await move(device, 'default-workspace', 'up');

    expect(menuOrder(device)).toEqual(['default-workspace', 'a']);
    expect(await serverSortOrders()).toEqual({ 'default-workspace': 0, a: 1 });
  });
});

/** 編集のダイアログの［保存］と同じ手順（開いたときの行と、今の行と、入力の途中の値から、送る行を決める）。 */
function saveEdited(
  device: Device,
  original: Workspace,
  change: Partial<Pick<WorkspaceInput, 'name' | 'color'>>,
) {
  const plan = workspaceToSave({
    original,
    latest: device.state().view.workspaces.get(original.id),
    draft: { ...toWorkspaceInput(original), ...change },
  });
  if (plan.kind === 'save' && device.engine.saveWorkspace(plan.workspace) === null) {
    throw new Error('エンジンが受け付けませんでした');
  }
  return plan;
}

describe('8 色にない色のワークスペース（API から入ったもの）', () => {
  it('名前だけを変えて保存しても、色は、そのまま（16 進の大文字・小文字も書き換えない）', async () => {
    const device = await startedDevice();
    await addWorkspace(device, 'legacy', '仕事');
    device.engine.saveWorkspace({ ...toWorkspaceInput(rowOf(device, 'legacy')), color: '#12ab34' });
    await device.engine.settled();

    saveEdited(device, rowOf(device, 'legacy'), { name: 'レガシー2' });
    await device.engine.settled();

    expect(device.state().discarded.count).toBe(0);
    expect((await readAllRows(testDatabase.db)).workspaces.get('legacy')).toMatchObject({
      name: 'レガシー2',
      color: '#12ab34',
    });
  });
});

describe('編集のダイアログを開いている間に、ほかの端末が、同じワークスペースを変えたとき', () => {
  async function twoDevices() {
    const a = await startedDevice('a');
    await addWorkspace(a, 'work', '仕事');
    const b = await startedDevice('b');
    // 時計は、手で進める偽物で、端末ごとに別。B の編集より後に、A が保存するよう、A の時計を進めておく
    // （ダイアログを開いている間に、時間が過ぎたことにする）。
    a.clock.advance(60_000);
    return { a, b };
  }

  it('名前だけを変えて保存しても、ほかの端末が変えた、表示の OFF と並び順は、戻らない', async () => {
    const { a, b } = await twoDevices();
    // A が、名前と色の段を開く（この時点の行を覚える）。
    const opened = rowOf(a, 'work');
    // B が、表示を OFF にして、並び順を変える。A は、それを受け取る。
    b.engine.saveWorkspace({ ...toWorkspaceInput(rowOf(b, 'work')), visible: false, sortOrder: 9 });
    await b.engine.settled();
    await a.engine.syncNow();
    expect(rowOf(a, 'work')).toMatchObject({ visible: false, sortOrder: 9 });

    saveEdited(a, opened, { name: '仕事（新）' });
    await a.engine.settled();

    expect(a.state().discarded.count).toBe(0);
    expect((await readAllRows(testDatabase.db)).workspaces.get('work')).toMatchObject({
      name: '仕事（新）',
      visible: false,
      sortOrder: 9,
    });
  });

  it('色だけを変えて保存しても、ほかの端末が変えた名前は、戻らない', async () => {
    const { a, b } = await twoDevices();
    const opened = rowOf(a, 'work');
    b.engine.saveWorkspace({ ...toWorkspaceInput(rowOf(b, 'work')), name: 'Bが付けた名前' });
    await b.engine.settled();
    await a.engine.syncNow();

    saveEdited(a, opened, { color: WORKSPACE_COLORS[2]?.value ?? '' });
    await a.engine.settled();

    expect((await readAllRows(testDatabase.db)).workspaces.get('work')).toMatchObject({
      name: 'Bが付けた名前',
      color: WORKSPACE_COLORS[2]?.value,
    });
  });

  it('ほかの端末が削除したワークスペースは、送らず（サーバーに、黙って捨てられないように）、削除されたとして扱う', async () => {
    const { a, b } = await twoDevices();
    const opened = rowOf(a, 'work');
    b.engine.deleteWorkspace('work');
    b.clock.advance(DELETE_UNDO_MS);
    await b.engine.settled();
    await a.engine.syncNow();
    a.network.calls.length = 0;

    const plan = saveEdited(a, opened, { name: '仕事（新）' });
    await a.engine.settled();

    expect(plan.kind).toBe('gone');
    expect(a.network.writes).toEqual([]);
  });
});

describe('削除', () => {
  it('削除の確認に出す件数は、繰り返さない予定と系列の数（例外は数えない）。削除すると、中の予定は、例外も消える', async () => {
    const device = await startedDevice();
    await addWorkspace(device, 'work', '仕事');
    const created = [
      device.engine.createEntry(makeDraft({ title: '会議', workspaceId: 'work' })),
      device.engine.createEntry(
        makeDraft({ title: '朝会', workspaceId: 'work', rrule: { freq: 'daily' } }),
      ),
      device.engine.createEntry(makeDraft({ title: '別', workspaceId: 'default-workspace' })),
    ];
    const series = created[1];
    if (series === null || series === undefined) throw new Error('エンジンが受け付けませんでした');
    device.engine.changeEntry(
      { seriesId: series.entryId, occurrenceDate: '2026-10-20', scope: 'this' },
      { title: '朝会（変更）' },
    );
    await device.engine.settled();

    expect(countEntriesIn(device.state().view.entries.values(), 'work')).toBe(2);

    device.engine.deleteWorkspace('work');
    device.clock.advance(DELETE_UNDO_MS);
    await device.engine.settled();

    const { entries, workspaces } = await readAllRows(testDatabase.db);
    expect(workspaces.get('work')?.deletedAt).not.toBeNull();
    const inside = [...entries.values()].filter(({ workspaceId }) => workspaceId === 'work');
    expect(inside).toHaveLength(3);
    expect(inside.every(({ deletedAt }) => deletedAt !== null)).toBe(true);
    expect(entries.get(created[2]?.entryId ?? '')?.deletedAt).toBeNull();
  });

  it('最後の 1 つか（isLastWorkspace）が true のとき、サーバーも削除を断る（400。画面は、そのボタンを押せなくする）', async () => {
    const device = await startedDevice();
    expect(isLastWorkspace(workspacesOf(device), 'default-workspace')).toBe(true);

    device.engine.deleteWorkspace('default-workspace');
    device.clock.advance(DELETE_UNDO_MS);
    await device.engine.settled();

    expect(device.network.writeResponses.at(-1)).toMatchObject({
      status: 400,
      body: { error: 'last_workspace' },
    });
  });

  it('ほかに利用者のワークスペースがあれば（isLastWorkspace が false）、サーバーは削除を受け付ける', async () => {
    const device = await startedDevice();
    await addWorkspace(device, 'work', '仕事');
    expect(isLastWorkspace(workspacesOf(device), 'default-workspace')).toBe(false);

    device.engine.deleteWorkspace('default-workspace');
    device.clock.advance(DELETE_UNDO_MS);
    await device.engine.settled();

    expect(device.network.writeResponses.at(-1)).toMatchObject({ status: 200 });
    expect(device.state().discarded.count).toBe(0);
    expect(menuOrder(device)).toEqual(['work']);
  });

  it('削除して元に戻すと、ワークスペースも中の予定も戻り、サーバーには削除を送らない', async () => {
    const device = await startedDevice();
    await addWorkspace(device, 'work', '仕事');
    const entry = device.engine.createEntry(makeDraft({ title: '会議', workspaceId: 'work' }));
    await device.engine.settled();
    device.network.calls.length = 0;

    const deleted = device.engine.deleteWorkspace('work');
    expect(menuOrder(device)).toEqual(['default-workspace']);
    if (deleted === null) throw new Error('エンジンが受け付けませんでした');
    expect(device.engine.undo(deleted.requestId)).toBe(true);
    device.clock.advance(DELETE_UNDO_MS * 2);
    await device.engine.settled();

    expect(menuOrder(device)).toEqual(['default-workspace', 'work']);
    expect(device.state().view.entries.get(entry?.entryId ?? '')?.deletedAt).toBeNull();
    expect(device.network.writes).toEqual([]);
  });
});
