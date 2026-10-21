/**
 * 端末で編集した時刻（editedAt）を決める時計。端末全体で、決めるたびに必ず増える。
 * max(今, 前に決めた値 + 1) にするのは、サーバーが edited_at が同じ依頼を「2 回目の送信」として捨てるため
 * （設計書 6.2）。同じミリ秒に 2 回編集すると、2 回目が黙って消える。
 * 単調にするだけで、今の時刻から離れた値にはしない（時計が戻っても、戻った分だけ先の値を作り続けない。
 * 戻した分は、次に今の時刻が追いつくまで、1 ずつ増える）。
 */
export interface EditedAtClock {
  next(): number;
}

/**
 * initial は、起動時に、保存してある送信待ちの依頼の editedAt の最大値を渡す。再読み込みの間に時計が戻っても、
 * 送信待ちより古い時刻を作らないため（先の編集を、後の編集が追い越して、食い違いの判定を逆にしてしまう）。
 * 送信待ちがなければ undefined でよい。
 */
export function createEditedAtClock({
  now,
  initial,
}: {
  now: () => number;
  initial?: number;
}): EditedAtClock {
  let last = initial ?? 0;
  return {
    next() {
      last = Math.max(now(), last + 1);
      return last;
    },
  };
}
