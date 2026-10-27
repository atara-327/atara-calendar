import { useSyncExternalStore } from 'react';

// 今の時刻の線（今日の日表示）を、1 分ごとに動かす。useToday（src/client/month/useToday.ts）と同じ考え方で、
// タブが裏に回ったときに、ブラウザがタイマーを遅らせても、前面に戻ったときに、すぐ今の時刻に直す。
const MS_PER_MINUTE = 60_000;

function subscribe(onChange: () => void): () => void {
  // 分が変わる瞬間に合わせて、毎回、次の分の頭までを数え直す。setInterval の 1 分ごとにしないのは、
  // 動き出した時刻の端数のぶん、線の動きが、最大 1 分遅れるため。少し足すのは、タイマーが、
  // 分の頭の直前に動くと、まだ前の分のままで、さらに 1 分待つことになるため。
  let timer = 0;
  const schedule = () => {
    timer = window.setTimeout(
      () => {
        onChange();
        schedule();
      },
      MS_PER_MINUTE - (Date.now() % MS_PER_MINUTE) + 50,
    );
  };
  schedule();
  document.addEventListener('visibilitychange', onChange);
  return () => {
    window.clearTimeout(timer);
    document.removeEventListener('visibilitychange', onChange);
  };
}

/** 今の時刻を、分に切り捨てた UTC のミリ秒。分が変わるまで、同じ値を返す（変わらなければ、再描画されない）。 */
function getSnapshot(): number {
  return Math.floor(Date.now() / MS_PER_MINUTE) * MS_PER_MINUTE;
}

export function useNowMinute(): number {
  return useSyncExternalStore(subscribe, getSnapshot);
}
