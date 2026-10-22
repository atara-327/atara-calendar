import { expandOccurrences, type Occurrence } from '../../src/shared/recurrence';
import type { Entry, EntryDraft } from '../../src/shared/schema';

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
 * テスト用の、展開した 1 回（makeEntry の行を、その期間で展開したもの）。繰り返さない行なら、その予定そのもの。
 * 画面の「開いた回」（フォームの編集）のテストに使う。
 */
export function makeOccurrence(overrides: Partial<Entry> = {}): Occurrence {
  const entry = makeEntry({ id: 'e1', ...overrides });
  const [occurrence] = expandOccurrences([entry], entry.startDate, entry.endDate);
  if (occurrence === undefined) throw new Error('回が展開されませんでした');
  return occurrence;
}

/** テスト用の、新しく作るときの下書き。何も渡さないと、時間指定の 1 回きりの予定になる。 */
export function makeDraft(overrides: Partial<EntryDraft> = {}): EntryDraft {
  return {
    kind: 'event',
    title: '歯医者',
    workspaceId: 'default-workspace',
    allDay: false,
    startDate: '2026-10-19',
    startTime: '15:00',
    endDate: '2026-10-19',
    endTime: '16:00',
    location: null,
    url: null,
    memo: null,
    rrule: null,
    notifyEnabled: true,
    notifyOffsetMin: 10,
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
