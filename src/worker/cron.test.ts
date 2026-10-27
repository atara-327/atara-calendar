import {
  afterAll,
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  vi,
  type MockInstance,
} from 'vitest';
import type { Entry } from '../shared/schema';
import {
  createTestDatabase,
  removeDefaultWorkspace,
  type TestDatabase,
} from '../../test/helpers/d1';
import { TEST_APP_ORIGIN } from '../../test/helpers/env';
import { makeEntry } from '../../test/helpers/entries';
import { readNextNotifyAt } from '../../test/helpers/rows';
import { jst } from '../../test/helpers/time';
import {
  MAX_DUE_ENTRIES_PER_RUN,
  RUN_TIME_LIMIT_MS,
  scheduled,
  sendDueNotifications,
} from './cron';
import { applyWrite, readSeriesEntries } from './db/store';
import type { Bindings } from './env';
import type { DiscordFetch } from './notify/discord';

// 条件付きの UPDATE の確認で、系列を読んだあと、UPDATE の前に、別の書き込みを割り込ませるため、
// readSeriesEntries だけ差し替えられるようにする。差し替えない限り、本物をそのまま呼ぶ。
vi.mock('./db/store', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./db/store')>();
  return { ...actual, readSeriesEntries: vi.fn(actual.readSeriesEntries) };
});

// 本物の Webhook の URL ではない。テストの値。
const WEBHOOK_URL = 'https://discord.example/api/webhooks/123456/secret-token';

let testDatabase: TestDatabase;
let consoleError: MockInstance<typeof console.error>;
let consoleWarn: MockInstance<typeof console.warn>;
let consoleLog: MockInstance<typeof console.log>;

beforeAll(async () => {
  testDatabase = await createTestDatabase();
});

afterAll(async () => {
  await testDatabase.dispose();
});

