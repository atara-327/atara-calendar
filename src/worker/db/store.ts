import { z } from 'zod';
import {
  entryKindSchema,
  entrySchema,
  workspaceSchema,
  type Entry,
  type Workspace,
} from '../../shared/schema';
import {
  CorruptRowError,
  ENTRY_COLUMNS,
  WORKSPACE_COLUMNS,
  entryFromRow,
  entryToRow,
  workspaceFromRow,
  workspaceToRow,
  type StoredEntry,
  type StoredWorkspace,
} from './rows';

// D1 の読み書き（設計書 6.3・6.4）。SQL は直接書く（設計書 2章）。値はすべて bind し、
// 文字列として連結するのは、このファイルの中で決めた固定の表名・列名だけ。

/**
 * 読み書きに使うのは prepare と batch だけ。D1Database ごと受け取らないのは、テストで、確認と書き込みの
 * 間に別の書き込みを割り込ませる db を、型を偽らずに渡せるようにするため。
 */
export type Database = Pick<D1Database, 'prepare' | 'batch'>;

export interface Changes {
  /** meta の今の rev。端末は、これを「最後に受け取った rev」として覚える。 */
  rev: number;
  /** データを復元したら変わる値（設計書 付録 A.1）。端末が覚えている値と違えば、全件を読み込み直す。 */
  epoch: string;
  workspaces: StoredWorkspace[];
  entries: StoredEntry[];
}

const metaRowSchema = z.object({ rev: z.number().int(), epoch: z.string().min(1) });
const revRowSchema = z.object({ rev: z.number().int() });
const workspaceStateRowSchema = z.object({ id: z.string(), edited_at: z.number().int() });
const entryStateRowSchema = workspaceStateRowSchema.extend({ kind: entryKindSchema });

/** D1 の batch() は、文の数だけ結果を返す。noUncheckedIndexedAccess のために、足りないときは例外にする。 */
function resultAt(results: readonly D1Result[], index: number): D1Result {
  const result = results[index];
  if (result === undefined) {
    throw new Error(`D1 の batch の結果が足りません（${String(index)} 番目）`);
  }
  return result;
}

function rowsAt(results: readonly D1Result[], index: number): unknown[] {
  return resultAt(results, index).results;
}

/**
 * 行を型に直す。構造が壊れた行が 1 行でもあれば、差分の読み込み全体を失敗させる（設計書 6.3）。
 * 壊れた行だけを飛ばして返さないのは、受け取った端末が「全部受け取った」と思い込み、その行が
 * 永久に届かないまま、気づけなくなるため。直すための手がかり（表と id）は、ログに残す。
 */
function parseRows<T>(rawRows: readonly unknown[], fromRow: (raw: unknown) => T): T[] {
  try {
    return rawRows.map((raw) => fromRow(raw));
  } catch (error) {
    if (error instanceof CorruptRowError) console.error(error.message);
    throw error;
  }
}

function selectChanged(db: Database, table: 'workspaces' | 'entries', sinceRev: number) {
  // sinceRev = 0 は初回の読み込み。削除の記録は要らないので、削除済みを除く。
  // rev の条件を付けないのは、組み込みのワークスペースが rev = 0 で入っているため。
  if (sinceRev === 0) {
    return db.prepare(`SELECT * FROM ${table} WHERE deleted_at IS NULL ORDER BY rev, id`);
  }
  // 途中からは、削除済みも返す。他の端末に、削除を伝えるため（設計書 4.3）。
  return db.prepare(`SELECT * FROM ${table} WHERE rev > ?1 ORDER BY rev, id`).bind(sinceRev);
}

/** sinceRev より後に変わった行を返す。meta と行を 1 回の batch で読むのは、同じ時点の内容にそろえるため。 */
export async function readChanges(db: Database, sinceRev: number): Promise<Changes> {
  if (!Number.isInteger(sinceRev) || sinceRev < 0) {
    throw new RangeError(`sinceRev は 0 以上の整数にしてください: ${String(sinceRev)}`);
  }
  const results = await db.batch([
    db.prepare('SELECT rev, epoch FROM meta WHERE id = 1'),
    selectChanged(db, 'workspaces', sinceRev),
    selectChanged(db, 'entries', sinceRev),
  ]);
  const meta = metaRowSchema.parse(rowsAt(results, 0)[0]);
  return {
    rev: meta.rev,
    epoch: meta.epoch,
    workspaces: parseRows(rowsAt(results, 1), workspaceFromRow),
    entries: parseRows(rowsAt(results, 2), entryFromRow),
  };
}

export interface WriteRequest {
  entries?: readonly Entry[];
  workspaces?: readonly Workspace[];
}

