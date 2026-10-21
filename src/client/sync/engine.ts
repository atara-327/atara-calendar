import { createStore, type StoreApi } from 'zustand/vanilla';
import type { ChangesResponse } from '../../shared/api';
import type { Entry, EntryChanges, EntryDraft, Scope, Workspace } from '../../shared/schema';
import { createEditedAtClock, type EditedAtClock } from './editedAt';
import { fetchChanges, sendRequest, type FetchFn, type WriteOutcome } from './http';
import type { TabLock, TabLockHandle } from './lock';
import { editedAtOf, pendingRequestSchema, type PendingRequest } from './requests';
import {
  computeView,
  initialState,
  type BaseData,
  type QueuedRequest,
  type SyncState,
} from './state';
import type { LoadedRequests, PendingStorage } from './storage';

// 同期の中心（設計書 6章）。サーバーから受け取った内容と、送信待ちの列を持ち、画面に出すデータは、その
// 2 つから作る。ブラウザの機能（fetch・IndexedDB・錠・ページの出来事・時計）は、すべて env から受け取る。
// Why: テストで、Miniflare の Worker につなぎ、端末を 2 台作って、時計と電波を自由に動かすため。

/** 削除の「元に戻す」を押せる時間（ms）。この間は、サーバーに送らない（設計書 6.6）。 */
export const DELETE_UNDO_MS = 5000;

/** 画面を開いている間に、受け取る間隔（ms。設計書 6.3）。 */
export const POLL_INTERVAL_MS = 60_000;

/** setTimeout の戻り値。ブラウザは number、Node は object。 */
export type TimerHandle = number | object;

export interface PageHandlers {
  /** 電波が戻った（online イベント）。 */
  online(): void;
  /** タブが前面に戻った。 */
  visible(): void;
  /** タブが裏に回る・閉じる（visibilitychange の hidden と pagehide）。 */
  hidden(): void;
}

export interface PageEvents {
  isVisible(): boolean;
  /** 戻り値は、購読をやめる関数。 */
  subscribe(handlers: PageHandlers): () => void;
}

export interface SyncEnvironment {
  fetch: FetchFn;
  storage: PendingStorage;
  locks: TabLock;
  page: PageEvents;
  now(): number;
  setTimeout(callback: () => void, ms: number): TimerHandle;
  clearTimeout(handle: TimerHandle): void;
  randomUUID(): string;
}

/** 依頼を列に入れたときの結果。requestId は、削除の「元に戻す」（undo）に使う。 */
export interface Accepted {
  requestId: string;
}

export interface EntryTarget {
  /** 系列の id。繰り返さない予定なら、その予定の id（設計書 5.1）。 */
  seriesId: string;
  occurrenceDate: string;
  scope: Scope;
}

export interface SyncEngine {
  readonly store: StoreApi<SyncState>;
  /** 錠を取る → 送信待ちを読む → 全データを読む → 送信を始める（設計書 6章）。 */
  start(): Promise<void>;
  /** 止める。止めたエンジンは、再び動かさない。 */
  stop(): void;
  /** 今すぐ、送って、受け取る。最初の読み込みに失敗しているときは、読み込みからやり直す。 */
  syncNow(): Promise<void>;
  /** 送信・受け取り・保存が、すべて終わるまで待つ（テスト用）。 */
  settled(): Promise<void>;

  // 依頼を作る側の入口。editedAt と新しい id をここで付けて、列に入れる。
  // 編集を受け付けられないとき（読み込み前・別のタブで開いたため止めたとき）は、何もせず null を返す。
  // 本文は、サーバーの入力の検証と同じスキーマで確かめる。通らなければ例外（フォームが先に確かめる前提）。
  createEntry(draft: EntryDraft): (Accepted & { entryId: string }) | null;
  changeEntry(target: EntryTarget, changes: EntryChanges): Accepted | null;
  /** 削除は、DELETE_UNDO_MS の間、送らずに待つ。その間なら、undo で取り消せる（設計書 6.6）。 */
  deleteEntry(target: EntryTarget): Accepted | null;
  saveWorkspace(workspace: Omit<Workspace, 'editedAt' | 'deletedAt'>): Accepted | null;
  deleteWorkspace(id: string): Accepted | null;
  /** 削除の「元に戻す」。まだ送っていなければ、列と IndexedDB から消して true。送り始めていたら false。 */
  undo(requestId: string): boolean;

  /** 「保存できなかった変更」の知らせを閉じる。 */
  dismissDiscarded(): void;
}

