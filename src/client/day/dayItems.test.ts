import { describe, expect, it } from 'vitest';
import { makeEntry } from '../../../test/helpers/entries';
import { makeWorkspace } from '../../../test/helpers/workspaces';
import { dayItemsOf } from './dayItems';

const workspaces = [
  makeWorkspace({ id: 'w1', color: '#039BE5' }),
  makeWorkspace({ id: 'builtin-holiday', builtin: 'holiday', color: '#F28B82' }),
  makeWorkspace({ id: 'builtin-observance', builtin: 'observance', color: '#9AA0A6' }),
];

type EntryFields = Parameters<typeof makeEntry>[0];

/** 時間指定の予定（既定は w1 の予定）。 */
function timed(fields: EntryFields): EntryFields {
  return { allDay: false, startTime: '09:00', endTime: '10:00', ...fields };
}

/** タイムブロック（ワークスペースを持たない）。 */
function block(fields: EntryFields): EntryFields {
  return { kind: 'block', workspaceId: null, ...timed(fields) };
}

function itemsOf(
  date: string,
  entries: EntryFields[],
  options: { workspaces?: typeof workspaces } = {},
) {
  return dayItemsOf({
    entries: entries.map((entry) => makeEntry(entry)),
    workspaces: options.workspaces ?? workspaces,
    date,
  });
}

describe('上部の欄（DV-6）に出るもの', () => {
  it('終日の予定は、上部の欄に、ワークスペースの色で出る。1 日だけなら、期間は出さない', () => {
    const { banner, timeline } = itemsOf('2026-10-19', [
      { id: 'e1', title: '誕生日', startDate: '2026-10-19' },
    ]);

    expect(timeline).toEqual([]);
    expect(banner).toMatchObject([
      { title: '誕生日', color: '#039BE5', period: null, accessibleName: '終日 誕生日' },
    ]);
  });

  it('複数日の終日の予定は、期間「10/18〜10/21」が付き、どの日にも出る', () => {
    const entries = [{ id: 'e1', title: '帰省', startDate: '2026-10-18', endDate: '2026-10-21' }];

    for (const date of ['2026-10-18', '2026-10-19', '2026-10-21']) {
      expect(itemsOf(date, entries).banner).toMatchObject([
        { title: '帰省', period: '10/18〜10/21', accessibleName: '10/18〜10/21 終日 帰省' },
      ]);
    }
    expect(itemsOf('2026-10-22', entries).banner).toEqual([]);
  });

  it('24 時間以上の時間指定の予定は、上部の欄に出る。期間は「10/16 18:00〜10/18 20:00」', () => {
    const entries = [
      timed({
        id: 'e1',
        title: '合宿',
        startDate: '2026-10-16',
        startTime: '18:00',
        endDate: '2026-10-18',
        endTime: '20:00',
      }),
    ];

    for (const date of ['2026-10-16', '2026-10-17', '2026-10-18']) {
      const { banner, timeline } = itemsOf(date, entries);
      expect(timeline).toEqual([]);
      expect(banner).toMatchObject([
        {
          title: '合宿',
          color: '#039BE5',
          period: '10/16 18:00〜10/18 20:00',
          accessibleName: '10/16 18:00〜10/18 20:00 合宿',
        },
      ]);
    }
  });

  it('ちょうど 24 時間の時間指定の予定も、上部の欄（24 時間以上）', () => {
    const { banner, timeline } = itemsOf('2026-10-19', [
      timed({
        id: 'e1',
        startDate: '2026-10-19',
        startTime: '09:00',
        endDate: '2026-10-20',
        endTime: '09:00',
      }),
    ]);

    expect(timeline).toEqual([]);
    expect(banner).toHaveLength(1);
  });

  it('23 時間 45 分の時間指定の予定は、タイムラインに出る（24 時間に届かない）', () => {
    const { banner, timeline } = itemsOf('2026-10-19', [
      timed({
        id: 'e1',
        startDate: '2026-10-19',
        startTime: '09:00',
        endDate: '2026-10-20',
        endTime: '08:45',
      }),
    ]);

    expect(banner).toEqual([]);
    expect(timeline).toMatchObject([{ start: 540, end: 1440 }]);
  });

  it('24 時間以上のタイムブロックも、上部の欄に出る。色は持たない（画面が、タイムブロックの色にする）', () => {
    const { banner } = itemsOf('2026-10-19', [
      block({
        id: 'b1',
        title: '出張',
        startDate: '2026-10-19',
        startTime: '09:00',
        endDate: '2026-10-21',
        endTime: '18:00',
      }),
    ]);

    expect(banner).toMatchObject([
      {
        title: '出張',
        color: null,
        period: '10/19 9:00〜10/21 18:00',
        accessibleName: 'タイムブロック 10/19 9:00〜10/21 18:00 出張',
      },
    ]);
  });

  it('上部の欄の項目は、押したときに開く回（occurrence）を持つ', () => {
    const { banner } = itemsOf('2026-10-19', [{ id: 'e1', startDate: '2026-10-19' }]);

    expect(banner[0]?.occurrence).toMatchObject({ entryId: 'e1', occurrenceDate: '2026-10-19' });
  });
});

