import type { Workspace } from '../../shared/schema';
import { selectableWorkspaces } from '../form/workspaceChoices';

// サイドメニューに出すワークスペースの、並べ方（設計書 11.5）。

/** サイドメニューの 2 つの節。 */
export interface MenuSections {
  /** 利用者のワークスペース。並び順（sortOrder。同じなら id の順）。 */
  workspaces: Workspace[];
  /** 組み込みの「祝日」「記念日」。この順。その行がなければ、出さない。 */
  builtins: Workspace[];
}

const BUILTIN_ORDER = ['holiday', 'observance'] as const;

/**
 * 削除されたものは、どちらの節にも出さない。
 * 利用者のワークスペースの並びは、予定のフォームの選択肢（selectableWorkspaces）と同じ関数で決める。
 * Why: メニューとフォームで並びが食い違うと、同じワークスペースを、場所によって別の順に探すことになる。
 */
export function menuSections(workspaces: Iterable<Workspace>): MenuSections {
  const live = [...workspaces].filter(({ deletedAt }) => deletedAt === null);
  return {
    workspaces: selectableWorkspaces(live),
    builtins: BUILTIN_ORDER.flatMap((builtin) => {
      const row = live.find((workspace) => workspace.builtin === builtin);
      return row === undefined ? [] : [row];
    }),
  };
}
