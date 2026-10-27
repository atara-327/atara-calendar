import { describe, expect, it } from 'vitest';
import {
  changeEntry,
  createEntry,
  deleteEntry,
  expandOccurrences,
  InvalidChangeError,
  OccurrenceNotFoundError,
  type Occurrence,
} from './recurrence';
import { addDays } from './date';
import { entryProblem } from './entryRules';
import type { Entry, EntryChanges, EntryDraft, Rrule, Scope } from './schema';
import { deepFreeze, makeEntry } from '../../test/helpers/entries';

const NEW_ID = 'new-1';
const EDITED_AT = 5000;
const SCOPES: readonly Scope[] = ['this', 'following', 'all'];

/** 毎週 月・水・金の 19:00〜20:00。2026-10-19 は月曜。 */
const weekly = makeEntry({
  id: 's1',
  title: 'ジム',
  allDay: false,
  startDate: '2026-10-19',
  startTime: '19:00',
  endDate: '2026-10-19',
  endTime: '20:00',
  rrule: { freq: 'weekly', days: [1, 3, 5] },
  location: '駅前',
  memo: '水筒',
});

function exceptionOf(overrides: Partial<Entry> & Pick<Entry, 'id' | 'originalDate'>): Entry {
  return makeEntry({
    seriesId: 's1',
    title: 'ジム',
    allDay: false,
    startDate: overrides.originalDate ?? '',
    startTime: '19:00',
    endTime: '20:00',
    ...overrides,
  });
}

/** 10/21 を別の時刻にした例外、10/23 を削除した例外、10/28 のタイトルを変えた例外。 */
const exceptions: Entry[] = [
  exceptionOf({
    id: 'ex-10-21',
    originalDate: '2026-10-21',
    title: 'ジム（個別）',
    startTime: '07:00',
    endTime: '08:00',
  }),
  exceptionOf({ id: 'ex-10-23', originalDate: '2026-10-23', cancelled: true }),
  exceptionOf({ id: 'ex-10-28', originalDate: '2026-10-28', title: '後の個別' }),
];

function change(
  entries: readonly Entry[],
  occurrenceDate: string,
  scope: Scope,
  changes: EntryChanges,
  seriesId = 's1',
): Entry[] {
  return changeEntry({
    entries,
    target: { seriesId, occurrenceDate },
    scope,
    changes,
    newId: NEW_ID,
    editedAt: EDITED_AT,
  });
}

function remove(
  entries: readonly Entry[],
  occurrenceDate: string,
  scope: Scope,
  seriesId = 's1',
): Entry[] {
  return deleteEntry({
    entries,
    target: { seriesId, occurrenceDate },
    scope,
    newId: NEW_ID,
    editedAt: EDITED_AT,
  });
}

function rowOf(rows: readonly Entry[], id: string): Entry {
  const row = rows.find((candidate) => candidate.id === id);
  if (row === undefined) throw new Error(`結果に ${id} の行がありません`);
  return row;
}

/** 書き込む行を、元の行に反映する（同じ id は置き換え、なければ追加）。 */
function applyRows(entries: readonly Entry[], rows: readonly Entry[]): Entry[] {
  const written = new Map(rows.map((row) => [row.id, row]));
  const merged = entries.map((entry) => written.get(entry.id) ?? entry);
  const added = rows.filter((row) => !entries.some((entry) => entry.id === row.id));
  return [...merged, ...added];
}

function titlesAndDates(occurrences: readonly Occurrence[]): string[] {
  return occurrences.map(({ occurrenceDate, title }) => `${occurrenceDate} ${title}`);
}

describe('作成', () => {
  const draft: EntryDraft = {
    kind: 'event',
    title: '歯医者',
    workspaceId: 'w1',
    allDay: false,
    startDate: '2026-10-19',
    startTime: '15:00',
    endDate: '2026-10-19',
    endTime: '16:00',
    location: '○○歯科',
    url: null,
    memo: null,
    rrule: null,
    notifyEnabled: true,
    notifyOffsetMin: 10,
  };

  it('EV-2: 下書きから、id と編集時刻を持つ 1 行を作る', () => {
    expect(createEntry({ draft, newId: NEW_ID, editedAt: EDITED_AT })).toEqual([
      {
        ...draft,
        id: NEW_ID,
        untilDate: null,
        seriesId: null,
        originalDate: null,
        cancelled: false,
        editedAt: EDITED_AT,
        deletedAt: null,
      },
    ]);
  });

  it('RP-1: 開始日がルールに合わなければ、合う最初の日へずらし、終了日も同じだけずらす', () => {
    const [row] = createEntry({
      draft: {
        ...draft,
        endDate: '2026-10-20',
        rrule: { freq: 'weekly', days: [3, 5] },
      },
      newId: NEW_ID,
      editedAt: EDITED_AT,
    });
    expect([row?.startDate, row?.endDate]).toEqual(['2026-10-21', '2026-10-22']);
  });

  it('RP-6: タイムブロックも、繰り返しを付けて作れる', () => {
    const [row] = createEntry({
      draft: {
        ...draft,
        kind: 'block',
        workspaceId: null,
        notifyEnabled: false,
        rrule: { freq: 'weekday' },
        startDate: '2026-10-24',
        endDate: '2026-10-24',
      },
      newId: NEW_ID,
      editedAt: EDITED_AT,
    });
    expect(row).toMatchObject({
      kind: 'block',
      rrule: { freq: 'weekday' },
      startDate: '2026-10-26',
    });
  });

  it('下書きのルールのオブジェクトを、作った行と共有しない', () => {
    const rrule = { freq: 'weekly', days: [1] } as const;
    const [row] = createEntry({
      draft: { ...draft, rrule: { freq: 'weekly', days: [1] } },
      newId: NEW_ID,
      editedAt: EDITED_AT,
    });
    expect(row?.rrule).toEqual(rrule);
    const input = { ...draft, rrule: { freq: 'weekly' as const, days: [1] } };
    const [other] = createEntry({ draft: input, newId: NEW_ID, editedAt: EDITED_AT });
    expect(other?.rrule).not.toBe(input.rrule);
  });
});

describe('RP-4: 繰り返さない予定の変更・削除', () => {
  const single = makeEntry({
    id: 'e1',
    title: '歯医者',
    allDay: false,
    startTime: '15:00',
    endTime: '16:00',
  });

  it.each(SCOPES)('変更は、範囲（%s）を無視して、その行を書き換える', (scope) => {
    const rows = change([single], '2026-10-19', scope, { title: '内科', startTime: '10:15' }, 'e1');
    expect(rows).toEqual([{ ...single, title: '内科', startTime: '10:15', editedAt: EDITED_AT }]);
  });

  it('開始日だけを変えると、1 回の長さを保つように、終了日も動く', () => {
    const trip = makeEntry({ id: 'e1', startDate: '2026-10-19', endDate: '2026-10-21' });
    const [row] = change([trip], '2026-10-19', 'all', { startDate: '2026-10-25' }, 'e1');
    expect([row?.startDate, row?.endDate]).toEqual(['2026-10-25', '2026-10-27']);
  });

  it('開始日と終了日を両方変えたときは、それぞれ変更後の値になる', () => {
    const trip = makeEntry({ id: 'e1', startDate: '2026-10-19', endDate: '2026-10-21' });
    const [row] = change(
      [trip],
      '2026-10-19',
      'all',
      { startDate: '2026-10-25', endDate: '2026-10-26' },
      'e1',
    );
    expect([row?.startDate, row?.endDate]).toEqual(['2026-10-25', '2026-10-26']);
  });

  it('値を null にした項目は、空になる。変えていない項目は、そのまま', () => {
    const detailed = makeEntry({ id: 'e1', memo: 'メモ', location: '場所' });
    const [row] = change([detailed], '2026-10-19', 'all', { memo: null }, 'e1');
    expect(row).toMatchObject({ memo: null, location: '場所' });
  });

  it('繰り返しのルールを付けると、開始日をルールに合う日へずらして、繰り返す予定になる', () => {
    const [row] = change(
      [single],
      '2026-10-19',
      'all',
      { rrule: { freq: 'weekly', days: [3] } },
      'e1',
    );
    expect(row).toMatchObject({ rrule: { freq: 'weekly', days: [3] }, startDate: '2026-10-21' });
  });

  it.each(SCOPES)('削除は、範囲（%s）を無視して、deletedAt を付ける', (scope) => {
    expect(remove([single], '2026-10-19', scope, 'e1')).toEqual([
      { ...single, deletedAt: EDITED_AT, editedAt: EDITED_AT },
    ]);
  });
});

