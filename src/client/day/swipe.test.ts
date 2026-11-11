import { describe, expect, it } from 'vitest';
import {
  SWIPE_DISTANCE,
  SWIPE_FLING_VELOCITY,
  createSwipeTracker,
  followOffset,
  isClickAfterSwipe,
  releaseDirection,
} from './swipe';

// 指の識別（pointerId）。最初の指は isPrimary で、2 本目の指は、isPrimary ではない。
const FINGER = 1;
const SECOND_FINGER = 2;

describe('左右のスワイプ（DV-5）', () => {
  it('横に 60px 以上、左へ動かして離したら、左（次の日へ）', () => {
    const tracker = createSwipeTracker();

    tracker.start(300, 400, FINGER, true, 0);
    tracker.move(280, 402, FINGER, 0);
    tracker.move(200, 405, FINGER, 0);

    expect(tracker.end(200, FINGER, 0)).toBe('left');
  });

  it('右へ動かして離したら、右（前の日へ）', () => {
    const tracker = createSwipeTracker();

    tracker.start(100, 400, FINGER, true, 0);
    tracker.move(120, 398, FINGER, 0);

    expect(tracker.end(100 + SWIPE_DISTANCE, FINGER, 0)).toBe('right');
  });

  it('動きが 60px に届かなければ、スワイプではない', () => {
    const tracker = createSwipeTracker();

    tracker.start(300, 400, FINGER, true, 0);
    tracker.move(260, 400, FINGER, 0);

    expect(tracker.end(300 - SWIPE_DISTANCE + 1, FINGER, 0)).toBeNull();
  });

  it('動き始めが縦なら、あとから横に 60px 以上動いても、スワイプではない（縦のスクロール）', () => {
    const tracker = createSwipeTracker();

    tracker.start(300, 400, FINGER, true, 0);
    tracker.move(302, 430, FINGER, 0);
    tracker.move(200, 440, FINGER, 0);

    expect(tracker.end(200, FINGER, 0)).toBeNull();
  });

  it('動き始めが横なら、あとから縦に動いても、横に 60px 以上動いていれば、スワイプ', () => {
    const tracker = createSwipeTracker();

    tracker.start(300, 400, FINGER, true, 0);
    tracker.move(280, 395, FINGER, 0);
    tracker.move(220, 460, FINGER, 0);

    expect(tracker.end(220, FINGER, 0)).toBe('left');
  });

  it('動き始めの、横と縦が同じ大きさなら、縦（スクロールを優先する）', () => {
    const tracker = createSwipeTracker();

    tracker.start(300, 400, FINGER, true, 0);
    tracker.move(280, 420, FINGER, 0);

    expect(tracker.end(200, FINGER, 0)).toBeNull();
  });

  it('動き始めの向きは、指の、ほんの揺れでは決めない（8px 未満は見送る）', () => {
    const tracker = createSwipeTracker();

    tracker.start(300, 400, FINGER, true, 0);
    // 縦に 6px だけ揺れた。向きは決めない。
    tracker.move(300, 406, FINGER, 0);
    tracker.move(250, 408, FINGER, 0);

    expect(tracker.end(200, FINGER, 0)).toBe('left');
  });

  it('動かさずに離したら（タップ）、スワイプではない', () => {
    const tracker = createSwipeTracker();

    tracker.start(300, 400, FINGER, true, 0);

    expect(tracker.end(300, FINGER, 0)).toBeNull();
  });

  it('取り消されたら（ブラウザが縦のスクロールを始めた）、そのあとに離しても、スワイプではない', () => {
    const tracker = createSwipeTracker();
    tracker.start(300, 400, FINGER, true, 0);
    tracker.move(280, 398, FINGER, 0);

    tracker.cancel(FINGER);

    expect(tracker.end(200, FINGER, 0)).toBeNull();
  });

  it('1 回の動きが終わったら、次の動きは、最初からやり直す', () => {
    const tracker = createSwipeTracker();
    tracker.start(300, 400, FINGER, true, 0);
    tracker.move(200, 400, FINGER, 0);
    expect(tracker.end(200, FINGER, 0)).toBe('left');

    tracker.start(100, 400, FINGER, true, 0);
    tracker.move(100, 450, FINGER, 0);

    expect(tracker.end(250, FINGER, 0)).toBeNull();
  });

  it('指を置かずに離しても、何も起きない', () => {
    expect(createSwipeTracker().end(100, FINGER, 0)).toBeNull();
  });
});

