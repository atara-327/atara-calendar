import {
  InvalidChangeError,
  OccurrenceNotFoundError,
  changeEntry,
  createEntry,
  deleteEntry,
} from '../../shared/recurrence';
import type { Entry, Workspace } from '../../shared/schema';
import { deleteWorkspace } from '../../shared/workspace';
import type { PendingRequest } from './requests';

// 送信待ちの依頼を、手元の行の上で「やり直す」（設計書 6.4）。画面に出すデータは、サーバーから受け取った
// 内容の上に、まだ受け取りで確かめられていない依頼を、先頭から順に重ねて作る。
// 依頼ごとの計算は、サーバー（worker/api/entries.ts・workspaces.ts・write.ts）と同じにする。
// 同じ依頼を、同じ行に当てたとき、サーバーが書く行と、ここで書く行が一致するため（設計書 5.2）。
// 一致することは、Worker の本物の API と見比べるテスト（replay.equivalence.test.ts）で確かめている。

/** 行の集まり。削除済みの行も、id で持つ（サーバーの食い違いの判定が、削除済みの行の編集時刻も見るため）。 */
export interface RowSet {
  readonly workspaces: ReadonlyMap<string, Workspace>;
  readonly entries: ReadonlyMap<string, Entry>;
}

/** 依頼が書く行。 */
export interface Write {
  workspaces: Workspace[];
  entries: Entry[];
}

/**
 * 今の行の編集時刻が、書く行の編集時刻以上か。サーバーの applyWrite（store.ts）と同じ決め方で、
 * 「以上」にするのは、同じ依頼の 2 回目を、反映済みとして当てないため（設計書 6.2）。
 */
function isStale(
  row: { id: string; editedAt: number },
  current: ReadonlyMap<string, { editedAt: number }>,
): boolean {
  const stored = current.get(row.id);
  return stored !== undefined && stored.editedAt >= row.editedAt;
}

/** 1 行でも、サーバーの方が新しい（または同じ）なら、依頼全体を当てない（設計書 6.4）。 */
function rejectedByEditedAt(write: Write, rows: RowSet): boolean {
  return (
    write.workspaces.some((row) => isStale(row, rows.workspaces)) ||
    write.entries.some((row) => isStale(row, rows.entries))
  );
}

// サーバーの 400 の入力の検証（長さ・年の範囲・項目をまたぐ確認・組み込みのワークスペースの保護・最後の
// 1 つのワークスペースの保護・newId が系列の id と同じ、など）は、ここでは真似ない。
// Why not: その依頼は、送ったときに 4xx で列から外れ、画面からも消える（設計書 6.2）ので、通る依頼だけを
// 正しくやり直せばよい。検証まで真似ると、サーバーと二重に保つ規則が増え、片方だけを直して食い違う。
// 真似るのは、サーバーが 200 で「捨てた」（applied: false）にする場合と、書く行を決める計算だけ。

/** 変更・削除の計算。サーバーが「依頼を捨てる」場合（対象がない・変更の中身が受け付けられない・日付の計算が範囲を出る）は null。 */
function calculate(compute: () => Entry[]): Entry[] | null {
  try {
    return compute();
  } catch (error) {
    if (
      error instanceof OccurrenceNotFoundError ||
      error instanceof InvalidChangeError ||
      error instanceof RangeError
    ) {
      return null;
    }
    // 想定していない例外でも、再投げしない。画面に出すデータの作り直しが止まると、1 つの依頼のために、
    // 画面全体が更新されなくなる。当てなかった依頼は、送られた後に、サーバーの応答で列から外れる。
    console.error('送信待ちの依頼を、手元でやり直せませんでした', error);
    return null;
  }
}

/** 系列の行（または繰り返さない予定の行）と、その例外の行。削除済みを含む。サーバーの readSeriesEntries と同じ範囲。 */
function seriesRows(rows: RowSet, seriesId: string): Entry[] {
  return [...rows.entries.values()].filter(
    (entry) => entry.id === seriesId || entry.seriesId === seriesId,
  );
}

/**
 * ワークスペースの中の、削除されていない予定。サーバーの readWorkspaceEntries（SQL）と同じ範囲。
 * - そのワークスペースを指す予定（系列・例外・繰り返さない予定）
 * - そのワークスペースの（削除されていない）系列の例外。例外の行自身が別のワークスペースを指していても含める
 * - そのワークスペースを指す例外の、系列の行
 */
function workspaceEntries(rows: RowSet, workspaceId: string): Entry[] {
  const live = [...rows.entries.values()].filter((entry) => entry.deletedAt === null);
  const seriesInside = new Set(
    live
      .filter((entry) => entry.seriesId === null && entry.workspaceId === workspaceId)
      .map((entry) => entry.id),
  );
  const seriesOfExceptionsInside = new Set(
    live
      .filter((entry) => entry.seriesId !== null && entry.workspaceId === workspaceId)
      .map((entry) => entry.seriesId),
  );
  return live.filter(
    (entry) =>
      entry.workspaceId === workspaceId ||
      (entry.seriesId !== null && seriesInside.has(entry.seriesId)) ||
      seriesOfExceptionsInside.has(entry.id),
  );
}

