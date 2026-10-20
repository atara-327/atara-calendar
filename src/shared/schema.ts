import { z } from 'zod';

// 型はすべて Zod のスキーマから導く（z.infer）。名前は camelCase で、DB の snake_case との
// 対応は API の層で行う（設計書 4章）。rev と nextNotifyAt はサーバーの都合の列なので、ここには入れない。

/** 'YYYY-MM-DD'（日本時間）。2/30 のような存在しない日付は通さない。 */
export const dateStringSchema = z.iso.date();

/**
 * 'HH:MM'（日本時間）。分は 00・15・30・45 だけ（DV-3）。
 * z.iso.time() を使わないのは、15 分刻みに絞れないため。24:00 も通さない（終わりが翌日 0:00 なら、終了日を翌日にして 00:00 と書く）。
 */
export const timeStringSchema = z.string().regex(/^([01]\d|2[0-3]):(00|15|30|45)$/, {
  message: "時刻は 'HH:MM' で、分は 00・15・30・45 のどれかにしてください",
});

const weekdayNumberSchema = z.number().int().min(0).max(6);

/** 繰り返しのルール（設計書 4.4）。weekly の days は 0 = 日曜 〜 6 = 土曜。 */
export const rruleSchema = z.discriminatedUnion('freq', [
  z.strictObject({ freq: z.literal('daily') }),
  z.strictObject({
    freq: z.literal('weekly'),
    days: z
      .array(weekdayNumberSchema)
      .min(1)
      .refine((days) => new Set(days).size === days.length, {
        message: '曜日が重複しています',
      }),
  }),
  z.strictObject({ freq: z.literal('monthly') }),
  z.strictObject({ freq: z.literal('yearly') }),
  z.strictObject({ freq: z.literal('weekday') }),
  z.strictObject({ freq: z.literal('holiday') }),
]);

export type Rrule = z.infer<typeof rruleSchema>;

export const entryKindSchema = z.enum(['event', 'block']);

/**
 * 予定とタイムブロックの1行（設計書 4.2 の entries）。
 * 終日かどうかと時刻の組み合わせ（終日なら時刻が null など）や、終了が開始より前でないことは、
 * このスキーマでは確かめない。z.object に refine を付けると pick / omit が使えなくなり、
 * 下書き・変更のスキーマをここから導けなくなるため。
 */
export const entrySchema = z.object({
  id: z.string().min(1),
  kind: entryKindSchema,
  title: z.string(),
  workspaceId: z.string().min(1).nullable(),
  allDay: z.boolean(),
  startDate: dateStringSchema,
  startTime: timeStringSchema.nullable(),
  endDate: dateStringSchema,
  endTime: timeStringSchema.nullable(),
  location: z.string().nullable(),
  url: z.string().nullable(),
  memo: z.string().nullable(),
  rrule: rruleSchema.nullable(),
  untilDate: dateStringSchema.nullable(),
  seriesId: z.string().min(1).nullable(),
  originalDate: dateStringSchema.nullable(),
  cancelled: z.boolean(),
  notifyEnabled: z.boolean(),
  notifyOffsetMin: z.number().int(),
  editedAt: z.number().int(),
  deletedAt: z.number().int().nullable(),
});

export type Entry = z.infer<typeof entrySchema>;

/** 新しく作るときに、ユーザーが入力する項目。 */
export const entryDraftSchema = entrySchema.pick({
  kind: true,
  title: true,
  workspaceId: true,
  allDay: true,
  startDate: true,
  startTime: true,
  endDate: true,
  endTime: true,
  location: true,
  url: true,
  memo: true,
  rrule: true,
  notifyEnabled: true,
  notifyOffsetMin: true,
});

export type EntryDraft = z.infer<typeof entryDraftSchema>;

/**
 * 変更で、ユーザーが変えた項目だけ。undefined（キーがない）は「変えていない」、null は「空にした」。
 * kind は作成した後に変えられないので入れない。strictObject にして、kind が混ざった入力を弾く
 * （普通の object だと、知らないキーを黙って捨ててしまい、変わったと思い込ませてしまう）。
 */
export const entryChangesSchema = z.strictObject(
  entryDraftSchema.omit({ kind: true }).partial().shape,
);

export type EntryChanges = z.infer<typeof entryChangesSchema>;

/**
 * ワークスペースの1行（設計書 4.2 の workspaces）。builtin は、組み込みの「祝日」「記念日」の印（WS-4）。
 * color は '#RRGGBB' の形だけを確かめる。選べる 8 色に絞るかどうかは、ワークスペースの編集（実装 #10）で決める。
 */
export const workspaceSchema = z.object({
  id: z.string().min(1),
  name: z.string(),
  color: z.string().regex(/^#[0-9A-Fa-f]{6}$/, { message: "色は '#RRGGBB' で指定してください" }),
  sortOrder: z.number().int(),
  visible: z.boolean(),
  builtin: z.enum(['holiday', 'observance']).nullable(),
  editedAt: z.number().int(),
  deletedAt: z.number().int().nullable(),
});

export type Workspace = z.infer<typeof workspaceSchema>;

/** 繰り返し予定の変更・削除の範囲（RP-4）。 */
export const scopeSchema = z.enum(['this', 'following', 'all']);

export type Scope = z.infer<typeof scopeSchema>;
