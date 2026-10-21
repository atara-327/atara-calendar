import 'fake-indexeddb/auto';
import { createStore, entries, set } from 'idb-keyval';
import { describe, expect, it } from 'vitest';
import type { PendingRequest } from './requests';
import { createIdbStorage, type StoredRequest } from './storage';

let counter = 0;
/** テストごとに別のデータベースを使う。前のテストの保存が、次のテストに残らないようにするため。 */
function newDbName(): string {
  counter += 1;
  return `test-pending-${String(counter)}`;
}

function deleteRequest(targetId: string, editedAt: number): PendingRequest {
  return { type: 'deleteWorkspace', targetId, body: { editedAt } };
}

function stored(id: string, editedAt: number): StoredRequest {
  return { id, request: deleteRequest(`w-${id}`, editedAt) };
}

describe('送信待ちの IndexedDB への保存（設計書 6.2）', () => {
  it('保存した依頼を、読み込める', async () => {
    const storage = createIdbStorage({ dbName: newDbName() });
    await storage.save(stored('r1', 1000));

    expect(await storage.load()).toEqual({ requests: [stored('r1', 1000)], discarded: 0 });
  });

  it('何も保存していなければ、空で読み込める', async () => {
    expect(await createIdbStorage({ dbName: newDbName() }).load()).toEqual({
      requests: [],
      discarded: 0,
    });
  });

  it('読み込んだ依頼は、保存した順ではなく、編集時刻の順に並ぶ（作った順に送るため）', async () => {
    const storage = createIdbStorage({ dbName: newDbName() });
    await storage.save(stored('c', 3000));
    await storage.save(stored('a', 1000));
    await storage.save(stored('b', 2000));

    const { requests } = await storage.load();

    expect(requests.map(({ id }) => id)).toEqual(['a', 'b', 'c']);
  });

  it('依頼を消すと、読み込まれなくなる。ほかの依頼は残る', async () => {
    const storage = createIdbStorage({ dbName: newDbName() });
    await storage.save(stored('a', 1000));
    await storage.save(stored('b', 2000));

    await storage.remove('a');

    expect((await storage.load()).requests.map(({ id }) => id)).toEqual(['b']);
  });

  it('保存されていない依頼を消しても、エラーにならない', async () => {
    await expect(createIdbStorage({ dbName: newDbName() }).remove('none')).resolves.toBeUndefined();
  });

  it('同じ id で保存し直すと、上書きされる', async () => {
    const storage = createIdbStorage({ dbName: newDbName() });
    await storage.save(stored('a', 1000));
    await storage.save({ id: 'a', request: deleteRequest('w-x', 1500) });

    const { requests } = await storage.load();

    expect(requests).toHaveLength(1);
    expect(requests[0]?.request).toEqual(deleteRequest('w-x', 1500));
  });

  it('依頼 1 つが、依頼の id 1 つのキーで保存される（列全体を 1 つのキーにしない）', async () => {
    const dbName = newDbName();
    const storage = createIdbStorage({ dbName, storeName: 'pending' });
    await storage.save(stored('a', 1000));
    await storage.save(stored('b', 2000));

    const keys = (await entries(createStore(dbName, 'pending'))).map(([key]) => key);

    expect(keys.sort()).toEqual(['a', 'b']);
  });

  it('2 つのタブが同時に保存しても、互いの依頼を消さない（キーが別なので、上書きしない）', async () => {
    const dbName = newDbName();
    const tabA = createIdbStorage({ dbName });
    const tabB = createIdbStorage({ dbName });

    await Promise.all([tabA.save(stored('fromA', 1000)), tabB.save(stored('fromB', 1001))]);

    const { requests } = await createIdbStorage({ dbName }).load();
    expect(requests.map(({ id }) => id)).toEqual(['fromA', 'fromB']);
  });

  describe('形の合わない依頼（古い版の画面が保存したものなど）', () => {
    async function writeRaw(dbName: string, key: string, value: unknown): Promise<void> {
      await set(key, value, createStore(dbName, 'pending-requests'));
    }

    it.each([
      { name: '知らない種類の依頼', value: { id: 'bad', request: { type: 'moveEntry' } } },
      {
        name: '本文が API の形に合わない依頼',
        value: { id: 'bad', request: { type: 'deleteWorkspace', targetId: 'w1', body: {} } },
      },
      { name: '依頼の包みの形が違うもの', value: { id: 'bad', requestType: 'x' } },
      { name: 'オブジェクトでない値', value: 'text' },
      {
        name: 'キーと依頼の id が違うもの',
        value: { id: 'other', request: deleteRequest('w1', 1000) },
      },
    ])('$name は、送らずに消して、捨てた数に数える', async ({ value }) => {
      const dbName = newDbName();
      const storage = createIdbStorage({ dbName });
      await storage.save(stored('good', 1000));
      await writeRaw(dbName, 'bad', value);

      const first = await storage.load();

      expect(first.requests.map(({ id }) => id)).toEqual(['good']);
      expect(first.discarded).toBe(1);
      // 消してあるので、次の起動では、数えない。
      expect(await storage.load()).toEqual({ requests: [stored('good', 1000)], discarded: 0 });
    });
  });
});
