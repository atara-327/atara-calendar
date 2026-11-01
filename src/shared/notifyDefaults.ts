import type { Entry } from './schema';

// 通知の初期値（要件 NT-2〜4。設計書 4.3）。画面のフォーム（client/form/values.ts）と MCP の create_event が、
// 同じ値を使う。片方だけを直すと、画面から作った予定と、Claude から作った予定で、通知の初期値が食い違う。
// タイミングは、開始の何分前かの 1 つの数。終日は、開始を「その日の 0:00」とみなすので、当日の朝 6 時なら -360。

/** 時間指定の通知の初期値（NT-2）。10 分前。 */
export const DEFAULT_TIMED_NOTIFY_MIN = 10;

/** 終日の通知の時刻（NT-3）。当日の朝 6 時。予定ごとには設定できない。 */
export const DEFAULT_ALL_DAY_NOTIFY_MIN = -360;

/**
 * 通知の初期値（NT-4）。予定は ON（時間指定は 10 分前、終日は当日の朝 6 時）、タイムブロックは OFF。
 * OFF のときも、ON にしたときの初期のタイミング（10 分前）を持つ。
 */
export function defaultNotify(
  kind: Entry['kind'],
  allDay: boolean,
): Pick<Entry, 'notifyEnabled' | 'notifyOffsetMin'> {
  if (kind === 'block') return { notifyEnabled: false, notifyOffsetMin: DEFAULT_TIMED_NOTIFY_MIN };
  return {
    notifyEnabled: true,
    notifyOffsetMin: allDay ? DEFAULT_ALL_DAY_NOTIFY_MIN : DEFAULT_TIMED_NOTIFY_MIN,
  };
}
