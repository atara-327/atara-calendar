import 'fake-indexeddb/auto';
import {
  createSyncEngine,
  type PageHandlers,
  type SyncEngine,
  type TimerHandle,
} from '../../src/client/sync/engine';
import type { FetchFn, FetchInit, FetchResponse } from '../../src/client/sync/http';
import type { TabLock } from '../../src/client/sync/lock';
import type { SyncState } from '../../src/client/sync/state';
import { createIdbStorage, type PendingStorage } from '../../src/client/sync/storage';
import type { Bindings } from '../../src/worker/env';
import { app } from '../../src/worker/index';

// 同期の結合テストの道具。端末（同期のエンジンと、その環境）を、本物の Worker（Miniflare の D1 と app）に
// つなぐ。時計・電波・ページの出来事・タブの錠は、テストが自由に動かせる偽物にする。
// エンジンが使うブラウザの機能を、すべて env 経由にしてあるので、エンジンのコードは、本番と同じものが動く。

/** 手で進める時計とタイマー。advance で、期限が来たタイマーを、期限の順に呼ぶ。 */
export class ManualClock {
  private time: number;
  private nextId = 1;
  private readonly timers = new Map<number, { at: number; callback: () => void }>();

  constructor(start: number = Date.now()) {
    this.time = start;
  }

  readonly now = (): number => this.time;

  readonly setTimeout = (callback: () => void, ms: number): TimerHandle => {
    const id = this.nextId;
    this.nextId += 1;
    this.timers.set(id, { at: this.time + ms, callback });
    return id;
  };

  readonly clearTimeout = (handle: TimerHandle): void => {
    if (typeof handle === 'number') this.timers.delete(handle);
  };

  advance(ms: number): void {
    const target = this.time + ms;
    for (;;) {
      const due = [...this.timers.entries()]
        .filter(([, timer]) => timer.at <= target)
        .sort(([, a], [, b]) => a.at - b.at)[0];
      if (due === undefined) break;
      const [id, timer] = due;
      this.timers.delete(id);
      this.time = Math.max(this.time, timer.at);
      timer.callback();
    }
    this.time = target;
  }

  /** 時計だけを、指定した時刻にする（タイマーは動かさない）。端末の時計のずれを再現するため。 */
  set(time: number): void {
    this.time = time;
  }

  get pendingTimerCount(): number {
    return this.timers.size;
  }
}

export interface RecordedCall {
  method: string;
  url: string;
  body: unknown;
  keepalive: boolean;
}

/** 偽の応答。Response と同じ形（type・status・json）で、HTTP の中身を、テストが決める。 */
export function fakeResponse(status: number, body: unknown = null, type = 'basic'): FetchResponse {
  return { type, status, json: () => Promise.resolve(body) };
}

/**
 * 端末の fetch。電波がなければ失敗し、あれば、本物の Worker の app にそのまま渡す。
 * 認証は AUTH_MODE: 'dev'（localhost のときだけ効く）で通す。Sec-Fetch-Site は、ブラウザが付けるので、ここで付ける。
 */
export class WorkerNetwork {
  online = true;
  readonly calls: RecordedCall[] = [];
  /**
   * Worker が返した、書き込み（PUT・PATCH・DELETE）の応答。依頼が、書かれたか（200 の applied: true）、
   * 200 で捨てられたか（applied: false）、4xx にされたかを、テストが確かめる。端末は、捨てられた依頼も、
   * 4xx 以外は知らせない（設計書 6.2）ので、行を見比べるだけでは、捨てられたことに気づけない。
   */
  readonly writeResponses: { status: number; body: unknown }[] = [];
  /** 同時に実行中だった書き込み・読み込みの最大数。「同時に 1 つだけ」を確かめるため。 */
  maxConcurrentWrites = 0;
  maxConcurrentReads = 0;
  /** 値を返すと、Worker に渡さず、その応答を返す（4xx・403・壊れた応答などを再現する）。 */
  override: ((call: RecordedCall) => FetchResponse | Promise<FetchResponse> | undefined) | null =
    null;
  private lostResponses = 0;
  private inFlightWrites = 0;
  private inFlightReads = 0;

  constructor(private readonly db: D1Database) {}

  /** 次の n 回の書き込みは、Worker が実行するが、応答が届かない（電波が切れた）ことにする。 */
  loseNextWriteResponses(count: number): void {
    this.lostResponses = count;
  }