describe('2 本目の指（拡大などの 2 本指の操作と、スワイプを取り違えない）', () => {
  it('最初の指を置いたあと、2 本目の指が触れたら、最初の指が、横に 60px 以上動いても、スワイプではない', () => {
    const tracker = createSwipeTracker();
    tracker.start(300, 400, FINGER, true, 0);
    tracker.start(100, 420, SECOND_FINGER, false, 0);

    tracker.move(200, 402, FINGER, 0);

    expect(tracker.end(200, FINGER, 0)).toBeNull();
  });

  it('2 本目の指が触れたら、最初の指が、ほとんど動いていなくても、2 本目の位置を起点にして、日が動かない', () => {
    // 2 本目の指の位置（100）を、起点に上書きすると、最初の指（300）との距離が、60px を超えて、スワイプになってしまう。
    const tracker = createSwipeTracker();
    tracker.start(300, 400, FINGER, true, 0);
    tracker.start(100, 400, SECOND_FINGER, false, 0);

    tracker.move(302, 401, FINGER, 0);

    expect(tracker.end(302, FINGER, 0)).toBeNull();
  });

  it('2 本目の指の動きと、離れたことも、スワイプにしない', () => {
    const tracker = createSwipeTracker();
    tracker.start(300, 400, FINGER, true, 0);
    tracker.start(300, 420, SECOND_FINGER, false, 0);

    tracker.move(150, 420, SECOND_FINGER, 0);

    expect(tracker.end(150, SECOND_FINGER, 0)).toBeNull();
    expect(tracker.end(300, FINGER, 0)).toBeNull();
  });

  it('追跡している指ではない指の、動き・離れた・取り消しは、無視する（最初の指の動きを、乱さない）', () => {
    const tracker = createSwipeTracker();
    tracker.start(300, 400, FINGER, true, 0);

    tracker.move(100, 600, SECOND_FINGER, 0);
    tracker.cancel(SECOND_FINGER);
    expect(tracker.end(100, SECOND_FINGER, 0)).toBeNull();
    tracker.move(200, 402, FINGER, 0);

    expect(tracker.end(200, FINGER, 0)).toBe('left');
  });

  it('2 本の指がすべて離れたあとの、次の指は、最初からやり直す', () => {
    const tracker = createSwipeTracker();
    tracker.start(300, 400, FINGER, true, 0);
    tracker.start(100, 400, SECOND_FINGER, false, 0);
    tracker.end(300, FINGER, 0);
    tracker.end(100, SECOND_FINGER, 0);

    tracker.start(300, 400, 3, true, 0);
    tracker.move(200, 402, 3, 0);

    expect(tracker.end(200, 3, 0)).toBe('left');
  });
});

describe('スワイプの直後の click', () => {
  it('スワイプのあとに、指（やマウス）の click が来たら、捨てる（空いているところのタップにしない）', () => {
    expect(isClickAfterSwipe(true, 1)).toBe(true);
  });

  it('キーボード（Enter・Space）から来た click（detail が 0）は、スワイプの直後でも、捨てない', () => {
    expect(isClickAfterSwipe(true, 0)).toBe(false);
  });

  it('スワイプしていないときの click は、捨てない', () => {
    expect(isClickAfterSwipe(false, 1)).toBe(false);
    expect(isClickAfterSwipe(false, 0)).toBe(false);
  });
});

describe('左右のスワイプの、指についてくる動き（DV-5）', () => {
  it('横の動きと決まったあとは、move が起点からの横の動き（px）を返す', () => {
    const tracker = createSwipeTracker();

    tracker.start(300, 400, FINGER, true, 0);

    expect(tracker.move(304, 400, FINGER, 10)).toBeNull();
    expect(tracker.move(270, 402, FINGER, 20)).toBe(-30);
    expect(tracker.move(250, 480, FINGER, 30)).toBe(-50);
  });

  it('縦の動きと決まったときは、move は null を返す（指についてこない）', () => {
    const tracker = createSwipeTracker();

    tracker.start(300, 400, FINGER, true, 0);

    expect(tracker.move(302, 430, FINGER, 10)).toBeNull();
    expect(tracker.move(200, 440, FINGER, 20)).toBeNull();
  });

  it('60px に届かなくても、速くはじいたら、はじいた向きに切り替わる', () => {
    const tracker = createSwipeTracker();

    tracker.start(300, 400, FINGER, true, 0);
    tracker.move(280, 400, FINGER, 20);

    expect(tracker.end(260, FINGER, 40)).toBe('left');
  });

  it('60px に届かず、はじく速さにも届かなければ、元に戻る（null）', () => {
    const tracker = createSwipeTracker();

    tracker.start(300, 400, FINGER, true, 0);
    tracker.move(280, 400, FINGER, 200);

    expect(tracker.end(260, FINGER, 400)).toBeNull();
  });

  it('ゆっくり動かして、最後に止めた指は、はじきにしない', () => {
    const tracker = createSwipeTracker();

    tracker.start(300, 400, FINGER, true, 0);
    tracker.move(280, 400, FINGER, 20);
    tracker.move(250, 400, FINGER, 100);
    tracker.move(250, 400, FINGER, 400);

    expect(tracker.end(250, FINGER, 500)).toBeNull();
  });

  it('60px 以上動かした向きに、速さが 0 でも切り替わる', () => {
    expect(releaseDirection(-SWIPE_DISTANCE, 0)).toBe('left');
    expect(releaseDirection(SWIPE_DISTANCE, 0)).toBe('right');
    expect(releaseDirection(SWIPE_DISTANCE - 1, 0)).toBeNull();
  });

  it('はじく速さ以上なら、動いた距離が短くても、はじいた向きに切り替わる', () => {
    expect(releaseDirection(10, SWIPE_FLING_VELOCITY)).toBe('right');
    expect(releaseDirection(-10, -SWIPE_FLING_VELOCITY)).toBe('left');
    expect(releaseDirection(-10, -SWIPE_FLING_VELOCITY + 0.01)).toBeNull();
  });

  it('隣の日がある向きは指のとおりに動き、範囲の外の向きは小さく動く', () => {
    expect(followOffset(100, true, true)).toBe(100);
    expect(followOffset(-100, true, true)).toBe(-100);
    expect(followOffset(100, false, true)).toBeLessThan(100);
    expect(followOffset(-100, true, false)).toBeGreaterThan(-100);
    expect(followOffset(100, true, false)).toBe(100);
  });
});
