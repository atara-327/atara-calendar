import { describe, expect, it } from 'vitest';
import { makeEntry } from '../../../test/helpers/entries';
import { deleteEntryRequestSchema, patchEntryRequestSchema } from '../../shared/api';
import { addDays } from '../../shared/date';
import {
  InvalidChangeError,
  OccurrenceNotFoundError,
  changeEntry,
  deleteEntry,
  expandOccurrences,
  type Occurrence,
} from '../../shared/recurrence';
import {
  entrySchema,
  type Entry,
  type EntryChanges,
  type Rrule,
  type Scope,
} from '../../shared/schema';
import { assertWritableEntries } from '../../worker/api/entryRules';
import { toChanges } from './build';
import { seriesRruleOf } from './repeat';
import { moveStart } from './schedule';
import { decideScope, type ScopeDecision } from './scope';
import { validateForm } from './validate';
import { editValues, setAllDay, type FormValues } from './values';

// フォームが選べるとした範囲と、サーバーが受け付ける範囲が、食い違わないことを、組み合わせを試して確かめる
// （設計書 11.4）。画面（React）と、Worker・D1 は動かさない。それぞれの「手順」を、同じ行と同じ変更に当てて比べる。
// - フォームの手順: editValues → 編集 → validateForm → toChanges → decideScope（範囲ごとに shared の関数を当てる）。
// - サーバーの手順（worker/api/entries.ts）: 依頼の本文のスキーマ → changeEntry・deleteEntry（RangeError・
//   InvalidChangeError は 400、OccurrenceNotFoundError は 200 の「捨てた」）→ assertWritableEntries（書く行の確認。400）
//   → 書き込みの前の entrySchema の確認。
// 見つけたい食い違いは 2 つ。
// - フォームで選べたのに、サーバーが 4xx にする・捨てる（保存した変更が、画面から消える・黙って消える。設計書 6.2）。
// - フォームが選べないとしたのに、サーバーが受け付ける（選べるはずの範囲を、利用者が選べない）。
// 組み合わせの全部は試さない（CI で数秒で終わる大きさにする）。ルール・形・系列の状態・開く回・編集の、代表を選ぶ。

type ServerOutcome =
  'applied' | 'dropped' | '400:input' | '400:invalid' | '400:range' | '400:rule' | '500:schema';

function serverOutcome(
  rows: readonly Entry[],
  { seriesId, occurrenceDate }: { seriesId: string; occurrenceDate: string },
  scope: Scope,
  changes: EntryChanges | null,
): ServerOutcome {
  const newId = 'new-id-1';
  const editedAt = 9_000_000;
  const body = { occurrenceDate, scope, newId, editedAt };
  const parsed =
    changes === null
      ? deleteEntryRequestSchema.safeParse(body)
      : patchEntryRequestSchema.safeParse({ ...body, changes });
  if (!parsed.success) return '400:input';
  // サーバーが読む行は、系列の行とその例外の行（worker の readSeriesEntries）。
  const entries = rows.filter((row) => row.id === seriesId || row.seriesId === seriesId);
  const target = { seriesId, occurrenceDate };
  let written: Entry[];
  try {
    written =
      changes === null
        ? deleteEntry({ entries, target, scope, newId, editedAt })
        : changeEntry({ entries, target, scope, changes, newId, editedAt });
  } catch (error) {
    if (error instanceof OccurrenceNotFoundError) return 'dropped';
    if (error instanceof InvalidChangeError) return '400:invalid';
    if (error instanceof RangeError) return '400:range';
    throw error;
  }
  try {
    assertWritableEntries(written);
  } catch {
    return '400:rule';
  }
  return written.every((row) => entrySchema.safeParse(row).success) ? 'applied' : '500:schema';
}

// ---- 試す系列の状態 ----

function baseRow(overrides: Partial<Entry>): Entry {
  return makeEntry({
    id: 's1',
    allDay: false,
    startTime: '09:00',
    endTime: '10:00',
    ...overrides,
  });
}

const RULES: readonly (Rrule | null)[] = [
  null,
  { freq: 'daily' },
  { freq: 'weekly', days: [1, 3, 5] },
  { freq: 'weekly', days: [2] },
  { freq: 'monthly' },
  { freq: 'yearly' },
  { freq: 'weekday' },
  { freq: 'holiday' },
];

// 2199-12-24 は、日付の計算が対応する年（〜2199 年）の端に近い。ずらすと 2200 年にかかる。
const STARTS = ['2026-10-19', '2026-01-31', '2028-02-29', '2199-12-24'];