describe('RP-4: この予定のみ（変更）', () => {
  it('例外の行がなければ、系列の内容をコピーした例外の行を newId で作り、系列は書き換えない', () => {
    const rows = change([weekly], '2026-10-21', 'this', { title: '体験', startTime: '18:00' });
    expect(rows).toEqual([
      {
        id: NEW_ID,
        kind: 'event',
        title: '体験',
        workspaceId: 'w1',
        allDay: false,
        startDate: '2026-10-21',
        startTime: '18:00',
        endDate: '2026-10-21',
        endTime: '20:00',
        location: '駅前',
        url: null,
        memo: '水筒',
        rrule: null,
        untilDate: null,
        seriesId: 's1',
        originalDate: '2026-10-21',
        cancelled: false,
        notifyEnabled: true,
        notifyOffsetMin: 10,
        editedAt: EDITED_AT,
        deletedAt: null,
      },
    ]);
  });

  it('例外の行があれば、その行を書き換える（新しい行は作らない）', () => {
    const rows = change([weekly, ...exceptions], '2026-10-21', 'this', { title: '再変更' });
    expect(rows).toEqual([
      { ...rowOf(exceptions, 'ex-10-21'), title: '再変更', editedAt: EDITED_AT },
    ]);
  });

  it('日時を別の日に移せる。originalDate は元の回の日付のまま', () => {
    const rows = change([weekly], '2026-10-21', 'this', {
      startDate: '2026-10-22',
      startTime: '20:00',
      endDate: '2026-10-22',
      endTime: '21:00',
    });
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      originalDate: '2026-10-21',
      startDate: '2026-10-22',
      startTime: '20:00',
      endDate: '2026-10-22',
      endTime: '21:00',
    });
  });

  it('開始日だけを変えると、1 回の長さを保つように、終了日も動く', () => {
    const trip = makeEntry({
      id: 's1',
      rrule: { freq: 'weekly', days: [1] },
      startDate: '2026-10-19',
      endDate: '2026-10-20',
    });
    const [row] = change([trip], '2026-10-26', 'this', { startDate: '2026-10-27' });
    expect([row?.startDate, row?.endDate]).toEqual(['2026-10-27', '2026-10-28']);
  });

  it('すでに移した例外の日付は、フォームに出ていた値（例外の行）からの変更になる', () => {
    const moved = exceptionOf({
      id: 'ex-moved',
      originalDate: '2026-10-21',
      startDate: '2026-10-22',
      endDate: '2026-10-22',
    });
    const [row] = change([weekly, moved], '2026-10-21', 'this', { startDate: '2026-10-23' });
    expect([row?.startDate, row?.endDate, row?.originalDate]).toEqual([
      '2026-10-23',
      '2026-10-23',
      '2026-10-21',
    ]);
  });

  it('繰り返しのルールの変更は受け付けない（InvalidChangeError）', () => {
    expect(() => change([weekly], '2026-10-21', 'this', { rrule: { freq: 'daily' } })).toThrow(
      InvalidChangeError,
    );
    expect(() => change([weekly], '2026-10-21', 'this', { rrule: null })).toThrow(
      InvalidChangeError,
    );
  });

  it('系列の回でない日付は、存在しない回を作らないよう、OccurrenceNotFoundError', () => {
    expect(() => change([weekly], '2026-10-20', 'this', { title: 'x' })).toThrow(
      OccurrenceNotFoundError,
    );
  });

  it('untilDate より後の日付も、回ではない', () => {
    const cut = { ...weekly, untilDate: '2026-10-23' };
    expect(() => change([cut], '2026-10-26', 'this', { title: 'x' })).toThrow(
      OccurrenceNotFoundError,
    );
  });

  it('同じ回の例外が 2 行あって編集時刻も同じなら、id が大きい方を書き換える', () => {
    const small = exceptionOf({ id: 'ex-a', originalDate: '2026-10-21', editedAt: 1000 });
    const large = exceptionOf({ id: 'ex-b', originalDate: '2026-10-21', editedAt: 1000 });
    for (const entries of [
      [weekly, small, large],
      [weekly, large, small],
    ]) {
      const rows = change(entries, '2026-10-21', 'this', { memo: '変更' });
      expect(rows.map(({ id }) => id)).toEqual(['ex-b']);
    }
  });

  it('削除した回（cancelled の例外）は、存在しない回として OccurrenceNotFoundError', () => {
    expect(() => change([weekly, ...exceptions], '2026-10-23', 'this', { title: 'x' })).toThrow(
      OccurrenceNotFoundError,
    );
  });

  it('現在と同じルールを渡しても、ルールを変えたことにならず、受け付ける（曜日の並びも問わない）', () => {
    const rows = change([weekly], '2026-10-21', 'this', {
      title: '体験',
      rrule: { freq: 'weekly', days: [5, 3, 1] },
    });
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ title: '体験', rrule: null, originalDate: '2026-10-21' });
  });
});

