import { useStore } from 'zustand';
import { getSyncEngine } from '../sync/instance';
import styles from './UndoNotices.module.css';
import { createUndoNotices } from './undoNotices';

const undoNotices = createUndoNotices({
  // エンジンを、使うときに初めて作る（sync/instance.ts）。ここで先に作らない。
  undo: (requestId) => getSyncEngine().undo(requestId),
  setTimeout: (callback, ms) => window.setTimeout(callback, ms),
  clearTimeout: (handle) => {
    if (typeof handle === 'number') window.clearTimeout(handle);
  },
});

/** 削除したことを知らせ、DELETE_UNDO_MS の間、元に戻すボタンを出す。 */
export function showDeletedNotice(requestId: string): void {
  undoNotices.show(requestId);
}

/**
 * 画面の下の「削除しました［元に戻す］」（OT-1。設計書 6.6）。置き場所は、同期の知らせと同じ列（BottomNotices）。
 * ワークスペースの編集のダイアログ（sidebar/WorkspaceEditor.tsx）の中にも、同じ知らせを出す。削除のあとも、ダイアログが
 * 開いたままで、モーダルの外の列は、押せないため。知らせの状態（undoNotices）は 1 つで、どちらにも同じものが出る。
 * 中身がないときも、読み上げ用の領域（role="status"）は置いておく。あとから領域を足すと、
 * 読み上げソフトが、出てきた知らせを読まないことがある。
 */
export function UndoNotices() {
  const notices = useStore(undoNotices.store, (state) => state.notices);
  return (
    <div className={styles.list} role="status">
      {notices.map((notice) => (
        <p key={notice.id} className={styles.notice}>
          {notice.status === 'waiting' ? (
            <>
              <span>削除しました</span>
              <button
                type="button"
                className={styles.button}
                onClick={() => {
                  undoNotices.undo(notice.id);
                }}
              >
                元に戻す
              </button>
            </>
          ) : (
            <span>元に戻せませんでした（すでにサーバーへ送っています）</span>
          )}
        </p>
      ))}
    </div>
  );
}
