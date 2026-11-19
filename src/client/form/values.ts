import type { Occurrence } from '../../shared/recurrence';
import { defaultNotify as sharedDefaultNotify } from '../../shared/notifyDefaults';
import { dateToDays, daysToDate } from '../../shared/date';
import { inputDateSchema, type Entry, type Rrule } from '../../shared/schema';
import { NO_REPEAT, repeatFieldsOf, type RepeatFields } from './repeat';
import {
  defaultSchedule,
  nextFullHour,
  scheduleFromStart,
  toAllDay,
  toTimed,
  type Schedule,
  type StartPoint,
} from './schedule';

// フォームの入力値（設計書 11.4）。開いたときの初期値と、種類・終日を切り替えたときの変わり方を決める。
// 画面に依存しない。保存する本文（draft・changes）への変換は build.ts、確認は validate.ts。

export type EntryKind = Entry['kind'];

/**
 * 入力欄の値。文字の欄は、空文字で「空」を表す（保存するときに null にする。build.ts）。
 * workspaceId は、種類がタイムブロックのときも持つ（予定に切り替えたときの値）。保存するときに null にする。
 */
export interface FormValues extends Schedule, RepeatFields {
  kind: EntryKind;
  title: string;
  workspaceId: string | null;
  notifyEnabled: boolean;
  /**
   * 通知のタイミング（開始の何分前か）を、10 進の文字で持つ。時間指定は、利用者が入力欄に入れる文字
   * （入力の途中は、空や「-」で、数にならない）。終日は、固定（-360）で、入力欄がない。
   */
  notifyOffsetText: string;
  location: string;
  url: string;
  memo: string;
}

/** 通知の初期値（要件 NT-2〜4）。値は shared/notifyDefaults.ts。入力欄の文字（10 進）で持つ。 */
export function defaultNotify(
  kind: EntryKind,
  allDay: boolean,
): Pick<FormValues, 'notifyEnabled' | 'notifyOffsetText'> {
  const { notifyEnabled, notifyOffsetMin } = sharedDefaultNotify(kind, allDay);
  return { notifyEnabled, notifyOffsetText: String(notifyOffsetMin) };
}

/**
 * 新しく作るときの初期値。開始は、start（日表示で決めた開始）か、なければ今日の次の正時。終了は、その 1 時間後（schedule.ts）。
 * workspaceId は、呼び出し側が、前回選んだワークスペース（EV-8。workspaceChoices.ts）から決めて渡す。
 */
export function createValues({
  kind,
  nowMs,
  workspaceId,
  start,
}: {
  kind: EntryKind;
  nowMs: number;
  workspaceId: string | null;
  start?: StartPoint;
}): FormValues {
  const schedule = scheduleFromStart(start ?? nextFullHour(nowMs));
  return {
    kind,
    title: '',
    ...schedule,
    workspaceId,
    ...NO_REPEAT,
    ...defaultNotify(kind, schedule.allDay),
    location: '',
    url: '',
    memo: '',
  };
}

/**
 * 開いた回の内容を、入力値にする。終日の予定の時刻の欄は、時間指定に切り替えたときの値として、
 * 新しく作るときと同じ初期値（今日の次の正時から 1 時間）を入れる。
 * 繰り返しの欄には、系列の行のルール（rrule）を出す。回（Occurrence）はルールを持たないので、呼び出し側が、
 * 同期のエンジンの行から seriesId で系列の行を引いて渡す。例外の回も、系列のルール（例外の行はルールを持たない）。
 * タイムブロックはワークスペースを持たないので、予定に変換したときの値として、workspaceFallback
 * （前回使ったワークスペース。EV-8。新しく作るときと同じ）を入れる。
 */
export function editValues(
  occurrence: Occurrence,
  nowMs: number,
  rrule: Rrule | null,
  workspaceFallback: string | null = null,
): FormValues {
  const fallback = defaultSchedule(nowMs);
  return {
    kind: occurrence.kind,
    title: occurrence.title,
    allDay: occurrence.allDay,
    startDate: occurrence.startDate,
    startTime: occurrence.startTime ?? fallback.startTime,
    endDate: occurrence.endDate,
    endTime: occurrence.endTime ?? fallback.endTime,
    workspaceId: occurrence.workspaceId ?? workspaceFallback,
    ...repeatFieldsOf(rrule),
    notifyEnabled: occurrence.notifyEnabled,
    notifyOffsetText: String(occurrence.notifyOffsetMin),
    location: occurrence.location ?? '',
    url: occurrence.url ?? '',
    memo: occurrence.memo ?? '',
  };
}

/** 日付の入力欄の値を日数にする。正しくなければ null（途中の入力があるため）。 */
function dateToDaysOrNull(date: string): number | null {
  return inputDateSchema.safeParse(date).success ? dateToDays(date) : null;
}

