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
): Map<string, number | null> | null {
  try {
    return nextNotifyTimes({ family, afterMs: nowMs });
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
  const families = new Map<string, Map<string, { entry: Entry; current: number | null }>>();
  const add = (entry: Entry, current: number | null) => {
    const key = familyKey(entry);
    if (!keys.has(key)) return;
    const family = families.get(key) ?? new Map<string, { entry: Entry; current: number | null }>();
    family.set(entry.id, { entry, current });
    families.set(key, family);
  };
  for (const { entry, nextNotifyAt } of stored) add(entry, nextNotifyAt);
  for (const entry of written) add(entry, null);

  const updates: NotifyUpdate[] = [];
  for (const [key, family] of families) {
    const times = calculateOrNull(
      key,
      [...family.values()].map(({ entry }) => entry),
      nowMs,
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
