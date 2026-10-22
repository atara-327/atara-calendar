// 仮想モジュール。vite-plugins/notoEmoji.ts が、ビルドと vite dev で作る。
declare module 'virtual:noto-emoji' {
  /** 画像の URL の先頭（`/emoji/<パッケージの版>/`）。後ろに `<key>.svg` を付ける。 */
  export const EMOJI_BASE_URL: string;
  /** 画像のある key の集合。key の作り方は設計書 11.1 の「絵文字（NF-7）」。 */
  export const EMOJI_KEYS: ReadonlySet<string>;
}
