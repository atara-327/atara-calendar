import { z } from 'zod';
import { entryKindSchema, rruleSchema, workspaceSchema } from './schema';

// 行の「構造」だけを確かめるスキーマ。型・必須の項目・日付と時刻の形・rrule の形を見る。
// 長さ・年の範囲・15 分刻み・色の形のような入力のルールは見ない。
// Why: 入力のルールを後で厳しくしたときに、すでに DB にある行が「壊れた行」になり、全端末の受け取りが
// 止まるのを防ぐため（設計書 6.3）。入力のルールを確かめるのは、書き込むとき（API と store.ts の applyWrite）。
// 画面が GET /api/changes の応答を確かめる（実装 #6）のにも、DB から読んだ行の確認（worker/db/rows.ts）にも、
// 同じ部品を使う。部品を分けて持つと、片方だけ厳しくなって、サーバーが返せる行を、画面が読めなくなる。

export const rowIdSchema = z.string().min(1);

/** 'YYYY-MM-DD'。2/30 のような存在しない日付は通さない。 */
export const rowDateSchema = z.iso.date();

/** 'HH:MM'。分は 00〜59 のどれでもよい（15 分刻みは入力のルール）。 */
export const rowTimeSchema = z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/);

export const rowTimestampSchema = z.number().int();

/**
 * 予定の 1 行（camelCase）。DB の行（snake_case・真偽値は 0/1）の確認は rows.ts が行うが、部品は共有する。
 * strictObject にしないのは、サーバーが後から項目を足したときに、古い画面が応答を読めなくならないため。
 * kind・builtin・rrule だけは、書き込み用のスキーマと同じものを使う。閉じた集合で、コードの分岐の元になる値のため。
 */
export const structuralEntrySchema = z.object({
  id: rowIdSchema,
  kind: entryKindSchema,
  title: z.string(),
  workspaceId: rowIdSchema.nullable(),
  allDay: z.boolean(),
  startDate: rowDateSchema,
  startTime: rowTimeSchema.nullable(),
  endDate: rowDateSchema,
  endTime: rowTimeSchema.nullable(),
  location: z.string().nullable(),
  url: z.string().nullable(),
  memo: z.string().nullable(),
  rrule: rruleSchema.nullable(),
  untilDate: rowDateSchema.nullable(),
  seriesId: rowIdSchema.nullable(),
  originalDate: rowDateSchema.nullable(),
  cancelled: z.boolean(),
  notifyEnabled: z.boolean(),
  notifyOffsetMin: z.number().int(),
  editedAt: rowTimestampSchema,
  deletedAt: rowTimestampSchema.nullable(),
});

/** ワークスペースの 1 行（camelCase）。color は '#RRGGBB' の形まで確かめない（入力のルール）。 */
export const structuralWorkspaceSchema = z.object({
  id: rowIdSchema,
  name: z.string(),
  color: z.string(),
  sortOrder: z.number().int(),
  visible: z.boolean(),
  builtin: workspaceSchema.shape.builtin,
  editedAt: rowTimestampSchema,
  deletedAt: rowTimestampSchema.nullable(),
});

/**
 * GET /api/changes の応答の、構造だけを見るスキーマ（設計書 6.3）。画面が、応答を当てる前の確認に使う。
 * api.ts の changesResponseSchema は、応答の形（型）を表すもので、行の部分が書き込み用のスキーマ
 * （入力のルールを含む）なので、実行時の確認には使わない。
 */
export const structuralChangesResponseSchema = z.object({
  rev: z.number().int(),
  epoch: z.string(),
  workspaces: z.array(structuralWorkspaceSchema),
  entries: z.array(structuralEntrySchema),
});
