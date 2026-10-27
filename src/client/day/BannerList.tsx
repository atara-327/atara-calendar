import { readableTextColor } from '../color';
import { EmojiText } from '../emoji/EmojiText';
import { openEditForm } from '../form/instance';
import type { BannerItem } from './dayItems';
import styles from './DayView.module.css';

/**
 * 上部の欄（DV-6）。終日の予定と、24 時間以上の時間指定の予定を、1 件 1 行で出す。タイムブロックは出さない（タイムラインに、日ごとに切り取って出す。dayItems.ts）。
 * 高さに上限があり（約 3.5 行）、超えたら欄の中でスクロールする。スマホで、タイムラインが見えなくならないため。
 * 1 件もなければ、欄ごと出さない。
 */
export function BannerList({ items }: { items: readonly BannerItem[] }) {
  if (items.length === 0) return null;
  return (
    <div className={styles.banner}>
      {items.map((item) => (
        <button
          key={item.key}
          type="button"
          aria-label={item.accessibleName}
          className={styles.bannerItem}
          // ワークスペースの色は、実行時に決まるので、CSP の下でも使える React の style（CSSOM）で与える
          // （設計書 11.2）。
          style={{ backgroundColor: item.color, color: readableTextColor(item.color) }}
          onClick={() => {
            openEditForm(item.occurrence);
          }}
        >
          <span className={styles.bannerTitle}>
            <EmojiText text={item.title} />
          </span>
          {item.period !== null && <span className={styles.bannerPeriod}>{item.period}</span>}
        </button>
      ))}
    </div>
  );
}
