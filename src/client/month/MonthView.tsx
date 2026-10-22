import { useState } from 'react';
import { WEEKDAY_LABELS } from '../dateFormat';
import { AddEntryButton } from '../form/AddEntryButton';
import { PendingBadge, SyncOverview } from '../sync/SyncStatus';
import { useToday } from '../useToday';
import { MonthGrid } from './MonthGrid';
import styles from './MonthView.module.css';
import { headerTitle } from './labels';
import { loadScrollRows } from './scrollMemory';
import { rowHeightFor } from './sizing';
import { useElementHeight } from './useElementHeight';
import { scrollRowsForToday, weekOfRow } from './weeks';

const SUNDAY = 0;
const SATURDAY = 6;

/**
 * 月表示（MV-1〜10）。固定のヘッダー（年月・今日ボタン・曜日）と、縦に途切れずスクロールする週の行と、
 * 新しい予定を作る ( + ) ボタン。
 * まだない部品は出さない（≡ のサイドメニューは実装 #10）。
 */
export function MonthView() {
  const today = useToday();
  const [scrollElement, setScrollElement] = useState<HTMLDivElement | null>(null);
  const viewportHeight = useElementHeight(scrollElement);
  const rowHeight = rowHeightFor(viewportHeight);
  const [topRow, setTopRow] = useState(() =>
    Math.floor(loadScrollRows() ?? scrollRowsForToday(today)),
  );

  const goToToday = () => {
    scrollElement?.scrollTo({ top: scrollRowsForToday(today) * rowHeight });
  };

  return (
    <div className={styles.screen}>
      <header className={styles.header}>
        <h1 className={styles.title}>{headerTitle(weekOfRow(topRow))}</h1>
        <div className={styles.headerEnd}>
          <PendingBadge />
          <button type="button" className={styles.todayButton} onClick={goToToday}>
            今日
          </button>
        </div>
      </header>
      <div className={styles.weekdays} aria-hidden="true">
        {WEEKDAY_LABELS.map((label, weekday) => (
          <span
            key={label}
            className={
              weekday === SUNDAY
                ? styles.sundayLabel
                : weekday === SATURDAY
                  ? styles.saturdayLabel
                  : styles.weekday
            }
          >
            {label}
          </span>
        ))}
      </div>
      <div className={styles.body}>
        <div ref={setScrollElement} className={styles.scroller}>
          {scrollElement !== null && viewportHeight > 0 && (
            <MonthGrid
              key={rowHeight}
              scrollElement={scrollElement}
              viewportHeight={viewportHeight}
              rowHeight={rowHeight}
              today={today}
              onTopRowChange={setTopRow}
            />
          )}
        </div>
        <SyncOverview />
      </div>
      <AddEntryButton kind="event" />
    </div>
  );
}
