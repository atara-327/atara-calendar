import { afterEach, beforeEach, describe, expect, it, vi, type MockInstance } from 'vitest';
import { postToDiscord, type DiscordFetch } from './discord';

// 本物の Webhook の URL ではない。テストの値。
const WEBHOOK_URL = 'https://discord.example/api/webhooks/123456/secret-token';

let consoleError: MockInstance<typeof console.error>;

beforeEach(() => {
  consoleError = vi.spyOn(console, 'error').mockImplementation(() => undefined);
});

afterEach(() => {
  vi.restoreAllMocks();
});

/** 呼ばれた順に、決めた応答を返す fetch。応答が足りなくなったら、テストの誤りなので、例外にする。 */
function fetchReturning(...outcomes: (Response | Error)[]) {
  const queue = [...outcomes];
  return vi.fn<DiscordFetch>(() => {
    const outcome = queue.shift();
    if (outcome === undefined) throw new Error('fetch が、決めた回数より多く呼ばれました');
    return outcome instanceof Error ? Promise.reject(outcome) : Promise.resolve(outcome);
  });
}

const ok = () => new Response(null, { status: 204 });
const failed = (status: number) => new Response('{"message":"error"}', { status });

/** console.error に渡された引数のすべてを、1 つの文字列にする。URL が混ざっていないかを調べるため。 */
function loggedText(): string {
  return consoleError.mock.calls
    .flat()
    .map((arg: unknown) => (arg instanceof Error ? `${arg.name} ${arg.message}` : String(arg)))
    .join('\n');
}

