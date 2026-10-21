import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { createDevice, fakeResponse, type Device } from '../../../test/helpers/device';
import {
  createTestDatabase,
  restoredMetaStatement,
  type TestDatabase,
} from '../../../test/helpers/d1';
import { makeDraft } from '../../../test/helpers/entries';
import { readAllRows } from '../../../test/helpers/rows';
import { makeWorkspace } from '../../../test/helpers/workspaces';
import type { Entry } from '../../shared/schema';
import { DELETE_UNDO_MS, POLL_INTERVAL_MS } from './engine';
import { editedAtOf } from './requests';
import { selectPendingCount } from './state';

// 1 台の端末の動き（設計書 6章）を、本物の Worker（Miniflare の D1 と app）につないで確かめる。
// 2 台以上が関わる動きは、sync.integration.test.ts。

let testDatabase: TestDatabase;

beforeAll(async () => {
  testDatabase = await createTestDatabase();
});

afterAll(async () => {
  await testDatabase.dispose();
});

beforeEach(async () => {
  await testDatabase.reset();
  // 4xx の応答や、再現した失敗は、原因をログに出す。テストの出力に混ぜないため、黙らせる。
  vi.spyOn(console, 'warn').mockImplementation(() => undefined);
  vi.spyOn(console, 'error').mockImplementation(() => undefined);
});

afterEach(() => {
  vi.restoreAllMocks();
});

function db(): D1Database {
  return testDatabase.db;
}

/** 端末を作って、起動し、最初の送受信が終わるまで待つ。 */
async function startedDevice(options: Parameters<typeof createDevice>[0] = { db: db() }) {
  const device = createDevice(options);
  await device.engine.start();
  await device.engine.settled();
  return device;
}

function entryIn(device: Device, id: string): Entry | undefined {
  return device.state().view.entries.get(id);
}

function pendingOf(device: Device): number {
  return selectPendingCount(device.state());
}

async function serverMetaRev(): Promise<number> {
  const row = await db().prepare('SELECT rev FROM meta WHERE id = 1').first<{ rev: number }>();
  return row?.rev ?? -1;
}

function toTarget(entryId: string) {
  return { seriesId: entryId, occurrenceDate: '2026-10-19', scope: 'all' } as const;
}

describe('起動（設計書 6章）', () => {
  it('全データを読み込み、サーバーの内容（組み込みと「予定」のワークスペース）を画面に出すデータに持つ', async () => {
    const device = await startedDevice();

    const state = device.state();
    expect(state.phase).toBe('ready');
    expect([...state.view.workspaces.keys()].sort()).toEqual([
      'builtin-holiday',
      'builtin-observance',
      'default-workspace',
    ]);
    expect(state.base.epoch).not.toBeNull();
    expect(state.base.rev).toBe(await serverMetaRev());
  });

  it('最初の読み込みは since=0 で行う', async () => {
    const device = await startedDevice();
    expect(device.network.reads[0]?.url).toBe('/api/changes?since=0');
  });

  it('全データを読み込んでから、送信待ちを送り始める（錠を取り、送信待ちを読み、全データを読み、送る）', async () => {
    const device = createDevice({ db: db() });
    await device.storage.save({
      id: 'r1',
      request: {
        type: 'putEntry',
        targetId: 'saved-1',
        body: { draft: makeDraft(), editedAt: 5000 },
      },
    });

    await device.engine.start();
    await device.engine.settled();

    expect(device.network.calls.map(({ method }) => method).slice(0, 2)).toEqual(['GET', 'PUT']);
    expect(entryIn(device, 'saved-1')?.title).toBe('歯医者');
    expect((await readAllRows(db())).entries.has('saved-1')).toBe(true);
    expect(pendingOf(device)).toBe(0);
  });

  it('形の合わない保存済みの依頼は、送らずに消して、保存できなかった変更に数える', async () => {
    const device = createDevice({ db: db() });
    await device.storage.save({
      id: 'good',
      request: {
        type: 'putEntry',
        targetId: 'good-1',
        body: { draft: makeDraft(), editedAt: 5000 },
      },
    });
    // 古い版の画面が保存したもの、を真似る。型の上では保存できない形なので、型を合わせて渡す。
    await device.storage.save({
      id: 'old',
      request: { type: 'moveEntry' },
    } as unknown as Parameters<typeof device.storage.save>[0]);

    await device.engine.start();
    await device.engine.settled();

    expect(device.state().discarded).toEqual({ count: 1, clockSkew: false });
    expect((await device.storage.load()).requests).toEqual([]);
    expect(device.network.writes).toHaveLength(1);
  });

  describe('最初の読み込みに失敗したとき（電波がない状態で開いたとき。SY-4）', () => {
    it('読み込めなかった状態になり、編集は受け付けない', async () => {
      const device = createDevice({ db: db() });
      device.network.online = false;

      await device.engine.start();

      expect(device.state().phase).toBe('loadFailed');
      expect(device.engine.createEntry(makeDraft())).toBeNull();
      expect(pendingOf(device)).toBe(0);
    });

    it('再試行（syncNow）で、読み込める', async () => {
      const device = createDevice({ db: db() });
      device.network.online = false;
      await device.engine.start();

      device.network.online = true;
      await device.engine.syncNow();

      expect(device.state().phase).toBe('ready');
      expect(device.state().view.workspaces.has('default-workspace')).toBe(true);
    });

    it('電波が戻ったとき（online）も、読み込みをやり直す', async () => {
      const device = createDevice({ db: db() });
      device.network.online = false;
      await device.engine.start();

      device.network.online = true;
      device.page.goOnline();
      await device.engine.settled();

      expect(device.state().phase).toBe('ready');
    });

    it('サーバーが 5xx のときも、読み込めなかった状態になる', async () => {
      const device = createDevice({ db: db() });
      device.network.override = () => fakeResponse(503, { error: 'internal_error' });

      await device.engine.start();

      expect(device.state().phase).toBe('loadFailed');
    });
  });
});

