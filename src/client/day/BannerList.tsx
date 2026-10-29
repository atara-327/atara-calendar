import { classNames } from '../classNames';
import { readableTextColor } from '../color';
import { EmojiText } from '../emoji/EmojiText';
import { openEditForm } from '../form/instance';
import type { BannerItem } from './dayItems';
import styles from './DayView.module.css';

/**
 * 上部の欄（DV-6）。祝日・記念日と、終日の予定と、24 時間以上の時間指定の予定を、1 件 1 行で出す。タイムブロックは出さない（タイムラインに、日ごとに切り取って出す。dayItems.ts）。
 * 高さに上限があり（約 3.5 行）、超えたら欄の中でスクロールする。スマホで、タイムラインが見えなくならないため。
 * 1 件もなければ、欄ごと出さない。
 * 祝日・記念日は、編集も削除もできないので、押せない項目（<div>）にする。<button> にしないのは、押してもフォームを
 * 開かないのに、Tab で止まったり、ボタンとして読み上げられたりするのを避けるため。名前は、そのまま読み上げられる。
 */
export function BannerList({ items }: { items: readonly BannerItem[] }) {
  if (items.length === 0) return null;
  return (
    <div className={styles.banner}>
      {items.map((item) => {
        // ワークスペースの色は、実行時に決まるので、CSP の下でも使える React の style（CSSOM）で与える
        // （設計書 11.2）。
        const style = { backgroundColor: item.color, color: readableTextColor(item.color) };
        if (item.source !== 'entry') {
          return (
            <div key={item.key} className={styles.bannerItem} style={style}>
              <span className={styles.bannerTitle}>{item.title}</span>
            </div>
          );
        }
        const { occurrence } = item;
        return (
          <button
            key={item.key}
            type="button"
            aria-label={item.accessibleName}
            className={classNames(styles.bannerItem, styles.bannerButton)}
            style={style}
            onClick={() => {
              openEditForm(occurrence);
            }}
          >
            <span className={styles.bannerTitle}>
              <EmojiText text={item.title} />
            </span>
            {item.period !== null && <span className={styles.bannerPeriod}>{item.period}</span>}
          </button>
        );
      })}
    </div>
  );
}
