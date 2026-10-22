import { entryDraftInputSchema } from '../../shared/schema';

/** 場所の名前から作る、地図の検索へのリンク（設計書 4.3）。地図の URL を保存せず、名前だけを保存する。 */
export function mapSearchUrl(location: string): string {
  return `https://www.google.com/maps/search/?api=1&query=${encodeURIComponent(location)}`;
}

/**
 * リンクにしてよい URL。サーバーの入力の検証（http:// か https:// で始まる・URL として読める・2048 文字まで）を
 * 通るものだけを、そのまま返す。通らなければ null。
 * 検証を通らないものをリンクにしないのは、javascript: などを押したときに、スクリプトが動くのを防ぐため（設計書 10.3）。
 */
export function openableUrl(value: string): string | null {
  return entryDraftInputSchema.shape.url.safeParse(value).success ? value : null;
}
