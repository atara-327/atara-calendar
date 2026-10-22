import { describe, expect, it } from 'vitest';
import { makeOccurrence } from '../../../test/helpers/entries';
import {
  createFormController,
  type FormController,
  type FormTarget,
  type HistoryPort,
} from './formController';

/**
 * ブラウザの履歴の偽物。pushState は、先の履歴を捨てて、積む。back は、すぐには動かず（実際のブラウザも
 * 非同期）、flush で動いて、popstate を起こす。
 */
class FakeHistory implements HistoryPort {
  readonly entries: unknown[] = [null];
  index = 0;
  private pendingBacks = 0;
  private listeners = new Set<() => void>();

  get state(): unknown {
    return this.entries[this.index];
  }

  pushState(state: unknown): void {
    this.entries.splice(this.index + 1);
    this.entries.push(state);
    this.index += 1;
  }

  back(): void {
    this.pendingBacks += 1;
  }

  /** 頼まれた「戻る」を、すべて実行する。 */
  flush(): void {
    while (this.pendingBacks > 0) {
      this.pendingBacks -= 1;
      this.move(-1);
    }
  }

  /** 利用者が、ブラウザの「戻る」を押す。 */
  userBack(): void {
    this.move(-1);
  }

  /** 利用者が、ブラウザの「進む」を押す。 */
  userForward(): void {
    this.move(1);
  }

  private move(delta: number): void {
    const next = this.index + delta;
    if (next < 0 || next >= this.entries.length) return;
    this.index = next;
    for (const listener of this.listeners) listener();
  }

  readonly onPopState = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  };
}

const create: FormTarget = { mode: 'create', kind: 'event', openedAt: 0 };
const edit: FormTarget = { mode: 'edit', occurrence: makeOccurrence(), openedAt: 0 };

function setup(history = new FakeHistory()): { history: FakeHistory; controller: FormController } {
  const controller = createFormController({ history, onPopState: history.onPopState });
  controller.start();
  return { history, controller };
}

const target = (controller: FormController) => controller.store.getState().target;

describe('フォームを開く', () => {
  it('開くと、履歴を 1 つ積み、開いたフォームを持つ', () => {
    const { history, controller } = setup();

    controller.open(create);

    expect(target(controller)).toEqual(create);
    expect(history.entries).toHaveLength(2);
  });

  it('積んだ履歴には、フォームの印と、この画面が積んだ履歴の印（inApp）を付ける', () => {
    const { history, controller } = setup();

    controller.open(create);

    expect(history.state).toEqual({ inApp: true, form: true });
  });

  it('編集（開いた回）も同じに、履歴を積む', () => {
    const { history, controller } = setup();

    controller.open(edit);

    expect(target(controller)).toEqual(edit);
    expect(history.entries).toHaveLength(2);
  });

  it('すでに開いているときは、開き直さず、履歴も積まない', () => {
    const { history, controller } = setup();
    controller.open(create);

    controller.open(edit);

    expect(target(controller)).toEqual(create);
    expect(history.entries).toHaveLength(2);
  });

  it('開くたびに、session が増える（フォームを作り直すため）', () => {
    const { history, controller } = setup();
    controller.open(create);
    const first = controller.store.getState().session;
    controller.close();
    history.flush();

    controller.open(create);

    expect(controller.store.getState().session).toBe(first + 1);
  });
});

describe('スマホの「戻る」で閉じる', () => {
  it('「戻る」を押すと、フォームが閉じ、履歴は 1 つ戻った位置になる（月表示から出ない）', () => {
    const { history, controller } = setup();
    controller.open(create);

    history.userBack();

    expect(target(controller)).toBeNull();
    expect(history.index).toBe(0);
  });

  it('「戻る」で閉じたあと、フォームの履歴を、さらに戻さない（二重に戻って、アプリから出ない）', () => {
    const { history, controller } = setup();
    controller.open(create);

    history.userBack();
    history.flush();

    expect(history.index).toBe(0);
  });
});

describe('✕・保存・削除で閉じる', () => {
  it('閉じると、フォームを閉じ、積んだ履歴を戻す（履歴が残らない）', () => {
    const { history, controller } = setup();
    controller.open(create);

    controller.close();
    history.flush();

    expect(target(controller)).toBeNull();
    expect(history.index).toBe(0);
  });

  it('閉じた直後から、フォームは閉じている（履歴が戻るのを待たない）', () => {
    const { controller } = setup();
    controller.open(create);

    controller.close();

    expect(target(controller)).toBeNull();
  });

  it('続けて 2 回閉じても、履歴を戻すのは 1 回だけ', () => {
    const { history, controller } = setup();
    controller.open(create);

    controller.close();
    controller.close();
    history.flush();

    expect(history.index).toBe(0);
  });

  it('閉じているときに閉じても、履歴を戻さない', () => {
    const { history, controller } = setup();

    controller.close();
    history.flush();

    expect(history.index).toBe(0);
    expect(history.entries).toEqual([null]);
  });

  it('開いて閉じるのを繰り返しても、戻れる履歴が増えない', () => {
    const { history, controller } = setup();

    for (let i = 0; i < 3; i += 1) {
      controller.open(create);
      controller.close();
      history.flush();
    }

    expect(history.index).toBe(0);
  });

  it('履歴を戻し終える前に、開き直しても、フォームは開いたまま、閉じれば元の位置に戻る', () => {
    const { history, controller } = setup();
    controller.open(create);
    controller.close();

    controller.open(edit);
    history.flush();

    expect(target(controller)).toEqual(edit);
    controller.close();
    history.flush();
    expect(target(controller)).toBeNull();
    expect(history.index).toBe(0);
  });

  it('今の履歴が、フォームの履歴でなくなっていたら、戻さない（フォームの前の画面から出てしまうため）', () => {
    const { history, controller } = setup();
    controller.open(create);
    // 別の処理が、今の履歴の印を置き換えた、という状況（replaceState）。
    history.entries[history.index] = { inApp: true };

    controller.close();
    history.flush();

    expect(history.index).toBe(1);
    expect(target(controller)).toBeNull();
  });
});

describe('履歴の印だけが残ったとき', () => {
  it('開き直したときに、フォームの履歴の上にいたら（再読み込み・タブの復元）、履歴を 1 つ戻す', () => {
    const history = new FakeHistory();
    history.pushState({ inApp: true, form: true });

    setup(history);
    history.flush();

    expect(history.index).toBe(0);
  });

  it('「進む」でフォームの履歴に入っても、フォームは開いていないので、履歴を戻す', () => {
    const { history, controller } = setup();
    controller.open(create);
    history.userBack();

    history.userForward();
    history.flush();

    expect(target(controller)).toBeNull();
    expect(history.index).toBe(0);
  });

  it('止めると、「戻る」を見張らない', () => {
    const history = new FakeHistory();
    const controller = createFormController({ history, onPopState: history.onPopState });
    const stop = controller.start();
    controller.open(create);

    stop();
    history.userBack();

    expect(target(controller)).toEqual(create);
  });
});
