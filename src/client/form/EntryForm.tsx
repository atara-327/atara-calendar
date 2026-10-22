import {
  useId,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type SubmitEvent,
  type ReactNode,
} from 'react';
import {
  INPUT_LIMITS,
  type Entry,
  type EntryChanges,
  type Rrule,
  type Scope,
  type Workspace,
} from '../../shared/schema';
import { MAX_YEAR, MIN_YEAR } from '../../shared/solarTerms';
import { classNames } from '../classNames';
import { getSyncEngine, useSyncState } from '../sync/instance';
import type { SyncState } from '../sync/state';
import { toChanges, toDraft } from './build';
import styles from './EntryForm.module.css';
import type { FormTarget } from './formController';
import { CloseIcon } from './icons';
import { closeEntryForm } from './instance';
import { loadLastWorkspaceId, saveLastWorkspaceId } from './lastWorkspace';
import { mapSearchUrl, openableUrl } from './links';
import { scopeChangedMessage, scopeUnavailableMessage, unavailableMessage } from './messages';
import {
  DEFAULT_ALL_DAY_NOTIFY_MIN,
  TIMED_NOTIFY_RANGE,
  describeAllDayNotify,
  parseNotifyOffset,
} from './notify';
import { RepeatControls } from './RepeatControls';
import {
  describeFirstOccurrence,
  describeSeriesAfter,
  firstOccurrence,
  repeatDescriptionDate,
  seriesRruleOf,
} from './repeat';
import { moveStart } from './schedule';
import {
  decideScope,
  recheckScope,
  seriesAfterChange,
  type ScopeAction,
  type ScopeDecision,
} from './scope';
import { ScopeStep, type ScopeStepKind } from './ScopeStep';
import { showDeletedNotice } from './UndoNotices';
import { validateForm, type FormErrors } from './validate';
import {
  createValues,
  editValues,
  setAllDay,
  setKind,
  type EntryKind,
  type FormValues,
} from './values';
import { defaultWorkspaceId, selectableWorkspaces } from './workspaceChoices';

// 予定・タイムブロックの入力フォーム（設計書 11.4。要件 EV-1〜4・8、TB-1〜6、NT-2〜4、OT-1）。
// スマホでは下から出るシート、PC では中央のダイアログ。ネイティブの <dialog>（showModal）を使う。
// Why: フォーカスの閉じ込め・Esc で閉じる・背景を操作できなくする、が、追加の部品なしで手に入る。
// 値の決め方・確認・本文の作り方・繰り返しの欄の値・変更・削除の範囲の決め方は、画面に依存しない関数
// （values.ts・validate.ts・build.ts・repeat.ts・scope.ts など）にある。

const DATE_MIN = `${String(MIN_YEAR)}-01-01`;
const DATE_MAX = `${String(MAX_YEAR)}-12-31`;

const HOURS = Array.from({ length: 24 }, (_, hour) => String(hour).padStart(2, '0'));
// 時刻の「分」は 00・15・30・45 だけ（DV-3）。ブラウザ標準の時刻入力は、iPhone で 15 分刻みが効かない（設計書 11.4）。
const MINUTES = ['00', '15', '30', '45'];

const KINDS: readonly { kind: EntryKind; label: string }[] = [
  { kind: 'event', label: '予定' },
  { kind: 'block', label: 'タイムブロック' },
];

function selectViewWorkspaces(state: SyncState): SyncState['view']['workspaces'] {
  return state.view.workspaces;
}

function initialValues(
  target: FormTarget,
  choices: readonly Workspace[],
  originalRrule: Rrule | null,
): FormValues {
  if (target.mode === 'edit') return editValues(target.occurrence, target.openedAt, originalRrule);
  return createValues({
    kind: target.kind,
    nowMs: target.openedAt,
    workspaceId: defaultWorkspaceId(choices, loadLastWorkspaceId()),
  });
}

/** 誤りのある欄のうち、画面の上にあるもの。保存を押したときに、そこへフォーカスを移す（name 属性）。 */
function firstErrorField(errors: FormErrors): string | null {
  const order: readonly (readonly [keyof FormErrors, string])[] = [
    ['title', 'title'],
    ['startDate', 'startDate'],
    ['endDate', 'endDate'],
    ['range', 'endDate'],
    ['workspace', 'workspace'],
    ['repeat', 'repeat'],
    ['notify', 'notify'],
    ['location', 'location'],
    ['url', 'url'],
    ['memo', 'memo'],
  ];
  return order.find(([key]) => errors[key] !== undefined)?.[1] ?? null;
}

