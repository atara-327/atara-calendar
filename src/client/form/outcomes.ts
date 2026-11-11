import type { Occurrence } from '../../shared/recurrence';
import type { Entry, EntryChanges, Scope } from '../../shared/schema';
import { describeSeriesAfter } from './repeat';
import { seriesAfterChange } from './scope';

/**
 * 範囲ごとの、保存したあとの系列の説明（範囲を聞く段の「保存後: …」。設計書 11.4）。EntryForm の保存と、
 * ドラッグで移したあとの MoveDialog が、同じ計算を使う。
 * ルールか開始日を変えていないとき（題名だけなど）は、保存したあとの系列が変わらないので、出さない。
 * 範囲によって、基準の日が違い（「すべて」は系列の開始日、「これ以降すべて」は開いた回の日付に、日付の変更を足した日）、
 * 入力の段では、毎月 N 日などが決まらない。shared の関数を当てた結果から作る（画面にずらしの決まりを書き写さない）。
 * shownStartDate は、画面に出ている開始日。最初の回がこれと違うときだけ、説明に最初の回を付ける。
 */
export function outcomesOf({
  rows,
  occurrence,
  changes,
  scopes,
  shownStartDate,
}: {
  rows: Iterable<Entry>;
  occurrence: Occurrence;
  changes: EntryChanges;
  scopes: readonly Scope[];
  shownStartDate: string;
}): Partial<Record<Scope, string>> {
  if (changes.rrule === undefined && changes.startDate === undefined) return {};
  const entries = [...rows];
  const outcomes: Partial<Record<Scope, string>> = {};
  for (const scope of scopes) {
    const after = seriesAfterChange({ rows: entries, occurrence, changes, scope });
    if (after !== null) outcomes[scope] = describeSeriesAfter(after, shownStartDate);
  }
  return outcomes;
}
