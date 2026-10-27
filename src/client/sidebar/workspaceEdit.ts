import { INPUT_LIMITS, type Entry, type Workspace } from '../../shared/schema';
import { selectableWorkspaces } from '../form/workspaceChoices';
import { WORKSPACE_COLORS, isSameColor, type WorkspaceColor } from '../workspaceColors';

// ワークスペースの編集（設計書 11.5）の、画面に依存しない部分。並べ替え・新しいワークスペースの初期値・
// 名前の確認・保存する行の決め方・色の見本・削除の確認に出す件数・最後の 1 つの判定。

/** エンジンの saveWorkspace に渡す形。editedAt と deletedAt は、エンジンが決める。 */
export type WorkspaceInput = Omit<Workspace, 'editedAt' | 'deletedAt'>;

/**
 * 保存する行から、エンジンに渡す形を作る。
 * 項目を 1 つずつ書くのは、Workspace に項目が増えたとき、ここで型の誤りにして、渡し忘れに気づけるようにするため。
 */
export function toWorkspaceInput(workspace: Workspace): WorkspaceInput {
  return {
    id: workspace.id,
    name: workspace.name,
    color: workspace.color,
    sortOrder: workspace.sortOrder,
    visible: workspace.visible,
    builtin: workspace.builtin,
  };
}

export type MoveDirection = 'up' | 'down';

/**
 * ［↑］［↓］で並べ替えた結果、保存し直す行（sortOrder が変わる行だけ）。
 * 利用者のワークスペースを、今の並びで 1 つ入れ替えたあと、sortOrder を、並びの順に 0, 1, 2… に振り直す。
 * Why 2 行の sortOrder を入れ替えるだけにしないのか: 同じ値の行があるとき（API から入れたときなど）、
 * 入れ替えても、値が変わらず、並びが変わらない。
 * 組み込みの行は、並べ替えに含めない。別の節に出すので、利用者の並びに混ぜない（sortOrder も変えない）。
 * 端の行を、外へ動かすとき（いちばん上の ↑、いちばん下の ↓）と、対象がないときは、何も変えない。
 */
export function reorderWorkspaces(
  workspaces: Iterable<Workspace>,
  id: string,
  direction: MoveDirection,
): Workspace[] {
  const ordered = selectableWorkspaces(workspaces);
  const from = ordered.findIndex((workspace) => workspace.id === id);
  const to = direction === 'up' ? from - 1 : from + 1;
  const moving = ordered[from];
  const other = ordered[to];
  if (moving === undefined || other === undefined) return [];
  return ordered
    .map((workspace, index) => (index === from ? other : index === to ? moving : workspace))
    .flatMap((workspace, index) =>
      workspace.sortOrder === index ? [] : [{ ...workspace, sortOrder: index }],
    );
}

/**
 * 新しいワークスペースの色の初期値。削除されていない、利用者のワークスペースが、まだ使っていない、最初の 8 色。
 * 全部使っていれば、最初の色（トマト）。
 * Why: 色でワークスペースを見分けるため（要件 WS-2）。
 */
export function initialWorkspaceColor(workspaces: Iterable<Workspace>): string {
  const used = selectableWorkspaces(workspaces).map(({ color }) => color);
  const unused = WORKSPACE_COLORS.find(
    ({ value }) => !used.some((color) => isSameColor(color, value)),
  );
  return (unused ?? WORKSPACE_COLORS[0]).value;
}

/**
 * 新しく作るワークスペースの、入力の初期値。名前は空（利用者が入れる）。
 * sortOrder は、今のいちばん大きい値の次（いちばん下に並ぶ）。表示は ON、組み込みではない。
 */
export function newWorkspaceInput(workspaces: Iterable<Workspace>, id: string): WorkspaceInput {
  const live = selectableWorkspaces(workspaces);
  return {
    id,
    name: '',
    color: initialWorkspaceColor(live),
    sortOrder: Math.max(-1, ...live.map(({ sortOrder }) => sortOrder)) + 1,
    visible: true,
    builtin: null,
  };
}

/** 名前の誤り（日本語）。なければ null。前後の空白を除いた値で確かめる（保存する値も、除いたもの）。 */
export function validateWorkspaceName(name: string): string | null {
  const trimmed = name.trim();
  if (trimmed === '') return '名前を入れてください';
  if (trimmed.length > INPUT_LIMITS.workspaceName) {
    return `名前は ${String(INPUT_LIMITS.workspaceName)} 文字までにしてください`;
  }
  return null;
}

