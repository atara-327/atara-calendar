/**
 * 書き込みの editedAt を決める時計。max(今の時刻, 前に決めた editedAt + 1)（設計書 13.4・6.4）。
 * Why +1 するのか: 同じミリ秒に 2 つ書くと、サーバーが同じ editedAt の 2 つ目を stale として捨てるため。
 */
export function createEditedAtClock(now: () => number): () => number {
  let last = 0;
  return () => {
    last = Math.max(now(), last + 1);
    return last;
  };
}
