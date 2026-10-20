import type { Context } from 'hono';
import { HTTPException } from 'hono/http-exception';
import type { ApiErrorBody, ApiErrorKind } from '../../shared/api';
import { InvalidChangeError } from '../../shared/recurrence';
import type { AppEnv } from '../env';
import { KindMismatchError } from '../db/store';

/**
 * 端末が「直らないので捨てる」4xx にする入力の誤り。detail はログにだけ出し、応答には出さない
 * （Zod のエラー文や内部の情報を、応答に混ぜないため。設計書 5.1）。
 */
export class ApiError extends Error {
  override readonly name = 'ApiError';
  readonly status: 400 | 409;
  readonly kind: ApiErrorKind;

  constructor(status: 400 | 409, kind: ApiErrorKind, detail: string) {
    super(detail);
    this.status = status;
    this.kind = kind;
  }
}

export function badRequest(detail: string): ApiError {
  return new ApiError(400, 'invalid_request', detail);
}

const MESSAGES: Record<ApiErrorKind, string> = {
  invalid_request: '入力が正しくありません',
  invalid_change: '変更の内容を受け付けられません',
  builtin_workspace: '組み込みのワークスペースは、表示と並び順のほかは変えられません',
  last_workspace: '最後のワークスペースは削除できません',
  edited_at_in_future: '編集した時刻が未来すぎます',
  conflict: '依頼の内容が、保存されているデータと食い違っています',
  internal_error: 'サーバーでエラーが起きました',
};

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : '';
}

/**
 * D1 の外部キー違反か。D1 は、例外の message に SQLite の文言をそのまま入れる
 * （'D1_ERROR: FOREIGN KEY constraint failed: SQLITE_CONSTRAINT ...'）。専用のクラスや code がないので、文言で判定する。
 * workerd では、本当の原因が cause に入ることもあるので、両方を見る。
 */
export function isForeignKeyViolation(error: unknown): boolean {
  const pattern = /FOREIGN KEY constraint failed/i;
  return (
    pattern.test(messageOf(error)) ||
    (error instanceof Error && pattern.test(messageOf(error.cause)))
  );
}

interface Classified {
  status: 400 | 409 | 500;
  kind: ApiErrorKind;
}

function classify(error: Error): Classified {
  if (error instanceof ApiError) return { status: error.status, kind: error.kind };
  // InvalidChangeError は、変更の中身が受け付けられない（設計書 4.5）。端末が直せないので 400。
  if (error instanceof InvalidChangeError) return { status: 400, kind: 'invalid_change' };
  // kind の食い違いと外部キー違反は、依頼が、保存されているデータと合わない。再送しても直らないので 409。
  if (error instanceof KindMismatchError || isForeignKeyViolation(error)) {
    return { status: 409, kind: 'conflict' };
  }
  // それ以外（壊れた行 CorruptRowError、D1 の一時的な失敗など）は、サーバーの側の問題。端末は再送する。
  return { status: 500, kind: 'internal_error' };
}

/**
 * API のエラー応答。本文は、種類と固定の文言だけにする。詳しい内容は、ログ（wrangler tail）にだけ残す。
 * 4xx は warn、500 は error で出す。
 */
export function handleError(error: Error, c: Context<AppEnv>): Response | Promise<Response> {
  // HTTPException は、Hono が自分で作った応答（本文の大きさの制限など）を持っているので、そのまま返す。
  if (error instanceof HTTPException) return error.getResponse();

  const { status, kind } = classify(error);
  if (status === 500) {
    console.error(`[api] 500: ${error.name}: ${error.message}`, error);
  } else {
    console.warn(`[api] ${String(status)} ${kind}: ${error.name}: ${error.message}`);
  }
  const body: ApiErrorBody = { error: kind, message: MESSAGES[kind] };
  return c.json(body, status);
}
