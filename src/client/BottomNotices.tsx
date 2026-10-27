import styles from './BottomNotices.module.css';
import { UndoNotices } from './form/UndoNotices';
import { useSidebarState } from './sidebar/instance';
import { SyncNotices } from './sync/SyncStatus';

/**
 * 画面の下の知らせの置き場所（設計書 6.5）。同期の知らせと、削除の「元に戻す」を、1 つの列に、左寄せで縦に積む。
 * Why: 別々に固定すると、同じ場所に重なり、押せないボタンができる。右下の ( + ) ボタンにも重なる
 * （重なった部分は、( + ) が押されて、知らせの［閉じる］が押せなかった）。
 * ワークスペースの編集のダイアログが開いている間は、「元に戻す」を、この列に出さない。ダイアログの中に、同じ知らせを
 * 出す（sidebar/WorkspaceEditor.tsx）ので、モーダルの背景の下に、押せない同じ知らせが、重ねて見えてしまうため。
 */
export function BottomNotices() {
  const editing = useSidebarState((state) => state.view === 'editor');
  return (
    <div className={styles.column}>
      <SyncNotices />
      {!editing && <UndoNotices />}
    </div>
  );
}
