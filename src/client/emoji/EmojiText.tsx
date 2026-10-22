import { Fragment, useState } from 'react';
import { EMOJI_BASE_URL, EMOJI_KEYS } from 'virtual:noto-emoji';
import styles from './EmojiText.module.css';
import { splitEmoji } from './splitEmoji';

function EmojiImage({ emoji, imageKey }: { emoji: string; imageKey: string }) {
  // 失敗した画像の key を覚える（true / false にしないのは、同じ場所に別の絵文字が来たとき、失敗を引きずらないため）。
  const [failedKey, setFailedKey] = useState<string>();

  // 読み込めなかったとき（電波がない間など）は、端末の絵文字に切り替える。
  // alt に任せないのは、読み込めない画像が、ブラウザによって、壊れた画像の印で出るため（設計書 11.1）。
  if (failedKey === imageKey) return emoji;

  return (
    <img
      className={styles.emoji}
      src={`${EMOJI_BASE_URL}${imageKey}.svg`}
      // コピーしたときに、元の絵文字になる。読み上げも、絵文字の名前になる。
      alt={emoji}
      draggable={false}
      decoding="async"
      onError={() => {
        setFailedKey(imageKey);
      }}
    />
  );
}

/** 文字列を出す。絵文字は、Noto Color Emoji の画像にする（設計書 11.1）。 */
export function EmojiText({ text }: { text: string }) {
  return splitEmoji(text, EMOJI_KEYS).map((segment, index) =>
    segment.kind === 'emoji' ? (
      <EmojiImage key={index} emoji={segment.text} imageKey={segment.key} />
    ) : (
      <Fragment key={index}>{segment.text}</Fragment>
    ),
  );
}
