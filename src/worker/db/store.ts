import { z } from 'zod';
import type { Entry, Workspace } from '../../shared/schema';
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
const editedAtRowSchema = z.object({ id: z.string(), edited_at: z.number().int() });

/** D1 の batch() は、文の数だけ結果を返す。noUncheckedIndexedAccess のために、足りないときは例外にする。 */
function rowsAt(results: readonly D1Result[], index: number): unknown[] {
  const result = results[index];
  if (result === undefined) {
    throw new Error(`D1 の batch の結果が足りません（${String(index)} 番目）`);
  }
  return result.results;
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

/** applied: false は、サーバーの方が新しい（または同じ）行があって、依頼全体を捨てたこと。 */
export type WriteResult = { applied: false } | { applied: true; rev: number };

function upsertSql(table: 'workspaces' | 'entries', columns: readonly string[]): string {
  const assignments = columns
    .filter((column) => column !== 'id')
    .map((column) => `${column} = excluded.${column}`);
  // rev は、同じ batch の先頭で増やした meta.rev を、後の文から参照して入れる。
  // next_notify_at は書かない。通知の時刻は、通知を作る実装 #11 が計算する。
  return [
    `INSERT INTO ${table} (${columns.join(', ')}, rev)`,
    `VALUES (${columns.map(() => '?').join(', ')}, (SELECT rev FROM meta WHERE id = 1))`,
    `ON CONFLICT(id) DO UPDATE SET ${assignments.join(', ')}, rev = excluded.rev`,
    `WHERE excluded.edited_at > ${table}.edited_at`,
  ].join(' ');
}

const UPSERT_WORKSPACE = upsertSql('workspaces', WORKSPACE_COLUMNS);
const UPSERT_ENTRY = upsertSql('entries', ENTRY_COLUMNS);

/** 表ごとの、id → 今の edited_at。id は表の中でだけ一意なので、2 つの表の結果を 1 つの Map にまとめない。 */
interface CurrentEditedAt {
  workspaces: Map<string, number>;
  entries: Map<string, number>;
}

async function currentEditedAt(
  db: Database,
  workspaceIds: readonly string[],
  entryIds: readonly string[],
): Promise<CurrentEditedAt> {
  // json_each で ids を 1 つの値として渡すのは、行数が多い依頼でも、D1 の bind できる値の数の上限
  // （1 文あたり 100 個）に当たらないようにするため。
  const select = (table: 'workspaces' | 'entries', ids: readonly string[]) =>
    db
      .prepare(`SELECT id, edited_at FROM ${table} WHERE id IN (SELECT value FROM json_each(?1))`)
      .bind(JSON.stringify(ids));
  const results = await db.batch([select('workspaces', workspaceIds), select('entries', entryIds)]);
  const toMap = (index: number) =>
    new Map(
      rowsAt(results, index).map((raw) => {
        const row = editedAtRowSchema.parse(raw);
        return [row.id, row.edited_at] as const;
      }),
    );
  return { workspaces: toMap(0), entries: toMap(1) };
}

/** 今の行の edited_at が、書き込む行の edited_at 以上か（同じ id の行が、まだなければ false）。 */
function isStale(row: { id: string; editedAt: number }, current: ReadonlyMap<string, number>) {
  const stored = current.get(row.id);
  return stored !== undefined && stored >= row.editedAt;
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
 */
export async function applyWrite(
  db: Database,
  { entries = [], workspaces = [] }: WriteRequest,
): Promise<WriteResult> {
  if (entries.length === 0 && workspaces.length === 0) {
    const meta = revRowSchema.parse(await db.prepare('SELECT rev FROM meta WHERE id = 1').first());
    return { applied: true, rev: meta.rev };
  }
  assertNoDuplicateIds(workspaces.map(({ id }) => id));
  assertNoDuplicateIds(entries.map(({ id }) => id));

  const current = await currentEditedAt(
    db,
    workspaces.map(({ id }) => id),
    entries.map(({ id }) => id),
  );
  if (
    workspaces.some((row) => isStale(row, current.workspaces)) ||
    entries.some((row) => isStale(row, current.entries))
  ) {
    return { applied: false };
  }

  // 確認（上）と書き込み（下）の間に、別の書き込みが割り込む可能性は残る。1 回の処理にしていないのは、
  // 自分 1 人の利用で、2 台がほぼ同時に同じ行を書く確率がごく小さいため。割り込まれても、
  // upsert の WHERE が、新しい行を古い行で上書きすることだけは防ぐ。
  const results = await db.batch([
    db.prepare('UPDATE meta SET rev = rev + 1 WHERE id = 1 RETURNING rev'),
    // workspaces を先に書く。entries の workspace_id は外部キーで、同じ依頼で作るワークスペースを指すことがあるため。
    ...workspaces.map((workspace) => {
      const row = workspaceToRow(workspace);
      return db.prepare(UPSERT_WORKSPACE).bind(...WORKSPACE_COLUMNS.map((column) => row[column]));
    }),
    ...entries.map((entry) => {
      const row = entryToRow(entry);
      return db.prepare(UPSERT_ENTRY).bind(...ENTRY_COLUMNS.map((column) => row[column]));
    }),
  ]);
  return { applied: true, rev: revRowSchema.parse(rowsAt(results, 0)[0]).rev };
}
