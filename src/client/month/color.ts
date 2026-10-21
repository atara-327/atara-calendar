/** 背景の上に出す文字の色。白か、画面の背景と同じ #1F1F1F（設計書 11.1）。 */
export const LIGHT_TEXT_COLOR = '#FFFFFF';
export const DARK_TEXT_COLOR = '#1F1F1F';

function linearChannel(value: number): number {
  const srgb = value / 255;
  return srgb <= 0.04045 ? srgb / 12.92 : ((srgb + 0.055) / 1.055) ** 2.4;
}

/** WCAG の相対輝度（0 = 黒、1 = 白）。color は '#RRGGBB'。 */
export function relativeLuminance(color: string): number {
  const red = parseInt(color.slice(1, 3), 16);
  const green = parseInt(color.slice(3, 5), 16);
  const blue = parseInt(color.slice(5, 7), 16);
  return 0.2126 * linearChannel(red) + 0.7152 * linearChannel(green) + 0.0722 * linearChannel(blue);
}

/** WCAG のコントラスト比（1〜21）。 */
export function contrastRatio(a: string, b: string): number {
  const [lighter, darker] = [relativeLuminance(a), relativeLuminance(b)].sort((x, y) => y - x);
  return ((lighter ?? 0) + 0.05) / ((darker ?? 0) + 0.05);
}

/**
 * 色の背景の上に出す文字の色。白と #1F1F1F のうち、背景とのコントラスト比が大きい方を選ぶ。
 * 色ごとに文字色を決めておかないのは、ワークスペースの色が、利用者が選ぶ 8 色のどれでもよいため（設計書 11.1）。
 */
export function readableTextColor(background: string): string {
  return contrastRatio(background, LIGHT_TEXT_COLOR) >= contrastRatio(background, DARK_TEXT_COLOR)
    ? LIGHT_TEXT_COLOR
    : DARK_TEXT_COLOR;
}
