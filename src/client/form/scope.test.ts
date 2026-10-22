import { describe, expect, it } from 'vitest';
import { deepFreeze, makeEntry } from '../../../test/helpers/entries';
import { addDays, dayOfWeek } from '../../shared/date';
import { expandOccurrences } from '../../shared/recurrence';
import type { Entry, EntryChanges, Rrule, Scope } from '../../shared/schema';
import {
  decideScope,
  recheckScope,
  seriesAfterChange,
  type ScopeAction,
  type ScopeDecision,
} from './scope';

// 変更・削除の範囲の、選べるものを決める（設計書 4.5・11.4）。
// 決め方は、shared の changeEntry・deleteEntry を、範囲ごとに実際に当てること。ここでは、その結果が、
// 設計書 4.5・11.4 の決まりのとおりになることを、事例で確かめる（決まりそのものは、shared のテストにある）。

// 2026-10-19 は月曜。毎日の系列 s1 は、この日から始まる。
const MONDAY = '2026-10-19';
const WEDNESDAY = '2026-10-21';

function daily(overrides: Partial<Entry> = {}): Entry {
  return makeEntry({
    id: 's1',
    title: '毎日',
    allDay: false,
    startTime: '09:00',
    endTime: '10:00',
    rrule: { freq: 'daily' },
    startDate: MONDAY,
    ...overrides,
  });
}

function weekly(days: number[], overrides: Partial<Entry> = {}): Entry {
  return daily({ title: '毎週', rrule: { freq: 'weekly', days }, ...overrides });
}

/**
 * 月表示が持つ、回の日付（occurrenceDate）の回（押したときに、フォームへ渡す回）。
 * 別の日に移した例外の回は、移した先の日に出るので、前後の 1 週間から探す。
 */
function occurrenceOn(rows: readonly Entry[], date: string, seriesId = 's1') {
  const found = expandOccurrences(rows, addDays(date, -7), addDays(date, 7)).find(
    (occurrence) => occurrence.seriesId === seriesId && occurrence.occurrenceDate === date,
  );
  if (found === undefined) throw new Error(`${date} の回がありません`);
  return found;
}

function decideChange(
  rows: readonly Entry[],
  date: string,
  changes: EntryChanges,
  seriesId = 's1',
): ScopeDecision {
  return decideScope({
    rows: deepFreeze([...rows]),
    occurrence: occurrenceOn(rows, date, seriesId),
    action: { kind: 'change', changes },
  });
}

function decideDelete(rows: readonly Entry[], date: string, seriesId = 's1'): ScopeDecision {
  return decideScope({
    rows: deepFreeze([...rows]),
    occurrence: occurrenceOn(rows, date, seriesId),
    action: { kind: 'delete' },
  });
}

const ALL_SCOPES = { kind: 'choose', scopes: ['this', 'following', 'all'] } as const;

describe('繰り返さない予定は、範囲を聞かない（設計書 4.5）', () => {
  const single = makeEntry({ id: 'e1', startDate: MONDAY });

  it('変更も、削除も、範囲を聞かない', () => {
    expect(decideChange([single], MONDAY, { title: '変更' }, 'e1')).toEqual({ kind: 'single' });
    expect(decideDelete([single], MONDAY, 'e1')).toEqual({ kind: 'single' });
  });

  it('ルールを付けて繰り返す予定にするときも、聞かない', () => {
    expect(decideChange([single], MONDAY, { rrule: { freq: 'weekday' } }, 'e1')).toEqual({
      kind: 'single',
    });
  });

  it('ルールを付けると、開始日が、2199 年の外にずれるときは、保存できない（サーバーが 400 にする）', () => {
    const last = makeEntry({ id: 'e1', startDate: '2199-12-31' });

    expect(decideChange([last], '2199-12-31', { rrule: { freq: 'weekday' } }, 'e1')).toEqual({
      kind: 'unavailable',
      reason: 'other',
    });
    expect(
      decideChange([last], '2199-12-31', { rrule: { freq: 'weekly', days: [1] } }, 'e1'),
    ).toEqual({ kind: 'unavailable', reason: 'other' });
  });

  it('予定が、ほかの端末で削除されたあと（行が削除済み）は、対象がない', () => {
    const gone = makeEntry({ id: 'e1', startDate: MONDAY, deletedAt: 5000 });
    const occurrence = { seriesId: 'e1', occurrenceDate: MONDAY, recurring: false };

    expect(decideScope({ rows: [gone], occurrence, action: { kind: 'delete' } })).toEqual({
      kind: 'gone',
    });
    expect(
      decideScope({
        rows: [gone],
        occurrence,
        action: { kind: 'change', changes: { title: '変更' } },
      }),
    ).toEqual({ kind: 'gone' });
  });
});

