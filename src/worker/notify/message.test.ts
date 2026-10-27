import { describe, expect, it } from 'vitest';
import { DISCORD_CONTENT_LIMIT, buildNotifyMessage, type NotifyMessageFields } from './message';

const ORIGIN = 'https://calendar.ataraman.com';

/** 時間指定の回（2026-10-19（月）15:00〜16:00、10 分前に通知）。 */
function timed(overrides: Partial<NotifyMessageFields> = {}): NotifyMessageFields {
  return {
    title: '歯医者',
    allDay: false,
    startDate: '2026-10-19',
    startTime: '15:00',
    endDate: '2026-10-19',
    endTime: '16:00',
    location: null,
    notifyOffsetMin: 10,
    ...overrides,
  };
}

/** 終日の回（2026-10-19 の 1 日。当日の朝 6 時 = -360 に通知）。 */
function allDay(overrides: Partial<NotifyMessageFields> = {}): NotifyMessageFields {
  return {
    title: '帰省',
    allDay: true,
    startDate: '2026-10-19',
    startTime: null,
    endDate: '2026-10-19',
    endTime: null,
    location: null,
    notifyOffsetMin: -360,
    ...overrides,
  };
}

const firstLine = (message: string) => message.split('\n')[0];

describe('NT-1: 通知の文面（設計書 9.4）', () => {
  it('時間指定の予定は、題名・日時・場所・日表示へのリンクの順に並ぶ', () => {
    expect(buildNotifyMessage(timed({ location: '○○歯科' }), ORIGIN)).toBe(
      [
        '🔔 10分後: 歯医者',
        '10/19（月）15:00〜16:00',
        '📍 ○○歯科',
        'https://calendar.ataraman.com/day/2026-10-19',
      ].join('\n'),
    );
  });

  it('場所がなければ、場所の行は出さない', () => {
    expect(buildNotifyMessage(timed(), ORIGIN)).toBe(
      [
        '🔔 10分後: 歯医者',
        '10/19（月）15:00〜16:00',
        'https://calendar.ataraman.com/day/2026-10-19',
      ].join('\n'),
    );
  });

  it('場所が空白だけでも、場所の行は出さない', () => {
    expect(buildNotifyMessage(timed({ location: '  ' }), ORIGIN)).not.toContain('📍');
  });

  it('終日の予定は、日時の行を出さない（日付は 1 行目と、リンクにある）', () => {
    expect(buildNotifyMessage(allDay(), ORIGIN)).toBe(
      ['🔔 今日: 帰省', 'https://calendar.ataraman.com/day/2026-10-19'].join('\n'),
    );
  });

  it('終日の予定にも、場所があれば、場所の行を出す', () => {
    expect(buildNotifyMessage(allDay({ location: '実家' }), ORIGIN)).toBe(
      ['🔔 今日: 帰省', '📍 実家', 'https://calendar.ataraman.com/day/2026-10-19'].join('\n'),
    );
  });

  it('タイムブロックも、予定と同じ文面になる（種類は文面に出ない）', () => {
    expect(
      buildNotifyMessage(timed({ title: '仕事', startTime: '09:00', endTime: '18:00' }), ORIGIN),
    ).toBe(
      [
        '🔔 10分後: 仕事',
        '10/19（月）9:00〜18:00',
        'https://calendar.ataraman.com/day/2026-10-19',
      ].join('\n'),
    );
  });
});

describe('時間指定の「いつ」（通知の分）', () => {
  it.each([
    { minutes: 0, expected: '🔔 今から: 歯医者' },
    { minutes: 1, expected: '🔔 1分後: 歯医者' },
    { minutes: 10, expected: '🔔 10分後: 歯医者' },
    { minutes: 59, expected: '🔔 59分後: 歯医者' },
    { minutes: 60, expected: '🔔 1時間後: 歯医者' },
    { minutes: 90, expected: '🔔 1時間30分後: 歯医者' },
    { minutes: 120, expected: '🔔 2時間後: 歯医者' },
    { minutes: 1440, expected: '🔔 1日後: 歯医者' },
    { minutes: 1500, expected: '🔔 1日1時間後: 歯医者' },
    { minutes: 1441, expected: '🔔 1日1分後: 歯医者' },
    { minutes: 10_080, expected: '🔔 7日後: 歯医者' },
    { minutes: -1, expected: '🔔 開始から1分: 歯医者' },
    { minutes: -30, expected: '🔔 開始から30分: 歯医者' },
    { minutes: -60, expected: '🔔 開始から1時間: 歯医者' },
    { minutes: -90, expected: '🔔 開始から1時間30分: 歯医者' },
    { minutes: -1440, expected: '🔔 開始から1日: 歯医者' },
  ])('通知の分が $minutes なら、1 行目は「$expected」', ({ minutes, expected }) => {
    expect(firstLine(buildNotifyMessage(timed({ notifyOffsetMin: minutes }), ORIGIN))).toBe(
      expected,
    );
  });
});

