import { afterEach, beforeEach, describe, expect, it, vi, type MockInstance } from 'vitest';
import {
  MAX_RATE_LIMIT_WAIT_MS,
  createDiscordSender,
  type DiscordFetch,
  type Sleep,
} from './discord';

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
/** 決めたヘッダーを持つ応答。レート制限のヘッダーを付けるのに使う。 */
const withHeaders = (status: number, headers: Record<string, string>) =>
  new Response(status === 204 ? null : '{"message":"error"}', { status, headers });

/** 待ちを記録するだけで、実際には待たない sleep。 */
function recordingSleep() {
  const waits: number[] = [];
  const sleep: Sleep = (ms) => {
    waits.push(ms);
    return Promise.resolve();
  };
  return { sleep, waits };
}

/** 送り手を作って、1 回投稿する。 */
function post(
  content: string,
  fetchFn: DiscordFetch,
  options: { timeoutMs?: number; sleep?: Sleep } = {},
): Promise<boolean> {
  return createDiscordSender({ webhookUrl: WEBHOOK_URL, fetchFn, ...options }).send(content);
}

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

    await post('🔔 10分後: 歯医者', fetchFn);

    expect(fetchFn).toHaveBeenCalledTimes(1);
    const [url, init] = fetchFn.mock.calls[0] ?? [];
    expect(url).toBe(WEBHOOK_URL);
    expect(init?.method).toBe('POST');
    expect(init?.headers).toEqual({ 'Content-Type': 'application/json' });
    expect(typeof init?.body).toBe('string');
    expect(JSON.parse(typeof init?.body === 'string' ? init.body : 'null')).toMatchObject({
      content: '🔔 10分後: 歯医者',
      allowed_mentions: { parse: [] },
    });
  });

  it('リンクの埋め込み（カード）を付けさせない（flags: 4 = SUPPRESS_EMBEDS）', async () => {
    const fetchFn = fetchReturning(ok());

    await post('x', fetchFn);

    const init = fetchFn.mock.calls[0]?.[1];
    expect(JSON.parse(typeof init?.body === 'string' ? init.body : 'null')).toMatchObject({
      flags: 4,
    });
  });

  it('2xx なら、true を返し、再送しない（204 も 200 も成功）', async () => {
    const no = fetchReturning(ok());
    const withBody = fetchReturning(new Response('{}', { status: 200 }));

    expect(await post('x', no)).toBe(true);
    expect(await post('x', withBody)).toBe(true);
    expect(no).toHaveBeenCalledTimes(1);
    expect(withBody).toHaveBeenCalledTimes(1);
    expect(consoleError).not.toHaveBeenCalled();
  });

  it('2xx 以外なら、その場で 1 回だけ再送する。2 回目が成功なら、true', async () => {
    const fetchFn = fetchReturning(failed(500), ok());

    expect(await post('x', fetchFn)).toBe(true);
    expect(fetchFn).toHaveBeenCalledTimes(2);
    expect(consoleError).not.toHaveBeenCalled();
  });

  it('通信の例外（ネットワークの失敗）でも、その場で 1 回だけ再送する', async () => {
    const fetchFn = fetchReturning(new TypeError('Network connection lost.'), ok());

    expect(await post('x', fetchFn)).toBe(true);
    expect(fetchFn).toHaveBeenCalledTimes(2);
  });

  it('再送も失敗したら、false を返し、ログに残して終わる。3 回目は送らない', async () => {
    const fetchFn = fetchReturning(failed(429), failed(429));

    expect(await post('x', fetchFn)).toBe(false);
    expect(fetchFn).toHaveBeenCalledTimes(2);
    expect(consoleError).toHaveBeenCalledTimes(1);
    expect(loggedText()).toContain('HTTP 429');
  });

  it('1 回目が 2xx 以外で、2 回目が通信の例外のときも、false を返す（例外を投げない）', async () => {
    const fetchFn = fetchReturning(failed(500), new TypeError('Network connection lost.'));

    expect(await post('x', fetchFn)).toBe(false);
    expect(loggedText()).toContain('TypeError');
  });

  it('3xx も、成功とは数えない（2xx だけが成功）', async () => {
    const fetchFn = fetchReturning(
      new Response(null, { status: 302 }),
      new Response(null, { status: 302 }),
    );

    expect(await post('x', fetchFn)).toBe(false);
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

    const result = await post('x', fetchFn, { timeoutMs: 20 });

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

    await post('x', fetchFn);

    expect(signals).toHaveLength(2);
    expect(signals[0]).not.toBe(signals[1]);
    expect(signals[1]?.aborted).toBe(false);
  });

  it('既定の待ちの上限は 10 秒', async () => {
    const spy = vi.spyOn(AbortSignal, 'timeout');
    const fetchFn = fetchReturning(ok());

    await post('x', fetchFn);

    expect(spy).toHaveBeenCalledWith(10_000);
  });
});