/** 同じ回の例外の行か（どちらも例外の行で、系列と回の日付が同じ）。worker/api/write.ts の isSameException と同じ。 */
function isSameException(stored: Entry, written: Entry): boolean {
  return (
    stored.seriesId !== null &&
    stored.seriesId === written.seriesId &&
    stored.originalDate === written.originalDate
  );
}

/**
 * 予定の行を書く（サーバーの commitEntries と同じ決め方）。次の場合は、書かずに null にする。
 * - 新しい行の id が、保存されている別の行とぶつかる（同じ回の例外の行は、ぶつかりではない）。
 *   サーバーは、その行が依頼より新しければ stale、古ければ 409 で、どちらも書かない。
 * - 削除されていない行が指すワークスペースが、削除済み、または見つからない。サーバーは、削除済みなら
 *   捨て、存在しなければ 409 にする。どちらも書かない。
 * - 1 行でも、サーバーの方が新しい（または同じ）。
 */
function entryWrite(rows: RowSet, written: Entry[], newId: string): Write | null {
  const created = written.find((entry) => entry.id === newId);
  const stored = rows.entries.get(newId);
  if (created !== undefined && stored !== undefined && !isSameException(stored, created)) {
    return null;
  }
  for (const entry of written) {
    if (entry.deletedAt !== null || entry.workspaceId === null) continue;
    const workspace = rows.workspaces.get(entry.workspaceId);
    if (workspace === undefined || workspace.deletedAt !== null) return null;
  }
  const write: Write = { workspaces: [], entries: written };
  return rejectedByEditedAt(write, rows) ? null : write;
}

/**
 * 依頼 1 つが、今の行に当たったときに書く行。サーバーが捨てる場合は null（何も書かない）。
 * rows は書き換えない。
 */
export function writeOfRequest(rows: RowSet, request: PendingRequest): Write | null {
  switch (request.type) {
    case 'putWorkspace': {
      const { workspace } = request.body;
      // 削除済みのワークスペースは、更新で生き返らせない（サーバーと同じ。設計書 5.1）。
      const existing = rows.workspaces.get(workspace.id);
      if (existing !== undefined && existing.deletedAt !== null) return null;
      const write: Write = { workspaces: [workspace], entries: [] };
      return rejectedByEditedAt(write, rows) ? null : write;
    }
    case 'deleteWorkspace': {
      const existing = rows.workspaces.get(request.targetId);
      if (existing === undefined || existing.deletedAt !== null) return null;
      const deleted = deleteWorkspace({
        workspace: existing,
        entries: workspaceEntries(rows, existing.id),
        editedAt: request.body.editedAt,
      });
      const write: Write = { workspaces: [deleted.workspace], entries: deleted.entries };
      return rejectedByEditedAt(write, rows) ? null : write;
    }
    case 'putEntry': {
      const { draft, editedAt } = request.body;
      const written = calculate(() => createEntry({ draft, newId: request.targetId, editedAt }));
      return written === null ? null : entryWrite(rows, written, request.targetId);
    }
    case 'patchEntry': {
      const { occurrenceDate, scope, changes, newId, editedAt } = request.body;
      const entries = seriesRows(rows, request.targetId);
      const written = calculate(() =>
        changeEntry({
          entries,
          target: { seriesId: request.targetId, occurrenceDate },
          scope,
          changes,
          newId,
          editedAt,
        }),
      );
      return written === null ? null : entryWrite(rows, written, newId);
    }
    case 'deleteEntry': {
      const { occurrenceDate, scope, newId, editedAt } = request.body;
      const entries = seriesRows(rows, request.targetId);
      const written = calculate(() =>
        deleteEntry({
          entries,
          target: { seriesId: request.targetId, occurrenceDate },
          scope,
          newId,
          editedAt,
        }),
      );
      return written === null ? null : entryWrite(rows, written, newId);
    }
  }
}

/**
 * base の上に、依頼を先頭から順にやり直した結果。base は書き換えない。
 * 依頼が 1 つもなければ、base をそのまま返す（行の集まりを複製しない）。
 */
export function replayRequests(base: RowSet, requests: readonly PendingRequest[]): RowSet {
  if (requests.length === 0) return base;
  const rows = { workspaces: new Map(base.workspaces), entries: new Map(base.entries) };
  for (const request of requests) {
    const write = writeOfRequest(rows, request);
    if (write === null) continue;
    for (const workspace of write.workspaces) rows.workspaces.set(workspace.id, workspace);
    for (const entry of write.entries) rows.entries.set(entry.id, entry);
  }
  return rows;
}
