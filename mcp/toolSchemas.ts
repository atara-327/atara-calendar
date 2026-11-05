import { z } from 'zod';
import {
  INPUT_LIMITS,
  entryChangesInputSchema,
  entryDraftInputSchema,
  idInputSchema,
  inputDateSchema,
  scopeSchema,
} from '../src/shared/schema';
import { WORKSPACE_COLORS } from '../src/shared/workspaceColors';

// ツールの入力（設計書 13.3）。項目の形と範囲は、src/shared/schema.ts の入力用のスキーマをそのまま使う
// （サーバーと同じスキーマなので、通らない入力は、送る前に Claude に理由を返せる）。
// 説明（describe）は、Claude が項目の意味を読み取るためのもの。日付・時刻は、日本時間。

export const MAX_LIST_DAYS = 366;

const draft = entryDraftInputSchema.shape;

const DATE_NOTE = '日本時間の YYYY-MM-DD';
const TIME_NOTE = '日本時間の HH:MM（1 分刻み）';

export const listEventsInputSchema = z.strictObject({
  from: inputDateSchema.describe(`期間の最初の日（この日を含む）。${DATE_NOTE}`),
  to: inputDateSchema.describe(
    `期間の最後の日（この日を含む）。${DATE_NOTE}。from から最大 ${String(MAX_LIST_DAYS)} 日`,
  ),
});

export const listWorkspacesInputSchema = z.strictObject({});

export const createEventInputSchema = z.strictObject({
  kind: draft.kind.describe(
    "'event'（予定。ワークスペースが必要）か 'block'（タイムブロック。ワークスペースなし。終日にできない）",
  ),
  title: draft.title.describe(`タイトル（1〜${String(INPUT_LIMITS.title)} 文字）`),
  workspaceId: draft.workspaceId
    .optional()
    .describe(
      "ワークスペースの id（list_workspaces で分かる）。kind が 'event' のとき必須。'block' のときは省略する",
    ),
  allDay: draft.allDay
    .optional()
    .describe('終日なら true（省略すると false）。終日のときは startTime・endTime を省略する'),
  startDate: draft.startDate.describe(`開始日。${DATE_NOTE}`),
  startTime: draft.startTime
    .optional()
    .describe(`開始時刻。${TIME_NOTE}。終日のときは省略する。それ以外は必須`),
  endDate: draft.endDate.describe(
    `終了日。${DATE_NOTE}。終日の予定は、最終日（その日を含む）。1 日だけなら startDate と同じ`,
  ),
  endTime: draft.endTime
    .optional()
    .describe(
      `終了時刻。${TIME_NOTE}。終日のときは省略する。終わりが翌日の 0:00 なら、endDate を翌日にして 00:00 と書く（24:00 は使えない）`,
    ),
  location: draft.location.optional().describe('場所の名前（省略すると空）'),
  url: draft.url.optional().describe('http:// か https:// で始まる URL（省略すると空）'),
  memo: draft.memo.optional().describe('メモ（省略すると空）'),
  rrule: draft.rrule
    .optional()
    .describe(
      '繰り返しのルール。省略すると繰り返さない。' +
        '{"freq":"daily"}（毎日）・{"freq":"weekly","days":[1,3,5]}（毎週。days は 0=日〜6=土）・' +
        '{"freq":"monthly"}（毎月。開始日と同じ日）・{"freq":"yearly"}（毎年。開始日と同じ月日）・' +
        '{"freq":"weekday"}（平日）・{"freq":"holiday"}（土日祝）。' +
        '開始日がルールに合わないときは、ルールに合う最初の日にずれる。終わりの日は指定できない',
    ),
  notifyEnabled: draft.notifyEnabled
    .optional()
    .describe("Discord への通知。省略すると、'event' は true、'block' は false"),
  notifyOffsetMin: draft.notifyOffsetMin
    .optional()
    .describe(
      '開始の何分前に通知するか。省略すると、時間指定は 10、終日は -360（当日の朝 6 時。終日は 0:00 からの分で、後ろへは負の数）',
    ),
});

const occurrenceTarget = {
  seriesId: idInputSchema.describe(
    'list_events が返した回の seriesId（繰り返さない予定では、その予定自身の id）',
  ),
  occurrenceDate: inputDateSchema.describe(
    `list_events が返した回の occurrenceDate（変える・消す回の日付）。${DATE_NOTE}`,
  ),
  scope: scopeSchema.describe(
    '繰り返す予定（list_events の recurring が true）のとき、どこまで変える・消すか。' +
      "'this'（この回のみ）・'following'（この回以降すべて）・'all'（すべての回）。" +
      "繰り返さない予定では無視されるが、必ず指定する（'all' でよい）",
  ),
};

export const updateEventInputSchema = z.strictObject({
  ...occurrenceTarget,
  changes: entryChangesInputSchema.describe(
    '変える項目だけを書く（書かない項目は変わらない）。項目の名前と意味は create_event と同じ' +
      '（kind は変えられない）。空にできる項目（location・url・memo・rrule）は null で空にする。' +
      "scope が 'this' のときは、rrule（繰り返し）を変えられない。" +
      '終日にするときは startTime・endTime を null にする。時間指定にするときは startTime・endTime の両方を入れる。' +
      'allDay を書いて notifyOffsetMin を書かないと、通知は、その初期値（時間指定は 10、終日は -360）になる（終日かどうかを変えないなら、allDay は書かない）',
  ),
});

export const deleteEventInputSchema = z.strictObject(occurrenceTarget);

const colorNames = WORKSPACE_COLORS.map(({ name }) => name);
export const WORKSPACE_COLOR_NAMES: [string, ...string[]] = [
  WORKSPACE_COLORS[0].name,
  ...colorNames.slice(1),
];

export const createWorkspaceInputSchema = z.strictObject({
  name: z
    .string()
    .min(1)
    .max(INPUT_LIMITS.workspaceName)
    .describe(`ワークスペースの名前（1〜${String(INPUT_LIMITS.workspaceName)} 文字）`),
  color: z
    .enum(WORKSPACE_COLOR_NAMES)
    .optional()
    .describe(
      `色の名前。省略すると、まだ使っていない色の先頭。選べる色: ${WORKSPACE_COLOR_NAMES.join('・')}`,
    ),
});

export type ListEventsInput = z.infer<typeof listEventsInputSchema>;
export type CreateEventInput = z.infer<typeof createEventInputSchema>;
export type UpdateEventInput = z.infer<typeof updateEventInputSchema>;
export type DeleteEventInput = z.infer<typeof deleteEventInputSchema>;
export type CreateWorkspaceInput = z.infer<typeof createWorkspaceInputSchema>;
