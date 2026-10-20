import { describe, expect, it } from 'vitest';
import {
  dateStringSchema,
  entryChangesSchema,
  entryDraftSchema,
  entrySchema,
  rruleSchema,
  scopeSchema,
  timeStringSchema,
  workspaceSchema,
  type Entry,
  type Workspace,
} from './schema';

const validEntry: Entry = {
  id: 'e1',
  kind: 'event',
  title: '歯医者',
  workspaceId: 'w1',
  allDay: false,
  startDate: '2026-10-19',
  startTime: '15:00',
  endDate: '2026-10-19',
  endTime: '16:00',
  location: null,
  url: null,
  memo: null,
  rrule: null,
  untilDate: null,
  seriesId: null,
  originalDate: null,
  cancelled: false,
  notifyEnabled: true,
  notifyOffsetMin: 10,
  editedAt: 1_760_000_000_000,
  deletedAt: null,
};

describe('日付の文字列', () => {
  it.each(['2026-10-19', '2024-02-29', '1900-01-01', '2199-12-31'])('%s は通る', (value) => {
    expect(dateStringSchema.safeParse(value).success).toBe(true);
  });

  it.each(['2026-02-29', '2100-02-29', '2026-04-31', '2026-13-01', '2026-1-9', '20261019', ''])(
    '%s は通らない',
    (value) => {
      expect(dateStringSchema.safeParse(value).success).toBe(false);
    },
  );
});

describe('DV-3: 時刻の文字列は 15 分刻み', () => {
  it.each(['00:00', '09:15', '12:30', '23:45'])('%s は通る', (value) => {
    expect(timeStringSchema.safeParse(value).success).toBe(true);
  });

  it.each(['09:10', '12:59', '24:00', '9:00', '09:00:00', '12:60', ''])(
    '%s は通らない',
    (value) => {
      expect(timeStringSchema.safeParse(value).success).toBe(false);
    },
  );
});

describe('RP-1: 繰り返しのルール', () => {
  it.each([
    { freq: 'daily' },
    { freq: 'weekly', days: [1, 3, 5] },
    { freq: 'weekly', days: [0] },
    { freq: 'monthly' },
    { freq: 'yearly' },
    { freq: 'weekday' },
    { freq: 'holiday' },
  ])('%j は通る', (rule) => {
    expect(rruleSchema.safeParse(rule).success).toBe(true);
  });

  it.each([
    { reason: '曜日が 1 件もない', rule: { freq: 'weekly', days: [] } },
    { reason: '曜日が重複している', rule: { freq: 'weekly', days: [1, 1] } },
    { reason: '曜日が 0〜6 の外', rule: { freq: 'weekly', days: [7] } },
    { reason: '曜日が整数でない', rule: { freq: 'weekly', days: [1.5] } },
    { reason: 'weekly に days がない', rule: { freq: 'weekly' } },
    { reason: 'daily に余計なキーがある', rule: { freq: 'daily', days: [1] } },
    { reason: '知らない種類', rule: { freq: 'biweekly' } },
  ])('通らない: $reason', ({ rule }) => {
    expect(rruleSchema.safeParse(rule).success).toBe(false);
  });
});

describe('予定とタイムブロックの行', () => {
  it('すべての列がそろった行は通り、同じ内容に戻る', () => {
    expect(entrySchema.parse(validEntry)).toEqual(validEntry);
  });

  it('繰り返しのルールが入った行は通る', () => {
    const row = { ...validEntry, rrule: { freq: 'weekly', days: [3, 5] } };
    expect(entrySchema.safeParse(row).success).toBe(true);
  });

  it('タイムブロック（kind が block）は通る', () => {
    const row = { ...validEntry, kind: 'block', workspaceId: null };
    expect(entrySchema.safeParse(row).success).toBe(true);
  });

  it('種類が event と block 以外だと通らない', () => {
    expect(entrySchema.safeParse({ ...validEntry, kind: 'task' }).success).toBe(false);
  });

  it('日付の形式が違うと通らない', () => {
    expect(entrySchema.safeParse({ ...validEntry, startDate: '2026/10/19' }).success).toBe(false);
  });

  it('時刻が 15 分刻みでないと通らない', () => {
    expect(entrySchema.safeParse({ ...validEntry, startTime: '15:10' }).success).toBe(false);
  });

  it('列が足りないと通らない', () => {
    expect(entrySchema.safeParse({ ...validEntry, title: undefined }).success).toBe(false);
  });

  it('サーバーの都合の列（rev など）は、読み込むと捨てられる', () => {
    const parsed = entrySchema.parse({ ...validEntry, rev: 5, nextNotifyAt: 1 });
    expect(parsed).toEqual(validEntry);
  });
});

