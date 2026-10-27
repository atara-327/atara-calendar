// ブラウザの履歴に「開いている」印を付けて、スマホの「戻る」で閉じる仕組み（設計書 11.4・11.5）。
// 予定のフォーム（form/formController.ts）と、サイドメニュー（sidebar/sidebarController.ts）が、
// 印の名前だけを変えて使う。
// 開いたら履歴を 1 つ積み、「戻る」で閉じる。✕・保存・Esc などで閉じたときも、積んだ履歴を戻す。
// Why: 積まないと、開いたまま「戻る」を押したとき、月表示から出てしまう（設計書 2章の
// 「スマホの戻る操作がそのまま使える」）。閉じるときに戻さないと、開閉のたびに履歴が残り、
// 「戻る」を何度も押すことになる。
// URL は変えない。Why not: 入力の途中やメニューの開閉を URL にしても、開き直したときに復元できず、
// 共有もしないので、履歴に印（state）を付けるだけで足りる。
// ブラウザの機能は、env から受け取る（履歴の出し入れの順番が間違えやすく、テストで確かめるため）。

/** window.history のうち、使うもの。 */
export interface HistoryPort {
  readonly state: unknown;
  /** URL は渡さない（今の URL のまま、履歴だけを積む）。 */
  pushState(state: unknown, unused: string): void;
  back(): void;
}

export interface HistoryEnv {
  history: HistoryPort;
  /** popstate（戻る・進む）を受け取る。戻り値は、購読をやめる関数。 */
  onPopState(listener: () => void): () => void;
}

/** このブラウザの履歴。呼んだときに初めて window に触れる（読み込んだだけでは触れない）。 */
export function browserHistoryEnv(): HistoryEnv {
  return {
    history: window.history,
    onPopState: (listener) => {
      window.addEventListener('popstate', listener);
      return () => {
        window.removeEventListener('popstate', listener);
      };
    },
  };
}

/** 印を付けた履歴を、開いている側が見張るために渡すもの。 */
export interface MarkedLayer {
  isOpen(): boolean;
  /** 状態だけを閉じる。履歴は戻さない（履歴は、もう出ているか、起動時の食い違いを直す側が戻す）。 */
  close(): void;
}

export interface HistoryMark {
  /** 印を付けた履歴を 1 つ積む。 */
  push(): void;
  /** 今の履歴が、この印の履歴のときだけ、1 つ戻す。 */
  release(): void;
  /** 戻る・進むと、起動時の履歴の食い違いを見張り始める。戻り値は、やめる関数。 */
  watch(layer: MarkedLayer): () => void;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

/**
 * 印の名前ごとに、履歴の出し入れを行う。積む履歴の印は、この画面が積んだ履歴の印（navigation.ts の
 * IN_APP_STATE と同じ inApp）に、name の印を足したもの。
 * Why 名前を分けるのか: 同じ印にすると、フォームが閉じるとき、サイドメニューが積んだ履歴を戻してしまう
 * （逆も同じ）。印が違えば、自分の印の履歴にいるときだけ戻す。
 */
export function createHistoryMark(env: HistoryEnv, name: string): HistoryMark {
  const markedState = { inApp: true, [name]: true };

  function isMarked(state: unknown): boolean {
    return isRecord(state) && state[name] === true;
  }

  /**
   * 履歴と、開いているかの食い違いを直す。
   * - 印の履歴から出た（「戻る」）のに、開いている → 閉じる。
   * - 印の履歴にいるのに、開いていない → 履歴を 1 つ戻す。ページの再読み込みや、裏のタブが破棄されて
   *   開き直されたあと（履歴の印だけが残る）と、「進む」で印の履歴に入ったとき。
   *   戻さないと、「戻る」を押しても、何も変わらない 1 回が、余計にできる。
   */
  function settle(layer: MarkedLayer): void {
    if (!isMarked(env.history.state)) {
      if (layer.isOpen()) layer.close();
    } else if (!layer.isOpen()) {
      env.history.back();
    }
  }

  return {
    push() {
      env.history.pushState(markedState, '');
    },
    release() {
      // 今の履歴が、この印の履歴でないときは、戻さない。戻すと、開く前の画面（や、アプリの外）へ出てしまう。
      if (isMarked(env.history.state)) env.history.back();
    },
    watch(layer) {
      const stop = env.onPopState(() => {
        settle(layer);
      });
      settle(layer);
      return stop;
    },
  };
}
