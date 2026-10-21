import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { createDevice, FakeLockHub, fakeResponse, type Device } from '../../../test/helpers/device';
import { createTestDatabase, type TestDatabase } from '../../../test/helpers/d1';
import { makeDraft } from '../../../test/helpers/entries';
import { readAllRows } from '../../../test/helpers/rows';
import type { Entry } from '../../shared/schema';
import { POLL_INTERVAL_MS } from './engine';
import { selectPendingCount } from './state';

// 端末を 2 台以上作り、本物の Worker（Miniflare の D1 と app）につないで、同期の動きを確かめる
// （設計書 6章。SY-1・SY-2・SY-3）。1 台の動きは、engine.test.ts。

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

async function startedDevice(options: Partial<Parameters<typeof createDevice>[0]> = {}) {
  const device = createDevice({ db: db(), ...options });
  await device.engine.start();
  await device.engine.settled();
  return device;
}

function titleOf(device: Device, id: string): string | undefined {
  return device.state().view.entries.get(id)?.title;
}

function pendingOf(device: Device): number {
  return selectPendingCount(device.state());
}

function liveEntries(entries: ReadonlyMap<string, Entry>): Entry[] {
  return [...entries.values()]
    .filter(({ deletedAt }) => deletedAt === null)
    .sort((a, b) => (a.id < b.id ? -1 : 1));
}

/** 端末の画面に出すデータの、削除されていない予定が、サーバーと一致するか。 */
async function expectMatchesServer(device: Device): Promise<void> {
  const server = await readAllRows(db());
  expect(liveEntries(device.state().view.entries)).toEqual(liveEntries(server.entries));
}

function target(entryId: string) {
  return { seriesId: entryId, occurrenceDate: '2026-10-19', scope: 'all' } as const;
}

describe('2 台で見る（SY-1）', () => {
  it('一方の端末で作った予定が、もう一方の端末に届く（前面に戻ったとき）', async () => {
    const a = await startedDevice({ idPrefix: 'a' });
    const b = await startedDevice({ idPrefix: 'b' });

    const created = a.engine.createEntry(makeDraft({ title: 'Aで作った' }));
    await a.engine.settled();
    b.page.hide();
    b.page.show();
    await b.engine.settled();

    expect(titleOf(b, created?.entryId ?? '')).toBe('Aで作った');
    await expectMatchesServer(b);
  });

  it('画面を開いている間は、60 秒ごとに、もう一方の端末の編集を受け取る', async () => {
    const a = await startedDevice({ idPrefix: 'a' });
    const b = await startedDevice({ idPrefix: 'b' });
    const created = a.engine.createEntry(makeDraft({ title: 'Aで作った' }));
    await a.engine.settled();
    expect(titleOf(b, created?.entryId ?? '')).toBeUndefined();

    b.clock.advance(POLL_INTERVAL_MS);
    await b.engine.settled();

    expect(titleOf(b, created?.entryId ?? '')).toBe('Aで作った');
  });

  it('もう一方の端末の削除は、削除済みの行として id で置き換わり、画面から消える', async () => {
    const a = await startedDevice({ idPrefix: 'a' });
    const b = await startedDevice({ idPrefix: 'b' });
    const created = a.engine.createEntry(makeDraft({ title: '消される' }));
    const entryId = created?.entryId ?? '';
    await a.engine.settled();
    await b.engine.syncNow();
    expect(b.state().base.entries.get(entryId)?.deletedAt).toBeNull();

    a.engine.deleteEntry(target(entryId));
    a.clock.advance(5000);
    await a.engine.settled();
    await b.engine.syncNow();

    expect(b.state().base.entries.get(entryId)?.deletedAt).not.toBeNull();
    expect(liveEntries(b.state().view.entries).map(({ id }) => id)).not.toContain(entryId);
  });

  it('自分の書き込みの後に受け取っても、他の端末が先に書いた行を取りこぼさない（書き込みの応答から rev を覚えない）', async () => {
    const a = await startedDevice({ idPrefix: 'a' });
    const b = await startedDevice({ idPrefix: 'b' });
    const fromB = b.engine.createEntry(makeDraft({ title: 'Bが先に書いた' }));
    await b.engine.settled();

    // A は、B の書き込みを受け取る前に、自分で書く。書き込みの応答の rev で進めていたら、B の行を飛ばす。
    const fromA = a.engine.createEntry(makeDraft({ title: 'Aが後で書いた' }));
    await a.engine.settled();

    expect(titleOf(a, fromB?.entryId ?? '')).toBe('Bが先に書いた');
    expect(titleOf(a, fromA?.entryId ?? '')).toBe('Aが後で書いた');
    await expectMatchesServer(a);
  });
});

