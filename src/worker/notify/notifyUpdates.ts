import type { Entry } from '../../shared/schema';
import type { StoredEntry } from '../db/rows';
import { nextNotifyTimes } from './nextNotifyAt';

// 保存したときに、どの行の next_notify_at を、いくつに更新するかを決める（設計書 9.2）。
// DB には触れない。読み込んだ今の行と、書く行から、書いたあとの状態を作って、計算を当てるだけ。

/** next_notify_at を、nextNotifyAt にする行。editedAt は、更新の条件（store.ts の UPDATE）に使う。 */
export interface NotifyUpdate {
  id: string;
  editedAt: number;
  nextNotifyAt: number | null;
}

/** 系列の id。系列の行と、繰り返さない予定は自分の id。例外の行は、元の系列の id。 */
export function familyKey(row: Entry): string {
  return row.seriesId ?? row.id;
}

/** 計算が例外を投げたら、null（その系列の削除されていない行は、すべて NULL にする）。 */
function calculateOrNull(
  key: string,
  family: readonly Entry[],
  nowMs: number,
  afterMsById: ReadonlyMap<string, number>,
): Map<string, number | null> | null {
  try {
    return nextNotifyTimes({ family, afterMs: nowMs, afterMsById });
  } catch (error) {
    // 計算のバグで保存を失敗させると、端末が再送し続けるか、4xx で捨てて、予定そのものを失う。
    // 保存は成功させ、この系列だけ、通知しない（NULL）。ログに出すのは id と例外だけで、予定の中身（題名など）は出さない。
    console.error(
      `next_notify_at の計算に失敗したので、この系列は通知しません（系列の id: ${key}）`,
      error,
    );
    return null;
  }
}

/**
 * 書く行（written）のうち、削除しない行が 1 つでもある系列ごとに、書いたあとの状態に計算を当てて、
 * その系列の、削除されていない全行の next_notify_at を決める。upsert のあとの値と違う行だけを返す。
 * 書かない行も含める。「この予定のみ」で例外の行だけを書いたときも、系列の行の次の回が変わることがあるため。
 *
 * stored は、書く前の今の行。書く行の系列の、系列の行と例外の行を、すべて含む（それ以外の行は見ない）。
 * 削除する行だけを書く系列は、計算しない。recurrence.ts の削除は、系列の行と例外の行を同時に削除するので、
 * 通知の対象になる行が残らず、削除した行の next_notify_at は upsert が NULL に戻す。見ようとすると、
 * ワークスペースの削除のように、削除する行が多い書き込みで、系列ごとの読み込みと検証が増えて、CPU 時間を使う。
 *
 * 書く行は「今」より後の回だけを数える（保存した時点で過ぎている回は飛ばす）。書かない行は、「今」と、その行の
 * 今の next_notify_at の 1 ms 前の、早い方より後の回を数える（今の値が NULL なら「今」）。書かない行の、
 * 時刻が来て、まだ送っていない回は、利用者が今回保存した回ではないので、飛ばさず、定期実行が送るもののまま残す。
 * 飛ばすと、14:50 に通知する毎日の系列で、14:50:20 に、明日の回を「この予定のみ」で変えたとき、書かない系列の行が
 * 「今」で計算し直されて、今日の通知が明日に進み、届かない。afterMs を小さくしても、例外で移した・削除した回は、
 * 展開がもとから除くので、その回の通知は、数えられない。
 *
 * 計算が例外を投げたら、その系列の削除されていない全行を NULL にする（calculateOrNull）。書かない行は、
 * upsert が NULL に戻さないので、古い値が残る。残すと、変わった系列に、古い時刻で通知してしまう。
 */
export function planNotifyUpdates({
  stored,
  written,
  nowMs,
}: {
  stored: readonly StoredEntry[];
  written: readonly Entry[];
  nowMs: number;
}): NotifyUpdate[] {
  const keys = new Set(written.filter((row) => row.deletedAt === null).map(familyKey));

  // id → 行と、upsert のあとに next_notify_at が持っている値。書いた行は、upsert が NULL に戻している。
  interface FamilyRow {
    entry: Entry;
    current: number | null;
    written: boolean;
  }
  const families = new Map<string, Map<string, FamilyRow>>();
  const add = (row: FamilyRow) => {
    const key = familyKey(row.entry);
    if (!keys.has(key)) return;
    const family = families.get(key) ?? new Map<string, FamilyRow>();
    family.set(row.entry.id, row);
    families.set(key, family);
  };
  for (const { entry, nextNotifyAt } of stored) {
    add({ entry, current: nextNotifyAt, written: false });
  }
  for (const entry of written) add({ entry, current: null, written: true });

  const updates: NotifyUpdate[] = [];
  for (const [key, family] of families) {
    const afterMsById = new Map<string, number>();
    for (const { entry, current, written: isWritten } of family.values()) {
      if (!isWritten && current !== null) afterMsById.set(entry.id, Math.min(nowMs, current - 1));
    }
    const times = calculateOrNull(
      key,
      [...family.values()].map(({ entry }) => entry),
      nowMs,
      afterMsById,
    );
    for (const { entry, current } of family.values()) {
      if (entry.deletedAt !== null) continue;
      const next = times?.get(entry.id) ?? null;
      if (next !== current) {
        updates.push({ id: entry.id, editedAt: entry.editedAt, nextNotifyAt: next });
      }
    }
  }
  return updates;
}