describe('IndexedDB が使えないとき', () => {
  const brokenStorage = {
    load: () => Promise.reject(new Error('IndexedDB が使えません')),
    save: () => Promise.reject(new Error('IndexedDB が使えません')),
    remove: () => Promise.reject(new Error('IndexedDB が使えません')),
  };

  it('メモリの上では動き続け、保存できないことを知らせる。送信待ちは、送れる', async () => {
    const device = await startedDevice({ db: db(), storage: brokenStorage });

    expect(device.state().phase).toBe('ready');
    expect(device.state().storageFailed).toBe(true);

    const created = device.engine.createEntry(makeDraft({ title: '保存できなくても送る' }));
    await device.engine.settled();

    expect(pendingOf(device)).toBe(0);
    expect((await readAllRows(db())).entries.get(created?.entryId ?? '')?.title).toBe(
      '保存できなくても送る',
    );
  });
});

describe('編集と送信（設計書 6.2）', () => {
  it('編集は、すぐ画面に出すデータに出る。送り終えると、未送信が 0 になり、サーバーに入っている', async () => {
    const device = await startedDevice();
    device.network.online = false;

    const created = device.engine.createEntry(makeDraft({ title: '歯医者' }));
    expect(created).not.toBeNull();
    const entryId = created?.entryId ?? '';

    expect(entryIn(device, entryId)?.title).toBe('歯医者');
    expect(pendingOf(device)).toBe(1);

    device.network.online = true;
    await device.engine.syncNow();

    expect(pendingOf(device)).toBe(0);
    expect((await readAllRows(db())).entries.get(entryId)?.title).toBe('歯医者');
  });

  it('電波がない間に、作成・変更・削除を重ねると、画面にすぐ出て、電波が戻ると順に送られ、サーバーと一致する（SY-2）', async () => {
    const device = await startedDevice();
    device.network.online = false;

    const { entryId } = device.engine.createEntry(makeDraft({ title: '歯医者' })) ?? {
      entryId: '',
    };
    await device.engine.settled();
    expect(entryIn(device, entryId)?.title).toBe('歯医者');

    device.clock.advance(10);
    device.engine.changeEntry(toTarget(entryId), { title: '歯科' });
    await device.engine.settled();
    expect(entryIn(device, entryId)?.title).toBe('歯科');

    const other = device.engine.createEntry(makeDraft({ title: '散髪' }));
    device.clock.advance(10);
    device.engine.deleteEntry(toTarget(entryId));
    await device.engine.settled();
    expect(entryIn(device, entryId)?.deletedAt).not.toBeNull();
    expect(entryIn(device, other?.entryId ?? '')?.title).toBe('散髪');
    expect(pendingOf(device)).toBe(4);

    const attemptsOffline = device.network.writes.length;
    device.network.online = true;
    device.page.goOnline();
    await device.engine.settled();
    // 削除は、元に戻すの間（5 秒）は、送らずに待つ。
    expect(pendingOf(device)).toBe(1);
    device.clock.advance(DELETE_UNDO_MS);
    await device.engine.settled();

    expect(pendingOf(device)).toBe(0);
    const server = await readAllRows(db());
    expect(server.entries.get(entryId)?.deletedAt).not.toBeNull();
    expect(server.entries.get(other?.entryId ?? '')?.title).toBe('散髪');
    // 画面に出すデータと、サーバーが、全行で一致する。
    for (const [id, entry] of server.entries) expect(entryIn(device, id)).toEqual(entry);
    // 電波がない間の試み（失敗）を除いて、電波が戻ってから、編集した順に送られた。
    expect(device.network.writes.slice(attemptsOffline).map(({ method }) => method)).toEqual([
      'PUT',
      'PATCH',
      'PUT',
      'DELETE',
    ]);
  });

  it('送信は、編集した順に、同時に 1 つだけ行う', async () => {
    const device = await startedDevice();

    device.engine.createEntry(makeDraft({ title: '1' }));
    device.engine.createEntry(makeDraft({ title: '2' }));
    device.engine.createEntry(makeDraft({ title: '3' }));
    await device.engine.settled();

    expect(device.network.maxConcurrentWrites).toBe(1);
    const titles = device.network.writes.map(
      ({ body }) => (body as { draft: { title: string } }).draft.title,
    );
    expect(titles).toEqual(['1', '2', '3']);
  });

  it('送信待ちは、依頼 1 つが 1 つのキーで IndexedDB に保存され、送り終えると消える', async () => {
    const device = await startedDevice();
    device.network.online = false;

    device.engine.createEntry(makeDraft({ title: '1' }));
    device.engine.createEntry(makeDraft({ title: '2' }));
    await device.engine.settled();

    const stored = (await device.storage.load()).requests;
    expect(stored.map(({ id }) => id)).toEqual(device.state().queue.map(({ id }) => id));
    expect(stored).toHaveLength(2);

    device.network.online = true;
    await device.engine.syncNow();
    await device.engine.settled();

    expect((await device.storage.load()).requests).toEqual([]);
  });

  describe('編集した時刻（実装 #6 の確認 Q1）', () => {
    it('同じミリ秒に続けて編集しても、editedAt は必ず増える（2 回目が反映済みとして捨てられない）', async () => {
      const device = await startedDevice();
      device.network.online = false;

      device.engine.createEntry(makeDraft({ title: '1' }));
      device.engine.createEntry(makeDraft({ title: '2' }));
      device.engine.createEntry(makeDraft({ title: '3' }));
      await device.engine.settled();

      const editedAts = device.state().queue.map(({ request }) => editedAtOf(request));
      expect(new Set(editedAts).size).toBe(3);
      expect(editedAts).toEqual([...editedAts].sort((a, b) => a - b));
    });

    it('保存してある送信待ちの editedAt の最大値より後の時刻から始める（再読み込みの間に、時計が戻っていても）', async () => {
      const device = createDevice({ db: db() });
      const ahead = device.clock.now() + 3_600_000;
      await device.storage.save({
        id: 'future',
        request: {
          type: 'putEntry',
          targetId: 'saved-1',
          body: { draft: makeDraft(), editedAt: ahead },
        },
      });
      // 保存してある依頼を送れないまま、起動する（書き込みだけ、サーバーが 5xx を返す）。
      device.network.override = ({ method }) =>
        method === 'GET' ? undefined : fakeResponse(503, null);
      await device.engine.start();

      device.engine.createEntry(makeDraft({ title: '新しい' }));

      const queue = device.state().queue;
      expect(queue).toHaveLength(2);
      const last = queue[1];
      expect(last === undefined ? 0 : editedAtOf(last.request)).toBe(ahead + 1);
    });
  });

  describe('サーバーの応答（実装 #6 の確認 Q2・Q6）', () => {
    it('4xx で断られた依頼は、列から外れて画面から消え、保存できなかった変更として知らせる', async () => {
      const device = await startedDevice();
      // 組み込みのワークスペースの名前は変えられない（400 builtin_workspace）。端末のやり直しは、この検証を真似ないので、
      // 送るまでは画面に出る。
      const holiday = makeWorkspace({
        id: 'builtin-holiday',
        name: '祝日',
        builtin: 'holiday',
        color: '#F28B82',
      });
      const original = device.state().view.workspaces.get('builtin-holiday');
      device.engine.saveWorkspace({ ...holiday, name: '改名', sortOrder: 0, visible: true });
      expect(device.state().view.workspaces.get('builtin-holiday')?.name).toBe('改名');

      await device.engine.settled();

      expect(device.state().view.workspaces.get('builtin-holiday')).toEqual(original);
      expect(pendingOf(device)).toBe(0);
      expect(device.state().discarded).toEqual({ count: 1, clockSkew: false });
      expect((await device.storage.load()).requests).toEqual([]);
    });

    it('4xx で断られても、後ろの依頼は続けて送る', async () => {
      const device = await startedDevice();
      device.network.online = false;
      device.engine.saveWorkspace({
        id: 'builtin-holiday',
        name: '改名',
        color: '#F28B82',
        sortOrder: 1,
        visible: true,
        builtin: 'holiday',
      });
      const created = device.engine.createEntry(makeDraft({ title: '後ろの依頼' }));
      await device.engine.settled();

      device.network.online = true;
      await device.engine.syncNow();

      expect(device.state().discarded.count).toBe(1);
      expect((await readAllRows(db())).entries.get(created?.entryId ?? '')?.title).toBe(
        '後ろの依頼',
      );
    });

    it('編集した時刻が未来すぎて断られたときは、端末の時計がずれていることを知らせる', async () => {
      const device = await startedDevice();
      device.clock.set(Date.now() + 3_600_000);

      const created = device.engine.createEntry(makeDraft());
      await device.engine.settled();

      expect(device.state().discarded).toEqual({ count: 1, clockSkew: true });
      expect(entryIn(device, created?.entryId ?? '')).toBeUndefined();
      expect(pendingOf(device)).toBe(0);
    });

    it('知らせを閉じると、数が 0 に戻る', async () => {
      const device = await startedDevice();
      device.clock.set(Date.now() + 3_600_000);
      device.engine.createEntry(makeDraft());
      await device.engine.settled();

      device.engine.dismissDiscarded();

      expect(device.state().discarded).toEqual({ count: 0, clockSkew: false });
    });

    it('200 の applied: false（別の端末の新しい編集に負けた）は、知らせない', async () => {
      const device = await startedDevice();
      const created = device.engine.createEntry(makeDraft({ title: '先' }));
      await device.engine.settled();
      const entryId = created?.entryId ?? '';
      // サーバーの行を、端末の次の編集より新しい編集時刻にする（別の端末が、後で編集した）。
      await db()
        .prepare('UPDATE entries SET edited_at = ?1 WHERE id = ?2')
        .bind(Date.now() + 100_000, entryId)
        .run();

      device.engine.changeEntry(toTarget(entryId), { title: '負ける編集' });
      await device.engine.settled();

      expect(device.state().discarded.count).toBe(0);
      expect(pendingOf(device)).toBe(0);
      // 受け取りで、サーバーの内容に戻る。
      expect(entryIn(device, entryId)?.title).toBe('先');
    });

    it.each([
      { name: '401', respond: () => fakeResponse(401, { error: 'unauthorized' }) },
      { name: '403', respond: () => fakeResponse(403, { error: 'forbidden' }) },
      {
        name: 'Access のログイン画面への転送（opaqueredirect）',
        respond: () => fakeResponse(0, null, 'opaqueredirect'),
      },
    ])(
      '$name は、依頼を捨てずに送信を止め、ログインし直すよう知らせる。次のきっかけで再び試し、通れば続ける（実装 #6 の確認 Q6）',
      async ({ respond }) => {
        const device = await startedDevice();
        device.network.override = ({ method }) => (method === 'GET' ? undefined : respond());

        const created = device.engine.createEntry(makeDraft({ title: '残る' }));
        device.engine.createEntry(makeDraft({ title: '後ろ' }));
        await device.engine.settled();

        expect(device.state().authRequired).toBe(true);
        expect(pendingOf(device)).toBe(2);
        expect(device.state().discarded.count).toBe(0);
        expect(entryIn(device, created?.entryId ?? '')?.title).toBe('残る');
        expect((await device.storage.load()).requests).toHaveLength(2);
        // 先頭で止まり、後ろは送らない（試すのは、先頭の依頼だけ）。
        const titles = device.network.writes.map(
          ({ body }) => (body as { draft: { title: string } }).draft.title,
        );
        expect(new Set(titles)).toEqual(new Set(['残る']));

        device.network.override = null;
        device.page.goOnline();
        await device.engine.settled();

        expect(device.state().authRequired).toBe(false);
        expect(pendingOf(device)).toBe(0);
        expect((await readAllRows(db())).entries.get(created?.entryId ?? '')?.title).toBe('残る');
      },
    );

    it.each([500, 502, 503, 408, 429])(
      '%i は、依頼を外さずに止め、次のきっかけで再び試す（知らせない）',
      async (status) => {
        const device = await startedDevice();
        device.network.override = ({ method }) =>
          method === 'GET' ? undefined : fakeResponse(status, { error: 'x' });
        device.engine.createEntry(makeDraft());
        await device.engine.settled();

        expect(pendingOf(device)).toBe(1);
        expect(device.state().discarded.count).toBe(0);
        expect(device.state().authRequired).toBe(false);

        device.network.override = null;
        await device.engine.syncNow();

        expect(pendingOf(device)).toBe(0);
      },
    );

    it('429 を受けても、続けて送り直さず、次のきっかけ（60 秒ごと）でだけ再び試す。回数の制限を、短い間に叩き続けない（実装 #6 の確認 Q7）', async () => {
      const device = await startedDevice();
      device.network.override = ({ method }) =>
        method === 'GET' ? undefined : fakeResponse(429, { error: 'too_many_requests' });
      device.engine.createEntry(makeDraft());
      await device.engine.settled();
      const attempts = () => device.network.writes.length;
      expect(attempts()).toBe(1);
      // 再送のためのタイマーはない。残っているのは、60 秒ごとの受け取りのタイマーだけ。
      expect(device.clock.pendingTimerCount).toBe(1);

      device.clock.advance(POLL_INTERVAL_MS - 1);
      await device.engine.settled();
      expect(attempts()).toBe(1);

      device.clock.advance(1);
      await device.engine.settled();
      expect(attempts()).toBe(2);

      device.clock.advance(POLL_INTERVAL_MS);
      await device.engine.settled();
      expect(attempts()).toBe(3);
      expect(pendingOf(device)).toBe(1);
    });

    it('API のエラーの形でない 4xx（前段のエラーページなど）は、捨てずに、外さずに再び試す（実装 #6 の確認 Q12）', async () => {
      const device = await startedDevice();
      device.network.override = ({ method }) =>
        method === 'GET' ? undefined : fakeResponse(400, '<html>Bad Request</html>');
      device.engine.createEntry(makeDraft());
      await device.engine.settled();

      expect(pendingOf(device)).toBe(1);
      expect(device.state().discarded.count).toBe(0);

      device.network.override = null;
      await device.engine.syncNow();

      expect(pendingOf(device)).toBe(0);
    });

    it('200 でも、書き込みの応答の形でない本文（中継ページの HTML など）は、外さずに再び試す', async () => {
      const device = await startedDevice();
      device.network.override = ({ method }) =>
        method === 'GET' ? undefined : fakeResponse(200, '<html>login</html>');
      device.engine.createEntry(makeDraft());
      await device.engine.settled();

      expect(pendingOf(device)).toBe(1);
    });

    it('電波がない間に始めた送信が終わる前に、電波が戻っても、そのきっかけを失わず、止まった後にもう一度送る', async () => {
      const device = await startedDevice();
      // 送信が、電波のない間に始まり、通信の失敗が分かるまで、時間がかかっている（タイムアウトを待っている）。
      let failFirst: (error: Error) => void = () => undefined;
      device.network.override = ({ method }) =>
        method === 'GET'
          ? undefined
          : new Promise((_resolve, reject) => {
              failFirst = reject;
            });
      device.engine.createEntry(makeDraft({ title: '送る' }));
      await vi.waitFor(() => {
        expect(device.network.writes).toHaveLength(1);
      });

      // その間に電波が戻った。online のきっかけは、実行中の送信に合流するが、失われない。
      device.network.override = null;
      device.page.goOnline();
      failFirst(new TypeError('Failed to fetch'));
      await device.engine.settled();

      expect(pendingOf(device)).toBe(0);
      expect(device.network.writes).toHaveLength(2);
    });

    it('送れたかどうか分からない依頼（応答が届かなかった）は、再送しても、二重にならない', async () => {
      const device = await startedDevice();
      device.network.loseNextWriteResponses(1);

      const created = device.engine.createEntry(makeDraft({ title: '一度だけ' }));
      await device.engine.settled();
      const revAfterFirst = await serverMetaRev();
      expect(pendingOf(device)).toBe(1);

      await device.engine.syncNow();

      expect(pendingOf(device)).toBe(0);
      expect(device.network.writes).toHaveLength(2);
      const server = await readAllRows(db());
      expect([...server.entries.values()].filter(({ title }) => title === '一度だけ')).toHaveLength(
        1,
      );
      expect(server.entries.get(created?.entryId ?? '')?.title).toBe('一度だけ');
      // 2 回目はサーバーが捨てる（同じ editedAt）ので、rev が進まない。
      expect(await serverMetaRev()).toBe(revAfterFirst);
      expect(device.state().discarded.count).toBe(0);
    });
  });

  describe('送信が終わったとき（設計書 6.3）', () => {
    it('送り終えたら、受け取りを 1 回行う', async () => {
      const device = await startedDevice();
      const readsBefore = device.network.reads.length;

      device.engine.createEntry(makeDraft({ title: '1' }));
      device.engine.createEntry(makeDraft({ title: '2' }));
      await device.engine.settled();

      expect(device.network.reads.length - readsBefore).toBe(1);
    });

    it('送れずに止まったときは、受け取らない（次のきっかけにまとめて試す）', async () => {
      const device = await startedDevice();
      const readsBefore = device.network.reads.length;
      device.network.online = false;

      device.engine.createEntry(makeDraft());
      await device.engine.settled();

      expect(device.network.writes).toHaveLength(1);
      expect(device.network.reads.length).toBe(readsBefore);
    });

    it('送信が終わってから受け取りが終わるまでの間も、編集した予定は、画面から消えない', async () => {
      const device = await startedDevice();
      // 受け取りだけ失敗させる。書き込みは通る。
      device.network.override = ({ method }) =>
        method === 'GET' ? fakeResponse(503, { error: 'internal_error' }) : undefined;
      const revBefore = device.state().base.rev;

      const created = device.engine.createEntry(makeDraft({ title: '消えない' }));
      await device.engine.settled();

      // 列からは外れている（サーバーが受け取った）。
      expect(pendingOf(device)).toBe(0);
      expect(device.state().confirming).toHaveLength(1);
      // サーバーから受け取った内容には、まだない。それでも、画面に出すデータには、残っている。
      expect(device.state().base.entries.has(created?.entryId ?? '')).toBe(false);
      expect(entryIn(device, created?.entryId ?? '')?.title).toBe('消えない');
      // 書き込みの応答から rev は覚えない（他の端末の行の取りこぼしを防ぐ。設計書 6.3）。
      expect(device.state().base.rev).toBe(revBefore);

      device.network.override = null;
      await device.engine.syncNow();

      expect(device.state().confirming).toHaveLength(0);
      expect(device.state().base.entries.has(created?.entryId ?? '')).toBe(true);
      expect(device.state().base.rev).toBe(await serverMetaRev());
      expect(entryIn(device, created?.entryId ?? '')?.title).toBe('消えない');
    });
  });
});