describe('RP-4: これ以降すべて（変更）', () => {
  it('系列を前の日で切り、D 以降の例外を消し、D 以降は新しい系列を newId で作る', () => {
    const rows = change([weekly, ...exceptions], '2026-10-26', 'following', { title: '新ジム' });
    expect(rows).toEqual([
      { ...weekly, untilDate: '2026-10-25', editedAt: EDITED_AT },
      { ...rowOf(exceptions, 'ex-10-28'), deletedAt: EDITED_AT, editedAt: EDITED_AT },
      {
        id: NEW_ID,
        kind: 'event',
        title: '新ジム',
        workspaceId: 'w1',
        allDay: false,
        startDate: '2026-10-26',
        startTime: '19:00',
        endDate: '2026-10-26',
        endTime: '20:00',
        location: '駅前',
        url: null,
        memo: '水筒',
        rrule: { freq: 'weekly', days: [1, 3, 5] },
        untilDate: null,
        seriesId: null,
        originalDate: null,
        cancelled: false,
        notifyEnabled: true,
        notifyOffsetMin: 10,
        editedAt: EDITED_AT,
        deletedAt: null,
      },
    ]);
  });

  it('D より前の例外は、そのまま残る（書き込まれない）', () => {
    const rows = change([weekly, ...exceptions], '2026-10-26', 'following', { title: '新ジム' });
    expect(rows.map(({ id }) => id)).not.toContain('ex-10-21');
    expect(rows.map(({ id }) => id)).not.toContain('ex-10-23');
  });

  it('D の回そのものの例外も消す（D を含む）', () => {
    const onDay = exceptionOf({ id: 'ex-10-26', originalDate: '2026-10-26', title: '個別' });
    const rows = change([weekly, onDay], '2026-10-26', 'following', { title: '新ジム' });
    expect(rowOf(rows, 'ex-10-26').deletedAt).toBe(EDITED_AT);
    expect(rowOf(rows, 's1').untilDate).toBe('2026-10-25');
  });

  it('D 以降の例外は、cancelled でも消す', () => {
    const laterCancelled = exceptionOf({
      id: 'ex-10-30',
      originalDate: '2026-10-30',
      cancelled: true,
    });
    const rows = change([weekly, laterCancelled], '2026-10-26', 'following', { title: 'x' });
    expect(rowOf(rows, 'ex-10-30').deletedAt).toBe(EDITED_AT);
  });

  it('D より前の回を D 以降の日へ移した例外は、消えない（originalDate で判定するため）', () => {
    const moved = exceptionOf({
      id: 'ex-moved',
      title: '移した',
      originalDate: '2026-10-21',
      startDate: '2026-10-27',
      endDate: '2026-10-27',
    });
    const rows = change([weekly, moved], '2026-10-26', 'following', { title: '新ジム' });
    expect(rows.map(({ id }) => id)).toEqual(['s1', NEW_ID]);
    const after = applyRows([weekly, moved], rows);
    expect(titlesAndDates(expandOccurrences(after, '2026-10-26', '2026-10-28'))).toEqual([
      '2026-10-26 新ジム',
      '2026-10-21 移した',
      '2026-10-28 新ジム',
    ]);
  });

  it('D 以降の回を D より前の日へ移した例外は、消える（originalDate で判定するため）', () => {
    const moved = exceptionOf({
      id: 'ex-moved',
      originalDate: '2026-10-28',
      startDate: '2026-10-22',
      endDate: '2026-10-22',
    });
    const rows = change([weekly, moved], '2026-10-26', 'following', { title: '新ジム' });
    expect(rowOf(rows, 'ex-moved').deletedAt).toBe(EDITED_AT);
  });

  it('すでに後ろで切られている系列を、延ばさない（untilDate は D の前の日と、既存の untilDate の早い方）', () => {
    // 10/28 の例外が、切った後（untilDate = 10/23）にも残っているとき。
    const cut = { ...weekly, untilDate: '2026-10-23' };
    const rows = change([cut, rowOf(exceptions, 'ex-10-28')], '2026-10-28', 'following', {
      title: '新ジム',
    });
    expect(rowOf(rows, 's1').untilDate).toBe('2026-10-23');
  });

  it('元の系列が前に切られていたら、新しい系列も同じ untilDate を引き継ぐ', () => {
    const cut = { ...weekly, untilDate: '2026-12-31' };
    const rows = change([cut], '2026-10-26', 'following', { title: '新ジム' });
    expect(rowOf(rows, 's1').untilDate).toBe('2026-10-25');
    expect(rowOf(rows, NEW_ID).untilDate).toBe('2026-12-31');
  });

  it('元の系列が前に切られていて日付もずらしたら、新しい系列の untilDate も同じ日数ずれる', () => {
    const cut = { ...weekly, untilDate: '2026-11-04' };
    const rows = change([cut], '2026-10-26', 'following', { startDate: '2026-10-27' });
    expect(rowOf(rows, NEW_ID)).toMatchObject({ startDate: '2026-10-27', untilDate: '2026-11-05' });
  });

  it('最初の回で選ぶと、「すべて」と同じ結果になる', () => {
    const entries = [weekly, ...exceptions];
    const changes: EntryChanges = { title: '新ジム', startTime: '18:00', endTime: '19:00' };
    expect(change(entries, '2026-10-19', 'following', changes)).toEqual(
      change(entries, '2026-10-19', 'all', changes),
    );
  });

  it('日付を変えると、新しい系列の開始日は D に Δ を足した日になり、曜日もずれる', () => {
    const rows = change([weekly], '2026-10-26', 'following', { startDate: '2026-10-27' });
    expect(rowOf(rows, NEW_ID)).toMatchObject({
      startDate: '2026-10-27',
      endDate: '2026-10-27',
      rrule: { freq: 'weekly', days: [2, 4, 6] },
    });
    expect(rowOf(rows, 's1').untilDate).toBe('2026-10-25');
  });

  it('Δ は、その回の日付（移した例外なら originalDate）から数え、新しい系列は変更後の開始日から始まる', () => {
    const moved = exceptionOf({
      id: 'ex-moved',
      originalDate: '2026-10-26',
      startDate: '2026-10-27',
      endDate: '2026-10-27',
    });
    const rows = change([weekly, moved], '2026-10-26', 'following', { startDate: '2026-10-28' });
    expect(rowOf(rows, NEW_ID)).toMatchObject({
      startDate: '2026-10-28',
      rrule: { freq: 'weekly', days: [0, 3, 5] },
    });
  });

  it('ルールを変えると、新しい系列は変更後のルールになり、開始日はルールに合う日へずれる', () => {
    const rows = change([weekly], '2026-10-26', 'following', {
      rrule: { freq: 'weekly', days: [3, 5] },
    });
    expect(rowOf(rows, NEW_ID)).toMatchObject({
      rrule: { freq: 'weekly', days: [3, 5] },
      startDate: '2026-10-28',
      endDate: '2026-10-28',
    });
  });

  it('ルールを null にすると、新しい行は繰り返さない予定になる（untilDate も持たない）', () => {
    const cut = { ...weekly, untilDate: '2026-12-31' };
    const rows = change([cut], '2026-10-26', 'following', { rrule: null });
    expect(rowOf(rows, NEW_ID)).toMatchObject({
      rrule: null,
      untilDate: null,
      startDate: '2026-10-26',
    });
  });

  it('終了日を変えると、新しい系列の 1 回の長さが変わる', () => {
    const rows = change([weekly], '2026-10-26', 'following', { endDate: '2026-10-27' });
    expect(rowOf(rows, NEW_ID)).toMatchObject({ startDate: '2026-10-26', endDate: '2026-10-27' });
  });

  it('系列の回でない日付は、OccurrenceNotFoundError', () => {
    expect(() => change([weekly], '2026-10-27', 'following', { title: 'x' })).toThrow(
      OccurrenceNotFoundError,
    );
  });
});