describe('終日の「いつ」（通知の日と、開始日の差）', () => {
  it.each([
    { name: '当日の朝 6 時（-360）は「今日」', minutes: -360, expected: '🔔 今日: 帰省' },
    { name: '当日の 0:00（0）は「今日」', minutes: 0, expected: '🔔 今日: 帰省' },
    { name: '前の日の 18:00（360）は「明日」', minutes: 360, expected: '🔔 明日: 帰省' },
    { name: '前の日の 0:00（1440）は「明日」', minutes: 1440, expected: '🔔 明日: 帰省' },
    { name: '前の日の 0:00 より前（1441）は「2日後」', minutes: 1441, expected: '🔔 2日後: 帰省' },
    { name: '7 日前（10080）は「7日後」', minutes: 10_080, expected: '🔔 7日後: 帰省' },
    {
      name: '開始日の翌日の 0:00（-1440）は「昨日から」',
      minutes: -1440,
      expected: '🔔 昨日から: 帰省',
    },
  ])('$name', ({ minutes, expected }) => {
    expect(firstLine(buildNotifyMessage(allDay({ notifyOffsetMin: minutes }), ORIGIN))).toBe(
      expected,
    );
  });

  it('入力の範囲の外の、さらに後の通知（-2880）も、文面は作れる', () => {
    expect(firstLine(buildNotifyMessage(allDay({ notifyOffsetMin: -2880 }), ORIGIN))).toBe(
      '🔔 2日前から: 帰省',
    );
  });

  it('複数日の終日の予定は、題名のあとに、期間を付ける', () => {
    expect(
      firstLine(buildNotifyMessage(allDay({ title: '帰省', endDate: '2026-10-21' }), ORIGIN)),
    ).toBe('🔔 今日: 帰省（10/19〜10/21）');
  });

  it('1 日だけの終日の予定には、期間を付けない', () => {
    expect(firstLine(buildNotifyMessage(allDay(), ORIGIN))).not.toContain('（');
  });

  it('月をまたぐ期間は、月も付ける。月日は 0 を付けない', () => {
    expect(
      firstLine(
        buildNotifyMessage(allDay({ startDate: '2026-12-29', endDate: '2027-01-03' }), ORIGIN),
      ),
    ).toBe('🔔 今日: 帰省（12/29〜1/3）');
  });

  it('日本時間で求める（開始日の前日の夜に通知しても、日は日本時間の差）', () => {
    // 開始日 2026-10-19 の 0:00（日本時間）の 2 時間前 = 10/18 22:00（日本時間）。UTC では 10/18 13:00。
    expect(firstLine(buildNotifyMessage(allDay({ notifyOffsetMin: 120 }), ORIGIN))).toBe(
      '🔔 明日: 帰省',
    );
  });
});

describe('時間指定の日時の行', () => {
  it('時刻は、先頭の 0 を付けない（画面と同じ）', () => {
    expect(
      buildNotifyMessage(timed({ startTime: '09:00', endTime: '09:45' }), ORIGIN).split('\n')[1],
    ).toBe('10/19（月）9:00〜9:45');
  });

  it('日をまたぐときは、終わりにも日付と曜日を付ける', () => {
    expect(
      buildNotifyMessage(
        timed({ startTime: '23:00', endDate: '2026-10-20', endTime: '07:00' }),
        ORIGIN,
      ).split('\n')[1],
    ).toBe('10/19（月）23:00〜10/20（火）7:00');
  });

  it('終わりが翌日の 0:00 のときも、終わりの日付を付ける（終了日は翌日で持つ）', () => {
    expect(
      buildNotifyMessage(
        timed({ startTime: '20:00', endDate: '2026-10-20', endTime: '00:00' }),
        ORIGIN,
      ).split('\n')[1],
    ).toBe('10/19（月）20:00〜10/20（火）0:00');
  });

  it('月をまたぐ日付も、月日は 0 を付けない', () => {
    expect(
      buildNotifyMessage(
        timed({
          startDate: '2026-10-31',
          startTime: '23:00',
          endDate: '2026-11-01',
          endTime: '01:00',
        }),
        ORIGIN,
      ).split('\n')[1],
    ).toBe('10/31（土）23:00〜11/1（日）1:00');
  });

  it('日曜から土曜まで、曜日を出す', () => {
    // 2026-10-18 は日曜。
    const weekdays = ['日', '月', '火', '水', '木', '金', '土'];
    weekdays.forEach((weekday, index) => {
      const date = `2026-10-${String(18 + index)}`;
      const line = buildNotifyMessage(timed({ startDate: date, endDate: date }), ORIGIN).split(
        '\n',
      )[1];
      expect(line).toContain(`（${weekday}）`);
    });
  });
});

