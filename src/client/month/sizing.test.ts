import { describe, expect, it } from 'vitest';
import {
  DATE_HEADER_HEIGHT,
  MIN_ROW_HEIGHT,
  SLOT_HEIGHT,
  VISIBLE_WEEKS,
  rowHeightFor,
  slotsFor,
} from './sizing';

describe('行の高さ', () => {
  it('画面の高さを、6 週間で割った高さにする', () => {
    expect(VISIBLE_WEEKS).toBe(6);
    expect(rowHeightFor(720)).toBe(120);
  });

  it('割り切れないときは、切り捨てた整数にする（全部の行が同じ高さで、半端な px にならない）', () => {
    expect(rowHeightFor(725)).toBe(120);
    expect(Number.isInteger(rowHeightFor(733))).toBe(true);
  });

  it('画面が低くても、行の高さの下限を下回らない', () => {
    expect(rowHeightFor(200)).toBe(MIN_ROW_HEIGHT);
  });

  it('画面が高くなれば、行も高くなる（画面の大きさが変わったら計算し直す）', () => {
    expect(rowHeightFor(1200)).toBeGreaterThan(rowHeightFor(600));
  });
});

describe('マスに入る予定の行数', () => {
  it('日付の行を除いた高さに、予定 1 行の高さで何行入るか', () => {
    expect(slotsFor(DATE_HEADER_HEIGHT + SLOT_HEIGHT * 4)).toBe(4);
    expect(slotsFor(DATE_HEADER_HEIGHT + SLOT_HEIGHT * 4 + SLOT_HEIGHT - 1)).toBe(4);
  });

  it('どれだけ低くても、1 行は入る', () => {
    expect(slotsFor(0)).toBe(1);
    expect(slotsFor(MIN_ROW_HEIGHT)).toBeGreaterThanOrEqual(1);
  });

  it('行が高くなれば、行数も増える', () => {
    expect(slotsFor(rowHeightFor(1000))).toBeGreaterThan(slotsFor(rowHeightFor(500)));
  });
});