describe('RP-4: すべて（変更）', () => {
  const entries = [weekly, ...exceptions];

  it('タイトルだけ変えると、系列の日付はそのまま', () => {
    const rows = change(entries, '2026-10-26', 'all', { title: '新ジム' });
    expect(rowOf(rows, 's1')).toEqual({ ...weekly, title: '新ジム', editedAt: EDITED_AT });
  });

  it('タイトルだけ変えると、削除した回（cancelled）は残り、個別に変えた回のタイトルも変わる', () => {
    const rows = change(entries, '2026-10-26', 'all', { title: '新ジム' });
    expect(rows.map(({ id }) => id).sort()).toEqual(['ex-10-21', 'ex-10-28', 's1']);
    // 個別に決めた時刻はそのまま。
    expect(rowOf(rows, 'ex-10-21')).toMatchObject({
      title: '新ジム',
      startTime: '07:00',
      endTime: '08:00',
      editedAt: EDITED_AT,
    });
    expect(rowOf(rows, 'ex-10-28').title).toBe('新ジム');
    expect(rows.every(({ deletedAt }) => deletedAt === null)).toBe(true);
  });

  it('時刻だけ変えたときは、例外の行を書き込まず、個別に決めた時刻を保つ', () => {
    const rows = change(entries, '2026-10-26', 'all', { startTime: '18:00', endTime: '19:00' });
    expect(rows).toEqual([
      { ...weekly, startTime: '18:00', endTime: '19:00', editedAt: EDITED_AT },
    ]);
  });

  it('日付・時刻・終日以外の項目だけが、例外に当たる', () => {
    const rows = change(entries, '2026-10-26', 'all', {
      location: '新しい場所',
      startTime: '18:00',
      startDate: '2026-10-26',
    });
    expect(rowOf(rows, 'ex-10-21')).toMatchObject({ location: '新しい場所', startTime: '07:00' });
  });

  it('日付をずらすと、系列の開始日と、weekly の曜日がずれ、例外はすべて消える', () => {
    // 水曜（10/21）の回を、1 日後ろの木曜にする。
    const rows = change(entries, '2026-10-21', 'all', { startDate: '2026-10-22' });
    expect(rowOf(rows, 's1')).toMatchObject({
      startDate: '2026-10-20',
      endDate: '2026-10-20',
      rrule: { freq: 'weekly', days: [2, 4, 6] },
      editedAt: EDITED_AT,
    });
    for (const id of ['ex-10-21', 'ex-10-23', 'ex-10-28']) {
      expect(rowOf(rows, id)).toMatchObject({ deletedAt: EDITED_AT, editedAt: EDITED_AT });
    }
  });

  it('日付を前へずらして日曜が土曜になるときも、曜日は 0〜6 に収まる', () => {
    const sundays = makeEntry({
      id: 's1',
      rrule: { freq: 'weekly', days: [0] },
      startDate: '2026-10-18',
    });
    const [row] = change([sundays], '2026-10-25', 'all', { startDate: '2026-10-24' });
    expect(row).toMatchObject({ rrule: { freq: 'weekly', days: [6] }, startDate: '2026-10-17' });
  });

  it('Δ は、フォームに出ていた回の開始日から数える（最初の回でなくても、系列の開始日がずれる）', () => {
    const rows = change([weekly], '2026-10-28', 'all', { startDate: '2026-10-29' });
    expect(rowOf(rows, 's1')).toMatchObject({ startDate: '2026-10-20', endDate: '2026-10-20' });
  });

  it('移した例外の回を開いて日付を変えると、その回がユーザーが選んだ日に出る（Δ は originalDate から数える）', () => {
    const monthly = makeEntry({
      id: 's1',
      allDay: false,
      rrule: { freq: 'monthly' },
      startDate: '2026-10-19',
      startTime: '19:00',
      endTime: '20:00',
    });
    const moved = exceptionOf({
      id: 'ex-moved',
      originalDate: '2026-11-19',
      startDate: '2026-11-20',
      endDate: '2026-11-20',
    });
    const rows = change([monthly, moved], '2026-11-19', 'all', { startDate: '2026-11-22' });
    expect(rowOf(rows, 's1').startDate).toBe('2026-10-22');
    const after = applyRows([monthly, moved], rows);
    expect(titlesAndDates(expandOccurrences(after, '2026-10-01', '2026-12-31'))).toEqual([
      '2026-10-22 ジム',
      '2026-11-22 ジム',
      '2026-12-22 ジム',
    ]);
  });

  it('monthly は、ずらした開始日がそのまま新しい基準になる', () => {
    const monthly = makeEntry({ id: 's1', rrule: { freq: 'monthly' }, startDate: '2026-10-19' });
    const rows = change([monthly], '2026-11-19', 'all', { startDate: '2026-11-20' });
    expect(rowOf(rows, 's1')).toMatchObject({
      rrule: { freq: 'monthly' },
      startDate: '2026-10-20',
    });
    const after = applyRows([monthly], rows);
    expect(titlesAndDates(expandOccurrences(after, '2026-10-01', '2026-12-31'))).toEqual([
      '2026-10-20 ジム',
      '2026-11-20 ジム',
      '2026-12-20 ジム',
    ]);
  });

  it('ルールを変えると、開始日はルールに合う日へずれ、例外（cancelled も）はすべて消える', () => {
    const rows = change(entries, '2026-10-26', 'all', { rrule: { freq: 'weekly', days: [2] } });
    expect(rowOf(rows, 's1')).toMatchObject({
      rrule: { freq: 'weekly', days: [2] },
      startDate: '2026-10-20',
      endDate: '2026-10-20',
    });
    expect(
      rows
        .filter(({ deletedAt }) => deletedAt !== null)
        .map(({ id }) => id)
        .sort(),
    ).toEqual(['ex-10-21', 'ex-10-23', 'ex-10-28']);
  });

  it('同じ曜日の組をそのまま指定しても、ルールを変えたことにならず、例外は残る', () => {
    const rows = change(entries, '2026-10-26', 'all', {
      title: '新ジム',
      rrule: { freq: 'weekly', days: [5, 3, 1] },
    });
    expect(rows.every(({ deletedAt }) => deletedAt === null)).toBe(true);
    expect(rowOf(rows, 's1').rrule).toEqual({ freq: 'weekly', days: [1, 3, 5] });
  });

  it('ルールを null にすると、系列は繰り返さない予定になり、例外はすべて消える', () => {
    const cut = { ...weekly, untilDate: '2026-12-31' };
    const rows = change([cut, ...exceptions], '2026-10-26', 'all', { rrule: null });
    expect(rowOf(rows, 's1')).toMatchObject({
      rrule: null,
      untilDate: null,
      startDate: '2026-10-19',
    });
    expect(rowOf(rows, 'ex-10-21').deletedAt).toBe(EDITED_AT);
  });

  it('終了日だけを変えると、系列の 1 回の長さが変わる', () => {
    const rows = change([weekly], '2026-10-26', 'all', { endDate: '2026-10-27' });
    expect(rowOf(rows, 's1')).toMatchObject({ startDate: '2026-10-19', endDate: '2026-10-20' });
  });

  it('別の長さに変えた例外の回で、タイトルだけ変えても、系列の長さは変わらない', () => {
    const longer = exceptionOf({
      id: 'ex-long',
      originalDate: '2026-10-21',
      startDate: '2026-10-21',
      endDate: '2026-10-23',
    });
    const rows = change([weekly, longer], '2026-10-21', 'all', { title: '新ジム' });
    expect(rowOf(rows, 's1')).toMatchObject({ startDate: '2026-10-19', endDate: '2026-10-19' });
  });

  it('untilDate は、日付をずらさなければ、そのまま残る', () => {
    const cut = { ...weekly, untilDate: '2026-12-31' };
    const rows = change([cut], '2026-10-26', 'all', { title: '新ジム' });
    expect(rowOf(rows, 's1').untilDate).toBe('2026-12-31');
  });

  it('日付をずらすと、untilDate も同じだけずれて、回の数は変わらない', () => {
    const cut = { ...weekly, untilDate: '2026-11-13' };
    const before = expandOccurrences([cut], '2026-10-01', '2026-12-31');
    const rows = change([cut], '2026-10-21', 'all', { startDate: '2026-10-22' });
    expect(rowOf(rows, 's1').untilDate).toBe('2026-11-14');
    const after = expandOccurrences(applyRows([cut], rows), '2026-10-01', '2026-12-31');
    expect(after).toHaveLength(before.length);
    expect(after.at(-1)?.occurrenceDate).toBe('2026-11-14');
  });

  it('日付を前にずらすと、untilDate も前にずれる（monthly）', () => {
    const monthly = makeEntry({
      id: 's1',
      rrule: { freq: 'monthly' },
      startDate: '2026-10-19',
      untilDate: '2027-01-19',
    });
    const rows = change([monthly], '2026-11-19', 'all', { startDate: '2026-11-18' });
    expect(rowOf(rows, 's1')).toMatchObject({ startDate: '2026-10-18', untilDate: '2027-01-18' });
  });

  it('untilDate がない系列は、日付をずらしても null のまま', () => {
    const rows = change([weekly], '2026-10-21', 'all', { startDate: '2026-10-22' });
    expect(rowOf(rows, 's1').untilDate).toBeNull();
  });

  it('開いていた回が例外の行なら、その例外には日時・終日も含めて変更をすべて当て、ほかの例外には日時を当てない', () => {
    const rows = change(entries, '2026-10-21', 'all', {
      title: '新ジム',
      startTime: '18:00',
      endTime: '19:00',
    });
    expect(rows.map(({ id }) => id).sort()).toEqual(['ex-10-21', 'ex-10-28', 's1']);
    expect(rowOf(rows, 'ex-10-21')).toMatchObject({
      title: '新ジム',
      startTime: '18:00',
      endTime: '19:00',
      editedAt: EDITED_AT,
    });
    expect(rowOf(rows, 'ex-10-28')).toMatchObject({
      title: '新ジム',
      startTime: '19:00',
      endTime: '20:00',
    });
  });

  it('開いていた回の例外を終日に変えると、その例外も終日になる', () => {
    const rows = change(entries, '2026-10-21', 'all', {
      allDay: true,
      startTime: null,
      endTime: null,
    });
    expect(rows.map(({ id }) => id).sort()).toEqual(['ex-10-21', 's1']);
    expect(rowOf(rows, 'ex-10-21')).toMatchObject({ allDay: true, startTime: null, endTime: null });
  });

  it('開いていた回が、別の日に移した例外なら、その日付にも変更後の終了日が当たる', () => {
    const moved = exceptionOf({
      id: 'ex-moved',
      originalDate: '2026-10-21',
      startDate: '2026-10-22',
      endDate: '2026-10-22',
    });
    const rows = change([weekly, moved], '2026-10-21', 'all', { endDate: '2026-10-23' });
    expect(rowOf(rows, 'ex-moved')).toMatchObject({
      startDate: '2026-10-22',
      endDate: '2026-10-23',
    });
    expect(rowOf(rows, 's1')).toMatchObject({ startDate: '2026-10-19', endDate: '2026-10-20' });
  });

  it('開いていた回の例外が、変更後も同じ値なら、その行は書き込まない', () => {
    const rows = change(entries, '2026-10-28', 'all', { startTime: '19:00', endTime: '20:00' });
    expect(rows.map(({ id }) => id)).toEqual(['s1']);
  });

  it('系列の回でない日付は、OccurrenceNotFoundError', () => {
    expect(() => change(entries, '2026-10-27', 'all', { title: 'x' })).toThrow(
      OccurrenceNotFoundError,
    );
  });
});

