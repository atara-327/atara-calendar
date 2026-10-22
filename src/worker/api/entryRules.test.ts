import { describe, expect, it } from 'vitest';
import { makeEntry } from '../../../test/helpers/entries';
import { ApiError } from './errors';
import { assertWritableEntries } from './entryRules';

const timed = { allDay: false, startTime: '15:00', endTime: '16:00' } as const;

describe('assertWritableEntries: 書く行の確認', () => {
  it('守られている行は通る', () => {
    expect(() => {
      assertWritableEntries([makeEntry({ id: 'a' }), makeEntry({ id: 'b', ...timed })]);
    }).not.toThrow();
  });

  it('守られていない行が 1 つでもあれば、400 の ApiError', () => {
    const rows = [makeEntry({ id: 'a' }), makeEntry({ id: 'b', startTime: '15:00' })];

    expect(() => {
      assertWritableEntries(rows);
    }).toThrow(ApiError);
  });

  it('削除する行（deletedAt がある行）は確かめない。決まりが厳しくなる前の行も、削除できるように', () => {
    const rows = [makeEntry({ id: 'a', startTime: '15:00', editedAt: 2000, deletedAt: 2000 })];

    expect(() => {
      assertWritableEntries(rows);
    }).not.toThrow();
  });

  it('削除する行は、日付の年が範囲外でも確かめない', () => {
    const rows = [makeEntry({ id: 'a', startDate: '1850-06-01', editedAt: 2000, deletedAt: 2000 })];

    expect(() => {
      assertWritableEntries(rows);
    }).not.toThrow();
  });

  it('同じ id の行が 2 つあれば、400 の ApiError（applyWrite の Error を、500 にしないため）', () => {
    const rows = [makeEntry({ id: 'a' }), makeEntry({ id: 'a', editedAt: 2000, deletedAt: 2000 })];

    expect(() => {
      assertWritableEntries(rows);
    }).toThrow(ApiError);
  });
});
