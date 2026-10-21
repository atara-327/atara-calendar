import { readdirSync, readFileSync } from 'node:fs';
import { Miniflare, convertV4MiniflareOptions } from 'miniflare';

// 本物の D1（wrangler が使っている Miniflare の、メモリ上の SQLite）をテストで使う。
// @cloudflare/vitest-pool-workers を使わないのは、今の Vitest 5 に対応していない（Vitest 4 が必要）ため。
// D1 を自作の偽物に置き換えないのは、upsert の条件や batch の動きが、本物と食い違うと意味がなくなるため。

const MIGRATIONS_DIR = new URL('../../migrations/', import.meta.url);

/**
 * SQL を文ごとに分ける。D1 の exec() は 1 行に 1 文のときしか使えないので、複数行の CREATE TABLE を
 * そのまま渡せない。`--` のコメントと、'...' の中の `;` は区切りとして扱わない。
 * トリガー（BEGIN ... END の中に `;` がある文）には対応しない。マイグレーションに書く必要が出たら、ここを直す。
 */
export function splitStatements(sql: string): string[] {
  const statements: string[] = [];
  let current = '';
  let inString = false;
  for (let index = 0; index < sql.length; index += 1) {
    const char = sql.charAt(index);
    if (!inString && char === '-' && sql.charAt(index + 1) === '-') {
      const lineEnd = sql.indexOf('\n', index);
      index = lineEnd === -1 ? sql.length : lineEnd;
      current += '\n';
    } else if (!inString && char === ';') {
      if (current.trim() !== '') statements.push(current.trim());
      current = '';
    } else {
      if (char === "'") inString = !inString;
      current += char;
    }
  }
  if (current.trim() !== '') statements.push(current.trim());
  return statements;
}

/** migrations/ の SQL ファイル 1 つを、文ごとに分けて返す。1 つのマイグレーションだけを、後から当てるテストのため。 */
export function readMigrationFileStatements(fileName: string): string[] {
  return splitStatements(readFileSync(new URL(fileName, MIGRATIONS_DIR), 'utf8'));
}

/** migrations/*.sql を、ファイル名の順に、文ごとに分けて返す。 */
export function readMigrationStatements(): string[] {
  return readdirSync(MIGRATIONS_DIR)
    .filter((name) => name.endsWith('.sql'))
    .sort()
    .flatMap(readMigrationFileStatements);
}

/**
 * マイグレーション（0002 が入れ、0003 が色を直した）「予定」を消して、meta.rev を 0 に戻す。
 * rev を 0 から数えるテストが、自分で入れる rev 0 の行と、数え方をそろえるため。
 * 「予定」が入っていることは、マイグレーション直後の DB を使う migration.test.ts で確かめる。
 */
export async function removeDefaultWorkspace(db: D1Database): Promise<void> {
  await db.batch([
    db.prepare("DELETE FROM workspaces WHERE id = 'default-workspace'"),
    db.prepare('UPDATE meta SET rev = 0'),
  ]);
}

/**
 * データを復元した（過去の時点に戻した）ときの meta にする文。rev は、残っている行の rev の最大値になり、
 * epoch は変わる。rev を、小さい値の直書きにしないのは、行の rev より小さい meta.rev は、本物の復元では
 * 起きないため（マイグレーションが入れる「予定」の rev も、行の rev に含まれる）。
 * 行を消す文より後に、同じ batch で流す。
 */
export function restoredMetaStatement(db: D1Database, epoch: string): D1PreparedStatement {
  return db
    .prepare(
      `UPDATE meta SET epoch = ?1,
         rev = (SELECT max(rev) FROM (SELECT rev FROM workspaces UNION ALL SELECT rev FROM entries))`,
    )
    .bind(epoch);
}

export interface TestDatabase {
  db: D1Database;
  /** すべてのテーブルを消して、マイグレーションを流し直す。テストごとに、初期状態から始めるため。 */
  reset: () => Promise<void>;
  dispose: () => Promise<void>;
}

export async function createTestDatabase(): Promise<TestDatabase> {
  const miniflare = new Miniflare(
    convertV4MiniflareOptions({
      modules: true,
      script: 'export default { fetch() { return new Response(null); } };',
      d1Databases: ['DB'],
    }),
  );
  // Miniflare が返す型は @cloudflare/workers-types のもので、worker-configuration.d.ts の D1Database と
  // 名前が同じでも別の型になる。実体は同じ D1 なので、ここで 1 回だけ合わせる。
  const db = (await miniflare.getD1Database('DB')) as unknown as D1Database;

  async function reset(): Promise<void> {
    // 作った順の逆に消す。entries が workspaces を外部キーで参照しているため、親を先に消すと失敗する。
    const { results } = await db
      .prepare(
        `SELECT name FROM sqlite_master
         WHERE type = 'table' AND name NOT LIKE 'sqlite_%' AND name NOT LIKE '_cf_%'
         ORDER BY rowid DESC`,
      )
      .all<{ name: string }>();
    // 空の batch は D1 が受け付けないので、最初の 1 回（表がまだない）は飛ばす。
    if (results.length > 0) {
      await db.batch(results.map(({ name }) => db.prepare(`DROP TABLE ${name}`)));
    }
    await db.batch(readMigrationStatements().map((statement) => db.prepare(statement)));
  }

  await reset();
  return { db, reset, dispose: () => miniflare.dispose() };
}
