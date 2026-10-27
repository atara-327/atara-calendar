import { describe, expect, it } from 'vitest';
import { FakeHistory } from '../../test/helpers/history';
import { createHistoryMark } from './historyMark';

/** 開いているかを、変数 1 つで持つ層。 */
function setupLayer(name: string, history = new FakeHistory()) {
  const mark = createHistoryMark({ history, onPopState: history.onPopState }, name);
  const layer = {
    open: false,
    isOpen: () => layer.open,
    close: () => {
      layer.open = false;
    },
  };
  return { history, mark, layer };
}

describe('履歴を積む', () => {
  it('印の名前と、この画面が積んだ履歴の印（inApp）を付けた履歴を、1 つ積む', () => {
    const { history, mark } = setupLayer('drawer');

    mark.push();

    expect(history.entries).toHaveLength(2);
    expect(history.state).toEqual({ inApp: true, drawer: true });
  });
});

describe('履歴を戻す', () => {
  it('今の履歴が、この印の履歴なら、1 つ戻す', () => {
    const { history, mark } = setupLayer('drawer');
    mark.push();

    mark.release();
    history.flush();

    expect(history.index).toBe(0);
  });

  it('今の履歴が、別の印の履歴なら、戻さない（その履歴を積んだ側が閉じるまで残す）', () => {
    const { history, mark } = setupLayer('drawer');
    history.pushState({ inApp: true, form: true });

    mark.release();
    history.flush();

    expect(history.index).toBe(1);
  });

  it('今の履歴が、印のない履歴なら、戻さない（開く前の画面から出てしまうため）', () => {
    const { history, mark } = setupLayer('drawer');
    history.pushState({ inApp: true });

    mark.release();
    history.flush();

    expect(history.index).toBe(1);
  });
});

describe('「戻る」を見張る', () => {
  it('印の履歴から出たとき、開いていれば、閉じる', () => {
    const { history, mark, layer } = setupLayer('drawer');
    mark.watch(layer);
    mark.push();
    layer.open = true;

    history.userBack();

    expect(layer.open).toBe(false);
  });

  it('印の履歴から出て、すでに閉じているときは、履歴をそれ以上、戻さない', () => {
    const { history, mark, layer } = setupLayer('drawer');
    mark.watch(layer);
    mark.push();
    layer.open = true;
    history.userBack();

    history.flush();

    expect(history.index).toBe(0);
  });

  it('起動時に、印の履歴の上にいて、開いていなければ（再読み込み）、履歴を 1 つ戻す', () => {
    const history = new FakeHistory();
    history.pushState({ inApp: true, drawer: true });
    const { mark, layer } = setupLayer('drawer', history);

    mark.watch(layer);
    history.flush();

    expect(history.index).toBe(0);
  });

  it('「進む」で、印の履歴に入ったとき、開いていなければ、履歴を 1 つ戻す', () => {
    const { history, mark, layer } = setupLayer('drawer');
    mark.watch(layer);
    mark.push();
    layer.open = true;
    history.userBack();

    history.userForward();
    history.flush();

    expect(history.index).toBe(0);
  });

  it('やめると、「戻る」を見張らない', () => {
    const { history, mark, layer } = setupLayer('drawer');
    const stop = mark.watch(layer);
    mark.push();
    layer.open = true;

    stop();
    history.userBack();

    expect(layer.open).toBe(true);
  });
});

describe('印の名前が違う 2 つの層（フォームとサイドメニュー）', () => {
  it('一方の履歴に「進む」で入ったとき、戻すのは、その印の層の 1 回だけ（他方は戻さない）', () => {
    const history = new FakeHistory();
    // 戻りすぎたら、ここを越えて、index が 1 より小さくなる。
    history.pushState({ inApp: true });
    const form = setupLayer('form', history);
    const sidebar = setupLayer('sidebar', history);
    form.mark.watch(form.layer);
    sidebar.mark.watch(sidebar.layer);
    sidebar.mark.push();
    sidebar.layer.open = true;
    history.userBack();

    history.userForward();
    history.flush();

    expect(history.index).toBe(1);
  });

  it('起動時に、フォームの印の履歴の上にいても、サイドメニューは戻さない（フォームだけが戻す）', () => {
    const history = new FakeHistory();
    history.pushState({ inApp: true });
    history.pushState({ inApp: true, form: true });
    const form = setupLayer('form', history);
    const sidebar = setupLayer('sidebar', history);

    sidebar.mark.watch(sidebar.layer);
    history.flush();
    expect(history.index).toBe(2);

    form.mark.watch(form.layer);
    history.flush();
    expect(history.index).toBe(1);
  });
});
