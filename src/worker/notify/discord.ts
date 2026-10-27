// Discord の Webhook への送信（設計書 9.3）。通知の文面（message.ts）を、そのまま投稿する。

/** 送信に使う fetch。テストが、偽物を渡すために、引数で受け取る。 */
export type DiscordFetch = (url: string, init: RequestInit) => Promise<Response>;

/** 1 回の送信を待つ上限。Discord が応答しないとき、定期実行が、ほかの通知を送れないまま待ち続けないため。 */
export const DISCORD_TIMEOUT_MS = 10_000;

/** メッセージの flags の SUPPRESS_EMBEDS。Webhook の投稿で指定できるのは、このフラグと SUPPRESS_NOTIFICATIONS だけ。 */
const SUPPRESS_EMBEDS = 4;

/** 待つ関数。テストが、実際には待たずに、待つ時間を確かめられるように、引数で受け取る。 */
export type Sleep = (ms: number) => Promise<void>;

const defaultSleep: Sleep = (ms) =>
  new Promise((resolve) => {
    setTimeout(resolve, ms);
  });

/**
 * レート制限で待つ時間の上限。Webhook は、短い時間に 5 回ほどしか投稿できないと報告されていて、同じ時刻の通知が
 * 6 件以上あると、6 件目以降が 429 になる。待つ秒数は Discord が返すが、そのまま待つと、1 回の実行が長くなり、
 * 毎分の実行が重なる。上限より長く待たされるときは、上限だけ待って再送し、まだ 429 なら、その通知は届かない。
 */
export const MAX_RATE_LIMIT_WAIT_MS = 5_000;

/** 失敗の理由（ログ用）。URL や応答の中身は含めない。 */
type Failure = string;

type Attempt =
  { failure: null; response: Response } | { failure: Failure; response: Response | null };

async function attempt(
  fetchFn: DiscordFetch,
  webhookUrl: string,
  content: string,
  timeoutMs: number,
): Promise<Attempt> {
  try {
    const response = await fetchFn(webhookUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      // allowed_mentions で、題名に @everyone などを書いた予定が、サーバー全員への通知にならないようにする（設計書 9.4）。
      // flags: 4（SUPPRESS_EMBEDS）で、リンクの埋め込み（カード）を付けさせない。リンク先は Access の後ろにあるので、
      // Discord がリンクを読みに行くと、毎回、ログインの画面のカードが付くおそれがある（設計書 9.3）。
      body: JSON.stringify({ content, allowed_mentions: { parse: [] }, flags: SUPPRESS_EMBEDS }),
      signal: AbortSignal.timeout(timeoutMs),
    });
    // 本文は使わない（レート制限も、ヘッダーだけを見る）。読まずに放ると、接続が開いたままになるので、捨てる。
    // 捨てるのに失敗しても、送れたことは変わらない。
    await response.body?.cancel().catch(() => undefined);
    return response.status >= 200 && response.status < 300
      ? { failure: null, response }
      : { failure: `HTTP ${String(response.status)}`, response };
  } catch (error) {
    // 例外のメッセージは、ログに出さない。URL を含むことがある（Webhook の URL は、知っていれば誰でも投稿できる秘密）。
    return { failure: error instanceof Error ? error.name : '不明なエラー', response: null };
  }
}

/**
 * 秒で書かれたヘッダー（最初に値があり、0 以上の数として読めるもの）を、ミリ秒にする。
 * なければ、0。上限は MAX_RATE_LIMIT_WAIT_MS。
 */
function waitFromHeaders(response: Response, ...names: string[]): number {
  for (const name of names) {
    const value = response.headers.get(name);
    if (value === null || value.trim() === '') continue;
    const seconds = Number(value);
    if (Number.isFinite(seconds) && seconds >= 0) {
      return Math.min(Math.round(seconds * 1000), MAX_RATE_LIMIT_WAIT_MS);
    }
  }
  return 0;
}

export interface DiscordSender {
  /** 投稿する。届いたら true。例外は投げない。 */
  send: (content: string) => Promise<boolean>;
}

/**
 * Discord の Webhook に投稿する送り手。1 回の定期実行に 1 つ作り、同じ実行の投稿は、同じ送り手で送る
 * （レート制限の「次の投稿の前に待つ」が、投稿をまたいで効くため）。
 *
 * 失敗（2xx 以外・通信の例外・待ちの上限）したら、その場で 1 回だけ再送する。それでも失敗したら、ログに残して、
 * false を返す。再送を 1 回にするのは、先に next_notify_at を進めてから送る（設計書 9.3）ので、失敗した回は、
 * 後から送り直されないため。何度も再送すると、Discord が落ちているとき、ほかの通知まで遅らせる。
 *
 * レート制限（設計書 9.3）: 429 のときは、Retry-After（なければ X-RateLimit-Reset-After）の秒数だけ待って、
 * 1 回だけ再送する。2xx の応答で X-RateLimit-Remaining が 0 なら、次の投稿の前に、X-RateLimit-Reset-After
 * の秒数だけ待つ。待つのは、どちらも上限（MAX_RATE_LIMIT_WAIT_MS）まで。ヘッダーだけを見て、本文は読まない。
 *
 * ログに URL を出さない。Webhook の URL を知っていれば、誰でもそのチャンネルに投稿できる。
 */
export function createDiscordSender({
  webhookUrl,
  fetchFn,
  timeoutMs = DISCORD_TIMEOUT_MS,
  sleep = defaultSleep,
}: {
  webhookUrl: string;
  fetchFn: DiscordFetch;
  timeoutMs?: number;
  sleep?: Sleep;
}): DiscordSender {
  // 次の投稿の前に待つ時間。直前の応答で、このあと投稿できる回数が 0 だと分かったときだけ入る。
  let waitBeforeNextMs = 0;

  const waitIfNeeded = async (ms: number): Promise<void> => {
    if (ms > 0) await sleep(ms);
  };

  return {
    async send(content) {
      const waitMs = waitBeforeNextMs;
      waitBeforeNextMs = 0;
      await waitIfNeeded(waitMs);

      let result = await attempt(fetchFn, webhookUrl, content, timeoutMs);
      if (result.failure !== null) {
        if (result.response?.status === 429) {
          await waitIfNeeded(
            waitFromHeaders(result.response, 'Retry-After', 'X-RateLimit-Reset-After'),
          );
        }
        result = await attempt(fetchFn, webhookUrl, content, timeoutMs);
      }

      if (result.failure === null) {
        if (result.response.headers.get('X-RateLimit-Remaining')?.trim() === '0') {
          waitBeforeNextMs = waitFromHeaders(result.response, 'X-RateLimit-Reset-After');
        }
        return true;
      }
      console.error(
        `Discord への送信に失敗しました（理由: ${result.failure}）。この通知は届きません`,
      );
      return false;
    },
  };
}