/** 既存のワークスペースの［保存］で、何を送るか。 */
export type WorkspaceSave =
  /** 名前も色も、開いたときから変えていない。何も送らない。 */
  | { kind: 'unchanged' }
  /** 最新の行がない（ほかの端末で削除された）。何も送らない。 */
  | { kind: 'gone' }
  | { kind: 'save'; workspace: WorkspaceInput };

/**
 * 既存のワークスペースの［保存］で、エンジンに渡す行を決める。
 * original は、段 2 を開いたときの行、latest は、今の（同期のエンジンの view の）行、draft は、入力の途中の値。
 * 土台は latest にして、利用者が、開いたときの値から変えた項目（名前・色）だけを、draft の値で上書きする。
 * Why: ワークスペースは、行全体を put する（予定のフォームは、変えた項目だけを changes で送る）。開いたときの行を
 * 土台にすると、段を開いている間に、ほかの端末が変えた、触っていない項目（表示の ON/OFF・並び順・名前・色）まで、
 * 新しい編集時刻で送り、巻き戻してしまう。
 * - 名前を変えたのは、前後の空白を除いた値が、開いたときの名前と違うとき。ただし、入力を触っていなければ（開いたときの
 *   名前と同じなら）変えていない。API から入った、前後に空白のある名前を、色だけ変えたときに、書き換えないため。
 * - 色を変えたのは、isSameColor で、開いたときの色と違うとき。8 色にない色（API から入った値）や、16 進の小文字の色は、
 *   選び直さなければ、保存してある文字列のまま。
 * - 最新の行がない（削除された）ときは、送らない。サーバーは、削除済みのワークスペースの更新を、黙って捨てる
 *   （生き返らせない。設計書 5.1）ので、送ると、保存したつもりで、保存されない。呼び出し側が、理由を出す
 *   （予定のフォームの、対象がもうないときと同じ）。
 */
export function workspaceToSave({
  original,
  latest,
  draft,
}: {
  original: Workspace;
  latest: Workspace | undefined;
  draft: WorkspaceInput;
}): WorkspaceSave {
  if (latest === undefined || latest.deletedAt !== null) return { kind: 'gone' };
  const name = draft.name.trim();
  const nameChanged = draft.name !== original.name && name !== original.name;
  const colorChanged = !isSameColor(draft.color, original.color);
  if (!nameChanged && !colorChanged) return { kind: 'unchanged' };
  return {
    kind: 'save',
    workspace: {
      ...toWorkspaceInput(latest),
      ...(nameChanged ? { name } : {}),
      ...(colorChanged ? { color: draft.color } : {}),
    },
  };
}

/** 色の見本の読み上げの名前（8 色にないとき）。 */
export const CURRENT_COLOR_NAME = '今の色';

/**
 * 色の見本。8 色の見本に、current が 8 色にないときは、9 つ目に「今の色」を足す。
 * Why: API から、8 色以外の色が入ったワークスペースを、編集画面で、その色のまま保存できるようにするため。
 * 画面は、8 色からだけ選べるが、API から入った値は、表示するだけで、勝手に書き換えない
 * （ユーザーの回答。実装 #10 の確認 Q4）。
 */
export function colorSwatches(current: string): WorkspaceColor[] {
  const isPalette = WORKSPACE_COLORS.some(({ value }) => isSameColor(value, current));
  return isPalette
    ? [...WORKSPACE_COLORS]
    : [...WORKSPACE_COLORS, { name: CURRENT_COLOR_NAME, value: current }];
}

/**
 * 削除の確認に出す、中の予定の件数。削除されていない行のうち、このワークスペースの、繰り返さない予定と、繰り返しの系列
 * （seriesId が null のもの）。例外の行は数えない。
 * Why: 利用者が作った予定の数（繰り返しは 1 件）に合わせるため。別の系列から「この予定のみ」で移した回は数えないが、
 * まれなので、文言の正確さより、単純さを取る。
 */
export function countEntriesIn(entries: Iterable<Entry>, workspaceId: string): number {
  let count = 0;
  for (const entry of entries) {
    if (entry.deletedAt === null && entry.seriesId === null && entry.workspaceId === workspaceId) {
      count += 1;
    }
  }
  return count;
}

/**
 * 最後の 1 つか。削除されていない、組み込みでない行が、この id の 1 つだけ。
 * Why: 予定はワークスペースに必ず属する（要件 EV-2）ので、1 つもなくなると、予定を作れなくなる。
 * サーバーも、同じ理由で、最後の 1 つの削除を 400 にする（設計書 4.2）。
 */
export function isLastWorkspace(workspaces: Iterable<Workspace>, id: string): boolean {
  const live = selectableWorkspaces(workspaces);
  return live.length === 1 && live[0]?.id === id;
}
