import type { SyncState } from './state';

// サーバーが失敗を返したときの、画面の下の知らせの文言（設計書 6.5）。画面に依存しない関数にして、テストする。

/**
 * 出す文言。知らせないときは null。
 * 送信と受け取りの両方が失敗しているときは、送信の状態を出す。送信の失敗は、保存した編集が、まだサーバーに
 * 届いていないことなので、受け取りの失敗より大事なため。
 * 状態が 200 のとき（書き込みの応答の形が違う。ログイン前の案内ページなど）は、「HTTP 200 で失敗」では意味が
 * 読み取れないので、状態の代わりに、形が違うことを言う。
 */
export function serverFailureMessage(serverFailure: SyncState['serverFailure']): string | null {
  const status = serverFailure.send ?? serverFailure.receive;
  if (status === null) return null;
  const detail = status === 200 ? '応答の形が違います' : `HTTP ${String(status)}`;
  return `サーバーとのやり取りに失敗しています（${detail}）。続くときは、Worker のログを確かめてください`;
}