describe('変更: 選べる範囲は、変えた内容で絞る（設計書 4.5・11.4）', () => {
  it('題名だけを変えたら、3 つとも選べる', () => {
    expect(decideChange([daily()], WEDNESDAY, { title: '変更' })).toEqual(ALL_SCOPES);
  });

  it('時刻や通知だけを変えても、3 つとも選べる', () => {
    expect(decideChange([daily()], WEDNESDAY, { startTime: '10:00', endTime: '11:00' })).toEqual(
      ALL_SCOPES,
    );
  });

  it('ルールを変えたら、「この予定のみ」は出さない（例外の行は、ルールを持たない）', () => {
    const rows = [weekly([1, 3])];

    expect(decideChange(rows, WEDNESDAY, { rrule: { freq: 'weekly', days: [1, 3, 5] } })).toEqual({
      kind: 'choose',
      scopes: ['following', 'all'],
    });
  });

  it('曜日の並びだけを変えても、ルールを変えたことにならない（3 つとも選べる）', () => {
    const rows = [weekly([1, 3])];

    expect(decideChange(rows, WEDNESDAY, { rrule: { freq: 'weekly', days: [3, 1] } })).toEqual(
      ALL_SCOPES,
    );
  });

  it('ルールをなくして、繰り返さない予定にするときも、「この予定のみ」は出さない', () => {
    expect(decideChange([daily()], WEDNESDAY, { rrule: null })).toEqual({
      kind: 'choose',
      scopes: ['following', 'all'],
    });
  });

  it('毎日の予定の日付を変えたら、「この予定のみ」だけ（毎日は、開始日をずらせない）', () => {
    expect(
      decideChange([daily()], WEDNESDAY, { startDate: '2026-10-23', endDate: '2026-10-23' }),
    ).toEqual({ kind: 'choose', scopes: ['this'] });
  });

  it.each<[string, Rrule]>([
    ['平日', { freq: 'weekday' }],
    ['休日', { freq: 'holiday' }],
  ])('%s の予定の日付を変えたら、「この予定のみ」だけ', (_name, rrule) => {
    // 水曜の回（平日）。休日のルールには、水曜の回がない（祝日でなければ）ので、土曜の回を使う。
    const date = rrule.freq === 'weekday' ? WEDNESDAY : '2026-10-24';
    const rows = [daily({ rrule, startDate: rrule.freq === 'weekday' ? MONDAY : '2026-10-17' })];

    expect(decideChange(rows, date, { startDate: '2026-10-26', endDate: '2026-10-26' })).toEqual({
      kind: 'choose',
      scopes: ['this'],
    });
  });

  it('毎週・毎月・毎年の予定の日付を変えたら、3 つとも選べる（開始日をずらせる）', () => {
    const changes = { startDate: '2026-10-22', endDate: '2026-10-22' };

    expect(decideChange([weekly([3])], WEDNESDAY, changes)).toEqual(ALL_SCOPES);
    expect(
      decideChange(
        [daily({ rrule: { freq: 'monthly' }, startDate: '2026-10-21' })],
        WEDNESDAY,
        changes,
      ),
    ).toEqual(ALL_SCOPES);
    expect(
      decideChange(
        [daily({ rrule: { freq: 'yearly' }, startDate: '2026-10-21' })],
        WEDNESDAY,
        changes,
      ),
    ).toEqual(ALL_SCOPES);
  });

  describe('毎日・平日・休日に変えて、日付も同時に変えたら、どの範囲も選べない（実装 #8 の確認 Q3）', () => {
    const dateChange = { startDate: '2026-10-22', endDate: '2026-10-22' };

    it.each<[string, Rrule]>([
      ['毎日', { freq: 'daily' }],
      ['平日', { freq: 'weekday' }],
      ['休日', { freq: 'holiday' }],
    ])('毎週を、%s に変えて、日付も変える', (_name, rrule) => {
      expect(decideChange([weekly([3])], WEDNESDAY, { rrule, ...dateChange })).toEqual({
        kind: 'unavailable',
        reason: 'ruleAndDate',
      });
    });

    it('毎日を、平日に変えて、日付も変える', () => {
      expect(
        decideChange([daily()], WEDNESDAY, { rrule: { freq: 'weekday' }, ...dateChange }),
      ).toEqual({ kind: 'unavailable', reason: 'ruleAndDate' });
    });

    it('片方ずつなら、選べる（ルールだけ変える・日付だけ変える）', () => {
      const rows = [weekly([3])];

      expect(decideChange(rows, WEDNESDAY, { rrule: { freq: 'daily' } })).toEqual({
        kind: 'choose',
        scopes: ['following', 'all'],
      });
      expect(decideChange(rows, WEDNESDAY, dateChange)).toEqual(ALL_SCOPES);
    });

    it('毎日・平日・休日でなく、毎週・毎月・毎年に変えて、日付も変えるなら、選べる', () => {
      expect(
        decideChange([daily()], WEDNESDAY, { rrule: { freq: 'monthly' }, ...dateChange }),
      ).toEqual({ kind: 'choose', scopes: ['following', 'all'] });
    });
  });

  describe('最初の回', () => {
    it('最初の回の「これ以降すべて」は、「すべて」と同じ（系列を切らない）ので、選べる', () => {
      expect(decideChange([daily()], MONDAY, { title: '変更' })).toEqual(ALL_SCOPES);
    });

    it('最初の回でルールを変えても、「これ以降すべて」と「すべて」を選べる', () => {
      expect(
        decideChange([weekly([1, 3])], MONDAY, { rrule: { freq: 'weekly', days: [1] } }),
      ).toEqual({ kind: 'choose', scopes: ['following', 'all'] });
    });
  });

  describe('例外の回（別の日に移した回。回の日付は、元の日付）', () => {
    // 10-21 の回を、10-23 に移して、題名を変えた例外の行。
    const exception = makeEntry({
      id: 'x1',
      title: '移した回',
      allDay: false,
      startTime: '09:00',
      endTime: '10:00',
      seriesId: 's1',
      originalDate: WEDNESDAY,
      startDate: '2026-10-23',
    });
    const rows = [daily(), exception];

    it('題名を変えたら、3 つとも選べる', () => {
      expect(decideChange(rows, WEDNESDAY, { title: '変更' })).toEqual(ALL_SCOPES);
    });

    it('ルールを変えたら、「この予定のみ」は出さない（例外の回も、系列のルールを変える）', () => {
      expect(decideChange(rows, WEDNESDAY, { rrule: { freq: 'weekday' } })).toEqual({
        kind: 'choose',
        scopes: ['following', 'all'],
      });
    });

    it('毎日の予定の例外の回は、日付を変えるなら「この予定のみ」だけ', () => {
      expect(
        decideChange(rows, WEDNESDAY, { startDate: '2026-10-25', endDate: '2026-10-25' }),
      ).toEqual({
        kind: 'choose',
        scopes: ['this'],
      });
    });
  });

  describe('対象がもうない（ほかの端末で変更・削除された）', () => {
    it('その回を、ほかの端末で削除したあと（例外の行が cancelled）は、対象がない', () => {
      const cancelled = makeEntry({
        id: 'x1',
        seriesId: 's1',
        originalDate: WEDNESDAY,
        startDate: WEDNESDAY,
        cancelled: true,
      });
      const occurrence = { seriesId: 's1', occurrenceDate: WEDNESDAY, recurring: true };

      expect(
        decideScope({
          rows: [daily(), cancelled],
          occurrence,
          action: { kind: 'change', changes: { title: '変更' } },
        }),
      ).toEqual({ kind: 'gone' });
    });

    it('系列を、ほかの端末で削除したあと（行が削除済み・行がない）は、対象がない', () => {
      const occurrence = { seriesId: 's1', occurrenceDate: WEDNESDAY, recurring: true };
      const action: ScopeAction = { kind: 'change', changes: { title: '変更' } };

      expect(decideScope({ rows: [daily({ deletedAt: 5000 })], occurrence, action })).toEqual({
        kind: 'gone',
      });
      expect(decideScope({ rows: [], occurrence, action })).toEqual({ kind: 'gone' });
    });

    it('系列を「これ以降すべて」で切られて、その回がなくなったあとも、対象がない', () => {
      const cut = daily({ untilDate: '2026-10-20' });
      const occurrence = { seriesId: 's1', occurrenceDate: WEDNESDAY, recurring: true };

      expect(
        decideScope({
          rows: [cut],
          occurrence,
          action: { kind: 'change', changes: { title: '変更' } },
        }),
      ).toEqual({ kind: 'gone' });
    });
  });

  describe('日付の計算が、対応する年（1900〜2199 年）を出る', () => {
    it('毎日を平日に変えるとき、最初の回が 2199-12-31 なら、どの範囲も選べない（理由は汎用）', () => {
      // 2199-12-31 は年末年始（休日）。平日にずらす途中で、2200 年の祝日の計算に入り、例外を投げる。
      const rows = [daily({ startDate: '2199-12-31' })];

      expect(decideChange(rows, '2199-12-31', { rrule: { freq: 'weekday' } })).toEqual({
        kind: 'unavailable',
        reason: 'other',
      });
    });

    // 入力の範囲（1900〜2199 年）に収まる日付への変更で、結果の日付だけが 2200 年にずれる例。
    // 毎週の曜日を別の曜日に変えて、日付を 2199-12-31 にする。2199-12-31 から、その曜日へずらすと、2200 年になる。
    function otherDay(date: string): number {
      return dayOfWeek(date) === 1 ? 2 : 1;
    }

    it('ルールを変えて、日付を 2199-12-31 にすると、新しい系列の開始日が 2200 年にずれる「これ以降すべて」は選べない。「すべて」は、選べる', () => {
      // 毎週（2199-12-24 の曜日）。12-24 の回の日付を、1 週間後の 12-31 にして、曜日も変える。
      const rows = [weekly([dayOfWeek('2199-12-24')], { startDate: '2199-12-10' })];
      const changes = {
        rrule: { freq: 'weekly', days: [otherDay('2199-12-24')] } satisfies Rrule,
        startDate: '2199-12-31',
        endDate: '2199-12-31',
      };

      // 「すべて」は、系列の開始日を、1 週間後の 2199-12-17 にして、曜日に合わせるだけで、2199 年に収まる。
      expect(decideChange(rows, '2199-12-24', changes)).toEqual({
        kind: 'choose',
        scopes: ['all'],
      });
    });

    it('どの範囲も、最初の回が 2200 年にずれるなら、選べない。理由は汎用（ルールと日付の同時の変更ではない）', () => {
      const rows = [weekly([dayOfWeek('2199-12-24')], { startDate: '2199-12-24' })];
      const changes = {
        rrule: { freq: 'weekly', days: [otherDay('2199-12-24')] } satisfies Rrule,
        startDate: '2199-12-31',
        endDate: '2199-12-31',
      };

      expect(decideChange(rows, '2199-12-24', changes)).toEqual({
        kind: 'unavailable',
        reason: 'other',
      });
    });
  });

  describe('どの範囲も選べない理由が、ルールと日付の同時の変更でないとき（汎用の文言）', () => {
    it('日付を変えて、1 回の長さが変わり、時間が合わなくなるときは、日付を外すと通っても、汎用', () => {
      // 毎日 22:00〜翌 06:00 のタイムブロックの、10/20 の回を、「この予定のみ」で 13:00〜15:00 にした例外の回を開く。
      // その回で、毎週に変え、日付を 10/21 にする。日付を変えたので、1 回の長さが、その回の長さ（同じ日の 2 時間）になり、
      // 系列の 22:00〜06:00 に当てると、終了が開始より前になる。日付を外すと通るが、原因は、ルールと日付の同時の変更ではない。
      const series = daily({
        id: 's1',
        kind: 'block',
        workspaceId: null,
        title: '睡眠',
        startTime: '22:00',
        endTime: '06:00',
        endDate: addDays(MONDAY, 1),
        notifyEnabled: false,
      });
      const exception = makeEntry({
        id: 'x1',
        kind: 'block',
        workspaceId: null,
        title: '睡眠',
        allDay: false,
        startTime: '13:00',
        endTime: '15:00',
        seriesId: 's1',
        originalDate: '2026-10-20',
        startDate: '2026-10-20',
        notifyEnabled: false,
      });

      expect(
        decideChange([series, exception], '2026-10-20', {
          rrule: { freq: 'weekly', days: [3] },
          startDate: '2026-10-21',
          endDate: '2026-10-21',
        }),
      ).toEqual({ kind: 'unavailable', reason: 'other' });
      // 日付を外せば、通る（原因が、日付の変更にあることの確認）。
      expect(
        decideChange([series, exception], '2026-10-20', { rrule: { freq: 'weekly', days: [3] } }),
      ).toEqual({ kind: 'choose', scopes: ['following', 'all'] });
    });
  });
});

