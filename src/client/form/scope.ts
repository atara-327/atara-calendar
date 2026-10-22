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
//
// 「サーバーで 4xx にならない」のは、次の前提のもとで成り立つ。
// - changes が、入力のスキーマ（shared の entryChangesInputSchema）を通っている。ここでは確かめない。
//   フォームが、保存の前に、validateForm（validate.ts）で確かめている。サーバーが入力の段階で 400 にする
//   changes（例: 年が範囲の外の日付）は、ここでは範囲の判定に使わない。
// - rows が最新である。ほかの端末の変更が、まだ受け取りで届いていなければ、判定とサーバーの結果は、食い違いうる
//   （範囲を選んで送るときに、もう一度確かめる。recheckScope）。
// 判定と、サーバーの手順の食い違いがないことは、scope.consistency.test.ts が、組み合わせを試して確かめている。

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

/**
 * 範囲 1 つを、手元の行に当てた結果。拒まれた理由を分けるのは、どの範囲も選べないとき、ルールと日付を
 * 同時に変えたためか（InvalidChangeError）、そうでないか（長さが合わない・年の範囲を出る）を見分けるため。
 */
type Trial = 'accepted' | 'gone' | 'invalidChange' | 'otherRejection';

/** 範囲 1 つを当てて、書く行を返す。shared の例外（対象がない・受け付けられない・日付の計算が範囲を出る）は、そのまま投げる。 */
function apply(
  seriesRows: readonly Entry[],
  target: { seriesId: string; occurrenceDate: string },
  scope: Scope,
  action: ScopeAction,
): Entry[] {
  return action.kind === 'change'
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
}

function trial(
  seriesRows: readonly Entry[],
  target: { seriesId: string; occurrenceDate: string },
  scope: Scope,
  action: ScopeAction,
): Trial {
  try {
    const written = apply(seriesRows, target, scope, action);
    // 削除する行は、確かめない（worker/api/entryRules.ts と同じ。確かめると、決まりが厳しくなる前の行を削除できない）。
    const ok = written.every((row) => row.deletedAt !== null || entryProblem(row) === null);
    return ok ? 'accepted' : 'otherRejection';
  } catch (error) {
    if (error instanceof OccurrenceNotFoundError) return 'gone';
    if (error instanceof InvalidChangeError) return 'invalidChange';
    // 日付の計算が、対応する年（1900〜2199 年）を出る。サーバーは、同じ RangeError を 400 にする（設計書 5.1）。
    if (error instanceof RangeError) return 'otherRejection';
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

  // どの範囲も選べないのが、ルールと日付を同時に変えたためか。次の 3 つが、すべて当てはまるときだけ、そうとする。
  // - ルールも日付も変えている。
  // - 「この予定のみ」以外の範囲（これ以降すべて・すべて）が、どちらも InvalidChangeError で拒まれた
  //   （「この予定のみ」は、ルールを変えると、いつも拒まれるので、見ない）。
  // - 日付の変更を外すと、選べる範囲がある。
  // 日付を外すと通るだけでは、足りない。日付を変えて、1 回の長さが変わり、項目をまたぐ確認に当たる場合なども、
  // 日付を外すと通るので、別の理由（汎用の文言）を、ルールと日付の同時の変更のせいにしてしまう。
  // 理由を、ルールの種類（毎日・平日・休日）から決めないのは、画面に決まりを書き写さないため。
  if (
    action.kind === 'change' &&
    action.changes.rrule !== undefined &&
    action.changes.startDate !== undefined &&
    results.every(({ scope, result }) => scope === 'this' || result === 'invalidChange')
  ) {
    const probe: ScopeAction = { kind: 'change', changes: withoutDates(action.changes) };
    if (SCOPE_ORDER.some((scope) => trial(seriesRows, target, scope, probe) === 'accepted')) {
      return { kind: 'unavailable', reason: 'ruleAndDate' };
    }
  }
  return { kind: 'unavailable', reason: 'other' };
}

/** 範囲を選んで送るときの、もう一度の確認の結果。 */
export type ScopeRecheck =
  /** 選んだ範囲は、まだ選べる。送ってよい。 */
  | { kind: 'proceed' }
  /** 対象がもうない・どの範囲も選べなくなった。保存しない。 */
  | { kind: 'rejected'; decision: Extract<ScopeDecision, { kind: 'gone' | 'unavailable' }> }
  /** ほかの範囲は選べるが、選んだ範囲は、もう選べない。範囲を選び直す。 */
  | { kind: 'changed' };

/**
 * 範囲を選んで送るとき、同じ変更・削除に、もう一度 decideScope を当て、選んだ範囲が、まだ選べるかを確かめる。
 * Why: 範囲を聞く段を開いている間に、ほかの端末の変更が、受け取りで届くことがある。選べる範囲が変わったのに
 * そのまま送ると、サーバーが 200 で「捨てた」にするか、400 にする（400 なら、保存した変更が画面から消える。設計書 6.2）。
 */
export function recheckScope({
  selected,
  ...decision
}: Parameters<typeof decideScope>[0] & { selected: Scope }): ScopeRecheck {
  const result = decideScope(decision);
  switch (result.kind) {
    case 'choose':
      return result.scopes.includes(selected) ? { kind: 'proceed' } : { kind: 'changed' };
    case 'single':
      return { kind: 'proceed' };
    default:
      return { kind: 'rejected', decision: result };
  }
}

/** 保存したあとの系列（ルールと、最初の回の日付）。 */
export interface SeriesAfter {
  /** null は、繰り返さない予定になる（ルールをなくした）。 */
  rrule: Entry['rrule'];
  startDate: string;
}

/**
 * 変更を、この範囲で保存したあとの、系列のルールと最初の回の日付。範囲を聞く段で、範囲ごとに、保存したあとに
 * どうなるかを出すのに使う。「この予定のみ」は、系列を変えない（例外の行が 1 つできるだけ）ので null。
 * 日付のずらし方と、ルールに合う最初の日への動かし方は、画面で計算せず、shared の changeEntry を当てた結果から読む
 * （範囲によって、基準の日が違う。「すべて」は系列の開始日、「これ以降すべて」は開いた回の日付から）。
 * 書く行のうち、系列の行を探す。「これ以降すべて」は、新しい系列（新しい行の id）で、最初の回から数えるときは、
 * 元の系列の行（「すべて」と同じ）。
 */
export function seriesAfterChange({
  rows,
  occurrence,
  changes,
  scope,
}: {
  rows: Iterable<Entry>;
  occurrence: Pick<Occurrence, 'seriesId' | 'occurrenceDate'>;
  changes: EntryChanges;
  scope: Scope;
}): SeriesAfter | null {
  if (scope === 'this') return null;
  const { seriesId, occurrenceDate } = occurrence;
  const seriesRows = [...rows].filter((row) => row.id === seriesId || row.seriesId === seriesId);
  const written = apply(seriesRows, { seriesId, occurrenceDate }, scope, {
    kind: 'change',
    changes,
  });
  const row =
    written.find((entry) => entry.id === TRIAL_NEW_ID && entry.seriesId === null) ??
    written.find((entry) => entry.id === seriesId && entry.seriesId === null);
  return row === undefined ? null : { rrule: row.rrule, startDate: row.startDate };
}
