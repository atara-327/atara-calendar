import { z } from 'zod';
import { MAX_YEAR, MIN_YEAR } from './solarTerms';

// 型はすべて Zod のスキーマから導く（z.infer）。名前は camelCase で、DB の snake_case との
// 対応は Worker の DB の層（worker/db/rows.ts）で行う（設計書 4章）。
// rev と nextNotifyAt はサーバーの都合の列なので、ここには入れない。

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

/**
 * 繰り返しのルール（設計書 4.4）。weekly の days は 0 = 日曜 〜 6 = 土曜。
 * rows.ts の DB の読み込み（rrule の列）でも使う。ルールを厳しくすると、すでに DB にある行が読めなくなり、
 * readChanges が例外になって、全端末の同期が止まる。厳しくするなら、先に rows.ts のスキーマを分ける。
 */
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

/**
 * rows.ts の DB の読み込みと、store.ts の今の行の kind の確認でも使う。値を減らしたり名前を変えたりすると、
 * すでに DB にある行が読めなくなり、全端末の同期が止まる。増やすときは、DB の CHECK 制約（migrations）も変える。
 */
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
  // rows.ts の DB の読み込み（workspaceSchema.shape.builtin）でも使う。値を減らしたり名前を変えたりすると、
  // すでに DB にある行が読めなくなり、全端末の同期が止まる。
  builtin: z.enum(['holiday', 'observance']).nullable(),
  editedAt: z.number().int(),
  deletedAt: z.number().int().nullable(),
});

export type Workspace = z.infer<typeof workspaceSchema>;

/** 繰り返し予定の変更・削除の範囲（RP-4）。 */
export const scopeSchema = z.enum(['this', 'following', 'all']);

export type Scope = z.infer<typeof scopeSchema>;

// ここから先は、API が受け取る入力の検証用（設計書 4.2「入力の上限と項目をまたぐ確認」）。
// 上の entrySchema・workspaceSchema に、長さや年の範囲を足さないのは、これらが書き込み（store.ts）の
// 確認にも、読み込み（rows.ts）の部品にも使われるため。足すと、入力のルールを後で厳しくしたときに、
// すでに DB にある行が、更新できない行（書き込みで ZodError）になる。入力だけを、別のスキーマで厳しくする。
// 文字列の長さ（.max）は UTF-16 の単位で数える。上限は、1 行が D1 の値の上限（約 2MB）に余裕で収まる大きさ。

/** 入力の上限。画面のフォームも同じ値を使う（入力欄の maxLength など）。 */
export const INPUT_LIMITS = {
  title: 200,
  location: 200,
  memo: 10_000,
  url: 2048,
  workspaceName: 50,
  /** 開始の何分前か。終日は 0:00 からの分なので、負の値もある（設計書 4.3）。最大 1 週間前。 */
  notifyOffsetMin: { min: -1440, max: 10_080 },
} as const;

/** 端末が作る UUID と、組み込みの固定 id（'builtin-holiday' など）の、両方が通る形。 */
export const idInputSchema = z.string().regex(/^[A-Za-z0-9-]{1,64}$/, {
  message: 'id は英数字とハイフンの 1〜64 文字にしてください',
});

/** 日付の年は 1900〜2199（設計書 Q2）。祝日の計算と、繰り返しの展開が対応する範囲。 */
export const inputDateSchema = dateStringSchema.refine(
  (date) => {
    const year = Number(date.slice(0, 4));
    return year >= MIN_YEAR && year <= MAX_YEAR;
  },
  { message: `日付の年は ${String(MIN_YEAR)}〜${String(MAX_YEAR)} にしてください` },
);

/** new URL() で読めるか。 */
function isParsableUrl(value: string): boolean {
  try {
    new URL(value);
    return true;
  } catch {
    return false;
  }
}

/**
 * URL は http:// と https:// だけ（設計書 10.3）。javascript: などをリンクにしないため。
 * z.url() を使わないのは、値を黙って整える（先頭と末尾の空白を取り除く）ため。入力と保存する値が食い違うと、
 * 端末が持っている行と、サーバーが保存した行が、同期のたびにずれて見える。
 */
const urlInputSchema = z
  .string()
  .max(INPUT_LIMITS.url)
  .regex(/^https?:\/\//i, { message: 'URL は http:// か https:// で始めてください' })
  .refine(isParsableUrl, { message: 'URL の形が正しくありません' });

/** 端末で編集した時刻（ms）。サーバーの今より未来すぎないことは、API が確かめる（設計書 6.4）。 */
export const editedAtSchema = z.number().int().nonnegative();

/** 新しく作るときの下書きの、入力用。strictObject にして、知らないキーを黙って捨てずに弾く。 */
export const entryDraftInputSchema = z.strictObject({
  ...entryDraftSchema.shape,
  title: z.string().min(1).max(INPUT_LIMITS.title),
  workspaceId: idInputSchema.nullable(),
  startDate: inputDateSchema,
  endDate: inputDateSchema,
  location: z.string().max(INPUT_LIMITS.location).nullable(),
  url: urlInputSchema.nullable(),
  memo: z.string().max(INPUT_LIMITS.memo).nullable(),
  notifyOffsetMin: z
    .number()
    .int()
    .min(INPUT_LIMITS.notifyOffsetMin.min)
    .max(INPUT_LIMITS.notifyOffsetMin.max),
});

/** 変更の中身の、入力用。entryChangesSchema と同じく、kind を弾く。 */
export const entryChangesInputSchema = z.strictObject(
  entryDraftInputSchema.omit({ kind: true }).partial().shape,
);

/**
 * ワークスペースの 1 行の、入力用。deletedAt は null だけを通す。PUT で論理削除すると、組み込みと
 * 最後の 1 つの保護（API の DELETE が確かめる）をすり抜けるため。削除は DELETE で行う。
 */
export const workspaceInputSchema = z.strictObject({
  ...workspaceSchema.shape,
  id: idInputSchema,
  name: z.string().min(1).max(INPUT_LIMITS.workspaceName),
  editedAt: editedAtSchema,
  deletedAt: z.null(),
});
