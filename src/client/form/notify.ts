import { INPUT_LIMITS } from '../../shared/schema';

// 通知のタイミング（設計書 11.4。要件 NT-2・NT-3）。タイミングは、開始の何分前かの 1 つの数で持つ（設計書 4.3）。
// 時間指定は、そのまま「何分前か」で、利用者が分を入力する。終日は、開始を「その日の 0:00」とみなすので、
// 当日の朝 6 時なら -360。終日の時刻は、予定ごとには設定できず、当日の朝 6 時に固定する（要件 NT-3）。

/** 時間指定の通知の初期値（NT-2）。10 分前。 */
export const DEFAULT_TIMED_NOTIFY_MIN = 10;

/** 終日の通知の時刻（NT-3）。当日の朝 6 時。予定ごとには設定できない。 */
export const DEFAULT_ALL_DAY_NOTIFY_MIN = -360;

/**
 * 時間指定の「何分前」の入力欄が受け付ける範囲。
 * 下限が 0 なのは、開始より後の通知（負の値）を、画面から作らせないため。上限は、サーバーの入力の検証と同じ。
 * API は、終日のために、負の値（-1440 まで）も受け付けるが、時間指定の入力欄には使わない。
 */
export const TIMED_NOTIFY_RANGE = { min: 0, max: INPUT_LIMITS.notifyOffsetMin.max } as const;

/**
 * 「何分前」の入力欄の文字を、整数にする。整数でなければ null（空・小数・文字・「1e2」など）。範囲は見ない。
 * 入力欄の文字をそのまま持つのは、入力の途中（空・「-」だけ）が、数では表せないため。
 */
export function parseNotifyOffset(text: string): number | null {
  if (!/^-?\d+$/.test(text)) return null;
  const value = Number(text);
  // -0 にしない（保存する値と、比べる値が、見かけ上同じ 0 になるように）。
  return value === 0 ? 0 : value;
}

const MINUTES_PER_DAY = 24 * 60;

/**
 * 終日の通知の時刻の表記。ふつうは「当日 6:00」。
 * 画面では固定（当日 6:00）だが、API から直接入れた、別の値の終日の予定も開けるので、どの値でも表記できる
 * （前の日・翌日になる値もある。API は -1440〜10080 を受け付ける）。
 */
export function describeAllDayNotify(offsetMin: number): string {
  // 0 から引くのは、offsetMin が 0 のときに、-0 にしないため。
  const fromMidnight = 0 - offsetMin;
  const day = Math.floor(fromMidnight / MINUTES_PER_DAY);
  const minuteOfDay = fromMidnight - day * MINUTES_PER_DAY;
  const time = `${String(Math.floor(minuteOfDay / 60))}:${String(minuteOfDay % 60).padStart(2, '0')}`;
  const prefix =
    day === 0
      ? '当日'
      : day === -1
        ? '前日'
        : day < 0
          ? `${String(-day)}日前`
          : day === 1
            ? '翌日'
            : `${String(day)}日後`;
  return `${prefix} ${time}`;
}
