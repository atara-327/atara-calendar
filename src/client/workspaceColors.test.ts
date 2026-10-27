import { describe, expect, it } from 'vitest';
import { workspaceSchema } from '../shared/schema';
import { WORKSPACE_COLORS, isSameColor } from './workspaceColors';

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
