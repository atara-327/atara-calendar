import { z } from 'zod';
import {
  entryKindSchema,
  rruleSchema,
  workspaceSchema,
  type Entry,
  type Workspace,
} from '../../shared/schema';
import {
  rowDateSchema as dateSchema,
  rowIdSchema as idSchema,
  rowTimeSchema as timeSchema,
  rowTimestampSchema as timestampSchema,
} from '../../shared/structure';

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

/**
 * 行が、DB の行として成り立っていない（型・必須の列・日付や時刻の形・rrule の形が合わない）。
 * 壊れた行を黙って直さず、止めて気づけるようにする。table と rowId は、直す行を探すための印（付録 A.3）。
 */
export class CorruptRowError extends Error {
  override readonly name = 'CorruptRowError';
  readonly table: string;
  /** 行の id。id の列すら読めないときは undefined。 */
  readonly rowId: string | undefined;

  constructor(table: string, rowId: string | undefined, detail: string, options?: ErrorOptions) {
    super(`${table} の行が壊れています（id: ${rowId ?? '不明'}）\n${detail}`, options);
    this.table = table;
    this.rowId = rowId;
  }
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

// 型側のスキーマ（schema.ts）の部品を使い回さないのは、あちらが入力のルール（長さ・年の範囲・
// 15 分刻み・色の形など）で、後で厳しくする可能性があるため。使い回すと、厳しくした途端に、すでに
// DB にある行が「壊れた行」になり、readChanges が例外になって、全端末の同期が止まる。
// ここは、DB の行として成り立つか（型・必須・日付と時刻の形・rrule の形）だけを確かめる。
// 入力のルールは、書き込むとき（store.ts の applyWrite）に確かめる。
// 構造だけを見る部品は、画面の受け取りの確認（shared/structure.ts）と同じものを使う。
// DB の行は列名が snake_case で、真偽値が 0/1 なので、スキーマの全体は共有できず、部品だけを共有する。
// kind・builtin・rrule だけは型側と同じものを使う。閉じた集合で、DB の CHECK 制約やコードの分岐の元になる値のため。
const entryRowSchema = z
  .object({
    id: idSchema,
    kind: entryKindSchema,
    title: z.string(),
    workspace_id: idSchema.nullable(),
    all_day: flagSchema,
    start_date: dateSchema,
    start_time: timeSchema.nullable(),
    end_date: dateSchema,
    end_time: timeSchema.nullable(),
    location: z.string().nullable(),
    url: z.string().nullable(),
    memo: z.string().nullable(),
    rrule: rruleColumnSchema.nullable(),
    until_date: dateSchema.nullable(),
    series_id: idSchema.nullable(),
    original_date: dateSchema.nullable(),
    cancelled: flagSchema,
    notify_enabled: flagSchema,
    notify_offset_min: z.number().int(),
    next_notify_at: timestampSchema.nullable(),
    edited_at: timestampSchema,
    rev: z.number().int(),
    deleted_at: timestampSchema.nullable(),
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
    id: idSchema,
    name: z.string(),
    color: z.string(),
    sort_order: z.number().int(),
    visible: flagSchema,
    builtin: workspaceSchema.shape.builtin,
    edited_at: timestampSchema,
    rev: z.number().int(),
    deleted_at: timestampSchema.nullable(),
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
    table,
    typeof id === 'string' ? id : undefined,
    z.prettifyError(result.error),
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
