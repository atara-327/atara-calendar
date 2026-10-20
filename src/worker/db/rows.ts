import { z } from 'zod';
import {
  entrySchema,
  rruleSchema,
  workspaceSchema,
  type Entry,
  type Workspace,
} from '../../shared/schema';

// DB の行（snake_case・真偽値は 0/1・rrule は JSON の文字列）と、型（camelCase）の相互変換。
// rev と next_notify_at はサーバーの都合の列なので、Entry・Workspace には入れず、読み込み結果で別に持つ（設計書 4.2）。

/** D1 に bind できる値。undefined を bind すると D1 が例外を投げるので、空は必ず null にする。 */
type SqlValue = string | number | null;

/** rev と next_notify_at は、書き込みの SQL が自分で決める（store.ts）ので、ここには入れない。 */
export const ENTRY_COLUMNS = [
  'id',
  'kind',
  'title',
  'workspace_id',
  'all_day',
  'start_date',
  'start_time',
  'end_date',
  'end_time',
  'location',
  'url',
  'memo',
  'rrule',
  'until_date',
  'series_id',
  'original_date',
  'cancelled',
  'notify_enabled',
  'notify_offset_min',
  'edited_at',
  'deleted_at',
] as const;

export const WORKSPACE_COLUMNS = [
  'id',
  'name',
  'color',
  'sort_order',
  'visible',
  'builtin',
  'edited_at',
  'deleted_at',
] as const;

export type EntryWriteRow = Record<(typeof ENTRY_COLUMNS)[number], SqlValue>;
export type WorkspaceWriteRow = Record<(typeof WORKSPACE_COLUMNS)[number], SqlValue>;

function toFlag(value: boolean): 0 | 1 {
  return value ? 1 : 0;
}

export function entryToRow(entry: Entry): EntryWriteRow {
  return {
    id: entry.id,
    kind: entry.kind,
    title: entry.title,
    workspace_id: entry.workspaceId,
    all_day: toFlag(entry.allDay),
    start_date: entry.startDate,
    start_time: entry.startTime,
    end_date: entry.endDate,
    end_time: entry.endTime,
    location: entry.location,
    url: entry.url,
    memo: entry.memo,
    rrule: entry.rrule === null ? null : JSON.stringify(entry.rrule),
    until_date: entry.untilDate,
    series_id: entry.seriesId,
    original_date: entry.originalDate,
    cancelled: toFlag(entry.cancelled),
    notify_enabled: toFlag(entry.notifyEnabled),
    notify_offset_min: entry.notifyOffsetMin,
    edited_at: entry.editedAt,
    deleted_at: entry.deletedAt,
  };
}

export function workspaceToRow(workspace: Workspace): WorkspaceWriteRow {
  return {
    id: workspace.id,
    name: workspace.name,
    color: workspace.color,
    sort_order: workspace.sortOrder,
    visible: toFlag(workspace.visible),
    builtin: workspace.builtin,
    edited_at: workspace.editedAt,
    deleted_at: workspace.deletedAt,
  };
}

/** 読み込んだ行。rev は、差分の同期（設計書 6.3）でどの変更まで渡したかの印になる。 */
export interface StoredEntry {
  entry: Entry;
  rev: number;
  nextNotifyAt: number | null;
}

export interface StoredWorkspace {
  workspace: Workspace;
  rev: number;
}

/** 行が、書き込んだ覚えのない形になっている。壊れた行を黙って直さず、止めて気づけるようにする。 */
export class CorruptRowError extends Error {
  override readonly name = 'CorruptRowError';
}

// 0 と 1 以外（2 など）は、アプリが書いた値ではないので、真偽値に丸めず壊れた行として扱う。
const flagSchema = z.union([z.literal(0), z.literal(1)]).transform((value) => value === 1);

const rruleColumnSchema = z
  .string()
  .transform((text, ctx): unknown => {
    try {
      return JSON.parse(text);
    } catch {
      ctx.addIssue({ code: 'custom', message: 'rrule が JSON として読めません' });
      return z.NEVER;
    }
  })
  .pipe(rruleSchema);