describe('削除: 範囲', () => {
  it('3 つとも選べる', () => {
    expect(decideDelete([daily()], WEDNESDAY)).toEqual(ALL_SCOPES);
  });

  it('最初の回の「これ以降すべて」は、「すべて」と同じ（系列を切らない）ので、選べる', () => {
    expect(decideDelete([daily()], MONDAY)).toEqual(ALL_SCOPES);
  });

  it('例外の回も、3 つとも選べる', () => {
    const exception = makeEntry({
      id: 'x1',
      seriesId: 's1',
      originalDate: WEDNESDAY,
      startDate: '2026-10-23',
    });

    expect(decideDelete([daily(), exception], WEDNESDAY)).toEqual(ALL_SCOPES);
  });

  it('系列を、ほかの端末で削除したあとは、対象がない', () => {
    const occurrence = { seriesId: 's1', occurrenceDate: WEDNESDAY, recurring: true };

    expect(
      decideScope({ rows: [daily({ deletedAt: 5000 })], occurrence, action: { kind: 'delete' } }),
    ).toEqual({ kind: 'gone' });
  });
});

describe('ほかの系列の行は、見ない', () => {
  it('系列の行と、その例外の行だけを使う（ほかの予定の行があっても、結果は変わらない）', () => {
    const other = makeEntry({ id: 's2', rrule: { freq: 'daily' }, startDate: MONDAY });
    const otherException = makeEntry({
      id: 'x9',
      seriesId: 's2',
      originalDate: WEDNESDAY,
      startDate: WEDNESDAY,
      cancelled: true,
    });

    expect(decideChange([other, otherException, daily()], WEDNESDAY, { title: '変更' })).toEqual(
      ALL_SCOPES,
    );
  });
});

