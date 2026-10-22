import { useSyncState } from '../sync/instance';
import styles from './AddEntryButton.module.css';
import { PlusIcon } from './icons';
import { openCreateForm } from './instance';
import type { EntryKind } from './values';

/**
 * ( + ) ボタン（設計書 11.2）。画面の右下に浮かせて、新しいフォームを開く。
 * 最初の読み込みが終わるまでは押せない。終わる前に開くと、ワークスペースの選択肢がなく、
 * 保存してもエンジンが受け付けない（engine.ts）ため、入力してから失敗するより、先に押せなくする。
 */
export function AddEntryButton({ kind }: { kind: EntryKind }) {
  const ready = useSyncState((state) => state.phase === 'ready');
  return (
    <button
      type="button"
      className={styles.button}
      aria-label={kind === 'event' ? '予定を作成' : 'タイムブロックを作成'}
      disabled={!ready}
      onClick={() => {
        openCreateForm(kind);
      }}
    >
      <PlusIcon />
    </button>
  );
}