interface FieldProps {
  label: string;
  /** 1 つの入力欄のラベルのとき、その id。複数の部品が並ぶ行は省く（部品に、それぞれ aria-label がある）。 */
  htmlFor?: string;
  error: string | undefined;
  errorId: string;
  children: ReactNode;
}

function Field({ label, htmlFor, error, errorId, children }: FieldProps) {
  return (
    <div className={styles.row}>
      {htmlFor === undefined ? (
        <span className={styles.label}>{label}</span>
      ) : (
        <label className={styles.label} htmlFor={htmlFor}>
          {label}
        </label>
      )}
      <div className={styles.cell}>
        <div className={styles.controls}>{children}</div>
        {error !== undefined && (
          <p id={errorId} className={styles.error} role="alert">
            {error}
          </p>
        )}
      </div>
    </div>
  );
}

function invalidProps(error: string | undefined, errorId: string) {
  return {
    'aria-invalid': error !== undefined,
    'aria-describedby': error === undefined ? undefined : errorId,
  };
}

function TimeSelect({
  label,
  value,
  onChange,
}: {
  label: string;
  value: string;
  onChange: (time: string) => void;
}) {
  const hour = value.slice(0, 2);
  const minute = value.slice(3, 5);
  return (
    <span className={styles.time}>
      <select
        className={styles.select}
        aria-label={`${label}の時`}
        value={hour}
        onChange={(event) => {
          onChange(`${event.target.value}:${minute}`);
        }}
      >
        {HOURS.map((option) => (
          <option key={option} value={option}>
            {option}
          </option>
        ))}
      </select>
      <span aria-hidden="true">:</span>
      <select
        className={styles.select}
        aria-label={`${label}の分`}
        value={minute}
        onChange={(event) => {
          onChange(`${hour}:${event.target.value}`);
        }}
      >
        {MINUTES.map((option) => (
          <option key={option} value={option}>
            {option}
          </option>
        ))}
      </select>
    </span>
  );
}

/**
 * 通知のタイミング。時間指定は、「何分前」を、利用者が入力する（0 は開始時刻）。
 * 終日は、当日の朝 6 時に固定で、入力欄を出さず、時刻を表示するだけ（要件 NT-3）。API から入れた、別の値の終日の予定も、
 * その時刻を表示する（書き換えない）。
 * 通知が OFF のときも、タイミングは見せて、編集もできる（薄く出す）。隠すと、入力欄の誤りが見えないまま、保存を止める。
 */
function NotifyTiming({
  allDay,
  enabled,
  offsetText,
  error,
  errorId,
  onChange,
}: {
  allDay: boolean;
  enabled: boolean;
  offsetText: string;
  error: string | undefined;
  errorId: string;
  onChange: (offsetText: string) => void;
}) {
  const offset = parseNotifyOffset(offsetText);
  if (allDay) {
    return (
      <span className={classNames(styles.timing, !enabled && styles.dimmed)}>
        {describeAllDayNotify(offset ?? DEFAULT_ALL_DAY_NOTIFY_MIN)}
      </span>
    );
  }
  return (
    <span className={classNames(styles.timing, !enabled && styles.dimmed)}>
      <input
        className={classNames(styles.input, styles.minutes)}
        name="notify"
        type="number"
        inputMode="numeric"
        min={TIMED_NOTIFY_RANGE.min}
        max={TIMED_NOTIFY_RANGE.max}
        step={1}
        aria-label="通知のタイミング（開始の何分前か）"
        value={offsetText}
        onChange={(event) => {
          onChange(event.target.value);
        }}
        {...invalidProps(error, errorId)}
      />
      <span>分前</span>
      {offset === 0 && <span>（開始時刻）</span>}
    </span>
  );
}

