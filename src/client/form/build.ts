import type { Occurrence } from '../../shared/recurrence';
import type { EntryChanges, EntryDraft } from '../../shared/schema';
import { parseNotifyOffset } from './notify';
import type { FormValues } from './values';

// 入力値（FormValues）から、保存する本文を作る（設計書 4.5。画面に依存しない）。
// 入力値が確認（validate.ts）を通っていることが前提。

/** 文字の欄は、空なら null（「空にした」）で保存する。前後の空白は整えない（入力した値を、そのまま保存する）。 */
function orNull(text: string): string | null {
  return text === '' ? null : text;
}

/**
 * 文字の欄を、開いた回の値から変えたか。空文字と null は、同じ「空」とみなす。
 * API から、空文字（''）が入ることがある（場所・メモ）。null と比べると、触っていないのに、変えたことになり、
 * null を送ってしまう（空文字が、null に書き換わる）。
 */
function isTextChanged(original: string | null, text: string): boolean {
  return (original ?? '') !== text;
}

/** 新しく作るときの下書き。予定・タイムブロックのどちらも、ここで、列の組み合わせを合わせる。 */
export function toDraft(values: FormValues): EntryDraft {
  const isEvent = values.kind === 'event';
  // タイムブロックは、終日にできず、ワークスペースに属さない（設計書 4.1）。
  const allDay = isEvent && values.allDay;
  return {
    kind: values.kind,
    title: values.title,
    workspaceId: isEvent ? values.workspaceId : null,
    allDay,
    startDate: values.startDate,
    startTime: allDay ? null : values.startTime,
    endDate: values.endDate,
    endTime: allDay ? null : values.endTime,
    location: orNull(values.location),
    url: orNull(values.url),
    memo: orNull(values.memo),
    // 繰り返しの設定は、フォームにまだない（実装 #8 の後半）。
    rrule: null,
    notifyEnabled: values.notifyEnabled,
    // 整数でない文字は、確認（validate.ts）が止めている。ここで NaN にしておけば、確認を通さずに作っても、
    // サーバーの入力の検証（整数）で止まり、0 などの別の値で、黙って保存されない。
    notifyOffsetMin: parseNotifyOffset(values.notifyOffsetText) ?? Number.NaN,
  };
}

/**
 * 開いた回（original）から変えた項目だけを入れる（設計書 4.5。キーがない項目は「変えていない」、null は「空にした」）。
 * 何も変えていなければ、空のオブジェクト。
 * 終了日は、開始日を変えたときも入れる。開始日だけを渡すと、サーバーが、終了日を同じ日数だけずらして、
 * 1 回の長さを保つ（4.5）。フォームで終了を、開始から別の長さに直していたときに、その直しを失わないため。
 * 通知の分は、終日を切り替えたときも入れる（数が同じでも。意味が違うため）。
 * kind と繰り返しのルールは入れない（kind は作成後に変えられない。ルールはフォームにまだない）。
 */
export function toChanges(values: FormValues, original: Occurrence): EntryChanges {
  const draft = toDraft(values);
  const changes: EntryChanges = {};
  if (draft.title !== original.title) changes.title = draft.title;
  if (draft.workspaceId !== original.workspaceId) changes.workspaceId = draft.workspaceId;
  if (draft.allDay !== original.allDay) changes.allDay = draft.allDay;
  const startDateChanged = draft.startDate !== original.startDate;
  if (startDateChanged) changes.startDate = draft.startDate;
  if (draft.startTime !== original.startTime) changes.startTime = draft.startTime;
  if (startDateChanged || draft.endDate !== original.endDate) changes.endDate = draft.endDate;
  if (draft.endTime !== original.endTime) changes.endTime = draft.endTime;
  if (isTextChanged(original.location, values.location)) changes.location = draft.location;
  if (isTextChanged(original.url, values.url)) changes.url = draft.url;
  if (isTextChanged(original.memo, values.memo)) changes.memo = draft.memo;
  if (draft.notifyEnabled !== original.notifyEnabled) changes.notifyEnabled = draft.notifyEnabled;
  // 終日を切り替えたときは、同じ数でも入れる。終日と時間指定では、分の意味が違う（設計書 4.3）ので、
  // 数が同じでも、変えた項目として、フォームの値を、はっきり送る。
  if (draft.notifyOffsetMin !== original.notifyOffsetMin || draft.allDay !== original.allDay) {
    changes.notifyOffsetMin = draft.notifyOffsetMin;
  }
  return changes;
}
