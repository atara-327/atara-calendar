import { describe, expect, it } from 'vitest';
import { ManualClock } from '../../../test/helpers/device';
import { DELETE_UNDO_MS } from '../sync/engine';
import { FAILED_NOTICE_MS, createUndoNotices } from './undoNotices';

function setup(undoResult = true) {
  const clock = new ManualClock(0);
  const undone: string[] = [];
  const notices = createUndoNotices({
    undo: (requestId) => {
      undone.push(requestId);
      return undoResult;
    },
    setTimeout: clock.setTimeout,
    clearTimeout: clock.clearTimeout,
  });
  const list = () => notices.store.getState().notices;
  return { clock, notices, undone, list };
}

describe('OT-1: 削除したあとの「元に戻す」', () => {
  it('削除したことを知らせると、元に戻せる知らせが出る', () => {
    const { notices, list } = setup();

    notices.show('req-1');

    expect(list()).toEqual([{ id: 1, requestId: 'req-1', status: 'waiting' }]);
  });

  it('DELETE_UNDO_MS（5 秒）たつと、消える（その間だけ、サーバーに送らずに待つため）', () => {
    const { clock, notices, list } = setup();
    notices.show('req-1');

    clock.advance(DELETE_UNDO_MS - 1);
    expect(list()).toHaveLength(1);

    clock.advance(1);
    expect(list()).toEqual([]);
  });

  it('元に戻すを押すと、その削除を取り消して（engine.undo）、知らせが消える', () => {
    const { notices, undone, list } = setup(true);
    notices.show('req-1');

    notices.undo(1);

    expect(undone).toEqual(['req-1']);
    expect(list()).toEqual([]);
  });

  it('取り消したあとは、時間がたっても、何も起きない（消えた知らせのタイマーが残らない）', () => {
    const { clock, notices, list } = setup();
    notices.show('req-1');
    notices.undo(1);

    clock.advance(DELETE_UNDO_MS);

    expect(list()).toEqual([]);
    expect(clock.pendingTimerCount).toBe(0);
  });

  it('もう送り始めていて、取り消せなかったら、その旨の知らせに変わり、少しして消える', () => {
    const { clock, notices, list } = setup(false);
    notices.show('req-1');

    notices.undo(1);

    expect(list()).toEqual([{ id: 1, requestId: 'req-1', status: 'failed' }]);
    clock.advance(FAILED_NOTICE_MS);
    expect(list()).toEqual([]);
  });

  it('取り消せなかった知らせは、もう一度押しても、取り消しをやり直さない', () => {
    const { notices, undone } = setup(false);
    notices.show('req-1');

    notices.undo(1);
    notices.undo(1);

    expect(undone).toEqual(['req-1']);
  });

  it('続けて削除したら、知らせを並べる（前の削除も、元に戻せる）', () => {
    const { notices, undone, list } = setup();
    notices.show('req-1');
    notices.show('req-2');

    expect(list().map(({ requestId }) => requestId)).toEqual(['req-1', 'req-2']);
    notices.undo(1);
    expect(undone).toEqual(['req-1']);
    expect(list().map(({ requestId }) => requestId)).toEqual(['req-2']);
  });

  it('知らせごとに、5 秒を数える（あとの削除の知らせは、前の知らせが消えたあとも残る）', () => {
    const { clock, notices, list } = setup();
    notices.show('req-1');
    clock.advance(3000);
    notices.show('req-2');

    clock.advance(DELETE_UNDO_MS - 3000);
    expect(list().map(({ requestId }) => requestId)).toEqual(['req-2']);

    clock.advance(3000);
    expect(list()).toEqual([]);
  });

  it('存在しない知らせの取り消しは、何もしない', () => {
    const { notices, undone } = setup();

    notices.undo(99);

    expect(undone).toEqual([]);
  });
});
