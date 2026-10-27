import { dayOfWeek, type DateStr } from '../../shared/date';
import { classNames } from '../classNames';
import { formatMonthDay, formatYear } from '../dateFormat';
import { MenuButton } from '../sidebar/MenuButton';
import { PendingBadge } from '../sync/SyncStatus';
import type { DayNames } from './dayItems';
import styles from './DayView.module.css';

const SUNDAY = 0;
const SATURDAY = 6;

// 前後の日の矢印の絵。文字（‹ ›）にしないのは、フォントによって、大きさと高さがずれるため。
// 装飾なので、読み上げからは外す（ボタンに aria-label を付ける）。
function ChevronIcon({ direction }: { direction: 'left' | 'right' }) {
  return (
    <svg viewBox="0 0 24 24" width="24" height="24" aria-hidden="true" focusable="false">
      <path
        d={direction === 'left' ? 'M15 6l-6 6 6 6' : 'M9 6l6 6-6 6'}
        fill="none"
        stroke="currentColor"
        strokeWidth="2.5"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}

interface DayHeaderProps {
  date: DateStr;
  names: DayNames;
  /** 範囲（1900〜2199 年）の端では、前（後）の日へ移れない。 */
  hasPrevious: boolean;
  hasNext: boolean;
  onMonth: () => void;
  onPrevious: () => void;
  onNext: () => void;
  onToday: () => void;
}

/**
 * 日表示の固定のヘッダー。1 行目に、≡・［月表示］・前の日・日付・次の日・［今日］。
 * 日付の年は、幅の狭い画面（約 640px 以下。月表示と同じ境目）では、CSS で隠す（≡ が増えて、年まで収まらないため）。
 * 隠した年は、読み上げからも外れる（display: none）。見えるとおりの読み上げでよい。
 * 2 行目に、祝日名・記念日名（全文。折り返してよい）と、未送信の件数（右端）。
 * 未送信の件数を 1 行目に入れないのは、スマホの幅（412px）では、1 行目に、件数まで収まらないため。
 * 2 行目は、中身がなければ、高さを持たない（styles.subRow の :empty）。
 */
export function DayHeader({
  date,
  names,
  hasPrevious,
  hasNext,
  onMonth,
  onPrevious,
  onNext,
  onToday,
}: DayHeaderProps) {
  const weekday = dayOfWeek(date);
  // 日付の色は、月表示と同じ決まり（設計書 11.2）。祝日と日曜は赤、土曜は青。祝日が土曜に重なれば、祝日の赤。
  const titleClass = classNames(
    styles.title,
    (names.holiday !== null || weekday === SUNDAY) && styles.holiday,
    names.holiday === null && weekday === SATURDAY && styles.saturday,
  );
  const hasNames = names.holiday !== null || names.observances.length > 0;

  return (
    <header className={styles.header}>
      <div className={styles.titleRow}>
        <MenuButton />
        <button type="button" className={styles.pill} onClick={onMonth}>
          月表示
        </button>
        <button
          type="button"
          className={styles.arrow}
          aria-label="前の日"
          disabled={!hasPrevious}
          onClick={onPrevious}
        >
          <ChevronIcon direction="left" />
        </button>
        <h1 className={titleClass}>
          <span className={styles.titleYear}>{formatYear(date)}</span>
          {formatMonthDay(date)}
        </h1>
        <button
          type="button"
          className={styles.arrow}
          aria-label="次の日"
          disabled={!hasNext}
          onClick={onNext}
        >
          <ChevronIcon direction="right" />
        </button>
        <button type="button" className={classNames(styles.pill, styles.today)} onClick={onToday}>
          今日
        </button>
      </div>
      <div className={styles.subRow}>
        {hasNames && (
          <p className={styles.names}>
            {names.holiday !== null && <span className={styles.holidayName}>{names.holiday}</span>}
            {names.observances.map((name) => (
              <span key={name} className={styles.observanceName}>
                {name}
              </span>
            ))}
          </p>
        )}
        <PendingBadge />
      </div>
    </header>
  );
}
