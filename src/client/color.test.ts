import { describe, expect, it } from 'vitest';
import {
  DARK_TEXT_COLOR,
  LIGHT_TEXT_COLOR,
  contrastRatio,
  readableTextColor,
  relativeLuminance,
} from './color';

describe('コントラスト比', () => {
  it('黒と白は 21、同じ色どうしは 1', () => {
    expect(contrastRatio('#000000', '#FFFFFF')).toBeCloseTo(21, 5);
    expect(contrastRatio('#336699', '#336699')).toBeCloseTo(1, 5);
  });

  it('相対輝度は、黒が 0、白が 1', () => {
    expect(relativeLuminance('#000000')).toBe(0);
    expect(relativeLuminance('#FFFFFF')).toBeCloseTo(1, 5);
  });
});

describe('背景の上に出す文字の色', () => {
  it('暗い背景には白を使う', () => {
    expect(readableTextColor('#000000')).toBe(LIGHT_TEXT_COLOR);
    expect(readableTextColor('#D50000')).toBe(LIGHT_TEXT_COLOR);
    expect(readableTextColor('#3F51B5')).toBe(LIGHT_TEXT_COLOR);
  });

  it('明るい背景には #1F1F1F を使う', () => {
    expect(readableTextColor('#FFFFFF')).toBe(DARK_TEXT_COLOR);
    expect(readableTextColor('#F6BF26')).toBe(DARK_TEXT_COLOR);
    expect(readableTextColor('#7986CB')).toBe(DARK_TEXT_COLOR);
  });

  it.each(['#039BE5', '#33B679', '#E67C73', '#8E24AA', '#616161', '#F4511E', '#0B8043'])(
    '%s の背景には、コントラスト比が大きい方の色を選ぶ',
    (background) => {
      const chosen = readableTextColor(background);
      const other = chosen === LIGHT_TEXT_COLOR ? DARK_TEXT_COLOR : LIGHT_TEXT_COLOR;
      expect(contrastRatio(background, chosen)).toBeGreaterThanOrEqual(
        contrastRatio(background, other),
      );
    },
  );

  it('小文字の色コードも読める', () => {
    expect(readableTextColor('#039be5')).toBe(readableTextColor('#039BE5'));
  });
});
