import type { DateStr } from '../../shared/date';
import { formatDayTitle } from '../dateFormat';
import { goToMonth } from '../navigation';
import { PendingBadge, SyncOverview } from '../sync/SyncStatus';
import styles from './DayPlaceholder.module.css';

// 日表示（実装 #9）ができるまでの、仮の画面。月表示から日付をタップして移る先（MV-8）が、
// 行き止まりにならないよう、日付と、月表示に戻るボタンだけを出す。
// 同期の状態（未送信の件数・読み込みの状態）も出す。/day/... を直接開いて、読み込みに失敗したとき、
// 再試行のボタンがないと、行き止まりになるため。
export function DayPlaceholder({ date }: { date: DateStr }) {
  return (
    <main className={styles.screen}>
      <div className={styles.status}>
        <PendingBadge />
      </div>
      <SyncOverview />
      <h1 className={styles.date}>{formatDayTitle(date)}</h1>
      <p className={styles.message}>日表示は実装 #9 で作ります</p>
      <button type="button" className={styles.button} onClick={goToMonth}>
        月表示に戻る
      </button>
    </main>
  );
}
