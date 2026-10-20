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
  not_found: '存在しない API です',
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
  // 外部キー違反を文言で判定するのは、予備。存在しないワークスペースは、書く前に API が確かめて 409 にしている
  // （write.ts）ので、通常はここに来ない。確かめた後、書き込みの前に、ワークスペースが消える割り込み（手での
  // 修正や復元。設計書 付録 A.1・A.3）があると、外部キー違反になる。判定を消して、API の確認だけにしなかったのは、
  // 割り込まれたときに 500 になり、端末が再送し続けるため。逆に、文言の判定だけにしなかったのは、本番の D1 の
  // 文言が Miniflare と同じかを確かめられず、違うと、ふだんの依頼まで 500 になるため。
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

/**
 * /api/ の下の、存在しないパスと、存在するパスへの違うメソッド。Hono の既定の text/plain の "404 Not Found" ではなく、
 * 他のエラーと同じ JSON にする。端末や MCP が、エラーを同じ形で読めるため。
 * 認証より前には出ない（認証の後ろに置いたミドルウェアが、先に応答しないときだけ、ここに来る）ので、
 * ログインしていない相手に、API の存在を教えない（設計書 10.2）。
 */
export function handleNotFound(c: Context<AppEnv>): Response {
  console.warn(`[api] 404 not_found: ${c.req.method} ${c.req.path}`);
  const body: ApiErrorBody = { error: 'not_found', message: MESSAGES.not_found };
  return c.json(body, 404);
}
