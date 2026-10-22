import type { Scope } from '../../shared/schema';
import styles from './EntryForm.module.css';

// 変更・削除の範囲を聞く段（設計書 11.4。要件 RP-4）。フォームのダイアログの中身を差し替えて出す。
// Why not 別のダイアログを重ねる: ダイアログを入れ子にすると、フォームの履歴（スマホの「戻る」で閉じる仕組み。
// formController.ts）や、Esc・戻るの扱いが増えるため。選べる範囲は、scope.ts が決めた、出すものだけを渡す。

/** 何をする範囲を聞くか。保存（変更）か、削除か。 */
export type ScopeStepKind = 'save' | 'delete';

const OPTIONS: Record<Scope, { label: string; save: string; delete: string }> = {
  this: {
    label: 'この予定のみ',
    save: 'この回だけを変更します',
    delete: 'この回だけを削除します',
  },
  following: {
    label: 'これ以降すべて',
    save: 'この回と、これより後の回を、すべて変更します',
    delete: 'この回と、これより後の回を、すべて削除します',
  },
  all: {
    label: 'すべて',
    save: '前の回も含めて、この予定のすべての回を変更します',
    delete: '前の回も含めて、この予定のすべての回を削除します',
  },
};

export function ScopeStep({
  action,
  scopes,
  selected,
  outcomes,
  error,
  onSelect,
  onBack,
}: {
  action: ScopeStepKind;
  /** 選べる範囲。この順に出す。 */
  scopes: readonly Scope[];
  selected: Scope;
  /** 範囲ごとの、保存したあとの系列の説明（ルールか開始日を変えたときだけ。ない範囲は、キーがない）。 */
  outcomes: Partial<Record<Scope, string>>;
  error: string | null;
  onSelect: (scope: Scope) => void;
  onBack: () => void;
}) {
  const verb = action === 'save' ? '変更' : '削除';
  return (
    <div className={styles.scopeStep}>
      {error !== null && (
        <p className={styles.error} role="alert">
          {error}
        </p>
      )}
      <fieldset className={styles.scopeGroup}>
        <legend className={styles.scopeLegend}>{`${verb}する範囲を選んでください`}</legend>
        {scopes.map((scope) => (
          <label key={scope} className={styles.scopeOption}>
            <input
              type="radio"
              name="scope"
              value={scope}
              checked={selected === scope}
              onChange={() => {
                onSelect(scope);
              }}
            />
            <span className={styles.scopeText}>
              <span className={styles.scopeLabel}>{OPTIONS[scope].label}</span>
              <span className={styles.scopeHint}>{OPTIONS[scope][action]}</span>
              {outcomes[scope] !== undefined && (
                <span className={styles.scopeOutcome}>{`保存後: ${outcomes[scope]}`}</span>
              )}
            </span>
          </label>
        ))}
      </fieldset>
      <div className={styles.scopeButtons}>
        <button type="button" className={styles.backButton} onClick={onBack}>
          戻る
        </button>
        <button
          type="submit"
          name={action}
          className={action === 'save' ? styles.saveButton : styles.deleteSubmit}
        >
          {action === 'save' ? '保存' : '削除'}
        </button>
      </div>
    </div>
  );
}