interface SendSummary {
  /** 列から外した依頼の数。 */
  sent: number;
  /** 5xx・通信の失敗・認証の失敗で、先頭の依頼を送れずに止まった。 */
  stalled: boolean;
}

type ReceiveResult = 'ok' | 'auth' | 'invalid' | 'failed' | 'skipped';

/** full なら、受け取った行だけにする（since=0 の応答は、削除済みの行を含まない）。そうでなければ、id で置き換える。 */
function mergeChanges(current: BaseData, changes: ChangesResponse, full: boolean): BaseData {
  const workspaces = new Map<string, Workspace>(full ? [] : current.workspaces);
  const entries = new Map<string, Entry>(full ? [] : current.entries);
  for (const workspace of changes.workspaces) workspaces.set(workspace.id, workspace);
  for (const entry of changes.entries) entries.set(entry.id, entry);
  return { rev: changes.rev, epoch: changes.epoch, workspaces, entries };
}

export function createSyncEngine(env: SyncEnvironment): SyncEngine {
  const store = createStore<SyncState>(() => initialState());

  let clock: EditedAtClock | null = null;
  let lockHandle: TabLockHandle | null = null;
  let unsubscribePage: (() => void) | null = null;
  let pollTimer: TimerHandle | null = null;
  let holdTimer: TimerHandle | null = null;
  // タブが裏に回っている間の送信に、keepalive を付ける（設計書 6.6）。
  let keepalive = false;
  let inFlightId: string | null = null;
  // 受け取りを始めた回数。200 を受け取った依頼を、どの受け取りで確かめられるかの印（ConfirmingRequest.coverIndex）。
  let receiveStarted = 0;
  // 保存（IndexedDB への書き込み）は、1 本の鎖で順番に行う。同じ依頼の保存と削除の順番が、入れ替わらないため。
  let persistChain: Promise<void> = Promise.resolve();

  function isActive(): boolean {
    return store.getState().phase !== 'stopped';
  }

  /**
   * 状態を更新する。base・queue・confirming が変わるときは、画面に出すデータ（view）を作り直す。
   * Why 毎回作り直すのか: 手元の編集結果を、サーバーから受け取った内容とは別にため込むと、サーバーが捨てた依頼の
   * 結果が、手元にだけ残り続ける（設計書 6.4）。
   */
  function update(patch: Partial<Omit<SyncState, 'view'>>): void {
    if (!('base' in patch || 'queue' in patch || 'confirming' in patch)) {
      store.setState(patch);
      return;
    }
    const next = { ...store.getState(), ...patch };
    store.setState({ ...patch, view: computeView(next.base, next.confirming, next.queue) });
  }

  /** 失敗しうる非同期の処理を、投げっぱなしにするときに使う。握りつぶさず、ログに残す。 */
  function run(task: Promise<unknown>): void {
    task.catch((error: unknown) => {
      console.error('同期の処理でエラーが起きました', error);
    });
  }

  function persist(task: () => Promise<void>): void {
    persistChain = persistChain.then(task).catch((error: unknown) => {
      // IndexedDB が使えない（プライベートブラウズなど）。送信待ちは、メモリの上では動き続ける。
      // ただし、タブが閉じられると消えるので、画面に知らせる。
      console.error('送信待ちを保存できませんでした', error);
      update({ storageFailed: true });
    });
  }

  // ---- 送る（設計書 6.2） ----

  const sending = { running: false, again: false };
  function wasAskedToSendAgain(): boolean {
    return sending.again;
  }
  let sendDone: Promise<SendSummary> = Promise.resolve({ sent: 0, stalled: false });

  /**
   * 列の先頭から 1 つずつ、順番に送る。同時に送るのは 1 つだけ。
   * 実行中に呼ばれたら、実行中のものに合流する。ループは、1 つ送るたびに列を見直すので、その間に入った依頼も送る。
   */
  function send(): Promise<SendSummary> {
    if (sending.running) {
      // 実行中に頼まれたことを覚えておく。実行中の送信が、電波がない間に始めたもので、まだ終わっていないときに、
      // 電波が戻った（online）としても、そのきっかけを失わないため。止まって終わるなら、もう一度試す（sendLoop）。
      sending.again = true;
      return sendDone;
    }
    sending.running = true;
    sendDone = sendLoop();
    return sendDone;
  }

  /** 送ってよい先頭の依頼。待ち中（元に戻すの間）なら、後ろの依頼も待つ（順番を崩さない）。 */
  function nextToSend(): QueuedRequest | null {
    if (!isActive() || store.getState().phase !== 'ready') return null;
    const [head] = store.getState().queue;
    if (head === undefined || head.sendAfter > env.now()) return null;
    return head;
  }

  async function sendLoop(): Promise<SendSummary> {
    let sent = 0;
    let stalled: boolean;
    do {
      sending.again = false;
      stalled = false;
      for (;;) {
        const head = nextToSend();
        if (head === null) break;
        inFlightId = head.id;
        const outcome = await sendRequest(env.fetch, head.request, { keepalive });
        inFlightId = null;
        // 錠を奪われた・止めた後の応答は、読まずに捨てる。列にも IndexedDB にも触らない。
        // 列の依頼は、IndexedDB に残っているので、引き継いだタブが送り直す（サーバーは 2 回目を捨てる）。
        if (!isActive()) break;
        if (outcome.kind === 'auth') {
          update({ authRequired: true });
          stalled = true;
          break;
        }
        if (outcome.kind === 'retry') {
          stalled = true;
          break;
        }
        completeHead(head, outcome);
        sent += 1;
      }
      // 止まって終わるとき、止まっている間に、次のきっかけ（編集・online など）が来ていたら、もう一度試す。
    } while (stalled && isActive() && wasAskedToSendAgain());
    // ループを終える判断と、送信中の印を戻すことの間に、await を挟まない。挟むと、その間に入った依頼を、
    // 実行中のループが見落としたまま、呼び出し側が合流したと思い込む。
    sending.running = false;
    armHoldTimer();
    return { sent, stalled };
  }

  /** 200 または 4xx を受け取った先頭の依頼を、列と IndexedDB から外す。 */
  function completeHead(
    item: QueuedRequest,
    outcome: Extract<WriteOutcome, { kind: 'done' | 'rejected' }>,
  ): void {
    const state = store.getState();
    const queue = state.queue.filter(({ id }) => id !== item.id);
    if (outcome.kind === 'done') {
      update({
        queue,
        confirming: [
          ...state.confirming,
          { id: item.id, request: item.request, coverIndex: receiveStarted + 1 },
        ],
        authRequired: false,
      });
    } else {
      // 4xx。画面からは、すぐ消える（view を作り直すと、この依頼が重ならない）。利用者に、捨てたことを知らせる（実装 #6 の確認 Q2）。
      update({
        queue,
        authRequired: false,
        discarded: {
          count: state.discarded.count + 1,
          clockSkew: state.discarded.clockSkew || outcome.clockSkew,
        },
      });
    }
    persist(() => env.storage.remove(item.id));
  }

  /**
   * 送信が終わったとき、受け取りを 1 回行う（設計書 6.3）。1 つも送らなかったとき（待ち中・列が空）と、
   * 送れずに止まったとき（電波がない・サーバーの不調）は、行わない。止まったときは、受け取りも失敗する
   * 見込みで、次のきっかけに、まとめて試す。
   */
  async function afterSend(summary: SendSummary): Promise<void> {
    if (summary.sent > 0 && !summary.stalled) await receive();
  }

  /**
   * 送って、止まらずに送り終えたら、受け取る。実行中の送信に合流した呼び出しは、受け取らない。
   * 合流した依頼も、実行中のループが送るので、そのループを始めた呼び出しが、まとめて 1 回だけ受け取ればよい。
   * 合流した呼び出しも受け取ると、続けて N 回編集したとき、受け取りを N 回頼むことになる。
   */
  async function syncSoon(): Promise<void> {
    if (store.getState().phase !== 'ready') return;
    const joined = sending.running;
    const summary = await send();
    if (!joined) await afterSend(summary);
  }

  // ---- 元に戻す（設計書 6.6） ----

  function armHoldTimer(): void {
    if (holdTimer !== null) {
      env.clearTimeout(holdTimer);
      holdTimer = null;
    }
    if (!isActive()) return;
    const [head] = store.getState().queue;
    if (head === undefined) return;
    const wait = head.sendAfter - env.now();
    if (wait <= 0) return;
    holdTimer = env.setTimeout(() => {
      holdTimer = null;
      run(syncSoon());
    }, wait);
  }

  /** 待ち中の依頼の、待ちをやめる。タブが裏に回る・閉じるとき、5 秒を待たずに送るため。 */
  function releaseHolds(): void {
    const { queue } = store.getState();
    if (queue.some(({ sendAfter }) => sendAfter > 0)) {
      update({
        queue: queue.map((item) => (item.sendAfter > 0 ? { ...item, sendAfter: 0 } : item)),
      });
    }
    armHoldTimer();
  }

  function undo(requestId: string): boolean {
    if (!isActive() || inFlightId === requestId) return false;
    const { queue } = store.getState();
    if (!queue.some(({ id }) => id === requestId)) return false;
    update({ queue: queue.filter(({ id }) => id !== requestId) });
    persist(() => env.storage.remove(requestId));
    armHoldTimer();
    // 取り消した依頼が先頭で、待ち中だったときは、その後ろの依頼が、これまで待たされていた。
    // 送り始めないと、次のきっかけ（最大 60 秒後）まで、後ろの依頼が送られない。
    run(syncSoon());
    return true;
  }

  // ---- 受け取る（設計書 6.3） ----

  // 状態を、let の変数ではなくオブジェクトに持つのは、await をまたいで別の関数が書き換える値を、
  // 型の検査が「いつも同じ値」と見なさないようにするため。
  const receiving = { running: false, again: false };
  function wasAskedAgain(): boolean {
    return receiving.again;
  }
  let receiveDone: Promise<ReceiveResult> = Promise.resolve('skipped');

  /** 同時に受け取るのは 1 つだけ。実行中に頼まれたら、終わった後にもう 1 回行う。 */
  function receive(): Promise<ReceiveResult> {
    if (receiving.running) {
      receiving.again = true;
      return receiveDone;
    }
    receiving.running = true;
    receiveDone = receiveLoop();
    return receiveDone;
  }

  async function receiveLoop(): Promise<ReceiveResult> {
    for (;;) {
      receiving.again = false;
      const result = await receiveOnce();
      if (!wasAskedAgain() || !isActive()) {
        receiving.running = false;
        return result;
      }
    }
  }

  async function receiveOnce(): Promise<ReceiveResult> {
    receiveStarted += 1;
    const started = receiveStarted;
    let since = store.getState().base.rev;
    for (;;) {
      const outcome = await fetchChanges(env.fetch, since);
      if (!isActive()) return 'skipped';
      if (outcome.kind === 'auth') {
        update({ authRequired: true });
        return 'auth';
      }
      if (outcome.kind === 'invalid') {
        // 形が合わない応答は、当てない。壊れた行だけを飛ばして当てると、端末は「全部受け取った」と思い込み、
        // その行が永久に届かないまま、気づけなくなる（設計書 6.3）。
        update({ syncError: true });
        return 'invalid';
      }
      if (outcome.kind === 'failed') return 'failed';

      const state = store.getState();
      const { changes } = outcome;
      if (since !== 0 && state.base.epoch !== null && changes.epoch !== state.base.epoch) {
        // データが復元された（設計書 付録 A.1）。覚えている rev は、復元の前のもので、意味がない。
        // 受け取った内容を捨てて、全データを読み込み直す。送信待ちの列は、消さない（まだサーバーにない編集のため）。
        // 読み込みが終わるまで、受け取った内容は、そのまま残す（失敗したときに、画面を空にしないため）。
        since = 0;
        continue;
      }
      update({
        base: mergeChanges(state.base, changes, since === 0),
        // この受け取りは、200 を受け取った後に始まっている依頼の結果を、含んでいる。
        confirming: state.confirming.filter(({ coverIndex }) => coverIndex > started),
        authRequired: false,
        syncError: false,
        ...(state.phase === 'loading' || state.phase === 'loadFailed' ? { phase: 'ready' } : {}),
      });
      return 'ok';
    }
  }

  // ---- 起動・停止・きっかけ ----

  async function loadInitial(): Promise<void> {
    update({ phase: 'loading' });
    const result = await receive();
    if (!isActive()) return;
    if (result !== 'ok') update({ phase: 'loadFailed' });
  }

  async function syncNow(): Promise<void> {
    if (!isActive()) return;
    if (store.getState().phase === 'loadFailed') await loadInitial();
    if (store.getState().phase !== 'ready') return;
    await send();
    await receive();
  }

  function schedulePoll(): void {
    if (pollTimer !== null) env.clearTimeout(pollTimer);
    pollTimer = env.setTimeout(() => {
      pollTimer = null;
      if (!isActive()) return;
      // 裏に回っている間は、受け取らない（設計書 6.3「前面にある間は 60 秒ごと」）。
      if (env.page.isVisible()) run(syncNow());
      schedulePoll();
    }, POLL_INTERVAL_MS);
  }

  function halt(takenOver: boolean): void {
    if (store.getState().phase === 'stopped') return;
    if (pollTimer !== null) env.clearTimeout(pollTimer);
    if (holdTimer !== null) env.clearTimeout(holdTimer);
    pollTimer = null;
    holdTimer = null;
    unsubscribePage?.();
    unsubscribePage = null;
    update({ phase: 'stopped', takenOver });
    // 奪われたときは、錠はもう手元にない。
    if (!takenOver) lockHandle?.release();
  }

  async function start(): Promise<void> {
    if (store.getState().phase !== 'idle') return;
    update({ phase: 'starting' });

    let handle: TabLockHandle;
    try {
      handle = await env.locks.acquire(() => {
        halt(true);
      });
    } catch (error) {
      // 錠の仕組みが失敗しても、動かさないという選択はしない（lock.ts の、錠がないブラウザと同じ考え方）。
      console.error('タブの錠を取れませんでした。複数のタブの調整をせずに動かします', error);
      handle = { release: () => undefined };
    }
    if (!isActive()) {
      handle.release();
      return;
    }
    lockHandle = handle;

    // 錠を取ってから、送信待ちを読む。錠を取る前に読むと、前のタブが、止まる直前に書いた依頼を見落とす。
    let loaded: LoadedRequests = { requests: [], discarded: 0 };
    try {
      loaded = await env.storage.load();
    } catch (error) {
      console.error('送信待ちを読み込めませんでした', error);
      update({ storageFailed: true });
    }
    if (!isActive()) return;

    clock = createEditedAtClock({
      now: () => env.now(),
      initial:
        loaded.requests.length === 0
          ? undefined
          : Math.max(...loaded.requests.map(({ request }) => editedAtOf(request))),
    });
    update({
      queue: loaded.requests.map(({ id, request }) => ({ id, request, sendAfter: 0 })),
      discarded: { count: loaded.discarded, clockSkew: false },
    });

    keepalive = !env.page.isVisible();
    unsubscribePage = env.page.subscribe({
      online: () => {
        run(syncNow());
      },
      visible: () => {
        keepalive = false;
        run(syncNow());
        schedulePoll();
      },
      hidden: () => {
        keepalive = true;
        releaseHolds();
        run(syncSoon());
      },
    });
    schedulePoll();

    await loadInitial();
    if (store.getState().phase === 'ready') await syncSoon();
  }

  // ---- 依頼を作る側の入口 ----

  function submit(build: (editedAt: number) => PendingRequest, holdMs = 0): Accepted | null {
    if (store.getState().phase !== 'ready' || clock === null) return null;
    const request = pendingRequestSchema.parse(build(clock.next()));
    const id = env.randomUUID();
    const sendAfter = holdMs > 0 ? env.now() + holdMs : 0;
    update({ queue: [...store.getState().queue, { id, request, sendAfter }] });
    persist(() => env.storage.save({ id, request }));
    armHoldTimer();
    run(syncSoon());
    return { requestId: id };
  }

  return {
    store,
    start,
    stop() {
      halt(false);
    },
    syncNow,
    async settled() {
      for (;;) {
        const chain = persistChain;
        await Promise.all([sendDone, receiveDone, chain]);
        if (!sending.running && !receiving.running && chain === persistChain) return;
      }
    },
    createEntry(draft) {
      const entryId = env.randomUUID();
      const accepted = submit((editedAt) => ({
        type: 'putEntry',
        targetId: entryId,
        body: { draft, editedAt },
      }));
      return accepted === null ? null : { ...accepted, entryId };
    },
    changeEntry({ seriesId, occurrenceDate, scope }, changes) {
      const newId = env.randomUUID();
      return submit((editedAt) => ({
        type: 'patchEntry',
        targetId: seriesId,
        body: { occurrenceDate, scope, changes, newId, editedAt },
      }));
    },
    deleteEntry({ seriesId, occurrenceDate, scope }) {
      const newId = env.randomUUID();
      return submit(
        (editedAt) => ({
          type: 'deleteEntry',
          targetId: seriesId,
          body: { occurrenceDate, scope, newId, editedAt },
        }),
        DELETE_UNDO_MS,
      );
    },
    saveWorkspace(workspace) {
      return submit((editedAt) => ({
        type: 'putWorkspace',
        body: { workspace: { ...workspace, editedAt, deletedAt: null } },
      }));
    },
    deleteWorkspace(id) {
      return submit((editedAt) => ({
        type: 'deleteWorkspace',
        targetId: id,
        body: { editedAt },
      }));
    },
    undo,
    dismissDiscarded() {
      update({ discarded: { count: 0, clockSkew: false } });
    },
  };
}