describe('削除の「元に戻す」（設計書 6.6・OT-1）', () => {
  async function deviceWithEntry() {
    const device = await startedDevice();
    const created = device.engine.createEntry(makeDraft({ title: '消す予定' }));
    await device.engine.settled();
    return { device, entryId: created?.entryId ?? '' };
  }

  it('削除は、手元ではすぐ消えるが、元に戻すの間（5 秒）は、サーバーに送らない', async () => {
    const { device, entryId } = await deviceWithEntry();
    const writesBefore = device.network.writes.length;

    const accepted = device.engine.deleteEntry(toTarget(entryId));
    await device.engine.settled();

    expect(accepted).not.toBeNull();
    expect(entryIn(device, entryId)?.deletedAt).not.toBeNull();
    expect(pendingOf(device)).toBe(1);
    expect(device.network.writes).toHaveLength(writesBefore);

    device.clock.advance(DELETE_UNDO_MS - 1);
    await device.engine.settled();
    expect(device.network.writes).toHaveLength(writesBefore);

    device.clock.advance(1);
    await device.engine.settled();

    expect(device.network.writes).toHaveLength(writesBefore + 1);
    expect(pendingOf(device)).toBe(0);
    expect((await readAllRows(db())).entries.get(entryId)?.deletedAt).not.toBeNull();
  });

  it('元に戻すと、列と IndexedDB から消えて、画面は元に戻り、何も送られない', async () => {
    const { device, entryId } = await deviceWithEntry();
    const before = entryIn(device, entryId);
    const writesBefore = device.network.writes.length;
    const accepted = device.engine.deleteEntry(toTarget(entryId));
    await device.engine.settled();

    expect(device.engine.undo(accepted?.requestId ?? '')).toBe(true);
    await device.engine.settled();

    expect(pendingOf(device)).toBe(0);
    expect(entryIn(device, entryId)).toEqual(before);
    expect((await device.storage.load()).requests).toEqual([]);

    device.clock.advance(DELETE_UNDO_MS * 2);
    await device.engine.settled();
    expect(device.network.writes).toHaveLength(writesBefore);
    expect((await readAllRows(db())).entries.get(entryId)?.deletedAt).toBeNull();
  });

  it('待ち中の削除は、IndexedDB に保存してある（タブが閉じられても、失わない）', async () => {
    const { device, entryId } = await deviceWithEntry();

    device.engine.deleteEntry(toTarget(entryId));
    await device.engine.settled();

    const stored = (await device.storage.load()).requests;
    expect(stored.map(({ request }) => request.type)).toEqual(['deleteEntry']);
  });

  it('送り始めた依頼は、元に戻せない', async () => {
    const { device, entryId } = await deviceWithEntry();
    let release: (response: ReturnType<typeof fakeResponse>) => void = () => undefined;
    const accepted = device.engine.deleteEntry(toTarget(entryId));
    // 待ちをやめて送り始める（タブが裏に回る）。応答が来るまで、送信中のままにする。
    device.network.override = ({ method }) =>
      method === 'GET'
        ? undefined
        : new Promise((resolve) => {
            release = resolve;
          });
    device.page.hide();
    await vi.waitFor(() => {
      expect(device.network.writes.length).toBeGreaterThan(1);
    });

    expect(device.engine.undo(accepted?.requestId ?? '')).toBe(false);

    release(fakeResponse(200, { applied: true }));
    await device.engine.settled();
  });

  it('存在しない依頼の取り消しは、false', async () => {
    const device = await startedDevice();
    expect(device.engine.undo('nothing')).toBe(false);
  });

  it('先頭の依頼が待ち中なら、後ろの依頼も待つ（順番を崩さない）', async () => {
    const { device, entryId } = await deviceWithEntry();
    const writesBefore = device.network.writes.length;

    device.engine.deleteEntry(toTarget(entryId));
    const other = device.engine.createEntry(makeDraft({ title: '後ろ' }));
    await device.engine.settled();

    expect(device.network.writes).toHaveLength(writesBefore);
    expect(pendingOf(device)).toBe(2);

    device.clock.advance(DELETE_UNDO_MS);
    await device.engine.settled();

    expect(device.network.writes.slice(writesBefore).map(({ method }) => method)).toEqual([
      'DELETE',
      'PUT',
    ]);
    expect((await readAllRows(db())).entries.get(other?.entryId ?? '')?.title).toBe('後ろ');
  });

  describe('ワークスペースの削除', () => {
    async function deviceWithExtraWorkspace() {
      const device = await startedDevice();
      device.engine.saveWorkspace({
        id: 'extra',
        name: '私用',
        color: '#4285F4',
        sortOrder: 1,
        visible: true,
        builtin: null,
      });
      await device.engine.settled();
      expect((await readAllRows(db())).workspaces.get('extra')?.deletedAt).toBeNull();
      return device;
    }

    it('元に戻すの間（5 秒）は、サーバーに送らず、画面からはすぐ消える。過ぎたら送る', async () => {
      const device = await deviceWithExtraWorkspace();
      const writesBefore = device.network.writes.length;

      device.engine.deleteWorkspace('extra');
      await device.engine.settled();

      expect(device.state().view.workspaces.get('extra')?.deletedAt).not.toBeNull();
      expect(device.network.writes).toHaveLength(writesBefore);

      device.clock.advance(DELETE_UNDO_MS);
      await device.engine.settled();

      expect(device.network.writes.slice(writesBefore).map(({ method }) => method)).toEqual([
        'DELETE',
      ]);
      expect((await readAllRows(db())).workspaces.get('extra')?.deletedAt).not.toBeNull();
    });

    it('元に戻すと、何も送られず、ワークスペースも中の予定も、画面で元に戻る', async () => {
      const device = await deviceWithExtraWorkspace();
      const inside = device.engine.createEntry(
        makeDraft({ workspaceId: 'extra', title: '私用の予定' }),
      );
      await device.engine.settled();
      const writesBefore = device.network.writes.length;
      const accepted = device.engine.deleteWorkspace('extra');
      await device.engine.settled();
      expect(entryIn(device, inside?.entryId ?? '')?.deletedAt).not.toBeNull();

      expect(device.engine.undo(accepted?.requestId ?? '')).toBe(true);
      await device.engine.settled();

      expect(device.state().view.workspaces.get('extra')?.deletedAt).toBeNull();
      expect(entryIn(device, inside?.entryId ?? '')?.deletedAt).toBeNull();
      device.clock.advance(DELETE_UNDO_MS * 2);
      await device.engine.settled();
      expect(device.network.writes).toHaveLength(writesBefore);
      expect((await readAllRows(db())).workspaces.get('extra')?.deletedAt).toBeNull();
    });
  });

  it('先頭の待ち中の削除を元に戻すと、これまで待たされていた後ろの依頼を、すぐ送る', async () => {
    const { device, entryId } = await deviceWithEntry();
    const accepted = device.engine.deleteEntry(toTarget(entryId));
    const other = device.engine.createEntry(makeDraft({ title: '後ろ' }));
    await device.engine.settled();
    expect(pendingOf(device)).toBe(2);
    const writesBefore = device.network.writes.length;

    device.clock.advance(1000);
    device.engine.undo(accepted?.requestId ?? '');
    await device.engine.settled();

    // 次のきっかけ（60 秒ごとの受け取りなど）を待たずに送られている。
    expect(pendingOf(device)).toBe(0);
    expect(device.network.writes.slice(writesBefore).map(({ method }) => method)).toEqual(['PUT']);
    expect((await readAllRows(db())).entries.get(other?.entryId ?? '')?.title).toBe('後ろ');
  });

  it('タブが裏に回ると、待ちをやめて、すぐ送る。そのときの送信には keepalive を付ける', async () => {
    const { device, entryId } = await deviceWithEntry();
    device.engine.deleteEntry(toTarget(entryId));
    await device.engine.settled();

    device.page.hide();
    await device.engine.settled();

    expect(pendingOf(device)).toBe(0);
    const last = device.network.writes.at(-1);
    expect(last?.method).toBe('DELETE');
    expect(last?.keepalive).toBe(true);
  });

  it('keepalive は、裏に回ったときだけ付ける。前面にある間の送信には付けない', async () => {
    const device = await startedDevice();

    device.engine.createEntry(makeDraft({ title: '前面' }));
    await device.engine.settled();
    device.page.hide();
    device.engine.createEntry(makeDraft({ title: '裏' }));
    await device.engine.settled();
    device.page.show();
    device.engine.createEntry(makeDraft({ title: '前面に戻った' }));
    await device.engine.settled();

    expect(device.network.writes.map(({ keepalive }) => keepalive)).toEqual([false, true, false]);
  });
});