// 予定の行が使う外部キーの相手を、rev 0 の行として入れる。
// w1: 表示 ON。off: 表示 OFF（Q1）。gone: 削除済み。
beforeEach(async () => {
  await testDatabase.reset();
  await removeDefaultWorkspace(testDatabase.db);
  await testDatabase.db.batch([
    testDatabase.db.prepare(
      `INSERT INTO workspaces (id, name, color, sort_order, visible, builtin, edited_at, rev, deleted_at)
       VALUES ('w1', '仕事', '#4285F4', 0, 1, NULL, 0, 0, NULL),
              ('off', '趣味', '#34A853', 1, 0, NULL, 0, 0, NULL),
              ('gone', '消した', '#EA4335', 2, 1, NULL, 0, 0, 5000)`,
    ),
  ]);
  consoleError = vi.spyOn(console, 'error').mockImplementation(() => undefined);
  consoleWarn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
  consoleLog = vi.spyOn(console, 'log').mockImplementation(() => undefined);
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

function db(): D1Database {
  return testDatabase.db;
}

/** 日付は、2026-10-27（火）。保存するのは、その日の朝 9 時。 */
const TODAY = '2026-10-27';
const SAVED_AT = jst(TODAY, '09:00');
/** 15:00 の予定の、10 分前の通知の時刻（定期実行が、時刻が来た行を見つける時刻）。 */
const NOTIFY_AT = jst(TODAY, '14:50');
const MINUTE = 60_000;

/** 時間指定の予定（15:00〜16:00、10 分前に通知）。繰り返さない。 */
function timed(overrides: Partial<Entry> & Pick<Entry, 'id'>): Entry {
  return makeEntry({
    allDay: false,
    startDate: TODAY,
    startTime: '15:00',
    endTime: '16:00',
    notifyOffsetMin: 10,
    ...overrides,
  });
}

/** 系列 's' の、例外の行。 */
function exception(overrides: Partial<Entry> & Pick<Entry, 'id' | 'originalDate'>): Entry {
  return timed({ seriesId: 's', ...overrides });
}

/** 毎日 15:00 の系列 's'。 */
function dailySeries(overrides: Partial<Entry> = {}): Entry {
  return timed({ id: 's', rrule: { freq: 'daily' }, startDate: '2026-10-19', ...overrides });
}

/** 行を保存する（保存したときの計算で、next_notify_at が入る）。 */
function save(entries: Entry[], nowMs = SAVED_AT) {
  return applyWrite(db(), { entries }, { nowMs });
}

/** 送った内容の記録と、偽の fetch。respond で、呼ばれた回（1 から）ごとの応答を決められる。 */
function fakeDiscord(
  respond: (call: number) => Response | Error = () => new Response(null, { status: 204 }),
) {
  const calls: { url: string; body: unknown }[] = [];
  const fetchFn = vi.fn<DiscordFetch>((url, init) => {
    calls.push({ url, body: typeof init.body === 'string' ? JSON.parse(init.body) : null });
    const outcome = respond(calls.length);
    return outcome instanceof Error ? Promise.reject(outcome) : Promise.resolve(outcome);
  });
  // レート制限で待つ時間の記録。実際には待たない。
  const waits: number[] = [];
  const sleep = (ms: number) => {
    waits.push(ms);
    return Promise.resolve();
  };
  return {
    fetchFn,
    sleep,
    waits,
    calls,
    /** 送った content（再送を含む）。 */
    contents: () => calls.map(({ body }) => (body as { content: string }).content),
  };
}

function envOf(overrides: Partial<Bindings> = {}): Bindings {
  return {
    DB: db(),
    ACCESS_TEAM_DOMAIN: '',
    ACCESS_AUD: '',
    APP_ORIGIN: TEST_APP_ORIGIN,
    DISCORD_WEBHOOK_URL: WEBHOOK_URL,
    ...overrides,
  };
}

/** 時刻 nowMs の定期実行を、偽の Discord に向けて動かす。 */
async function run(nowMs: number, discord = fakeDiscord(), overrides: Partial<Bindings> = {}) {
  await sendDueNotifications(envOf(overrides), nowMs, {
    fetchFn: discord.fetchFn,
    sleep: discord.sleep,
  });
  return discord;
}

/** console に出された内容のすべて。Webhook の URL が混ざっていないかを調べるため。 */
function everythingLogged(): string {
  return [consoleError, consoleWarn, consoleLog]
    .flatMap((spy) => spy.mock.calls)
    .flat()
    .map((arg: unknown) => (arg instanceof Error ? `${arg.name}: ${arg.message}` : String(arg)))
    .join('\n');
}

describe('NT-1・NT-5: 時刻が来た通知を、Discord に送る', () => {
  it('通知の時刻が来た予定を、Webhook の URL に送る', async () => {
    await save([
      timed({
        id: 'a',
        title: '歯医者',
        location: '○○歯科',
        endTime: '16:00',
      }),
    ]);

    const discord = await run(NOTIFY_AT);

    expect(discord.calls).toHaveLength(1);
    expect(discord.calls[0]?.url).toBe(WEBHOOK_URL);
    expect(discord.contents()).toEqual([
      [
        '🔔 10分後: 歯医者',
        '10/27（火）15:00〜16:00',
        '📍 ○○歯科',
        `${TEST_APP_ORIGIN}/day/2026-10-27`,
      ].join('\n'),
    ]);
  });

  it('通知の時刻が、ちょうど今の行も、送る（今以前が対象）', async () => {
    await save([timed({ id: 'a' })]);

    expect((await run(NOTIFY_AT)).calls).toHaveLength(1);
  });

  it('通知の時刻が、まだ来ていない行は、送らず、触らない', async () => {
    await save([timed({ id: 'a' })]);

    const discord = await run(NOTIFY_AT - 1);

    expect(discord.calls).toHaveLength(0);
    expect(await readNextNotifyAt(db())).toEqual({ a: NOTIFY_AT });
  });

  it('時刻が来た行が、1 つもなければ、何も送らない', async () => {
    const discord = await run(NOTIFY_AT);

    expect(discord.calls).toHaveLength(0);
    expect(consoleError).not.toHaveBeenCalled();
  });

  it('終日の予定は、当日の朝 6 時に、「今日」で送る', async () => {
    await save([
      makeEntry({
        id: 'a',
        title: '帰省',
        allDay: true,
        startDate: '2026-10-28',
        endDate: '2026-10-30',
        notifyOffsetMin: -360,
      }),
    ]);

    const discord = await run(jst('2026-10-28', '06:00'));

    expect(discord.contents()).toEqual([
      ['🔔 今日: 帰省（10/28〜10/30）', `${TEST_APP_ORIGIN}/day/2026-10-28`].join('\n'),
    ]);
  });

  it('メンションを無効にする allowed_mentions を付けて送る（題名に @everyone があっても、全員への通知にならない）', async () => {
    await save([timed({ id: 'a', title: '@everyone 集合' })]);

    const discord = await run(NOTIFY_AT);

    expect(discord.calls[0]?.body).toMatchObject({ allowed_mentions: { parse: [] } });
    expect(discord.contents()[0]).toContain('@everyone 集合');
  });

  it('1 回の実行で、時刻が来た行を、すべて送る', async () => {
    await save([
      timed({ id: 'a', title: 'A' }),
      // 15:15 開始の 25 分前も、14:50。
      timed({ id: 'b', title: 'B', startTime: '15:15', endTime: '15:45', notifyOffsetMin: 25 }),
    ]);

    const discord = await run(NOTIFY_AT);

    expect(discord.contents().map((content) => content.split('\n')[0])).toEqual(
      expect.arrayContaining(['🔔 10分後: A', '🔔 25分後: B']),
    );
    expect(discord.calls).toHaveLength(2);
  });

  it('タイムブロックも送る（NT-4 で通知を ON にしたときだけ、値が入っている）', async () => {
    await save([
      timed({ id: 'b', kind: 'block', workspaceId: null, title: '仕事', notifyEnabled: true }),
      timed({ id: 'off', kind: 'block', workspaceId: null, title: '休憩', notifyEnabled: false }),
    ]);

    const discord = await run(NOTIFY_AT);

    expect(discord.contents().map((content) => content.split('\n')[0])).toEqual([
      '🔔 10分後: 仕事',
    ]);
  });

  it('文面の URL の頭は、設定（APP_ORIGIN）から取る', async () => {
    await save([timed({ id: 'a' })]);

    const discord = await run(NOTIFY_AT, fakeDiscord(), { APP_ORIGIN: 'http://localhost:5173' });

    expect(discord.contents()[0]).toMatch(/\nhttp:\/\/localhost:5173\/day\/2026-10-27$/);
  });
});

describe('送ったら、次の回の時刻に進める', () => {
  it('繰り返さない予定は、送ったら NULL になる（探されなくなる）', async () => {
    await save([timed({ id: 'a' })]);

    await run(NOTIFY_AT);

    expect(await readNextNotifyAt(db())).toEqual({ a: null });
  });

  it('繰り返しの系列は、送ったら、次の回の通知の時刻になる', async () => {
    await save([dailySeries()]);

    await run(NOTIFY_AT);

    expect(await readNextNotifyAt(db())).toEqual({ s: jst('2026-10-28', '14:50') });
  });

  it('先に next_notify_at を進めてから、送る（送る時点で、DB の値は、もう次の回になっている）', async () => {
    await save([dailySeries()]);
    const discord = fakeDiscord((call) =>
      call === 1 ? new Response(null, { status: 500 }) : new Response(null, { status: 204 }),
    );
    const seenWhenSending: (number | null | undefined)[] = [];
    const fetchFn: DiscordFetch = async (url, init) => {
      seenWhenSending.push((await readNextNotifyAt(db()))['s']);
      return discord.fetchFn(url, init);
    };

    await sendDueNotifications(envOf(), NOTIFY_AT, { fetchFn, sleep: discord.sleep });

    // 1 回目の送信も、失敗した再送も、値は、すでに明日の回。
    expect(seenWhenSending).toEqual([jst('2026-10-28', '14:50'), jst('2026-10-28', '14:50')]);
  });

  it('送った次の分の実行では、同じ回を、もう送らない', async () => {
    await save([dailySeries()]);
    await run(NOTIFY_AT);

    const discord = await run(NOTIFY_AT + MINUTE);

    expect(discord.calls).toHaveLength(0);
  });

  it('例外の行は、送ったら NULL になる。系列の行は、例外で移した回を飛ばした次になる', async () => {
    await save([
      dailySeries(),
      // 今日の回を、明日の 16:00 に移した。
      exception({
        id: 'x',
        originalDate: TODAY,
        startDate: '2026-10-28',
        startTime: '16:00',
        endTime: '17:00',
      }),
    ]);
    // 今日の回は、例外で移したので、系列の行は、明日の 14:50 まで通知しない。
    expect(await readNextNotifyAt(db())).toEqual({
      s: jst('2026-10-28', '14:50'),
      x: jst('2026-10-28', '15:50'),
    });

    await run(jst('2026-10-28', '14:50'));
    expect(await readNextNotifyAt(db())).toEqual({
      s: jst('2026-10-29', '14:50'),
      x: jst('2026-10-28', '15:50'),
    });

    const discord = await run(jst('2026-10-28', '15:50'));
    expect(discord.contents()[0]).toContain('10/28（水）16:00〜17:00');
    expect(await readNextNotifyAt(db())).toEqual({
      s: jst('2026-10-29', '14:50'),
      x: null,
    });
  });

  it('後ろを切った系列の最後の回を送ったら、NULL になる', async () => {
    await save([dailySeries({ untilDate: TODAY })]);

    await run(NOTIFY_AT);

    expect(await readNextNotifyAt(db())).toEqual({ s: null });
  });

  it('rev は変えない（next_notify_at は、端末に送らない列のため）', async () => {
    await save([timed({ id: 'a' })]);
    const before = await db().batch([
      db().prepare('SELECT rev FROM meta'),
      db().prepare("SELECT rev, edited_at FROM entries WHERE id = 'a'"),
    ]);

    await run(NOTIFY_AT);

    const after = await db().batch([
      db().prepare('SELECT rev FROM meta'),
      db().prepare("SELECT rev, edited_at FROM entries WHERE id = 'a'"),
    ]);
    expect(after.map(({ results }) => results)).toEqual(before.map(({ results }) => results));
  });

  it('同じ系列の、系列の行と例外の行が、同じ時刻に来たら、両方を送る', async () => {
    await save([
      dailySeries(),
      // 明日の回を、今日の 15:00 に移した（今日の系列の回と、同じ時刻）。
      exception({
        id: 'x',
        originalDate: '2026-10-28',
        startDate: TODAY,
        title: '前倒し',
      }),
    ]);

    const discord = await run(NOTIFY_AT);

    expect(discord.contents().map((content) => content.split('\n')[0])).toEqual(
      expect.arrayContaining(['🔔 10分後: ジム', '🔔 10分後: 前倒し']),
    );
    expect(discord.calls).toHaveLength(2);
  });
});

describe('Q10: 10 分以上遅れた通知は、送らずに次の回へ進める', () => {
  it('10 分より 1 ミリ秒短い遅れなら、送る', async () => {
    await save([dailySeries()]);

    const discord = await run(NOTIFY_AT + 10 * MINUTE - 1);

    expect(discord.calls).toHaveLength(1);
  });

  it('ちょうど 10 分遅れたら、送らず、次の回に進める', async () => {
    await save([dailySeries()]);

    const discord = await run(NOTIFY_AT + 10 * MINUTE);

    expect(discord.calls).toHaveLength(0);
    expect(await readNextNotifyAt(db())).toEqual({ s: jst('2026-10-28', '14:50') });
  });

  it('繰り返さない予定が遅れたら、送らず、NULL にする', async () => {
    await save([timed({ id: 'a' })]);

    const discord = await run(NOTIFY_AT + 30 * MINUTE);

    expect(discord.calls).toHaveLength(0);
    expect(await readNextNotifyAt(db())).toEqual({ a: null });
  });

  it('何日も止まっていたら、1 回の実行で、遅れていない最初の回まで進める（続けて飛ばす）', async () => {
    // 10/24 の朝に保存したので、値は 10/24 14:50。定期実行が、10/27 15:00 まで止まっていた。
    await save([dailySeries()], jst('2026-10-24', '09:00'));
    expect(await readNextNotifyAt(db())).toEqual({ s: jst('2026-10-24', '14:50') });

    const discord = await run(jst(TODAY, '15:00'));

    expect(discord.calls).toHaveLength(0);
    expect(await readNextNotifyAt(db())).toEqual({ s: jst('2026-10-28', '14:50') });
  });

  it('止まっていたあとで、直前（10 分以内）の回があれば、そこまで進めて、次の分に送る', async () => {
    await save([dailySeries()], jst('2026-10-24', '09:00'));

    // 今日の 14:50 の回は、5 分の遅れ。遅れた古い回（10/24〜26）は、飛ばす。
    const first = await run(jst(TODAY, '14:55'));
    expect(first.calls).toHaveLength(0);
    expect(await readNextNotifyAt(db())).toEqual({ s: jst(TODAY, '14:50') });

    const second = await run(jst(TODAY, '14:56'));
    expect(second.calls).toHaveLength(1);
    expect(await readNextNotifyAt(db())).toEqual({ s: jst('2026-10-28', '14:50') });
  });
});

describe('送る前に、その回が、まだその行の回かを確かめる（割り込みで、古い値が残ったとき）', () => {
  it('系列の時刻を変えたあとに、古い通知の時刻が残っていたら、送らず、今の展開で計算し直した値にする', async () => {
    await save([dailySeries()]);
    // 別の端末が、系列の時刻を 16:00 に変えた。この行の next_notify_at は、古い 14:50 のまま。
    await db()
      .prepare("UPDATE entries SET start_time = '16:00', end_time = '17:00' WHERE id = 's'")
      .run();

    const discord = await run(NOTIFY_AT);

    expect(discord.calls).toHaveLength(0);
    expect(await readNextNotifyAt(db())).toEqual({ s: jst(TODAY, '15:50') });
  });

  it('残っていた古い値が、何日も前のものでも、今より後の回の値に直す（過去の回を、毎分、探し続けない）', async () => {
    await save([dailySeries()], jst('2026-10-24', '09:00'));
    await db()
      .prepare("UPDATE entries SET start_time = '16:00', end_time = '17:00' WHERE id = 's'")
      .run();

    const discord = await run(jst(TODAY, '15:00'));

    expect(discord.calls).toHaveLength(0);
    expect(await readNextNotifyAt(db())).toEqual({ s: jst(TODAY, '15:50') });
  });

  it('その回を、例外で削除したあとに、古い値が残っていたら、送らず、次の回にする', async () => {
    await save([dailySeries()]);
    await save([exception({ id: 'x', originalDate: TODAY, startDate: TODAY, cancelled: true })]);
    // 系列の行に、削除した回の通知の時刻が、残っている（2 台で同時に保存した割り込み）。
    await db()
      .prepare('UPDATE entries SET next_notify_at = ?1 WHERE id = ?2')
      .bind(NOTIFY_AT, 's')
      .run();

    const discord = await run(NOTIFY_AT);

    expect(discord.calls).toHaveLength(0);
    expect(await readNextNotifyAt(db())).toEqual({ s: jst('2026-10-28', '14:50'), x: null });
  });

  it('系列が削除されたあとに作られた例外（系列のない例外）は、送らず、NULL にする', async () => {
    await save([
      dailySeries(),
      exception({ id: 'x', originalDate: '2026-10-28', startDate: TODAY }),
    ]);
    await db().prepare("UPDATE entries SET deleted_at = 6000 WHERE id = 's'").run();

    const discord = await run(NOTIFY_AT);

    expect(discord.calls).toHaveLength(0);
    expect((await readNextNotifyAt(db()))['x']).toBeNull();
  });

  it('通知を OFF にしたあとに、古い値が残っていたら、送らず、NULL にする', async () => {
    await save([timed({ id: 'a' })]);
    await db().prepare("UPDATE entries SET notify_enabled = 0 WHERE id = 'a'").run();

    const discord = await run(NOTIFY_AT);

    expect(discord.calls).toHaveLength(0);
    expect(await readNextNotifyAt(db())).toEqual({ a: null });
  });

  it('値を直すときも、条件付きの UPDATE。ほかが先に値を変えていたら、上書きしない', async () => {
    await save([dailySeries()]);
    await db()
      .prepare("UPDATE entries SET start_time = '16:00', end_time = '17:00' WHERE id = 's'")
      .run();
    const actual = await vi.importActual<typeof import('./db/store')>('./db/store');
    vi.mocked(readSeriesEntries).mockImplementationOnce(async (database, id) => {
      const rows = await actual.readSeriesEntries(database, id);
      await db()
        .prepare("UPDATE entries SET next_notify_at = ?1 WHERE id = 's'")
        .bind(jst('2026-10-30', '15:50'))
        .run();
      return rows;
    });

    await run(NOTIFY_AT);

    expect(await readNextNotifyAt(db())).toEqual({ s: jst('2026-10-30', '15:50') });
  });
});

describe('条件付きの UPDATE（二重に送らない）', () => {
  it('読んだあとに、ほかが next_notify_at を先に変えていたら、送らない。ほかが決めた値を残す', async () => {
    await save([dailySeries()]);
    const actual = await vi.importActual<typeof import('./db/store')>('./db/store');
    vi.mocked(readSeriesEntries).mockImplementationOnce(async (database, id) => {
      const rows = await actual.readSeriesEntries(database, id);
      // 別の実行（や保存）が、この行を先に進めた。
      await db()
        .prepare("UPDATE entries SET next_notify_at = ?1 WHERE id = 's'")
        .bind(jst('2026-10-28', '14:50'))
        .run();
      return rows;
    });

    const discord = await run(NOTIFY_AT);

    expect(discord.calls).toHaveLength(0);
    expect(await readNextNotifyAt(db())).toEqual({ s: jst('2026-10-28', '14:50') });
  });

  it('同じ時刻の実行が 2 回重なっても、送るのは 1 回だけ', async () => {
    await save([timed({ id: 'a' })]);
    const discord = fakeDiscord();

    await Promise.all([run(NOTIFY_AT, discord), run(NOTIFY_AT, discord)]);

    expect(discord.calls).toHaveLength(1);
  });
});

describe('送る条件（ワークスペース・通知の ON/OFF）', () => {
  it('削除されたワークスペースの予定は、送らない。値は進める（毎分、探され続けないように）', async () => {
    await save([
      timed({ id: 'a', workspaceId: 'gone' }),
      dailySeries({ id: 's', workspaceId: 'gone' }),
    ]);

    const discord = await run(NOTIFY_AT);

    expect(discord.calls).toHaveLength(0);
    expect(await readNextNotifyAt(db())).toEqual({ a: null, s: jst('2026-10-28', '14:50') });
  });

  it('表示が OFF のワークスペースの予定は、送る（Q1。表示の ON/OFF は見ない）', async () => {
    await save([timed({ id: 'a', workspaceId: 'off', title: '趣味の予定' })]);

    const discord = await run(NOTIFY_AT);

    expect(discord.contents()[0]).toContain('趣味の予定');
  });

  it('タイムブロックは、ワークスペースを持たないので、ワークスペースを見ずに送る', async () => {
    await save([timed({ id: 'b', kind: 'block', workspaceId: null, title: '仕事' })]);

    expect((await run(NOTIFY_AT)).calls).toHaveLength(1);
  });

  it('別のワークスペースの系列の、例外の回は、例外の行のワークスペースで決める', async () => {
    await save([
      dailySeries({ workspaceId: 'w1' }),
      exception({ id: 'x', originalDate: '2026-10-28', startDate: TODAY, workspaceId: 'gone' }),
    ]);

    const discord = await run(NOTIFY_AT);

    // 系列の行の今日の回だけが届く。削除されたワークスペースの例外は、送らない。
    // 系列の行の次は、10/28 の回を例外で今日に移したので、その次の 10/29。
    expect(discord.calls).toHaveLength(1);
    expect(await readNextNotifyAt(db())).toEqual({ s: jst('2026-10-29', '14:50'), x: null });
  });
});

describe('Discord への送信の失敗', () => {
  it('失敗したら、その場で 1 回だけ再送する。2 回目が届けば、1 回送ったのと同じ', async () => {
    await save([timed({ id: 'a' })]);
    const discord = fakeDiscord((call) =>
      call === 1 ? new Response(null, { status: 500 }) : new Response(null, { status: 204 }),
    );

    await run(NOTIFY_AT, discord);

    expect(discord.calls).toHaveLength(2);
    expect(discord.contents()[0]).toBe(discord.contents()[1]);
    expect(consoleError).not.toHaveBeenCalled();
  });

  it('2 回とも失敗しても、値は進んでいる（届かない通知を、毎分、送り直さない）', async () => {
    await save([dailySeries()]);
    const discord = fakeDiscord(() => new Response(null, { status: 500 }));

    await run(NOTIFY_AT, discord);
    expect(discord.calls).toHaveLength(2);
    expect(await readNextNotifyAt(db())).toEqual({ s: jst('2026-10-28', '14:50') });

    await run(NOTIFY_AT + MINUTE, discord);
    expect(discord.calls).toHaveLength(2);
  });

  it('失敗した行があっても、ほかの行は送る', async () => {
    await save([timed({ id: 'a', title: 'A' }), timed({ id: 'b', title: 'B' })]);
    const discord = fakeDiscord((call) =>
      call <= 2 ? new Error('Network connection lost.') : new Response(null, { status: 204 }),
    );

    await run(NOTIFY_AT, discord);

    expect(discord.calls).toHaveLength(3);
    expect(await readNextNotifyAt(db())).toEqual({ a: null, b: null });
  });
});

describe('Discord のレート制限（同じ時刻の通知が多いとき）', () => {
  it('429 のときは、Retry-After の秒数だけ待って、再送する。通知は届く', async () => {
    await save([timed({ id: 'a' })]);
    const discord = fakeDiscord((call) =>
      call === 1
        ? new Response(null, { status: 429, headers: { 'Retry-After': '2' } })
        : new Response(null, { status: 204 }),
    );

    await run(NOTIFY_AT, discord);

    expect(discord.calls).toHaveLength(2);
    expect(discord.waits).toEqual([2000]);
  });

  it('応答の X-RateLimit-Remaining が 0 なら、次の行の通知の前に待つ（1 回の実行の中の、行をまたいで）', async () => {
    await save([timed({ id: 'a' }), timed({ id: 'b' }), timed({ id: 'c' })]);
    const discord = fakeDiscord((call) =>
      call === 2
        ? new Response(null, {
            status: 204,
            headers: { 'X-RateLimit-Remaining': '0', 'X-RateLimit-Reset-After': '1.2' },
          })
        : new Response(null, { status: 204 }),
    );

    await run(NOTIFY_AT, discord);

    expect(discord.calls).toHaveLength(3);
    expect(discord.waits).toEqual([1200]);
  });
});

describe('DISCORD_WEBHOOK_URL が設定されていないとき', () => {
  it('送らず、値は進める（進めないと、同じ行が、毎分、見つかり続けるため）', async () => {
    await save([dailySeries()]);

    const discord = await run(NOTIFY_AT, fakeDiscord(), { DISCORD_WEBHOOK_URL: undefined });

    expect(discord.calls).toHaveLength(0);
    expect(await readNextNotifyAt(db())).toEqual({ s: jst('2026-10-28', '14:50') });
  });

  it('空の文字列・空白だけの値も、未設定として扱う', async () => {
    await save([timed({ id: 'a' }), timed({ id: 'b' })]);

    const empty = await run(NOTIFY_AT, fakeDiscord(), { DISCORD_WEBHOOK_URL: '' });
    expect(empty.calls).toHaveLength(0);
    expect(await readNextNotifyAt(db())).toEqual({ a: null, b: null });

    await save([timed({ id: 'c', editedAt: 2000 })]);
    const blank = await run(NOTIFY_AT, fakeDiscord(), { DISCORD_WEBHOOK_URL: '  ' });
    expect(blank.calls).toHaveLength(0);
  });

  it('ログは、1 回の実行で 1 回だけ（通知が出る行が複数あっても）。Webhook の設定のことが分かる', async () => {
    await save([timed({ id: 'a' }), timed({ id: 'b' }), timed({ id: 'c' })]);

    await run(NOTIFY_AT, fakeDiscord(), { DISCORD_WEBHOOK_URL: undefined });

    expect(consoleError).toHaveBeenCalledTimes(1);
    expect(everythingLogged()).toContain('DISCORD_WEBHOOK_URL');
  });

  it('送る通知がない実行では、ログを出さない（毎分、出し続けない）', async () => {
    const discord = await run(NOTIFY_AT, fakeDiscord(), { DISCORD_WEBHOOK_URL: undefined });

    expect(discord.calls).toHaveLength(0);
    expect(consoleError).not.toHaveBeenCalled();
  });

  it('10 分以上遅れて、どうせ送らない通知だけのときも、ログを出さない', async () => {
    await save([timed({ id: 'a' })]);

    await run(NOTIFY_AT + 30 * MINUTE, fakeDiscord(), { DISCORD_WEBHOOK_URL: undefined });

    expect(consoleError).not.toHaveBeenCalled();
  });
});

describe('1 回の実行で処理する行数の上限', () => {
  /** 文面の 1 行目の、題名の部分。 */
  const titleOf = (content: string) => content.split('\n')[0]?.split(': ')[1];
  const ids = Array.from({ length: 15 }, (_, index) => `e${String(index).padStart(2, '0')}`);

  it(`時刻が来た行が上限（${String(MAX_DUE_ENTRIES_PER_RUN)} 行）より多いときは、上限までを送り、残りは次の実行で拾う`, async () => {
    expect(MAX_DUE_ENTRIES_PER_RUN).toBe(10);
    await save(ids.map((id) => timed({ id, title: id })));

    const first = await run(NOTIFY_AT);
    expect(first.calls).toHaveLength(10);
    const remaining = Object.entries(await readNextNotifyAt(db())).filter(
      ([, value]) => value !== null,
    );
    expect(remaining).toHaveLength(5);

    const second = await run(NOTIFY_AT + MINUTE);
    expect(second.calls).toHaveLength(5);
    expect(await readNextNotifyAt(db())).toEqual(Object.fromEntries(ids.map((id) => [id, null])));

    const sentTitles = [...first.contents(), ...second.contents()].map(titleOf);
    expect(new Set(sentTitles)).toEqual(new Set(ids));
  });

  it('通知の時刻が新しい行から拾う（古い行は、新しい行の後に回る）', async () => {
    // 15 分前の通知は 14:45（5 分の遅れ。まだ送れる）。ほかの 15 行は 14:50。
    await save([
      ...ids.map((id) => timed({ id, title: id })),
      timed({ id: 'older', title: 'older', notifyOffsetMin: 15 }),
    ]);

    const first = await run(NOTIFY_AT);
    expect(first.calls).toHaveLength(10);
    expect(first.contents().map(titleOf)).not.toContain('older');

    // 次の分に、残りの 14:50 の 5 行と、14:45 の行（6 分の遅れ。まだ送れる）を拾う。
    const second = await run(NOTIFY_AT + MINUTE);
    expect(second.contents().map(titleOf)).toContain('older');
    expect(second.calls).toHaveLength(6);
  });

  it('止まっていた間に溜まった、遅れた古い行が、枠より多くても、時刻どおりの新しい通知は、先に送る', async () => {
    // 30 分前に通知する予定だった行（14:20 の通知。14:50 には 30 分の遅れで、送らない）が 12 行。今の通知（14:50）が 3 行。
    await save([
      ...Array.from({ length: 12 }, (_, index) =>
        timed({ id: `late${String(index)}`, title: 'late', startTime: '14:30', endTime: '15:00' }),
      ),
      ...['a', 'b', 'c'].map((id) => timed({ id, title: id })),
    ]);
    // 14:30 開始の 10 分前の通知は 14:20（保存は 09:00 なので、値が入っている）。

    const first = await run(NOTIFY_AT);

    expect(first.contents().map(titleOf).sort()).toEqual(['a', 'b', 'c']);
    // 枠の残りの 7 行は、古い行を、送らずに進めた。5 行は、次の実行に回る。
    const stillDue = Object.entries(await readNextNotifyAt(db())).filter(
      ([id, value]) => id.startsWith('late') && value !== null,
    );
    expect(stillDue).toHaveLength(5);
  });
});

describe('1 回の実行の時間の上限', () => {
  /** 呼ばれるたびに、決めた時間だけ進む時計と、その分だけ時計を進める偽の Discord。 */
  function slowDiscord(stepMs: number) {
    let elapsed = 0;
    const discord = fakeDiscord();
    const fetchFn = vi.fn<DiscordFetch>((url, init) => {
      elapsed += stepMs;
      return discord.fetchFn(url, init);
    });
    return { discord, fetchFn, now: () => elapsed };
  }

  it('実行を始めてから 20 秒を過ぎたら、残りの行は処理せず、次の分に回す（値は進めない）', async () => {
    expect(RUN_TIME_LIMIT_MS).toBe(20_000);
    await save([timed({ id: 'a' }), timed({ id: 'b' }), timed({ id: 'c' })]);
    // 1 件の送信ごとに 15 秒かかる。1 件目の後が 15 秒（上限の内）、2 件目の後が 30 秒（上限を過ぎた）。
    const { discord, fetchFn, now } = slowDiscord(15_000);

    await sendDueNotifications(envOf(), NOTIFY_AT, { fetchFn, sleep: discord.sleep, now });

    expect(discord.calls).toHaveLength(2);
    const values = Object.values(await readNextNotifyAt(db()));
    expect(values.filter((value) => value === null)).toHaveLength(2);
    expect(values.filter((value) => value === NOTIFY_AT)).toHaveLength(1);
  });

  it('次の分の実行が、回された行を拾って送る', async () => {
    await save([timed({ id: 'a' }), timed({ id: 'b' }), timed({ id: 'c' })]);
    const slow = slowDiscord(15_000);
    await sendDueNotifications(envOf(), NOTIFY_AT, {
      fetchFn: slow.fetchFn,
      sleep: slow.discord.sleep,
      now: slow.now,
    });

    const next = await run(NOTIFY_AT + MINUTE);

    expect(next.calls).toHaveLength(1);
    expect(await readNextNotifyAt(db())).toEqual({ a: null, b: null, c: null });
  });

  it('回したことを、ログに出す（行数だけ。中身は出さない）', async () => {
    await save([timed({ id: 'a', title: 'ひみつ' }), timed({ id: 'b' }), timed({ id: 'c' })]);
    const { discord, fetchFn, now } = slowDiscord(15_000);

    await sendDueNotifications(envOf(), NOTIFY_AT, { fetchFn, sleep: discord.sleep, now });

    expect(consoleWarn).toHaveBeenCalledTimes(1);
    expect(String(consoleWarn.mock.calls[0]?.[0])).toContain('残りの 1 行');
    expect(everythingLogged()).not.toContain('ひみつ');
  });

  it('ちょうど 20 秒なら、まだ処理する（過ぎたときだけ止める）', async () => {
    await save([timed({ id: 'a' }), timed({ id: 'b' })]);
    const { discord, fetchFn, now } = slowDiscord(20_000);

    await sendDueNotifications(envOf(), NOTIFY_AT, { fetchFn, sleep: discord.sleep, now });

    expect(discord.calls).toHaveLength(2);
  });

  it('時間がかからなければ、すべての行を処理する', async () => {
    await save([timed({ id: 'a' }), timed({ id: 'b' }), timed({ id: 'c' })]);

    const discord = await run(NOTIFY_AT);

    expect(discord.calls).toHaveLength(3);
    expect(consoleWarn).not.toHaveBeenCalled();
  });
});

describe('1 行で例外が起きても、ほかの行は続ける', () => {
  /** 定期実行が、1 行の失敗として出したログ（store.ts が出す、壊れた行のログは含めない）。 */
  const failureLogs = () =>
    consoleError.mock.calls
      .map(([message]) => String(message))
      .filter((message) => message.startsWith('通知の処理に失敗しました'));

  /** 構造が壊れた行（日付が日付でない）。読むと CorruptRowError になる。 */
  async function insertBrokenRow(
    id: string,
    nextNotifyAt: number | null,
    seriesId: string | null = null,
  ): Promise<void> {
    await db()
      .prepare(
        `INSERT INTO entries (id, kind, title, workspace_id, start_date, start_time, end_date, end_time,
           series_id, original_date, notify_enabled, notify_offset_min, next_notify_at, edited_at, rev)
         VALUES (?1, 'event', 'ひみつの題名', 'w1', 'not-a-date', '15:00', '2026-10-27', '16:00',
           ?3, ?4, 1, 10, ?2, 1000, 1)`,
      )
      .bind(id, nextNotifyAt, seriesId, seriesId === null ? null : '2026-10-28')
      .run();
  }

  it('壊れた行があっても、ほかの行は送る', async () => {
    await save([timed({ id: 'a', title: 'A' })]);
    await insertBrokenRow('broken', NOTIFY_AT - 1);

    const discord = await run(NOTIFY_AT);

    expect(discord.contents().map((content) => content.split('\n')[0])).toEqual(['🔔 10分後: A']);
  });

  it('壊れた行は、ログに、行の id と例外を出す。題名などの中身は出さない', async () => {
    await insertBrokenRow('broken', NOTIFY_AT - 1);

    await run(NOTIFY_AT);

    expect(failureLogs()).toHaveLength(1);
    const text = everythingLogged();
    expect(failureLogs()[0]).toContain('broken');
    expect(text).toContain('CorruptRowError');
    expect(text).not.toContain('ひみつの題名');
  });

  it('壊れた行の値は進まない。次の分も、同じ例外のログが出る（それで気づける）', async () => {
    await insertBrokenRow('broken', NOTIFY_AT - 1);

    await run(NOTIFY_AT);
    await run(NOTIFY_AT + MINUTE);

    expect(await readNextNotifyAt(db())).toEqual({ broken: NOTIFY_AT - 1 });
    expect(failureLogs()).toHaveLength(2);
  });

  it('壊れた行が先に来ても（時刻が早くても）、後ろの行は送る', async () => {
    await insertBrokenRow('broken', NOTIFY_AT - 5 * MINUTE);
    await save([timed({ id: 'a' }), timed({ id: 'b' })]);

    const discord = await run(NOTIFY_AT);

    expect(discord.calls).toHaveLength(2);
  });

  it('壊れた行が、枠（10 行）より多くても、時刻どおりの新しい通知は送る（壊れた行は、新しい行の後に回る）', async () => {
    for (let index = 0; index < 12; index += 1) {
      await insertBrokenRow(`broken${String(index)}`, NOTIFY_AT - 5 * MINUTE);
    }
    await save([timed({ id: 'a' }), timed({ id: 'b' }), timed({ id: 'c' })]);

    const discord = await run(NOTIFY_AT);

    expect(discord.calls).toHaveLength(3);
    // 枠の残り 7 行は、壊れた行。1 行ずつ、ログに出る。
    expect(failureLogs()).toHaveLength(7);
  });

  it('系列の中に壊れた行があると、その系列の、時刻が来た行は、すべて止まる（系列の読み直しが、壊れた行で失敗するため）', async () => {
    await save([dailySeries()]);
    await insertBrokenRow('broken-exception', null, 's');

    const discord = await run(NOTIFY_AT);

    expect(discord.calls).toHaveLength(0);
    expect(await readNextNotifyAt(db())).toMatchObject({ s: NOTIFY_AT });
    expect(failureLogs()).toHaveLength(1);
    expect(failureLogs()[0]).toContain('（行の id: s）');
  });
});

describe('Webhook の URL は、ログに出さない', () => {
  it('Discord への送信が失敗し、例外のメッセージに URL が入っていても、どのログにも URL は出ない', async () => {
    await save([timed({ id: 'a' }), dailySeries()]);
    const discord = fakeDiscord(() => new TypeError(`Failed to fetch ${WEBHOOK_URL}`));

    await run(NOTIFY_AT, discord);

    expect(consoleError).toHaveBeenCalled();
    expect(everythingLogged()).not.toContain('secret-token');
    expect(everythingLogged()).not.toContain('discord.example');
  });

  it('壊れた行があるときも、URL は出ない', async () => {
    await save([timed({ id: 'a' })]);
    await db()
      .prepare(
        `INSERT INTO entries (id, kind, title, workspace_id, start_date, end_date, notify_enabled,
           notify_offset_min, next_notify_at, edited_at, rev)
         VALUES ('broken', 'event', 'x', 'w1', 'not-a-date', '2026-10-27', 1, 10, ?1, 1000, 1)`,
      )
      .bind(NOTIFY_AT)
      .run();

    await run(NOTIFY_AT);

    expect(consoleError).toHaveBeenCalled();
    expect(everythingLogged()).not.toContain('secret-token');
  });
});

describe('scheduled（Worker の定期実行の入口）', () => {
  function controllerAt(scheduledTime: number): ScheduledController {
    return { scheduledTime, cron: '* * * * *', noRetry: () => undefined };
  }

  it('「今」は、controller.scheduledTime を使う。送るのは、グローバルの fetch', async () => {
    await save([timed({ id: 'a', title: '歯医者' })]);
    const fetchStub = vi.fn<DiscordFetch>(() =>
      Promise.resolve(new Response(null, { status: 204 })),
    );
    vi.stubGlobal('fetch', fetchStub);

    await scheduled(controllerAt(NOTIFY_AT), envOf());

    expect(fetchStub).toHaveBeenCalledTimes(1);
    expect(fetchStub.mock.calls[0]?.[0]).toBe(WEBHOOK_URL);
    expect(await readNextNotifyAt(db())).toEqual({ a: null });
  });

  it('予定の時刻が、まだ来ていなければ、送らない', async () => {
    await save([timed({ id: 'a' })]);
    const fetchStub = vi.fn<DiscordFetch>(() =>
      Promise.resolve(new Response(null, { status: 204 })),
    );
    vi.stubGlobal('fetch', fetchStub);

    await scheduled(controllerAt(NOTIFY_AT - MINUTE), envOf());

    expect(fetchStub).not.toHaveBeenCalled();
  });
});