/**
 * 同じ id の既存の行と、kind が違う行が届いた。kind は作成後に変えられない（設計書 4.5）ので、
 * 呼び出し側（API や recurrence.ts）のバグ。
 * 黙って捨てたり、kind だけを残して書いたりしないのは、混ぜると、kind は event のまま中身は block、という
 * 壊れた行ができるため。同じ id の行が 2 つ届いたとき（assertNoDuplicateIds）と同じ方針で、止めて気づけるようにする。
 */
export class KindMismatchError extends Error {
  override readonly name = 'KindMismatchError';
  readonly entryId: string;

  constructor(entryId: string, storedKind: string, requestedKind: string) {
    super(
      `予定の kind は作成後に変えられません（id: ${entryId}、今の kind: ${storedKind}、届いた kind: ${requestedKind}）`,
    );
    this.entryId = entryId;
  }
}

/**
 * applied: false は、サーバーの方が新しい（または同じ）行があって、依頼全体を捨てたこと。
 * applied: true の rev は、この依頼を書いた rev（行がない依頼では、今の rev）。
 * 端末は、この rev を「最後に受け取った rev」として使ってはいけない。受け取りは GET /api/changes
 * （readChanges）で行い、その rev だけを覚える。
 * Why: この rev まで進めると、他の端末が先に書いた行（これより前の rev）や、割り込みで弾かれて、
 * 別の端末の新しい編集が残っている行を、受け取らないまま取りこぼすため。
 */
export type WriteResult = { applied: false } | { applied: true; rev: number };

/**
 * upsert の JSON の値 1 つの大きさの上限（バイト）。D1 は、値 1 つを約 2MB までしか受け付けず、超えると
 * SQLITE_TOOBIG で batch 全体が失敗する。余裕をもって、その半分にする。
 * Miniflare の上限は 5〜20MB の間なので、テストでは、2MB を超えても失敗しない。本番でだけ失敗する。
 */
export const MAX_UPSERT_VALUE_BYTES = 1_000_000;

const textEncoder = new TextEncoder();

/**
 * 行を、JSON 配列の文字列に分ける。1 つの文字列は、MAX_UPSERT_VALUE_BYTES を超えないようにする。
 * 大きさは、string.length（文字数）ではなく、UTF-8 のバイト数で数える。D1 の上限がバイトで、日本語は
 * 1 文字 3 バイトなので、文字数で数えると、上限の 3 倍近くまで大きくなってしまう。
 * 1 行だけで上限を超える行は、行を分けられないので、その行だけで 1 つのかたまりにする。そういう行は、
 * ここでは防げない。入力の文字列の長さの上限（実装 #4c。設計書 4.2）で防ぐ。
 */
function toJsonChunks(rows: readonly unknown[]): string[] {
  const chunks: string[][] = [];
  let current: string[] = [];
  let bytes = 2; // 配列の [ と ]
  for (const row of rows) {
    const json = JSON.stringify(row);
    const size = textEncoder.encode(json).length + 1; // 区切りの ,
    if (current.length > 0 && bytes + size > MAX_UPSERT_VALUE_BYTES) {
      chunks.push(current);
      current = [];
      bytes = 2;
    }
    current.push(json);
    bytes += size;
  }
  if (current.length > 0) chunks.push(current);
  return chunks.map((jsons) => `[${jsons.join(',')}]`);
}

/**
 * 1 つの表への書き込みを、1 文の upsert にする。行は、列名をキーにしたオブジェクトの JSON 配列を、
 * 1 つの値（?1）として渡す。値は、大きさで分けたかたまりごとに 1 つ（toJsonChunks）。
 * 1 行ごとに 1 文にしないのは、ワークスペースの削除（中の予定をすべて論理削除）や、例外の多い系列の
 * 削除で、1 回の依頼が数百行になり、D1 の 1 回の呼び出しあたりのクエリ数の上限（無料プラン）に
 * 当たるおそれがあるため。行ごとに値を bind しないのも、1 文に bind できる値が 100 個までで、
 * 1 文に入る行が数行に限られ、結局、文の数が行数に比例して増えてしまうため。
 */
