import { dateToDays, addDays, type DateStr } from '../../shared/date';
import { isDateInSupportedYears } from '../../shared/schema';

// 月表示の、ドラッグで日付を移す計算（EV-6。設計書 11.2）。画面（Pointer Events・DOM）に依存しない。
// 始まり方の判定（長押し・4px）は、日表示のドラッグと共有する dragTracker.ts。

/** 押したマスから、離したマスまでの日数（後ろの日が正）。 */
export function dayShift(pressed: DateStr, dropped: DateStr): number {
  return dateToDays(dropped) - dateToDays(pressed);
}

/**
 * 開始日と終了日を、同じ日数だけずらした組。ずらさない（0 日）・範囲（1900〜2199 年）の外へ出るときは null。
 * 基準は、予定の開始日と終了日（押したマスの日ではない）。複数日の予定は、どのマスを掴んでも、動かした日数だけずれる。
 * 時刻と長さは、日付を同じだけずらすので、変わらない。
 */
export function movedDates(
  { startDate, endDate }: { startDate: DateStr; endDate: DateStr },
  shift: number,
): { startDate: DateStr; endDate: DateStr } | null {
  if (shift === 0) return null;
  const moved = { startDate: addDays(startDate, shift), endDate: addDays(endDate, shift) };
  return isDateInSupportedYears(moved.startDate) && isDateInSupportedYears(moved.endDate)
    ? moved
    : null;
}
