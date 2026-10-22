import { describe, expect, it } from 'vitest';
import { mapSearchUrl, openableUrl } from './links';

describe('場所の、地図へのリンク', () => {
  it('場所の名前を、地図の検索の query にする', () => {
    expect(mapSearchUrl('東京駅')).toBe(
      'https://www.google.com/maps/search/?api=1&query=%E6%9D%B1%E4%BA%AC%E9%A7%85',
    );
  });

  it('& や空白などは、query の中で区切りにならないよう、エンコードする', () => {
    expect(mapSearchUrl('A&B カフェ')).toBe(
      'https://www.google.com/maps/search/?api=1&query=A%26B%20%E3%82%AB%E3%83%95%E3%82%A7',
    );
  });
});

describe('URL を、リンクにしてよいか（設計書 10.3）', () => {
  it('http:// と https:// の URL は、そのまま返す', () => {
    expect(openableUrl('https://example.com/a?b=1')).toBe('https://example.com/a?b=1');
    expect(openableUrl('http://example.com')).toBe('http://example.com');
  });

  it.each([
    '',
    'javascript:alert(1)',
    'data:text/html,<p>',
    'ftp://example.com',
    'example.com',
    'https://',
  ])('%s はリンクにしない（null）', (value) => {
    expect(openableUrl(value)).toBeNull();
  });

  it('2048 文字を超える URL は、リンクにしない（保存できない URL のため）', () => {
    expect(openableUrl(`https://example.com/${'a'.repeat(2040)}`)).toBeNull();
  });
});