describe('範囲を選んで送るときの、もう一度の確認（ほかの端末の変更が、範囲を聞く段の間に届いたとき）', () => {
  const dateChange = { startDate: '2026-10-22', endDate: '2026-10-22' };
  const occurrence = { seriesId: 's1', occurrenceDate: WEDNESDAY, recurring: true };
  const change: ScopeAction = { kind: 'change', changes: dateChange };

  it('何も変わっていなければ、選んだ範囲を送ってよい', () => {
    const rows = [weekly([3])];

    expect(recheckScope({ rows, occurrence, action: change, selected: 'all' })).toEqual({
      kind: 'proceed',
    });
  });

  it('ほかの端末が、毎週を毎日に変えて、日付を動かす「すべて」が選べなくなったら、範囲を選び直す', () => {
    // 範囲の段を出したときは、毎週で、3 つとも選べた。その後、毎日に変わった（毎日は、日付をずらせない）。
    expect(decideScope({ rows: [weekly([3])], occurrence, action: change })).toEqual(ALL_SCOPES);
    const rows = [daily()];

    expect(recheckScope({ rows, occurrence, action: change, selected: 'all' })).toEqual({
      kind: 'changed',
    });
    expect(recheckScope({ rows, occurrence, action: change, selected: 'this' })).toEqual({
      kind: 'proceed',
    });
  });

  it('ほかの端末が、系列を削除したら、対象がないとして、保存しない', () => {
    expect(
      recheckScope({
        rows: [weekly([3], { deletedAt: 5000 })],
        occurrence,
        action: change,
        selected: 'this',
      }),
    ).toEqual({ kind: 'rejected', decision: { kind: 'gone' } });
  });

  it('削除も、同じく確かめる（系列が削除されていたら、対象がない）', () => {
    expect(
      recheckScope({
        rows: [daily({ deletedAt: 5000 })],
        occurrence,
        action: { kind: 'delete' },
        selected: 'all',
      }),
    ).toEqual({ kind: 'rejected', decision: { kind: 'gone' } });
    expect(
      recheckScope({ rows: [daily()], occurrence, action: { kind: 'delete' }, selected: 'all' }),
    ).toEqual({ kind: 'proceed' });
  });

  it('ほかの端末が、ルールを変えたあとに、変えていないルールを含む変更は、「この予定のみ」が選べなくなる', () => {
    // 系列を、毎週（水）から毎週（水・金）にされた。こちらは、毎週（水）のままの値で、題名だけを変える。
    // ルールは changes に入れていない（変えていない）ので、「この予定のみ」は、そのまま選べる。
    expect(
      recheckScope({
        rows: [weekly([3, 5])],
        occurrence,
        action: { kind: 'change', changes: { title: '変更' } },
        selected: 'this',
      }),
    ).toEqual({ kind: 'proceed' });
  });
});

