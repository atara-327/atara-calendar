import type { Entry, Workspace } from '../../src/shared/schema';
import { entryFromRow, workspaceFromRow } from '../../src/worker/db/rows';

export interface AllRows {
  workspaces: Map<string, Workspace>;
  entries: Map<string, Entry>;
}

/**
 * DB の全行（削除済みを含む）を、型に直して id で持つ。GET /api/changes は、初回の読み込みで削除済みを返さないので、
 * 端末の「やり直し」の結果と見比べるときに、削除済みの行まで取り出すのに使う。
 */
export async function readAllRows(db: D1Database): Promise<AllRows> {
  const [workspaces, entries] = await db.batch([
    db.prepare('SELECT * FROM workspaces ORDER BY id'),
    db.prepare('SELECT * FROM entries ORDER BY id'),
  ]);
  return {
    workspaces: new Map(
      (workspaces?.results ?? []).map((row) => {
        const { workspace } = workspaceFromRow(row);
        return [workspace.id, workspace] as const;
      }),
    ),
    entries: new Map(
      (entries?.results ?? []).map((row) => {
        const { entry } = entryFromRow(row);
        return [entry.id, entry] as const;
      }),
    ),
  };
}
