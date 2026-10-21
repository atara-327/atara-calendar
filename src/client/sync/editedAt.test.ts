import { describe, expect, it } from 'vitest';
import { createEditedAtClock } from './editedAt';

describe('editedAt の時計（Q1）', () => {
  it('時計が進んでいるときは、今の時刻（ms）を返す', () => {
    let now = 1000;
    const clock = createEditedAtClock({ now: () => now });
    expect(clock.next()).toBe(1000);
    now = 1500;
    expect(clock.next()).toBe(1500);
  });

  it('同じミリ秒に 2 回決めても、2 回目は 1 増える（サーバーが、同じ editedAt を 2 回目の送信として捨てるため）', () => {
    const clock = createEditedAtClock({ now: () => 1000 });
    expect([clock.next(), clock.next(), clock.next()]).toEqual([1000, 1001, 1002]);
  });

  it('時計が戻っても、前に決めた値より小さくならない', () => {
    let now = 5000;
    const clock = createEditedAtClock({ now: () => now });
    expect(clock.next()).toBe(5000);
    now = 3000;
    expect(clock.next()).toBe(5001);
    expect(clock.next()).toBe(5002);
  });

  it('時計が追いついたら、今の時刻に戻る', () => {
    let now = 5000;
    const clock = createEditedAtClock({ now: () => now });
    clock.next();
    clock.next();
    now = 5002;
    expect(clock.next()).toBe(5002);
    expect(clock.next()).toBe(5003);
    now = 6000;
    expect(clock.next()).toBe(6000);
  });

  it('初期値（保存してある送信待ちの最大値）より後の値から始める。時計が戻っていても', () => {
    const clock = createEditedAtClock({ now: () => 1000, initial: 9000 });
    expect(clock.next()).toBe(9001);
  });

  it('初期値が今より古ければ、今の時刻から始める', () => {
    const clock = createEditedAtClock({ now: () => 9000, initial: 1000 });
    expect(clock.next()).toBe(9000);
  });
});
