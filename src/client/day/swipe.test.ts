import { describe, expect, it } from 'vitest';
import { SWIPE_DISTANCE, createSwipeTracker } from './swipe';

describe('左右のスワイプ（DV-5）', () => {
  it('横に 60px 以上、左へ動かして離したら、左（次の日へ）', () => {
    const tracker = createSwipeTracker();

    tracker.start(300, 400);
    tracker.move(280, 402);
    tracker.move(200, 405);

    expect(tracker.end(200)).toBe('left');
  });

  it('右へ動かして離したら、右（前の日へ）', () => {
    const tracker = createSwipeTracker();

    tracker.start(100, 400);
    tracker.move(120, 398);

    expect(tracker.end(100 + SWIPE_DISTANCE)).toBe('right');
  });

  it('動きが 60px に届かなければ、スワイプではない', () => {
    const tracker = createSwipeTracker();

    tracker.start(300, 400);
    tracker.move(260, 400);

    expect(tracker.end(300 - SWIPE_DISTANCE + 1)).toBeNull();
  });

  it('動き始めが縦なら、あとから横に 60px 以上動いても、スワイプではない（縦のスクロール）', () => {
    const tracker = createSwipeTracker();

    tracker.start(300, 400);
    tracker.move(302, 430);
    tracker.move(200, 440);

    expect(tracker.end(200)).toBeNull();
  });

  it('動き始めが横なら、あとから縦に動いても、横に 60px 以上動いていれば、スワイプ', () => {
    const tracker = createSwipeTracker();

    tracker.start(300, 400);
    tracker.move(280, 395);
    tracker.move(220, 460);

    expect(tracker.end(220)).toBe('left');
  });

  it('動き始めの、横と縦が同じ大きさなら、縦（スクロールを優先する）', () => {
    const tracker = createSwipeTracker();

    tracker.start(300, 400);
    tracker.move(280, 420);

    expect(tracker.end(200)).toBeNull();
  });

  it('動き始めの向きは、指の、ほんの揺れでは決めない（8px 未満は見送る）', () => {
    const tracker = createSwipeTracker();

    tracker.start(300, 400);
    // 縦に 6px だけ揺れた。向きは決めない。
    tracker.move(300, 406);
    tracker.move(250, 408);

    expect(tracker.end(200)).toBe('left');
  });

  it('動かさずに離したら（タップ）、スワイプではない', () => {
    const tracker = createSwipeTracker();

    tracker.start(300, 400);

    expect(tracker.end(300)).toBeNull();
  });

  it('取り消されたら（ブラウザが縦のスクロールを始めた）、そのあとに離しても、スワイプではない', () => {
    const tracker = createSwipeTracker();
    tracker.start(300, 400);
    tracker.move(280, 398);

    tracker.cancel();

    expect(tracker.end(200)).toBeNull();
  });

  it('1 回の動きが終わったら、次の動きは、最初からやり直す', () => {
    const tracker = createSwipeTracker();
    tracker.start(300, 400);
    tracker.move(200, 400);
    expect(tracker.end(200)).toBe('left');

    tracker.start(100, 400);
    tracker.move(100, 450);

    expect(tracker.end(250)).toBeNull();
  });

  it('指を置かずに離しても、何も起きない', () => {
    expect(createSwipeTracker().end(100)).toBeNull();
  });
});
