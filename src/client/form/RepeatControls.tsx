import { classNames } from '../classNames';
import { WEEKDAY_LABELS } from '../dateFormat';
import styles from './EntryForm.module.css';
import {
  REPEAT_OPTIONS,
  describeRepeat,
  toggleRepeatDay,
  weeklyDays,
  type RepeatFields,
} from './repeat';

// 繰り返しの欄の中身（設計書 11.4。要件 RP-1・RP-3・RP-6）。選択欄と、毎週の曜日のトグル（日〜土）と、説明。
// 終わりの指定は出さない（RP-3。終わらせたいときは、「これ以降すべて」で削除する）。
// 値の決め方（曜日の初期値と並び・説明の文言・最初の回）は、画面に依存しない関数（repeat.ts）にある。

export function RepeatControls({
  id,
  values,
  baseDate,
  firstNote,
  describedBy,
  invalid,
  onChange,
}: {
  /** 選択欄の id（項目名の <label> が指す）。 */
  id: string;
  values: RepeatFields & { startDate: string };
  /** 毎月・毎年の説明の基準にする日付（repeat.ts の repeatDescriptionDate）。決められないときは null。 */
  baseDate: string | null;
  /** 「最初の回は 10月21日（水）になります」。開始日がずれないときや、求めないときは null。 */
  firstNote: string | null;
  /** 誤りの文言の id。誤りがあるときだけ渡す。 */
  describedBy: string | undefined;
  invalid: boolean;
  onChange: (patch: RepeatFields) => void;
}) {
  const days = weeklyDays(values);
  const description = describeRepeat(values.repeat, baseDate);
  const noteId = `${id}-note`;
  const hasNote = description !== null || firstNote !== null;

  return (
    <>
      <select
        id={id}
        className={classNames(styles.select, styles.grow)}
        name="repeat"
        value={values.repeat}
        onChange={(event) => {
          // 曜日は、選んだままにする。別の種類を試して、毎週に戻したとき、選んだ曜日が消えないように。
          const next = REPEAT_OPTIONS.find(({ kind }) => kind === event.target.value);
          if (next !== undefined) onChange({ repeat: next.kind, repeatDays: values.repeatDays });
        }}
        aria-invalid={invalid}
        aria-describedby={
          [describedBy, hasNote ? noteId : undefined].filter((v) => v !== undefined).join(' ') ||
          undefined
        }
      >
        {REPEAT_OPTIONS.map(({ kind, label }) => (
          <option key={kind} value={kind}>
            {label}
          </option>
        ))}
      </select>

      {values.repeat === 'weekly' && (
        <fieldset className={styles.days}>
          <legend className={styles.visuallyHidden}>繰り返す曜日</legend>
          {WEEKDAY_LABELS.map((label, day) => (
            <label key={label} className={styles.day}>
              <input
                type="checkbox"
                name={`repeatDay${String(day)}`}
                // 見える文字は 1 文字（日・月）。読み上げでは、曜日だと分かる名前にする。
                aria-label={`${label}曜日`}
                checked={days.includes(day)}
                onChange={() => {
                  onChange(toggleRepeatDay(values, day));
                }}
              />
              <span>{label}</span>
            </label>
          ))}
        </fieldset>
      )}

      {hasNote && (
        <div id={noteId} className={styles.hints}>
          {description !== null && <p className={styles.hint}>{description}</p>}
          {firstNote !== null && <p className={styles.firstNote}>{firstNote}</p>}
        </div>
      )}
    </>
  );
}
