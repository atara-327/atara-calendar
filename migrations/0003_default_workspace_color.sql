-- 「予定」（設計書 4.2）の色を、ワークスペースの 8 色のピーコック（設計書 11.1）に合わせる。
-- 0002 で入れた色 #039BE5 は、8 色が決まるまでの仮の値だった。
--
-- 直すのは、「予定」が未編集のときだけ。条件の edited_at = 0 が、それを表す。端末からの書き込みは
-- edited_at が今の値より大きいときだけ行を変えるので、名前・色・表示の変更も削除も、
-- 1 回でも行われていれば edited_at は 0 ではなくなる。利用者が選んだ色は残す。
-- deleted_at を条件に足さないのは、削除も edited_at を進めるので、edited_at = 0 なら削除済みにならないため。
-- color = '#039BE5' も条件にするのは、もう一度当てても、何も変えず rev も進めないようにするため。
--
-- edited_at は 0 のままにする。0002 と同じく、端末からの最初の編集が必ず勝つようにするため。
-- rev は meta.rev を 1 つ進めた値にする。進めないと、すでに rev を覚えている端末が、差分の読み込み
-- （設計書 6.3）で、この色の変更を受け取れない。
-- meta の UPDATE を先にして、workspaces の UPDATE が、進めた後の rev を読む。workspaces を先にすると、
-- meta の UPDATE が、すでに色を直した後の行を見て、条件を付けられない（0002 と同じ理由）。

UPDATE meta SET rev = rev + 1
WHERE id = 1 AND EXISTS (
  SELECT 1 FROM workspaces
  WHERE id = 'default-workspace' AND edited_at = 0 AND color = '#039BE5'
);

UPDATE workspaces SET color = '#4FC3F7', rev = (SELECT rev FROM meta WHERE id = 1)
WHERE id = 'default-workspace' AND edited_at = 0 AND color = '#039BE5';
