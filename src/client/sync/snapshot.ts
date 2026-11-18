import { createStore, get, set, type UseStore } from 'idb-keyval';
import { z } from 'zod';
import { structuralChangesResponseSchema } from '../../shared/structure';
import type { BaseData } from './state';

/** 保存の形を、互換でなく変えたときに上げる。違う版のスナップショットは、読まずに捨てて、全データを読み込む。 */
export const SNAPSHOT_VERSION = 1;

/** 受け取った内容の保存先（設計書 6.1）。画面は IndexedDB（createIdbSnapshotStorage）、テストは fake-indexeddb を使う。 */
export interface SnapshotStorage {
  /** 保存したものがない・版が違う・形が合わないときは null。 */
  load(): Promise<BaseData | null>;
  save(base: BaseData): Promise<void>;
}

// 行の形は、受け取りの応答の確認（http.ts の fetchChanges）と同じスキーマで確かめる。
// 書き写すと、片方だけが変わって、応答は通るのにスナップショットは読めない、という食い違いが起きる。
const storedSnapshotSchema = structuralChangesResponseSchema.extend({
  version: z.literal(SNAPSHOT_VERSION),
});

const SNAPSHOT_KEY = 'base';

/**
 * 1 つのキーに、丸ごと保存する。Why not 行ごとにキーを分ける: 書くのは錠を持つタブだけ（設計書 6.7）なので、
 * 書き込みが重ならない。丸ごとなら、途中までしか書けていない状態が起きない。
 * 送信待ちと別のデータベースにするのは、idb-keyval が、すでにあるデータベースに表を足せないため（設計書 14.2）。
 */
export function createIdbSnapshotStorage({
  dbName = 'atara-calendar-snapshot',
  storeName = 'snapshot',
}: { dbName?: string; storeName?: string } = {}): SnapshotStorage {
  // storage.ts と同じ理由で、IndexedDB を開くのは、最初の読み書きまで遅らせる。
  let opened: UseStore | undefined;
  const openStore = (): UseStore => {
    opened ??= createStore(dbName, storeName);
    return opened;
  };

  return {
    async load() {
      const parsed = storedSnapshotSchema.safeParse(await get<unknown>(SNAPSHOT_KEY, openStore()));
      if (!parsed.success) return null;
      const { rev, epoch, workspaces, entries } = parsed.data;
      return {
        rev,
        epoch,
        workspaces: new Map(workspaces.map((row) => [row.id, row])),
        entries: new Map(entries.map((row) => [row.id, row])),
      };
    },
    async save(base) {
      await set(
        SNAPSHOT_KEY,
        {
          version: SNAPSHOT_VERSION,
          rev: base.rev,
          epoch: base.epoch,
          workspaces: [...base.workspaces.values()],
          entries: [...base.entries.values()],
        },
        openStore(),
      );
    },
  };
}
