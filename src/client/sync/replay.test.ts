import { describe, expect, it } from 'vitest';
import { makeEntry } from '../../../test/helpers/entries';
import { makeWorkspace } from '../../../test/helpers/workspaces';
import type { Entry, EntryDraft, Workspace } from '../../shared/schema';
import type { PendingRequest } from './requests';
import { replayRequests, writeOfRequest, type RowSet } from './replay';

function rowsOf(workspaces: Workspace[], entries: Entry[]): RowSet {
  return {
    workspaces: new Map(workspaces.map((workspace) => [workspace.id, workspace])),
    entries: new Map(entries.map((entry) => [entry.id, entry])),
  };
}

function draft(overrides: Partial<EntryDraft> = {}): EntryDraft {
  return {
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
    notifyEnabled: true,
    notifyOffsetMin: 10,
    ...overrides,
  };
}

function putEntry(
  id: string,
  editedAt: number,
  overrides: Partial<EntryDraft> = {},
): PendingRequest {
  return { type: 'putEntry', targetId: id, body: { draft: draft(overrides), editedAt } };
}

function patchEntry(
  targetId: string,
  editedAt: number,
  rest: {
    occurrenceDate?: string;
    scope?: 'this' | 'following' | 'all';
    changes?: Extract<PendingRequest, { type: 'patchEntry' }>['body']['changes'];
    newId?: string;
  } = {},
): PendingRequest {
  return {
    type: 'patchEntry',
    targetId,
    body: {
      occurrenceDate: rest.occurrenceDate ?? '2026-10-19',
      scope: rest.scope ?? 'all',
      changes: rest.changes ?? {},
      newId: rest.newId ?? 'new1',
      editedAt,
    },
  };
}

function deleteEntry(
  targetId: string,
  editedAt: number,
  rest: { occurrenceDate?: string; scope?: 'this' | 'following' | 'all'; newId?: string } = {},
): PendingRequest {
  return {
    type: 'deleteEntry',
    targetId,
    body: {
      occurrenceDate: rest.occurrenceDate ?? '2026-10-19',
      scope: rest.scope ?? 'all',
      newId: rest.newId ?? 'new1',
      editedAt,
    },
  };
}

const w1 = makeWorkspace({ id: 'w1', editedAt: 100 });

