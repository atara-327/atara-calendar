import { useId, useLayoutEffect, useMemo, useRef, useState } from 'react';
import type { Workspace } from '../../shared/schema';
import { useBackdropClose } from '../backdropClose';
import { classNames } from '../classNames';
import { EmojiText } from '../emoji/EmojiText';
import { CloseIcon } from '../form/icons';
import { unavailableMessage } from '../form/messages';
import { getSyncEngine, useSyncState } from '../sync/instance';
import { PHASE_NOTICE_MESSAGES, phaseNotice, type PhaseNotice } from '../sync/phaseNotice';
import type { SyncState } from '../sync/state';
import { closeSidebar, openWorkspaceEditor } from './instance';
import styles from './SidebarMenu.module.css';
import { toWorkspaceInput } from './workspaceEdit';
import { menuSections } from './workspaceList';

// サイドメニュー（設計書 11.5。要件 WS-1・3・4）。左から重ねて出す、ネイティブの <dialog>（showModal）。
// Why: フォーカスの閉じ込め・Esc で閉じる・背景を操作できなくする、が、追加の部品なしで手に入る
// （予定のフォーム EntryForm と同じ）。背景を押しても閉じる（backdropClose.ts。予定のフォームも同じ）。

function selectWorkspaces(state: SyncState): SyncState['view']['workspaces'] {
  return state.view.workspaces;
}

function selectNotice(state: SyncState): PhaseNotice | null {
  return phaseNotice(state.phase, state.takenOver);
}

export function SidebarMenu() {
  const dialogRef = useRef<HTMLDialogElement>(null);
  const ids = useId();
  const workspaces = useSyncState(selectWorkspaces);
  // 読み込み中・読み込めなかった・別のタブで開いたため止めた、のとき、その理由。動いているときは null。
  // 理由があるあいだは、チェックボックスと［ワークスペースを編集］を押せない（エンジンが受け付けないため）。
  const notice = useSyncState(selectNotice);
  const ready = notice === null;
  const sections = useMemo(() => menuSections(workspaces.values()), [workspaces]);
  const [failure, setFailure] = useState<string | null>(null);
  const backdropClose = useBackdropClose(closeSidebar);

  // 開いたとき showModal し、閉じるとき close する。useLayoutEffect にするのは、後片付けを、dialog が DOM から外れる前に
  // 行い、開く前にフォーカスのあった要素（≡）へ、フォーカスを戻すため（EntryForm と同じ）。
  useLayoutEffect(() => {
    const dialog = dialogRef.current;
    if (dialog === null) return;
    dialog.showModal();
    return () => {
      dialog.close();
    };
  }, []);

  /**
   * 表示の ON/OFF を、すぐ保存する（設計書 12章 Q3。DB に保存して、全端末で共通）。
   * 組み込みの「祝日」「記念日」も同じ。サーバーは、組み込みの行の visible の変更を許す（設計書 4.2）。
   * 画面（月表示・日表示）は、同期のエンジンの view から描くので、保存した直後に、手元で反映される。
   */
  function toggleVisible(workspace: Workspace, visible: boolean): void {
    try {
      const accepted = getSyncEngine().saveWorkspace({ ...toWorkspaceInput(workspace), visible });
      setFailure(
        accepted === null
          ? unavailableMessage(getSyncEngine().store.getState().phase, '保存')
          : null,
      );
    } catch (error) {
      console.error('表示の切り替えを保存できませんでした', error);
      setFailure('保存できませんでした');
    }
  }

  function row(workspace: Workspace, withEmoji: boolean) {
    return (
      <li key={workspace.id}>
        <label className={styles.row}>
          <input
            type="checkbox"
            className={styles.check}
            checked={workspace.visible}
            disabled={!ready}
            onChange={(event) => {
              toggleVisible(workspace, event.target.checked);
            }}
          />
          <span className={styles.dot} style={{ backgroundColor: workspace.color }} />
          <span className={styles.name}>
            {withEmoji ? <EmojiText text={workspace.name} /> : workspace.name}
          </span>
        </label>
      </li>
    );
  }

  return (
    <dialog
      ref={dialogRef}
      className={styles.drawer}
      aria-label="メニュー"
      // Esc。ブラウザの既定で閉じさせず、✕ と同じ閉じ方にする（履歴を戻すため）。
      onCancel={(event) => {
        event.preventDefault();
        closeSidebar();
      }}
      // Esc を続けて押すと、ブラウザが、cancel を止められずに閉じることがある。そのときも、状態を閉じる。
      // 開いているとき（open）と、後片付けのあと（dialogRef が外れた後）に届く close は、無視する（EntryForm と同じ理由）。
      onClose={(event) => {
        if (event.currentTarget === dialogRef.current && !event.currentTarget.open) {
          closeSidebar();
        }
      }}
      {...backdropClose}
    >
      <div className={styles.panel}>
        <header className={styles.header}>
          <h2 className={styles.heading}>メニュー</h2>
          <button
            type="button"
            className={styles.closeButton}
            aria-label="閉じる"
            onClick={closeSidebar}
          >
            <CloseIcon />
          </button>
        </header>

        {failure !== null && (
          <p className={styles.error} role="alert">
            {failure}
          </p>
        )}

        {/* 月表示・日表示の読み込みの表示（SyncOverview）と同じ文言。読み込みの前は、一覧が空なので、見出しだけの
            節は出さず、この 1 か所で伝える。読み込んだあとに止まったときは、一覧の上に、理由を出す。 */}
        {notice !== null && (
          <p
            className={classNames(styles.notice, notice === 'loading' && styles.muted)}
            role={notice === 'loading' ? 'status' : 'alert'}
          >
            {PHASE_NOTICE_MESSAGES[notice]}
          </p>
        )}

        {(sections.workspaces.length > 0 || ready) && (
          <section className={styles.section} aria-labelledby={`${ids}-workspaces`}>
            <h3 id={`${ids}-workspaces`} className={styles.sectionTitle}>
              ワークスペース
            </h3>
            {sections.workspaces.length > 0 ? (
              <ul className={styles.list}>{sections.workspaces.map((item) => row(item, true))}</ul>
            ) : (
              <p className={styles.note}>ワークスペースがありません</p>
            )}
          </section>
        )}

        {sections.builtins.length > 0 && (
          <section className={styles.section} aria-labelledby={`${ids}-builtins`}>
            <h3 id={`${ids}-builtins`} className={styles.sectionTitle}>
              祝日・記念日
            </h3>
            <ul className={styles.list}>{sections.builtins.map((item) => row(item, false))}</ul>
          </section>
        )}

        <button
          type="button"
          className={styles.editButton}
          disabled={!ready}
          onClick={openWorkspaceEditor}
        >
          ワークスペースを編集
        </button>
      </div>
    </dialog>
  );
}
