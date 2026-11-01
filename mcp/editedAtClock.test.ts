import { describe, expect, it } from 'vitest';
import { createEditedAtClock } from './editedAtClock';

describe('editedAt の時計（MC-2）', () => {
  it('今の時刻を返す', () => {
    const next = createEditedAtClock(() => 5000);
    expect(next()).toBe(5000);
  });

  it('同じミリ秒に何度呼んでも、前より 1 大きくなる', () => {
    const next = createEditedAtClock(() => 5000);
    expect([next(), next(), next()]).toEqual([5000, 5001, 5002]);
  });

  it('時計が戻っても、前の値より小さくならない', () => {
    let now = 5000;
    const next = createEditedAtClock(() => now);
    next();
    now = 4000;
    expect(next()).toBe(5001);
  });

  it('時計が十分進んでいれば、今の時刻に追いつく', () => {
    let now = 5000;
    const next = createEditedAtClock(() => now);
    next();
    next();
    now = 9000;
    expect(next()).toBe(9000);
  });
});
