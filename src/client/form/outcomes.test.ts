import { describe, expect, it } from 'vitest';
import { makeEntry } from '../../../test/helpers/entries';
import { expandOccurrences } from '../../shared/recurrence';
import { outcomesOf } from './outcomes';

// 2026-10-19 は月曜。毎週（月）の系列の最初の回を、火曜へ 1 日ずらす。
const rows = [
  makeEntry({
    id: 's1',
    title: '毎週',
    allDay: false,
    startTime: '09:00',
    endTime: '10:00',
    rrule: { freq: 'weekly', days: [1] },
    startDate: '2026-10-19',
  }),
];
const occurrence = (() => {
  const found = expandOccurrences(rows, '2026-10-19', '2026-10-25')[0];
  if (found === undefined) throw new Error('回がありません');
  return found;
})();

describe('範囲ごとの、保存したあとの系列の説明', () => {
  it('EV-6: 毎週（月）の回を 1 日ずらすと、「すべて」「これ以降すべて」は、毎週 火。「この予定のみ」は出さない', () => {
    expect(
      outcomesOf({
        rows,
        occurrence,
        changes: { startDate: '2026-10-20', endDate: '2026-10-20' },
        scopes: ['this', 'following', 'all'],
        shownStartDate: '2026-10-20',
      }),
    ).toEqual({ following: '毎週 火', all: '毎週 火' });
  });

  it('開始日もルールも変えない変更（題名だけ）は、何も出さない', () => {
    expect(
      outcomesOf({
        rows,
        occurrence,
        changes: { title: '変更' },
        scopes: ['this', 'following', 'all'],
        shownStartDate: '2026-10-19',
      }),
    ).toEqual({});
  });
});
