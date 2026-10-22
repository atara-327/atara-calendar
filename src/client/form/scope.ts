import { entryProblem } from '../../shared/entryRules';
import {
  InvalidChangeError,
  OccurrenceNotFoundError,
  changeEntry,
  deleteEntry,
  type Occurrence,
} from '../../shared/recurrence';
import type { Entry, EntryChanges, Scope } from '../../shared/schema';

// 変更・削除の範囲（「この予定のみ／これ以降すべて／すべて」。要件 RP-4）の、選べるものを決める（設計書 11.4）。
//
// 決め方は、範囲ごとに、shared の changeEntry（削除なら deleteEntry）を、手元の行に実際に当ててみること。
// 画面に決まり（ルールを変えたら「この予定のみ」は出さない、毎日・平日・休日は日付をずらせない、など）を書き写さない。
// Why: サーバーも同じ関数で、受け付けるかを決める。フォームで選べた範囲が、サーバーで 4xx になることはない。
// 4xx の依頼は、端末が捨てるので、保存した変更が画面から消える（設計書 6.2）。書き写すと、片方だけを直して食い違う。
// 結果の行は捨てる（当てるのは確かめるためだけ）ので、新しい行の id と編集時刻は、仮の値でよい。
//
// サーバーは、計算した行に、項目をまたぐ確認（entryProblem）も当てて、守られていなければ 400 にする
// （worker/api/entryRules.ts）。ここでも同じ確認をして、日付が 1900〜2199 年の外にずれる範囲を、選べないものにする。

const TRIAL_NEW_ID = 'trial-new-id';
const TRIAL_EDITED_AT = 0;

/** 画面に出す順。 */
const SCOPE_ORDER: readonly Scope[] = ['this', 'following', 'all'];

export type ScopeAction = { kind: 'change'; changes: EntryChanges } | { kind: 'delete' };

/** 選べない理由。ruleAndDate は、ルールを変えて、日付も同時に変えたこと（片方ずつなら、保存できる）。 */
export type UnavailableReason = 'ruleAndDate' | 'other';

export type ScopeDecision =
  /** 繰り返さない予定。範囲を聞かずに、書き換える（設計書 4.5。ルールを付けて、繰り返す予定にする場合も含む）。 */
  | { kind: 'single' }
  /** 選べる範囲（1 つだけのときも、聞く）。「この予定のみ」「これ以降すべて」「すべて」の順。 */
  | { kind: 'choose'; scopes: readonly [Scope, ...Scope[]] }
  /** どの範囲も、受け付けられない。保存しない。 */
  | { kind: 'unavailable'; reason: UnavailableReason }
  /** 対象の予定・回が、もうない（開いている間に、ほかの端末で変更・削除された）。保存しない。 */
  | { kind: 'gone' };

type Trial = 'accepted' | 'rejected' | 'gone';

function trial(
  seriesRows: readonly Entry[],
  target: { seriesId: string; occurrenceDate: string },
  scope: Scope,
  action: ScopeAction,
): Trial {
  try {
    const written =
      action.kind === 'change'
        ? changeEntry({
            entries: seriesRows,
            target,
            scope,
            changes: action.changes,
            newId: TRIAL_NEW_ID,
            editedAt: TRIAL_EDITED_AT,
          })
        : deleteEntry({
            entries: seriesRows,
            target,
            scope,
            newId: TRIAL_NEW_ID,
            editedAt: TRIAL_EDITED_AT,
          });
    // 削除する行は、確かめない（worker/api/entryRules.ts と同じ。確かめると、決まりが厳しくなる前の行を削除できない）。
    const ok = written.every((row) => row.deletedAt !== null || entryProblem(row) === null);
    return ok ? 'accepted' : 'rejected';
  } catch (error) {
    if (error instanceof OccurrenceNotFoundError) return 'gone';
    // 日付の計算が、対応する年（1900〜2199 年）を出る。サーバーは、同じ RangeError を 400 にする（設計書 5.1）。
    if (error instanceof InvalidChangeError || error instanceof RangeError) return 'rejected';
    throw error;
  }
}

function withoutDates(changes: EntryChanges): EntryChanges {
  const rest = { ...changes };
  delete rest.startDate;
  delete rest.endDate;
  return rest;
}

/**
 * 開いた回を、変更・削除するときの、範囲の選び方。
 * rows は、同期のエンジンの view の今の行（削除済みを含む全行。系列以外の行は、読み飛ばす）。
 * 系列の行とその例外の行だけを使うのは、サーバーが読む行と同じ範囲にするため（worker の readSeriesEntries）。
 * 範囲ごとに当てた結果が、どれか 1 つでも「対象がない」なら、gone。開いている回が、もうないことを意味する
 * （例: 削除した回への「この予定のみ」は、対象がない。同じ回への「すべて」は通るが、利用者が開いた回は、もうない）。
 */
export function decideScope({
  rows,
  occurrence,
  action,
}: {
  rows: Iterable<Entry>;
  occurrence: Pick<Occurrence, 'seriesId' | 'occurrenceDate' | 'recurring'>;
  action: ScopeAction;
}): ScopeDecision {
  const { seriesId, occurrenceDate } = occurrence;
  const seriesRows = [...rows].filter((row) => row.id === seriesId || row.seriesId === seriesId);
  const target = { seriesId, occurrenceDate };

  // 繰り返さない予定は、範囲を使わない（設計書 4.5）ので、'all' で確かめる。対象がもうないことと、
  // ルールを付けるとき、日付の計算が範囲を出ることは、ここでも見つかる。
  if (!occurrence.recurring) {
    const result = trial(seriesRows, target, 'all', action);
    if (result === 'accepted') return { kind: 'single' };
    return result === 'gone' ? { kind: 'gone' } : { kind: 'unavailable', reason: 'other' };
  }

  const results = SCOPE_ORDER.map((scope) => ({
    scope,
    result: trial(seriesRows, target, scope, action),
  }));
  if (results.some(({ result }) => result === 'gone')) return { kind: 'gone' };
  const [first, ...rest] = results
    .filter(({ result }) => result === 'accepted')
    .map(({ scope }) => scope);
  if (first !== undefined) return { kind: 'choose', scopes: [first, ...rest] };

  // どの範囲も選べないのが、ルールと日付を同時に変えたためか。ルールも日付も変えていて、日付の変更を外すと、
  // 選べる範囲があれば、そうである。理由を、ルールの種類（毎日・平日・休日）から決めないのは、画面に決まりを
  // 書き写さないため。
  if (
    action.kind === 'change' &&
    action.changes.rrule !== undefined &&
    action.changes.startDate !== undefined
  ) {
    const probe: ScopeAction = { kind: 'change', changes: withoutDates(action.changes) };
    if (SCOPE_ORDER.some((scope) => trial(seriesRows, target, scope, probe) === 'accepted')) {
      return { kind: 'unavailable', reason: 'ruleAndDate' };
    }
  }
  return { kind: 'unavailable', reason: 'other' };
}
