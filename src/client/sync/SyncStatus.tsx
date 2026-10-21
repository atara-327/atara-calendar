import { liveWorkspaceIds } from '../../shared/workspace';
import { getSyncEngine, useSyncState } from './instance';
import { selectPendingCount, type SyncState } from './state';
import styles from './SyncStatus.module.css';

// 同期の状態の表示（設計書 6.2・6.5）。月表示などの本体（実装 #7 以降）ができるまでの、最小限の画面。
// 色は、設計書 11.1 の配色（global.css の CSS 変数）に合わせる。

/** 「未送信 N件」。電波がない間に保存した変更が、まだ他の端末に届いていないことを、知っておけるようにする（設計書 6.5）。 */
export function PendingBadge() {
  const count = useSyncState(selectPendingCount);
  if (count === 0) return null;
  return (
    <p className={styles.pending} role="status">
      未送信 {count}件
    </p>
  );
}

function liveEntryCount(state: SyncState): number {
  let count = 0;
  for (const entry of state.view.entries.values()) {
    if (entry.deletedAt === null) count += 1;
  }
  return count;
}

function liveWorkspaceCount(state: SyncState): number {
  return liveWorkspaceIds(state.view.workspaces.values()).size;
}

/** 読み込みの状態と、読み込んだ件数。 */
export function SyncOverview() {
  const phase = useSyncState((state) => state.phase);
  const takenOver = useSyncState((state) => state.takenOver);
  const entries = useSyncState(liveEntryCount);
  const workspaces = useSyncState(liveWorkspaceCount);

  if (phase === 'stopped' && takenOver) {
    // 同じ端末で、別のタブを開いたので、このタブは動かさない（設計書 6.2。Q5）。
    return (
      <section className={styles.overview} role="alert">
        <p>別のタブで開いたため、このタブは止めました</p>
      </section>
    );
  }
  if (phase === 'loadFailed') {
    return (
      <section className={styles.overview} role="alert">
        <p>読み込めませんでした</p>
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
  if (phase !== 'ready') {
    return (
      <section className={styles.overview} role="status">
        <p className={styles.muted}>読み込み中…</p>
      </section>
    );
  }
  return (
    <section className={styles.overview}>
      <p>予定 {entries}件</p>
      <p>ワークスペース {workspaces}件</p>
    </section>
  );
}

/** 画面の下に出す知らせ。 */
export function SyncNotices() {
  const discarded = useSyncState((state) => state.discarded);
  const authRequired = useSyncState((state) => state.authRequired);
  const syncError = useSyncState((state) => state.syncError);
  const storageFailed = useSyncState((state) => state.storageFailed);

  return (
    <div className={styles.notices}>
      {discarded.count > 0 && (
        <p className={styles.notice} role="alert">
          <span>
            保存できなかった変更が {discarded.count} 件あります
            {discarded.clockSkew && '。端末の時計がずれています。時計を合わせてください'}
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
    </div>
  );
}
