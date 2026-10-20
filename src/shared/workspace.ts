import { markDeleted } from './recurrence';
import type { Entry, Workspace } from './schema';

/**
 * ワークスペースの削除（設計書 Q6 a）。ワークスペースと、その中の予定をすべて論理削除した行を返す。
 * 中の予定には、そのワークスペースの系列の例外の行も含める。例外の行自身が別のワークスペースを指していても
 * （「この予定のみ」でワークスペースを変えた回）、系列が消えるので、残しても画面に出ない行になるだけのため。
 * 逆に、別のワークスペースの系列の例外が、このワークスペースを指している行は、「この中の予定」として消える。
 * その回は、元の系列の回として出るようになる。この例外の行を、消さずに cancelled にして残す形にしないのは、
 * 削除したワークスペースを指す、削除されていない行が残り、「中の予定をすべて論理削除する」（設計書 Q6 a）が
 * 成り立たなくなるため。
 * 組み込みのワークスペースや、最後の 1 つかどうかは確かめない。確かめるのは API（設計書 4.2・11.5）。
 * entries は全行でも、中の行だけを読んだものでもよい。削除済みの行は、もう一度書かない。
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
  const seriesIds = new Set(
    entries
      .filter((entry) => entry.workspaceId === workspace.id && entry.seriesId === null)
      .map((entry) => entry.id),
  );
  const inside = entries.filter(
    (entry) =>
      entry.deletedAt === null &&
      (entry.workspaceId === workspace.id ||
        (entry.seriesId !== null && seriesIds.has(entry.seriesId))),
  );
  return {
    workspace: { ...workspace, deletedAt: editedAt, editedAt },
    entries: inside.map((entry) => markDeleted(entry, editedAt)),
  };
}