describe('範囲ごとの、保存したあとの系列（範囲を聞く段で、保存後の説明を出すのに使う）', () => {
  function after(rows: readonly Entry[], date: string, changes: EntryChanges, scope: Scope) {
    return seriesAfterChange({
      rows: deepFreeze([...rows]),
      occurrence: occurrenceOn(rows, date),
      changes,
      scope,
    });
  }

  it('毎週（月）・開始 2026-01-05 の系列の 3/9 の回を毎月に変える: 「すべて」は、系列の開始日（1/5）の毎月 5 日。「これ以降すべて」は、その回の日付の毎月 9 日', () => {
    const rows = [weekly([1], { startDate: '2026-01-05' })];
    const changes = { rrule: { freq: 'monthly' } satisfies Rrule };

    expect(after(rows, '2026-03-09', changes, 'all')).toEqual({
      rrule: { freq: 'monthly' },
      startDate: '2026-01-05',
    });
    expect(after(rows, '2026-03-09', changes, 'following')).toEqual({
      rrule: { freq: 'monthly' },
      startDate: '2026-03-09',
    });
    expect(after(rows, '2026-03-09', changes, 'this')).toBeNull();
  });

  it('毎月 15 日の系列の 3/15 の回の日付を 3/20 にする: 「これ以降すべて」は 3/20 の毎月 20 日。「すべて」は、系列の開始日に 5 日足した 1/20 の毎月 20 日', () => {
    const rows = [daily({ rrule: { freq: 'monthly' }, startDate: '2026-01-15' })];
    const changes = { startDate: '2026-03-20', endDate: '2026-03-20' };

    expect(after(rows, '2026-03-15', changes, 'following')).toEqual({
      rrule: { freq: 'monthly' },
      startDate: '2026-03-20',
    });
    expect(after(rows, '2026-03-15', changes, 'all')).toEqual({
      rrule: { freq: 'monthly' },
      startDate: '2026-01-20',
    });
  });

  it('開始日がルールに合わなければ、合う最初の日にずれた結果を返す（毎日の系列の水曜の回を、毎週の月曜・金曜にする「これ以降すべて」は、金曜）', () => {
    const rows = [daily()];
    const changes = { rrule: { freq: 'weekly', days: [1, 5] } satisfies Rrule };

    expect(after(rows, WEDNESDAY, changes, 'following')).toEqual({
      rrule: { freq: 'weekly', days: [1, 5] },
      startDate: '2026-10-23',
    });
  });

  it('ルールをなくすと、ルールは null（繰り返さない予定になる）', () => {
    expect(after([daily()], WEDNESDAY, { rrule: null }, 'all')).toMatchObject({ rrule: null });
  });

  it('最初の回の「これ以降すべて」は、「すべて」と同じ結果（元の系列の行）', () => {
    const changes = { rrule: { freq: 'weekly', days: [1] } satisfies Rrule };

    expect(after([daily()], MONDAY, changes, 'following')).toEqual(
      after([daily()], MONDAY, changes, 'all'),
    );
  });
});
