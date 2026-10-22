import { useSyncState } from '../sync/instance';
import styles from './AddEntryButton.module.css';
import { PlusIcon } from './icons';
import { openCreateForm } from './instance';
import type { StartPoint } from './schedule';
import type { EntryKind } from './values';

/**
 * ( + ) ボタン（設計書 11.2）。画面の右下に浮かせて、新しいフォームを開く。
 * 最初の読み込みが終わるまでは押せない。終わる前に開くと、ワークスペースの選択肢がなく、
 * 保存してもエンジンが受け付けない（engine.ts）ため、入力してから失敗するより、先に押せなくする。
 */
export function AddEntryButton({
  kind,
  start,
}: {
  kind: EntryKind;
  /**
   * 開始の初期値を決める関数。押したときに呼ぶ。省くと、今日の次の正時から。
   * 値ではなく関数にするのは、日表示が、見ている日と、押した時刻の次の正時から始めるため。値を渡すと、
   * 描画した時点の時刻が残り、1 時間以上開いたままのとき、過ぎた時刻から始まってしまう。
   */
  start?: () => StartPoint;
}) {
  const ready = useSyncState((state) => state.phase === 'ready');
  return (
    <button
      type="button"
      className={styles.button}
      aria-label={kind === 'event' ? '予定を作成' : 'タイムブロックを作成'}
      disabled={!ready}
      onClick={() => {
        openCreateForm(kind, start?.());
      }}
    >
      <PlusIcon />
    </button>
  );
}
