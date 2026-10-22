import chars from '@iconify-json/noto/chars.json';
import { describe, expect, it } from 'vitest';
import { emojiKey, splitEmoji } from './splitEmoji';

/** 画像がある key の集合。 */
const images = (...keys: string[]) => new Set(keys);

// 見た目が同じで、符号位置が違うものは、書き分ける。
const HEART_EMOJI_STYLE = '\u{2764}\u{FE0F}'; // ❤️（U+2764 + 絵文字の表示を求める U+FE0F）
const HEART_DEFAULT_STYLE = '\u{2764}'; // ❤（U+2764 だけ。文字として表示される）
const KEYCAP_ONE = '1\u{FE0F}\u{20E3}'; // 1️⃣
const COPYRIGHT_EMOJI_STYLE = '\u{A9}\u{FE0F}'; // ©️
const FAMILY = '👨\u{200D}👩\u{200D}👧'; // 👨‍👩‍👧（ZWJ でつないだ 1 つの絵文字）
const FLAG_JAPAN = '\u{1F1EF}\u{1F1F5}'; // 🇯🇵（地域を表す 2 文字の組）

describe('絵文字の key', () => {
  it('符号位置を 16 進の小文字で、4 桁に 0 埋めして、- でつなぐ', () => {
    expect(emojiKey('😀')).toBe('1f600');
    expect(emojiKey('\u{A9}')).toBe('00a9');
    expect(emojiKey(FAMILY)).toBe('1f468-200d-1f469-200d-1f467');
  });

  it('異体字セレクタ（fe0f）は、key に入れない', () => {
    expect(emojiKey(HEART_EMOJI_STYLE)).toBe('2764');
    expect(emojiKey(KEYCAP_ONE)).toBe('0031-20e3');
  });

  it('画像の一覧（@iconify-json/noto の chars.json）のどの key も、その符号位置の文字列から作る key と同じ', () => {
    for (const key of Object.keys(chars)) {
      const text = String.fromCodePoint(...key.split('-').map((hex) => parseInt(hex, 16)));
      expect(emojiKey(text)).toBe(key);
    }
  });
});

