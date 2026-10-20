import type { Context } from 'hono';
import { z } from 'zod';
import { idInputSchema } from '../../shared/schema';
import type { AppEnv } from '../env';
import { ApiError, badRequest } from './errors';

/** 検証に失敗したら ApiError（400）。Zod のエラー文は、ログにだけ出す。 */
export function parseWith<T extends z.ZodType>(
  schema: T,
  value: unknown,
  what: string,
): z.infer<T> {
  const result = schema.safeParse(value);
  if (!result.success)
    throw badRequest(`入力が正しくありません（${what}）\n${z.prettifyError(result.error)}`);
  return result.data;
}

/** JSON の本文を読んで検証する。JSON として読めないときも 400。 */
export async function parseBody<T extends z.ZodType>(
  c: Context<AppEnv>,
  schema: T,
): Promise<z.infer<T>> {
  let json: unknown;
  try {
    json = await c.req.json();
  } catch {
    throw badRequest('本文が JSON として読めません');
  }
  return parseWith(schema, json, '本文');
}

/** URL の :id。端末が作る UUID と、組み込みの固定 id の形だけを通す。 */
export function parseId(value: string): string {
  return parseWith(idInputSchema, value, 'URL の id');
}

/**
 * 編集時刻が、サーバーの今より、これ以上未来の依頼は断る（設計書 6.4）。
 * 時計が大きく進んだ端末の編集が、その後のすべての編集に勝ち続けてしまうため。10 分にしているのは、
 * 端末の時計の普通のずれ（数秒〜数分）は通し、大きく進んだ端末だけを止めるため。
 */
export const MAX_EDITED_AT_AHEAD_MS = 10 * 60 * 1000;

export function assertEditedAtNotInFuture(editedAt: number, nowMs: number = Date.now()): void {
  if (editedAt > nowMs + MAX_EDITED_AT_AHEAD_MS) {
    throw new ApiError(
      400,
      'edited_at_in_future',
      `editedAt が未来すぎます（editedAt: ${String(editedAt)}、サーバーの今: ${String(nowMs)}）`,
    );
  }
}
