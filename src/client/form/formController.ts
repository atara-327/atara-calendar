import { createStore, type StoreApi } from 'zustand/vanilla';
import type { Occurrence } from '../../shared/recurrence';
import { createHistoryMark, type HistoryEnv, type HistoryPort } from '../historyMark';
import type { StartPoint } from './schedule';
import type { EntryKind } from './values';

// フォームを開いている間の状態（設計書 11.4）。開いたら履歴を 1 つ積み、スマホの「戻る」でフォームを閉じる。
// 履歴の出し入れは、サイドメニューと共通の部品（historyMark.ts）に、印の名前 'form' を渡して行う。

export type { HistoryPort };

export type FormTarget =
  /** start は、開始の初期値。なければ、今日の次の正時（日表示が、見ている日と、タップした時刻を渡す）。 */
  | { mode: 'create'; kind: EntryKind; openedAt: number; start?: StartPoint }
  | { mode: 'edit'; occurrence: Occurrence; openedAt: number };

export interface FormState {
  /** 開いているフォーム。閉じているときは null。 */
  target: FormTarget | null;
  /** 開くたびに増える。フォームの部品を、開くたびに作り直す（入力値を引き継がない）ための key。 */
  session: number;
}

export type FormControllerEnv = HistoryEnv;

export interface FormController {
  readonly store: StoreApi<FormState>;
  /** フォームを開く。すでに開いているときは、何もしない。 */
  open(target: FormTarget): void;
  /** ✕・保存・削除で閉じる。積んだ履歴も戻す。閉じているときは、何もしない。 */
  close(): void;
  /** 戻る・進むと、起動時の履歴の食い違いを見張り始める。戻り値は、やめる関数。 */
  start(): () => void;
}

export function createFormController(env: FormControllerEnv): FormController {
  const store = createStore<FormState>(() => ({ target: null, session: 0 }));
  const mark = createHistoryMark(env, 'form');

  function open(target: FormTarget): void {
    // 二重に開くと、履歴を 2 つ積んでしまい、閉じても 1 つ残る。
    if (store.getState().target !== null) return;
    mark.push();
    store.setState((state) => ({ target, session: state.session + 1 }));
  }

  function close(): void {
    if (store.getState().target === null) return;
    // 先に閉じてから、履歴を戻す。履歴を戻す popstate が、あとから届いても、もう閉じている。
    store.setState({ target: null });
    mark.release();
  }

  function start(): () => void {
    return mark.watch({
      isOpen: () => store.getState().target !== null,
      close: () => {
        store.setState({ target: null });
      },
    });
  }

  return { store, open, close, start };
}