describe('RP-4: 日付をずらせるのは weekly・monthly・yearly だけ', () => {
  function seriesOf(rrule: Rrule, startDate: string): Entry {
    return makeEntry({
      id: 's1',
      allDay: false,
      startDate,
      startTime: '19:00',
      endTime: '20:00',
      rrule,
    });
  }

  /** [名前, ルール, 系列の開始日（最初の回）, 2 回目以降の回] */
  const NOT_SHIFTABLE: [string, Rrule, string, string][] = [
    ['daily', { freq: 'daily' }, '2026-10-19', '2026-10-21'],
    ['weekday', { freq: 'weekday' }, '2026-10-19', '2026-10-21'],
    ['holiday', { freq: 'holiday' }, '2026-10-24', '2026-10-25'],
  ];

  it.each(NOT_SHIFTABLE)(
    '%s は、「すべて」「これ以降すべて」で開始日を変えると InvalidChangeError',
    (_name, rrule, first, later) => {
      const entries = [seriesOf(rrule, first)];
      expect(() => change(entries, first, 'all', { startDate: addDays(first, 1) })).toThrow(
        InvalidChangeError,
      );
      expect(() => change(entries, later, 'following', { startDate: addDays(later, 1) })).toThrow(
        InvalidChangeError,
      );
    },
  );

  it.each(NOT_SHIFTABLE)(
    '%s でも、「この予定のみ」なら日付を動かせる',
    (_name, rrule, first, later) => {
      const rows = change([seriesOf(rrule, first)], later, 'this', {
        startDate: addDays(later, 1),
      });
      expect(rows[0]).toMatchObject({ originalDate: later, startDate: addDays(later, 1) });
    },
  );

  it.each(NOT_SHIFTABLE)(
    '%s でも、開始日を変えなければ（Δ = 0）、ほかの項目は変えられる',
    (_name, rrule, first, later) => {
      const entries = [seriesOf(rrule, first)];
      expect(() => change(entries, first, 'all', { title: '新ジム' })).not.toThrow();
      expect(() =>
        change(entries, later, 'following', { title: '新ジム', startDate: later }),
      ).not.toThrow();
    },
  );

  it('yearly は、日付をずらせる', () => {
    const yearly = seriesOf({ freq: 'yearly' }, '2026-10-19');
    const rows = change([yearly], '2027-10-19', 'all', { startDate: '2027-10-20' });
    expect(rowOf(rows, 's1').startDate).toBe('2026-10-20');
  });

  it('ルールを同時に変えるときは、変更後のルールで判定する（weekly → daily は不可、daily → weekly は可）', () => {
    const weeklyDaily = () =>
      change([weekly], '2026-10-21', 'all', {
        rrule: { freq: 'daily' },
        startDate: '2026-10-22',
      });
    expect(weeklyDaily).toThrow(InvalidChangeError);

    const daily = seriesOf({ freq: 'daily' }, '2026-10-19');
    const rows = change([daily], '2026-10-21', 'all', {
      rrule: { freq: 'weekly', days: [3] },
      startDate: '2026-10-22',
    });
    expect(rowOf(rows, 's1')).toMatchObject({
      rrule: { freq: 'weekly', days: [3] },
      startDate: '2026-10-21',
    });
  });

  it('繰り返さない予定（ルールを null）に変えるなら、日付をずらせる', () => {
    const daily = seriesOf({ freq: 'daily' }, '2026-10-19');
    const rows = change([daily], '2026-10-19', 'all', { rrule: null, startDate: '2026-10-20' });
    expect(rowOf(rows, 's1')).toMatchObject({ rrule: null, startDate: '2026-10-20' });
  });
});

describe('RP-4: すべて（変更）で、終日かどうかが違う例外には、通知の分数を当てない', () => {
  const allDayException = exceptionOf({
    id: 'ex-allday',
    originalDate: '2026-10-21',
    allDay: true,
    startTime: null,
    endTime: null,
    notifyOffsetMin: -360,
  });
  const timedException = exceptionOf({
    id: 'ex-timed',
    originalDate: '2026-10-23',
    notifyOffsetMin: 10,
  });
  const entries = [weekly, allDayException, timedException];

  it('時間指定の系列に通知の設定を当てると、終日の例外には notifyEnabled だけが当たる', () => {
    const rows = change(entries, '2026-10-26', 'all', {
      notifyEnabled: false,
      notifyOffsetMin: 30,
    });
    expect(rowOf(rows, 's1')).toMatchObject({ notifyEnabled: false, notifyOffsetMin: 30 });
    expect(rowOf(rows, 'ex-timed')).toMatchObject({ notifyEnabled: false, notifyOffsetMin: 30 });
    expect(rowOf(rows, 'ex-allday')).toMatchObject({ notifyEnabled: false, notifyOffsetMin: -360 });
  });

  it('系列を終日に変えるときは、時間指定の例外に notifyOffsetMin を当てない', () => {
    const rows = change(entries, '2026-10-26', 'all', {
      allDay: true,
      startTime: null,
      endTime: null,
      notifyEnabled: false,
      notifyOffsetMin: -360,
    });
    expect(rowOf(rows, 'ex-timed')).toMatchObject({ notifyEnabled: false, notifyOffsetMin: 10 });
    expect(rowOf(rows, 'ex-allday')).toMatchObject({ notifyEnabled: false, notifyOffsetMin: -360 });
  });

  it('当たらない項目だけの変更なら、その例外の行は書き込まない', () => {
    const rows = change(entries, '2026-10-26', 'all', { notifyOffsetMin: 30 });
    expect(rows.map(({ id }) => id).sort()).toEqual(['ex-timed', 's1']);
  });

  it('開いていた回の例外を終日に変えるときは、その例外にも notifyOffsetMin が当たる', () => {
    const rows = change(entries, '2026-10-23', 'all', {
      allDay: true,
      startTime: null,
      endTime: null,
      notifyOffsetMin: -180,
    });
    expect(rowOf(rows, 'ex-timed')).toMatchObject({ allDay: true, notifyOffsetMin: -180 });
    expect(rowOf(rows, 'ex-allday')).toMatchObject({ allDay: true, notifyOffsetMin: -180 });
  });
});