  readonly fetch: FetchFn = async (url: string, init: FetchInit): Promise<FetchResponse> => {
    const call: RecordedCall = {
      method: init.method,
      url,
      body: init.body === undefined ? undefined : (JSON.parse(init.body) as unknown),
      keepalive: init.keepalive === true,
    };
    this.calls.push(call);
    if (!this.online) throw new TypeError('Failed to fetch');
    const overridden = this.override?.(call);
    if (overridden !== undefined) return await overridden;

    const isRead = init.method === 'GET';
    if (isRead) {
      this.inFlightReads += 1;
      this.maxConcurrentReads = Math.max(this.maxConcurrentReads, this.inFlightReads);
    } else {
      this.inFlightWrites += 1;
      this.maxConcurrentWrites = Math.max(this.maxConcurrentWrites, this.inFlightWrites);
    }
    try {
      const env: Bindings = {
        DB: this.db,
        ACCESS_TEAM_DOMAIN: '',
        ACCESS_AUD: '',
        AUTH_MODE: 'dev',
      };
      const response = await app.request(
        url,
        {
          method: init.method,
          headers: { 'Sec-Fetch-Site': 'same-origin', ...init.headers },
          body: init.body,
        },
        env,
      );
      if (!isRead) {
        this.writeResponses.push({
          status: response.status,
          body: await response
            .clone()
            .json()
            .catch(() => null),
        });
      }
      if (!isRead && this.lostResponses > 0) {
        this.lostResponses -= 1;
        throw new TypeError('Failed to fetch');
      }
      return response;
    } finally {
      if (isRead) this.inFlightReads -= 1;
      else this.inFlightWrites -= 1;
    }
  };

  /** 書き込みの呼び出しだけ（GET を除く）。 */
  get writes(): RecordedCall[] {
    return this.calls.filter(({ method }) => method !== 'GET');
  }

  get reads(): RecordedCall[] {
    return this.calls.filter(({ method }) => method === 'GET');
  }
}

/** ページの出来事。テストが、電波の復帰・タブの前面・裏を起こす。 */
export class FakePage {
  visible = true;
  private readonly subscribers = new Set<PageHandlers>();

  readonly isVisible = (): boolean => this.visible;

  readonly subscribe = (handlers: PageHandlers): (() => void) => {
    this.subscribers.add(handlers);
    return () => {
      this.subscribers.delete(handlers);
    };
  };

  get subscriberCount(): number {
    return this.subscribers.size;
  }

  goOnline(): void {
    for (const handlers of this.subscribers) handlers.online();
  }

  hide(): void {
    this.visible = false;
    for (const handlers of this.subscribers) handlers.hidden();
  }

  show(): void {
    this.visible = true;
    for (const handlers of this.subscribers) handlers.visible();
  }
}

/**
 * 同じ端末の複数のタブが共有する錠（Web Locks の steal の動き）。新しいタブが取ると、古いタブの onLost が呼ばれる。
 * 端末を作るたびに、別のタブを開いたものとして扱う。
 */
export class FakeLockHub {
  private holder: { onLost: () => void } | null = null;

  lock(): TabLock {
    return {
      acquire: (onLost) => {
        const mine = { onLost };
        this.holder?.onLost();
        this.holder = mine;
        return Promise.resolve({
          release: () => {
            if (this.holder === mine) this.holder = null;
          },
        });
      },
    };
  }
}

export interface Device {
  engine: SyncEngine;
  network: WorkerNetwork;
  clock: ManualClock;
  page: FakePage;
  storage: PendingStorage;
  /** IndexedDB のデータベース名。同じ名前で端末を作ると、同じ端末の別のタブになる。 */
  dbName: string;
  state(): SyncState;
}

let deviceCounter = 0;

/**
 * 端末を 1 台作る。start() は呼ばない（テストが、起動の前に、保存や電波を用意できるように）。
 * id は、idPrefix に連番を付けたもの。端末ごとに別の接頭辞にして、2 台で id がぶつからないようにする。
 */
export function createDevice({
  db,
  hub = new FakeLockHub(),
  dbName,
  idPrefix,
  clock = new ManualClock(),
  storage: storageOverride,
}: {
  db: D1Database;
  hub?: FakeLockHub;
  dbName?: string;
  idPrefix?: string;
  clock?: ManualClock;
  /** 送信待ちの保存先。省くと、fake-indexeddb の上の本物の実装。保存の失敗を再現するときに渡す。 */
  storage?: PendingStorage;
}): Device {
  deviceCounter += 1;
  const name = dbName ?? `test-device-${String(deviceCounter)}`;
  const prefix = idPrefix ?? `dev${String(deviceCounter)}`;
  const network = new WorkerNetwork(db);
  const page = new FakePage();
  const storage = storageOverride ?? createIdbStorage({ dbName: name });
  let ids = 0;
  const engine = createSyncEngine({
    fetch: network.fetch,
    storage,
    locks: hub.lock(),
    page,
    now: clock.now,
    setTimeout: clock.setTimeout,
    clearTimeout: clock.clearTimeout,
    randomUUID: () => {
      ids += 1;
      return `${prefix}-${String(ids)}`;
    },
  });
  return {
    engine,
    network,
    clock,
    page,
    storage,
    dbName: name,
    state: () => engine.store.getState(),
  };
}
