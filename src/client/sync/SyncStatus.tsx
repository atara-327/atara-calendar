import { classNames } from '../classNames';
import { getSyncEngine, useSyncState } from './instance';
import { PHASE_NOTICE_MESSAGES, phaseNotice } from './phaseNotice';
import { serverFailureMessage } from './serverFailure';
import { selectPendingCount } from './state';
import styles from './SyncStatus.module.css';

// 同期の状態の表示（設計書 6.2・6.5）。月表示が使う。
// 色は、設計書 11.1 の配色（global.css の CSS 変数）に合わせる。

/**
 * 「未送信 N件」。電波がない間に保存した変更が、まだ他の端末に届いていないことを、知っておけるようにする（設計書 6.5）。
 * 置く場所は、使う側が決める（月表示では、ヘッダーの「今日」ボタンの隣）。
 */
export function PendingBadge() {
  const count = useSyncState(selectPendingCount);
  if (count === 0) return null;
  return (
    <p className={styles.pending} role="status">
      未送信 {count}件
    </p>
  );
}

/**
 * 読み込みの状態。読み込み中・読み込めなかった・別のタブで止めた、のときだけ、月表示の上に重ねて出す。
 * 読み込めているときは、何も出さない（月表示の邪魔にならないように）。
 * 親は、position: relative の領域にすること。
 */
export function SyncOverview() {
  const notice = useSyncState((state) => phaseNotice(state.phase, state.takenOver));

  if (notice === null) return null;
  const message = PHASE_NOTICE_MESSAGES[notice];
  if (notice === 'takenOver') {
    // 同じ端末で、別のタブを開いたので、このタブは動かさない（設計書 6.7。実装 #6 の確認 Q5）。
    return (
      <section className={styles.overview} role="alert">
        <p>{message}</p>
      </section>
    );
  }
  if (notice === 'loadFailed') {
    return (
      <section className={styles.overview} role="alert">
        <p>{message}</p>
        <button
          type="button"
          className={styles.button}
          onClick={() => {
            void getSyncEngine().syncNow();
          }}
        >
          もう一度読み込む
        </button>
      </section>
    );
  }
  return (
    <section className={classNames(styles.overview, styles.passive)} role="status">
      <p className={styles.muted}>{message}</p>
    </section>
  );
}

/**
 * 画面の下に出す知らせ。置き場所（画面の下の、左寄せの 1 つの列。右は ( + ) ボタンのために空ける）は、
 * 使う側（BottomNotices）が決める。元に戻すの知らせ（form/UndoNotices）と、同じ列に並べるため。
 */
export function SyncNotices() {
  const discarded = useSyncState((state) => state.discarded);
  const authRequired = useSyncState((state) => state.authRequired);
  const serverFailure = useSyncState((state) => serverFailureMessage(state.serverFailure));
  const syncError = useSyncState((state) => state.syncError);
  const storageFailed = useSyncState((state) => state.storageFailed);

  return (
    <>
      {discarded.count > 0 && (
        <p className={styles.notice} role="alert">
          <span>
            保存できなかった変更が {discarded.count} 件あります
            {discarded.clockSkew &&
              '。端末の時計がずれています。時計を合わせてから、ページを開き直してください'}
          </span>
          <button
            type="button"
            className={styles.button}
            onClick={() => {
              getSyncEngine().dismissDiscarded();
            }}
          >
            閉じる
          </button>
        </p>
      )}
      {authRequired && (
        <p className={styles.notice} role="alert">
          <span>ログインし直してください（ページを開き直してください）</span>
          <button
            type="button"
            className={styles.button}
            onClick={() => {
              window.location.reload();
            }}
          >
            開き直す
          </button>
        </p>
      )}
      {serverFailure !== null && (
        // 閉じるボタンは付けない。今の状態を表す知らせで、直れば（次に成功すれば）自分で消える。
        <p className={styles.notice} role="alert">
          {serverFailure}
        </p>
      )}
      {syncError && (
        <p className={styles.notice} role="alert">
          サーバーのデータを読み取れませんでした。しばらくしてから、もう一度お試しください
        </p>
      )}
      {storageFailed && (
        <p className={styles.notice} role="alert">
          この端末では、未送信の変更を保存できません（タブを閉じると失われます）
        </p>
      )}
    </>
  );
}
