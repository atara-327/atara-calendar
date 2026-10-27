import { describe, expect, it } from 'vitest';
import { FakeHistory } from '../../../test/helpers/history';
import { createFormController } from '../form/formController';
import { createSidebarController } from './sidebarController';

function setup(history = new FakeHistory()) {
  const env = { history, onPopState: history.onPopState };
  const controller = createSidebarController(env);
  controller.start();
  return { history, controller };
}

const view = (controller: ReturnType<typeof setup>['controller']) =>
  controller.store.getState().view;

describe('サイドメニューを開く', () => {
  it('開くと、メニューが開き、サイドメニューの印を付けた履歴を、1 つ積む', () => {
    const { history, controller } = setup();

    controller.open();

    expect(view(controller)).toBe('menu');
    expect(history.entries).toHaveLength(2);
    expect(history.state).toEqual({ inApp: true, sidebar: true });
  });

  it('すでに開いているときは、履歴を積まない', () => {
    const { history, controller } = setup();
    controller.open();

    controller.open();

    expect(history.entries).toHaveLength(2);
  });
});

describe('ワークスペースの編集へ移る', () => {
  it('履歴を積まずに、メニューの履歴を引き継ぐ（履歴は 1 つのまま）', () => {
    const { history, controller } = setup();
    controller.open();

    controller.openEditor();

    expect(view(controller)).toBe('editor');
    expect(history.entries).toHaveLength(2);
    expect(history.index).toBe(1);
  });

  it('メニューが開いていないときは、何もしない（履歴も積まない）', () => {
    const { history, controller } = setup();

    controller.openEditor();

    expect(view(controller)).toBe('closed');
    expect(history.entries).toHaveLength(1);
  });

  it('編集のあとに、もう一度呼んでも、状態も履歴も変わらない', () => {
    const { history, controller } = setup();
    controller.open();
    controller.openEditor();

    controller.openEditor();

    expect(view(controller)).toBe('editor');
    expect(history.entries).toHaveLength(2);
  });
});

describe('閉じる', () => {
  it('メニューから閉じると、積んだ履歴を戻す（履歴が残らない）', () => {
    const { history, controller } = setup();
    controller.open();

    controller.close();
    history.flush();

    expect(view(controller)).toBe('closed');
    expect(history.index).toBe(0);
  });

  it('編集からも、全部を閉じ、積んだ履歴を 1 つだけ戻す', () => {
    const { history, controller } = setup();
    history.pushState({ inApp: true });
    controller.open();
    controller.openEditor();

    controller.close();
    history.flush();

    expect(view(controller)).toBe('closed');
    // メニューを開く前の履歴（index 1）に戻る。2 つ戻ると、月表示の前に出てしまう。
    expect(history.index).toBe(1);
  });

  it('閉じた直後から、閉じている（履歴が戻るのを待たない）', () => {
    const { controller } = setup();
    controller.open();

    controller.close();

    expect(view(controller)).toBe('closed');
  });

  it('続けて 2 回閉じても、履歴を戻すのは 1 回だけ', () => {
    const { history, controller } = setup();
    history.pushState({ inApp: true });
    controller.open();

    controller.close();
    controller.close();
    history.flush();

    expect(history.index).toBe(1);
  });

  it('閉じているときに閉じても、履歴を戻さない', () => {
    const { history, controller } = setup();

    controller.close();
    history.flush();

    expect(history.entries).toEqual([null]);
    expect(history.index).toBe(0);
  });

  it('開いて閉じるのを繰り返しても、戻れる履歴が増えない', () => {
    const { history, controller } = setup();

    for (let i = 0; i < 3; i += 1) {
      controller.open();
      controller.openEditor();
      controller.close();
      history.flush();
    }

    expect(history.index).toBe(0);
  });
});

describe('スマホの「戻る」で閉じる', () => {
  it('メニューから「戻る」を押すと、閉じ、履歴は 1 つ戻った位置になる（月表示から出ない）', () => {
    const { history, controller } = setup();
    history.pushState({ inApp: true });
    controller.open();

    history.userBack();
    history.flush();

    expect(view(controller)).toBe('closed');
    expect(history.index).toBe(1);
  });

  it('編集から「戻る」を押しても、全部を閉じる（メニューには戻らない）', () => {
    const { history, controller } = setup();
    history.pushState({ inApp: true });
    controller.open();
    controller.openEditor();

    history.userBack();
    history.flush();

    expect(view(controller)).toBe('closed');
    expect(history.index).toBe(1);
  });
});

describe('履歴の印だけが残ったとき', () => {
  it('開き直したときに、サイドメニューの履歴の上にいたら（再読み込み）、履歴を 1 つ戻す', () => {
    const history = new FakeHistory();
    history.pushState({ inApp: true, sidebar: true });

    setup(history);
    history.flush();

    expect(history.index).toBe(0);
  });
});

describe('予定のフォームと、同じ履歴の上で動かすとき', () => {
  function setupBoth(history = new FakeHistory()) {
    const env = { history, onPopState: history.onPopState };
    const sidebar = createSidebarController(env);
    const form = createFormController(env);
    sidebar.start();
    form.start();
    return { history, sidebar, form };
  }

  it('サイドメニューを閉じても、フォームの状態は変わらず、履歴を余計に戻さない', () => {
    const { history, sidebar, form } = setupBoth();
    history.pushState({ inApp: true });
    sidebar.open();

    sidebar.close();
    history.flush();

    expect(form.store.getState().target).toBeNull();
    expect(history.index).toBe(1);
  });

  it('フォームを閉じても、サイドメニューの履歴を戻さない', () => {
    const { history, sidebar, form } = setupBoth();
    history.pushState({ inApp: true });
    sidebar.open();

    form.close();
    history.flush();

    expect(sidebar.store.getState().view).toBe('menu');
    expect(history.index).toBe(2);
  });

  it('再読み込みでフォームの印だけが残っていても、サイドメニューは何も開かず、フォームだけが戻す', () => {
    const history = new FakeHistory();
    history.pushState({ inApp: true });
    history.pushState({ inApp: true, form: true });

    const { sidebar } = setupBoth(history);
    history.flush();

    expect(sidebar.store.getState().view).toBe('closed');
    expect(history.index).toBe(1);
  });
});
