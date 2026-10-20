import { describe, expect, it } from 'vitest';
import { makeEntry } from '../../../test/helpers/entries';
import { ApiError } from './errors';
import { assertWritableEntries, entryProblem } from './entryRules';

const timed = { allDay: false, startTime: '15:00', endTime: '16:00' } as const;

describe('entryProblem: 項目をまたぐ確認（設計書 4.2）', () => {
  it.each([
    { name: '時間指定の予定', overrides: timed },
    { name: '1 日だけの終日の予定（開始日と終了日が同じ）', overrides: {} },
    { name: '複数日の終日の予定', overrides: { endDate: '2026-10-21' } },
    {
      name: '日付をまたぐ時間指定（23:00〜翌 7:00）',
      overrides: { ...timed, startTime: '23:00', endDate: '2026-10-20', endTime: '07:00' },
    },
    {
      name: '終わりが翌日の 0:00',
      overrides: { ...timed, endDate: '2026-10-20', endTime: '00:00' },
    },
    { name: 'タイムブロック', overrides: { ...timed, kind: 'block', workspaceId: null } },
    {
      name: '年の範囲の下端（1900-01-01）',
      overrides: { startDate: '1900-01-01', endDate: '1900-01-01', untilDate: '1900-12-31' },
    },
    {
      name: '年の範囲の上端（2199-12-31）',
      overrides: { startDate: '2199-12-31', endDate: '2199-12-31', untilDate: '2199-12-31' },
    },
  ] as const)('$name は守られている', ({ overrides }) => {
    expect(entryProblem(makeEntry({ id: 'e', ...overrides }))).toBeNull();
  });

  it.each([
    { name: '終日なのに開始時刻がある', overrides: { startTime: '15:00' } },
    { name: '終日なのに終了時刻がある', overrides: { endTime: '16:00' } },
    { name: '時間指定なのに開始時刻がない', overrides: { ...timed, startTime: null } },
    { name: '時間指定なのに終了時刻がない', overrides: { ...timed, endTime: null } },
    { name: '終了が開始と同じ日時', overrides: { ...timed, endTime: '15:00' } },
    { name: '終了が開始より前（同じ日）', overrides: { ...timed, endTime: '14:45' } },
    {
      name: '終了が開始より前（日をまたいだ先が前の日）',
      overrides: { ...timed, endDate: '2026-10-18' },
    },
    { name: '終日で、終了日が開始日より前', overrides: { endDate: '2026-10-18' } },
    { name: 'タイムブロックが終日', overrides: { kind: 'block', workspaceId: null } },
    { name: 'タイムブロックがワークスペースを持つ', overrides: { ...timed, kind: 'block' } },
    { name: '予定がワークスペースを持たない', overrides: { ...timed, workspaceId: null } },
    {
      name: '開始日の年が 1900 より前',
      overrides: { startDate: '1899-12-31', endDate: '1900-01-01' },
    },
    {
      name: '終了日の年が 2199 より後',
      overrides: { startDate: '2199-12-31', endDate: '2200-01-01' },
    },
    { name: '終わりの日（untilDate）の年が 2199 より後', overrides: { untilDate: '2200-01-01' } },
    { name: '終わりの日（untilDate）の年が 1900 より前', overrides: { untilDate: '1899-12-31' } },
  ] as const)('$name は守られていない', ({ overrides }) => {
    expect(entryProblem(makeEntry({ id: 'e', ...overrides }))).toEqual(expect.any(String));
  });
});

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
