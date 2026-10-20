import type { WriteResponse } from '../../shared/api';
import type { Entry } from '../../shared/schema';
import { applyWrite, readWorkspaces, type Database, type WriteRequest } from '../db/store';
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

/**
 * 予定の行を書く。書く前に、行の確認（entryRules.ts）と、指すワークスペースの確認をする。
 * 組み込みのワークスペースを指す行は、400（WS-4。設計書 4.2）。削除済みのワークスペースを指す行は、書かずに捨てる。
 * 存在しないワークスペースは、ここでは確かめず、外部キー違反（409）に任せる。
 * 削除する行は、ワークスペースを指していても確かめない。
 * 400 を捨てるより先に確かめるのは、依頼そのものの誤りは、保存されているデータの状態によらないため。
 */
export async function commitEntries(
  db: Database,
  entries: readonly Entry[],
  editedAt: number,
): Promise<WriteResponse> {
  assertWritableEntries(entries);
  const workspaceIds = [
    ...new Set(
      entries.flatMap((entry) =>
        entry.deletedAt === null && entry.workspaceId !== null ? [entry.workspaceId] : [],
      ),
    ),
  ];
  const workspaces = await readWorkspaces(db, workspaceIds);
  for (const { workspace } of workspaces.values()) {
    if (workspace.builtin !== null) {
      throw new ApiError(
        400,
        'builtin_workspace',
        `組み込みのワークスペースには、予定を入れられません（workspaceId: ${workspace.id}）`,
      );
    }
  }
  for (const { workspace } of workspaces.values()) {
    if (workspace.deletedAt !== null) return dropped(workspace, editedAt);
  }
  return commit(db, { entries });
}