describe('対象が見つからないとき', () => {
  it.each(SCOPES)('変更（%s）は、系列が見つからなければ OccurrenceNotFoundError', (scope) => {
    expect(() => change([weekly], '2026-10-19', scope, { title: 'x' }, 'missing')).toThrow(
      OccurrenceNotFoundError,
    );
  });

  it('削除済みの系列は、見つからないものとして OccurrenceNotFoundError', () => {
    const deleted = { ...weekly, deletedAt: 1 };
    expect(() => change([deleted], '2026-10-19', 'all', { title: 'x' })).toThrow(
      OccurrenceNotFoundError,
    );
    expect(() => remove([deleted], '2026-10-19', 'all')).toThrow(OccurrenceNotFoundError);
  });

  it('例外の行の id は、系列として扱わない', () => {
    expect(() =>
      change([weekly, ...exceptions], '2026-10-21', 'all', { title: 'x' }, 'ex-10-21'),
    ).toThrow(OccurrenceNotFoundError);
  });
});

describe('エラーの種類（API が「依頼を捨てる」と「エラーを返す」を区別できる）', () => {
  it('OccurrenceNotFoundError と InvalidChangeError は、別のクラスで、どちらも Error', () => {
    const notFound = new OccurrenceNotFoundError('x');
    const invalid = new InvalidChangeError('x');
    expect(notFound).toBeInstanceOf(Error);
    expect(invalid).toBeInstanceOf(Error);
    expect(notFound).not.toBeInstanceOf(InvalidChangeError);
    expect(invalid).not.toBeInstanceOf(OccurrenceNotFoundError);
    expect([notFound.name, invalid.name]).toEqual([
      'OccurrenceNotFoundError',
      'InvalidChangeError',
    ]);
  });
});

describe('RP-4: 削除', () => {
  it('この予定のみ: 例外の行がなければ、cancelled の例外の行を newId で作る', () => {
    const rows = remove([weekly], '2026-10-21', 'this');
    expect(rows).toEqual([
      {
        id: NEW_ID,
        kind: 'event',
        title: 'ジム',
        workspaceId: 'w1',
        allDay: false,
        startDate: '2026-10-21',
        startTime: '19:00',
        endDate: '2026-10-21',
        endTime: '20:00',
        location: '駅前',
        url: null,
        memo: '水筒',
        rrule: null,
        untilDate: null,
        seriesId: 's1',
        originalDate: '2026-10-21',
        cancelled: true,
        notifyEnabled: true,
        notifyOffsetMin: 10,
        editedAt: EDITED_AT,
        deletedAt: null,
      },
    ]);
  });

  it('この予定のみ: 例外の行があれば、それを cancelled にする', () => {
    const rows = remove([weekly, ...exceptions], '2026-10-21', 'this');
    expect(rows).toEqual([
      { ...rowOf(exceptions, 'ex-10-21'), cancelled: true, editedAt: EDITED_AT },
    ]);
  });

  it('この予定のみ: 系列の回でない日付は、OccurrenceNotFoundError', () => {
    expect(() => remove([weekly], '2026-10-20', 'this')).toThrow(OccurrenceNotFoundError);
  });

  it('これ以降すべて: 系列を前の日で切り、D 以降の例外を消す', () => {
    const rows = remove([weekly, ...exceptions], '2026-10-26', 'following');
    expect(rows).toEqual([
      { ...weekly, untilDate: '2026-10-25', editedAt: EDITED_AT },
      { ...rowOf(exceptions, 'ex-10-28'), deletedAt: EDITED_AT, editedAt: EDITED_AT },
    ]);
  });

  it('これ以降すべて: D の回そのものの例外も消す（D を含む）', () => {
    const onDay = exceptionOf({ id: 'ex-10-26', originalDate: '2026-10-26', cancelled: true });
    const rows = remove([weekly, onDay], '2026-10-26', 'following');
    expect(rowOf(rows, 'ex-10-26').deletedAt).toBe(EDITED_AT);
  });

  it('これ以降すべて: D より前の回を D 以降の日へ移した例外は、消えない', () => {
    const moved = exceptionOf({
      id: 'ex-moved',
      originalDate: '2026-10-21',
      startDate: '2026-10-27',
      endDate: '2026-10-27',
    });
    const rows = remove([weekly, moved], '2026-10-26', 'following');
    expect(rows.map(({ id }) => id)).toEqual(['s1']);
  });

  it('これ以降すべて: すでに後ろで切られている系列を、延ばさない', () => {
    const cut = { ...weekly, untilDate: '2026-10-23' };
    const rows = remove([cut, rowOf(exceptions, 'ex-10-28')], '2026-10-28', 'following');
    expect(rowOf(rows, 's1').untilDate).toBe('2026-10-23');
  });

  it('これ以降すべて: 最初の回で選ぶと、「すべて」と同じ結果になる', () => {
    const entries = [weekly, ...exceptions];
    expect(remove(entries, '2026-10-19', 'following')).toEqual(
      remove(entries, '2026-10-19', 'all'),
    );
  });

  it('これ以降すべて: 系列の回でない日付は、OccurrenceNotFoundError', () => {
    expect(() => remove([weekly], '2026-10-20', 'following')).toThrow(OccurrenceNotFoundError);
  });

  it('すべて: 系列と、その例外（cancelled も）をすべて削除する', () => {
    const rows = remove([weekly, ...exceptions], '2026-10-26', 'all');
    expect(rows.map(({ id }) => id).sort()).toEqual(['ex-10-21', 'ex-10-23', 'ex-10-28', 's1']);
    expect(rows.every((row) => row.deletedAt === EDITED_AT && row.editedAt === EDITED_AT)).toBe(
      true,
    );
  });

  it('すべて: 削除済みの例外は、書き直さない', () => {
    const alreadyDeleted = { ...rowOf(exceptions, 'ex-10-21'), deletedAt: 1 };
    const rows = remove([weekly, alreadyDeleted], '2026-10-19', 'all');
    expect(rows.map(({ id }) => id)).toEqual(['s1']);
  });

  it('すべて: 回の日付が合っていなくても削除できる', () => {
    expect(remove([weekly], '2026-10-20', 'all')).toHaveLength(1);
  });
});