const validWorkspace: Workspace = {
  id: 'w1',
  name: '仕事',
  color: '#4285F4',
  sortOrder: 0,
  visible: true,
  builtin: null,
  editedAt: 1_760_000_000_000,
  deletedAt: null,
};

describe('WS-1・WS-4: ワークスペースの行', () => {
  it('すべての列がそろった行は通り、同じ内容に戻る', () => {
    expect(workspaceSchema.parse(validWorkspace)).toEqual(validWorkspace);
  });

  it.each(['holiday', 'observance'] as const)('組み込みの印 %s は通る', (builtin) => {
    expect(workspaceSchema.safeParse({ ...validWorkspace, builtin }).success).toBe(true);
  });

  it('組み込みの印が holiday と observance 以外だと通らない', () => {
    expect(workspaceSchema.safeParse({ ...validWorkspace, builtin: 'custom' }).success).toBe(false);
  });

  it.each(['#F28B82', '#9aa0a6'])('色 %s は通る', (color) => {
    expect(workspaceSchema.safeParse({ ...validWorkspace, color }).success).toBe(true);
  });

  it.each(['F28B82', '#F28B8', '#F28B822', '#GGGGGG', 'red', ''])('色 %s は通らない', (color) => {
    expect(workspaceSchema.safeParse({ ...validWorkspace, color }).success).toBe(false);
  });

  it('削除した行（deletedAt が数値）は通る', () => {
    expect(workspaceSchema.safeParse({ ...validWorkspace, deletedAt: 1 }).success).toBe(true);
  });

  it('表示の ON/OFF が真偽値でないと通らない', () => {
    expect(workspaceSchema.safeParse({ ...validWorkspace, visible: 1 }).success).toBe(false);
  });
});

describe('新しく作るときの下書き', () => {
  it('ユーザーが入力する項目だけが残る', () => {
    const parsed = entryDraftSchema.parse(validEntry);
    expect(Object.keys(parsed).sort()).toEqual(
      [
        'kind',
        'title',
        'workspaceId',
        'allDay',
        'startDate',
        'startTime',
        'endDate',
        'endTime',
        'location',
        'url',
        'memo',
        'rrule',
        'notifyEnabled',
        'notifyOffsetMin',
      ].sort(),
    );
  });
});

describe('RP-4: 変更の中身は、ユーザーが変えた項目だけ', () => {
  it('空のオブジェクト（何も変えていない）は通る', () => {
    expect(entryChangesSchema.safeParse({}).success).toBe(true);
  });

  it('変えた項目だけを持てる', () => {
    const changes = entryChangesSchema.parse({ title: '内科', startTime: '10:15' });
    expect(changes).toEqual({ title: '内科', startTime: '10:15' });
  });

  it('null は「空にした」として通り、キーがないことと区別される', () => {
    const changes = entryChangesSchema.parse({ memo: null });
    expect(changes.memo).toBeNull();
    expect('title' in changes).toBe(false);
  });

  it('繰り返しのルールを変えられる。しないに戻すときは null', () => {
    expect(entryChangesSchema.safeParse({ rrule: { freq: 'daily' } }).success).toBe(true);
    expect(entryChangesSchema.safeParse({ rrule: null }).success).toBe(true);
  });

  it('kind は作成した後に変えられないので通らない', () => {
    expect(entryChangesSchema.safeParse({ kind: 'block' }).success).toBe(false);
  });

  it('id や editedAt のような、変更で指定しない項目は通らない', () => {
    expect(entryChangesSchema.safeParse({ id: 'x' }).success).toBe(false);
    expect(entryChangesSchema.safeParse({ editedAt: 1 }).success).toBe(false);
  });

  it('項目の値が不正だと通らない', () => {
    expect(entryChangesSchema.safeParse({ startTime: '10:10' }).success).toBe(false);
  });
});

describe('RP-4: 変更・削除の範囲', () => {
  it.each(['this', 'following', 'all'])('%s は通る', (value) => {
    expect(scopeSchema.safeParse(value).success).toBe(true);
  });

  it('それ以外は通らない', () => {
    expect(scopeSchema.safeParse('both').success).toBe(false);
  });
});
