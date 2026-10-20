-- テーブル定義は設計書 4.2 に対応する。列の意味はそちらを参照。

CREATE TABLE workspaces (
  id         TEXT PRIMARY KEY,
  name       TEXT NOT NULL,
  color      TEXT NOT NULL,
  sort_order INTEGER NOT NULL,
  visible    INTEGER NOT NULL DEFAULT 1,
  builtin    TEXT,
  edited_at  INTEGER NOT NULL,
  rev        INTEGER NOT NULL,
  deleted_at INTEGER
);

CREATE TABLE entries (
  id            TEXT PRIMARY KEY,
  kind          TEXT NOT NULL CHECK (kind IN ('event', 'block')),
  title         TEXT NOT NULL,
  workspace_id  TEXT REFERENCES workspaces(id),
  all_day       INTEGER NOT NULL DEFAULT 0,
  start_date    TEXT NOT NULL,
  start_time    TEXT,
  end_date      TEXT NOT NULL,
  end_time      TEXT,
  location      TEXT,
  url           TEXT,
  memo          TEXT,
  rrule         TEXT,
  until_date    TEXT,
  series_id     TEXT,
  original_date TEXT,
  cancelled     INTEGER NOT NULL DEFAULT 0,
  notify_enabled    INTEGER NOT NULL,
  notify_offset_min INTEGER NOT NULL,
  next_notify_at    INTEGER,
  edited_at     INTEGER NOT NULL,
  rev           INTEGER NOT NULL,
  deleted_at    INTEGER
);

CREATE INDEX entries_rev    ON entries(rev);
CREATE INDEX entries_series ON entries(series_id);
CREATE INDEX entries_notify ON entries(next_notify_at)
  WHERE next_notify_at IS NOT NULL AND deleted_at IS NULL;

CREATE TABLE meta (
  id    INTEGER PRIMARY KEY CHECK (id = 1),
  rev   INTEGER NOT NULL,
  epoch TEXT NOT NULL
);

-- 管理情報の 1 行。epoch は、データを復元したときに変える値（設計書 付録 A.1）。
INSERT INTO meta (id, rev, epoch) VALUES (1, 0, lower(hex(randomblob(8))));

-- 組み込みのワークスペース（WS-4）。id が全端末で同じでないと、表示の ON/OFF を同期できない（設計書 Q3）。
-- sort_order を大きくして、利用者が作ったワークスペースの後ろに並べる。
-- edited_at = 0 にして、端末からの最初の編集（表示の ON/OFF）が必ず勝つようにする。
INSERT INTO workspaces (id, name, color, sort_order, visible, builtin, edited_at, rev, deleted_at)
VALUES
  ('builtin-holiday', '祝日', '#F28B82', 1000000, 1, 'holiday', 0, 0, NULL),
  ('builtin-observance', '記念日', '#9AA0A6', 1000001, 1, 'observance', 0, 0, NULL);