describe('展開との組み合わせ（行を書き込んだ後の見え方）', () => {
  const range = ['2026-10-19', '2026-11-01'] as const;

  it('この予定のみ変更: その回だけが変わる', () => {
    const after = applyRows([weekly], change([weekly], '2026-10-21', 'this', { title: '体験' }));
    expect(titlesAndDates(expandOccurrences(after, ...range))).toEqual([
      '2026-10-19 ジム',
      '2026-10-21 体験',
      '2026-10-23 ジム',
      '2026-10-26 ジム',
      '2026-10-28 ジム',
      '2026-10-30 ジム',
    ]);
  });

  it('この予定のみ削除: その回だけが消える', () => {
    const after = applyRows([weekly], remove([weekly], '2026-10-21', 'this'));
    expect(titlesAndDates(expandOccurrences(after, ...range))).toEqual([
      '2026-10-19 ジム',
      '2026-10-23 ジム',
      '2026-10-26 ジム',
      '2026-10-28 ジム',
      '2026-10-30 ジム',
    ]);
  });

  it('これ以降すべて変更: D の前は元のまま、D 以降は新しい内容で、二重にならない', () => {
    const after = applyRows(
      [weekly, ...exceptions],
      change([weekly, ...exceptions], '2026-10-26', 'following', { title: '新ジム' }),
    );
    expect(titlesAndDates(expandOccurrences(after, ...range))).toEqual([
      '2026-10-19 ジム',
      '2026-10-21 ジム（個別）',
      '2026-10-26 新ジム',
      '2026-10-28 新ジム',
      '2026-10-30 新ジム',
    ]);
  });

  it('これ以降すべて削除: D の前だけが残る', () => {
    const after = applyRows(
      [weekly, ...exceptions],
      remove([weekly, ...exceptions], '2026-10-26', 'following'),
    );
    expect(titlesAndDates(expandOccurrences(after, '2026-10-19', '2027-10-19'))).toEqual([
      '2026-10-19 ジム',
      '2026-10-21 ジム（個別）',
    ]);
  });

  it('すべて変更（日付をずらす）: 曜日がずれ、例外は消えて元の回が出る', () => {
    const after = applyRows(
      [weekly, ...exceptions],
      change([weekly, ...exceptions], '2026-10-21', 'all', { startDate: '2026-10-22' }),
    );
    expect(titlesAndDates(expandOccurrences(after, '2026-10-19', '2026-10-25'))).toEqual([
      '2026-10-20 ジム',
      '2026-10-22 ジム',
      '2026-10-24 ジム',
    ]);
  });

  it('操作を重ねても、二重にならず、それぞれの範囲だけが変わる（これ以降 → これ以降 → この予定のみ → すべて）', () => {
    let state: Entry[] = [weekly];
    const apply = (
      seriesId: string,
      occurrenceDate: string,
      scope: Scope,
      changes: EntryChanges,
      newId: string,
    ) => {
      const rows = changeEntry({
        entries: state,
        target: { seriesId, occurrenceDate },
        scope,
        changes,
        newId,
        editedAt: EDITED_AT,
      });
      state = applyRows(state, rows);
    };
    apply('s1', '2026-10-26', 'following', { title: '新ジム' }, 'new-1');
    apply(
      'new-1',
      '2026-11-09',
      'following',
      { title: '夜ジム', startTime: '18:00', endTime: '19:00' },
      'new-2',
    );
    apply('new-2', '2026-11-11', 'this', { title: '休み前' }, 'new-3');
    apply('new-2', '2026-11-13', 'all', { location: '新駅' }, 'new-4');

    expect(
      state
        .filter(({ seriesId }) => seriesId === null)
        .map(({ id, untilDate }) => `${id} ${String(untilDate)}`),
    ).toEqual(['s1 2026-10-25', 'new-1 2026-11-08', 'new-2 null']);
    const lines = expandOccurrences(state, '2026-10-19', '2026-11-16').map(
      ({ occurrenceDate, startTime, title, location }) =>
        `${occurrenceDate} ${String(startTime)} ${title} @${String(location)}`,
    );
    expect(lines).toEqual([
      '2026-10-19 19:00 ジム @駅前',
      '2026-10-21 19:00 ジム @駅前',
      '2026-10-23 19:00 ジム @駅前',
      '2026-10-26 19:00 新ジム @駅前',
      '2026-10-28 19:00 新ジム @駅前',
      '2026-10-30 19:00 新ジム @駅前',
      '2026-11-02 19:00 新ジム @駅前',
      '2026-11-04 19:00 新ジム @駅前',
      '2026-11-06 19:00 新ジム @駅前',
      '2026-11-09 18:00 夜ジム @新駅',
      '2026-11-11 18:00 休み前 @新駅',
      '2026-11-13 18:00 夜ジム @新駅',
      '2026-11-16 18:00 夜ジム @新駅',
    ]);
  });

  it('すべて削除: 何も出ない', () => {
    const after = applyRows(
      [weekly, ...exceptions],
      remove([weekly, ...exceptions], '2026-10-19', 'all'),
    );
    expect(expandOccurrences(after, '2026-10-01', '2027-12-31')).toEqual([]);
  });
});

