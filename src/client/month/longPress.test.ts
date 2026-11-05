import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { LONG_PRESS_MOVE_LIMIT, LONG_PRESS_MS, createLongPressTracker } from './longPress';

const FINGER = 1;

describe('日のマスの長押し（MV-11）', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  function setup() {
    const onLongPress = vi.fn();
    return { tracker: createLongPressTracker(onLongPress), onLongPress };
  }

  it('0.5 秒押し続けたら、長押しになる', () => {
    const { tracker, onLongPress } = setup();

    tracker.start(100, 100, FINGER, true);
    vi.advanceTimersByTime(LONG_PRESS_MS - 1);
    expect(onLongPress).not.toHaveBeenCalled();
    vi.advanceTimersByTime(1);

    expect(onLongPress).toHaveBeenCalledTimes(1);
  });

  it('0.5 秒より前に離したら、長押しにならず、click も捨てない', () => {
    const { tracker, onLongPress } = setup();

    tracker.start(100, 100, FINGER, true);
    vi.advanceTimersByTime(LONG_PRESS_MS - 1);
    tracker.stop(FINGER);
    vi.advanceTimersByTime(1000);

    expect(onLongPress).not.toHaveBeenCalled();
    expect(tracker.consumeClick(1)).toBe(false);
  });

  it('10px 未満の動きなら、長押しは続く', () => {
    const { tracker, onLongPress } = setup();

    tracker.start(100, 100, FINGER, true);
    tracker.move(100 + LONG_PRESS_MOVE_LIMIT - 1, 100, FINGER);
    vi.advanceTimersByTime(LONG_PRESS_MS);

    expect(onLongPress).toHaveBeenCalledTimes(1);
  });

  it('10px 以上動いたら、長押しをやめる（スクロールと取り合わない）', () => {
    const { tracker, onLongPress } = setup();

    tracker.start(100, 100, FINGER, true);
    tracker.move(100, 100 + LONG_PRESS_MOVE_LIMIT, FINGER);
    vi.advanceTimersByTime(LONG_PRESS_MS * 2);

    expect(onLongPress).not.toHaveBeenCalled();
  });

  it('取り消された（pointercancel）ら、長押しをやめる', () => {
    const { tracker, onLongPress } = setup();

    tracker.start(100, 100, FINGER, true);
    tracker.stop(FINGER);
    vi.advanceTimersByTime(LONG_PRESS_MS * 2);

    expect(onLongPress).not.toHaveBeenCalled();
  });

  it('2 本目の指が触れたら、長押しにしない', () => {
    const { tracker, onLongPress } = setup();

    tracker.start(100, 100, FINGER, true);
    tracker.start(150, 100, 2, false);
    vi.advanceTimersByTime(LONG_PRESS_MS * 2);

    expect(onLongPress).not.toHaveBeenCalled();
  });

  it('長押しのあとの click は捨てる。1 回だけ', () => {
    const { tracker } = setup();

    tracker.start(100, 100, FINGER, true);
    vi.advanceTimersByTime(LONG_PRESS_MS);
    tracker.stop(FINGER);

    expect(tracker.consumeClick(1)).toBe(true);
    expect(tracker.consumeClick(1)).toBe(false);
  });

  it('長押しのあとでも、キーボードの click（detail が 0）は捨てない', () => {
    const { tracker } = setup();

    tracker.start(100, 100, FINGER, true);
    vi.advanceTimersByTime(LONG_PRESS_MS);

    expect(tracker.consumeClick(0)).toBe(false);
  });

  it('次に押し始めたら、前の長押しの印は消える', () => {
    const { tracker } = setup();

    tracker.start(100, 100, FINGER, true);
    vi.advanceTimersByTime(LONG_PRESS_MS);
    tracker.start(100, 100, FINGER, true);

    expect(tracker.consumeClick(1)).toBe(false);
  });
});
