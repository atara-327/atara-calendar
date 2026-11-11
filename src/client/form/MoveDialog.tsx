import { useLayoutEffect, useRef, useState, type SubmitEvent } from 'react';
import type { Scope } from '../../shared/schema';
import { useBackdropClose } from '../backdropClose';
import { getSyncEngine } from '../sync/instance';
import styles from './EntryForm.module.css';
import type { FormTarget } from './formController';
import { CloseIcon } from './icons';
import { closeEntryForm } from './instance';
import { scopeChangedMessage, scopeUnavailableMessage, unavailableMessage } from './messages';
import { outcomesOf } from './outcomes';
import { recheckScope } from './scope';
import { ScopeStep } from './ScopeStep';

type MoveTarget = Extract<FormTarget, { mode: 'move' }>;

/**
 * ドラッグで時刻を移したあとの、範囲を聞く段（設計書 11.3・11.4）。入力の段はなく、EntryForm の範囲を聞く段
 * （ScopeStep）だけを出す。Why not EntryForm を開いて、保存を押した状態にする: 入力の段が、一瞬、見えてしまい、
 * 繰り返さない予定を、その場で保存する道と、分かれてしまうため。
 * 「戻る」と ✕ は、どちらも閉じる（動かす前の位置のまま。保存しない）。
 */
export function MoveDialog({ target }: { target: MoveTarget }) {
  const dialogRef = useRef<HTMLDialogElement>(null);
  const backdropClose = useBackdropClose(closeEntryForm);
  const { scopes, occurrence, changes } = target;
  const [selected, setSelected] = useState<Scope | null>(scopes?.[0] ?? null);
  // 範囲を聞けない（保存できなかった）ときと、範囲を聞く段で保存できなかったときの理由。
  const [message, setMessage] = useState<string | null>(target.message);
  const asking = scopes !== null && scopes.length > 0 && message === null;

  useLayoutEffect(() => {
    const dialog = dialogRef.current;
    if (dialog === null) return;
    dialog.showModal();
    dialog.querySelector<HTMLElement>('input[name="scope"]:checked')?.focus();
    return () => {
      dialog.close();
    };
  }, []);

  function apply(): void {
    if (selected === null) return;
    try {
      const engine = getSyncEngine();
      const recheck = recheckScope({
        rows: engine.store.getState().view.entries.values(),
        occurrence,
        action: { kind: 'change', changes },
        selected,
      });
      if (recheck.kind === 'rejected') {
        setMessage(scopeUnavailableMessage(recheck.decision));
        return;
      }
      if (recheck.kind === 'changed') {
        setMessage(scopeChangedMessage('保存'));
        return;
      }
      const { seriesId, occurrenceDate } = occurrence;
      const accepted = engine.changeEntry({ seriesId, occurrenceDate, scope: selected }, changes);
      if (accepted === null) {
        setMessage(unavailableMessage(engine.store.getState().phase, '保存'));
        return;
      }
      closeEntryForm();
    } catch (error) {
      console.error('予定を保存できませんでした', error);
      setMessage('保存できませんでした');
    }
  }

  function handleSubmit(event: SubmitEvent<HTMLFormElement>): void {
    event.preventDefault();
    if (asking) apply();
  }

  return (
    <dialog
      ref={dialogRef}
      className={styles.dialog}
      aria-label="予定を移す"
      onCancel={(event) => {
        event.preventDefault();
        closeEntryForm();
      }}
      onClose={(event) => {
        if (event.currentTarget === dialogRef.current && !event.currentTarget.open) {
          closeEntryForm();
        }
      }}
      {...backdropClose}
    >
      <form className={styles.form} noValidate onSubmit={handleSubmit}>
        <header className={styles.header}>
          <button
            type="button"
            className={styles.closeButton}
            aria-label="閉じる"
            title="保存せずに閉じる"
            onClick={closeEntryForm}
          >
            <CloseIcon />
          </button>
        </header>
        {asking && selected !== null ? (
          <ScopeStep
            action="save"
            scopes={scopes}
            selected={selected}
            outcomes={outcomesOf({
              rows: getSyncEngine().store.getState().view.entries.values(),
              occurrence,
              changes,
              scopes,
              shownStartDate: changes.startDate ?? occurrence.startDate,
            })}
            error={null}
            onSelect={setSelected}
            onBack={closeEntryForm}
          />
        ) : (
          <div className={styles.scopeStep}>
            <p className={styles.error} role="alert">
              {message ?? '保存できませんでした'}
            </p>
            <div className={styles.scopeButtons}>
              <button type="button" className={styles.backButton} onClick={closeEntryForm}>
                閉じる
              </button>
            </div>
          </div>
        )}
      </form>
    </dialog>
  );
}