describe('文字列の中の絵文字を見つける', () => {
  it('絵文字 1 つだけの文字列は、絵文字 1 つにする', () => {
    expect(splitEmoji('😀', images('1f600'))).toEqual([
      { kind: 'emoji', text: '😀', key: '1f600' },
    ]);
  });

  it('絵文字が前にあるとき、絵文字と文字に分ける', () => {
    expect(splitEmoji('🎂誕生日', images('1f382'))).toEqual([
      { kind: 'emoji', text: '🎂', key: '1f382' },
      { kind: 'text', text: '誕生日' },
    ]);
  });

  it('絵文字が文字にはさまれているとき、文字・絵文字・文字に分ける', () => {
    expect(splitEmoji('歯医者🦷です', images('1f9b7'))).toEqual([
      { kind: 'text', text: '歯医者' },
      { kind: 'emoji', text: '🦷', key: '1f9b7' },
      { kind: 'text', text: 'です' },
    ]);
  });

  it('絵文字が続くときは、1 つずつに分ける', () => {
    expect(splitEmoji('🎂🎉', images('1f382', '1f389'))).toEqual([
      { kind: 'emoji', text: '🎂', key: '1f382' },
      { kind: 'emoji', text: '🎉', key: '1f389' },
    ]);
  });

  it('ZWJ でつないだ絵文字（👨‍👩‍👧）は、全体で 1 つの絵文字にする（key に ZWJ の 200d も入る）', () => {
    expect(splitEmoji(FAMILY, images('1f468-200d-1f469-200d-1f467'))).toEqual([
      { kind: 'emoji', text: FAMILY, key: '1f468-200d-1f469-200d-1f467' },
    ]);
  });

  it('肌の色つきの絵文字（👍🏽）は、全体で 1 つの絵文字にする（key に肌の色の 1f3fd も入る）', () => {
    expect(splitEmoji('👍🏽', images('1f44d-1f3fd', '1f44d'))).toEqual([
      { kind: 'emoji', text: '👍🏽', key: '1f44d-1f3fd' },
    ]);
  });

  it('fe0f 付きの絵文字（❤️）は絵文字にして、key から fe0f を除く（2764）', () => {
    expect(splitEmoji(HEART_EMOJI_STYLE, images('2764'))).toEqual([
      { kind: 'emoji', text: HEART_EMOJI_STYLE, key: '2764' },
    ]);
  });

  it('fe0f がない ❤ は、文字として表示されるので、同じ key の画像があっても文字のまま', () => {
    expect(splitEmoji(HEART_DEFAULT_STYLE, images('2764'))).toEqual([
      { kind: 'text', text: HEART_DEFAULT_STYLE },
    ]);
  });

  it('キーキャップ（1️⃣）は、1 つの絵文字にする（key は 0031-20e3）', () => {
    expect(splitEmoji(KEYCAP_ONE, images('0031-20e3'))).toEqual([
      { kind: 'emoji', text: KEYCAP_ONE, key: '0031-20e3' },
    ]);
  });

  it('国旗（🇯🇵）は、画像がないので、文字のまま残す', () => {
    expect(splitEmoji(`旅行${FLAG_JAPAN}`, images('1f600'))).toEqual([
      { kind: 'text', text: `旅行${FLAG_JAPAN}` },
    ]);
  });

  it.each(['#', '1', '\u{A9}', '\u{2122}'])(
    '文字として表示される記号（%s）は、同じ key の画像があっても文字のまま',
    (symbol) => {
      expect(splitEmoji(symbol, images('0023', '0031', '00a9', '2122'))).toEqual([
        { kind: 'text', text: symbol },
      ]);
    },
  );

  it('「会議 #1」の # と 1 は、文字のまま（キーキャップではない）', () => {
    expect(splitEmoji('会議 #1', images('0023', '0031', '0023-20e3', '0031-20e3'))).toEqual([
      { kind: 'text', text: '会議 #1' },
    ]);
  });

  it('文字の記号に fe0f を付けたもの（©️）は、画像があれば絵文字にする', () => {
    expect(splitEmoji(COPYRIGHT_EMOJI_STYLE, images('00a9'))).toEqual([
      { kind: 'emoji', text: COPYRIGHT_EMOJI_STYLE, key: '00a9' },
    ]);
  });

  // Unicode 17 で加わった絵文字。Unicode 16 までのデータを持つエンジン（古いブラウザ）では、まだ割り当てがなく、
  // \p{Emoji_Presentation} に当たらない（予約の符号位置）。新しいエンジンでは、割り当て済みで、同じく絵文字になる。
  it.each(['\u{1FAEA}', '\u{1F6D8}'])(
    'エンジンの Unicode のデータが古くて、まだ知らない新しい絵文字（%s）も、画像があれば絵文字にする',
    (emoji) => {
      const key = emojiKey(emoji);

      expect(splitEmoji(emoji, images(key))).toEqual([{ kind: 'emoji', text: emoji, key }]);
      expect(splitEmoji(emoji, images())).toEqual([{ kind: 'text', text: emoji }]);
    },
  );

  it('Intl.Segmenter がないブラウザでは、絵文字を画像にせず、文字のまま返す（画面を止めない）', () => {
    expect(splitEmoji('🎂誕生日', images('1f382'), null)).toEqual([
      { kind: 'text', text: '🎂誕生日' },
    ]);
    expect(splitEmoji('歯医者', images('1f382'), null)).toEqual([{ kind: 'text', text: '歯医者' }]);
    expect(splitEmoji('', images('1f382'), null)).toEqual([]);
  });

  it('日本語だけの文字列は、そのまま 1 つの文字にする', () => {
    expect(splitEmoji('歯医者の予約', images('1f600'))).toEqual([
      { kind: 'text', text: '歯医者の予約' },
    ]);
  });

  it('空の文字列は、何も返さない', () => {
    expect(splitEmoji('', images('1f600'))).toEqual([]);
  });

  it('画像のない絵文字は、文字のまま残し、前後の文字と 1 つにまとめる', () => {
    expect(splitEmoji('A😀B', images())).toEqual([{ kind: 'text', text: 'A😀B' }]);
  });

  it('画像のある絵文字と、ない絵文字が混ざるとき、ある方だけを絵文字にする', () => {
    expect(splitEmoji('🎂誕生日🦷', images('1f382'))).toEqual([
      { kind: 'emoji', text: '🎂', key: '1f382' },
      { kind: 'text', text: '誕生日🦷' },
    ]);
  });

  it('ふつうの文字を、絵文字の前後でも、取りこぼさない（分けた text をつなぐと、元の文字列に戻る）', () => {
    const text = `A🎂B${HEART_EMOJI_STYLE}C${HEART_DEFAULT_STYLE}D${FLAG_JAPAN}E${FAMILY}F`;
    const segments = splitEmoji(text, images('1f382', '2764', '1f468-200d-1f469-200d-1f467'));

    expect(segments.map((segment) => segment.text).join('')).toBe(text);
  });
});
