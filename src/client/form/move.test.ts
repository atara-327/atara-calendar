import { describe, expect, it } from 'vitest';
import { makeEntry } from '../../../test/helpers/entries';
import { expandOccurrences } from '../../shared/recurrence';
import type { Entry } from '../../shared/schema';
import { planMove } from './move';

function occurrenceOf(row: Entry) {
  const found = expandOccurrences([row], row.startDate, row.startDate)[0];
  if (found === undefined) throw new Error('回がありません');
  return found;
}

const changes = { startTime: '10:15', endTime: '11:15' };

describe('ドラッグで時刻を移したあとの保存（EV-6）', () => {
  it('EV-6: 繰り返さない予定は、範囲を聞かずに保存する', () => {
    const row = makeEntry({ id: 'e1', allDay: false, startTime: '10:00', endTime: '11:00' });

    expect(planMove({ rows: [row], occurrence: occurrenceOf(row), changes })).toEqual({
      kind: 'save',
    });
  });

  it('EV-6: 繰り返す予定は、フォームと同じ範囲（この予定のみ・これ以降すべて・すべて）を聞く', () => {
    const row = makeEntry({
      id: 's1',
      allDay: false,
      startTime: '10:00',
      endTime: '11:00',
      rrule: { freq: 'daily' },
    });

    expect(planMove({ rows: [row], occurrence: occurrenceOf(row), changes })).toEqual({
      kind: 'ask',
      scopes: ['this', 'following', 'all'],
    });
  });

  it('EV-6: 予定がもうないときは、保存せず、理由を返す', () => {
    const row = makeEntry({ id: 'e1', allDay: false, startTime: '10:00', endTime: '11:00' });
    const plan = planMove({ rows: [], occurrence: occurrenceOf(row), changes });

    expect(plan.kind).toBe('reject');
  });
});
