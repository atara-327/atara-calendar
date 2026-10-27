import { useId, useLayoutEffect, useMemo, useRef, useState, type SubmitEvent } from 'react';
import { INPUT_LIMITS, type Workspace } from '../../shared/schema';
import { EmojiText } from '../emoji/EmojiText';
import formStyles from '../form/EntryForm.module.css';
import { CloseIcon } from '../form/icons';
import { unavailableMessage } from '../form/messages';
import { UndoNotices, showDeletedNotice } from '../form/UndoNotices';
import { getSyncEngine, useSyncState } from '../sync/instance';
import type { SyncState } from '../sync/state';
import { isSameColor } from '../workspaceColors';
import { closeSidebar } from './instance';
import styles from './WorkspaceEditor.module.css';
import {
  colorSwatches,
  countEntriesIn,
  isLastWorkspace,
  newWorkspaceInput,
  reorderWorkspaces,
  toWorkspaceInput,
  validateWorkspaceName,
  workspaceToSave,
  type MoveDirection,
  type WorkspaceInput,
} from './workspaceEdit';
import { menuSections } from './workspaceList';

// ワークスペースの編集（設計書 11.5。要件 WS-1）。サイドメニューの［ワークスペースを編集］で開く、ダイアログ。
// 予定のフォーム（EntryForm）と同じ形（スマホでは下から出るシート、PC では中央のダイアログ）で、ネイティブの
// <dialog>（showModal）を使う。見た目の枠は、EntryForm と同じ CSS を使う（形をそろえるため）。
// 中身は、段で差し替える。一覧 → 名前と色（新しく作るときも）→ 削除の確認。
// Why not 段ごとにダイアログを重ねる: 入れ子にすると、履歴を積む仕組み（スマホの「戻る」で閉じる。historyMark.ts）や、
// Esc・戻るの扱いが増えるため（予定のフォームの、範囲を聞く段 ScopeStep と同じ）。
// Esc・✕・スマホの「戻る」は、どの段にいても、全部を閉じる。段の中の［戻る］は、一つ前の段に戻る。

interface EditState {
  /** 入力の途中の値。名前は、前後の空白を除く前の、入力したまま。 */
  draft: WorkspaceInput;
  /** 開いたときの行。新しく作るときは null。変えたかの比べる先と、色の見本の「今の色」。 */
  original: Workspace | null;
  /** 保存を押したか。押したあとだけ、名前の誤りを出す（開いた直後の空の名前に、誤りを出さないため）。 */
  attempted: boolean;
}

type Step =
  { kind: 'list' } | { kind: 'edit'; edit: EditState } | { kind: 'confirm'; edit: EditState };

function selectWorkspaces(state: SyncState): SyncState['view']['workspaces'] {
  return state.view.workspaces;
}

function selectEntries(state: SyncState): SyncState['view']['entries'] {
  return state.view.entries;
}

