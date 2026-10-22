/** 文字列を分けた 1 つのまとまり。続く文字は 1 つの text にまとめる。 */
export type EmojiSegment =
  { kind: 'text'; text: string } | { kind: 'emoji'; text: string; key: string };

// 絵文字として表示されるまとまり（書記素）の目印。
// \p{Emoji} にしないのは、「#」「1」「©」「™」のような、ふつうは文字として表示される記号も含むため。
// 「会議 #1」の「#」と「1」が、画像になってはいけない。
// U+FE0F（絵文字の表示を求める印）と U+20E3（キーキャップ）は、これらの記号を絵文字として表示させるときに付く。
const DISPLAYED_AS_EMOJI = /\p{Emoji_Presentation}|\u{FE0F}|\u{20E3}/u;

// Intl.Segmenter は、Firefox 114〜124 にない（Vite の既定のビルド対象に、Firefox 114 が入っている）。
// 画面の読み込みで、ないものを使って例外を投げると、アプリ全体が真っ白になる。
// ないときは、絵文字を画像にせず、端末の絵文字のまま出す。ないからといって動かさないと、古いブラウザで予定が見られなくなる
// （設計書 6.7 の navigator.locks と同じ考え方）。
const defaultSegmenter =
  'Segmenter' in Intl ? new Intl.Segmenter(undefined, { granularity: 'grapheme' }) : null;

/**
 * 画像の key。符号位置を 16 進の小文字で、4 桁に 0 埋めして `-` でつなぐ（@iconify-json/noto の chars.json の形）。
 * 異体字セレクタ（U+FE0F）は除く。chars.json の key にはなく、付けても付けなくても同じ絵文字のため。
 */
export function emojiKey(grapheme: string): string {
  const parts: string[] = [];
  for (const character of grapheme) {
    const codePoint = character.codePointAt(0);
    if (codePoint === undefined || codePoint === 0xfe0f) continue;
    parts.push(codePoint.toString(16).padStart(4, '0'));
  }
  return parts.join('-');
}

/**
 * 文字列を、画像にする絵文字と、そのほかの文字に分ける。
 * 画像にするのは、絵文字として表示されるまとまりで、かつ画像がある（hasImage に key がある）ものだけ。
 * 画像のないもの（国旗など）は、文字のまま残して、端末の絵文字で表示させる。
 * segmenter を引数にするのは、Intl.Segmenter がないブラウザの動きを、テストするため。
 */
export function splitEmoji(
  text: string,
  hasImage: ReadonlySet<string>,
  segmenter: Intl.Segmenter | null = defaultSegmenter,
): readonly EmojiSegment[] {
  if (text === '') return [];
  // 絵文字として表示される文字が 1 つもなければ、書記素に分けない（ほとんどの題名がこれ。月表示は、1 画面に数十の題名を描く）。
  // 分けるかどうかの判定が、まとまりごとの判定（下）と同じ正規表現なので、見逃しはない。
  if (segmenter === null || !DISPLAYED_AS_EMOJI.test(text)) return [{ kind: 'text', text }];

  const segments: EmojiSegment[] = [];
  let pendingText = '';
  for (const { segment } of segmenter.segment(text)) {
    const key = DISPLAYED_AS_EMOJI.test(segment) ? emojiKey(segment) : undefined;
    if (key === undefined || !hasImage.has(key)) {
      pendingText += segment;
      continue;
    }
    if (pendingText !== '') {
      segments.push({ kind: 'text', text: pendingText });
      pendingText = '';
    }
    segments.push({ kind: 'emoji', text: segment, key });
  }
  if (pendingText !== '') segments.push({ kind: 'text', text: pendingText });
  return segments;
}