describe('タイムラインに出るもの（DV-1・DV-2）', () => {
  it('時間指定の予定は、開始・終了の分と、ワークスペースの色で出る。時刻は「9:00〜10:00」', () => {
    const { banner, timeline } = itemsOf('2026-10-19', [
      timed({
        id: 'e1',
        title: '会議',
        startDate: '2026-10-19',
        startTime: '09:00',
        endTime: '10:30',
      }),
    ]);

    expect(banner).toEqual([]);
    expect(timeline).toMatchObject([
      {
        title: '会議',
        color: '#039BE5',
        start: 540,
        end: 630,
        timeLabel: '9:00〜10:30',
        accessibleName: '9:00〜10:30 会議',
      },
    ]);
  });

  it('タイムブロックは、色を持たず、読み上げの名前の先頭に「タイムブロック」が付く', () => {
    const { timeline } = itemsOf('2026-10-19', [
      block({
        id: 'b1',
        title: '勉強',
        startDate: '2026-10-19',
        startTime: '13:00',
        endTime: '14:00',
      }),
    ]);

    expect(timeline).toMatchObject([
      { title: '勉強', color: null, accessibleName: 'タイムブロック 13:00〜14:00 勉強' },
    ]);
  });

  it('15 分の項目は、15 分（15px の高さになる長さ）', () => {
    const { timeline } = itemsOf('2026-10-19', [
      timed({ id: 'e1', startDate: '2026-10-19', startTime: '09:00', endTime: '09:15' }),
    ]);

    expect(timeline).toMatchObject([{ start: 540, end: 555 }]);
  });

  it('その日にかからない予定は出ない', () => {
    const { banner, timeline } = itemsOf('2026-10-19', [
      timed({ id: 'e1', startDate: '2026-10-20' }),
      timed({ id: 'e2', startDate: '2026-10-18' }),
    ]);

    expect({ banner, timeline }).toEqual({ banner: [], timeline: [] });
  });

  it('毎日の予定は、その日の 1 回だけが出る', () => {
    const { timeline } = itemsOf('2026-10-21', [
      timed({
        id: 's1',
        title: 'ジム',
        startDate: '2026-10-19',
        endDate: '2026-10-19',
        rrule: { freq: 'daily' },
      }),
    ]);

    expect(timeline).toMatchObject([{ title: 'ジム', start: 540, end: 600 }]);
    expect(timeline[0]?.occurrence.occurrenceDate).toBe('2026-10-21');
  });

  it('題名の絵文字は、そのまま渡す（画面が絵文字の画像にする）', () => {
    const { timeline } = itemsOf('2026-10-19', [
      timed({ id: 'e1', title: '🎂 誕生日会', startDate: '2026-10-19' }),
    ]);

    expect(timeline[0]?.title).toBe('🎂 誕生日会');
  });
});