describe('レート制限（429。Webhook は、短い時間に 5 回ほどしか投稿できない）', () => {
  it('429 のときは、Retry-After の秒数だけ待って、1 回だけ再送する', async () => {
    const fetchFn = fetchReturning(withHeaders(429, { 'Retry-After': '2' }), ok());
    const { sleep, waits } = recordingSleep();

    expect(await post('x', fetchFn, { sleep })).toBe(true);

    expect(fetchFn).toHaveBeenCalledTimes(2);
    expect(waits).toEqual([2000]);
    expect(consoleError).not.toHaveBeenCalled();
  });

  it('Retry-After が小数でも、その秒数だけ待つ', async () => {
    const fetchFn = fetchReturning(withHeaders(429, { 'Retry-After': '0.75' }), ok());
    const { sleep, waits } = recordingSleep();

    await post('x', fetchFn, { sleep });

    expect(waits).toEqual([750]);
  });

  it('Retry-After がなければ、X-RateLimit-Reset-After の秒数だけ待つ', async () => {
    const fetchFn = fetchReturning(withHeaders(429, { 'X-RateLimit-Reset-After': '1.5' }), ok());
    const { sleep, waits } = recordingSleep();

    await post('x', fetchFn, { sleep });

    expect(waits).toEqual([1500]);
  });

  it('両方あれば、Retry-After を使う', async () => {
    const fetchFn = fetchReturning(
      withHeaders(429, { 'Retry-After': '1', 'X-RateLimit-Reset-After': '3' }),
      ok(),
    );
    const { sleep, waits } = recordingSleep();

    await post('x', fetchFn, { sleep });

    expect(waits).toEqual([1000]);
  });

  it('待つ秒数が大きくても、5 秒で打ち切る', async () => {
    const fetchFn = fetchReturning(withHeaders(429, { 'Retry-After': '60' }), ok());
    const { sleep, waits } = recordingSleep();

    await post('x', fetchFn, { sleep });

    expect(MAX_RATE_LIMIT_WAIT_MS).toBe(5000);
    expect(waits).toEqual([5000]);
  });

  it('どちらのヘッダーもなければ、待たずに再送する（これまでどおり）', async () => {
    const fetchFn = fetchReturning(failed(429), ok());
    const { sleep, waits } = recordingSleep();

    expect(await post('x', fetchFn, { sleep })).toBe(true);

    expect(fetchFn).toHaveBeenCalledTimes(2);
    expect(waits).toEqual([]);
  });

  it('秒数として読めない値・負の値は、使わない（次のヘッダーを見る）', async () => {
    const fetchFn = fetchReturning(
      withHeaders(429, {
        'Retry-After': 'Wed, 21 Oct 2026 07:28:00 GMT',
        'X-RateLimit-Reset-After': '2',
      }),
      withHeaders(429, { 'Retry-After': '-1' }),
    );
    const { sleep, waits } = recordingSleep();

    await post('x', fetchFn, { sleep });

    expect(waits).toEqual([2000]);
  });

  it('再送も 429 なら、false を返す。待つのは 1 回だけで、3 回目は送らない', async () => {
    const fetchFn = fetchReturning(
      withHeaders(429, { 'Retry-After': '1' }),
      withHeaders(429, { 'Retry-After': '1' }),
    );
    const { sleep, waits } = recordingSleep();

    expect(await post('x', fetchFn, { sleep })).toBe(false);

    expect(fetchFn).toHaveBeenCalledTimes(2);
    expect(waits).toEqual([1000]);
    expect(loggedText()).toContain('HTTP 429');
  });

  it('429 以外の失敗は、Retry-After があっても、待たずに再送する', async () => {
    const fetchFn = fetchReturning(withHeaders(500, { 'Retry-After': '3' }), ok());
    const { sleep, waits } = recordingSleep();

    await post('x', fetchFn, { sleep });

    expect(waits).toEqual([]);
  });

  it('通信の例外のあとも、待たずに再送する', async () => {
    const fetchFn = fetchReturning(new TypeError('Network connection lost.'), ok());
    const { sleep, waits } = recordingSleep();

    await post('x', fetchFn, { sleep });

    expect(waits).toEqual([]);
  });

  it('2xx で X-RateLimit-Remaining が 0 なら、次の投稿の前に、X-RateLimit-Reset-After の秒数だけ待つ', async () => {
    const events: string[] = [];
    const responses = [
      withHeaders(204, { 'X-RateLimit-Remaining': '0', 'X-RateLimit-Reset-After': '0.8' }),
      ok(),
    ];
    const fetchFn = vi.fn<DiscordFetch>(() => {
      events.push('投稿');
      return Promise.resolve(responses.shift() ?? ok());
    });
    const sender = createDiscordSender({
      webhookUrl: WEBHOOK_URL,
      fetchFn,
      sleep: (ms) => {
        events.push(`待つ ${String(ms)}`);
        return Promise.resolve();
      },
    });

    await sender.send('1 件目');
    await sender.send('2 件目');
    await sender.send('3 件目');

    // 待つのは、2 件目の前だけ。1 件目の前と、3 件目の前（2 件目の応答に、Remaining がない）では、待たない。
    expect(events).toEqual(['投稿', '待つ 800', '投稿', '投稿']);
  });

  it('待つ秒数が大きくても、5 秒で打ち切る', async () => {
    const fetchFn = fetchReturning(
      withHeaders(204, { 'X-RateLimit-Remaining': '0', 'X-RateLimit-Reset-After': '60' }),
      ok(),
    );
    const { sleep, waits } = recordingSleep();
    const sender = createDiscordSender({ webhookUrl: WEBHOOK_URL, fetchFn, sleep });

    await sender.send('1 件目');
    await sender.send('2 件目');

    expect(waits).toEqual([5000]);
  });

  it('X-RateLimit-Remaining が 1 以上なら、待たない', async () => {
    const fetchFn = fetchReturning(
      withHeaders(204, { 'X-RateLimit-Remaining': '1', 'X-RateLimit-Reset-After': '2' }),
      ok(),
    );
    const { sleep, waits } = recordingSleep();
    const sender = createDiscordSender({ webhookUrl: WEBHOOK_URL, fetchFn, sleep });

    await sender.send('1 件目');
    await sender.send('2 件目');

    expect(waits).toEqual([]);
  });

  it('X-RateLimit-Remaining が 0 でも、X-RateLimit-Reset-After がなければ、待たない', async () => {
    const fetchFn = fetchReturning(withHeaders(204, { 'X-RateLimit-Remaining': '0' }), ok());
    const { sleep, waits } = recordingSleep();
    const sender = createDiscordSender({ webhookUrl: WEBHOOK_URL, fetchFn, sleep });

    await sender.send('1 件目');
    await sender.send('2 件目');

    expect(waits).toEqual([]);
  });

  it('再送が成功したときも、その応答の Remaining が 0 なら、次の投稿の前に待つ', async () => {
    const fetchFn = fetchReturning(
      failed(500),
      withHeaders(204, { 'X-RateLimit-Remaining': '0', 'X-RateLimit-Reset-After': '1' }),
      ok(),
    );
    const { sleep, waits } = recordingSleep();
    const sender = createDiscordSender({ webhookUrl: WEBHOOK_URL, fetchFn, sleep });

    await sender.send('1 件目');
    await sender.send('2 件目');

    expect(waits).toEqual([1000]);
  });

  it('ヘッダーだけを見て、応答の本文は読まない', async () => {
    const limited = withHeaders(429, { 'Retry-After': '1' });
    const succeeded = withHeaders(204, { 'X-RateLimit-Remaining': '0' });
    const reads = [limited, succeeded].flatMap((response) => [
      vi.spyOn(response, 'text'),
      vi.spyOn(response, 'json'),
      vi.spyOn(response, 'arrayBuffer'),
    ]);

    await post('x', fetchReturning(limited, succeeded), { sleep: recordingSleep().sleep });

    reads.forEach((read) => {
      expect(read).not.toHaveBeenCalled();
    });
  });
});

describe('Webhook の URL は、ログに出さない（知っていれば誰でも、そのチャンネルに投稿できるため）', () => {
  it('例外のメッセージに URL が入っていても、ログに出ない', async () => {
    const fetchFn = fetchReturning(
      new TypeError(`Failed to fetch ${WEBHOOK_URL}`),
      new TypeError(`Failed to fetch ${WEBHOOK_URL}`),
    );

    await post('x', fetchFn);

    expect(consoleError).toHaveBeenCalled();
    expect(loggedText()).not.toContain('secret-token');
    expect(loggedText()).not.toContain('discord.example');
  });

  it('2xx 以外の応答でも、ログに URL や応答の本文は出ない', async () => {
    const fetchFn = fetchReturning(failed(401), failed(401));

    await post('x', fetchFn);

    expect(loggedText()).not.toContain('secret-token');
    expect(loggedText()).not.toContain('"message"');
  });
});
