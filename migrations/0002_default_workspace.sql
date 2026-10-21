-- 利用者の最初のワークスペース「予定」（設計書 4.2）。
-- 画面が最初に開いたときに作る方式にしないのは、2 台でほぼ同時に初めて開くと「予定」が 2 つできるため。
-- 固定の id なら、全端末で同じ 1 行になる。色は仮の値で、決め方は設計書 4.2 を参照。
-- edited_at = 0 の理由は、0001 の組み込みの行と同じ（端末からの最初の編集が必ず勝つ）。
--
-- rev は meta.rev を 1 つ進めた値にする。0 のままだと、すでに rev を覚えている端末が、差分の読み込み
-- （設計書 6.3）でこの行を受け取れない。組み込みの 2 行が 0 なのは、どの端末も rev を覚えていない
-- 最初のマイグレーションで入れたため。
-- meta の UPDATE を先にして、INSERT が、進めた後の rev を読む。INSERT を先にすると、UPDATE に
-- 「まだない」の条件を付けられず、すでに行があるときも rev だけが進む。

UPDATE meta SET rev = rev + 1
WHERE NOT EXISTS (SELECT 1 FROM workspaces WHERE id = 'default-workspace');

INSERT INTO workspaces (id, name, color, sort_order, visible, builtin, edited_at, rev, deleted_at)
SELECT 'default-workspace', '予定', '#039BE5', 0, 1, NULL, 0, meta.rev, NULL
FROM meta
WHERE NOT EXISTS (SELECT 1 FROM workspaces WHERE id = 'default-workspace');