function ArrowIcon({ direction }: { direction: MoveDirection }) {
  return (
    <svg viewBox="0 0 24 24" width="24" height="24" aria-hidden="true" focusable="false">
      <path
        d={direction === 'up' ? 'M6 15l6-6 6 6' : 'M6 9l6 6 6-6'}
        fill="none"
        stroke="currentColor"
        strokeWidth="2.5"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}

export function WorkspaceEditor() {
  const dialogRef = useRef<HTMLDialogElement>(null);
  const ids = useId();
  const workspaces = useSyncState(selectWorkspaces);
  const users = useMemo(() => menuSections(workspaces.values()).workspaces, [workspaces]);
  const [step, setStep] = useState<Step>({ kind: 'list' });
  const [failure, setFailure] = useState<string | null>(null);
  // 段を変えたあと、フォーカスを置く先（data-focus の値）。段の中身は差し替わるので、押したボタンが DOM から外れ、
  // フォーカスが失われるため（予定のフォームの、範囲を聞く段から戻るときと同じ）。
  const pendingFocus = useRef<string | null>(null);
  // ［↑］［↓］で動かした行のボタン。並びが変わると、押したボタンの DOM が動き、フォーカスが外れることがあるため、
  // 動かしたあとに、同じ行の同じボタン（端で押せなくなったら、反対のボタン）へ、フォーカスを戻す。
  const [moved, setMoved] = useState<{ id: string; direction: MoveDirection } | null>(null);

  // 開いたとき showModal し、閉じるとき close する（EntryForm と同じ理由で、useLayoutEffect）。
  useLayoutEffect(() => {
    const dialog = dialogRef.current;
    if (dialog === null) return;
    dialog.showModal();
    return () => {
      dialog.close();
    };
  }, []);

  const stepKind = step.kind;
  useLayoutEffect(() => {
    const dialog = dialogRef.current;
    if (dialog === null || pendingFocus.current === null) return;
    dialog.querySelector<HTMLElement>(`[data-focus="${pendingFocus.current}"]`)?.focus();
    pendingFocus.current = null;
  }, [stepKind]);

  useLayoutEffect(() => {
    const dialog = dialogRef.current;
    if (dialog === null || moved === null) return;
    const pressed = dialog.querySelector<HTMLButtonElement>(
      `button[data-move="${moved.id}:${moved.direction}"]`,
    );
    const other = dialog.querySelector<HTMLButtonElement>(
      `button[data-move="${moved.id}:${moved.direction === 'up' ? 'down' : 'up'}"]`,
    );
    (pressed?.disabled === false ? pressed : other)?.focus();
  }, [moved]);

  function goTo(next: Step, focus: string | null): void {
    setFailure(null);
    pendingFocus.current = focus;
    setStep(next);
  }

  /**
   * エンジンに渡す処理を実行する。受け付けられなかったとき（null）は、理由を出して null を返す。
   * 例外（確認とサーバーの決まりの食い違い）は、ログに残して、入力を残したまま知らせる。握りつぶして先へ進むと、
   * 保存したつもりで、保存されない。
   */
  function submit<T>(action: '保存' | '削除', run: () => T | null): T | null {
    try {
      const accepted = run();
      if (accepted !== null) return accepted;
      setFailure(unavailableMessage(getSyncEngine().store.getState().phase, action));
    } catch (error) {
      console.error(`ワークスペースを${action}できませんでした`, error);
      setFailure(`${action}できませんでした。入力内容を確かめてください`);
    }
    return null;
  }

  function move(id: string, direction: MoveDirection): void {
    setFailure(null);
    setMoved({ id, direction });
    // 値が変わった行だけを、1 行ずつ保存する。エンジンが受け付けるかは、状態（読み込み前・止めたとき）だけで決まるので、
    // ふつうは、すべて受け付けられるか、すべて断られる。
    // 例外: エンジンは、本文を入力用のスキーマで確かめ、合わなければ例外にする。入力のルールを満たさない行が DB に
    // あると（API から入った値など）、途中の行で例外になり、前の行だけが列に入る。その場合も、次の［↑］［↓］で、
    // 並びの順に振り直されるので、並びは、直る。
    submit('保存', () => {
      for (const row of reorderWorkspaces(workspaces.values(), id, direction)) {
        if (getSyncEngine().saveWorkspace(toWorkspaceInput(row)) === null) return null;
      }
      return true;
    });
  }

  function openEdit(workspace: Workspace): void {
    goTo(
      {
        kind: 'edit',
        edit: { draft: toWorkspaceInput(workspace), original: workspace, attempted: false },
      },
      // 名前を直すとは限らない（色を変えるだけかもしれない）ので、スマホで、キーボードを出さない。
      'heading',
    );
  }

  function openAdd(): void {
    // 電波がない間にも、すぐ id が要る（端末で発行する。設計書 4.3）。エンジンの依頼の id と同じ crypto.randomUUID()。
    const draft = newWorkspaceInput(workspaces.values(), crypto.randomUUID());
    goTo({ kind: 'edit', edit: { draft, original: null, attempted: false } }, 'name');
  }

  function save(edit: EditState): void {
    if (validateWorkspaceName(edit.draft.name) !== null) {
      setStep({ kind: 'edit', edit: { ...edit, attempted: true } });
      dialogRef.current?.querySelector<HTMLElement>('[data-focus="name"]')?.focus();
      return;
    }
    const { original } = edit;
    // 新しく作るときは、入力した値をそのまま保存する。
    if (original === null) {
      const created = { ...edit.draft, name: edit.draft.name.trim() };
      if (submit('保存', () => getSyncEngine().saveWorkspace(created)) === null) return;
      goTo({ kind: 'list' }, `row:${created.id}`);
      return;
    }
    // 既存の行は、最新の行を土台に、変えた項目だけを送る（workspaceToSave）。段を開いたときの行全体を送ると、
    // 開いている間に、ほかの端末が変えた、触っていない項目まで戻してしまう。
    const plan = workspaceToSave({
      original,
      latest: getSyncEngine().store.getState().view.workspaces.get(original.id),
      draft: edit.draft,
    });
    if (plan.kind === 'gone') {
      // 段 2 に残しても、直せるものがない。一覧に戻って、理由を出す（goTo は、理由を消すので、あとで出す）。
      pendingFocus.current = 'add';
      setStep({ kind: 'list' });
      setFailure('このワークスペースは、ほかの端末で削除されました');
      return;
    }
    // 何も変えていないなら、何も送らない。送ると、行の編集時刻と rev だけが進み、他の端末が受け取り直す
    // （予定のフォームと同じ）。
    if (
      plan.kind === 'save' &&
      submit('保存', () => getSyncEngine().saveWorkspace(plan.workspace)) === null
    ) {
      return;
    }
    goTo({ kind: 'list' }, `row:${original.id}`);
  }

  function confirmDelete(edit: EditState): void {
    const { original } = edit;
    if (original === null) return;
    // 確認の段を開いている間に、ほかの端末の変更で、最後の 1 つになることがある。サーバーは 400 にし、端末は
    // その依頼を捨てる（保存した変更が画面から消える。設計書 6.2）ので、送る前に、もう一度確かめる。
    if (isLastWorkspace(workspaces.values(), original.id)) {
      // ［削除］は、押せなくなるので、見出しにフォーカスを置く。
      pendingFocus.current = 'heading';
      setStep({ kind: 'edit', edit });
      setFailure('最後の 1 つは削除できません');
      return;
    }
    const accepted = submit('削除', () => getSyncEngine().deleteWorkspace(original.id));
    if (accepted === null) return;
    // 確認は出したので、削除したあとに、5 秒の間、元に戻せるようにする（設計書 11.5・6.6）。
    showDeletedNotice(accepted.requestId);
    goTo({ kind: 'list' }, 'add');
  }

  return (
    <dialog
      ref={dialogRef}
      className={formStyles.dialog}
      aria-label="ワークスペースを編集"
      // Esc。ブラウザの既定で閉じさせず、✕ と同じ閉じ方にする（履歴を戻すため）。保存しない。
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
    >
      <header className={formStyles.header}>
        <h2 className={styles.title} tabIndex={-1} data-focus="heading">
          {step.kind === 'list'
            ? 'ワークスペースを編集'
            : step.kind === 'confirm'
              ? 'ワークスペースを削除'
              : step.edit.original === null
                ? 'ワークスペースを追加'
                : '名前と色'}
        </h2>
        <button
          type="button"
          className={formStyles.closeButton}
          aria-label="閉じる"
          title="保存せずに閉じる"
          onClick={closeSidebar}
        >
          <CloseIcon />
        </button>
      </header>

      {failure !== null && (
        <p className={styles.failure} role="alert">
          {failure}
        </p>
      )}

      {step.kind === 'list' && (
        <div className={styles.body}>
          <ul className={styles.list}>
            {users.map((workspace, index) => (
              <li key={workspace.id} className={styles.item}>
                <span className={styles.dot} style={{ backgroundColor: workspace.color }} />
                <button
                  type="button"
                  className={styles.nameButton}
                  data-focus={`row:${workspace.id}`}
                  onClick={() => {
                    openEdit(workspace);
                  }}
                >
                  <span className={styles.nameText}>
                    <EmojiText text={workspace.name} />
                  </span>
                </button>
                <button
                  type="button"
                  className={styles.moveButton}
                  data-move={`${workspace.id}:up`}
                  aria-label={`${workspace.name}を上へ`}
                  disabled={index === 0}
                  onClick={() => {
                    move(workspace.id, 'up');
                  }}
                >
                  <ArrowIcon direction="up" />
                </button>
                <button
                  type="button"
                  className={styles.moveButton}
                  data-move={`${workspace.id}:down`}
                  aria-label={`${workspace.name}を下へ`}
                  disabled={index === users.length - 1}
                  onClick={() => {
                    move(workspace.id, 'down');
                  }}
                >
                  <ArrowIcon direction="down" />
                </button>
              </li>
            ))}
          </ul>
          <button type="button" className={styles.addButton} data-focus="add" onClick={openAdd}>
            ＋ ワークスペースを追加
          </button>
        </div>
      )}

      {step.kind === 'edit' && (
        <EditStep
          idPrefix={ids}
          edit={step.edit}
          isLast={
            step.edit.original !== null &&
            isLastWorkspace(workspaces.values(), step.edit.original.id)
          }
          onChange={(draft) => {
            setStep({ kind: 'edit', edit: { ...step.edit, draft } });
          }}
          onSave={() => {
            save(step.edit);
          }}
          onDelete={() => {
            goTo({ kind: 'confirm', edit: step.edit }, 'confirm');
          }}
          onBack={() => {
            goTo(
              { kind: 'list' },
              step.edit.original === null ? 'add' : `row:${step.edit.original.id}`,
            );
          }}
        />
      )}

      {step.kind === 'confirm' && step.edit.original !== null && (
        <ConfirmStep
          workspace={step.edit.original}
          onDelete={() => {
            confirmDelete(step.edit);
          }}
          onBack={() => {
            goTo({ kind: 'edit', edit: step.edit }, 'delete');
          }}
        />
      )}

      {/* ダイアログの外の、画面の下の列（BottomNotices）は、モーダルの間、押せない。削除したあとの「元に戻す」を押せるよう、
          同じ知らせを、ダイアログの中にも出す。 */}
      <div className={styles.notices}>
        <UndoNotices />
      </div>
    </dialog>
  );
}

function EditStep({
  idPrefix,
  edit,
  isLast,
  onChange,
  onSave,
  onDelete,
  onBack,
}: {
  idPrefix: string;
  edit: EditState;
  /** 最後の 1 つ（削除できない）。 */
  isLast: boolean;
  onChange: (draft: WorkspaceInput) => void;
  onSave: () => void;
  onDelete: () => void;
  onBack: () => void;
}) {
  const { draft, original, attempted } = edit;
  const nameError = attempted ? validateWorkspaceName(draft.name) : null;
  // 色の見本の「今の色」は、開いたときの色（選び直したあとも、その色に戻せるように）。新しく作るときは、初期値。
  // 段を開いたときに 1 回だけ決める。選び直すたびに、見本が増えたり、入れ替わったりしないため。
  const [swatches] = useState(() => colorSwatches(original?.color ?? draft.color));

  function handleSubmit(event: SubmitEvent<HTMLFormElement>): void {
    event.preventDefault();
    onSave();
  }

  return (
    <form className={styles.body} noValidate onSubmit={handleSubmit}>
      <div className={styles.field}>
        <label className={styles.label} htmlFor={`${idPrefix}-name`}>
          名前
        </label>
        <input
          id={`${idPrefix}-name`}
          className={formStyles.input}
          name="name"
          type="text"
          maxLength={INPUT_LIMITS.workspaceName}
          autoComplete="off"
          data-focus="name"
          value={draft.name}
          onChange={(event) => {
            onChange({ ...draft, name: event.target.value });
          }}
          aria-invalid={nameError !== null}
          aria-describedby={nameError === null ? undefined : `${idPrefix}-name-error`}
        />
        {nameError !== null && (
          <p id={`${idPrefix}-name-error`} className={formStyles.error} role="alert">
            {nameError}
          </p>
        )}
      </div>

      <fieldset className={styles.field}>
        <legend className={styles.label}>色</legend>
        <div className={styles.swatches}>
          {swatches.map(({ name, value }) => (
            <label key={value} className={styles.swatch} title={name}>
              <input
                type="radio"
                name="color"
                value={value}
                checked={isSameColor(draft.color, value)}
                onChange={() => {
                  onChange({ ...draft, color: value });
                }}
              />
              <span className={styles.swatchDot} style={{ backgroundColor: value }} />
              <span className={formStyles.visuallyHidden}>{name}</span>
            </label>
          ))}
        </div>
      </fieldset>

      {isLast && (
        <p className={styles.hint}>
          最後の 1 つは削除できません（予定は、ワークスペースに必ず属するため）
        </p>
      )}

      <div className={styles.buttons}>
        {original !== null && (
          <button
            type="button"
            className={formStyles.deleteButton}
            data-focus="delete"
            disabled={isLast}
            onClick={onDelete}
          >
            削除
          </button>
        )}
        <span className={styles.spacer} />
        <button type="button" className={formStyles.backButton} onClick={onBack}>
          戻る
        </button>
        <button type="submit" className={formStyles.saveButton}>
          保存
        </button>
      </div>
    </form>
  );
}

function ConfirmStep({
  workspace,
  onDelete,
  onBack,
}: {
  workspace: Workspace;
  onDelete: () => void;
  onBack: () => void;
}) {
  const entries = useSyncState(selectEntries);
  const count = countEntriesIn(entries.values(), workspace.id);
  return (
    <div className={styles.body}>
      <p className={styles.confirmText} data-focus="confirm" tabIndex={-1}>
        「<EmojiText text={workspace.name} />
        」を削除します。
        {count > 0 && `中の予定 ${String(count)} 件も削除されます。`}
      </p>
      <div className={styles.buttons}>
        <span className={styles.spacer} />
        <button type="button" className={formStyles.backButton} onClick={onBack}>
          戻る
        </button>
        <button type="button" className={formStyles.deleteSubmit} onClick={onDelete}>
          削除
        </button>
      </div>
    </div>
  );
}
