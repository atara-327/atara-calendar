import { createStore, type StoreApi } from 'zustand/vanilla';
import { createHistoryMark, type HistoryEnv } from '../historyMark';

// サイドメニューと、そこから開くワークスペースの編集の、開閉の状態（設計書 11.5）。
// 履歴の出し入れは、予定のフォームと共通の部品（historyMark.ts）に、印の名前 'sidebar' を渡して行う。
// Why 履歴を 1 つだけ使うのか: メニューから編集へ移るとき、メニューを閉じて、編集の履歴を積み直すと、
// 閉じるときの history.back() が非同期で、戻りきる前に積むことになり、履歴と画面の状態が食い違う。
// そこで、メニューを開いたときに積んだ履歴を、そのまま編集に引き継ぐ。どの段にいても、「戻る」・Esc・✕ は、
// 全部を閉じて、積んだ履歴を 1 つ戻す。

/** closed: 閉じている。menu: サイドメニュー（左から重ねて出す）。editor: ワークスペースの編集のダイアログ。 */
export type SidebarView = 'closed' | 'menu' | 'editor';

export interface SidebarState {
  view: SidebarView;
}

export type SidebarControllerEnv = HistoryEnv;

export interface SidebarController {
  readonly store: StoreApi<SidebarState>;
  /** サイドメニューを開く。履歴を 1 つ積む。すでに開いているときは、何もしない。 */
  open(): void;
  /** サイドメニューから、ワークスペースの編集へ移る。履歴は積まず、メニューの履歴を引き継ぐ。メニューが開いていなければ、何もしない。 */
  openEditor(): void;
  /** どの段からでも、全部を閉じる。積んだ履歴も戻す。閉じているときは、何もしない。 */
  close(): void;
  /** 戻る・進むと、起動時の履歴の食い違いを見張り始める。戻り値は、やめる関数。 */
  start(): () => void;
}

export function createSidebarController(env: SidebarControllerEnv): SidebarController {
  const store = createStore<SidebarState>(() => ({ view: 'closed' }));
  const mark = createHistoryMark(env, 'sidebar');

  function open(): void {
    // 二重に開くと、履歴を 2 つ積んでしまい、閉じても 1 つ残る。
    if (store.getState().view !== 'closed') return;
    mark.push();
    store.setState({ view: 'menu' });
  }

  function openEditor(): void {
    if (store.getState().view !== 'menu') return;
    store.setState({ view: 'editor' });
  }

  function close(): void {
    if (store.getState().view === 'closed') return;
    // 先に閉じてから、履歴を戻す。履歴を戻す popstate が、あとから届いても、もう閉じている。
    store.setState({ view: 'closed' });
    mark.release();
  }

  function start(): () => void {
    return mark.watch({
      isOpen: () => store.getState().view !== 'closed',
      close: () => {
        store.setState({ view: 'closed' });
      },
    });
  }

  return { store, open, openEditor, close, start };
}
