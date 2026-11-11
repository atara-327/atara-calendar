import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { MOUSE_DRAG_THRESHOLD, createDragTracker } from './dragTracker';
import { LONG_PRESS_MOVE_LIMIT, LONG_PRESS_MS } from './month/longPress';

const FINGER = 1;

describe('ドラッグの判定（EV-6）: 始まり方', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  function setup() {
    const handlers = { onActivate: vi.fn(), onMove: vi.fn(), onAbort: vi.fn() };
    return { tracker: createDragTracker(handlers), ...handlers };
  }

  it('EV-6: スマホは、500ms 長押しすると、ドラッグが始まる', () => {
    const { tracker, onActivate } = setup();

    tracker.start(100, 100, FINGER, true, 'touch');
    vi.advanceTimersByTime(LONG_PRESS_MS - 1);
    expect(onActivate).not.toHaveBeenCalled();
    vi.advanceTimersByTime(1);

    expect(onActivate).toHaveBeenCalledTimes(1);
    expect(tracker.isDragging()).toBe(true);
  });

  it('EV-6: 長押しの前に 10px 以上動いたら（スクロール・スワイプ）、ドラッグにならない', () => {
    const { tracker, onActivate } = setup();

    tracker.start(100, 100, FINGER, true, 'touch');
    tracker.move(100, 100 + LONG_PRESS_MOVE_LIMIT, FINGER);
    vi.advanceTimersByTime(LONG_PRESS_MS);

    expect(onActivate).not.toHaveBeenCalled();
  });

  it('EV-6: 長押しの前に離したら、ドラッグにならず、click も捨てない', () => {
    const { tracker, onActivate } = setup();

    tracker.start(100, 100, FINGER, true, 'touch');
    vi.advanceTimersByTime(LONG_PRESS_MS - 1);
    expect(tracker.end(100, FINGER)).toBeNull();
    vi.advanceTimersByTime(LONG_PRESS_MS);

    expect(onActivate).not.toHaveBeenCalled();
    expect(tracker.consumeClick(1)).toBe(false);
  });

  it('EV-6: PC は、マウスで 4px 以上動くと、ドラッグが始まる。それより小さい動きは、クリック', () => {
    const { tracker, onActivate } = setup();

    tracker.start(100, 100, FINGER, true, 'mouse');
    tracker.move(100, 100 + MOUSE_DRAG_THRESHOLD - 1, FINGER);
    expect(onActivate).not.toHaveBeenCalled();
    tracker.move(100, 100 + MOUSE_DRAG_THRESHOLD, FINGER);

    expect(onActivate).toHaveBeenCalledTimes(1);
  });

  it('EV-6: 2 本目の指が触れたら、ドラッグにしない', () => {
    const { tracker, onActivate } = setup();

    tracker.start(100, 100, FINGER, true, 'touch');
    tracker.start(200, 100, 2, false, 'touch');
    vi.advanceTimersByTime(LONG_PRESS_MS);

    expect(onActivate).not.toHaveBeenCalled();
  });
});

describe('ドラッグの判定（EV-6）: 動かしている間と、離したとき', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  function dragging() {
    const handlers = { onActivate: vi.fn(), onMove: vi.fn(), onAbort: vi.fn() };
    const tracker = createDragTracker(handlers);
    tracker.start(100, 100, FINGER, true, 'touch');
    vi.advanceTimersByTime(LONG_PRESS_MS);
    return { tracker, ...handlers };
  }

  it('EV-6: 動かしている間は、置いた位置からの縦の距離を渡す。10px 以上動いても、やめない', () => {
    const { tracker, onMove } = dragging();

    tracker.move(100, 160, FINGER);

    expect(onMove).toHaveBeenCalledWith(60);
    expect(tracker.isDragging()).toBe(true);
  });

  it('EV-6: 離すと、離した位置の距離を返し、ドラッグが終わる', () => {
    const { tracker } = dragging();

    expect(tracker.end(145, FINGER)).toBe(45);
    expect(tracker.isDragging()).toBe(false);
  });

  it('EV-6: ブラウザが操作を取り上げたら（pointercancel）、取り消す', () => {
    const { tracker, onAbort } = dragging();

    tracker.cancel(FINGER);

    expect(onAbort).toHaveBeenCalledTimes(1);
    expect(tracker.isDragging()).toBe(false);
  });

  it('EV-6: ドラッグのあとの click は、1 回だけ捨てる', () => {
    const { tracker } = dragging();
    tracker.end(145, FINGER);

    expect(tracker.consumeClick(1)).toBe(true);
    expect(tracker.consumeClick(1)).toBe(false);
  });

  it('EV-6: キーボードの click（detail が 0）は、捨てない', () => {
    const { tracker } = dragging();
    tracker.end(145, FINGER);

    expect(tracker.consumeClick(0)).toBe(false);
  });

  it('EV-6: 普通のタップ（ドラッグなし）の click は、捨てない', () => {
    const tracker = createDragTracker({ onActivate: vi.fn(), onMove: vi.fn(), onAbort: vi.fn() });

    tracker.start(100, 100, FINGER, true, 'touch');
    tracker.end(100, FINGER);

    expect(tracker.consumeClick(1)).toBe(false);
  });
});