interface Shape {
  name: string;
  /** 終了日は、開始日の何日後か。 */
  endOffset: number;
  overrides: Partial<Entry>;
}

const SHAPES: readonly Shape[] = [
  { name: '時間指定', endOffset: 0, overrides: {} },
  {
    name: '日をまたぐ時間指定',
    endOffset: 1,
    overrides: { startTime: '23:00', endTime: '01:00' },
  },
  {
    name: '複数日の終日',
    endOffset: 2,
    overrides: { allDay: true, startTime: null, endTime: null, notifyOffsetMin: -360 },
  },
  {
    name: '日をまたぐタイムブロック',
    endOffset: 1,
    overrides: {
      kind: 'block',
      workspaceId: null,
      startTime: '22:00',
      endTime: '06:00',
      notifyEnabled: false,
    },
  },
];

const EXCEPTIONS = [
  'なし',
  '別の日に移した回',
  '時刻を変えた回',
  '削除した回',
  'untilDate で切った',
] as const;

interface Case {
  label: string;
  rows: Entry[];
  occurrence: Occurrence;
}

/** 系列の行と、系列の状態（例外・untilDate）を作り、開く回（最初の 3 つの回）を返す。 */
function buildCases(): Case[] {
  const cases: Case[] = [];
  for (const rule of RULES) {
    for (const start of STARTS) {
      if (rule?.freq === 'yearly' && start === '2199-12-24') continue;
      for (const shape of SHAPES) {
        for (const state of EXCEPTIONS) {
          if (rule === null && state !== 'なし') continue;
          const series = baseRow({
            ...shape.overrides,
            rrule: rule,
            startDate: start,
            endDate: addDays(start, shape.endOffset),
          });
          const window = (rows: Entry[]) =>
            expandOccurrences(rows, start, addDays(start, 120)).filter(
              (occurrence) => occurrence.seriesId === 's1',
            );
          let rows = [series];
          const generated = window(rows);
          if (rule !== null && generated.length >= 3) {
            const target = generated[1];
            const third = generated[2];
            if (target === undefined || third === undefined) continue;
            const exception = (overrides: Partial<Entry>) =>
              baseRow({
                ...shape.overrides,
                ...overrides,
                id: 'x1',
                rrule: null,
                seriesId: 's1',
              });
            if (state === '別の日に移した回') {
              rows = [
                series,
                exception({
                  originalDate: target.occurrenceDate,
                  startDate: addDays(target.startDate, 2),
                  endDate: addDays(target.endDate, 2),
                  title: '移した',
                }),
              ];
            } else if (state === '時刻を変えた回' && !series.allDay) {
              rows = [
                series,
                exception({
                  originalDate: target.occurrenceDate,
                  startDate: target.startDate,
                  endDate: target.startDate,
                  startTime: '14:00',
                  endTime: '15:00',
                  title: '時刻',
                }),
              ];
            } else if (state === '削除した回') {
              rows = [
                series,
                exception({
                  originalDate: third.occurrenceDate,
                  startDate: third.startDate,
                  endDate: third.endDate,
                  cancelled: true,
                }),
              ];
            } else if (state === 'untilDate で切った') {
              rows = [
                { ...series, untilDate: generated[generated.length - 1]?.occurrenceDate ?? null },
              ];
            }
          } else if (state !== 'なし') {
            continue;
          }
          for (const occurrence of window(rows).slice(0, 3)) {
            cases.push({
              label: `${JSON.stringify(rule)} ${start} ${shape.name} ${state} ${occurrence.occurrenceDate}`,
              rows,
              occurrence,
            });
          }
        }
      }
    }
  }
  return cases;
}

// ---- 試す編集 ----

type Edit = { name: string; apply: (values: FormValues) => FormValues };

const later = (days: number): Edit => ({
  name: `日付を ${String(days)} 日ずらす`,
  apply: (v) => moveStart(v, { startDate: addDays(v.startDate, days) }),
});

