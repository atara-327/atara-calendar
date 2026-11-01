import { describe, expect, it } from 'vitest';
import { workspaceSchema } from './schema';
import { WORKSPACE_COLORS, firstUnusedColor, isSameColor } from './workspaceColors';

describe('ワークスペースの 8 色', () => {
  it('8 色で、名前（読み上げ）も値も、重ならない', () => {
    expect(WORKSPACE_COLORS).toHaveLength(8);
    expect(new Set(WORKSPACE_COLORS.map(({ name }) => name)).size).toBe(8);
    expect(new Set(WORKSPACE_COLORS.map(({ value }) => value)).size).toBe(8);
  });

  it('どの色も、サーバーが受け付ける形（#RRGGBB）で、トマトから順に、設計書 11.1 の並び', () => {
    for (const { value } of WORKSPACE_COLORS) {
      expect(
        workspaceSchema.shape.color.safeParse(value).success,
        `${value} が #RRGGBB の形ではありません`,
      ).toBe(true);
    }
    expect(WORKSPACE_COLORS.map(({ name }) => name)).toEqual([
      'トマト',
      'オレンジ',
      'バナナ',
      'バジル',
      'ピーコック',
      'ブルーベリー',
      'ラベンダー',
      'グラファイト',
    ]);
  });
});

describe('同じ色か', () => {
  it('16 進の大文字と小文字は、区別しない', () => {
    expect(isSameColor('#e57373', '#E57373')).toBe(true);
  });

  it('値が違えば、違う色', () => {
    expect(isSameColor('#E57373', '#E57374')).toBe(false);
  });
});

describe('まだ使っていない最初の色', () => {
  it('何も使っていなければ、最初の色（トマト）', () => {
    expect(firstUnusedColor([])).toBe('#E57373');
  });

  it('使っている色を飛ばして、並びの先頭の、使っていない色を返す', () => {
    expect(firstUnusedColor(['#E57373', '#FFD54F'])).toBe('#FF8A65');
  });

  it('16 進の小文字で使っている色も、使っているとみなす', () => {
    expect(firstUnusedColor(['#e57373'])).toBe('#FF8A65');
  });

  it('8 色すべて使っていれば、最初の色', () => {
    expect(firstUnusedColor(WORKSPACE_COLORS.map(({ value }) => value))).toBe('#E57373');
  });
});
