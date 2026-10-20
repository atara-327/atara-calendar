import { z } from 'zod';
import type { NamedDate } from './holidays';
import type { Occurrence } from './recurrence';
import {
  editedAtSchema,
  entryChangesInputSchema,
  entryDraftInputSchema,
  idInputSchema,
  inputDateSchema,
  scopeSchema,
  workspaceInputSchema,
  type Entry,
  type Workspace,
} from './schema';

// API（設計書 5.1）の、依頼の本文と応答の形。画面（同期。実装 #6）と Worker が、同じ定義を使う。

export const putWorkspaceRequestSchema = z.strictObject({ workspace: workspaceInputSchema });

export const deleteWorkspaceRequestSchema = z.strictObject({ editedAt: editedAtSchema });

export const putEntryRequestSchema = z.strictObject({
  draft: entryDraftInputSchema,
  editedAt: editedAtSchema,
});

/** changes は、ユーザーが変えた項目だけ（設計書 4.5）。newId は、「この予定のみ」「これ以降すべて」で作る新しい行の id。 */
export const patchEntryRequestSchema = z.strictObject({
  occurrenceDate: inputDateSchema,
  scope: scopeSchema,
  changes: entryChangesInputSchema,
  newId: idInputSchema,
  editedAt: editedAtSchema,
});

export const deleteEntryRequestSchema = z.strictObject({
  occurrenceDate: inputDateSchema,
  scope: scopeSchema,
  newId: idInputSchema,
  editedAt: editedAtSchema,
});

export type PutWorkspaceRequest = z.infer<typeof putWorkspaceRequestSchema>;
export type DeleteWorkspaceRequest = z.infer<typeof deleteWorkspaceRequestSchema>;
export type PutEntryRequest = z.infer<typeof putEntryRequestSchema>;
export type PatchEntryRequest = z.infer<typeof patchEntryRequestSchema>;
export type DeleteEntryRequest = z.infer<typeof deleteEntryRequestSchema>;

/**
 * GET /api/changes の応答。行ごとの rev と nextNotifyAt は、サーバーの都合の値なので含めない。
 * rev は、端末が「最後に受け取った rev」として覚える唯一の値（設計書 6.3）。
 */
export interface ChangesResponse {
  rev: number;
  epoch: string;
  workspaces: Workspace[];
  entries: Entry[];
}

/**
 * 書き込みの応答。rev は返さない。端末が、受け取り（GET /api/changes）の rev と取り違えて、他の端末の
 * 行を取りこぼさないため（設計書 6.3）。
 * 捨てた理由は、stale（依頼より新しい、または同じ編集がある。同じ依頼の 2 回目を含む）と、
 * not_found（対象の予定・回・ワークスペースがもうない）。どちらも、端末は依頼を列から外して次へ進む（設計書 6.2）。
 */
export type WriteDropReason = 'stale' | 'not_found';

export type WriteResponse = { applied: true } | { applied: false; reason: WriteDropReason };

/** GET /api/occurrences で、1 回に指定できる期間の最大日数（両端を含む）。理由は設計書 5.1。 */
export const MAX_OCCURRENCES_DAYS = 31;

export interface OccurrencesResponse {
  occurrences: Occurrence[];
  holidays: NamedDate[];
  observances: NamedDate[];
}

/** 種類は、端末が判断に使える固定の文字列。文言は固定で、入力の中身や内部の情報は入れない（設計書 5.1）。 */
export type ApiErrorKind =
  | 'invalid_request'
  | 'invalid_change'
  | 'builtin_workspace'
  | 'last_workspace'
  | 'edited_at_in_future'
  | 'conflict'
  | 'internal_error';

export interface ApiErrorBody {
  error: ApiErrorKind;
  message: string;
}