/**
 * 終日・終了・通知のタイミングを、切り替える前に戻す（終日の切り替えで変わる項目）。
 * 開始は、今の値のまま保ち、終了は、開いたときの「長さ」を保つ（開始を動かしていても、終了が開始より前にならない）。
 * 時刻は、変換で入った値のままなら開いたときの値に、利用者が変えていれば、その値を保つ。
 * 変換で入った値かどうかは、開いたときの値から同じ変換をして比べる。
 * 通知のタイミングは、常に開いたときの値に戻す（終日と時間指定で数の意味が違い、終日は入力欄がないため、
 * 時間指定の値を保つと、見えない欄の値で通知の時刻が変わる）。
 * 時間指定に戻すとき、終了が開始より後でなければ、toTimed と同じく開始の 1 時間後にする。
 */
function restoreSchedule(values: FormValues, opened: FormValues): FormValues {
  const converted = opened.allDay ? toTimed(opened) : toAllDay(opened);
  const timesUntouched =
    values.startTime === converted.startTime && values.endTime === converted.endTime;
  const startDay = dateToDaysOrNull(values.startDate);
  const openedStartDay = dateToDaysOrNull(opened.startDate);
  const openedEndDay = dateToDaysOrNull(opened.endDate);
  const endDate =
    startDay !== null && openedStartDay !== null && openedEndDay !== null
      ? daysToDate(startDay + openedEndDay - openedStartDay)
      : opened.endDate;
  const timesBack = timesUntouched
    ? { startTime: opened.startTime, endTime: opened.endTime }
    : { startTime: values.startTime, endTime: values.endTime };
  const restored = {
    ...values,
    allDay: opened.allDay,
    endDate,
    ...timesBack,
    anchor: undefined,
    notifyOffsetText: opened.notifyOffsetText,
  };
  return restored.allDay ? restored : toTimed(restored);
}

/**
 * 開いた予定の種類を切り替える（変換。EV-9。設計書 11.4）。通知は、今の値を残す（変換先の初期値にしない）。
 * ただし、終日の予定をタイムブロックにして時間指定になるときは、終日を切り替えたときと同じく、タイミングだけ、
 * 時間指定の初期値に戻す（数の意味が違うため。setAllDay）。
 * ワークスペースは、触らない。予定にしたときの値は、開いたときに入れてある（editValues）。
 * 開いたときの種類に戻すときは、変換で変わった項目を戻し、別の種類にいる間に変えた項目は保つ（restoreSchedule）。
 */
export function convertKind(values: FormValues, kind: EntryKind, opened?: FormValues): FormValues {
  if (values.kind === kind) return values;
  // 開いたときの種類に押し戻したときは、変換で変わった項目を、切り替える前に戻す（変えていない項目を送らない。P4）。
  // ワークスペースは、変換で書き換えない（opened の値に戻すと、別の種類にいる間に選び直した値が消える）。
  if (opened !== undefined && opened.kind === kind) {
    const restored = values.allDay === opened.allDay ? values : restoreSchedule(values, opened);
    return { ...restored, kind };
  }
  if (kind === 'block' && values.allDay) return { ...setAllDay(values, false), kind };
  return { ...values, kind };
}

/**
 * 種類（予定・タイムブロック）を切り替える（新しく作るときだけ。設計書 11.4）。通知は、その種類の初期値に戻す。
 * タイムブロックは終日にできないので、終日は外す。
 * 通知を戻すのは、予定とタイムブロックで、ON/OFF の初期値が違うため（NT-4）。切り替えても通知の設定が残ると、
 * 「予定は ON、タイムブロックは OFF」の初期値が、切り替える順番で変わってしまう。
 */
export function setKind(values: FormValues, kind: EntryKind): FormValues {
  if (values.kind === kind) return values;
  const schedule = kind === 'block' && values.allDay ? toTimed(values) : values;
  return { ...schedule, kind, ...defaultNotify(kind, schedule.allDay) };
}

/**
 * 終日と時間指定を切り替える。通知のタイミングは、その形の初期値（終日は当日の朝 6 時、時間指定は 10 分前）に戻す
 * （ON/OFF は変えない）。戻すのは、タイミングの数の意味が違うため（時間指定は「開始の何分前」、終日は
 * 「当日の 0:00 からの分」。設計書 4.3・4.5）。そのままにすると、終日の「朝 6 時 = -360」が、時間指定の
 * 「開始の 360 分後」になる。切り替えない限り、開いた予定のタイミング（API から入れた別の値を含む）は、書き換えない。
 */
export function setAllDay(values: FormValues, allDay: boolean): FormValues {
  if (values.allDay === allDay) return values;
  const schedule = allDay ? toAllDay(values) : toTimed(values);
  return {
    ...schedule,
    notifyOffsetText: defaultNotify(values.kind, allDay).notifyOffsetText,
  };
}
