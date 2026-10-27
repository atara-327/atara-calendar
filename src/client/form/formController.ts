import { createStore, type StoreApi } from 'zustand/vanilla';
import type { Occurrence } from '../../shared/recurrence';
import type { StartPoint } from './schedule';
import type { EntryKind } from './values';

// フォームを開いている間の状態と、ブラウザの履歴の出し入れ（設計書 11.4）。
// 開いたら履歴を 1 つ積み、スマホの「戻る」でフォームを閉じる。✕・保存・削除で閉じたときも、積んだ履歴を戻す。
// Why: 積まないと、フォームを開いたまま「戻る」を押したとき、月表示から出てしまう（設計書 2章の
// 「スマホの戻る操作がそのまま使える」）。閉じるときに戻さないと、フォームを開閉するたびに履歴が残り、
// 「戻る」を何度も押すことになる。
// URL は変えない。Why not: フォームの入力の途中を URL にしても、開き直したときに復元できず、
// 共有もしないので、履歴に印（state）を付けるだけで足りる。ブラウザの機能は、env から受け取る
// （navigation.ts と違い、履歴の出し入れの順番が間違えやすく、テストで確かめるため）。

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

/** window.history のうち、使うもの。 */
export interface HistoryPort {
  readonly state: unknown;
  /** URL は渡さない（今の URL のまま、履歴だけを積む）。 */
  pushState(state: unknown, unused: string): void;
  back(): void;
}

export interface FormControllerEnv {
  history: HistoryPort;
  /** popstate（戻る・進む）を受け取る。戻り値は、購読をやめる関数。 */
  onPopState(listener: () => void): () => void;
}

export interface FormController {
  readonly store: StoreApi<FormState>;
  /** フォームを開く。すでに開いているときは、何もしない。 */
  open(target: FormTarget): void;
  /** ✕・保存・削除で閉じる。積んだ履歴も戻す。閉じているときは、何もしない。 */
  close(): void;
  /** 戻る・進むと、起動時の履歴の食い違いを見張り始める。戻り値は、やめる関数。 */
  start(): () => void;
}

/** この画面が積んだ履歴の印（navigation.ts の IN_APP_STATE と同じ inApp）に、フォームの印を足したもの。 */
const FORM_HISTORY_STATE = { inApp: true, form: true };

function isFormHistoryState(state: unknown): boolean {
  return typeof state === 'object' && state !== null && 'form' in state && state.form === true;
}

export function createFormController(env: FormControllerEnv): FormController {
  const store = createStore<FormState>(() => ({ target: null, session: 0 }));

  function open(target: FormTarget): void {
    // 二重に開くと、履歴を 2 つ積んでしまい、閉じても 1 つ残る。
    if (store.getState().target !== null) return;
    env.history.pushState(FORM_HISTORY_STATE, '');
    store.setState((state) => ({ target, session: state.session + 1 }));
  }

  function close(): void {
    if (store.getState().target === null) return;
    // 先に閉じてから、履歴を戻す。履歴を戻す popstate が、あとから届いても、もう閉じている。
    store.setState({ target: null });
    // 今の履歴が、フォームの履歴でないときは、戻さない。戻すと、フォームの前の画面（や、アプリの外）へ出てしまう。
    if (isFormHistoryState(env.history.state)) env.history.back();
  }

  /**
   * 履歴と、フォームの状態の食い違いを直す。
   * - フォームの履歴から出た（「戻る」）のに、フォームが開いている → 閉じる。
   * - フォームの履歴にいるのに、フォームが開いていない → 履歴を 1 つ戻す。ページの再読み込みや、
   *   裏のタブが破棄されて開き直されたあと（履歴の印だけが残る）と、「進む」でフォームの履歴に入ったとき。
   *   戻さないと、「戻る」を押しても、何も変わらない 1 回が、余計にできる。
   */
  function settle(): void {
    if (!isFormHistoryState(env.history.state)) {
      if (store.getState().target !== null) store.setState({ target: null });
    } else if (store.getState().target === null) {
      env.history.back();
    }
  }

  function start(): () => void {
    const stop = env.onPopState(settle);
    settle();
    return stop;
  }

  return { store, open, close, start };
}
