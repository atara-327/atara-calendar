import { createStore, type StoreApi } from 'zustand/vanilla';
import { DELETE_UNDO_MS, type TimerHandle } from '../sync/engine';

// 削除したあとに画面の下へ出す「削除しました［元に戻す］」（OT-1。設計書 6.6）。
// 削除の依頼は、DELETE_UNDO_MS の間、サーバーに送らずに待つ（engine.ts）。その間だけ、元に戻せる。
// 出す時間は、その待ちと同じ DELETE_UNDO_MS にする。待ちが終わったあとに、ボタンを出し続けると、
// 押しても、もう取り消せない（送り始めている）。
// 時計とエンジンは、env から受け取る（テストで、時間を進めて確かめるため）。

export interface UndoNotice {
  id: number;
  /** 削除の依頼の id。engine.undo に渡す。 */
  requestId: string;
  /** waiting: 元に戻せる。failed: 押したが、もう送り始めていて、戻せなかった。 */
  status: 'waiting' | 'failed';
}

export interface UndoNoticeEnv {
  /** engine.undo。まだ送っていなければ true、送り始めていたら false。 */
  undo(requestId: string): boolean;
  setTimeout(callback: () => void, ms: number): TimerHandle;
  clearTimeout(handle: TimerHandle): void;
}

/** 「元に戻せませんでした」を出しておく時間（ms）。 */
export const FAILED_NOTICE_MS = 4000;

export interface UndoNotices {
  readonly store: StoreApi<{ notices: readonly UndoNotice[] }>;
  /** 削除したことを知らせ、DELETE_UNDO_MS の間、元に戻すボタンを出す。 */
  show(requestId: string): void;
  /** 元に戻すボタンを押した。 */
  undo(id: number): void;
}

export function createUndoNotices(env: UndoNoticeEnv): UndoNotices {
  const store = createStore<{ notices: readonly UndoNotice[] }>(() => ({ notices: [] }));
  const timers = new Map<number, TimerHandle>();
  let nextId = 1;

  function remove(id: number): void {
    const timer = timers.get(id);
    if (timer !== undefined) env.clearTimeout(timer);
    timers.delete(id);
    store.setState((state) => ({ notices: state.notices.filter((notice) => notice.id !== id) }));
  }

  function removeLater(id: number, ms: number): void {
    const timer = timers.get(id);
    if (timer !== undefined) env.clearTimeout(timer);
    timers.set(
      id,
      env.setTimeout(() => {
        remove(id);
      }, ms),
    );
  }

  return {
    store,
    show(requestId) {
      // 続けて削除したとき、前の知らせを消さずに、並べる。消すと、前の削除を、元に戻せなくなる。
      const id = nextId;
      nextId += 1;
      store.setState((state) => ({
        notices: [...state.notices, { id, requestId, status: 'waiting' }],
      }));
      removeLater(id, DELETE_UNDO_MS);
    },
    undo(id) {
      const notice = store.getState().notices.find((candidate) => candidate.id === id);
      if (notice?.status !== 'waiting') return;
      if (env.undo(notice.requestId)) {
        remove(id);
        return;
      }
      store.setState((state) => ({
        notices: state.notices.map((candidate) =>
          candidate.id === id ? { ...candidate, status: 'failed' } : candidate,
        ),
      }));
      removeLater(id, FAILED_NOTICE_MS);
    },
  };
}