function upsertSql(
  table: 'workspaces' | 'entries',
  columns: readonly string[],
  {
    keepOnUpdate = [],
    extraAssignments = [],
  }: { keepOnUpdate?: readonly string[]; extraAssignments?: readonly string[] } = {},
): string {
  const assignments = [
    ...columns
      .filter((column) => column !== 'id' && !keepOnUpdate.includes(column))
      .map((column) => `${column} = excluded.${column}`),
    'rev = excluded.rev',
    ...extraAssignments,
  ];
  // rev は、同じ batch の先頭で増やした meta.rev を、後の文から参照して入れる。
  // WHERE true は、SELECT の後の ON CONFLICT を、SQLite が JOIN の ON と取り違えないために要る。
  return [
    `INSERT INTO ${table} (${columns.join(', ')}, rev)`,
    `SELECT ${columns.map((column) => `json_extract(value, '$.${column}')`).join(', ')}, (SELECT rev FROM meta WHERE id = 1)`,
    'FROM json_each(?1) WHERE true',
    `ON CONFLICT(id) DO UPDATE SET ${assignments.join(', ')}`,
    `WHERE excluded.edited_at > ${table}.edited_at`,
  ].join(' ');
}

// builtin は、更新の SET に入れない。組み込みのワークスペース（WS-4）の印を、後から付けたり外したりできないようにする。
// 付けられると、普通のワークスペースが組み込みとして扱われ、外せると、組み込みの行が、禁じるはずの
// 編集や削除（設計書 4.2。禁じるのは #4c の API）を通る普通の行になる。
const UPSERT_WORKSPACES = upsertSql('workspaces', WORKSPACE_COLUMNS, { keepOnUpdate: ['builtin'] });
// kind は、更新の SET に入れない。kind が違う行は、書く前の確認（assertSameKinds）で例外にしているが、
// 確認の後に別の書き込みが同じ id の行を作る割り込みは、確認をすり抜ける。割り込まれても、設計書 4.5
// 「kind は作成後に変えられない」を、DB への書き込みの形で守る。
// next_notify_at は、新しい行の INSERT では書かず（NULL）、更新では NULL に戻す。更新で残すと、変更・削除した
// 予定の通知が、古い時刻に送られる。通知の時刻は、通知を作る実装 #11 が、更新のたびに計算し直す。
const UPSERT_ENTRIES = upsertSql('entries', ENTRY_COLUMNS, {
  keepOnUpdate: ['kind'],
  extraAssignments: ['next_notify_at = NULL'],
});

type EntryKind = Entry['kind'];

/** 表ごとの、id → 今の行の edited_at（予定は kind も）。id は表の中でだけ一意なので、2 つの表の結果を 1 つの Map にまとめない。 */
interface CurrentRows {
  workspaces: Map<string, { editedAt: number }>;
  entries: Map<string, { editedAt: number; kind: EntryKind }>;
}

async function readCurrentRows(
  db: Database,
  workspaceIds: readonly string[],
  entryIds: readonly string[],
): Promise<CurrentRows> {
  // json_each で ids を 1 つの値として渡すのは、行数が多い依頼でも、D1 の bind できる値の数の上限
  // （1 文あたり 100 個）に当たらないようにするため。
  const select = (table: 'workspaces' | 'entries', columns: string, ids: readonly string[]) =>
    db
      .prepare(`SELECT ${columns} FROM ${table} WHERE id IN (SELECT value FROM json_each(?1))`)
      .bind(JSON.stringify(ids));
  const results = await db.batch([
    select('workspaces', 'id, edited_at', workspaceIds),
    select('entries', 'id, kind, edited_at', entryIds),
  ]);
  return {
    workspaces: new Map(
      rowsAt(results, 0).map((raw) => {
        const row = workspaceStateRowSchema.parse(raw);
        return [row.id, { editedAt: row.edited_at }] as const;
      }),
    ),
    entries: new Map(
      rowsAt(results, 1).map((raw) => {
        const row = entryStateRowSchema.parse(raw);
        return [row.id, { editedAt: row.edited_at, kind: row.kind }] as const;
      }),
    ),
  };
}

/** 今の行の edited_at が、書き込む行の edited_at 以上か（同じ id の行が、まだなければ false）。 */
function isStale(
  row: { id: string; editedAt: number },
  current: ReadonlyMap<string, { editedAt: number }>,
) {
  const stored = current.get(row.id);
  return stored !== undefined && stored.editedAt >= row.editedAt;
}

/** 同じ id の既存の行と kind が違う行があれば、KindMismatchError。 */
function assertSameKinds(
  entries: readonly Entry[],
  current: ReadonlyMap<string, { kind: EntryKind }>,
): void {
  for (const { id, kind } of entries) {
    const stored = current.get(id);
    if (stored !== undefined && stored.kind !== kind) {
      throw new KindMismatchError(id, stored.kind, kind);
    }
  }
}

function assertNoDuplicateIds(ids: readonly string[]): void {
  if (new Set(ids).size !== ids.length) {
    // 条件付きの upsert は、同じ id の 2 行目を黙って捨てる。呼び出し側のバグを、気づけない形で隠さない。
    throw new Error('1 つの依頼に、同じ id の行が 2 回以上入っています');
  }
}

