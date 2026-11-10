import { describe, expect, it } from 'vitest';
import { makeEntry } from '../../test/helpers/entries';
import { isSameException, isStale } from './conflict';

describe('SY-3: 編集時刻の比較（isStale）', () => {
  const current = new Map([['a', { editedAt: 1000 }]]);

  it('今の行の方が新しければ、古い', () => {
    expect(isStale({ id: 'a', editedAt: 999 }, current)).toBe(true);
  });

  it('編集時刻が同じでも、古い（同じ依頼の 2 回目を、反映済みとして捨てるため）', () => {
    expect(isStale({ id: 'a', editedAt: 1000 }, current)).toBe(true);
  });

  it('書く行の方が新しければ、古くない', () => {
    expect(isStale({ id: 'a', editedAt: 1001 }, current)).toBe(false);
  });

  it('同じ id の行がまだなければ、古くない', () => {
    expect(isStale({ id: 'b', editedAt: 1 }, current)).toBe(false);
  });
});

describe('同じ回の例外の行か（isSameException）', () => {
  const exception = makeEntry({ id: 'x', seriesId: 's', originalDate: '2026-10-19' });

  it('系列と回の日付が同じ例外の行は、同じ回', () => {
    expect(isSameException(exception, { ...exception, title: '変更後' })).toBe(true);
  });

  it('回の日付が違えば、別の回', () => {
    expect(isSameException(exception, { ...exception, originalDate: '2026-10-20' })).toBe(false);
  });

  it('系列が違えば、別の回', () => {
    expect(isSameException(exception, { ...exception, seriesId: 't' })).toBe(false);
  });

  it('保存されている行が例外の行でなければ（系列の行・繰り返さない予定）、同じ回ではない', () => {
    const single = makeEntry({ id: 'x' });
    expect(isSameException(single, single)).toBe(false);
  });
});