describe('日付をまたぐもの（TB-6）', () => {
  const sleep = block({
    id: 'b1',
    title: '睡眠',
    startDate: '2026-10-19',
    startTime: '23:00',
    endDate: '2026-10-20',
    endTime: '07:00',
  });

  it('始まる日には、開始から 24:00 までに切り取られる', () => {
    const { timeline } = itemsOf('2026-10-19', [sleep]);

    expect(timeline).toMatchObject([{ start: 1380, end: 1440 }]);
  });

  it('終わる日には、0:00 から終了までに切り取られる', () => {
    const { timeline } = itemsOf('2026-10-20', [sleep]);

    expect(timeline).toMatchObject([{ start: 0, end: 420 }]);
  });

  it('切り取っても、時刻の表示は、元の開始と終了（「23:00〜7:00」）', () => {
    expect(itemsOf('2026-10-19', [sleep]).timeline[0]?.timeLabel).toBe('23:00〜7:00');
    expect(itemsOf('2026-10-20', [sleep]).timeline[0]?.timeLabel).toBe('23:00〜7:00');
  });

  it('日をまたぐものの読み上げの名前には、日付が入る（「10/19 23:00〜10/20 7:00」）', () => {
    expect(itemsOf('2026-10-20', [sleep]).timeline[0]?.accessibleName).toBe(
      'タイムブロック 10/19 23:00〜10/20 7:00 睡眠',
    );
  });

  it('終了が翌日の 0:00 ちょうどのものは、翌日には出ない', () => {
    const entries = [
      block({
        id: 'b1',
        startDate: '2026-10-19',
        startTime: '22:00',
        endDate: '2026-10-20',
        endTime: '00:00',
      }),
    ];

    expect(itemsOf('2026-10-19', entries).timeline).toMatchObject([{ start: 1320, end: 1440 }]);
    expect(itemsOf('2026-10-20', entries).timeline).toEqual([]);
  });

  it('日をまたぐ予定（ワークスペースの予定）も、同じように切り取られる', () => {
    const { timeline } = itemsOf('2026-10-20', [
      timed({
        id: 'e1',
        startDate: '2026-10-19',
        startTime: '22:00',
        endDate: '2026-10-20',
        endTime: '01:00',
      }),
    ]);

    expect(timeline).toMatchObject([{ color: '#039BE5', start: 0, end: 60 }]);
  });
});

describe('表示するワークスペース（WS-3）', () => {
  it('表示が OFF のワークスペースの予定は、出ない。タイムブロックは、常に出る（TB-3）', () => {
    const { banner, timeline } = itemsOf(
      '2026-10-19',
      [
        timed({ id: 'e1', workspaceId: 'w2', startDate: '2026-10-19' }),
        { id: 'e2', workspaceId: 'w2', startDate: '2026-10-19' },
        block({ id: 'b1', startDate: '2026-10-19' }),
      ],
      { workspaces: [...workspaces, makeWorkspace({ id: 'w2', visible: false })] },
    );

    expect(banner).toEqual([]);
    expect(timeline).toHaveLength(1);
    expect(timeline[0]?.occurrence.kind).toBe('block');
  });

  it('削除済みのワークスペースの予定は、出ない', () => {
    const { timeline } = itemsOf(
      '2026-10-19',
      [timed({ id: 'e1', workspaceId: 'w2', startDate: '2026-10-19' })],
      { workspaces: [...workspaces, makeWorkspace({ id: 'w2', deletedAt: 5000 })] },
    );

    expect(timeline).toEqual([]);
  });

  it('OFF のワークスペースへ移した回があるとき、その日に、元の系列の回が現れない', () => {
    // 10-21 の回だけ、OFF のワークスペースへ移した例外。展開の前に除くと、系列の 10-21 の回が現れる。
    const entries = [
      timed({ id: 's1', title: '毎日', startDate: '2026-10-19', rrule: { freq: 'daily' } }),
      timed({
        id: 'x1',
        title: '毎日',
        seriesId: 's1',
        originalDate: '2026-10-21',
        workspaceId: 'w2',
        startDate: '2026-10-21',
      }),
    ];
    const withOff = { workspaces: [...workspaces, makeWorkspace({ id: 'w2', visible: false })] };

    expect(itemsOf('2026-10-21', entries, withOff).timeline).toEqual([]);
    expect(itemsOf('2026-10-20', entries, withOff).timeline).toHaveLength(1);
  });
});

describe('同じ日の、複数の項目', () => {
  it('上部の欄とタイムラインに、それぞれ分かれて出る', () => {
    const { banner, timeline } = itemsOf('2026-10-19', [
      { id: 'e1', title: '終日', startDate: '2026-10-19' },
      timed({ id: 'e2', title: '会議', startDate: '2026-10-19' }),
      block({
        id: 'b1',
        title: '勉強',
        startDate: '2026-10-19',
        startTime: '13:00',
        endTime: '14:00',
      }),
    ]);

    expect(banner.map((item) => item.title)).toEqual(['終日']);
    expect(timeline.map((item) => item.title)).toEqual(['会議', '勉強']);
  });
});