describe('同じ予定を 2 台で編集して食い違ったとき（SY-3）', () => {
  /** 2 台とも、同じ予定を持っていて、どちらも電波がない状態にする。 */
  async function twoOfflineDevices() {
    const a = await startedDevice({ idPrefix: 'a' });
    const b = await startedDevice({ idPrefix: 'b' });
    const created = a.engine.createEntry(makeDraft({ title: '元の予定' }));
    const entryId = created?.entryId ?? '';
    await a.engine.settled();
    await b.engine.syncNow();
    expect(titleOf(b, entryId)).toBe('元の予定');
    a.network.online = false;
    b.network.online = false;
    return { a, b, entryId };
  }

  it.each([
    { name: '先に編集した端末が、先に送ったとき', first: 'a' },
    { name: '後に編集した端末が、先に送ったとき', first: 'b' },
  ] as const)(
    '$name。どちらの順でも、後から編集した方（editedAt が大きい方）が残る',
    async ({ first }) => {
      const { a, b, entryId } = await twoOfflineDevices();
      a.engine.changeEntry(target(entryId), { title: 'Aの編集（先）' });
      b.clock.advance(1000);
      b.engine.changeEntry(target(entryId), { title: 'Bの編集（後）' });
      await Promise.all([a.engine.settled(), b.engine.settled()]);
      a.network.online = true;
      b.network.online = true;

      const order = first === 'a' ? [a, b] : [b, a];
      for (const device of order) await device.engine.syncNow();
      await a.engine.syncNow();
      await b.engine.syncNow();

      const server = await readAllRows(db());
      expect(server.entries.get(entryId)?.title).toBe('Bの編集（後）');
      expect(titleOf(a, entryId)).toBe('Bの編集（後）');
      expect(titleOf(b, entryId)).toBe('Bの編集（後）');
      // 負けた編集は、200 の「捨てた」で、正常な動き。利用者には知らせない。
      expect(a.state().discarded.count).toBe(0);
      expect(b.state().discarded.count).toBe(0);
      expect(pendingOf(a) + pendingOf(b)).toBe(0);
    },
  );

  it('一方の端末が削除した予定への、もう一方の端末の編集は、捨てられ、画面からも消える（知らせない）', async () => {
    const { a, b, entryId } = await twoOfflineDevices();
    a.engine.deleteEntry(target(entryId));
    b.clock.advance(1000);
    b.engine.changeEntry(target(entryId), { title: '削除された後の編集' });
    await Promise.all([a.engine.settled(), b.engine.settled()]);
    a.network.online = true;
    b.network.online = true;

    a.clock.advance(5000);
    await a.engine.settled();
    await b.engine.syncNow();
    await b.engine.syncNow();

    expect((await readAllRows(db())).entries.get(entryId)?.deletedAt).not.toBeNull();
    expect(liveEntries(b.state().view.entries).map(({ id }) => id)).not.toContain(entryId);
    expect(b.state().discarded.count).toBe(0);
    expect(pendingOf(b)).toBe(0);
  });

  it('別の予定への編集は、お互いに消さない', async () => {
    const { a, b } = await twoOfflineDevices();
    const fromA = a.engine.createEntry(makeDraft({ title: 'Aの新しい予定' }));
    const fromB = b.engine.createEntry(makeDraft({ title: 'Bの新しい予定' }));
    await Promise.all([a.engine.settled(), b.engine.settled()]);
    a.network.online = true;
    b.network.online = true;

    await a.engine.syncNow();
    await b.engine.syncNow();
    await a.engine.syncNow();

    for (const device of [a, b]) {
      expect(titleOf(device, fromA?.entryId ?? '')).toBe('Aの新しい予定');
      expect(titleOf(device, fromB?.entryId ?? '')).toBe('Bの新しい予定');
    }
    await expectMatchesServer(a);
    await expectMatchesServer(b);
  });
});

