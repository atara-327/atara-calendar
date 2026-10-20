import { Hono } from 'hono';
import { deleteWorkspaceRequestSchema, putWorkspaceRequestSchema } from '../../shared/api';
import type { Workspace } from '../../shared/schema';
import { deleteWorkspace } from '../../shared/workspace';
import { countLiveUserWorkspaces, readWorkspaceEntries, readWorkspaces } from '../db/store';
import type { AppEnv } from '../env';
import { ApiError, badRequest } from './errors';
import { assertEditedAtNotInFuture, parseBody, parseId } from './request';
import { commit, dropped } from './write';

/**
 * 組み込みのワークスペース（WS-4）の保護。変えてよいのは visible と sortOrder だけ（設計書 4.2）。
 * 組み込みの印（builtin）は、付けることも外すことも、組み込みの印が付いた新しい行を作ることも禁じる。
 * DB への書き込み（store.ts）で禁じないのは、表示の ON/OFF のように、組み込みの行にも書く変更が、同じ書き込みを通るため。
 */
function assertBuiltinRules(existing: Workspace | undefined, next: Workspace): void {
  if (existing === undefined) {
    if (next.builtin !== null) {
      throw new ApiError(
        400,
        'builtin_workspace',
        '組み込みの印が付いたワークスペースは作れません',
      );
    }
    return;
  }
  if (next.builtin !== existing.builtin) {
    throw new ApiError(400, 'builtin_workspace', '組み込みの印は付けたり外したりできません');
  }
  if (existing.builtin !== null && (next.name !== existing.name || next.color !== existing.color)) {
    throw new ApiError(
      400,
      'builtin_workspace',
      '組み込みのワークスペースの名前と色は変えられません',
    );
  }
}

export const workspacesRoute = new Hono<AppEnv>();

workspacesRoute.put('/:id', async (c) => {
  const id = parseId(c.req.param('id'));
  const { workspace } = await parseBody(c, putWorkspaceRequestSchema);
  if (workspace.id !== id) throw badRequest('本文のワークスペースの id が、URL の id と違います');
  assertEditedAtNotInFuture(workspace.editedAt);

  const db = c.env.DB;
  const existing = (await readWorkspaces(db, [id])).get(id)?.workspace;
  // 削除済みのワークスペースは、更新で生き返らせない。削除は、中の予定もまとめて消しているので、
  // 空のワークスペースだけが戻ることになる。
  if (existing !== undefined && existing.deletedAt !== null) {
    return c.json(dropped(existing, workspace.editedAt));
  }
  assertBuiltinRules(existing, workspace);
  return c.json(await commit(db, { workspaces: [workspace] }));
});

workspacesRoute.delete('/:id', async (c) => {
  const id = parseId(c.req.param('id'));
  const { editedAt } = await parseBody(c, deleteWorkspaceRequestSchema);
  assertEditedAtNotInFuture(editedAt);

  const db = c.env.DB;
  const existing = (await readWorkspaces(db, [id])).get(id)?.workspace;
  if (existing === undefined || existing.deletedAt !== null) {
    return c.json(dropped(existing, editedAt));
  }
  if (existing.builtin !== null) {
    throw new ApiError(400, 'builtin_workspace', '組み込みのワークスペースは削除できません');
  }
  // 予定はワークスペースに必ず属するので、1 つもなくなると、予定を作れなくなる（設計書 11.5）。
  if ((await countLiveUserWorkspaces(db, id)) === 0) {
    throw new ApiError(400, 'last_workspace', '最後のワークスペースは削除できません');
  }

  const inside = await readWorkspaceEntries(db, id);
  const deleted = deleteWorkspace({
    workspace: existing,
    entries: inside.map(({ entry }) => entry),
    editedAt,
  });
  return c.json(await commit(db, { workspaces: [deleted.workspace], entries: deleted.entries }));
});
