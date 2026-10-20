import type { WriteResponse } from '../../shared/api';
import type { Entry } from '../../shared/schema';
import {
  applyWrite,
  readEntry,
  readWorkspaces,
  type Database,
  type WriteRequest,
} from '../db/store';
import { assertWritableEntries } from './entryRules';
import { ApiError } from './errors';

/**
 * 対象がもうなくて、依頼を実行できないときの応答（200 の applied: false。設計書 6.2）。
 * row は、対象の系列やワークスペースの行（見つからなければ undefined）。
 * その行の edited_at が依頼の editedAt 以上なら、依頼より後（または同じ）の編集で対象がなくなったので stale。
 * 同じ依頼の 2 回目も、ここに入る（1 回目の削除や、系列を切る編集が、同じ editedAt の行を残している）。
 * そうでなければ not_found。
 * Why: 同じ依頼の 2 回目を、削除でも変更でも stale にそろえるため。対象がないことだけで not_found にすると、
 * 削除を 2 回送ったとき（2 回目は削除済みの系列が対象）だけ、理由が変わってしまう。
 */
export function dropped(row: { editedAt: number } | undefined, editedAt: number): WriteResponse {
  return {
    applied: false,
    reason: row !== undefined && row.editedAt >= editedAt ? 'stale' : 'not_found',
  };
}

/** 書き込む。応答に rev を入れないのは、端末が、受け取りの rev と取り違えないため（store.ts の WriteResult）。 */
export async function commit(db: Database, request: WriteRequest): Promise<WriteResponse> {
  const result = await applyWrite(db, request);
  return result.applied ? { applied: true } : { applied: false, reason: 'stale' };
}

/** 新しい行の id（newId）と、すでに読み込んである行（系列の行とその例外の行。削除済みを含む。なければ空）。 */
export interface NewIdContext {
  newId: string;
  loaded: readonly Entry[];
}

/** 同じ回の例外の行か（どちらも例外の行で、系列と回の日付が同じ）。 */
function isSameException(stored: Entry, written: Entry): boolean {
  return (
    stored.seriesId !== null &&
    stored.seriesId === written.seriesId &&
    stored.originalDate === written.originalDate
  );
}

/**
 * 新しい行の id（newId）が、保存されている別の行とぶつかっていたら、書かずに捨てる（stale）か、409 にする。
 * ぶつかっていなければ null。
 * 同じ id の行は、同じ依頼の 2 回目でなければ、別の行とぶつかったもの。上書きすると、例外の行を残したまま
 * 系列が繰り返さなくなる、例外の行が単独の予定になって同じ回が二重に出る、削除した行が生き返る、という
 * 画面から直せない壊れ方をする（設計書 5.1）。
 * 保存されている行の edited_at が依頼の editedAt 以上なら stale（同じ依頼の 2 回目は、ここに入る）。そうでなければ 409。
 * 同じ回の例外の行（isSameException）は、ぶつかりではない。「この予定のみ」の 2 回目は、originalDate で
 * 既存の例外を見つけて、その id（1 回目の newId）の行を計算する。削除済みの例外を作り直す場合も同じ。
 * これらは applyWrite の edited_at の比較に任せる。
 * 保存されている行は、読み込み済みの行から探し、なければ id で読む。
 */
async function checkNewId(
  db: Database,
  entries: readonly Entry[],
  { newId, loaded }: NewIdContext,
  editedAt: number,
): Promise<WriteResponse | null> {
  const written = entries.find((entry) => entry.id === newId);
  if (written === undefined) return null;
  const stored = loaded.find((entry) => entry.id === newId) ?? (await readEntry(db, newId))?.entry;
  if (stored === undefined || isSameException(stored, written)) return null;
  if (stored.editedAt >= editedAt) return { applied: false, reason: 'stale' };
  throw new ApiError(
    409,
    'conflict',
    `新しい行の id が、保存されている別の行と重なっています（id: ${newId}）`,
  );
}

/**
 * 予定の行を書く。書く前に、行の確認（entryRules.ts）と、新しい行の id のぶつかりの確認（checkNewId）と、
 * 指すワークスペースの確認をする。
 * 存在しないワークスペースは 409、組み込みのワークスペースを指す行は 400（WS-4。設計書 4.2）。
 * 削除済みのワークスペースを指す行は、書かずに捨てる。削除する行は、ワークスペースを指していても確かめない。
 * 409 と 400 を、捨てるより先に確かめるのは、依頼そのものの誤りは、保存されているデータの状態によらないため。
 * 存在しないワークスペースを、外部キー違反（errors.ts）に任せず、ここで確かめるのは、本番の D1 の
 * エラーの文言が Miniflare と同じかを確かめられず、違うと 500 になって、端末が再送し続けるため。
 */
export async function commitEntries(
  db: Database,
  entries: readonly Entry[],
  editedAt: number,
  newIdContext: NewIdContext,
): Promise<WriteResponse> {
  assertWritableEntries(entries);
  const collision = await checkNewId(db, entries, newIdContext, editedAt);
  if (collision !== null) return collision;
  const workspaceIds = [
    ...new Set(
      entries.flatMap((entry) =>
        entry.deletedAt === null && entry.workspaceId !== null ? [entry.workspaceId] : [],
      ),
    ),
  ];
  const workspaces = await readWorkspaces(db, workspaceIds);
  for (const id of workspaceIds) {
    const stored = workspaces.get(id);
    if (stored === undefined) {
      throw new ApiError(409, 'conflict', `存在しないワークスペースです（workspaceId: ${id}）`);
    }
    if (stored.workspace.builtin !== null) {
      throw new ApiError(
        400,
        'builtin_workspace',
        `組み込みのワークスペースには、予定を入れられません（workspaceId: ${id}）`,
      );
    }
  }
  for (const { workspace } of workspaces.values()) {
    if (workspace.deletedAt !== null) return dropped(workspace, editedAt);
  }
  return commit(db, { entries });
}
