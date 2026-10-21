import { markCancelled, markDeleted } from './recurrence';
import type { Entry, Workspace } from './schema';

/**
 * ワークスペースの削除（設計書 Q6 a）。ワークスペースと、その中の予定を削除した行を返す。
 * 中の予定は、次のとおり（削除されていない行だけ。削除済みの行は、もう一度書かない）。
 * - このワークスペースを指す予定は、論理削除する。
 * - このワークスペースの（削除されていない）系列の例外は、例外の行自身が別のワークスペースを指していても
 *   （「この予定のみ」でワークスペースを変えた回）、論理削除する。系列が消えるので、残しても画面に出ない行になるだけのため。
 * - 別のワークスペースの系列の例外が、このワークスペースを指している行は、論理削除せず、その回を削除した形
 *   （cancelled。「この予定のみ」の削除と同じ）にして、workspaceId を系列のワークスペースに戻す。
 *   論理削除すると、その例外が抑えていた元の回が、系列のワークスペースにまた現れる。利用者は「このワークスペースの
 *   中の予定」を削除したので、移していた回は消えるのが自然で、移す前の日に回が戻るのは意図に反する。
 *   workspaceId を系列の側に戻すのは、削除したワークスペースを指す、削除されていない行を残さないため。
 *   系列の行が entries にない、または削除済みなら、系列がなく、残しても画面に出ない行なので、論理削除する。
 * 組み込みのワークスペースや、最後の 1 つかどうかは確かめない。確かめるのは API（設計書 4.2・11.5）。
 * entries には、このワークスペースの予定のほかに、このワークスペースを指す例外の系列の行が要る。
 * 全行でも、必要な行だけを読んだもの（サーバーの readWorkspaceEntries）でもよい。どちらも同じ結果になる
 * （系列は、削除されていないものだけを見る。サーバーが、削除されていない系列の例外しか読まないため）。
 */
export function deleteWorkspace({
  workspace,
  entries,
  editedAt,
}: {
  workspace: Workspace;
  entries: readonly Entry[];
  editedAt: number;
}): { workspace: Workspace; entries: Entry[] } {
  const liveSeries = new Map(
    entries
      .filter((entry) => entry.deletedAt === null && entry.seriesId === null)
      .map((entry) => [entry.id, entry]),
  );
  const seriesIds = new Set(
    [...liveSeries.values()]
      .filter((series) => series.workspaceId === workspace.id)
      .map((series) => series.id),
  );

  const written: Entry[] = [];
  for (const entry of entries) {
    if (entry.deletedAt !== null) continue;
    if (entry.seriesId !== null && seriesIds.has(entry.seriesId)) {
      written.push(markDeleted(entry, editedAt));
    } else if (entry.workspaceId === workspace.id) {
      const series = entry.seriesId === null ? undefined : liveSeries.get(entry.seriesId);
      written.push(
        series === undefined
          ? markDeleted(entry, editedAt)
          : { ...markCancelled(entry, editedAt), workspaceId: series.workspaceId },
      );
    }
  }
  return { workspace: { ...workspace, deletedAt: editedAt, editedAt }, entries: written };
}

/** 削除されていないワークスペースの id。 */
export function liveWorkspaceIds(workspaces: Iterable<Workspace>): Set<string> {
  const ids = new Set<string>();
  for (const workspace of workspaces) {
    if (workspace.deletedAt === null) ids.add(workspace.id);
  }
  return ids;
}

/**
 * 削除されていないワークスペースの予定か。タイムブロック（workspaceId が null）は、ワークスペースに属さないので常に true。
 * ワークスペースの削除は、中の予定も（別のワークスペースの系列の例外を含めて）消す。しかし、書き込みが重なると
 * （設計書 6.4）、削除したワークスペースを指す、削除されていない行が残ることがある。そういう行を、画面にも
 * GET /api/occurrences にも出さないために、同じ判定を使う。
 * 展開の前ではなく、展開した回に当てる。先に除くと、除いた例外の行が抑えていた、元の系列の回が現れてしまう
 * （設計書 5.1）。表示の ON/OFF（visible）は、画面の都合なので、ここでは見ない。
 */
export function isInLiveWorkspace(
  row: { workspaceId: string | null },
  liveIds: ReadonlySet<string>,
): boolean {
  return row.workspaceId === null || liveIds.has(row.workspaceId);
}
