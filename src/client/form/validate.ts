import { entryProblem } from '../../shared/entryRules';
import type { Occurrence } from '../../shared/recurrence';
import { INPUT_LIMITS, entryDraftInputSchema } from '../../shared/schema';
import { toDraft } from './build';
import { TIMED_NOTIFY_RANGE, parseNotifyOffset } from './notify';
import { firstOccurrence, hasNoWeeklyDays } from './repeat';
import { DATE_RANGE_HINT, validateSchedule, type ScheduleErrors } from './schedule';
import type { FormValues } from './values';

// 保存の前の確認（設計書 11.4）。エンジンは、サーバーの入力の検証を通らない本文で、例外を投げる
// （engine.ts）ので、フォームが先に確かめる。確かめる決まりは、サーバーと同じもの
// （shared の entryDraftInputSchema と、項目をまたぐ確認 entryProblem）。ここで書くのは、
// 誤りを、どの欄の近くに、どう（日本語で）出すかだけ。zod の文言（英語）は、画面に出さない。

export interface FormErrors extends ScheduleErrors {
  title?: string;
  workspace?: string;
  /** 繰り返し（毎週の曜日・開始日からルールに合う最初の回を求められない）。 */
  repeat?: string;
  /** 通知のタイミング（時間指定の「何分前」の入力欄）。 */
  notify?: string;
  location?: string;
  url?: string;
  memo?: string;
  /** 欄に結びつかない、入力全体の誤り。 */
  form?: string;
}

/** 通知の分を、開いたときから変えていないか（分の数と、終日かどうかが、どちらも同じ）。 */
function isUnchanged(
  values: Pick<FormValues, 'allDay'>,
  offset: number,
  original: Pick<Occurrence, 'notifyOffsetMin' | 'allDay'> | undefined,
): boolean {
  return (
    original !== undefined &&
    values.allDay === original.allDay &&
    offset === original.notifyOffsetMin
  );
}

export const NO_WEEKLY_DAYS_MESSAGE = '繰り返す曜日を 1 つ以上選んでください';

const FIRST_OCCURRENCE_OUT_OF_RANGE_MESSAGE = `この開始日からは、繰り返しを設定できません（最初の回が、${DATE_RANGE_HINT}の外になります）`;

function tooLong(name: string, limit: number): string {
  return `${name}は ${limit.toLocaleString('ja-JP')} 文字までにしてください`;
}

/**
 * 誤りがなければ、空のオブジェクト。
 * original は、編集で開いた回。時間指定の通知の分は、開いたときから変えていなければ、範囲の確認を通す
 * （API から入った、開始より後の通知（負の値）を、題名だけ直したいときに、直させないため。変えていない項目は、
 * 送らない（build.ts の toChanges）ので、サーバーにも届かない）。変えたときは、0〜10080。
 * 「変えていない」は、分の数と、終日かどうかの両方が同じこと。終日と時間指定では、同じ数でも意味が違う
 * （設計書 4.3。終日の -360 は「当日の朝 6 時」、時間指定の -360 は「開始の 6 時間後」）ので、終日を切り替えたなら、
 * 元の終日の分と同じ数を打っても、範囲の確認を通さない。
 * 繰り返さない予定を、繰り返す予定にする（または新しく繰り返す予定を作る）ときは、開始日がルールに合う最初の日へ
 * ずれた後の日付が、対応する年の範囲に入っていることも確かめる（サーバーが、ずらした後の行を 400 にするため）。
 * すでに繰り返している予定（original.recurring）の範囲ごとの確認は、範囲を選ぶ前に、shared の関数を当てて行う。
 */
