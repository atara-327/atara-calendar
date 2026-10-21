import { z } from 'zod';
import { namedDateSchema } from './holidays';
import { occurrenceSchema } from './recurrence';
import {
  editedAtSchema,
  entryChangesInputSchema,
  entryDraftInputSchema,
  entrySchema,
  idInputSchema,
  inputDateSchema,
  scopeSchema,
  workspaceInputSchema,
  workspaceSchema,
} from './schema';

// API（設計書 5.1）の、依頼の本文と応答の形。画面（同期）と Worker が、同じ定義を使う。

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

// 応答の型も、Zod のスキーマから導く。厳密（strictObject）にしないのは、サーバーが後から項目を足したときに、
// 古い画面が、応答を読めなくならないため。
// このスキーマは、応答の形（型）を表す。実行時に応答を確かめる（画面の同期）のに、そのまま使わないこと。
// 行の部分が entrySchema・workspaceSchema なので、入力のルール（時刻は 15 分刻み、色は #RRGGBB など）を含み、
// ルールを満たさない行が DB に 1 つあるだけで、応答全体が失敗し、全端末の受け取りが止まる（設計書 6.3 が避けている状態）。
// 実行時に確かめるのは、構造だけを見る structure.ts の structuralChangesResponseSchema。

/**
 * GET /api/changes の応答。行ごとの rev と nextNotifyAt は、サーバーの都合の値なので含めない。
 * rev は、端末が「最後に受け取った rev」として覚える唯一の値（設計書 6.3）。
 */
export const changesResponseSchema = z.object({
  rev: z.number().int(),
  epoch: z.string(),
  workspaces: z.array(workspaceSchema),
  entries: z.array(entrySchema),
});

export type ChangesResponse = z.infer<typeof changesResponseSchema>;

/**
 * 書き込みの応答。rev は返さない。端末が、受け取り（GET /api/changes）の rev と取り違えて、他の端末の
 * 行を取りこぼさないため（設計書 6.3）。
 * 捨てた理由は、stale（依頼より新しい、または同じ編集がある。同じ依頼の 2 回目を含む）と、
 * not_found（対象の予定・回・ワークスペースがもうない）。どちらも、端末は依頼を列から外して次へ進む（設計書 6.2）。
 */
export const writeDropReasonSchema = z.enum(['stale', 'not_found']);

export type WriteDropReason = z.infer<typeof writeDropReasonSchema>;

export const writeResponseSchema = z.discriminatedUnion('applied', [
  z.object({ applied: z.literal(true) }),
  z.object({ applied: z.literal(false), reason: writeDropReasonSchema }),
]);

export type WriteResponse = z.infer<typeof writeResponseSchema>;

/** GET /api/occurrences で、1 回に指定できる期間の最大日数（両端を含む）。理由は設計書 5.1。 */
export const MAX_OCCURRENCES_DAYS = 31;

export const occurrencesResponseSchema = z.object({
  occurrences: z.array(occurrenceSchema),
  holidays: z.array(namedDateSchema),
  observances: z.array(namedDateSchema),
});

export type OccurrencesResponse = z.infer<typeof occurrencesResponseSchema>;

/** 種類は、端末が判断に使える固定の文字列。文言は固定で、入力の中身や内部の情報は入れない（設計書 5.1）。 */
export const apiErrorKindSchema = z.enum([
  'invalid_request',
  'invalid_change',
  'builtin_workspace',
  'last_workspace',
  'edited_at_in_future',
  'conflict',
  'not_found',
  'internal_error',
]);

export type ApiErrorKind = z.infer<typeof apiErrorKindSchema>;

export const apiErrorBodySchema = z.object({ error: apiErrorKindSchema, message: z.string() });

export type ApiErrorBody = z.infer<typeof apiErrorBodySchema>;
