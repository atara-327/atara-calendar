import { describe, expect, it } from 'vitest';
import { makeEntry } from '../../test/helpers/entries';
import { occurrencesInPeriod } from './period';

const live = new Set(['w1']);

function dates(occurrences: readonly { entryId: string; occurrenceDate: string }[]): string[][] {
  return occurrences.map(({ entryId, occurrenceDate }) => [entryId, occurrenceDate]);
}

describe('期間の回の一覧', () => {
  it('期間にかかる回を、繰り返しを展開して、日付順に返す', () => {
    const entries = [
      makeEntry({ id: 'daily', rrule: { freq: 'daily' }, startDate: '2026-10-19' }),
      makeEntry({ id: 'single', startDate: '2026-10-20' }),
    ];

    const result = occurrencesInPeriod(entries, live, '2026-10-19', '2026-10-21');

    expect(dates(result)).toEqual([
      ['daily', '2026-10-19'],
      ['daily', '2026-10-20'],
      ['single', '2026-10-20'],
      ['daily', '2026-10-21'],
    ]);
  });

  it('from が to より後なら、空を返す', () => {
    const entries = [makeEntry({ id: 'single', startDate: '2026-10-20' })];

    expect(occurrencesInPeriod(entries, live, '2026-10-21', '2026-10-19')).toEqual([]);
  });

  describe('削除済みのワークスペースの予定は出さない', () => {
    it('削除済みのワークスペースを指す、削除されていない予定は出ない', () => {
      const entries = [
        makeEntry({ id: 'live', workspaceId: 'w1', startDate: '2026-10-20' }),
        makeEntry({ id: 'orphan', workspaceId: 'w2', startDate: '2026-10-20' }),
      ];

      const result = occurrencesInPeriod(entries, live, '2026-10-20', '2026-10-20');

      expect(dates(result)).toEqual([['live', '2026-10-20']]);
    });

    it('削除済みのワークスペースを指す系列の回は、すべて出ない', () => {
      const entries = [
        makeEntry({ id: 'daily', workspaceId: 'w2', rrule: { freq: 'daily' } }),
        makeEntry({ id: 'single', workspaceId: 'w1', startDate: '2026-10-20' }),
      ];

      const result = occurrencesInPeriod(entries, live, '2026-10-19', '2026-10-21');

      expect(dates(result)).toEqual([['single', '2026-10-20']]);
    });

    it('タイムブロック（ワークスペースを持たない）は、出す', () => {
      const entries = [
        makeEntry({ id: 'block', kind: 'block', workspaceId: null, startDate: '2026-10-20' }),
      ];

      const result = occurrencesInPeriod(entries, new Set(), '2026-10-20', '2026-10-20');

      expect(dates(result)).toEqual([['block', '2026-10-20']]);
    });

    it('削除済みのワークスペースを指す例外の行が抑えていた、元の回（10-20）を、系列の回として出さない', () => {
      // 10-20 の回を、削除済みの w2 の 10-25 に移した例外。系列の側の 10-20 は、例外が抑えている。
      const entries = [
        makeEntry({
          id: 'daily',
          workspaceId: 'w1',
          rrule: { freq: 'daily' },
          startDate: '2026-10-19',
        }),
        makeEntry({
          id: 'moved',
          workspaceId: 'w2',
          seriesId: 'daily',
          originalDate: '2026-10-20',
          startDate: '2026-10-25',
        }),
      ];

      const result = occurrencesInPeriod(entries, live, '2026-10-19', '2026-10-25');

      expect(result.map(({ occurrenceDate }) => occurrenceDate)).toEqual([
        '2026-10-19',
        '2026-10-21',
        '2026-10-22',
        '2026-10-23',
        '2026-10-24',
        '2026-10-25',
      ]);
    });
  });
});
