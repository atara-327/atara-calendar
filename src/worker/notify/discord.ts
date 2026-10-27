// Discord の Webhook への送信（設計書 9.3）。通知の文面（message.ts）を、そのまま投稿する。

/** 送信に使う fetch。テストが、偽物を渡すために、引数で受け取る。 */
export type DiscordFetch = (url: string, init: RequestInit) => Promise<Response>;

/** 1 回の送信を待つ上限。Discord が応答しないとき、定期実行が、ほかの通知を送れないまま待ち続けないため。 */
export const DISCORD_TIMEOUT_MS = 10_000;

/** 失敗の理由（ログ用）。URL や応答の中身は含めない。 */
type Failure = string;

async function attempt(
  fetchFn: DiscordFetch,
  webhookUrl: string,
  content: string,
  timeoutMs: number,
): Promise<Failure | null> {
  try {
    const response = await fetchFn(webhookUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      // allowed_mentions で、題名に @everyone などを書いた予定が、サーバー全員への通知にならないようにする（設計書 9.4）。
      body: JSON.stringify({ content, allowed_mentions: { parse: [] } }),
      signal: AbortSignal.timeout(timeoutMs),
    });
    // 本文は使わない。読まずに放ると、接続が開いたままになるので、捨てる。捨てるのに失敗しても、送れたことは変わらない。
    await response.body?.cancel().catch(() => undefined);
    return response.status >= 200 && response.status < 300
      ? null
      : `HTTP ${String(response.status)}`;
  } catch (error) {
    // 例外のメッセージは、ログに出さない。URL を含むことがある（Webhook の URL は、知っていれば誰でも投稿できる秘密）。
    return error instanceof Error ? error.name : '不明なエラー';
  }
}

/**
 * Discord に投稿する。失敗（2xx 以外・通信の例外・待ちの上限）したら、その場で 1 回だけ再送する。
 * それでも失敗したら、ログに残して、false を返す。例外は投げない。
 * 再送を 1 回にするのは、先に next_notify_at を進めてから送る（設計書 9.3）ので、失敗した回は、
 * 後から送り直されないため。何度も再送すると、Discord が落ちているとき、ほかの通知まで遅らせる。
 * ログに URL を出さない。Webhook の URL を知っていれば、誰でもそのチャンネルに投稿できる。
 */
export async function postToDiscord({
  webhookUrl,
  content,
  fetchFn,
  timeoutMs = DISCORD_TIMEOUT_MS,
}: {
  webhookUrl: string;
  content: string;
  fetchFn: DiscordFetch;
  timeoutMs?: number;
}): Promise<boolean> {
  let failure = await attempt(fetchFn, webhookUrl, content, timeoutMs);
  if (failure === null) return true;
  failure = await attempt(fetchFn, webhookUrl, content, timeoutMs);
  if (failure === null) return true;
  console.error(`Discord への送信に失敗しました（理由: ${failure}）。この通知は届きません`);
  return false;
}
