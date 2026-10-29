import type { Workspace } from '../shared/schema';
import { liveWorkspaceIds } from '../shared/workspace';

/** ワークスペースの行から決まる、画面に出すものの決まり（月表示と日表示で共通）。 */
export interface WorkspaceDisplay {
  /** 削除されていないワークスペースの id（occurrencesInPeriod に渡す）。 */
  liveIds: ReadonlySet<string>;
  /** 表示が ON の、利用者のワークスペースの色（id → 色。WS-3）。組み込みの「祝日」「記念日」は入れない。 */
  colors: ReadonlyMap<string, string>;
  /** 組み込みのワークスペース「祝日」が ON か。OFF なら、祝日の横棒も、祝日の日付の色も出さない。 */
  showHolidays: boolean;
  /** 組み込みのワークスペース「記念日」が ON か。 */
  showObservances: boolean;
  /**
   * 祝日の横棒の色。組み込みの「祝日」の行の `color` そのもので、コードに色を書かない。
   * undefined なら、横棒を出さない（OFF のとき。行がまだないとき＝何も読み込んでいないときも、色が決まらない）。
   */
  holidayBarColor: string | undefined;
  /** 記念日の横棒の色。undefined なら、横棒を出さない。 */
  observanceBarColor: string | undefined;
}

/**
 * ワークスペースの行から、何を出すかを決める。
 * 組み込みの「祝日」「記念日」の行がないときは、ON として扱う（日付の色と読み上げに祝日名を出す）。
 * マイグレーションが必ず入れる行なので、行がないのは、まだ何も読み込んでいないときだけ。
 * そのときは色も分からないので、横棒は出さない。色の既定値をコードに持たないのは、色の決め場所を、
 * ワークスペースの行の 1 か所（マイグレーションが入れる値。設計書 4.2）にするため。
 * 表示が OFF のワークスペースの予定は、ここでは除かない。呼び出し側が、展開した回から、colors にないものを除く。
 * 展開の前に除くと、別のワークスペースへ移した例外の行を除いたとき、その例外が抑えていた、
 * 元の系列の回が現れてしまうため（設計書 5.1）。
 */
export function workspaceDisplayOf(workspaces: Iterable<Workspace>): WorkspaceDisplay {
  const all = [...workspaces];
  const colors = new Map<string, string>();
  let showHolidays = true;
  let showObservances = true;
  let holidayBarColor: string | undefined;
  let observanceBarColor: string | undefined;
  for (const workspace of all) {
    if (workspace.deletedAt !== null) continue;
    if (workspace.builtin === 'holiday') {
      showHolidays = workspace.visible;
      holidayBarColor = workspace.visible ? workspace.color : undefined;
    } else if (workspace.builtin === 'observance') {
      showObservances = workspace.visible;
      observanceBarColor = workspace.visible ? workspace.color : undefined;
    } else if (workspace.visible) colors.set(workspace.id, workspace.color);
  }
  return {
    liveIds: liveWorkspaceIds(all),
    colors,
    showHolidays,
    showObservances,
    holidayBarColor,
    observanceBarColor,
  };
}
