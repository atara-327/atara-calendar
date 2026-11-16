import { createStore, del, entries, set, type UseStore } from 'idb-keyval';
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
  /** 形が合わず、送らずに消した依頼の数（設計書 6.5 の「保存できなかった変更」に数える）。 */
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

/** 前の版が使っていたデータベースの名前（送信待ちの形を変えたときに、名前を変える。設計書 14.2）。 */
export const LEGACY_DB_NAMES: readonly string[] = ['atara-calendar-sync'];

/**
 * 依頼 1 つを、1 つのキー（依頼の id）で保存する。列全体を、1 つのキーに配列で入れない。
 * Why: 同じ端末の複数のタブ（設計書 6.7）で、古いタブが止まる直前に書き込みが重なったとき、配列を
 * 読んで書き戻す形だと、後から書いた方が、もう一方の依頼を消してしまう。キーを分ければ、書き込みは
 * 互いのキーに触れない。
 * idb-keyval の createStore は、データベースに表を 1 つだけ作る（データベース名ごとに 1 回）。
 * 同じデータベース名に、別の表名で作っても、表は増えない。
 */
export function createIdbStorage({
  dbName = 'atara-calendar-sync-v2',
  storeName = 'pending-requests',
  legacyDbNames = [],
}: {
  dbName?: string;
  storeName?: string;
  /** 前の版が使っていた名前。起動時に、ここにある送信待ちも読み、引き継ぐ。 */
  legacyDbNames?: readonly string[];
} = {}): PendingStorage {
  // IndexedDB を開くのは、最初の読み書きまで遅らせる。idb-keyval の createStore は、作った時点で開くので、
  // IndexedDB が使えない環境（プライベートブラウズなど）では、ここで例外になり、画面を描く前に落ちる。
  // 読み書きの中で失敗すれば、エンジンが storageFailed にして、メモリの上では動き続けられる。
  let opened: UseStore | undefined;
  const openStore = (): UseStore => {
    opened ??= createStore(dbName, storeName);
    return opened;
  };

  /**
   * 前の名前のデータベースにある送信待ちを、新しいデータベースに移す。移したら、前の方は消す。
   * Why: 送信待ちの形を、互換でなく変えたとき（予定とタイムブロックの変換で、changes に kind が増えた。
   * 設計書 14.2）、電波がない間は、端末に保存した古い版の画面が開き、古い版は、知らない形の送信待ちを消す。
   * 名前を変えれば、古い版は、新しい版の依頼に触れない。
   * Why not データベースごと消す（deleteDatabase）: idb-keyval は、開いた接続を閉じないので、自分の接続に
   * 邪魔されて消えない。
   */
  async function migrateLegacy(target: UseStore): Promise<number> {
    let discarded = 0;
    for (const legacyName of legacyDbNames) {
      const legacy = createStore(legacyName, storeName);
      for (const [key, value] of await entries<IDBValidKey, unknown>(legacy)) {
        const parsed = storedRequestSchema.safeParse(value);
        if (parsed.success && parsed.data.id === key) {
          await set(parsed.data.id, parsed.data, target);
        } else {
          discarded += 1;
        }
        await del(key, legacy);
      }
    }
    return discarded;
  }

  return {
    async load() {
      const store = openStore();
      let discarded = 0;
      try {
        discarded = await migrateLegacy(store);
      } catch (error) {
        // 古い DB が読めなくても、新しい DB の送信待ちは読む（止めると、新しい編集まで送れなくなる）。
        console.error('古い送信待ちの引き継ぎに失敗しました', error);
      }
      const stored = await entries<IDBValidKey, unknown>(store);
      const requests: StoredRequest[] = [];
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
      await set(item.id, item, openStore());
    },
    async remove(id) {
      await del(id, openStore());
    },
  };
}