describe('受け取る（設計書 6.3）', () => {
  it('前面にある間は、60 秒ごとに受け取る', async () => {
    const device = await startedDevice();
    const readsBefore = device.network.reads.length;

    device.clock.advance(POLL_INTERVAL_MS);
    await device.engine.settled();
    expect(device.network.reads.length).toBe(readsBefore + 1);

    device.clock.advance(POLL_INTERVAL_MS);
    await device.engine.settled();
    expect(device.network.reads.length).toBe(readsBefore + 2);
  });

  it('裏に回っている間は、60 秒ごとの受け取りをしない', async () => {
    const device = await startedDevice();
    device.page.hide();
    await device.engine.settled();
    const readsBefore = device.network.reads.length;

    device.clock.advance(POLL_INTERVAL_MS * 3);
    await device.engine.settled();

    expect(device.network.reads.length).toBe(readsBefore);
  });

  it('タブが前面に戻ったときと、電波が戻ったときに、受け取る', async () => {
    const device = await startedDevice();
    device.page.hide();
    await device.engine.settled();
    const readsBefore = device.network.reads.length;

    device.page.show();
    await device.engine.settled();
    expect(device.network.reads.length).toBe(readsBefore + 1);

    device.page.goOnline();
    await device.engine.settled();
    expect(device.network.reads.length).toBe(readsBefore + 2);
  });

  it('受け取りは、同時に 1 つだけ。実行中に頼まれたら、終わった後にもう 1 回', async () => {
    const device = await startedDevice();
    const readsBefore = device.network.reads.length;

    await Promise.all([device.engine.syncNow(), device.engine.syncNow(), device.engine.syncNow()]);

    expect(device.network.maxConcurrentReads).toBe(1);
    expect(device.network.reads.length - readsBefore).toBe(2);
  });

  it('差分は、最後に受け取った rev より後だけを受け取る', async () => {
    const device = await startedDevice();
    const rev = device.state().base.rev;

    await device.engine.syncNow();

    expect(device.network.reads.at(-1)?.url).toBe(`/api/changes?since=${String(rev)}`);
  });

  it('入力のルール（15 分刻みなど）を満たさない行があっても、受け取れる', async () => {
    await db().batch([
      db().prepare('UPDATE meta SET rev = 50'),
      db().prepare(
        `INSERT INTO entries (id, kind, title, workspace_id, all_day, start_date, start_time, end_date, end_time,
             notify_enabled, notify_offset_min, edited_at, rev)
           VALUES ('odd', 'event', '変な時刻', 'default-workspace', 0, '2026-10-19', '09:07', '2026-10-19', '10:07',
             1, 10, 5, 50)`,
      ),
    ]);

    const device = await startedDevice();

    expect(device.state().phase).toBe('ready');
    expect(entryIn(device, 'odd')?.startTime).toBe('09:07');
    expect(device.state().syncError).toBe(false);
  });

  it('応答の形が合わないときは、当てずに、同期のエラーとして知らせる。次に受け取れれば、知らせは消える', async () => {
    const device = await startedDevice();
    const before = device.state().base;
    device.network.override = ({ method }) =>
      method === 'GET'
        ? fakeResponse(200, { rev: 'x', epoch: 1, workspaces: [], entries: [] })
        : undefined;

    await device.engine.syncNow();

    expect(device.state().syncError).toBe(true);
    expect(device.state().base).toBe(before);
    expect(device.state().phase).toBe('ready');

    device.network.override = null;
    await device.engine.syncNow();

    expect(device.state().syncError).toBe(false);
  });

  it('受け取りで 401・403 が返ったときは、ログインし直すよう知らせる', async () => {
    const device = await startedDevice();
    device.network.override = ({ method }) =>
      method === 'GET' ? fakeResponse(403, { error: 'forbidden' }) : undefined;

    await device.engine.syncNow();

    expect(device.state().authRequired).toBe(true);
    device.network.override = null;
    await device.engine.syncNow();
    expect(device.state().authRequired).toBe(false);
  });

  describe('epoch（設計書 付録 A.1）', () => {
    it('epoch が違えば、受け取った内容を捨てて、since=0 で読み込み直す。送信待ちの列は消さない', async () => {
      const device = await startedDevice();
      const created = device.engine.createEntry(makeDraft({ title: '復元前にあった予定' }));
      await device.engine.settled();
      const entryId = created?.entryId ?? '';
      expect(device.state().base.entries.has(entryId)).toBe(true);

      // データを復元した（過去の時点に戻した）ことにする。その予定はなく、rev は戻り、epoch が変わる。
      await db().batch([
        db().prepare('DELETE FROM entries WHERE id = ?1').bind(entryId),
        restoredMetaStatement(db(), 'restored'),
      ]);
      // 復元の後に、端末で編集した（電波がない間）。
      device.network.online = false;
      device.engine.createEntry(makeDraft({ title: '復元後の編集' }));
      await device.engine.settled();
      device.network.online = true;
      const readsBefore = device.network.reads.length;

      await device.engine.syncNow();

      expect(device.state().base.epoch).toBe('restored');
      expect(device.state().base.entries.has(entryId)).toBe(false);
      expect(device.network.reads.slice(readsBefore).map(({ url }) => url)).toEqual([
        expect.stringMatching(/^\/api\/changes\?since=[1-9]\d*$/),
        '/api/changes?since=0',
      ]);
      // 送信待ちは消えず、送られて、サーバーに入る。
      expect(pendingOf(device)).toBe(0);
      const titles = [...(await readAllRows(db())).entries.values()].map(({ title }) => title);
      expect(titles).toEqual(['復元後の編集']);
    });

    it('読み込み直しに失敗したときは、画面に出すデータを、空にしない', async () => {
      const device = await startedDevice();
      const created = device.engine.createEntry(makeDraft({ title: '残る' }));
      await device.engine.settled();
      await db().prepare("UPDATE meta SET epoch = 'restored'").run();
      device.network.override = ({ url, method }) =>
        method === 'GET' && url.endsWith('since=0') ? fakeResponse(503, null) : undefined;

      await device.engine.syncNow();

      expect(device.state().base.epoch).not.toBe('restored');
      expect(entryIn(device, created?.entryId ?? '')?.title).toBe('残る');
    });
  });
});

describe('タイマーと止めた後（停止）', () => {
  it('止めると、タイマーと、ページの出来事の購読をやめる', async () => {
    const device = await startedDevice();
    expect(device.page.subscriberCount).toBe(1);

    device.engine.stop();

    expect(device.state().phase).toBe('stopped');
    expect(device.state().takenOver).toBe(false);
    expect(device.page.subscriberCount).toBe(0);
    expect(device.clock.pendingTimerCount).toBe(0);
  });

  it('止めた後は、編集を受け付けない', async () => {
    const device = await startedDevice();
    device.engine.stop();

    expect(device.engine.createEntry(makeDraft())).toBeNull();
    expect(device.engine.deleteEntry(toTarget('x'))).toBeNull();
    expect(pendingOf(device)).toBe(0);
  });
});
