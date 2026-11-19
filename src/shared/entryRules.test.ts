import { describe, expect, it } from 'vitest';
import { makeEntry } from '../../test/helpers/entries';
import { changesAffectLength, entryProblem, recurringLengthProblem } from './entryRules';

const timed = { allDay: false, startTime: '15:00', endTime: '16:00' } as const;
const daily = { rrule: { freq: 'daily' } } as const;

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
    {
      name: '繰り返しの終わりの日（untilDate）が開始日と同じ（その日の 1 回が残る）',
      overrides: { ...daily, untilDate: '2026-10-19' },
    },
    {
      name: '繰り返しの終わりの日（untilDate）が開始日より後',
      overrides: { ...daily, untilDate: '2026-10-23' },
    },
    { name: '繰り返しの終わりの日（untilDate）がない', overrides: { ...daily, untilDate: null } },
    {
      name: '繰り返さない行の untilDate は、開始日より前でも見ない',
      overrides: { rrule: null, untilDate: '2026-10-18' },
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
    {
      name: '繰り返しの終わりの日（untilDate）が開始日より前',
      overrides: { ...daily, untilDate: '2026-10-18' },
    },
  ] as const)('$name は守られていない', ({ overrides }) => {
    expect(entryProblem(makeEntry({ id: 'e', ...overrides }))).toEqual(expect.any(String));
  });
});

describe('recurringLengthProblem: 繰り返す予定の 1 回の長さは 31 日まで', () => {
  it.each([
    { name: '終日で、ちょうど 31 日（両端を含む）', overrides: { endDate: '2026-11-18' } },
    { name: '終日で、1 日', overrides: {} },
    {
      name: '時間指定で、ちょうど 31 × 24 時間',
      overrides: { ...timed, endDate: '2026-11-19', startTime: '15:00', endTime: '15:00' },
    },
    {
      name: '繰り返さない予定は、40 日でも見ない',
      overrides: { rrule: null, endDate: '2026-11-27' },
    },
    {
      name: '繰り返さない時間指定は、長くても見ない',
      overrides: { ...timed, rrule: null, endDate: '2026-12-31', endTime: '16:00' },
    },
  ])('$name は通る', ({ overrides }) => {
    const entry = makeEntry({ id: 'e', ...daily, ...overrides });
    expect(recurringLengthProblem(entry)).toBeNull();
  });

  it.each([
    { name: '終日で、32 日', overrides: { endDate: '2026-11-19' } },
    {
      name: '時間指定で、31 × 24 時間を 1 分超える',
      overrides: { ...timed, endDate: '2026-11-19', startTime: '15:00', endTime: '15:01' },
    },
  ])('$name は断る', ({ overrides }) => {
    const entry = makeEntry({ id: 'e', ...daily, ...overrides });
    expect(recurringLengthProblem(entry)).toBe('繰り返す予定は、1 回 31 日までです');
  });
});

describe('changesAffectLength', () => {
  it.each(['allDay', 'startDate', 'startTime', 'endDate', 'endTime', 'rrule'] as const)(
    '%s を変える変更は、長さに関わる',
    (key) => {
      expect(changesAffectLength({ [key]: null })).toBe(true);
    },
  );

  it('題名だけの変更は、長さに関わらない', () => {
    expect(changesAffectLength({})).toBe(false);
  });
});
