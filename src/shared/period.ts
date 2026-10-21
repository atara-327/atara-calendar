import type { DateStr } from './date';
import { expandOccurrences, type Occurrence } from './recurrence';
import type { Entry } from './schema';
import { isInLiveWorkspace } from './workspace';

/**
 * 期間 [from, to]（両端を含む）にかかる回の一覧を、開始の日時の順に返す。from が to より後なら空。
 * entries は全行（繰り返さない予定・系列・例外）、liveWorkspaceIds は削除されていないワークスペースの id。
 * 画面（月表示）と GET /api/occurrences が、同じ一覧を作るために使う。
 * 祝日と記念日は、別に namedDatesBetween（holidays.ts）で求める。
 */
export function occurrencesInPeriod(
  entries: readonly Entry[],
  liveWorkspaceIds: ReadonlySet<string>,
  from: DateStr,
  to: DateStr,
): Occurrence[] {
  // 削除済みのワークスペースの予定は出さない。ワークスペースの削除は中の予定も消すが、書き込みが重なると
  // （設計書 6.4）、削除したワークスペースを指す、削除されていない行が残ることがある。
  // 展開の前ではなく後で除くのは、先に除くと、除いた例外の行が抑えていた、元の系列の回が現れてしまうため。
  return expandOccurrences(entries, from, to).filter((occurrence) =>
    isInLiveWorkspace(occurrence, liveWorkspaceIds),
  );
}