export function validateForm(
  values: FormValues,
  original?: Pick<Occurrence, 'notifyOffsetMin' | 'allDay' | 'recurring'>,
): FormErrors {
  const errors: FormErrors = validateSchedule(values);
  // 空白だけのタイトルは、サーバーは通すが、月表示で何も書いていない予定になるので、空と同じにする。
  if (values.title.trim() === '') errors.title = 'タイトルを入力してください';
  if (values.kind === 'event' && values.workspaceId === null) {
    errors.workspace = 'ワークスペースを選んでください';
  }

  // 終日の通知の時刻は固定（入力欄がない）ので、時間指定だけ確かめる。API から入れた、別の値の終日の予定は、
  // そのまま保存できる（値の範囲は、下のサーバーと同じスキーマが確かめる）。
  if (!values.allDay) {
    const offset = parseNotifyOffset(values.notifyOffsetText);
    if (offset === null) {
      errors.notify = '通知のタイミングは、整数（分）で入力してください';
    } else if (
      !isUnchanged(values, offset, original) &&
      (offset < TIMED_NOTIFY_RANGE.min || offset > TIMED_NOTIFY_RANGE.max)
    ) {
      errors.notify = `通知のタイミングは、${String(TIMED_NOTIFY_RANGE.min)}〜${TIMED_NOTIFY_RANGE.max.toLocaleString('ja-JP')} 分の間で入力してください`;
    }
  }

  if (hasNoWeeklyDays(values)) errors.repeat = NO_WEEKLY_DAYS_MESSAGE;

  const draft = toDraft(values);
  const parsed = entryDraftInputSchema.safeParse(draft);
  if (!parsed.success) {
    for (const issue of parsed.error.issues) {
      switch (issue.path[0]) {
        case 'title':
          errors.title ??=
            issue.code === 'too_big'
              ? tooLong('タイトル', INPUT_LIMITS.title)
              : 'タイトルを入力してください';
          break;
        case 'location':
          errors.location ??= tooLong('場所', INPUT_LIMITS.location);
          break;
        case 'memo':
          errors.memo ??= tooLong('メモ', INPUT_LIMITS.memo);
          break;
        case 'url':
          errors.url ??= `URL は、http:// か https:// で始まる、正しい形で入力してください（${String(INPUT_LIMITS.url)} 文字まで）`;
          break;
        case 'startDate':
        case 'endDate':
          // validateSchedule が、日本語で、同じ欄に付けている。
          break;
        case 'rrule':
          // 毎週の曜日がない誤りは、上で、同じ欄に付けている。開始日が正しくないとき（日付を打っている途中）は、
          // 曜日が決まらないが、その誤りは開始日の欄に出ているので、重ねて出さない。
          if (errors.repeat === undefined && errors.startDate === undefined) {
            errors.repeat = '繰り返しの設定を確かめてください';
          }
          break;
        case 'notifyOffsetMin':
          // 時間指定は、上で、同じ欄に付けている。終日は、固定の値で、入力欄がないので、欄に結びつかない。
          if (values.allDay) errors.form ??= '入力内容を確かめてください';
          break;
        default:
          errors.form ??= '入力内容を確かめてください';
      }
    }
  }

  // 開始日がずれた後の最初の回が、対応する年の範囲を出るとき（例: 2199-12-31 の「平日」は、2200 年の 1 月にずれる）。
  // サーバーは、ずらした後の行を確かめて 400 にし、保存した変更が画面から消える（設計書 4.2・6.2）。
  if (
    draft.rrule !== null &&
    original?.recurring !== true &&
    errors.startDate === undefined &&
    errors.endDate === undefined
  ) {
    const first = firstOccurrence(values);
    if (
      first.kind === 'unsupported' ||
      (first.kind === 'found' &&
        entryProblem({
          ...draft,
          startDate: first.startDate,
          endDate: first.endDate,
          untilDate: null,
        }) !== null)
    ) {
      errors.repeat ??= FIRST_OCCURRENCE_OUT_OF_RANGE_MESSAGE;
    }
  }

  // どの欄にも誤りが見つからなかったのに、サーバーの決まりに合わないとき（上の確認の漏れ）は、
  // 保存を止めて、理由を出す。通すと、サーバーが 400 で断り、保存した変更が画面から消える（設計書 6.2）。
  if (Object.keys(errors).length === 0) {
    const problem = entryProblem({ ...draft, untilDate: null });
    if (problem !== null) errors.form = `入力内容に問題があります（${problem}）`;
  }
  return errors;
}
