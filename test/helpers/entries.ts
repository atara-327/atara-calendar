import type { Entry } from '../../src/shared/schema';

/**
 * テスト用の行。id 以外を省くと、終日で 1 日だけの、繰り返さない予定になる。
 * endDate を省くと startDate と同じ日になる（startDate だけ変えて、終了が開始より前になるのを防ぐ）。
 */
export function makeEntry(overrides: Partial<Entry> & Pick<Entry, 'id'>): Entry {
  const startDate = overrides.startDate ?? '2026-10-19';
  return {
    kind: 'event',
    title: 'ジム',
    workspaceId: 'w1',
    allDay: true,
    startDate,
    startTime: null,
    endDate: startDate,
    endTime: null,
    location: null,
    url: null,
    memo: null,
    rrule: null,
    untilDate: null,
    seriesId: null,
    originalDate: null,
    cancelled: false,
    notifyEnabled: true,
    notifyOffsetMin: 10,
    editedAt: 1000,
    deletedAt: null,
    ...overrides,
  };
}

/**
 * 入れ子も含めて凍結する。純粋な関数が入力を書き換えないことを、
 * 書き換えようとした時点で TypeError になる形で確かめるのに使う。
 */
export function deepFreeze<T>(value: T): T {
  if (typeof value === 'object' && value !== null && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const child of Object.values(value as Record<string, unknown>)) deepFreeze(child);
  }
  return value;
}
