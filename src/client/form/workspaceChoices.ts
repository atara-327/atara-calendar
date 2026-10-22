import type { Workspace } from '../../shared/schema';

// フォームのワークスペースの選択肢と、その初期値（EV-8。設計書 11.4）。

function compareText(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

/**
 * 予定に選べるワークスペース。削除されていない、利用者のワークスペースを、並び順で。
 * 組み込みの「祝日」「記念日」は、予定を入れられない（WS-4。サーバーも 400 にする）ので除く。
 */
export function selectableWorkspaces(workspaces: Iterable<Workspace>): Workspace[] {
  return [...workspaces]
    .filter(({ deletedAt, builtin }) => deletedAt === null && builtin === null)
    .sort((a, b) => a.sortOrder - b.sortOrder || compareText(a.id, b.id));
}

/**
 * 新しく予定を作るときの、ワークスペースの初期値（EV-8）。前回、新しく作った予定を保存したときのワークスペース。
 * 覚えたものが、選べなくなっていたら（削除された）、並び順が最初のもの。選べるものが 1 つもなければ null。
 */
export function defaultWorkspaceId(
  choices: readonly Workspace[],
  rememberedId: string | null,
): string | null {
  const remembered = choices.find(({ id }) => id === rememberedId);
  return (remembered ?? choices[0])?.id ?? null;
}