describe('送信待ちの依頼のやり直し（設計書 6.4）', () => {
  it('依頼がなければ、サーバーから受け取った内容をそのまま返す', () => {
    const base = rowsOf([w1], [makeEntry({ id: 'e1' })]);
    expect(replayRequests(base, [])).toBe(base);
  });

  it('依頼をやり直しても、サーバーから受け取った内容は書き換えない', () => {
    const base = rowsOf([w1], [makeEntry({ id: 'e1', editedAt: 1000 })]);

    const result = replayRequests(base, [putEntry('e2', 2000), deleteEntry('e1', 2001)]);

    expect(result.entries.get('e2')?.title).toBe('歯医者');
    expect(result.entries.get('e1')?.deletedAt).toBe(2001);
    expect([...base.entries.keys()]).toEqual(['e1']);
    expect(base.entries.get('e1')?.deletedAt).toBeNull();
  });

  it('先の依頼が作った行を、後の依頼が対象にできる（作る → 変える → 消す）', () => {
    const base = rowsOf([w1], []);

    const afterChange = replayRequests(base, [
      putEntry('e1', 2000),
      patchEntry('e1', 2001, { changes: { title: '歯科' } }),
    ]);
    expect(afterChange.entries.get('e1')?.title).toBe('歯科');

    const afterDelete = replayRequests(base, [
      putEntry('e1', 2000),
      patchEntry('e1', 2001, { changes: { title: '歯科' } }),
      deleteEntry('e1', 2002),
    ]);
    expect(afterDelete.entries.get('e1')).toMatchObject({ title: '歯科', deletedAt: 2002 });
  });

  describe('予定の作成（PUT）', () => {
    it('下書きから行を作る。繰り返すなら、開始日をルールに合う日にずらす（サーバーと同じ計算）', () => {
      // 2026-10-19 は月曜。毎週 水 なので、21 日（水）にずれる。
      const result = replayRequests(rowsOf([w1], []), [
        putEntry('e1', 2000, { rrule: { freq: 'weekly', days: [3] } }),
      ]);
      expect(result.entries.get('e1')).toMatchObject({
        startDate: '2026-10-21',
        endDate: '2026-10-21',
        editedAt: 2000,
        deletedAt: null,
      });
    });

    it('同じ id の行がすでにあるときは、上書きせずに当てない（サーバーは書かない）', () => {
      const existing = makeEntry({ id: 'e1', title: '先にあった', editedAt: 1000 });
      const write = writeOfRequest(rowsOf([w1], [existing]), putEntry('e1', 2000));
      expect(write).toBeNull();
    });

    it('同じ id の削除済みの行がすでにあるときも、生き返らせずに当てない', () => {
      const deleted = makeEntry({ id: 'e1', editedAt: 1000, deletedAt: 1000 });
      expect(writeOfRequest(rowsOf([w1], [deleted]), putEntry('e1', 2000))).toBeNull();
    });

    it('削除済みのワークスペースを指すときは、当てない（サーバーは捨てる）', () => {
      const gone = makeWorkspace({ id: 'w1', editedAt: 100, deletedAt: 100 });
      expect(writeOfRequest(rowsOf([gone], []), putEntry('e1', 2000))).toBeNull();
    });

    it('存在しないワークスペースを指すときも、当てない（サーバーは 409）', () => {
      expect(writeOfRequest(rowsOf([], []), putEntry('e1', 2000))).toBeNull();
    });

    it('タイムブロック（ワークスペースを指さない）は、ワークスペースがなくても当てる', () => {
      const write = writeOfRequest(
        rowsOf([], []),
        putEntry('b1', 2000, { kind: 'block', workspaceId: null }),
      );
      expect(write?.entries.map((entry) => entry.id)).toEqual(['b1']);
    });

    it('日付の計算が対応する年を出るときは、当てない（サーバーは 400）', () => {
      // 2199-12-31 から始まる「平日」は、開始日を 2200 年へずらす途中で、祝日の計算が RangeError を投げる。
      const request = putEntry('e1', 2000, {
        allDay: true,
        startTime: null,
        endTime: null,
        startDate: '2199-12-31',
        endDate: '2199-12-31',
        rrule: { freq: 'weekday' },
      });
      expect(writeOfRequest(rowsOf([w1], []), request)).toBeNull();
    });
  });

  describe('予定の変更（PATCH）', () => {
    const series = makeEntry({
      id: 's1',
      title: '毎日',
      rrule: { freq: 'daily' },
      startDate: '2026-10-19',
      editedAt: 1000,
    });

    it('「この予定のみ」は、例外の行を作る', () => {
      const result = replayRequests(rowsOf([w1], [series]), [
        patchEntry('s1', 2000, {
          scope: 'this',
          occurrenceDate: '2026-10-21',
          changes: { title: '休み' },
          newId: 'x1',
        }),
      ]);
      expect(result.entries.get('x1')).toMatchObject({
        title: '休み',
        seriesId: 's1',
        originalDate: '2026-10-21',
        editedAt: 2000,
      });
      expect(result.entries.get('s1')).toEqual(series);
    });

    it('対象の予定がもうないとき（OccurrenceNotFoundError）は、当てない', () => {
      expect(writeOfRequest(rowsOf([w1], []), patchEntry('s1', 2000))).toBeNull();
    });

    it('削除済みの系列への変更は、当てない', () => {
      const deleted = { ...series, deletedAt: 1500, editedAt: 1500 };
      expect(writeOfRequest(rowsOf([w1], [deleted]), patchEntry('s1', 2000))).toBeNull();
    });

    it('系列の回でない日付への「この予定のみ」は、当てない', () => {
      const request = patchEntry('s1', 2000, { scope: 'this', occurrenceDate: '2026-10-01' });
      expect(writeOfRequest(rowsOf([w1], [series]), request)).toBeNull();
    });

    it('変更の中身が受け付けられないとき（InvalidChangeError）は、当てない', () => {
      const request = patchEntry('s1', 2000, {
        scope: 'this',
        occurrenceDate: '2026-10-21',
        changes: { rrule: { freq: 'weekly', days: [1] } },
        newId: 'x1',
      });
      expect(writeOfRequest(rowsOf([w1], [series]), request)).toBeNull();
    });

    it('サーバーの行の編集時刻が、依頼の編集時刻以上なら、当てない（同じなら、反映済みの 2 回目）', () => {
      const request = patchEntry('s1', 2000, { changes: { title: '変更' } });
      const base = (editedAt: number) => rowsOf([w1], [{ ...series, editedAt }]);

      expect(writeOfRequest(base(2001), request)).toBeNull();
      expect(writeOfRequest(base(2000), request)).toBeNull();
      expect(writeOfRequest(base(1999), request)?.entries[0]?.title).toBe('変更');
    });

    it('書く行のうち 1 行でもサーバーの方が新しければ、依頼全体を当てない（系列だけが切れない）', () => {
      // 「これ以降すべて」の変更は、系列を切り、新しい系列を作り、これ以降の例外を消す。
      // 消す例外の 1 つが、依頼より新しい編集を持っているので、依頼全体を捨てる。
      const exception = makeEntry({
        id: 'x1',
        seriesId: 's1',
        originalDate: '2026-10-25',
        editedAt: 9000,
      });
      const request = patchEntry('s1', 2000, {
        scope: 'following',
        occurrenceDate: '2026-10-22',
        changes: { title: '変更' },
        newId: 'n1',
      });

      expect(writeOfRequest(rowsOf([w1], [series, exception]), request)).toBeNull();
    });

    it('新しい系列の id が、保存されている別の行とぶつかるときは、当てない', () => {
      const other = makeEntry({ id: 'n1', title: '別の予定', editedAt: 100 });
      const request = patchEntry('s1', 2000, {
        scope: 'following',
        occurrenceDate: '2026-10-22',
        changes: { title: '変更' },
        newId: 'n1',
      });
      expect(writeOfRequest(rowsOf([w1], [series, other]), request)).toBeNull();
    });

    it('「この予定のみ」の 2 回目は、前の例外の行を書き換える（同じ回の例外の行は、id のぶつかりではない）', () => {
      const first = patchEntry('s1', 2000, {
        scope: 'this',
        occurrenceDate: '2026-10-21',
        changes: { title: '1 回目' },
        newId: 'x1',
      });
      const second = patchEntry('s1', 2001, {
        scope: 'this',
        occurrenceDate: '2026-10-21',
        changes: { title: '2 回目' },
        newId: 'x2',
      });

      const result = replayRequests(rowsOf([w1], [series]), [first, second]);

      expect(result.entries.get('x1')).toMatchObject({ title: '2 回目', editedAt: 2001 });
      expect(result.entries.has('x2')).toBe(false);
    });

    it('同じ依頼を 2 回重ねても、2 回目は当てない（結果は変わらない）', () => {
      const request = patchEntry('s1', 2000, { changes: { title: '変更' } });
      const once = replayRequests(rowsOf([w1], [series]), [request]);
      const twice = replayRequests(rowsOf([w1], [series]), [request, request]);
      expect(twice.entries).toEqual(once.entries);
    });
  });

  describe('予定の削除（DELETE）', () => {
    const series = makeEntry({
      id: 's1',
      rrule: { freq: 'daily' },
      startDate: '2026-10-19',
      editedAt: 1000,
    });

    it('「すべて」は、系列とその例外を、論理削除した行にする', () => {
      const exception = makeEntry({
        id: 'x1',
        seriesId: 's1',
        originalDate: '2026-10-21',
        editedAt: 1000,
      });
      const result = replayRequests(rowsOf([w1], [series, exception]), [deleteEntry('s1', 3000)]);
      expect(result.entries.get('s1')).toMatchObject({ deletedAt: 3000, editedAt: 3000 });
      expect(result.entries.get('x1')).toMatchObject({ deletedAt: 3000, editedAt: 3000 });
    });

    it('「この予定のみ」は、その回を削除した例外の行（cancelled）を作る', () => {
      const result = replayRequests(rowsOf([w1], [series]), [
        deleteEntry('s1', 3000, { scope: 'this', occurrenceDate: '2026-10-21', newId: 'x1' }),
      ]);
      expect(result.entries.get('x1')).toMatchObject({
        seriesId: 's1',
        originalDate: '2026-10-21',
        cancelled: true,
      });
    });

    it('同じ削除を 2 回重ねても、2 回目は当てない（削除済みの系列が対象になる）', () => {
      const first = replayRequests(rowsOf([w1], [series]), [deleteEntry('s1', 3000)]);
      expect(writeOfRequest(first, deleteEntry('s1', 3000))).toBeNull();
    });

    it('対象がもうないときは、当てない', () => {
      expect(writeOfRequest(rowsOf([w1], []), deleteEntry('s1', 3000))).toBeNull();
    });
  });

  describe('ワークスペースの作成・更新（PUT）', () => {
    function putWorkspace(workspace: Workspace): PendingRequest {
      return { type: 'putWorkspace', body: { workspace: { ...workspace, deletedAt: null } } };
    }

    it('新しいワークスペースを追加する', () => {
      const created = makeWorkspace({ id: 'w2', name: '私用', editedAt: 2000 });
      const result = replayRequests(rowsOf([w1], []), [putWorkspace(created)]);
      expect(result.workspaces.get('w2')).toEqual(created);
    });

    it('サーバーの行より新しければ更新し、同じか古ければ当てない', () => {
      const update = (editedAt: number) =>
        putWorkspace(makeWorkspace({ id: 'w1', name: '新しい名前', editedAt }));

      expect(writeOfRequest(rowsOf([w1], []), update(101))?.workspaces[0]?.name).toBe('新しい名前');
      expect(writeOfRequest(rowsOf([w1], []), update(100))).toBeNull();
      expect(writeOfRequest(rowsOf([w1], []), update(99))).toBeNull();
    });

    it('削除済みのワークスペースの更新は、生き返らせずに当てない', () => {
      const gone = makeWorkspace({ id: 'w1', editedAt: 100, deletedAt: 100 });
      const request = putWorkspace(makeWorkspace({ id: 'w1', editedAt: 2000 }));
      expect(writeOfRequest(rowsOf([gone], []), request)).toBeNull();
    });
  });

  describe('ワークスペースの削除（DELETE）', () => {
    const w2 = makeWorkspace({ id: 'w2', editedAt: 100 });
    const deleteWs = (targetId: string, editedAt: number): PendingRequest => ({
      type: 'deleteWorkspace',
      targetId,
      body: { editedAt },
    });

    it('ワークスペースと、その中の予定（系列・例外を含む）を、論理削除した行にする', () => {
      const plain = makeEntry({ id: 'plain', workspaceId: 'w1', editedAt: 1000 });
      const series = makeEntry({
        id: 's1',
        workspaceId: 'w1',
        rrule: { freq: 'daily' },
        editedAt: 1000,
      });
      const exception = makeEntry({
        id: 'x1',
        workspaceId: 'w1',
        seriesId: 's1',
        originalDate: '2026-10-20',
        editedAt: 1000,
      });
      const outside = makeEntry({ id: 'outside', workspaceId: 'w2', editedAt: 1000 });

      const result = replayRequests(rowsOf([w1, w2], [plain, series, exception, outside]), [
        deleteWs('w1', 5000),
      ]);

      expect(result.workspaces.get('w1')).toMatchObject({ deletedAt: 5000, editedAt: 5000 });
      expect(result.entries.get('plain')?.deletedAt).toBe(5000);
      expect(result.entries.get('s1')?.deletedAt).toBe(5000);
      expect(result.entries.get('x1')?.deletedAt).toBe(5000);
      expect(result.entries.get('outside')).toEqual(outside);
    });

    it('別のワークスペースの系列の例外が、このワークスペースを指しているときは、その回を削除した形にして、系列のワークスペースに戻す', () => {
      const series = makeEntry({
        id: 's1',
        workspaceId: 'w1',
        rrule: { freq: 'daily' },
        editedAt: 1000,
      });
      const moved = makeEntry({
        id: 'x1',
        workspaceId: 'w2',
        seriesId: 's1',
        originalDate: '2026-10-20',
        startDate: '2026-10-25',
        editedAt: 1000,
      });

      const result = replayRequests(rowsOf([w1, w2], [series, moved]), [deleteWs('w2', 5000)]);

      expect(result.entries.get('x1')).toMatchObject({
        cancelled: true,
        workspaceId: 'w1',
        deletedAt: null,
        editedAt: 5000,
      });
      expect(result.entries.get('s1')).toEqual(series);
    });

    it('存在しない・削除済みのワークスペースの削除は、当てない', () => {
      const gone = makeWorkspace({ id: 'w1', editedAt: 100, deletedAt: 100 });
      expect(writeOfRequest(rowsOf([], []), deleteWs('w1', 5000))).toBeNull();
      expect(writeOfRequest(rowsOf([gone], []), deleteWs('w1', 5000))).toBeNull();
    });

    it('ワークスペースの行が、依頼より新しい（または同じ）ときは、当てない', () => {
      expect(writeOfRequest(rowsOf([w1], []), deleteWs('w1', 100))).toBeNull();
      expect(writeOfRequest(rowsOf([w1], []), deleteWs('w1', 99))).toBeNull();
    });

    it('中の予定の 1 行でも、依頼より新しい編集があれば、依頼全体を当てない（ワークスペースも消えない）', () => {
      const newer = makeEntry({ id: 'e1', workspaceId: 'w1', editedAt: 9000 });
      expect(writeOfRequest(rowsOf([w1], [newer]), deleteWs('w1', 5000))).toBeNull();
    });
  });
});