describe('同じ端末の複数のタブ（Q5）', () => {
  /** 同じ端末の、古いタブと、新しく開いたタブ。錠と IndexedDB を共有する。 */
  function twoTabs() {
    const hub = new FakeLockHub();
    const dbName = 'shared-browser-db';
    return {
      openOldTab: () => createDevice({ db: db(), hub, dbName, idPrefix: 'old' }),
      openNewTab: () => createDevice({ db: db(), hub, dbName, idPrefix: 'new' }),
    };
  }

  it('新しいタブが開くと、古いタブは止まる（編集を受け付けず、送受信もしない）', async () => {
    const { openOldTab, openNewTab } = twoTabs();
    const oldTab = openOldTab();
    await oldTab.engine.start();
    await oldTab.engine.settled();

    const newTab = openNewTab();
    await newTab.engine.start();
    await newTab.engine.settled();

    expect(oldTab.state()).toMatchObject({ phase: 'stopped', takenOver: true });
    expect(newTab.state().phase).toBe('ready');
    expect(oldTab.engine.createEntry(makeDraft())).toBeNull();
    expect(oldTab.page.subscriberCount).toBe(0);
    expect(oldTab.clock.pendingTimerCount).toBe(0);

    const callsBefore = oldTab.network.calls.length;
    oldTab.clock.advance(POLL_INTERVAL_MS * 3);
    oldTab.page.goOnline();
    await oldTab.engine.settled();
    expect(oldTab.network.calls).toHaveLength(callsBefore);
  });

  it('タブを 3 つ開くと、最後のタブだけが動く', async () => {
    const { openOldTab, openNewTab } = twoTabs();
    const first = openOldTab();
    const second = openNewTab();
    const third = openNewTab();

    await first.engine.start();
    await second.engine.start();
    await third.engine.start();
    await third.engine.settled();

    expect([first, second, third].map((tab) => tab.state().phase)).toEqual([
      'stopped',
      'stopped',
      'ready',
    ]);
  });

  it('古いタブに残っていた送信待ちは、IndexedDB にあるので、新しいタブが引き継いで送る', async () => {
    const { openOldTab, openNewTab } = twoTabs();
    const oldTab = openOldTab();
    await oldTab.engine.start();
    await oldTab.engine.settled();
    oldTab.network.online = false;
    const created = oldTab.engine.createEntry(makeDraft({ title: '古いタブで編集した' }));
    await oldTab.engine.settled();
    expect(pendingOf(oldTab)).toBe(1);

    const newTab = openNewTab();
    await newTab.engine.start();
    await newTab.engine.settled();

    expect(pendingOf(newTab)).toBe(0);
    expect((await readAllRows(db())).entries.get(created?.entryId ?? '')?.title).toBe(
      '古いタブで編集した',
    );
    expect(titleOf(newTab, created?.entryId ?? '')).toBe('古いタブで編集した');
    expect((await newTab.storage.load()).requests).toEqual([]);
  });

  it('止まる前に送り始めていた依頼の応答は、古いタブが読まずに捨てる（列と IndexedDB に触らない）', async () => {
    const { openOldTab, openNewTab } = twoTabs();
    const oldTab = openOldTab();
    await oldTab.engine.start();
    await oldTab.engine.settled();
    let release: (response: ReturnType<typeof fakeResponse>) => void = () => undefined;
    oldTab.network.override = ({ method }) =>
      method === 'GET'
        ? undefined
        : new Promise((resolve) => {
            release = resolve;
          });
    const created = oldTab.engine.createEntry(makeDraft({ title: '送信中に奪われる' }));
    await vi.waitFor(async () => {
      expect((await oldTab.storage.load()).requests).toHaveLength(1);
    });

    const newTab = openNewTab();
    await newTab.engine.start();
    await newTab.engine.settled();
    release(fakeResponse(200, { applied: true }));
    await oldTab.engine.settled();

    // 新しいタブが、同じ依頼を送り直して、サーバーに 1 つだけ入っている。
    const server = await readAllRows(db());
    expect(
      [...server.entries.values()].filter(({ title }) => title === '送信中に奪われる'),
    ).toHaveLength(1);
    expect(server.entries.has(created?.entryId ?? '')).toBe(true);
    // 古いタブは、応答を読んでいないので、列から外していない。
    expect(pendingOf(oldTab)).toBe(1);
    expect(oldTab.state().discarded.count).toBe(0);
  });
});

describe('サーバーが復元されたとき（設計書 付録 A.1）', () => {
  it('復元の前に覚えた rev ではなく、全データを読み直すので、復元後の変更も取りこぼさない', async () => {
    const a = await startedDevice({ idPrefix: 'a' });
    const b = await startedDevice({ idPrefix: 'b' });
    // 復元の前に、A が予定をたくさん書き、rev が進んでいる。
    for (let index = 0; index < 5; index += 1) {
      a.engine.createEntry(makeDraft({ title: `復元前 ${String(index)}` }));
    }
    await a.engine.settled();
    await b.engine.syncNow();
    const revBefore = b.state().base.rev;
    expect(revBefore).toBeGreaterThan(3);

    // データを、rev が小さかったころに戻した（復元）。epoch も変える。
    await db().batch([
      db().prepare("DELETE FROM entries WHERE title LIKE '復元前%'"),
      db().prepare("UPDATE meta SET rev = 1, epoch = 'after-restore'"),
    ]);
    // 復元の後に、A が書く。rev は 2 になる（B が覚えている rev より、ずっと小さい）。
    const fromA = a.engine.createEntry(makeDraft({ title: '復元の後' }));
    await a.engine.settled();

    await b.engine.syncNow();

    expect(b.state().base.epoch).toBe('after-restore');
    expect(titleOf(b, fromA?.entryId ?? '')).toBe('復元の後');
    expect(
      liveEntries(b.state().view.entries).filter(({ title }) => title.startsWith('復元前')),
    ).toEqual([]);
    await expectMatchesServer(b);
  });
});
