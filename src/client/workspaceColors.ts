// ワークスペースの色の 8 色（設計書 11.1）。Google カレンダーの 8 色を、暗い背景向けに明るくした色。
// 値は、ユーザーが、月表示のマスでの見本（3 案）を見て選んだ（ユーザーの回答。実装 #7 の確認 Q1）。
// 画面の色の選択（ワークスペースの編集）だけが使う。サーバー（API）は、これまでどおり '#RRGGBB' の形だけを
// 確かめる（shared/schema.ts）。
// Why 8 色を shared に置かないのか: サーバーで 8 色に絞ると、組み込みの「祝日」「記念日」が持つ、8 色以外の色に
// 例外が要る。API はユーザー専用なので、サーバーで絞る必要が小さい。
// サーバーで絞らないと決めたのは、ユーザーの回答（推奨どおり。実装 #10 の確認 Q4）。上の理由は、推奨案のもの。

export interface WorkspaceColor {
  /** 色の見本の、読み上げの名前。 */
  name: string;
  /** '#RRGGBB'（大文字）。 */
  value: string;
}

/** 1 つ以上あることを、型にも持たせる（色の初期値で、全部使っているとき、最初の色を使うため）。 */
export const WORKSPACE_COLORS: readonly [WorkspaceColor, ...WorkspaceColor[]] = [
  { name: 'トマト', value: '#E57373' },
  { name: 'オレンジ', value: '#FF8A65' },
  { name: 'バナナ', value: '#FFD54F' },
  { name: 'バジル', value: '#81C784' },
  { name: 'ピーコック', value: '#4FC3F7' },
  { name: 'ブルーベリー', value: '#7986CB' },
  { name: 'ラベンダー', value: '#B39DDB' },
  { name: 'グラファイト', value: '#BDBDBD' },
];

/**
 * 同じ色か。16 進の大文字・小文字は区別しない。
 * サーバーは、'#e57373' のような小文字も通す（shared/schema.ts）ので、API から入った値を、8 色の同じ色と見なす。
 */
export function isSameColor(a: string, b: string): boolean {
  return a.toUpperCase() === b.toUpperCase();
}
