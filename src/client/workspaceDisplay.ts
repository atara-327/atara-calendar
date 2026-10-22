import type { Workspace } from '../shared/schema';
import { liveWorkspaceIds } from '../shared/workspace';

/** ワークスペースの行から決まる、画面に出すものの決まり（月表示と日表示で共通）。 */
export interface WorkspaceDisplay {
  /** 削除されていないワークスペースの id（occurrencesInPeriod に渡す）。 */
  liveIds: ReadonlySet<string>;
  /** 表示が ON の、利用者のワークスペースの色（id → 色。WS-3）。組み込みの「祝日」「記念日」は入れない。 */
  colors: ReadonlyMap<string, string>;
  /** 組み込みのワークスペース「祝日」が ON か。OFF なら、祝日名も、祝日の日付の色も出さない。 */
  showHolidays: boolean;
  /** 組み込みのワークスペース「記念日」が ON か。 */
  showObservances: boolean;
}

/**
 * ワークスペースの行から、何を出すかを決める。
 * 組み込みの「祝日」「記念日」の行がないときは、出す。マイグレーションが必ず入れる行なので、
 * 行がないのは、まだ何も読み込んでいないときだけ。
 * 表示が OFF のワークスペースの予定は、ここでは除かない。呼び出し側が、展開した回から、colors にないものを除く。
 * 展開の前に除くと、別のワークスペースへ移した例外の行を除いたとき、その例外が抑えていた、
 * 元の系列の回が現れてしまうため（設計書 5.1）。
 */
export function workspaceDisplayOf(workspaces: Iterable<Workspace>): WorkspaceDisplay {
  const all = [...workspaces];
  const colors = new Map<string, string>();
  let showHolidays = true;
  let showObservances = true;
  for (const workspace of all) {
    if (workspace.deletedAt !== null) continue;
    if (workspace.builtin === 'holiday') showHolidays = workspace.visible;
    else if (workspace.builtin === 'observance') showObservances = workspace.visible;
    else if (workspace.visible) colors.set(workspace.id, workspace.color);
  }
  return { liveIds: liveWorkspaceIds(all), colors, showHolidays, showObservances };
}
