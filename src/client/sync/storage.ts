import { createStore, del, entries, set } from 'idb-keyval';
import { z } from 'zod';
import { editedAtOf, pendingRequestSchema, type PendingRequest } from './requests';

/** IndexedDB に保存する、送信待ちの依頼 1 つ。id は、依頼の id（保存のキーと同じ）。 */
export interface StoredRequest {
  id: string;
  request: PendingRequest;
}

export interface LoadedRequests {
  /** 編集時刻の順（端末全体で単調に増えるので、作った順）。 */
  requests: StoredRequest[];
  /** 形が合わず、送らずに消した依頼の数（設計書 6.2 の「保存できなかった変更」に数える）。 */
  discarded: number;
}

/** 送信待ちの保存先。画面は IndexedDB（createIdbStorage）、テストは fake-indexeddb か、差し替えた実装を使う。 */
export interface PendingStorage {
  load(): Promise<LoadedRequests>;
  save(item: StoredRequest): Promise<void>;
  remove(id: string): Promise<void>;
}

const storedRequestSchema = z.strictObject({
  id: z.string().min(1),
  request: pendingRequestSchema,
});

/**
 * 依頼 1 つを、1 つのキー（依頼の id）で保存する。列全体を、1 つのキーに配列で入れない。
 * Why: 同じ端末の複数のタブ（設計書 6.2）で、古いタブが止まる直前に書き込みが重なったとき、配列を
 * 読んで書き戻す形だと、後から書いた方が、もう一方の依頼を消してしまう。キーを分ければ、書き込みは
 * 互いのキーに触れない。
 * idb-keyval の createStore は、データベースに表を 1 つだけ作る（データベース名ごとに 1 回）。
 * 同じデータベース名に、別の表名で作っても、表は増えない。
 */
export function createIdbStorage({
  dbName = 'atara-calendar-sync',
  storeName = 'pending-requests',
}: { dbName?: string; storeName?: string } = {}): PendingStorage {
  const store = createStore(dbName, storeName);

  return {
    async load() {
      const stored = await entries<IDBValidKey, unknown>(store);
      const requests: StoredRequest[] = [];
      let discarded = 0;
      for (const [key, value] of stored) {
        const parsed = storedRequestSchema.safeParse(value);
        if (parsed.success && parsed.data.id === key) {
          requests.push(parsed.data);
        } else {
          // 形の合わない依頼（古い版の画面が保存したものなど）は、送らずに消す。送ると、サーバーが 4xx で
          // 断るか、意図と違う内容で書かれる。残すと、起動のたびに、同じ依頼を読み直して捨てることになる。
          await del(key, store);
          discarded += 1;
        }
      }
      requests.sort(
        (a, b) => editedAtOf(a.request) - editedAtOf(b.request) || (a.id < b.id ? -1 : 1),
      );
      return { requests, discarded };
    },
    async save(item) {
      await set(item.id, item, store);
    },
    async remove(id) {
      await del(id, store);
    },
  };
}