describe('日表示へのリンク', () => {
  it('最後の行は、その回の開始日の日表示のリンク', () => {
    const lines = buildNotifyMessage(
      timed({ startDate: '2026-11-03', endDate: '2026-11-03' }),
      ORIGIN,
    ).split('\n');

    expect(lines.at(-1)).toBe('https://calendar.ataraman.com/day/2026-11-03');
  });

  it('複数日の予定も、開始日の日表示', () => {
    expect(
      buildNotifyMessage(allDay({ startDate: '2026-10-19', endDate: '2026-10-21' }), ORIGIN),
    ).toMatch(/\n\S+\/day\/2026-10-19$/);
  });

  it('URL の頭は、引数で差し替えられる（ローカルや、ドメインを変えたとき）', () => {
    expect(buildNotifyMessage(timed(), 'http://localhost:5173')).toMatch(
      /\nhttp:\/\/localhost:5173\/day\/2026-10-19$/,
    );
  });

  it('URL の頭の末尾に / があっても、/ を重ねない', () => {
    expect(buildNotifyMessage(timed(), `${ORIGIN}/`)).toMatch(
      /\nhttps:\/\/calendar\.ataraman\.com\/day\/2026-10-19$/,
    );
  });
});

describe('Discord の上限（2000 文字）', () => {
  it('上限に収まる題名・場所は、切らない', () => {
    const message = buildNotifyMessage(
      timed({ title: 'あ'.repeat(200), location: 'い'.repeat(200) }),
      ORIGIN,
    );

    expect(message).toContain('あ'.repeat(200));
    expect(message).toContain('い'.repeat(200));
  });

  it('題名が長すぎるときは、題名を切り詰めて「…」を付け、全体を上限に収める。日時とリンクは残す', () => {
    const message = buildNotifyMessage(timed({ title: 'あ'.repeat(5000) }), ORIGIN);

    expect(message.length).toBeLessThanOrEqual(DISCORD_CONTENT_LIMIT);
    expect(firstLine(message)).toMatch(/^🔔 10分後: あ+…$/);
    expect(message).toContain('10/19（月）15:00〜16:00');
    expect(message).toMatch(/\nhttps:\/\/calendar\.ataraman\.com\/day\/2026-10-19$/);
  });

  it('場所が長すぎるときは、場所を切り詰める。題名は残る', () => {
    const message = buildNotifyMessage(timed({ location: 'い'.repeat(5000) }), ORIGIN);

    expect(message.length).toBeLessThanOrEqual(DISCORD_CONTENT_LIMIT);
    expect(firstLine(message)).toBe('🔔 10分後: 歯医者');
    expect(message).toMatch(/\n📍 い+…\n/);
  });

  it('題名も場所も長すぎるときは、両方を切り詰めて、上限に収める。どちらも、残る文字がある', () => {
    const message = buildNotifyMessage(
      timed({ title: 'あ'.repeat(5000), location: 'い'.repeat(5000) }),
      ORIGIN,
    );

    expect(message.length).toBeLessThanOrEqual(DISCORD_CONTENT_LIMIT);
    expect(message).toMatch(/^🔔 10分後: あ{100,}…\n/);
    expect(message).toMatch(/\n📍 い{100,}…\n/);
  });

  it('場所が短いときは、長い題名が、場所の残りの分まで使える', () => {
    const message = buildNotifyMessage(
      timed({ title: 'あ'.repeat(5000), location: '○○歯科' }),
      ORIGIN,
    );

    expect(message.length).toBe(DISCORD_CONTENT_LIMIT);
    expect(message).toContain('📍 ○○歯科\n');
  });

  it('絵文字（サロゲートペア）の途中では切らない', () => {
    const message = buildNotifyMessage(timed({ title: '🎂'.repeat(3000) }), ORIGIN);

    expect(message.length).toBeLessThanOrEqual(DISCORD_CONTENT_LIMIT);
    // 切れた半分（孤立したサロゲート）が残っていれば、JSON にしたとき、\ud83c のような文字が出る。
    expect(JSON.stringify(message)).not.toMatch(/\\ud[89a-f][0-9a-f]{2}/i);
    expect(firstLine(message)).toMatch(/^🔔 10分後: (🎂)+…$/u);
  });

  it('複数日の終日の予定でも、期間は切らず、題名を切り詰める', () => {
    const message = buildNotifyMessage(
      allDay({ title: 'あ'.repeat(5000), endDate: '2026-10-21' }),
      ORIGIN,
    );

    expect(message.length).toBeLessThanOrEqual(DISCORD_CONTENT_LIMIT);
    expect(firstLine(message)).toMatch(/^🔔 今日: あ+…（10\/19〜10\/21）$/);
  });
});