describe('項目をまたぐ確認（設計書 4.2）との組み合わせ: 回が 1 つもない系列は、守られていない行になる', () => {
  const daily = makeEntry({
    id: 's1',
    allDay: false,
    startDate: '2026-10-19',
    startTime: '19:00',
    endTime: '20:00',
    rrule: { freq: 'daily' },
  });
  /** 10/19 からの毎日を、10/24 の「これ以降すべて」の削除で、10/23 までにしたもの。 */
  const cutAtOct23 = applyRows([daily], remove([daily], '2026-10-24', 'following'));
  const toSunday: EntryChanges = { rrule: { freq: 'weekly', days: [0] } };

  /** 書く行のうち、削除しない行の、守られていない決まりの説明。 */
  function problemsOf(rows: readonly Entry[]): string[] {
    return rows.filter((row) => row.deletedAt === null).flatMap((row) => entryProblem(row) ?? []);
  }

  it('これ以降すべて: 10/23 の回を毎週 日に変えると、新しい系列の開始日が 10/25 になり、untilDate（10/23）より後になる', () => {
    expect(cutAtOct23.map(({ untilDate }) => untilDate)).toEqual(['2026-10-23']);

    const rows = change(cutAtOct23, '2026-10-23', 'following', toSunday);

    expect(rowOf(rows, NEW_ID)).toMatchObject({ startDate: '2026-10-25', untilDate: '2026-10-23' });
    expect(entryProblem(rowOf(rows, NEW_ID))).toEqual(expect.any(String));
  });

  it('すべて: 10/23 の回を毎週 日に変えると、開始日が 10/19 から 10/25 にずれ、untilDate（10/23）より後になる', () => {
    const rows = change(cutAtOct23, '2026-10-23', 'all', toSunday);

    expect(rowOf(rows, 's1')).toMatchObject({ startDate: '2026-10-25', untilDate: '2026-10-23' });
    expect(entryProblem(rowOf(rows, 's1'))).toEqual(expect.any(String));
  });

  it.each(['following', 'all'] as const)(
    '%s: ルールを変えずに題名だけ変えるのは、守られている',
    (scope) => {
      expect(problemsOf(change(cutAtOct23, '2026-10-23', scope, { title: '新ジム' }))).toEqual([]);
    },
  );

  it.each(['following', 'all'] as const)(
    '%s: ルールに合う最初の日（10/25）が untilDate と同じ日なら、その日の 1 回が残るので、守られている',
    (scope) => {
      const cutAtOct25 = applyRows([daily], remove([daily], '2026-10-26', 'following'));

      const rows = change(cutAtOct25, '2026-10-23', scope, toSunday);

      expect(rowOf(rows, scope === 'all' ? 's1' : NEW_ID)).toMatchObject({
        startDate: '2026-10-25',
        untilDate: '2026-10-25',
      });
      expect(problemsOf(rows)).toEqual([]);
    },
  );

  it.each(['following', 'all'] as const)(
    '%s: ルールをなくすと untilDate も null になり、守られている',
    (scope) => {
      const rows = change(cutAtOct23, '2026-10-23', scope, { rrule: null });

      expect(rowOf(rows, scope === 'all' ? 's1' : NEW_ID).untilDate).toBeNull();
      expect(problemsOf(rows)).toEqual([]);
    },
  );

  // 最初の回の「これ以降すべて」は「すべて」に回る（系列を切らない）ので、切った untilDate は、必ず開始日以降になる。
  it.each([
    {
      name: '終わりがない毎日の系列',
      rows: [daily],
      dates: ['2026-10-19', '2026-10-20', '2026-10-25'],
    },
    {
      name: '10/23 で切られた毎日の系列',
      rows: cutAtOct23,
      dates: ['2026-10-19', '2026-10-20', '2026-10-23'],
    },
  ])(
    '$name: どの回の「これ以降すべて」でも、題名の変更も削除も、守られている',
    ({ rows, dates }) => {
      for (const date of dates) {
        expect(problemsOf(change(rows, date, 'following', { title: '新ジム' })), date).toEqual([]);
        expect(problemsOf(remove(rows, date, 'following')), date).toEqual([]);
      }
    },
  );

  // ルールを変えずに日付をずらすと、開始日と untilDate が同じだけずれる。開始日と untilDate が同じ日になる境目でも、
  // その日の 1 回が残るので、守られている。
  it.each([
    {
      name: '毎週 月・水・金（10/19〜10/23）の 10/23 の回を 10/24 へ',
      series: makeEntry({
        id: 's1',
        rrule: { freq: 'weekly', days: [1, 3, 5] },
        startDate: '2026-10-19',
        untilDate: '2026-10-23',
      }),
      date: '2026-10-23',
      to: '2026-10-24',
      following: { startDate: '2026-10-24', untilDate: '2026-10-24' },
      all: { startDate: '2026-10-20', untilDate: '2026-10-24' },
    },
    {
      name: '毎月（1/31〜3/31）の 3/31 の回を 3/30 へ',
      series: makeEntry({
        id: 's1',
        rrule: { freq: 'monthly' },
        startDate: '2026-01-31',
        untilDate: '2026-03-31',
      }),
      date: '2026-03-31',
      to: '2026-03-30',
      following: { startDate: '2026-03-30', untilDate: '2026-03-30' },
      all: { startDate: '2026-01-30', untilDate: '2026-03-30' },
    },
  ])(
    '$name: ルールを変えずに日付をずらすのは、どちらの範囲でも、守られている',
    ({ series, date, to, following, all }) => {
      const followingRows = change([series], date, 'following', { startDate: to });
      expect(rowOf(followingRows, NEW_ID)).toMatchObject(following);
      expect(problemsOf(followingRows)).toEqual([]);

      const allRows = change([series], date, 'all', { startDate: to });
      expect(rowOf(allRows, 's1')).toMatchObject(all);
      expect(problemsOf(allRows)).toEqual([]);
    },
  );
});

describe('RP-6: タイムブロックでも同じように動く', () => {
  const block = makeEntry({
    id: 'b1',
    kind: 'block',
    title: '仕事',
    workspaceId: null,
    allDay: false,
    startDate: '2026-10-19',
    startTime: '09:00',
    endDate: '2026-10-19',
    endTime: '18:00',
    rrule: { freq: 'weekday' },
    notifyEnabled: false,
  });
  const blockChange = (occurrenceDate: string, scope: Scope, changes: EntryChanges) =>
    change([block], occurrenceDate, scope, changes, 'b1');

  it('この予定のみ: 例外の行も block で、ワークスペースを持たない', () => {
    const [row] = blockChange('2026-10-21', 'this', { startTime: '10:00' });
    expect(row).toMatchObject({
      kind: 'block',
      workspaceId: null,
      seriesId: 'b1',
      originalDate: '2026-10-21',
      startTime: '10:00',
    });
  });

  it('これ以降すべて: 新しい系列も block のまま、通知の初期値の OFF を引き継ぐ', () => {
    const rows = blockChange('2026-10-21', 'following', { endTime: '17:00' });
    expect(rowOf(rows, NEW_ID)).toMatchObject({
      kind: 'block',
      workspaceId: null,
      notifyEnabled: false,
      rrule: { freq: 'weekday' },
      startDate: '2026-10-21',
      endTime: '17:00',
    });
    expect(rowOf(rows, 'b1').untilDate).toBe('2026-10-20');
  });

  it('すべて・削除も、kind を変えずに動く', () => {
    const [changed] = blockChange('2026-10-21', 'all', { title: '在宅' });
    expect(changed).toMatchObject({ kind: 'block', title: '在宅' });
    expect(remove([block], '2026-10-21', 'this', 'b1')[0]).toMatchObject({
      kind: 'block',
      cancelled: true,
    });
  });

  it('平日の系列で、土曜の回の日付は存在しない回なのでOccurrenceNotFoundError', () => {
    expect(() => blockChange('2026-10-24', 'this', { startTime: '10:00' })).toThrow(
      OccurrenceNotFoundError,
    );
  });
});

describe('純粋な関数であること', () => {
  const frozen = deepFreeze([weekly, ...exceptions]);

  it.each(SCOPES)('変更（%s）は、同じ入力から同じ結果を返し、入力を書き換えない', (scope) => {
    const changes = deepFreeze<EntryChanges>({ title: '新ジム', startDate: '2026-10-26' });
    const first = change(frozen, '2026-10-26', scope, changes);
    const second = change(frozen, '2026-10-26', scope, changes);
    expect(second).toEqual(first);
  });

  it.each(SCOPES)('削除（%s）は、同じ入力から同じ結果を返し、入力を書き換えない', (scope) => {
    const first = remove(frozen, '2026-10-26', scope);
    expect(remove(frozen, '2026-10-26', scope)).toEqual(first);
  });

  it('作成は、同じ入力から同じ結果を返す', () => {
    const draft = deepFreeze<EntryDraft>({
      kind: 'event',
      title: 'x',
      workspaceId: 'w1',
      allDay: true,
      startDate: '2026-10-19',
      startTime: null,
      endDate: '2026-10-19',
      endTime: null,
      location: null,
      url: null,
      memo: null,
      rrule: { freq: 'weekly', days: [3] },
      notifyEnabled: true,
      notifyOffsetMin: -360,
    });
    expect(createEntry({ draft, newId: NEW_ID, editedAt: EDITED_AT })).toEqual(
      createEntry({ draft, newId: NEW_ID, editedAt: EDITED_AT }),
    );
  });

  it('結果の行は、入力の行と、ルールのオブジェクトを共有しない', () => {
    const rows = change(frozen, '2026-10-26', 'following', { title: '新ジム' });
    expect(rowOf(rows, 's1').rrule).not.toBe(weekly.rrule);
    expect(rowOf(rows, NEW_ID).rrule).not.toBe(weekly.rrule);
    expect(remove(frozen, '2026-10-19', 'all')[0]?.rrule).not.toBe(weekly.rrule);
  });

  it.each(SCOPES)('書き込む行の editedAt は、すべて引数の値（%s）', (scope) => {
    const rows = [
      ...change(frozen, '2026-10-26', scope, { title: '新ジム' }),
      ...remove(frozen, '2026-10-26', scope),
    ];
    expect(rows.every(({ editedAt }) => editedAt === EDITED_AT)).toBe(true);
  });
});