const RULE_EDITS: readonly Edit[] = [
  { name: 'ルールをなくす', apply: (v) => ({ ...v, repeat: 'none' }) },
  { name: 'ルールを毎日へ', apply: (v) => ({ ...v, repeat: 'daily' }) },
  { name: 'ルールを毎月へ', apply: (v) => ({ ...v, repeat: 'monthly' }) },
  { name: 'ルールを毎年へ', apply: (v) => ({ ...v, repeat: 'yearly' }) },
  { name: 'ルールを平日へ', apply: (v) => ({ ...v, repeat: 'weekday' }) },
  { name: 'ルールを休日へ', apply: (v) => ({ ...v, repeat: 'holiday' }) },
  { name: '毎週（日）へ', apply: (v) => ({ ...v, repeat: 'weekly', repeatDays: [0] }) },
  { name: '毎週（開始日の曜日）へ', apply: (v) => ({ ...v, repeat: 'weekly', repeatDays: null }) },
  {
    name: '毎週（月・水・金。並びを入れ替える）へ',
    apply: (v) => ({ ...v, repeat: 'weekly', repeatDays: [5, 1, 3] }),
  },
];

const DATE_EDITS: readonly Edit[] = [later(-1), later(1), later(7), later(30)];

const SINGLE_EDITS: readonly Edit[] = [
  { name: '題名', apply: (v) => ({ ...v, title: '変更後' }) },
  {
    name: '時刻',
    apply: (v) => (v.allDay ? v : moveStart(v, { startTime: '13:00' })),
  },
  { name: '終了日を 1 日延ばす', apply: (v) => ({ ...v, endDate: addDays(v.endDate, 1) }) },
  {
    name: '終日を切り替える',
    apply: (v) => (v.kind === 'block' ? v : setAllDay(v, !v.allDay)),
  },
  ...RULE_EDITS,
  ...DATE_EDITS,
];

const COMBINED_EDITS: readonly Edit[] = [
  // ルールと日付を同時に変える。毎日・平日・休日は、日付をずらせない（Q3）。ほかは、ずらせる。
  ...RULE_EDITS.flatMap((rule) =>
    [later(1), later(7)].map((date) => ({
      name: `${rule.name} + ${date.name}`,
      apply: (v: FormValues) => rule.apply(date.apply(v)),
    })),
  ),
  ...[later(1), later(30)].map((date) => ({
    name: `題名 + ${date.name}`,
    apply: (v: FormValues) => date.apply({ ...v, title: '変更後' }),
  })),
  {
    name: `時刻 + ${later(1).name}`,
    apply: (v) => later(1).apply(v.allDay ? v : moveStart(v, { startTime: '13:00' })),
  },
];

const NOW = Date.UTC(2026, 9, 22, 5, 20);

// ---- 総当たり ----

interface Result {
  stats: Map<string, number>;
  /** フォームで選べたのに、サーバーが受け付けなかった。 */
  rejected: string[];
  /** フォームが選べないとしたのに、サーバーが受け付けた。 */
  missed: string[];
  /** ルールと日付の同時の変更とした理由が、サーバーの結果（InvalidChangeError の 400）と合わない。 */
  wrongReason: string[];
}

function offered(decision: ScopeDecision): Scope[] {
  if (decision.kind === 'choose') return [...decision.scopes];
  return decision.kind === 'single' ? ['all'] : [];
}

let cachedResult: Result | null = null;

function run(): Result {
  if (cachedResult !== null) return cachedResult;
  const result: Result = { stats: new Map(), rejected: [], missed: [], wrongReason: [] };
  const count = (key: string) => {
    result.stats.set(key, (result.stats.get(key) ?? 0) + 1);
  };

  for (const { label, rows, occurrence } of buildCases()) {
    const target = { seriesId: occurrence.seriesId, occurrenceDate: occurrence.occurrenceDate };
    const seriesRule = seriesRruleOf(
      new Map(rows.map((row) => [row.id, row])),
      occurrence.seriesId,
    );
    const opened = editValues(occurrence, NOW, seriesRule);

    // 比べる。選べた範囲を、サーバーが受け付ける。選べなかった範囲は、受け付けない。
    const compare = (what: string, decision: ScopeDecision, changes: EntryChanges | null) => {
      const scopes = offered(decision);
      for (const scope of ['this', 'following', 'all'] as const) {
        const outcome = serverOutcome(rows, target, scope, changes);
        if (scopes.includes(scope) && outcome !== 'applied') {
          result.rejected.push(`${label} ${what} ${scope}: ${outcome}`);
        }
        // 繰り返さない予定は、範囲を聞かない（'all' だけを送る）。ほかの範囲は、比べない。
        if (occurrence.recurring && !scopes.includes(scope) && outcome === 'applied') {
          result.missed.push(`${label} ${what} ${scope}: ${JSON.stringify(decision)}`);
        }
        if (
          decision.kind === 'unavailable' &&
          decision.reason === 'ruleAndDate' &&
          scope !== 'this' &&
          outcome !== '400:invalid'
        ) {
          result.wrongReason.push(`${label} ${what} ${scope}: ${outcome}`);
        }
      }
    };

    const deleteDecision = decideScope({ rows, occurrence, action: { kind: 'delete' } });
    count(`削除: ${deleteDecision.kind}`);
    compare('削除', deleteDecision, null);

    for (const edit of [...SINGLE_EDITS, ...COMBINED_EDITS]) {
      const values = edit.apply(opened);
      // フォームが保存できない入力（確認の誤り）は、送らない。
      if (Object.keys(validateForm(values, occurrence)).length > 0) {
        count('フォームの確認で止まる');
        continue;
      }
      const changes = toChanges(values, occurrence, seriesRule);
      if (Object.keys(changes).length === 0) continue;
      const decision = decideScope({
        rows,
        occurrence,
        action: { kind: 'change', changes },
      });
      count(
        `変更: ${decision.kind}${decision.kind === 'unavailable' ? `:${decision.reason}` : ''}`,
      );
      compare(edit.name, decision, changes);
    }
  }
  cachedResult = result;
  return result;
}