export function EntryForm({ target }: { target: FormTarget }) {
  const dialogRef = useRef<HTMLDialogElement>(null);
  const ids = useId();
  const workspaces = useSyncState(selectViewWorkspaces);
  const choices = useMemo(() => selectableWorkspaces(workspaces.values()), [workspaces]);

  // 開いた回の、系列のルール。開いたときの値で固定する（開いた回 target.occurrence と同じ。changes に入れるかの比べる先）。
  const [originalRrule] = useState(() =>
    target.mode === 'edit'
      ? seriesRruleOf(getSyncEngine().store.getState().view.entries, target.occurrence.seriesId)
      : null,
  );
  const [values, setValues] = useState(() => initialValues(target, choices, originalRrule));
  // 保存を押したあとに、確認の誤りを、すべて出す。押す前は、開始・終了と、通知の分の誤り（入力の途中で、すぐ分かる）だけ出す。
  const [attempted, setAttempted] = useState(false);
  const [failure, setFailure] = useState<string | null>(null);
  // 範囲を聞く段（設計書 11.4）。null のときは、入力の段。変更の中身（changes）は、範囲を決めた時点のものを持つ
  // （範囲は、この changes に当てて決めたので、送るのも、同じものにする）。
  const [scopeStep, setScopeStep] = useState<{
    kind: ScopeStepKind;
    scopes: readonly Scope[];
    selected: Scope;
    changes: EntryChanges | null;
    /** 範囲ごとの、保存したあとの系列の説明（ルールか開始日を変えたときだけ。なければ、その範囲のキーがない）。 */
    outcomes: Partial<Record<Scope, string>>;
  } | null>(null);
  // 範囲を聞く段から戻ったとき、フォーカスを返す先（段を押したボタン）。
  const returnFocus = useRef<ScopeStepKind | null>(null);

  const original = target.mode === 'edit' ? target.occurrence : undefined;
  const errors = useMemo(() => validateForm(values, original), [values, original]);
  const shown: FormErrors = attempted
    ? errors
    : {
        startDate: errors.startDate,
        endDate: errors.endDate,
        range: errors.range,
        // 毎週の曜日を外したときと、開始日から最初の回を求められないとき。入力の途中で、すぐ分かる。
        repeat: errors.repeat,
        notify: errors.notify,
      };

  const formError = failure ?? shown.form ?? null;

  // 保存したとき、開始日がルールに合う最初の日へずれることを、保存の前に知らせる（設計書 4.4）。すでに繰り返している
  // 予定のルールを変えるときは、出さない。範囲によって、ずれる先の日が違い（「すべて」は、系列の最初の回から数える）、
  // 開いた回の開始日から求めた日を出すと、間違った日を言うことがあるため。
  const firstNote =
    original?.recurring === true
      ? null
      : describeFirstOccurrence(firstOccurrence(values), values.startDate);

  const isEvent = values.kind === 'event';

  // 開いたとき showModal し、閉じるとき close する。useEffect ではなく useLayoutEffect にするのは、
  // 後片付けを、dialog が DOM から外れる前に行うため。close() は、開く前にフォーカスのあった要素
  // （( + ) ボタンや、押した予定）へ、フォーカスを戻す。外れたあとでは戻らない。
  useLayoutEffect(() => {
    const dialog = dialogRef.current;
    if (dialog === null) return;
    dialog.showModal();
    if (target.mode === 'create') dialog.querySelector<HTMLElement>('input[name="title"]')?.focus();
    return () => {
      dialog.close();
    };
  }, [target.mode]);

  // 範囲を聞く段に入ったら、選んでいる範囲にフォーカスを置く。戻ったら、段を出したボタンに戻す。
  // 段の中身は、入力の段と差し替わるので、押したボタンが DOM から外れ、フォーカスが失われるため。
  const inScopeStep = scopeStep !== null;
  useLayoutEffect(() => {
    const dialog = dialogRef.current;
    if (dialog === null) return;
    if (inScopeStep) {
      dialog.querySelector<HTMLElement>('input[name="scope"]:checked')?.focus();
    } else if (returnFocus.current !== null) {
      dialog.querySelector<HTMLElement>(`button[name="${returnFocus.current}"]`)?.focus();
      returnFocus.current = null;
    }
  }, [inScopeStep]);

  const update = (patch: Partial<FormValues>) => {
    setValues((current) => ({ ...current, ...patch }));
  };

  /**
   * エンジンに渡す処理を実行する。受け付けられなかったとき（null）は、理由を出して null を返す。
   * 確認（validateForm）を通った入力で、エンジンが例外を投げるのは、確認とサーバーの決まりの食い違い。
   * 黙って閉じず、入力を残して知らせる。
   */
  function submit<T>(action: '保存' | '削除', run: () => T | null): T | null {
    try {
      const accepted = run();
      if (accepted !== null) return accepted;
      setFailure(unavailableMessage(getSyncEngine().store.getState().phase, action));
    } catch (error) {
      console.error(`予定を${action}できませんでした`, error);
      setFailure(`${action}できませんでした。入力内容を確かめてください`);
    }
    return null;
  }

  function createEntry(): void {
    const draft = toDraft(values);
    if (submit('保存', () => getSyncEngine().createEntry(draft)) === null) return;
    // 覚えるのは、新しく作った予定のワークスペースだけ（EV-8）。編集で別のワークスペースへ移しただけで、
    // 次の初期値が変わると、紛らわしい。タイムブロックはワークスペースを持たない。
    if (draft.kind === 'event' && draft.workspaceId !== null) {
      saveLastWorkspaceId(draft.workspaceId);
    }
    closeEntryForm();
  }

  /**
   * 想定外の例外（確認とサーバーの決まりの食い違い・shared の関数の例外など）を、ログに残して、入力を残したまま知らせる。
   * 握りつぶして閉じると、保存したつもりで、保存されない。
   */
  function guard(action: '保存' | '削除', run: () => void): void {
    try {
      run();
    } catch (error) {
      console.error(`予定を${action}できませんでした`, error);
      setFailure(`${action}できませんでした。入力内容を確かめてください`);
    }
  }

  /** 範囲を決められなかったとき（もうない・どの範囲も選べない）の理由を出す。 */
  function reject(decision: Extract<ScopeDecision, { kind: 'gone' | 'unavailable' }>): void {
    setFailure(scopeUnavailableMessage(decision));
  }

  /** 同期のエンジンの view の今の行（削除済みを含む全行）。範囲を決めるのに使う（scope.ts）。 */
  function viewRows(): Iterable<Entry> {
    return getSyncEngine().store.getState().view.entries.values();
  }

  /**
   * 範囲ごとの、保存したあとの系列の説明。ルールか開始日を変えていないとき（題名だけなど）は、保存したあとの系列が
   * 変わらないので、出さない（範囲の名前の下の 1 行だけ）。
   * 範囲によって、基準の日が違い（「すべて」は系列の開始日、「これ以降すべて」は開いた回の日付に、日付の変更を足した日）、
   * 入力の段では、毎月 N 日などが決まらない。shared の関数を当てた結果から作る（画面にずらしの決まりを書き写さない）。
   */
  function outcomesOf(
    scopes: readonly Scope[],
    changes: EntryChanges,
  ): Partial<Record<Scope, string>> {
    if (target.mode !== 'edit') return {};
    if (changes.rrule === undefined && changes.startDate === undefined) return {};
    const outcomes: Partial<Record<Scope, string>> = {};
    for (const scope of scopes) {
      const after = seriesAfterChange({
        rows: viewRows(),
        occurrence: target.occurrence,
        changes,
        scope,
      });
      if (after !== null) outcomes[scope] = describeSeriesAfter(after, values.startDate);
    }
    return outcomes;
  }

  function changeEntry(scope: Scope, changes: EntryChanges): void {
    if (target.mode !== 'edit') return;
    const { seriesId, occurrenceDate } = target.occurrence;
    const accepted = submit('保存', () =>
      getSyncEngine().changeEntry({ seriesId, occurrenceDate, scope }, changes),
    );
    if (accepted !== null) closeEntryForm();
  }

  function saveEdit(): void {
    if (target.mode !== 'edit') return;
    const { occurrence } = target;
    guard('保存', () => {
      const changes = toChanges(values, occurrence, originalRrule);
      // 何も変えていないなら、何も送らない（範囲も聞かない）。送ると、行の編集時刻と rev だけが進み、他の端末が受け取り直す。
      if (Object.keys(changes).length === 0) {
        closeEntryForm();
        return;
      }
      // 選べる範囲は、変えた内容を、手元の行に当てて決める（設計書 11.4。scope.ts）。
      const decision = decideScope({
        rows: viewRows(),
        occurrence,
        action: { kind: 'change', changes },
      });
      switch (decision.kind) {
        case 'single':
          // 繰り返さない予定は、範囲を使わない（設計書 5.1）。型に合わせて、予定全体を表す 'all' にする。
          changeEntry('all', changes);
          return;
        case 'choose':
          // 選べる範囲が 1 つだけでも、聞く（何が起きるかを、利用者が確かめられるように）。
          setScopeStep({
            kind: 'save',
            scopes: decision.scopes,
            selected: decision.scopes[0],
            changes,
            outcomes: outcomesOf(decision.scopes, changes),
          });
          return;
        default:
          reject(decision);
      }
    });
  }

  function save(): void {
    if (target.mode === 'create') createEntry();
    else saveEdit();
  }

  function deleteEntry(scope: Scope): void {
    if (target.mode !== 'edit') return;
    const { seriesId, occurrenceDate } = target.occurrence;
    const accepted = submit('削除', () =>
      getSyncEngine().deleteEntry({ seriesId, occurrenceDate, scope }),
    );
    if (accepted === null) return;
    // 確認は出さず、削除したあとに、5 秒の間、元に戻せるようにする（設計書 11.4・6.6）。
    showDeletedNotice(accepted.requestId);
    closeEntryForm();
  }

  function remove(): void {
    if (target.mode !== 'edit') return;
    const { occurrence } = target;
    setFailure(null);
    guard('削除', () => {
      const decision = decideScope({ rows: viewRows(), occurrence, action: { kind: 'delete' } });
      switch (decision.kind) {
        case 'single':
          deleteEntry('all');
          return;
        case 'choose':
          setScopeStep({
            kind: 'delete',
            scopes: decision.scopes,
            selected: decision.scopes[0],
            changes: null,
            outcomes: {},
          });
          return;
        default:
          reject(decision);
      }
    });
  }

  /**
   * 範囲を決めたあとの、保存・削除。送る前に、同じ変更・削除に、もう一度、選べる範囲を決める（scope.ts の recheckScope）。
   * 範囲を聞く段を開いている間に、ほかの端末の変更が届いて、選んだ範囲が、もう選べない（または、対象がもうない）ことが
   * あるため。そのまま送ると、サーバーが 200 で「捨てた」にするか、400 にする（400 なら、保存した変更が画面から消える。
   * 設計書 6.2）。選べなくなっていたら、理由を出して、入力の段に戻る。
   */
  function applyScope(): void {
    if (scopeStep === null || target.mode !== 'edit') return;
    const step = scopeStep;
    const { occurrence } = target;
    const verb = step.kind === 'delete' ? '削除' : '保存';
    setFailure(null);
    guard(verb, () => {
      const action: ScopeAction | null =
        step.kind === 'delete'
          ? { kind: 'delete' }
          : step.changes === null
            ? null
            : { kind: 'change', changes: step.changes };
      if (action === null) return;
      const recheck = recheckScope({
        rows: viewRows(),
        occurrence,
        action,
        selected: step.selected,
      });
      if (recheck.kind !== 'proceed') {
        returnFocus.current = step.kind;
        setScopeStep(null);
        if (recheck.kind === 'rejected') reject(recheck.decision);
        else setFailure(scopeChangedMessage(verb));
        return;
      }
      if (action.kind === 'delete') deleteEntry(step.selected);
      else changeEntry(step.selected, action.changes);
    });
  }

  function backToForm(): void {
    if (scopeStep === null) return;
    returnFocus.current = scopeStep.kind;
    setFailure(null);
    setScopeStep(null);
  }

  function handleSubmit(event: SubmitEvent<HTMLFormElement>): void {
    event.preventDefault();
    if (scopeStep !== null) {
      applyScope();
      return;
    }
    setAttempted(true);
    setFailure(null);
    if (Object.keys(errors).length > 0) {
      const name = firstErrorField(errors);
      const element = name === null ? null : event.currentTarget.elements.namedItem(name);
      if (element instanceof HTMLElement) element.focus();
      return;
    }
    save();
  }

  const mapHref = values.location.trim() === '' ? null : mapSearchUrl(values.location);
  const urlHref = openableUrl(values.url);
  const workspaceKnown = choices.some(({ id }) => id === values.workspaceId);
  const selectedColor = choices.find(({ id }) => id === values.workspaceId)?.color;
  const name = values.kind === 'event' ? '予定' : 'タイムブロック';

  return (
    <dialog
      ref={dialogRef}
      className={styles.dialog}
      aria-label={`${name}を${target.mode === 'create' ? '作成' : '編集'}`}
      // Esc。ブラウザの既定で閉じさせず、✕ と同じ閉じ方にする（履歴を戻すため）。
      onCancel={(event) => {
        event.preventDefault();
        closeEntryForm();
      }}
      // Esc を続けて押すと、ブラウザが、cancel を止められずに閉じることがある。そのときも、状態を閉じる。
      // 開いているとき（open）は無視する。自分で close() したあとに届く close を、取り違えないため。開発時の
      // StrictMode は、開いて・閉じて・開き直す（useLayoutEffect）ので、開き直した後に、最初の close が届く。
      // 後片付けのあと（dialogRef が外れた後）に届く close も、無視する。
      onClose={(event) => {
        if (event.currentTarget === dialogRef.current && !event.currentTarget.open) {
          closeEntryForm();
        }
      }}
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
          {scopeStep === null && (
            <button type="submit" name="save" className={styles.saveButton}>
              保存
            </button>
          )}
        </header>

        {scopeStep !== null ? (
          <ScopeStep
            action={scopeStep.kind}
            scopes={scopeStep.scopes}
            selected={scopeStep.selected}
            outcomes={scopeStep.outcomes}
            error={failure}
            onSelect={(selected) => {
              setScopeStep({ ...scopeStep, selected });
            }}
            onBack={backToForm}
          />
        ) : (
          <div className={styles.body}>
            {formError !== null && (
              <p className={classNames(styles.error, styles.wide)} role="alert">
                {formError}
              </p>
            )}

            {target.mode === 'create' && (
              <fieldset className={classNames(styles.segment, styles.wide)}>
                <legend className={styles.visuallyHidden}>種類</legend>
                {KINDS.map(({ kind, label }) => (
                  <label key={kind} className={styles.segmentOption}>
                    <input
                      type="radio"
                      name="kind"
                      value={kind}
                      checked={values.kind === kind}
                      onChange={() => {
                        setValues((current) => setKind(current, kind));
                      }}
                    />
                    <span>{label}</span>
                  </label>
                ))}
              </fieldset>
            )}

            <Field
              label="タイトル"
              htmlFor={`${ids}-title`}
              error={shown.title}
              errorId={`${ids}-title-error`}
            >
              <input
                id={`${ids}-title`}
                className={classNames(styles.input, styles.grow)}
                name="title"
                type="text"
                maxLength={INPUT_LIMITS.title}
                autoComplete="off"
                value={values.title}
                onChange={(event) => {
                  update({ title: event.target.value });
                }}
                {...invalidProps(shown.title, `${ids}-title-error`)}
              />
            </Field>

            {isEvent && (
              <div className={styles.row}>
                <span className={styles.label} />
                <label className={styles.check}>
                  <input
                    type="checkbox"
                    name="allDay"
                    checked={values.allDay}
                    onChange={(event) => {
                      setValues((current) => setAllDay(current, event.target.checked));
                    }}
                  />
                  終日
                </label>
              </div>
            )}

            <Field label="開始" error={shown.startDate} errorId={`${ids}-start-error`}>
              <input
                className={classNames(styles.input, styles.date)}
                name="startDate"
                type="date"
                min={DATE_MIN}
                max={DATE_MAX}
                aria-label="開始の日付"
                value={values.startDate}
                onChange={(event) => {
                  setValues((current) => moveStart(current, { startDate: event.target.value }));
                }}
                {...invalidProps(shown.startDate, `${ids}-start-error`)}
              />
              {!values.allDay && (
                <TimeSelect
                  label="開始"
                  value={values.startTime}
                  onChange={(startTime) => {
                    setValues((current) => moveStart(current, { startTime }));
                  }}
                />
              )}
            </Field>

            <Field label="終了" error={shown.endDate ?? shown.range} errorId={`${ids}-end-error`}>
              <input
                className={classNames(styles.input, styles.date)}
                name="endDate"
                type="date"
                min={DATE_MIN}
                max={DATE_MAX}
                aria-label="終了の日付"
                value={values.endDate}
                onChange={(event) => {
                  update({ endDate: event.target.value });
                }}
                {...invalidProps(shown.endDate ?? shown.range, `${ids}-end-error`)}
              />
              {!values.allDay && (
                <TimeSelect
                  label="終了"
                  value={values.endTime}
                  onChange={(endTime) => {
                    update({ endTime });
                  }}
                />
              )}
            </Field>

            {isEvent && (
              <Field
                label="ワークスペース"
                htmlFor={`${ids}-workspace`}
                error={shown.workspace}
                errorId={`${ids}-workspace-error`}
              >
                {selectedColor !== undefined && (
                  <span className={styles.dot} style={{ backgroundColor: selectedColor }} />
                )}
                <select
                  id={`${ids}-workspace`}
                  className={classNames(styles.select, styles.grow)}
                  name="workspace"
                  value={values.workspaceId ?? ''}
                  onChange={(event) => {
                    update({ workspaceId: event.target.value });
                  }}
                  {...invalidProps(shown.workspace, `${ids}-workspace-error`)}
                >
                  {values.workspaceId === null && (
                    <option value="">（選べるワークスペースがありません）</option>
                  )}
                  {values.workspaceId !== null && !workspaceKnown && (
                    <option value={values.workspaceId}>（選べないワークスペース）</option>
                  )}
                  {choices.map((workspace) => (
                    <option key={workspace.id} value={workspace.id}>
                      {workspace.name}
                    </option>
                  ))}
                </select>
              </Field>
            )}

            <Field
              label="繰り返し"
              htmlFor={`${ids}-repeat`}
              error={shown.repeat}
              errorId={`${ids}-repeat-error`}
            >
              <RepeatControls
                id={`${ids}-repeat`}
                values={values}
                baseDate={repeatDescriptionDate(
                  values,
                  original && { ...original, rrule: originalRrule },
                )}
                firstNote={firstNote}
                describedBy={shown.repeat === undefined ? undefined : `${ids}-repeat-error`}
                invalid={shown.repeat !== undefined}
                onChange={(patch) => {
                  update(patch);
                }}
              />
            </Field>

            <Field label="通知" error={shown.notify} errorId={`${ids}-notify-error`}>
              <label className={styles.check}>
                <input
                  type="checkbox"
                  name="notifyEnabled"
                  checked={values.notifyEnabled}
                  onChange={(event) => {
                    update({ notifyEnabled: event.target.checked });
                  }}
                />
                通知する
              </label>
              <NotifyTiming
                allDay={values.allDay}
                enabled={values.notifyEnabled}
                offsetText={values.notifyOffsetText}
                error={shown.notify}
                errorId={`${ids}-notify-error`}
                onChange={(notifyOffsetText) => {
                  update({ notifyOffsetText });
                }}
              />
            </Field>

            <Field
              label="場所"
              htmlFor={`${ids}-location`}
              error={shown.location}
              errorId={`${ids}-location-error`}
            >
              <input
                id={`${ids}-location`}
                className={classNames(styles.input, styles.grow)}
                name="location"
                type="text"
                maxLength={INPUT_LIMITS.location}
                autoComplete="off"
                value={values.location}
                onChange={(event) => {
                  update({ location: event.target.value });
                }}
                {...invalidProps(shown.location, `${ids}-location-error`)}
              />
              {mapHref !== null && (
                <a className={styles.link} href={mapHref} target="_blank" rel="noopener noreferrer">
                  地図で開く
                </a>
              )}
            </Field>

            <Field
              label="URL"
              htmlFor={`${ids}-url`}
              error={shown.url}
              errorId={`${ids}-url-error`}
            >
              <input
                id={`${ids}-url`}
                className={classNames(styles.input, styles.grow)}
                name="url"
                // type="url" にしない。ブラウザが、前後の空白を黙って取り除き、入力した値と保存する値が食い違うため。
                type="text"
                inputMode="url"
                autoCapitalize="none"
                autoComplete="off"
                spellCheck={false}
                maxLength={INPUT_LIMITS.url}
                value={values.url}
                onChange={(event) => {
                  update({ url: event.target.value });
                }}
                {...invalidProps(shown.url, `${ids}-url-error`)}
              />
              {urlHref !== null && (
                <a className={styles.link} href={urlHref} target="_blank" rel="noopener noreferrer">
                  開く
                </a>
              )}
            </Field>

            <Field
              label="メモ"
              htmlFor={`${ids}-memo`}
              error={shown.memo}
              errorId={`${ids}-memo-error`}
            >
              <textarea
                id={`${ids}-memo`}
                className={classNames(styles.input, styles.grow, styles.memo)}
                name="memo"
                rows={4}
                maxLength={INPUT_LIMITS.memo}
                value={values.memo}
                onChange={(event) => {
                  update({ memo: event.target.value });
                }}
                {...invalidProps(shown.memo, `${ids}-memo-error`)}
              />
            </Field>

            {target.mode === 'edit' && (
              <div className={classNames(styles.footer, styles.wide)}>
                <button
                  type="button"
                  name="delete"
                  className={styles.deleteButton}
                  onClick={remove}
                >
                  削除
                </button>
              </div>
            )}
          </div>
        )}
      </form>
    </dialog>
  );
}