describe('NT-1: Discord への送信', () => {
  it('Webhook の URL に、JSON で POST する。content と、メンションを無効にする allowed_mentions を送る', async () => {
    const fetchFn = fetchReturning(ok());

    await postToDiscord({ webhookUrl: WEBHOOK_URL, content: '🔔 10分後: 歯医者', fetchFn });

    expect(fetchFn).toHaveBeenCalledTimes(1);
    const [url, init] = fetchFn.mock.calls[0] ?? [];
    expect(url).toBe(WEBHOOK_URL);
    expect(init?.method).toBe('POST');
    expect(init?.headers).toEqual({ 'Content-Type': 'application/json' });
    expect(typeof init?.body).toBe('string');
    expect(JSON.parse(typeof init?.body === 'string' ? init.body : 'null')).toEqual({
      content: '🔔 10分後: 歯医者',
      allowed_mentions: { parse: [] },
    });
  });

  it('2xx なら、true を返し、再送しない（204 も 200 も成功）', async () => {
    const no = fetchReturning(ok());
    const withBody = fetchReturning(new Response('{}', { status: 200 }));

    expect(await postToDiscord({ webhookUrl: WEBHOOK_URL, content: 'x', fetchFn: no })).toBe(true);
    expect(await postToDiscord({ webhookUrl: WEBHOOK_URL, content: 'x', fetchFn: withBody })).toBe(
      true,
    );
    expect(no).toHaveBeenCalledTimes(1);
    expect(withBody).toHaveBeenCalledTimes(1);
    expect(consoleError).not.toHaveBeenCalled();
  });

  it('2xx 以外なら、その場で 1 回だけ再送する。2 回目が成功なら、true', async () => {
    const fetchFn = fetchReturning(failed(500), ok());

    expect(await postToDiscord({ webhookUrl: WEBHOOK_URL, content: 'x', fetchFn })).toBe(true);
    expect(fetchFn).toHaveBeenCalledTimes(2);
    expect(consoleError).not.toHaveBeenCalled();
  });

  it('通信の例外（ネットワークの失敗）でも、その場で 1 回だけ再送する', async () => {
    const fetchFn = fetchReturning(new TypeError('Network connection lost.'), ok());

    expect(await postToDiscord({ webhookUrl: WEBHOOK_URL, content: 'x', fetchFn })).toBe(true);
    expect(fetchFn).toHaveBeenCalledTimes(2);
  });

  it('再送も失敗したら、false を返し、ログに残して終わる。3 回目は送らない', async () => {
    const fetchFn = fetchReturning(failed(429), failed(429));

    expect(await postToDiscord({ webhookUrl: WEBHOOK_URL, content: 'x', fetchFn })).toBe(false);
    expect(fetchFn).toHaveBeenCalledTimes(2);
    expect(consoleError).toHaveBeenCalledTimes(1);
    expect(loggedText()).toContain('HTTP 429');
  });

  it('1 回目が 2xx 以外で、2 回目が通信の例外のときも、false を返す（例外を投げない）', async () => {
    const fetchFn = fetchReturning(failed(500), new TypeError('Network connection lost.'));

    expect(await postToDiscord({ webhookUrl: WEBHOOK_URL, content: 'x', fetchFn })).toBe(false);
    expect(loggedText()).toContain('TypeError');
  });

  it('3xx も、成功とは数えない（2xx だけが成功）', async () => {
    const fetchFn = fetchReturning(
      new Response(null, { status: 302 }),
      new Response(null, { status: 302 }),
    );

    expect(await postToDiscord({ webhookUrl: WEBHOOK_URL, content: 'x', fetchFn })).toBe(false);
  });

  it('1 回の待ちには上限がある。上限を過ぎたら、失敗として扱い、再送する', async () => {
    // 応答を返さず、待ちの上限（signal）が来たら、その理由で失敗する fetch。
    const fetchFn = vi.fn<DiscordFetch>(
      (_url, init) =>
        new Promise<Response>((_resolve, reject) => {
          init.signal?.addEventListener('abort', () => {
            const reason: unknown = init.signal?.reason;
            reject(reason instanceof Error ? reason : new Error('待ちの上限'));
          });
        }),
    );

    const result = await postToDiscord({
      webhookUrl: WEBHOOK_URL,
      content: 'x',
      fetchFn,
      timeoutMs: 20,
    });

    expect(result).toBe(false);
    expect(fetchFn).toHaveBeenCalledTimes(2);
    expect(loggedText()).toContain('TimeoutError');
  });

  it('待ちの上限は、1 回ごとに数え直す（再送が、すでに過ぎた上限で、すぐ失敗しない）', async () => {
    const signals: AbortSignal[] = [];
    const fetchFn = vi.fn<DiscordFetch>((_url, init) => {
      if (init.signal !== undefined && init.signal !== null) signals.push(init.signal);
      return Promise.resolve(signals.length === 1 ? failed(500) : ok());
    });

    await postToDiscord({ webhookUrl: WEBHOOK_URL, content: 'x', fetchFn });

    expect(signals).toHaveLength(2);
    expect(signals[0]).not.toBe(signals[1]);
    expect(signals[1]?.aborted).toBe(false);
  });

  it('既定の待ちの上限は 10 秒', async () => {
    const spy = vi.spyOn(AbortSignal, 'timeout');
    const fetchFn = fetchReturning(ok());

    await postToDiscord({ webhookUrl: WEBHOOK_URL, content: 'x', fetchFn });

    expect(spy).toHaveBeenCalledWith(10_000);
  });
});

describe('Webhook の URL は、ログに出さない（知っていれば誰でも、そのチャンネルに投稿できるため）', () => {
  it('例外のメッセージに URL が入っていても、ログに出ない', async () => {
    const fetchFn = fetchReturning(
      new TypeError(`Failed to fetch ${WEBHOOK_URL}`),
      new TypeError(`Failed to fetch ${WEBHOOK_URL}`),
    );

    await postToDiscord({ webhookUrl: WEBHOOK_URL, content: 'x', fetchFn });

    expect(consoleError).toHaveBeenCalled();
    expect(loggedText()).not.toContain('secret-token');
    expect(loggedText()).not.toContain('discord.example');
  });

  it('2xx 以外の応答でも、ログに URL や応答の本文は出ない', async () => {
    const fetchFn = fetchReturning(failed(401), failed(401));

    await postToDiscord({ webhookUrl: WEBHOOK_URL, content: 'x', fetchFn });

    expect(loggedText()).not.toContain('secret-token');
    expect(loggedText()).not.toContain('"message"');
  });
});
