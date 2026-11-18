import 'fake-indexeddb/auto';
import { createStore, set } from 'idb-keyval';
import { describe, expect, it } from 'vitest';
import { makeEntry } from '../../../test/helpers/entries';
import { makeWorkspace } from '../../../test/helpers/workspaces';
import { createIdbSnapshotStorage, SNAPSHOT_VERSION } from './snapshot';
import type { BaseData } from './state';

let counter = 0;
/** テストごとに別のデータベースを使う。前のテストの保存が、次のテストに残らないようにするため。 */
function newDbName(): string {
  counter += 1;
  return `test-snapshot-${String(counter)}`;
}

function sampleBase(): BaseData {
  const workspace = makeWorkspace({ id: 'w1' });
  const entry = makeEntry({ id: 'e1', rrule: { freq: 'daily' }, untilDate: '2026-12-31' });
  return {
    rev: 7,
    epoch: 'epoch-1',
    workspaces: new Map([[workspace.id, workspace]]),
    entries: new Map([[entry.id, entry]]),
  };
}

describe('受け取った内容の IndexedDB への保存（設計書 6.1）', () => {
  it('保存した内容を、同じ内容で読み込める', async () => {
    const storage = createIdbSnapshotStorage({ dbName: newDbName() });
    const base = sampleBase();
    await storage.save(base);

    expect(await storage.load()).toEqual(base);
  });

  it('何も保存していなければ、null', async () => {
    expect(await createIdbSnapshotStorage({ dbName: newDbName() }).load()).toBeNull();
  });

  it('版が違うものは、null（読まずに捨てる）', async () => {
    const dbName = newDbName();
    await set(
      'base',
      { version: SNAPSHOT_VERSION + 1, rev: 1, epoch: 'e', workspaces: [], entries: [] },
      createStore(dbName, 'snapshot'),
    );

    expect(await createIdbSnapshotStorage({ dbName }).load()).toBeNull();
  });

  it('形が合わないものは、null', async () => {
    const dbName = newDbName();
    await set(
      'base',
      { version: SNAPSHOT_VERSION, rev: 'x', epoch: 'e', workspaces: [], entries: [] },
      createStore(dbName, 'snapshot'),
    );

    expect(await createIdbSnapshotStorage({ dbName }).load()).toBeNull();
  });

  it('行の形が合わないものが 1 つでもあれば、null（一部だけ読まない）', async () => {
    const dbName = newDbName();
    await set(
      'base',
      {
        version: SNAPSHOT_VERSION,
        rev: 1,
        epoch: 'e',
        workspaces: [{ id: 'w1' }],
        entries: [],
      },
      createStore(dbName, 'snapshot'),
    );

    expect(await createIdbSnapshotStorage({ dbName }).load()).toBeNull();
  });
});
