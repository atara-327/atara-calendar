import { describe, expect, it } from 'vitest';
import { makeOccurrence } from '../../../test/helpers/entries';
import { eventAccessibleName } from './eventLabel';
import type { MonthEvent } from './layout';

function event(overrides: Partial<MonthEvent>): MonthEvent {
  return {
    key: 'e1:2026-10-22',
    title: '歯医者',
    color: '#4FC3F7',
    allDay: false,
    startDate: '2026-10-22',
    lastDate: '2026-10-22',
    startTime: '15:00',
    occurrence: makeOccurrence(),
    ...overrides,
  };
}

describe('予定のボタンの読み上げ名', () => {
  it('時間指定の予定は、日付（曜日つき）・開始の時刻・題名', () => {
    expect(eventAccessibleName(event({}))).toBe('10月22日（木） 15:00 歯医者');
  });

  it('終日の予定は、時刻のかわりに「終日」', () => {
    expect(eventAccessibleName(event({ title: '誕生日', allDay: true, startTime: null }))).toBe(
      '10月22日（木） 終日 誕生日',
    );
  });

  it('複数日の予定（横棒）は、開始日〜最後の日が分かる', () => {
    expect(
      eventAccessibleName(
        event({ title: '帰省', allDay: true, startTime: null, lastDate: '2026-10-24' }),
      ),
    ).toBe('10月22日（木）〜10月24日（土） 終日 帰省');
  });

  it('日付をまたぐ時間指定の予定も、開始日〜最後の日と、開始の時刻', () => {
    expect(
      eventAccessibleName(event({ title: '夜勤', startTime: '23:00', lastDate: '2026-10-23' })),
    ).toBe('10月22日（木）〜10月23日（金） 23:00 夜勤');
  });

  it('題名の絵文字・記号は、そのまま入る', () => {
    expect(eventAccessibleName(event({ title: '🎂 誕生日' }))).toBe(
      '10月22日（木） 15:00 🎂 誕生日',
    );
  });
});
