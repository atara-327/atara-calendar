import type { Workspace } from '../../shared/schema';

// フォームのワークスペースの選択肢と、その初期値（EV-8。設計書 11.4）。

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