describe('フォームが選べるとした範囲と、サーバーが受け付ける範囲が、食い違わない', () => {
  it('フォームで選べた範囲は、サーバーが受け付ける（4xx にも、「捨てた」にもならない）', () => {
    expect(run().rejected).toEqual([]);
  }, 60_000);

  it('フォームが選べないとした範囲は、サーバーも受け付けない', () => {
    expect(run().missed).toEqual([]);
  }, 60_000);

  it('ルールと日付の同時の変更とした理由は、サーバーも、InvalidChangeError で 400 にする', () => {
    expect(run().wrongReason).toEqual([]);
  }, 60_000);

  it('試した組み合わせに、すべての種類の結果が含まれている（空振りでない）', () => {
    const { stats } = run();
    const at = (key: string) => stats.get(key) ?? 0;

    expect(at('変更: choose')).toBeGreaterThan(1000);
    expect(at('変更: single')).toBeGreaterThan(100);
    expect(at('変更: unavailable:ruleAndDate')).toBeGreaterThan(10);
    expect(at('変更: unavailable:other')).toBeGreaterThan(10);
    expect(at('削除: choose')).toBeGreaterThan(100);
    expect(at('削除: single')).toBeGreaterThan(10);
  }, 60_000);
});

describe('対象がもうないとき（ほかの端末で、系列・その回が変更・削除された）も、食い違わない', () => {
  const series = baseRow({ rrule: { freq: 'weekly', days: [1, 3, 5] }, startDate: '2026-10-19' });
  // 開いた回は、2026-10-21（水）。
  const occurrence = expandOccurrences([series], '2026-10-21', '2026-10-21')[0];
  if (occurrence === undefined) throw new Error('回がありません');

  const stale: readonly { name: string; rows: Entry[] }[] = [
    { name: '系列を削除した', rows: [{ ...series, deletedAt: 5000 }] },
    { name: '系列の行がない', rows: [] },
    { name: '開いた回の前で、系列を切った', rows: [{ ...series, untilDate: '2026-10-20' }] },
    {
      name: '開いた回を、削除した',
      rows: [
        series,
        baseRow({
          id: 'x1',
          rrule: null,
          seriesId: 's1',
          originalDate: '2026-10-21',
          startDate: '2026-10-21',
          cancelled: true,
        }),
      ],
    },
  ];

  it.each(stale)('$name: 変更は、どの範囲も受け付けられず、サーバーは捨てる', ({ rows }) => {
    const changes = { title: '変更後' };
    const decision = decideScope({ rows, occurrence, action: { kind: 'change', changes } });
    const outcomes = (['this', 'following', 'all'] as const).map((scope) =>
      serverOutcome(rows, occurrence, scope, changes),
    );

    expect(decision).toEqual({ kind: 'gone' });
    // 対象がないのは、どれかの範囲が捨てられることと同じ（サーバーが 200 の「捨てた」にする）。
    expect(outcomes).toContain('dropped');
  });

  it.each(stale)('$name: 削除の結果と、サーバーの結果が、合う', ({ rows }) => {
    const decision = decideScope({ rows, occurrence, action: { kind: 'delete' } });
    const outcomes = (['this', 'following', 'all'] as const).map((scope) =>
      serverOutcome(rows, occurrence, scope, null),
    );

    // 対象がない（gone）のは、どれかの範囲が捨てられるときだけ。そうでなければ、選べる範囲を聞く。
    expect(decision.kind === 'gone').toBe(outcomes.includes('dropped'));
  });
});