// 各列の検証は、型側のスキーマ（schema.ts）の部品を使い回す。ここで別に書くと、型のルールを
// 変えたときに、DB から読み込む側だけ古いまま残るため。
const entryRowSchema = z
  .object({
    id: entrySchema.shape.id,
    kind: entrySchema.shape.kind,
    title: entrySchema.shape.title,
    workspace_id: entrySchema.shape.workspaceId,
    all_day: flagSchema,
    start_date: entrySchema.shape.startDate,
    start_time: entrySchema.shape.startTime,
    end_date: entrySchema.shape.endDate,
    end_time: entrySchema.shape.endTime,
    location: entrySchema.shape.location,
    url: entrySchema.shape.url,
    memo: entrySchema.shape.memo,
    rrule: rruleColumnSchema.nullable(),
    until_date: entrySchema.shape.untilDate,
    series_id: entrySchema.shape.seriesId,
    original_date: entrySchema.shape.originalDate,
    cancelled: flagSchema,
    notify_enabled: flagSchema,
    notify_offset_min: entrySchema.shape.notifyOffsetMin,
    next_notify_at: z.number().int().nullable(),
    edited_at: entrySchema.shape.editedAt,
    rev: z.number().int(),
    deleted_at: entrySchema.shape.deletedAt,
  })
  .transform((row): StoredEntry => ({
    entry: {
      id: row.id,
      kind: row.kind,
      title: row.title,
      workspaceId: row.workspace_id,
      allDay: row.all_day,
      startDate: row.start_date,
      startTime: row.start_time,
      endDate: row.end_date,
      endTime: row.end_time,
      location: row.location,
      url: row.url,
      memo: row.memo,
      rrule: row.rrule,
      untilDate: row.until_date,
      seriesId: row.series_id,
      originalDate: row.original_date,
      cancelled: row.cancelled,
      notifyEnabled: row.notify_enabled,
      notifyOffsetMin: row.notify_offset_min,
      editedAt: row.edited_at,
      deletedAt: row.deleted_at,
    },
    rev: row.rev,
    nextNotifyAt: row.next_notify_at,
  }));

const workspaceRowSchema = z
  .object({
    id: workspaceSchema.shape.id,
    name: workspaceSchema.shape.name,
    color: workspaceSchema.shape.color,
    sort_order: workspaceSchema.shape.sortOrder,
    visible: flagSchema,
    builtin: workspaceSchema.shape.builtin,
    edited_at: workspaceSchema.shape.editedAt,
    rev: z.number().int(),
    deleted_at: workspaceSchema.shape.deletedAt,
  })
  .transform((row): StoredWorkspace => ({
    workspace: {
      id: row.id,
      name: row.name,
      color: row.color,
      sortOrder: row.sort_order,
      visible: row.visible,
      builtin: row.builtin,
      editedAt: row.edited_at,
      deletedAt: row.deleted_at,
    },
    rev: row.rev,
  }));

function parseRow<T>(schema: z.ZodType<T>, table: string, raw: unknown): T {
  const result = schema.safeParse(raw);
  if (result.success) return result.data;
  const id = typeof raw === 'object' && raw !== null && 'id' in raw ? raw.id : undefined;
  throw new CorruptRowError(
    `${table} の行が壊れています（id: ${typeof id === 'string' ? id : '不明'}）\n${z.prettifyError(result.error)}`,
    { cause: result.error },
  );
}

/** D1 から読んだ entries の 1 行を、型に直す。形が合わなければ CorruptRowError。 */
export function entryFromRow(raw: unknown): StoredEntry {
  return parseRow(entryRowSchema, 'entries', raw);
}

/** D1 から読んだ workspaces の 1 行を、型に直す。形が合わなければ CorruptRowError。 */
export function workspaceFromRow(raw: unknown): StoredWorkspace {
  return parseRow(workspaceRowSchema, 'workspaces', raw);
}
