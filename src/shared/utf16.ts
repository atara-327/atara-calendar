import type { z } from 'zod';

/**
 * 文字列の長さの上限を、UTF-16 の単位（String.length）で確かめる検証。z.string().check(maxUtf16(n)) の形で使う。
 * Why not z.string().max(n): Zod 4 は、UTF-16 ではなく、コードポイントで数える。画面の入力欄（maxLength）と
 * フォームの確認は UTF-16 で数えるので、サーバーだけが数え方を変えると、API から入れた絵文字の名前を、画面が
 * 直せなくなる（例: 絵文字 26 個のワークスペース名は、上限 50 の UTF-16 では 52 単位で、色だけの変更も断られる）。
 * 誤りの種類は too_big のまま（z.string().max と同じなので、画面の誤りの出し分けが変わらない）。
 */
export function maxUtf16(maximum: number): z.core.CheckFn<string> {
  return (ctx) => {
    if (ctx.value.length > maximum) {
      ctx.issues.push({
        code: 'too_big',
        origin: 'string',
        maximum,
        inclusive: true,
        input: ctx.value,
      });
    }
  };
}
