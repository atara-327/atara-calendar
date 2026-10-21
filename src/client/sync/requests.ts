import { z } from 'zod';
import {
  deleteEntryRequestSchema,
  deleteWorkspaceRequestSchema,
  patchEntryRequestSchema,
  putEntryRequestSchema,
  putWorkspaceRequestSchema,
} from '../../shared/api';
import { idInputSchema } from '../../shared/schema';

// 送信待ちの依頼（設計書 6.2）。中身は、API の依頼の本文（shared/api.ts）と、対象の id。
// 本文のスキーマは、サーバーが受け取るときと同じものを使う。IndexedDB から読んだ依頼を、このスキーマで
// 確かめれば、形の合わない依頼（古い版の画面が保存したものなど）を、送る前に見つけられる。

export const pendingRequestSchema = z.discriminatedUnion('type', [
  // ワークスペースの PUT は、対象の id が本文（workspace.id）にあるので、targetId を持たない。
  z.strictObject({ type: z.literal('putWorkspace'), body: putWorkspaceRequestSchema }),
  z.strictObject({
    type: z.literal('deleteWorkspace'),
    targetId: idInputSchema,
    body: deleteWorkspaceRequestSchema,
  }),
  z.strictObject({
    type: z.literal('putEntry'),
    targetId: idInputSchema,
    body: putEntryRequestSchema,
  }),
  // PATCH・DELETE の targetId は、系列の id（繰り返さない予定なら自分の id）。
  z.strictObject({
    type: z.literal('patchEntry'),
    targetId: idInputSchema,
    body: patchEntryRequestSchema,
  }),
  z.strictObject({
    type: z.literal('deleteEntry'),
    targetId: idInputSchema,
    body: deleteEntryRequestSchema,
  }),
]);

export type PendingRequest = z.infer<typeof pendingRequestSchema>;

/** 依頼の編集時刻。送る順番（端末全体で単調に増えるので、作った順になる）と、時計の初期化に使う。 */
export function editedAtOf(request: PendingRequest): number {
  return request.type === 'putWorkspace' ? request.body.workspace.editedAt : request.body.editedAt;
}

export interface HttpRequest {
  method: 'PUT' | 'PATCH' | 'DELETE';
  url: string;
  body: unknown;
}

/** 依頼を、API の呼び出し（設計書 5.1）に直す。同じオリジンの /api/... を指す。 */
export function toHttpRequest(request: PendingRequest): HttpRequest {
  switch (request.type) {
    case 'putWorkspace':
      return {
        method: 'PUT',
        url: `/api/workspaces/${encodeURIComponent(request.body.workspace.id)}`,
        body: request.body,
      };
    case 'deleteWorkspace':
      return {
        method: 'DELETE',
        url: `/api/workspaces/${encodeURIComponent(request.targetId)}`,
        body: request.body,
      };
    case 'putEntry':
      return {
        method: 'PUT',
        url: `/api/entries/${encodeURIComponent(request.targetId)}`,
        body: request.body,
      };
    case 'patchEntry':
      return {
        method: 'PATCH',
        url: `/api/entries/${encodeURIComponent(request.targetId)}`,
        body: request.body,
      };
    case 'deleteEntry':
      return {
        method: 'DELETE',
        url: `/api/entries/${encodeURIComponent(request.targetId)}`,
        body: request.body,
      };
  }
}