/**
 * 変更を書き込む（設計書 6.4）。recurrence.ts の作成・変更・削除が返す行の配列を、そのまま渡せる。
 * どれか 1 行でも、今の行の edited_at が書き込む行の edited_at 以上なら、依頼全体を捨てる。
 * 「以上」にするのは、同じ依頼をもう一度送られたとき、2 回目を「もう反映済み」として捨てるため（設計書 6.2）。
 * 一部の行だけを書くと、系列が二重になるなど、データの形が壊れる。
 * 書く前に、すべての行を entrySchema・workspaceSchema で確かめ、合わない行が 1 つでもあれば（ZodError）、何も書かない。
 * 同じ id の既存の行と kind が違う行が 1 つでもあれば（KindMismatchError）も、何も書かない。
 */
export async function applyWrite(
  db: Database,
  { entries: entryInputs = [], workspaces: workspaceInputs = [] }: WriteRequest,
): Promise<WriteResult> {
  // API の入力の検証だけに任せないのは、サーバーが計算した行（recurrence.ts の結果）も、ここを通って
  // 書かれるため。ここで確かめれば、「書けた行は、必ず読める」（rows.ts）が、呼び出し側によらず成り立つ。
  const entries = entryInputs.map((entry) => entrySchema.parse(entry));
  const workspaces = workspaceInputs.map((workspace) => workspaceSchema.parse(workspace));
  if (entries.length === 0 && workspaces.length === 0) {
    const meta = revRowSchema.parse(await db.prepare('SELECT rev FROM meta WHERE id = 1').first());
    return { applied: true, rev: meta.rev };
  }
  assertNoDuplicateIds(workspaces.map(({ id }) => id));
  assertNoDuplicateIds(entries.map(({ id }) => id));

  const current = await readCurrentRows(
    db,
    workspaces.map(({ id }) => id),
    entries.map(({ id }) => id),
  );
  // 古い行の判定より先に確かめる。kind の食い違いは、古い依頼でも呼び出し側のバグなので、「捨てた」として隠さない。
  assertSameKinds(entries, current.entries);
  if (
    workspaces.some((row) => isStale(row, current.workspaces)) ||
    entries.some((row) => isStale(row, current.entries))
  ) {
    return { applied: false };
  }

  // 確認（上）と書き込み（下）の間に、別の書き込みが割り込む可能性は残る。1 回の処理にしていないのは、
  // 自分 1 人の利用で、2 台がほぼ同時に同じ行を書く確率がごく小さいため。割り込まれても、
  // upsert の WHERE が、新しい行を古い行で上書きすることだけは防ぐ。
  // workspaces を先に書く。entries の workspace_id は外部キーで、同じ依頼で作るワークスペースを指すことがあるため。
  const tables = [
    { table: 'workspaces', sql: UPSERT_WORKSPACES, rows: workspaces.map(workspaceToRow) },
    { table: 'entries', sql: UPSERT_ENTRIES, rows: entries.map(entryToRow) },
  ].filter(({ rows }) => rows.length > 0);
  // 値を分けても、かたまりの文は同じ batch に入れる。batch は 1 つのトランザクションなので、全部書くか、
  // 何も書かないかは変わらない。
  const upserts = tables.flatMap(({ table, sql, rows }) =>
    toJsonChunks(rows).map((json) => ({ table, statement: db.prepare(sql).bind(json) })),
  );
  const results = await db.batch([
    db.prepare('UPDATE meta SET rev = rev + 1 WHERE id = 1 RETURNING rev'),
    ...upserts.map(({ statement }) => statement),
  ]);
  // 1 つ目の結果は rev の UPDATE なので、upserts[i] の結果は i + 1 番目。
  // 書けた行数が少ないのは、確認の後に別の書き込みが同じ行を新しく書き、upsert の WHERE が弾いたとき。
  // 割り込みは許容しているので（上）、例外にも applied: false にもせず、起きたことだけをログに残す。
  // id や内容は出さない（予定のタイトルなどが、ログに残らないように）。
  const writtenByTable = new Map<string, number>();
  upserts.forEach(({ table }, index) => {
    const changes = resultAt(results, index + 1).meta.changes;
    writtenByTable.set(table, (writtenByTable.get(table) ?? 0) + changes);
  });
  tables.forEach(({ table, rows }) => {
    const written = writtenByTable.get(table) ?? 0;
    if (written < rows.length) {
      console.warn(
        `applyWrite: ${table} の ${String(rows.length)} 行のうち、書けたのは ${String(written)} 行でした（別の書き込みに割り込まれた可能性があります）`,
      );
    }
  });
  return { applied: true, rev: revRowSchema.parse(rowsAt(results, 0)[0]).rev };
}
